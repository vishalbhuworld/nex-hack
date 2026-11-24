const test = require("node:test");
const assert = require("node:assert/strict");
const store = require("../src/store");

function createPaidOrder(quantity = 1) {
  store.reset();

  const email = "recovery@example.com";

  const order = store.createOrder({
    customerEmail: email,
    items: [{ sku: "PHONE-01", quantity }]
  });

  store.processFinancialEvent({
    orderId: order.id,
    eventId: "recovery-test-payment",
    type: "payment",
    amount: order.total
  });

  return store.getSnapshot().orders.find(
    o => o.id === order.id
  );
}

function currentOrder(orderId) {
  return store.getSnapshot().orders.find(
    o => o.id === orderId
  );
}

test("Recovery hold blocks dispatch", () => {
  const order = createPaidOrder();
  const item = order.items[0];

  store.startStoreRecovery(order.id, item.storeId);

  const updated = currentOrder(order.id);

  assert.equal(
    updated.items[0].status,
    "recovery_pending"
  );

  assert.throws(() =>
    store.dispatchStore(order.id, item.storeId)
  );

  assert.ok(updated.items[0].recoveryExpiresAt);
});

test("Recovery switching requires valid payment code", () => {
  const order = createPaidOrder();
  const item = order.items[0];

  store.startStoreRecovery(order.id, item.storeId);

  const alternatives = store.findAlternativeStores(
    order.id, item.itemId
  );

  assert.ok(alternatives.length > 0);

  const args = {
    orderId: order.id,
    itemId: item.itemId,
    customerEmail: order.customerEmail,
    paymentCode: order.paymentCode,
    action: "switch",
    targetStoreId: alternatives[0].storeId
  };

  assert.throws(() =>
    store.resolveStoreRecovery({
      ...args,
      paymentCode: "INVALID"
    })
  );

  store.resolveStoreRecovery(args);

  const updated = currentOrder(order.id);

  assert.equal(updated.items[0].storeId, args.targetStoreId);
  assert.equal(updated.items[0].status, "paid");
  assert.equal(updated.paymentCode, order.paymentCode);
  assert.equal(updated.total, order.total);

  assert.equal(
    store.getSnapshot().financial.filter(
      op => op.type === "refund"
    ).length,
    0
  );
});

test("Recovery refund cannot be applied twice", () => {
  const order = createPaidOrder();
  const item = order.items[0];

  store.startStoreRecovery(order.id, item.storeId);

  const args = {
    orderId: order.id,
    itemId: item.itemId,
    customerEmail: order.customerEmail,
    paymentCode: order.paymentCode,
    action: "refund"
  };

  store.resolveStoreRecovery(args);

  assert.equal(
    currentOrder(order.id).items[0].status,
    "refunded"
  );

  assert.throws(() =>
    store.resolveStoreRecovery(args)
  );

  const refunds = store.getSnapshot().financial.filter(
    op => op.type === "refund" &&
          op.status === "applied"
  );

  assert.equal(refunds.length, 1);
  assert.equal(refunds[0].amount, item.amount);
});

test("Expired recovery automatically records refund", () => {
  const order = createPaidOrder();
  const item = order.items[0];

  store.startStoreRecovery(order.id, item.storeId);

  const originalNow = Date.now;
  const future = originalNow() + 360000;

  try {
    Date.now = () => future;

    store.expirePendingRecoveries();
    store.expirePendingRecoveries();

    assert.equal(
      currentOrder(order.id).items[0].status,
      "refunded"
    );

    assert.equal(
      store.getSnapshot().financial.filter(
        op => op.type === "refund" &&
              op.status === "applied"
      ).length,
      1
    );
  } finally {
    Date.now = originalNow;
  }
});

test("Recovery without alternative stock records refund", () => {
  const order = createPaidOrder(4);
  const item = order.items[0];

  assert.equal(item.quantity, 4);

  assert.equal(
    store.findAlternativeStores(
      order.id, item.itemId
    ).length,
    0
  );

  store.startStoreRecovery(order.id, item.storeId);

  assert.equal(
    currentOrder(order.id).items[0].status,
    "refunded"
  );

  assert.equal(
    store.getSnapshot().financial.filter(
      op => op.type === "refund" &&
            op.status === "applied"
    ).length,
    1
  );
});

