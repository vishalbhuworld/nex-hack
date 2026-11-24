const test = require("node:test");
const assert = require("node:assert/strict");
const store = require("../src/store");

test("delayed payment stays pending and duplicate notifications apply once", async () => {
  store.reset();
  const order = store.createOrder({ items: [{ sku: "PHONE-01", quantity: 1 }] });

  const first = store.processFinancialEvent({
    orderId: order.id,
    eventId: "payment-delay-test",
    type: "payment",
    amount: order.total,
    delayMs: 40,
  });
  const duplicate = store.processFinancialEvent({
    orderId: order.id,
    eventId: "payment-delay-test",
    type: "payment",
    amount: order.total,
    delayMs: 40,
  });

  assert.equal(first.operation.status, "pending");
  assert.equal(duplicate.duplicate, true);
  assert.equal(store.getSnapshot().orders[0].status, "reserved");
  await new Promise((resolve) => setTimeout(resolve, 70));

  const snapshot = store.getSnapshot();
  assert.equal(snapshot.orders[0].status, "paid");
  assert.equal(snapshot.financial.length, 1);
  assert.equal(snapshot.financial[0].status, "applied");
  assert.equal(store.processFinancialEvent({
    orderId: order.id,
    eventId: "payment-delay-test",
    type: "payment",
    amount: order.total,
  }).duplicate, true);
});

test("a delayed payment is rejected after the customer cancels", async () => {
  store.reset();
  const order = store.createOrder({ items: [{ sku: "PHONE-01", quantity: 1 }] });
  store.processFinancialEvent({
    orderId: order.id,
    eventId: "late-payment-test",
    type: "payment",
    amount: order.total,
    delayMs: 40,
  });

  const cancellation = store.processFinancialEvent({
    orderId: order.id,
    eventId: "cancel-test",
    type: "cancellation",
    amount: 0,
    itemId: order.items[0].itemId,
  });
  assert.equal(cancellation.operation.status, "applied");
  assert.equal(store.getSnapshot().orders[0].status, "cancelled");
  await new Promise((resolve) => setTimeout(resolve, 70));

  const snapshot = store.getSnapshot();
  assert.equal(snapshot.orders[0].status, "cancelled");
  assert.equal(snapshot.financial.find((operation) => operation.eventId === "late-payment-test").status, "rejected");
  assert.equal(snapshot.stores.reduce((sum, entry) => sum + entry.inventory.reduce((inner, item) => inner + item.reserved, 0), 0), 0);
});

test("store failure opens a staff issue and repeated failures do not repeat refunds", () => {
  store.reset();
  const order = store.createOrder({ items: [{ sku: "PHONE-01", quantity: 5 }] });
  store.processFinancialEvent({ orderId: order.id, eventId: "paid-for-failure-test", type: "payment", amount: order.total });
  store.dispatchStore(order.id, "store-b");

  store.failStore(order.id, "store-a");
  store.failStore(order.id, "store-a");
  let snapshot = store.getSnapshot();
  assert.equal(snapshot.orders[0].status, "partially_fulfilled");
  assert.equal(snapshot.orders[0].items.find((item) => item.storeId === "store-b").status, "dispatched");
  assert.equal(snapshot.issues.length, 1);
  assert.equal(snapshot.issues[0].status, "open");
  assert.equal(snapshot.issues[0].affectedItems[0].status, "refunded");
  assert.equal(snapshot.financial.filter((operation) => operation.type === "refund").length, 1);
  const refund = snapshot.financial.find((operation) => operation.type === "refund");
  assert.equal(store.processFinancialEvent({
    orderId: order.id,
    eventId: refund.eventId,
    type: "refund",
    amount: refund.amount,
  }).duplicate, true);
  assert.equal(store.processFinancialEvent({
    orderId: order.id,
    eventId: "second-refund-for-same-items",
    type: "refund",
    amount: refund.amount,
  }).operation.status, "rejected");
  assert.equal(store.getSnapshot().financial.filter((operation) => operation.type === "refund" && operation.status === "applied").length, 1);

  const resolved = store.resolveIssue(order.id, snapshot.issues[0].id);
  assert.equal(resolved.issue.status, "resolved");
  assert.equal(store.getSnapshot().issues[0].status, "resolved");
});

