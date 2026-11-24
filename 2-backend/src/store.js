const crypto = require("crypto");

const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}-${crypto.randomBytes(4).toString("hex")}`;
const storeError = (message, status = 400) => Object.assign(new Error(message), { status });
const paymentCode = () => {
  let code;
  do {
    code = `PAY-${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
  } while (Object.values(state.orders).some((order) => order.paymentCode === code));
  return code;
};

function createInitialState() {
  return {
    stores: [
      { id: "store-a", name: "Central Store", available: true },
      { id: "store-b", name: "North Store", available: true },
      { id: "store-c", name: "Market Store", available: true },
    ],
    products: [
      { sku: "PHONE-01", name: "Nova Phone", price: 24999, emoji: "📱" },
      { sku: "BUDS-01", name: "AirBuds Pro", price: 2999, emoji: "🎧" },
      { sku: "WATCH-01", name: "Pulse Watch", price: 4999, emoji: "⌚" },
    ],
    inventory: {
      "store-a": { "PHONE-01": 4, "BUDS-01": 8, "WATCH-01": 6 },
      "store-b": { "PHONE-01": 2, "BUDS-01": 8, "WATCH-01": 5 },
      "store-c": { "PHONE-01": 1, "BUDS-01": 7, "WATCH-01": 4 },
    },
    reserved: {},
    reservations: {},
    orders: {},
    financial: {},
    issues: [],
    events: [],
  };
}

let state = createInitialState();
const persistenceCollections = [
  "stores",
  "products",
  "inventory",
  "reservations",
  "orders",
  "financialEvents",
  "issues",
  "auditEvents",
];
let persistenceDb = null;
let persistedDocuments = null;
let persistenceQueue = Promise.resolve();
let mutationVersion = 0;
let persistedVersion = 0;

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertValidState(candidate) {
  const valid = candidate &&
    Array.isArray(candidate.stores) &&
    Array.isArray(candidate.products) &&
    candidate.inventory &&
    candidate.reserved &&
    candidate.reservations &&
    candidate.orders &&
    candidate.financial &&
    Array.isArray(candidate.issues) &&
    Array.isArray(candidate.events);
  if (!valid || candidate.stores.length === 0 || candidate.products.length === 0) {
    throw new Error("Firestore application state is incomplete");
  }
}

function stateToDocuments(source) {
  return new Map([
    ["stores", new Map(source.stores.map((entry, position) => [
      entry.id,
      { ...cloneValue(entry), _position: position },
    ]))],
    ["products", new Map(source.products.map((entry, position) => [
      entry.sku,
      { ...cloneValue(entry), _position: position },
    ]))],
    ["inventory", new Map(Object.entries(source.inventory).map(([storeId, quantities]) => [
      storeId,
      { storeId, quantities: cloneValue(quantities) },
    ]))],
    ["reservations", new Map(Object.entries(source.reservations).map(([reservationId, reservation]) => [
      reservationId,
      cloneValue(reservation),
    ]))],
    ["orders", new Map(Object.entries(source.orders).map(([orderId, order]) => [
      orderId,
      cloneValue(order),
    ]))],
    ["financialEvents", new Map(Object.entries(source.financial).map(([eventId, operation]) => [
      eventId,
      cloneValue(operation),
    ]))],
    ["issues", new Map(source.issues.map((issue) => [issue.id, cloneValue(issue)]))],
    ["auditEvents", new Map(source.events.map((event) => [event.id, cloneValue(event)]))],
  ]);
}

