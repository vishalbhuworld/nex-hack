const test = require("node:test");
const assert = require("node:assert/strict");
const app = require("../src/app");
const auth = require("../src/auth");
const store = require("../src/store");

test("customers receive a payment code and can cancel one paid item", async (t) => {
  store.reset();
  const customer = await auth.customerLogin(`order-test-${Date.now()}@example.com`);
  const staffId = `order-test-${Date.now()}`;
  await auth.createStaff({ id: staffId, name: "Order Test", password: "test-password-123" });
  const staff = auth.staffLogin(staffId, "test-password-123");
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, token, body) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
        Connection: "close",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await response.json();
    assert.equal(response.ok, true, data.error || data.message);
    return data;
  };

  const placedOrder = await request("/api/orders", customer.token, {
    items: [{ sku: "PHONE-01", quantity: 5 }],
    split: true,
    deliveryDetails: {
      fullName: "Order Test",
      phone: "9876543210",
      address: "12 Example Road",
      landmark: "",
      city: "Pune",
      pincode: "411001",
    },
  });
  const payment = await request(`/api/orders/${placedOrder.id}/payment`, staff.token, {
    eventId: "orders-route-payment-test",
  });
  assert.match(payment.paymentCode, /^PAY-[A-F0-9]{12}$/);
  const paymentRetry = await request(`/api/orders/${placedOrder.id}/payment`, staff.token, {
    eventId: "orders-route-payment-test",
  });
  assert.equal(paymentRetry.duplicate, true);
  assert.equal(paymentRetry.paymentCode, payment.paymentCode);

  const customerOrders = await request("/api/orders", customer.token);
  const customerOrder = customerOrders.orders.find((order) => order.id === placedOrder.id);
  assert.equal(customerOrder.paymentCode, payment.paymentCode);
  assert.ok(customerOrder.items.every((item) => item.itemId && item.storeName));

  const selectedItem = customerOrder.items.find((item) => item.storeId === "store-a");
  await request(`/api/orders/${placedOrder.id}/cancel`, customer.token, {
    eventId: "orders-route-cancellation-test",
    itemId: selectedItem.itemId,
  });
  const updatedOrders = await request("/api/orders", customer.token);
  const updatedOrder = updatedOrders.orders.find((order) => order.id === placedOrder.id);
  assert.equal(updatedOrder.items.find((item) => item.itemId === selectedItem.itemId).status, "refunded");
  assert.ok(updatedOrder.items.filter((item) => item.itemId !== selectedItem.itemId).every((item) => item.status === "paid"));
  assert.equal(updatedOrder.refundTotal, selectedItem.amount);
  assert.equal(updatedOrder.paidTotal, updatedOrder.total - selectedItem.amount);
});
