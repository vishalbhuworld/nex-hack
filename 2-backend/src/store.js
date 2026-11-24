const crypto = require("crypto");

const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}-${crypto.randomBytes(4).toString("hex")}`;
const storeError = (message, status = 400) => Object.assign(new Error(message), { status });

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
    orders: Object.fromEntries(read("orders").map(([documentId, order]) => [
      documentId,
      { ...cloneValue(order), id: order.id || documentId },
    ])),
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
    items: order.items.map((item) => ({ ...item })),
  };
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

function applyFinancialEvent(operation) {
  if (operation.type === "payment" || operation.type === "cancellation") expireReservations();
  const order = state.orders[operation.orderId];
  if (operation.type === "payment") {
    if (order.status !== "reserved" || order.items.some((item) => item.status !== "reserved")) {
      operation.status = "rejected";
      operation.appliedAt = now();
      addEvent("payment_rejected", `Payment ${operation.eventId} rejected because the order is no longer reserved`, operation.orderId);
      return;
    }
    operation.status = "applied";
    operation.appliedAt = now();
    order.status = "paid";
    order.items.forEach((item) => { item.status = "paid"; });
    for (const item of order.items) {
      const key = `${item.storeId}:${item.sku}`;
      state.reserved[key] = Math.max(0, (state.reserved[key] || 0) - item.quantity);
      state.inventory[item.storeId][item.sku] -= item.quantity;
    }
    if (state.reservations[order.reservationId]) state.reservations[order.reservationId].status = "consumed";
    addEvent("payment_applied", `Payment of ₹${operation.amount.toLocaleString("en-IN")} applied`, operation.orderId);
  } else if (operation.type === "cancellation") {
    let refundAmount = 0;
    let cancelled = false;
    for (const item of order.items) {
      if (item.status === "reserved") {
        const key = `${item.storeId}:${item.sku}`;
        state.reserved[key] = Math.max(0, (state.reserved[key] || 0) - item.quantity);
        item.status = "cancelled";
        cancelled = true;
      } else if (item.status === "paid") {
        refundAmount += item.amount;
        item.status = "failed";
        cancelled = true;
      }
    }
    if (!cancelled) {
      operation.status = "rejected";
      operation.appliedAt = now();
      addEvent("cancellation_rejected", `Cancellation ${operation.eventId} rejected because no cancellable items remain`, operation.orderId);
      return;
    }
    operation.status = "applied";
    operation.appliedAt = now();
    if (state.reservations[order.reservationId]) state.reservations[order.reservationId].status = "cancelled";
    if (refundAmount > 0) {
      processFinancialEvent({
        orderId: operation.orderId,
        eventId: id("refund"),
        type: "refund",
        amount: refundAmount,
      });
    }
    updateOrderStatus(order);
    addEvent("cancellation_applied", `Cancellation applied; refund ₹${refundAmount.toLocaleString("en-IN")}`, operation.orderId);
  } else {
    const failedItems = order.items.filter((item) => item.status === "failed");
    const refundableAmount = failedItems.reduce((sum, item) => sum + item.amount, 0);
    if (failedItems.length === 0 || operation.amount !== refundableAmount) {
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
        const orderItem = failedItems.find((item) => item.storeId === issue.storeId && item.sku === affectedItem.sku);
        if (orderItem) affectedItem.status = orderItem.status;
      });
    }
    addEvent("refund_applied", `Refund of ₹${operation.amount.toLocaleString("en-IN")} applied`, operation.orderId);
  }
}

function processFinancialEvent({ orderId, eventId, type, amount, delayMs = 0 }) {
  const order = state.orders[orderId];
  if (!order) throw storeError("Unknown order", 404);
  if (!eventId) throw storeError("eventId is required");
  if (!["payment", "refund", "cancellation"].includes(type)) throw storeError("Unsupported financial event type");
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount < 0 || (type !== "cancellation" && numericAmount === 0)) {
    throw storeError("Financial amount must be greater than zero");
  }
  if (type === "payment" && numericAmount !== order.total) throw storeError("Payment amount must match the order total");
  if (type === "cancellation" && numericAmount !== 0) throw storeError("Cancellation events must have a zero amount");
  const delay = Number(delayMs);
  if (!Number.isInteger(delay) || delay < 0 || delay > 30_000) {
    throw storeError("delayMs must be a whole number between 0 and 30000");
  }
  const existing = state.financial[eventId];
  if (existing) {
    if (existing.orderId !== orderId || existing.type !== type || existing.amount !== numericAmount) {
      throw storeError("eventId was already used for a different financial operation", 409);
    }
    addEvent("duplicate_event_ignored", `Duplicate ${existing.type} event ${eventId} ignored`, orderId);
    return { duplicate: true, operation: existing };
  }

  const operation = {
    eventId,
    orderId,
    type,
    amount: numericAmount,
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
    processFinancialEvent({ orderId, eventId, type: "refund", amount: refundAmount, delayMs: delay });
  }
  if (affectedItems.length > 0) {
    const issue = {
      id: id("issue"),
      orderId,
      storeId,
      storeName: store ? store.name : storeId,
      status: "open",
      amount: refundAmount,
      affectedItems: affectedItems.map(({ sku, name, quantity, status, amount }) => ({ sku, name, quantity, status, amount })),
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

module.exports = {
  initializePersistence,
  flush,
  createOrder,
  processFinancialEvent,
  dispatchStore,
  failStore,
  resolveIssue,
  reset,
  getSnapshot,
  runConcurrencyDemo,
};