test("delayed refunds remain pending, update recovery issues, and apply once", async () => {
  store.reset();
  const order = store.createOrder({ items: [{ sku: "PHONE-01", quantity: 1 }] });
  store.processFinancialEvent({ orderId: order.id, eventId: "paid-before-delayed-refund", type: "payment", amount: order.total });
  store.failStore(order.id, "store-a", { refundDelayMs: 40 });

  let snapshot = store.getSnapshot();
  const refund = snapshot.financial.find((operation) => operation.type === "refund");
  assert.equal(refund.status, "pending");
  assert.equal(snapshot.issues[0].affectedItems[0].status, "failed");
  assert.equal(store.processFinancialEvent({
    orderId: order.id,
    eventId: refund.eventId,
    type: "refund",
    amount: refund.amount,
    delayMs: 40,
  }).duplicate, true);

  await new Promise((resolve) => setTimeout(resolve, 70));
  snapshot = store.getSnapshot();
  assert.equal(snapshot.financial.find((operation) => operation.eventId === refund.eventId).status, "applied");
  assert.equal(snapshot.issues[0].affectedItems[0].status, "refunded");
  assert.equal(snapshot.financial.filter((operation) => operation.type === "refund" && operation.status === "applied").length, 1);
});

test("parallel purchase arrivals cannot reserve more stock than exists", async () => {
  const result = await store.runConcurrencyDemo();
  const successes = result.responses.filter((response) => response.result).length;
  const reservedUnits = result.snapshot.stores.reduce((sum, entry) =>
    sum + entry.inventory.filter((item) => item.sku === "PHONE-01").reduce((inner, item) => inner + item.reserved, 0), 0);
  const availableUnits = result.snapshot.stores.reduce((sum, entry) =>
    sum + entry.inventory.filter((item) => item.sku === "PHONE-01").reduce((inner, item) => inner + item.available, 0), 0);

  assert.equal(successes, 5);
  assert.equal(reservedUnits, 5);
  assert.equal(availableUnits, 0);
  assert.ok(result.snapshot.stores.every((entry) => entry.inventory.every((item) => item.available >= 0)));
});

test("cancelling one item from a paid split-store order refunds only that item", () => {
  store.reset();
  const order = store.createOrder({ items: [{ sku: "PHONE-01", quantity: 7 }] });
  assert.equal(new Set(order.items.map((item) => item.storeId)).size, 3);
  store.processFinancialEvent({ orderId: order.id, eventId: "paid-before-partial-cancel", type: "payment", amount: order.total });
  const paidOrder = store.getSnapshot().orders[0];
  const paymentCode = paidOrder.paymentCode;
  assert.match(paymentCode, /^PAY-[A-F0-9]{12}$/);

  const cancelledItem = paidOrder.items.find((item) => item.storeId === "store-a");
  const remainingItems = paidOrder.items.filter((item) => item.itemId !== cancelledItem.itemId);
  const first = store.processFinancialEvent({
    orderId: order.id,
    eventId: "cancel-one-store-item",
    type: "cancellation",
    amount: 0,
    itemId: cancelledItem.itemId,
  });
  const duplicate = store.processFinancialEvent({
    orderId: order.id,
    eventId: "cancel-one-store-item",
    type: "cancellation",
    amount: 0,
    itemId: cancelledItem.itemId,
  });
  const snapshot = store.getSnapshot();
  const updatedOrder = snapshot.orders[0];

  assert.equal(first.operation.status, "applied");
  assert.equal(duplicate.duplicate, true);
  assert.equal(updatedOrder.status, "partially_fulfilled");
  assert.equal(updatedOrder.paymentCode, paymentCode);
  assert.equal(updatedOrder.items.find((item) => item.itemId === cancelledItem.itemId).status, "refunded");
  assert.ok(remainingItems.every((item) => updatedOrder.items.find((entry) => entry.itemId === item.itemId).status === "paid"));
  const refunds = snapshot.financial.filter((operation) => operation.type === "refund");
  assert.equal(refunds.length, 1);
  assert.equal(refunds[0].amount, cancelledItem.amount);
  assert.deepEqual(refunds[0].itemIds, [cancelledItem.itemId]);
  assert.equal(store.processFinancialEvent({
    orderId: order.id,
    eventId: "cancel-same-item-again",
    type: "cancellation",
    amount: 0,
    itemId: cancelledItem.itemId,
  }).operation.status, "rejected");
});

test("cancelling one reserved item leaves the rest payable", () => {
  store.reset();
  const order = store.createOrder({ items: [{ sku: "PHONE-01", quantity: 5 }] });
  const cancelledItem = order.items.find((item) => item.storeId === "store-a");
  const remainingItem = order.items.find((item) => item.itemId !== cancelledItem.itemId);

  store.processFinancialEvent({
    orderId: order.id,
    eventId: "cancel-one-reserved-item",
    type: "cancellation",
    amount: 0,
    itemId: cancelledItem.itemId,
  });
  const reservation = store.getSnapshot().orders[0];
  assert.equal(reservation.status, "reserved");
  assert.equal(reservation.items.find((item) => item.itemId === cancelledItem.itemId).status, "cancelled");

  const payment = store.processFinancialEvent({
    orderId: order.id,
    eventId: "pay-remaining-reserved-item",
    type: "payment",
    amount: remainingItem.amount,
  });
  const paidOrder = store.getSnapshot().orders[0];
  assert.equal(payment.operation.status, "applied");
  assert.equal(paidOrder.items.find((item) => item.itemId === remainingItem.itemId).status, "paid");
  assert.equal(paidOrder.items.find((item) => item.itemId === cancelledItem.itemId).status, "cancelled");
  assert.equal(paidOrder.status, "partially_fulfilled");
  assert.match(paidOrder.paymentCode, /^PAY-[A-F0-9]{12}$/);
});