function cloneDocuments(documents) {
  return new Map([...documents].map(([collection, entries]) => [
    collection,
    new Map([...entries].map(([documentId, data]) => [documentId, cloneValue(data)])),
  ]));
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function stateFromDocuments(documents) {
  const read = (collection) => [...documents.get(collection).entries()];
  const ordered = (collection) => read(collection)
    .sort((left, right) => (left[1]._position || 0) - (right[1]._position || 0))
    .map(([, data]) => {
      const { _position, ...entry } = cloneValue(data);
      return entry;
    });

  const reservations = Object.fromEntries(read("reservations").map(([documentId, reservation]) => [
    documentId,
    { ...cloneValue(reservation), id: reservation.id || documentId },
  ]));
  const reserved = {};
  Object.values(reservations).forEach((reservation) => {
    if (reservation.status !== "active") return;
    reservation.items.forEach((item) => {
      const key = `${item.storeId}:${item.sku}`;
      reserved[key] = (reserved[key] || 0) + item.quantity;
    });
  });

  return {
    stores: ordered("stores"),
    products: ordered("products"),
    inventory: Object.fromEntries(read("inventory").map(([documentId, record]) => [
      record.storeId || documentId,
      cloneValue(record.quantities),
    ])),
    reserved,
    reservations,
    orders: Object.fromEntries(read("orders").map(([documentId, order]) => {
      const restored = { ...cloneValue(order), id: order.id || documentId };
      restored.items = restored.items.map((item, index) => ({
        ...item,
        itemId: item.itemId || `${restored.id}-item-${index + 1}`,
      }));
      return [documentId, restored];
    })),
    financial: Object.fromEntries(read("financialEvents").map(([documentId, operation]) => [
      documentId,
      { ...cloneValue(operation), eventId: operation.eventId || documentId },
    ])),
    issues: read("issues").map(([, issue]) => cloneValue(issue))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    events: read("auditEvents").map(([, event]) => cloneValue(event))
      .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))
      .slice(0, 300),
  };
}

async function loadCollectionDocuments(db) {
  const snapshots = await Promise.all(persistenceCollections.map((name) => db.collection(name).get()));
  return new Map(snapshots.map((snapshot, index) => {
    const entries = new Map();
    snapshot.forEach((document) => entries.set(document.id, document.data()));
    return [persistenceCollections[index], entries];
  }));
}

async function restoreFromCollections(db, metadataSnapshot) {
  const metadata = metadataSnapshot.data();
  if (metadata.schemaVersion !== 1) {
    throw new Error(`Unsupported Firestore schema version: ${metadata.schemaVersion}`);
  }
  const documents = await loadCollectionDocuments(db);
  const restoredState = stateFromDocuments(documents);
  assertValidState(restoredState);
  state = restoredState;
  persistedDocuments = cloneDocuments(documents);
}

async function initializePersistence(db) {
  const metadataRef = db.collection("appMetadata").doc("primary");
  const metadataSnapshot = await metadataRef.get();
  if (metadataSnapshot.exists) {
    await restoreFromCollections(db, metadataSnapshot);
  } else {
    const legacySnapshot = await db.collection("applicationState").doc("primary").get();
    const initialState = legacySnapshot.exists ? legacySnapshot.data().state : createInitialState();
    assertValidState(initialState);
    const initialDocuments = stateToDocuments(initialState);
    const batch = db.batch();
    initialDocuments.forEach((entries, collection) => {
      entries.forEach((data, documentId) => {
        batch.set(db.collection(collection).doc(documentId), data);
      });
    });
    batch.create(metadataRef, { schemaVersion: 1, createdAt: now() });
    try {
      await batch.commit();
      state = initialState;
      persistedDocuments = cloneDocuments(initialDocuments);
    } catch (error) {
      const racedMetadata = await metadataRef.get();
      if (!racedMetadata.exists) throw error;
      await restoreFromCollections(db, racedMetadata);
    }
  }
  persistenceDb = db;
  mutationVersion = 0;
  persistedVersion = 0;
}

function flush() {
  if (!persistenceDb) return Promise.resolve();
  if (mutationVersion <= persistedVersion) return persistenceQueue;
  const version = mutationVersion;
  const snapshot = JSON.parse(JSON.stringify(state));
  const write = persistenceQueue.catch(() => {}).then(async () => {
    const desiredDocuments = stateToDocuments(snapshot);
    const changes = [];
    desiredDocuments.forEach((entries, collection) => {
      const previousEntries = persistedDocuments.get(collection);
      entries.forEach((data, documentId) => {
        const previous = previousEntries.get(documentId);
        if (!previous || stableStringify(previous) !== stableStringify(data)) {
          changes.push({ type: "set", collection, documentId, data });
        }
      });
      previousEntries.forEach((_data, documentId) => {
        if (!entries.has(documentId)) changes.push({ type: "delete", collection, documentId });
      });
    });
    if (changes.length > 500) {
      throw new Error("Firestore update exceeds the 500-write batch limit");
    }
    if (changes.length > 0) {
      const batch = persistenceDb.batch();
      changes.forEach((change) => {
        const reference = persistenceDb.collection(change.collection).doc(change.documentId);
        if (change.type === "set") batch.set(reference, change.data);
        else batch.delete(reference);
      });
      await batch.commit();
    }
    persistedDocuments = cloneDocuments(desiredDocuments);
    persistedVersion = Math.max(persistedVersion, version);
  });
  persistenceQueue = write;
  return write;
}

