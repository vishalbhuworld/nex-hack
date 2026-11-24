const test = require("node:test");
const assert = require("node:assert/strict");
const store = require("../src/store");

test("Smart Store Switching preserves stock and payment", () => {
  store.reset();

  const email = "test@example.com";

  const order = store.createOrder({
    customerEmail: email,
    items: [{ sku: "PHONE-01", quantity: 1 }]
  });

  store.processFinancialEvent({
    orderId: order.id,
    eventId: "switch-test-payment",
    type: "payment",
    amount: order.total
  });

  const before = store.getSnapshot();
  const paid = before.orders[0];
  const item = paid.items[0];
  const oldStore = item.storeId;

  const alternatives = store.findAlternativeStores(
    order.id, item.itemId
  );

  assert.ok(alternatives.length > 0);

  const target = alternatives[0].storeId;

  const args = {
    orderId: order.id,
    itemId: item.itemId,
    targetStoreId: target,
    customerEmail: email,
    paymentCode: paid.paymentCode
  };

  assert.throws(() => store.switchStore({
    ...args,
    paymentCode: "INVALID"
  }));

  store.switchStore(args);

  const after = store.getSnapshot();

  assert.equal(after.orders[0].items[0].storeId, target);
  assert.equal(after.orders[0].items[0].status, "paid");
  assert.equal(after.orders[0].paymentCode, paid.paymentCode);
  assert.equal(after.orders[0].total, paid.total);
  assert.equal(after.financial.length, before.financial.length);

  const stock = (snap, sid) =>
    snap.stores.find(s => s.id === sid)
      .inventory.find(i => i.sku === "PHONE-01").physical;

  assert.equal(stock(after, target), stock(before, target) - 1);
  assert.equal(stock(after, oldStore), stock(before, oldStore) + 1);

  assert.throws(() => store.switchStore(args));

  assert.deepEqual(store.getSnapshot().stores, after.stores);
});
