const test = require("node:test");
const assert = require("node:assert/strict");
const app = require("../src/app");
const auth = require("../src/auth");
const store = require("../src/store");

test("customers submit UTRs and admins verify payment to generate a code", async (t) => {
  store.reset();
  const customer = await auth.customerLogin(`order-test-${Date.now()}@example.com`);
  const staffId = `order-test-${Date.now()}`;
  await auth.createStaff({ id: staffId, name: "Order Test", password: "test-password-123" });
  const staff = auth.staffLogin(staffId, "test-password-123");
  const admin = auth.adminLogin("admin", "admin123");
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const rawRequest = async (path, token, body) => {
    return fetch(`${baseUrl}${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
        Connection: "close",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  };
  const request = async (path, token, body) => {
    const response = await rawRequest(path, token, body);
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
  const paymentQr = await request(`/api/orders/${placedOrder.id}/payment-qr`, customer.token);
  assert.equal(paymentQr.upiId, "vk6654590@oksbi");
  assert.equal(paymentQr.amount, placedOrder.total);
  assert.match(paymentQr.qrDataUrl, /^data:image\/png;base64,/);
  const paymentParameters = new URL(paymentQr.paymentUri).searchParams;
  assert.equal(paymentParameters.get("pa"), "vk6654590@oksbi");
  assert.equal(paymentParameters.get("am"), placedOrder.total.toFixed(2));
  assert.equal(paymentParameters.get("cu"), "INR");

  const invalidProofResponse = await rawRequest(`/api/orders/${placedOrder.id}/payment-proof`, customer.token, {
    utr: "123456789012",
    proofDataUrl: "data:image/png;base64,SGVsbG8=",
  });
  assert.equal(invalidProofResponse.status, 400);

  const paymentSubmission = await request(`/api/orders/${placedOrder.id}/payment-proof`, customer.token, {
    utr: "123456789012",
    proofDataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jk9sAAAAASUVORK5CYII=",
  });
  assert.equal(paymentSubmission.status, "pending");
  assert.equal(paymentSubmission.amount, placedOrder.total);
  const lockedRetryResponse = await rawRequest(`/api/orders/${placedOrder.id}/payment-proof`, customer.token, {
    utr: "123456789013",
  });
  assert.equal(lockedRetryResponse.status, 409);
  const lockedCancelResponse = await rawRequest(`/api/orders/${placedOrder.id}/cancel`, customer.token, {
    eventId: "cancel-during-payment-review",
    itemId: placedOrder.items[0].itemId,
  });
  assert.equal(lockedCancelResponse.status, 409);

  const secondOrder = await request("/api/orders", customer.token, {
    items: [{ sku: "BUDS-01", quantity: 1 }],
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
  const duplicateUtrResponse = await rawRequest(`/api/orders/${secondOrder.id}/payment-proof`, customer.token, {
    utr: "123456789012",
  });
  assert.equal(duplicateUtrResponse.status, 409);

  const anotherCustomer = await auth.customerLogin(`other-order-test-${Date.now()}@example.com`);
  const unauthorizedQrResponse = await fetch(`${baseUrl}/api/orders/${placedOrder.id}/payment-qr`, {
    headers: { Authorization: `Bearer ${anotherCustomer.token}`, Connection: "close" },
  });
  assert.equal(unauthorizedQrResponse.status, 403);

  const adminQueue = await request("/api/orders", admin.token);
  assert.equal(adminQueue.orders.length, 0);
  assert.equal(adminQueue.paymentSubmissions[0].utr, "123456789012");
  assert.equal(adminQueue.paymentSubmissions[0].status, "pending");
  assert.equal(adminQueue.paymentSubmissions[0].proofDataUrl, "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jk9sAAAAASUVORK5CYII=");

  const staffOrderSnapshot = await request("/api/orders", staff.token);
  const staffOrder = staffOrderSnapshot.orders.find((order) => order.id === placedOrder.id);
  assert.equal(staffOrder.paymentStatus, "pending");
  assert.equal(staffOrder.paymentAttempts, undefined);
  assert.equal(JSON.stringify(staffOrder).includes("123456789012"), false);
  const customerPendingOrders = await request("/api/orders", customer.token);
  const customerPendingOrder = customerPendingOrders.orders.find((order) => order.id === placedOrder.id);
  assert.equal(customerPendingOrder.paymentStatus, "pending");
  assert.equal(customerPendingOrder.paymentCode, null);
  assert.equal(customerPendingOrder.paymentAttempts, undefined);

  const staffReviewResponse = await rawRequest(`/api/orders/${placedOrder.id}/payment-submissions/${paymentSubmission.submissionId}/review`, staff.token, {
    decision: "approve",
  });
  assert.equal(staffReviewResponse.status, 403);

  await request(`/api/orders/${placedOrder.id}/payment-submissions/${paymentSubmission.submissionId}/review`, admin.token, {
    decision: "hold",
  });
  const heldRetryResponse = await rawRequest(`/api/orders/${placedOrder.id}/payment-proof`, customer.token, {
    utr: "123456789013",
  });
  assert.equal(heldRetryResponse.status, 409);
  await request(`/api/orders/${placedOrder.id}/payment-submissions/${paymentSubmission.submissionId}/review`, admin.token, {
    decision: "reject",
    note: "UTR not found in bank app",
  });

  const correctedSubmission = await request(`/api/orders/${placedOrder.id}/payment-proof`, customer.token, {
    utr: "123456789013",
  });
  const payment = await request(`/api/orders/${placedOrder.id}/payment-submissions/${correctedSubmission.submissionId}/review`, admin.token, {
    decision: "approve",
  });
  assert.match(payment.paymentCode, /^PAY-[A-F0-9]{12}$/);
  const paymentRetry = await request(`/api/orders/${placedOrder.id}/payment-submissions/${correctedSubmission.submissionId}/review`, admin.token, {
    decision: "approve",
  });
  assert.equal(paymentRetry.duplicate, true);
  assert.equal(paymentRetry.paymentCode, payment.paymentCode);

  const bypassPaymentResponse = await rawRequest(`/api/orders/${placedOrder.id}/financial-event`, admin.token, {
    eventId: "orders-route-payment-bypass-test",
    type: "payment",
    amount: placedOrder.total,
  });
  assert.equal(bypassPaymentResponse.status, 403);

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