function flushInBackground() {
  flush().catch((error) => {
    console.error("Failed to persist application state to Firestore:", error);
  });
}

function addEvent(type, message, orderId = null, metadata = {}) {
  mutationVersion += 1;
  state.events.unshift({ id: id("evt"), at: now(), type, message, orderId, metadata });
  if (state.events.length > 300) state.events.length = 300;
}

function copyInventory() {
  return JSON.parse(JSON.stringify(state.inventory));
}

function serializeOrder(order) {
  return {
    ...order,
    items: order.items.map((item, index) => ({
      ...item,
      itemId: item.itemId || `${order.id}-item-${index + 1}`,
    })),
  };
}

function validatePaymentProofImage(proofDataUrl) {
  if (proofDataUrl === undefined || proofDataUrl === null || proofDataUrl === "") return null;
  if (typeof proofDataUrl !== "string") throw storeError("Payment proof must be an image");

  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(proofDataUrl);
  if (!match) throw storeError("Payment proof must be a PNG, JPEG, or WebP image");
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length === 0 || bytes.length > 200 * 1024 || bytes.toString("base64") !== match[2]) {
    throw storeError("Payment proof image must be smaller than 200 KB");
  }

  const validSignature = match[1] === "image/png"
    ? bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    : match[1] === "image/jpeg"
      ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  if (!validSignature) throw storeError("Payment proof image content does not match its file type");
  return proofDataUrl;
}

function submitPaymentProof({ orderId, customerEmail, utr, proofDataUrl }) {
  if (expireReservations()) flushInBackground();
  const order = state.orders[orderId];
  if (!order) throw storeError("Unknown order", 404);
  if (order.customerEmail !== customerEmail) throw storeError("You can only submit payment for your own orders", 403);
  if (order.status !== "reserved") throw storeError("This order is not awaiting payment", 409);

  const normalizedUtr = typeof utr === "string" ? utr.trim().toUpperCase() : "";
  if (!/^[A-Z0-9/-]{6,35}$/.test(normalizedUtr)) {
    throw storeError("Enter a valid UTR or transaction reference");
  }
  const attempts = order.paymentAttempts || [];
  const latestAttempt = attempts.at(-1);
  if (latestAttempt && ["pending", "hold", "approved"].includes(latestAttempt.status)) {
    throw storeError("A payment submission is already locked for review", 409);
  }
  const duplicateUtr = Object.entries(state.orders).some(([otherOrderId, otherOrder]) =>
    otherOrderId !== orderId && (otherOrder.paymentAttempts || []).some((attempt) => attempt.utr === normalizedUtr));
  if (duplicateUtr) throw storeError("This UTR has already been submitted for another order", 409);

  const amount = order.items.filter((item) => item.status === "reserved")
    .reduce((total, item) => total + item.amount, 0);
  if (amount <= 0) throw storeError("No payment is due for this order", 409);
  const validatedProofDataUrl = validatePaymentProofImage(proofDataUrl);
  const reservation = state.reservations[order.reservationId];
  if (!reservation || reservation.status !== "active") {
    throw storeError("The stock reservation has expired. Place the order again to pay", 409);
  }
  reservation.expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  const attempt = {
    id: id("submission"),
    utr: normalizedUtr,
    amount,
    status: "pending",
    proofDataUrl: validatedProofDataUrl,
    submittedAt: now(),
  };
  order.paymentAttempts = [...attempts, attempt];
  addEvent("payment_proof_submitted", `Payment proof submitted for ₹${amount.toLocaleString("en-IN")}`, orderId, {
    submissionId: attempt.id,
  });
  return { submissionId: attempt.id, amount, status: attempt.status };
}