test("cancelling the only paid item creates one refund and repeated cancellation is idempotent", () => {
  store.reset();
  const order = store.createOrder({ items: [{ sku: "PHONE-01", quantity: 1 }] });
  store.processFinancialEvent({ orderId: order.id, eventId: "paid-before-cancel", type: "payment", amount: order.total });

  const first = store.processFinancialEvent({
    orderId: order.id,
    eventId: "cancel-paid-test",
    type: "cancellation",
    amount: 0,
    itemId: order.items[0].itemId,
  });
  const duplicate = store.processFinancialEvent({
    orderId: order.id,
    eventId: "cancel-paid-test",
    type: "cancellation",
    amount: 0,
    itemId: order.items[0].itemId,
  });
  const snapshot = store.getSnapshot();

  assert.equal(first.operation.status, "applied");
  assert.equal(duplicate.duplicate, true);
  assert.equal(snapshot.orders[0].status, "cancelled");
  assert.equal(snapshot.financial.filter((operation) => operation.type === "refund").length, 1);
  assert.equal(snapshot.stores.reduce((sum, entry) =>
    sum + entry.inventory.filter((item) => item.sku === "PHONE-01").reduce((inner, item) => inner + item.physical, 0), 0), 7);
});

test("Firestore stores app data in collections and restores it after reinitialization", async () => {
  const collections = new Map();
  let batchCommits = 0;
  const getRecords = (name) => {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name);
  };
  const db = {
    collection(name) {
      return {
        doc(documentId) {
          return {
            id: documentId,
            collection: name,
            async get() {
              const record = getRecords(name).get(documentId);
              return {
                exists: record !== undefined,
                data: () => record,
              };
            },
          };
        },
        async get() {
          const records = getRecords(name);
          return {
            forEach(callback) {
              records.forEach((data, documentId) => callback({
                id: documentId,
                data: () => data,
              }));
            },
          };
        },
      };
    },
    batch() {
      const operations = [];
      return {
        set(reference, data) {
          operations.push({ type: "set", reference, data });
        },
        create(reference, data) {
          operations.push({ type: "create", reference, data });
        },
        delete(reference) {
          operations.push({ type: "delete", reference });
        },
        async commit() {
          operations.filter((operation) => operation.type === "create").forEach((operation) => {
            if (getRecords(operation.reference.collection).has(operation.reference.id)) {
              throw new Error("Document already exists");
            }
          });
          operations.forEach(({ type, reference, data }) => {
            const records = getRecords(reference.collection);
            if (type === "delete") records.delete(reference.id);
            else records.set(reference.id, JSON.parse(JSON.stringify(data)));
          });
          batchCommits += 1;
        },
      };
    },
  };

  store.reset();
  await store.initializePersistence(db);
  const initializedCommits = batchCommits;
  store.getSnapshot();
  await store.flush();
  assert.equal(batchCommits, initializedCommits, "reading unchanged state should not write");

  const order = store.createOrder({
    customer: "Persistent Buyer",
    customerEmail: "persistent@example.com",
    deliveryDetails: { fullName: "Persistent Buyer", city: "Delhi" },
    items: [{ sku: "PHONE-01", quantity: 1 }],
  });
  await store.flush();
  assert.ok(getRecords("orders").has(order.id));
  assert.ok(getRecords("reservations").has(order.reservationId));
  assert.ok(getRecords("inventory").has("store-a"));
  assert.ok(getRecords("auditEvents").size > 0);

  const writesAfterOrder = batchCommits;
  await store.initializePersistence(db);
  let snapshot = store.getSnapshot();
  await store.flush();
  assert.equal(batchCommits, writesAfterOrder, "restored reads should not write");
  assert.equal(snapshot.orders[0].customerEmail, "persistent@example.com");
  assert.equal(snapshot.stores.find((entry) => entry.id === "store-a").inventory
    .find((item) => item.sku === "PHONE-01").reserved, 1);

  store.processFinancialEvent({
    orderId: order.id,
    eventId: "persistent-payment",
    type: "payment",
    amount: order.total,
  });
  await store.flush();
  await store.initializePersistence(db);
  snapshot = store.getSnapshot();
  assert.equal(snapshot.orders[0].status, "paid");
  assert.equal(snapshot.financial[0].status, "applied");
  assert.equal(snapshot.stores.find((entry) => entry.id === "store-a").inventory
    .find((item) => item.sku === "PHONE-01").physical, 3);
});
