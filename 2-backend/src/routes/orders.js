const express = require("express");
const QRCode = require("qrcode");
const store = require("../store");
const auth = require("../auth");

const router = express.Router();
const UPI_ID = process.env.UPI_ID || "vk6654590@oksbi";

router.get("/", auth.authenticate, async (req, res, next) => {
  try {
    const snapshot = store.getSnapshot();
    await store.flush();
    if (req.user.role === "customer") {
      const storeNames = Object.fromEntries(snapshot.stores.map((entry) => [entry.id, entry.name]));
      return res.json({
        orders: snapshot.orders.filter((order) => order.customerEmail === req.user.email).map((order) => ({
          id: order.id,
          status: order.status,
          total: order.total,
          paidTotal: order.items.filter((item) => ["paid", "dispatched"].includes(item.status))
            .reduce((sum, item) => sum + item.amount, 0),
          refundTotal: order.items.filter((item) => item.status === "refunded")
            .reduce((sum, item) => sum + item.amount, 0),
          paymentCode: order.paymentCode || null,
          createdAt: order.createdAt,
          items: order.items.map(({ itemId, name, quantity, status, amount, storeId }) => ({
            itemId,
            name,
            quantity,
            status,
            amount,
            storeId,
            storeName: storeNames[storeId] || storeId,
          })),
        })),
      });
    }
    const pendingStatuses = new Set(["reserved", "paid"]);
    const orderSummary = {
      totalOrders: snapshot.orders.length,
      pendingOrders: snapshot.orders.filter((order) => ["reserved", "paid", "partially_fulfilled"].includes(order.status)).length,
      completedOrders: snapshot.orders.filter((order) => order.status === "fulfilled").length,
      pendingUnits: snapshot.orders.reduce((count, order) =>
        count + order.items.filter((item) => pendingStatuses.has(item.status)).reduce((sum, item) => sum + item.quantity, 0), 0),
      byStore: snapshot.stores.map((storeEntry) => {
        const storeOrders = snapshot.orders.filter((order) => order.items.some((item) => item.storeId === storeEntry.id));
        const pendingUnits = storeOrders.reduce((count, order) =>
          count + order.items.filter((item) => item.storeId === storeEntry.id && pendingStatuses.has(item.status))
            .reduce((sum, item) => sum + item.quantity, 0), 0);
        return { id: storeEntry.id, name: storeEntry.name, orderCount: storeOrders.length, pendingUnits };
      }),
    };
    if (req.user.role === "admin") {
      return res.json({
        stores: snapshot.stores,
        orders: [],
        financial: [],
        events: [],
        orderSummary,
      });
    }
    res.json({ ...snapshot, orderSummary });
  } catch (error) {
    next(error);
  }
});

router.get("/catalog", auth.authenticate, auth.allowRoles("customer"), async (_req, res, next) => {
  try {
    const snapshot = store.getSnapshot();
    await store.flush();
    const availability = {};
    snapshot.stores.forEach((storeEntry) => storeEntry.inventory.forEach((item) => {
      availability[item.sku] = (availability[item.sku] || 0) + item.available;
    }));
    res.json({
      products: snapshot.products.map((product) => ({ ...product, available: availability[product.sku] || 0 })),
    });
  } catch (error) {
    next(error);
  }
});

router.get("/:orderId/payment-qr", auth.authenticate, auth.allowRoles("customer"), async (req, res, next) => {
  try {
    const order = store.getSnapshot().orders.find((entry) => entry.id === req.params.orderId);
    if (!order) throw Object.assign(new Error("Unknown order"), { status: 404 });
    if (order.customerEmail !== req.user.email) {
      throw Object.assign(new Error("You can only view payment details for your own orders"), { status: 403 });
    }
    if (order.status !== "reserved") {
      throw Object.assign(new Error("Payment QR is only available for orders awaiting payment"), { status: 409 });
    }
    if (!/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+$/.test(UPI_ID)) {
      throw Object.assign(new Error("UPI payment address is not configured correctly"), { status: 500 });
    }

    const amount = order.items.filter((item) => item.status === "reserved")
      .reduce((total, item) => total + item.amount, 0);
    if (amount <= 0) throw Object.assign(new Error("No payment is due for this order"), { status: 409 });
    const paymentUri = `upi://pay?${new URLSearchParams({
      pa: UPI_ID,
      pn: "Veltrix Shop",
      am: amount.toFixed(2),
      cu: "INR",
      tn: `Order ${order.id}`,
    })}`;
    const qrDataUrl = await QRCode.toDataURL(paymentUri, { errorCorrectionLevel: "M", margin: 2, width: 256 });
    res.json({ upiId: UPI_ID, amount, paymentUri, qrDataUrl });
  } catch (error) {
    next(error);
  }
});