function reviewPaymentSubmission({ orderId, submissionId, decision, adminId, note = "" }) {
  if (expireReservations()) flushInBackground();
  const order = state.orders[orderId];
  if (!order) throw storeError("Unknown order", 404);
  const attempt = (order.paymentAttempts || []).find((entry) => entry.id === submissionId);
  if (!attempt) throw storeError("Unknown payment submission", 404);
  if (!["approve", "reject", "hold"].includes(decision)) throw storeError("Choose approve, reject, or hold");

  const reviewNote = typeof note === "string" ? note.trim() : "";
  if (reviewNote.length > 300) throw storeError("Review note cannot exceed 300 characters");
  if (decision === "reject" && reviewNote.length < 3) {
    throw storeError("Add a short reason before rejecting a payment");
  }

  const nextStatus = { approve: "approved", reject: "rejected", hold: "hold" }[decision];
  if (attempt.status === nextStatus) {
    return { duplicate: true, status: attempt.status, paymentCode: order.paymentCode || null };
  }
  if (!["pending", "hold"].includes(attempt.status)) {
    throw storeError("This payment submission has already been reviewed", 409);
  }

  if (decision === "approve") {
    if (order.status !== "reserved") throw storeError("Order is no longer awaiting payment", 409);
    const amountDue = order.items.filter((item) => item.status === "reserved")
      .reduce((total, item) => total + item.amount, 0);
    if (amountDue <= 0 || amountDue !== attempt.amount) {
      throw storeError("Payment amount no longer matches the reserved order items", 409);
    }

    const result = processFinancialEvent({
      orderId,
      eventId: `payment-proof-${submissionId}`,
      type: "payment",
      amount: amountDue,
    });
    if (result.operation.status !== "applied") {
      throw storeError("Payment could not be applied to this order", 409);
    }
  }

  attempt.status = nextStatus;
  attempt.reviewedAt = now();
  attempt.reviewedBy = adminId;
  attempt.reviewNote = reviewNote;
  addEvent(`payment_proof_${nextStatus}`, `Payment proof ${nextStatus} by administrator`, orderId, {
    submissionId,
  });
  return { duplicate: false, status: attempt.status, paymentCode: order.paymentCode || null };
}

function getStoreSku(storeId, sku) {
  return (state.inventory[storeId] && state.inventory[storeId][sku]) || 0;
}

function availableStock(storeId, sku) {
  const key = `${storeId}:${sku}`;
  const held = state.reserved[key] || 0;
  return Math.max(0, getStoreSku(storeId, sku) - held);
}

function getStores() {
  return state.stores.map((store) => ({
    ...store,
    inventory: state.products.map((product) => ({
      ...product,
      available: availableStock(store.id, product.sku),
      physical: getStoreSku(store.id, product.sku),
      reserved: state.reserved[`${store.id}:${product.sku}`] || 0,
    })),
  }));
}

function expireReservations() {
  const before = now();
  let expired = false;
  for (const reservation of Object.values(state.reservations)) {
    if (reservation.status === "active" && reservation.expiresAt <= before) {
      expired = true;
      reservation.status = "expired";
      for (const item of reservation.items) {
        const key = `${item.storeId}:${item.sku}`;
        state.reserved[key] = Math.max(0, (state.reserved[key] || 0) - item.quantity);
      }
      const order = state.orders[reservation.orderId];
      if (order && order.status === "reserved") {
        order.status = "expired";
        order.items.forEach((item) => {
          if (item.status === "reserved") item.status = "cancelled";
        });
      }
      addEvent("reservation_expired", `Reservation ${reservation.id} expired`, reservation.orderId);
    }
  }
  return expired;
}

const reservationCleanup = setInterval(() => {
  if (expireReservations()) flushInBackground();
}, 30_000);
if (typeof reservationCleanup.unref === "function") reservationCleanup.unref();

function reserveProduct(storeId, sku, quantity) {
  if (!state.stores.find((store) => store.id === storeId && store.available)) return false;
  if (availableStock(storeId, sku) < quantity) return false;
  const key = `${storeId}:${sku}`;
  state.reserved[key] = (state.reserved[key] || 0) + quantity;
  return true;
}

function createOrder({ customer = "Demo Customer", customerEmail = null, deliveryDetails = null, items = [], split = true }) {
  expireReservations();
  if (!Array.isArray(items) || items.length === 0) throw new Error("At least one item is required");
  const normalized = [];
  for (const request of items) {
    const quantity = Number(request.quantity);
    if (!request.sku || !Number.isInteger(quantity) || quantity < 1) {
      throw new Error("Invalid item or quantity");
    }
    if (!state.products.some((product) => product.sku === request.sku)) throw new Error("Unknown SKU");
    normalized.push({ sku: request.sku, quantity });
  }

  const orderId = id("order");
  const orderItems = [];
  const reservationItems = [];
  const reservationId = id("res");

  for (const item of normalized) {
    let remaining = item.quantity;
    const stores = [...state.stores].sort((a, b) => getStoreSku(b.id, item.sku) - getStoreSku(a.id, item.sku));
    for (const store of stores) {
      if (remaining === 0) break;
      if (!split && store !== stores[0]) continue;
      const quantity = split ? Math.min(remaining, availableStock(store.id, item.sku)) : availableStock(store.id, item.sku);
      if (quantity > 0 && reserveProduct(store.id, item.sku, quantity)) {
        const product = state.products.find((entry) => entry.sku === item.sku);
        orderItems.push({
          itemId: id("item"),
          sku: item.sku,
          name: product.name,
          quantity,
          storeId: store.id,
          status: "reserved",
          amount: product.price * quantity,
        });
        reservationItems.push({ storeId: store.id, sku: item.sku, quantity });
        remaining -= quantity;
      }
    }
    if (remaining > 0) {
      for (const held of reservationItems) {
        const key = `${held.storeId}:${held.sku}`;
        state.reserved[key] = Math.max(0, (state.reserved[key] || 0) - held.quantity);
      }
      throw new Error(`Insufficient stock for ${item.sku}`);
    }
  }

  const total = orderItems.reduce((sum, item) => sum + item.amount, 0);
  const order = {
    id: orderId,
    customer,
    customerEmail,
    deliveryDetails,
    status: "reserved",
    total,
    items: orderItems,
    createdAt: now(),
  };
  state.orders[orderId] = order;
  state.reservations[reservationId] = {
    id: reservationId,
    orderId,
    items: reservationItems,
    status: "active",
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  };
  order.reservationId = reservationId;
  addEvent("order_reserved", `Reserved ₹${total.toLocaleString("en-IN")} across ${new Set(orderItems.map((item) => item.storeId)).size} store(s)`, orderId);
  return serializeOrder(order);
}

function releaseReservedItem(order, item) {
  const key = `${item.storeId}:${item.sku}`;
  state.reserved[key] = Math.max(0, (state.reserved[key] || 0) - item.quantity);
  const reservation = state.reservations[order.reservationId];
  if (!reservation || reservation.status !== "active") return;

  let remaining = item.quantity;
  reservation.items.forEach((reservedItem) => {
    if (reservedItem.storeId !== item.storeId || reservedItem.sku !== item.sku || remaining === 0) return;
    const released = Math.min(reservedItem.quantity, remaining);
    reservedItem.quantity -= released;
    remaining -= released;
  });
  reservation.items = reservation.items.filter((reservedItem) => reservedItem.quantity > 0);
  if (reservation.items.length === 0) reservation.status = "cancelled";
}