router.post("/", auth.authenticate, auth.allowRoles("customer", "admin"), async (req, res, next) => {
  try {
    const isCustomer = req.user.role === "customer";
    let deliveryDetails;
    if (isCustomer) {
      const input = req.body.deliveryDetails || {};
      deliveryDetails = {
        fullName: String(input.fullName || "").trim(),
        phone: String(input.phone || "").trim(),
        address: String(input.address || "").trim(),
        landmark: String(input.landmark || "").trim(),
        city: String(input.city || "").trim(),
        pincode: String(input.pincode || "").trim(),
      };
      if (deliveryDetails.fullName.length < 2 || deliveryDetails.fullName.length > 80) {
        throw Object.assign(new Error("Enter a valid delivery name"), { status: 400 });
      }
      if (!/^[0-9+() -]{10,18}$/.test(deliveryDetails.phone) || deliveryDetails.phone.replace(/\D/g, "").length < 10) {
        throw Object.assign(new Error("Enter a valid phone number"), { status: 400 });
      }
      if (deliveryDetails.address.length < 5 || deliveryDetails.address.length > 180) {
        throw Object.assign(new Error("Enter a complete delivery address"), { status: 400 });
      }
      if (deliveryDetails.landmark.length > 100 || deliveryDetails.city.length < 2 || deliveryDetails.city.length > 80) {
        throw Object.assign(new Error("Enter a valid city and landmark"), { status: 400 });
      }
      if (!/^\d{6}$/.test(deliveryDetails.pincode)) {
        throw Object.assign(new Error("PIN code must contain 6 digits"), { status: 400 });
      }
    }
    const order = store.createOrder({
      ...req.body,
      customer: isCustomer ? req.user.email : "Demo Customer",
      customerEmail: isCustomer ? req.user.email : null,
      deliveryDetails,
    });
    await store.flush();
    res.status(201).json(order);
  } catch (error) {
    if (!error.status) error.status = 409;
    next(error);
  }
});

router.post("/:orderId/payment", auth.authenticate, auth.allowRoles("admin", "staff"), async (req, res, next) => {
  try {
    const eventId = req.body.eventId || `pay-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const snapshot = store.getSnapshot();
    const order = snapshot.orders.find((entry) => entry.id === req.params.orderId);
    if (!order) throw Object.assign(new Error("Unknown order"), { status: 404 });
    const delayMs = Number(req.body.delayMs || 0);
    const existingPayment = snapshot.financial.find((operation) => operation.eventId === eventId);
    const amount = existingPayment && existingPayment.orderId === order.id && existingPayment.type === "payment"
      ? existingPayment.amount
      : order.items.filter((item) => item.status === "reserved")
        .reduce((sum, item) => sum + item.amount, 0);
    const result = store.processFinancialEvent({
      orderId: req.params.orderId,
      eventId,
      type: "payment",
      amount,
      delayMs,
    });
    await store.flush();
    const updatedOrder = store.getSnapshot().orders.find((entry) => entry.id === req.params.orderId);
    res.json({ ...result, paymentCode: updatedOrder.paymentCode || null });
  } catch (error) {
    next(error);
  }
});

router.post("/:orderId/cancel", auth.authenticate, auth.allowRoles("customer", "admin", "staff"), async (req, res, next) => {
  try {
    const orderId = req.params.orderId;
    const order = store.getSnapshot().orders.find((entry) => entry.id === orderId);
    if (!order) throw Object.assign(new Error("Unknown order"), { status: 404 });
    if (req.user.role === "customer" && order.customerEmail !== req.user.email) {
      throw Object.assign(new Error("You can only cancel your own orders"), { status: 403 });
    }
    const result = store.processFinancialEvent({
      orderId,
      eventId: req.body.eventId || `cancel-${orderId}-${Date.now()}`,
      type: "cancellation",
      amount: 0,
      itemId: req.body.itemId,
      delayMs: req.body.delayMs === undefined ? 0 : Number(req.body.delayMs),
    });
    await store.flush();
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post("/:orderId/financial-event", auth.authenticate, auth.allowRoles("admin", "staff"), async (req, res, next) => {
  try {
    const { eventId, type, amount, itemIds, delayMs } = req.body;
    const result = store.processFinancialEvent({ orderId: req.params.orderId, eventId, type, amount, itemIds, delayMs });
    await store.flush();
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post("/:orderId/issues/:issueId/resolve", auth.authenticate, auth.allowRoles("staff"), async (req, res, next) => {
  try {
    const result = store.resolveIssue(req.params.orderId, req.params.issueId);
    await store.flush();
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post("/:orderId/dispatch/:storeId", auth.authenticate, auth.allowRoles("admin", "staff"), async (req, res, next) => {
  try {
    const result = store.dispatchStore(req.params.orderId, req.params.storeId);
    await store.flush();
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post("/:orderId/fail-store/:storeId", auth.authenticate, auth.allowRoles("admin", "staff"), async (req, res, next) => {
  try {
    const refundDelayMs = req.body.refundDelayMs === undefined ? 0 : Number(req.body.refundDelayMs);
    const result = store.failStore(req.params.orderId, req.params.storeId, { refundDelayMs });
    await store.flush();
    res.json(result);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