function applyFinancialEvent(operation) {
  if (operation.type === "payment" || operation.type === "cancellation") expireReservations();
  const order = state.orders[operation.orderId];
  if (operation.type === "payment") {
    const payableItems = order.items.filter((item) => item.status === "reserved");
    const payableAmount = payableItems.reduce((sum, item) => sum + item.amount, 0);
    if (order.status !== "reserved" || payableItems.length === 0 || operation.amount !== payableAmount) {
      operation.status = "rejected";
      operation.appliedAt = now();
      addEvent("payment_rejected", `Payment ${operation.eventId} rejected because the order is no longer reserved`, operation.orderId);
      return;
    }
    operation.status = "applied";
    operation.appliedAt = now();
    payableItems.forEach((item) => { item.status = "paid"; });
    order.status = order.items.every((item) => item.status === "paid") ? "paid" : "partially_fulfilled";
    for (const item of payableItems) {
      const key = `${item.storeId}:${item.sku}`;
      state.reserved[key] = Math.max(0, (state.reserved[key] || 0) - item.quantity);
      state.inventory[item.storeId][item.sku] -= item.quantity;
    }
    if (state.reservations[order.reservationId]) state.reservations[order.reservationId].status = "consumed";
    order.paymentCode = order.paymentCode || paymentCode();
    addEvent("payment_applied", `Payment of ₹${operation.amount.toLocaleString("en-IN")} applied`, operation.orderId);
  } else if (operation.type === "cancellation") {
    const item = order.items.find((entry) => entry.itemId === operation.itemId);
    if (!item || !["reserved", "paid"].includes(item.status)) {
      operation.status = "rejected";
      operation.appliedAt = now();
      addEvent("cancellation_rejected", `Cancellation ${operation.eventId} rejected because its item is no longer cancellable`, operation.orderId);
      return;
    }
    if (item.status === "reserved") {
      releaseReservedItem(order, item);
      item.status = "cancelled";
    } else {
      item.status = "failed";
    }
    operation.status = "applied";
    operation.appliedAt = now();
    if (item.status === "failed") {
      processFinancialEvent({
        orderId: operation.orderId,
        eventId: id("refund"),
        type: "refund",
        amount: item.amount,
        itemIds: [item.itemId],
      });
    }
    updateOrderStatus(order);
    addEvent("cancellation_applied", `Item cancelled; refund ₹${(item.status === "refunded" ? item.amount : 0).toLocaleString("en-IN")}`, operation.orderId);
  } else {
    const failedItems = operation.itemIds
      ? operation.itemIds.map((itemId) => order.items.find((item) => item.itemId === itemId))
      : order.items.filter((item) => item.status === "failed");
    const invalidItems = failedItems.length === 0 || failedItems.some((item) => !item || item.status !== "failed");
    const refundableAmount = invalidItems ? 0 : failedItems.reduce((sum, item) => sum + item.amount, 0);
    if (
      invalidItems ||
      operation.amount !== refundableAmount
    ) {
      operation.status = "rejected";
      operation.appliedAt = now();
      addEvent("refund_rejected", `Refund ${operation.eventId} rejected because the refundable amount changed`, operation.orderId);
      return;
    }
    operation.status = "applied";
    operation.appliedAt = now();
    for (const item of failedItems) {
      state.inventory[item.storeId][item.sku] += item.quantity;
      item.status = "refunded";
    }
    for (const issue of state.issues) {
      if (issue.orderId !== operation.orderId) continue;
      issue.affectedItems.forEach((affectedItem) => {
        const orderItem = failedItems.find((item) => item.itemId === affectedItem.itemId) ||
          failedItems.find((item) => !affectedItem.itemId && item.storeId === issue.storeId && item.sku === affectedItem.sku);
        if (orderItem) affectedItem.status = orderItem.status;
      });
    }
    addEvent("refund_applied", `Refund of ₹${operation.amount.toLocaleString("en-IN")} applied`, operation.orderId);
  }
}

function processFinancialEvent({ orderId, eventId, type, amount, itemId, itemIds, delayMs = 0 }) {
  const order = state.orders[orderId];
  if (!order) throw storeError("Unknown order", 404);
  if (!eventId) throw storeError("eventId is required");
  if (!["payment", "refund", "cancellation"].includes(type)) throw storeError("Unsupported financial event type");
  if (type === "cancellation" && (typeof itemId !== "string" || !itemId.trim())) {
    throw storeError("itemId is required for item cancellation");
  }
  if (type === "refund" && itemIds !== undefined && (
    !Array.isArray(itemIds) ||
    itemIds.length === 0 ||
    itemIds.some((targetId) => typeof targetId !== "string" || !targetId.trim()) ||
    new Set(itemIds).size !== itemIds.length
  )) {
    throw storeError("itemIds must contain unique item IDs");
  }
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount < 0 || (type !== "cancellation" && numericAmount === 0)) {
    throw storeError("Financial amount must be greater than zero");
  }
  if (type === "cancellation" && numericAmount !== 0) throw storeError("Cancellation events must have a zero amount");
  const delay = Number(delayMs);
  if (!Number.isInteger(delay) || delay < 0 || delay > 30_000) {
    throw storeError("delayMs must be a whole number between 0 and 30000");
  }
  const existing = state.financial[eventId];
  if (existing) {
    const itemTargetsChanged = type === "cancellation"
      ? existing.itemId !== itemId
      : type === "refund" && itemIds !== undefined &&
        JSON.stringify(existing.itemIds || null) !== JSON.stringify(itemIds);
    if (
      existing.orderId !== orderId ||
      existing.type !== type ||
      existing.amount !== numericAmount ||
      itemTargetsChanged
    ) {
      throw storeError("eventId was already used for a different financial operation", 409);
    }
    addEvent("duplicate_event_ignored", `Duplicate ${existing.type} event ${eventId} ignored`, orderId);
    return { duplicate: true, operation: existing };
  }
  const payableAmount = order.items.filter((item) => item.status === "reserved")
    .reduce((sum, item) => sum + item.amount, 0);
  if (type === "payment" && numericAmount !== payableAmount) throw storeError("Payment amount must match the remaining reserved items");

  const operation = {
    eventId,
    orderId,
    type,
    amount: numericAmount,
    ...(itemId ? { itemId } : {}),
    ...(itemIds ? { itemIds: [...itemIds] } : {}),
    status: "pending",
    at: now(),
    delayMs: delay,
  };
  state.financial[eventId] = operation;
  if (delay > 0) {
    addEvent("financial_event_scheduled", `${type} event ${eventId} scheduled for ${delay}ms`, orderId);
    setTimeout(() => {
      if (state.financial[eventId] === operation && operation.status === "pending") {
        applyFinancialEvent(operation);
        flushInBackground();
      }
    }, delay);
  } else {
    applyFinancialEvent(operation);
  }
  return { duplicate: false, operation };
}

function dispatchStore(orderId, storeId) {
  const order = state.orders[orderId];
  if (!order) throw new Error("Unknown order");
  let changed = false;
  order.items.forEach((item) => {
    if (item.storeId === storeId && ["paid", "dispatched"].includes(item.status)) {
      item.status = "dispatched";
      changed = true;
    }
  });
  if (!changed) throw new Error("No paid fulfilment exists for this store");
  addEvent("store_dispatched", `Store ${storeId} dispatched its fulfilment`, orderId);
  updateOrderStatus(order);
  return serializeOrder(order);
}

function failStore(orderId, storeId, { refundDelayMs = 0 } = {}) {
  const order = state.orders[orderId];
  if (!order) throw new Error("Unknown order");
  const delay = Number(refundDelayMs);
  if (!Number.isInteger(delay) || delay < 0 || delay > 30_000) {
    throw storeError("refundDelayMs must be a whole number between 0 and 30000");
  }
  const store = state.stores.find((entry) => entry.id === storeId);
  if (store) store.available = false;
  let refundAmount = 0;
  const affectedItems = [];
  order.items.forEach((item) => {
    if (item.storeId === storeId && item.status === "paid") {
      refundAmount += item.amount;
      item.status = "failed";
      affectedItems.push(item);
    } else if (item.storeId === storeId && item.status === "reserved") {
      const key = `${item.storeId}:${item.sku}`;
      state.reserved[key] = Math.max(0, (state.reserved[key] || 0) - item.quantity);
      item.status = "cancelled";
      affectedItems.push(item);
    }
  });
  addEvent("store_failed", `Store ${storeId} became unavailable; affected amount ₹${refundAmount.toLocaleString("en-IN")}`, orderId);
  if (refundAmount > 0) {
    const eventId = id("refund");
    const itemIds = affectedItems.filter((item) => item.status === "failed").map((item) => item.itemId);
    processFinancialEvent({ orderId, eventId, type: "refund", amount: refundAmount, itemIds, delayMs: delay });
  }
  if (affectedItems.length > 0) {
    const issue = {
      id: id("issue"),
      orderId,
      storeId,
      storeName: store ? store.name : storeId,
      status: "open",
      amount: refundAmount,
      affectedItems: affectedItems.map(({ itemId, sku, name, quantity, status, amount }) => ({
        itemId, sku, name, quantity, status, amount,
      })),
      message: `Store ${store ? store.name : storeId} failed while handling this order`,
      createdAt: now(),
      resolvedAt: null,
    };
    state.issues.unshift(issue);
    addEvent("attention_required", `Store failure for ${storeId} needs staff review`, orderId);
  }
  updateOrderStatus(order);
  return serializeOrder(order);
}

function resolveIssue(orderId, issueId) {
  const issue = state.issues.find((entry) => entry.id === issueId && entry.orderId === orderId);
  if (!issue) throw storeError("Unknown recovery issue", 404);
  if (issue.status === "resolved") return { duplicate: true, issue };
  issue.status = "resolved";
  issue.resolvedAt = now();
  addEvent("issue_resolved", `Staff reviewed recovery issue ${issue.id}`, orderId);
  return { duplicate: false, issue };
}

function updateOrderStatus(order) {
  const statuses = order.items.map((item) => item.status);
  if (statuses.every((status) => status === "dispatched")) order.status = "fulfilled";
  else if (statuses.every((status) => ["cancelled", "failed", "refunded"].includes(status))) order.status = "cancelled";
  else if (statuses.some((status) => ["dispatched", "refunded"].includes(status)) || statuses.some((status) => status === "failed")) {
    order.status = "partially_fulfilled";
  }
}

function reset() {
  state = createInitialState();
  addEvent("system_reset", "Demo environment reset");
  return getSnapshot();
}

function getSnapshot() {
  expireReservations();
  return {
    stores: getStores(),
    products: state.products,
    orders: Object.values(state.orders).map(serializeOrder).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    financial: Object.values(state.financial).sort((a, b) => b.at.localeCompare(a.at)),
    issues: state.issues.map((issue) => ({
      ...issue,
      affectedItems: issue.affectedItems.map((item) => ({ ...item })),
    })),
    events: state.events,
  };
}

async function runConcurrencyDemo() {
  reset();
  state.inventory["store-a"]["PHONE-01"] = 2;
  state.inventory["store-b"]["PHONE-01"] = 2;
  state.inventory["store-c"]["PHONE-01"] = 1;
  const responses = await Promise.all(Array.from({ length: 12 }, (_, index) =>
    new Promise((resolve) => setImmediate(() => {
      try {
        resolve({ buyer: index + 1, result: createOrder({ customer: `Buyer ${index + 1}`, items: [{ sku: "PHONE-01", quantity: 1 }] }) });
      } catch (error) {
        resolve({ buyer: index + 1, error: error.message });
      }
    })),
  ));
  addEvent("demo_completed", "12 competing purchase attempts arrived together for 5 units");
  const snapshot = getSnapshot();
  await flush();
  return { responses, snapshot };
}


function findAlternativeStores(orderId, itemId) {
  const order = state.orders[orderId];

  if (!order) {
    throw storeError("Unknown order", 404);
  }

  const item = order.items.find(i => i.itemId === itemId);

  if (!item) {
    throw storeError("Unknown item", 404);
  }

  if (item.status !== "paid") {
    return [];
  }

  return state.stores
    .filter(s =>
      s.id !== item.storeId &&
      s.available &&
      availableStock(s.id, item.sku) >= item.quantity
    )
    .map(s => ({
      storeId: s.id,
      name: s.name,
      sku: item.sku,
      available: availableStock(s.id, item.sku),
      quantity: item.quantity,
      amount: item.amount
    }))
    .sort((a, b) => b.available - a.available);
}


function switchStore({
  orderId,
  itemId,
  targetStoreId,
  customerEmail,
  paymentCode
}) {
  const order = state.orders[orderId];

  if (!order) {
    throw storeError("Unknown order", 404);
  }

  if (!customerEmail || order.customerEmail !== customerEmail) {
    throw storeError("Unauthorized order", 403);
  }

  if (!order.paymentCode ||
      order.paymentCode !== paymentCode) {
    throw storeError("Invalid payment code", 403);
  }

  const item = order.items.find(i => i.itemId === itemId);

  if (!item || item.status !== "paid") {
    throw storeError("Only paid and undispatched items can switch stores", 409);
  }

  if (item.storeId === targetStoreId) {
    throw storeError("Item already belongs to this store", 409);
  }

  const pendingOperation = Object.values(state.financial).some(op =>
    op.orderId === orderId &&
    op.status === "pending"
  );

  if (pendingOperation) {
    throw storeError("Financial operation pending", 409);
  }

  const alternatives = findAlternativeStores(orderId, itemId);
  const target = alternatives.find(s => s.storeId === targetStoreId);

  if (!target) {
    throw storeError("Alternative store stock unavailable", 409);
  }

  const previousStoreId = item.storeId;

  state.inventory[targetStoreId][item.sku] -= item.quantity;
  state.inventory[previousStoreId][item.sku] += item.quantity;

  item.storeId = targetStoreId;

  addEvent(
    "store_switched",
    `Item ${item.name} switched from ${previousStoreId} to ${targetStoreId}`,
    orderId,
    {
      itemId,
      previousStoreId,
      targetStoreId,
      quantity: item.quantity,
      amount: item.amount
    }
  );

  return serializeOrder(order);
}

module.exports = {
  switchStore,
  findAlternativeStores,
  initializePersistence,
  flush,
  createOrder,
  submitPaymentProof,
  reviewPaymentSubmission,
  processFinancialEvent,
  dispatchStore,
  failStore,
  resolveIssue,
  reset,
  getSnapshot,
  runConcurrencyDemo,
};
