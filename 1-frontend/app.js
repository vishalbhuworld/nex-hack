const cart = {};
let snapshot = null;
let currentUser = null;
let authToken = sessionStorage.getItem("resolve-token");
let loginMode = "customer";
let refreshTimer = null;
const money = (value) => `₹${Number(value).toLocaleString("en-IN")}`;
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;",
}[character]));

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  const response = await fetch(path, { ...options, headers });
  const data = await response.json();
  if (response.status === 401 && authToken) {
    sessionStorage.removeItem("resolve-token");
    authToken = null;
    currentUser = null;
    window.location.reload();
  }
  if (!response.ok) throw new Error(data.error || data.message || "Request failed");
  return data;
}

function toast(message) {
  const node = document.getElementById("toast");
  node.textContent = message;
  node.classList.add("show");
  setTimeout(() => node.classList.remove("show"), 2600);
}

async function load() {
  if (currentUser.role === "customer") {
    const [catalog, orders] = await Promise.all([api("/api/orders/catalog"), api("/api/orders")]);
    snapshot = { products:catalog.products, stores:[], orders:orders.orders, financial:[], events:[] };
  } else {
    snapshot = await api("/api/orders");
  }
  render();
}

function render() {
  if (currentUser.role === "customer") {
    document.getElementById("storeCount").textContent = "Multiple";
    document.getElementById("orderCount").textContent = snapshot.orders.length;
    renderProducts();
    renderCart();
    renderCustomerOrders();
    attachStoreSwitchButtons();
  } else {
    renderOperationsSummary();
    renderStores();
    void renderStoreReliability();
    if (currentUser.role === "admin") {
      renderPaymentVerification();
    } else if (currentUser.role === "staff") {
      renderStaffMetrics();
      renderOrders();
      renderTimeline();
    }
  }
}

function renderOperationsSummary() {
  const summary = snapshot.orderSummary;
  document.getElementById("incomingOrderCount").textContent = summary.totalOrders;
  document.getElementById("pendingOrderCount").textContent = summary.pendingOrders;
  document.getElementById("completedOrderCount").textContent = summary.completedOrders;
  document.getElementById("pendingItemCount").textContent = summary.pendingUnits;
  document.getElementById("storeOrderSummary").innerHTML = summary.byStore.map((entry) =>
    `<article class="storeOrderChip"><b>${escapeHtml(entry.name)}</b><span>${entry.orderCount} order${entry.orderCount === 1 ? "" : "s"} · ${entry.pendingUnits} pending unit${entry.pendingUnits === 1 ? "" : "s"}</span></article>`
  ).join("");
  const onlineStores = snapshot.stores.filter((store) => store.available).length;
  document.getElementById("systemLabel").textContent = `${onlineStores}/${snapshot.stores.length} stores online`;
}

function renderStaffMetrics() {
  const today = new Date().toLocaleDateString();
  const isToday = (value) => value && new Date(value).toLocaleDateString() === today;
  const dispatchedUnits = snapshot.orders.reduce((total, order) =>
    total + order.items.filter((item) => item.status === "dispatched")
      .reduce((quantity, item) => quantity + item.quantity, 0), 0);
  const pendingRefunds = snapshot.financial.filter((operation) =>
    operation.type === "refund" && operation.status === "pending").length;
  const todaySales = snapshot.financial.filter((operation) =>
    operation.type === "payment" && operation.status === "applied" && isToday(operation.appliedAt || operation.at))
    .reduce((total, operation) => total + operation.amount, 0);
  const lowStock = snapshot.stores.flatMap((store) => store.inventory
    .filter((item) => item.available <= 2)
    .map((item) => ({ ...item, storeName:store.name })));
  const stockUnits = snapshot.stores.reduce((total, store) =>
    total + store.inventory.reduce((sum, item) => sum + item.available + item.reserved, 0), 0);
  const onlineStores = snapshot.stores.filter((store) => store.available).length;
  const todayOrderCount = snapshot.orders.filter((order) => isToday(order.createdAt)).length;
  const pendingUnits = snapshot.orderSummary.pendingUnits;

  document.getElementById("staffTodayOrders").textContent = todayOrderCount;
  document.getElementById("staffPendingUnits").textContent = pendingUnits;
  document.getElementById("staffDispatchedUnits").textContent = dispatchedUnits;
  document.getElementById("staffRefundPending").textContent = pendingRefunds;
  document.getElementById("staffSalesToday").textContent = money(todaySales);
  document.getElementById("staffOrderCount").textContent = snapshot.orders.length;
  document.getElementById("sidebarOrderCount").textContent = snapshot.orders.length;
  document.getElementById("staffOnlineStoreCount").textContent = `${onlineStores}/${snapshot.stores.length} Online`;
  document.getElementById("staffStoreStatusChip").textContent = onlineStores === snapshot.stores.length ? "Online" : "Attention";
  document.getElementById("staffStoreStatusChip").classList.toggle("offline", onlineStores !== snapshot.stores.length);
  document.getElementById("staffStoreStatusChip").classList.remove("checking");
  document.getElementById("staffStockUnits").textContent = stockUnits;
  document.getElementById("staffLowStockCount").textContent = lowStock.length;
  document.getElementById("sidebarIssueCount").textContent = (snapshot.issues || []).filter((issue) => issue.status === "open").length;
  document.getElementById("staffInventoryAlerts").innerHTML = lowStock.length
    ? lowStock.slice(0, 4).map((item) => `
      <article class="staffAlertRow"><span class="staffAlertProduct">⬡</span><span><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.storeName)} · ${item.available} available</small></span><b class="restockLabel">Low</b></article>`).join("")
    : `<p class="staffNoAlerts">No low-stock items (threshold: 2 available or fewer).</p>`;
  renderStaffInsights();
}

function renderStaffInsights() {
  const today = new Date().toLocaleDateString();
  const timeBins = [
    { start:0, end:4, label:"12 AM" },
    { start:4, end:8, label:"4 AM" },
    { start:8, end:12, label:"8 AM" },
    { start:12, end:16, label:"12 PM" },
    { start:16, end:20, label:"4 PM" },
    { start:20, end:24, label:"8 PM" },
  ];
  const orderCounts = timeBins.map(({ start, end }) => snapshot.orders.filter((order) => {
    const createdAt = new Date(order.createdAt);
    return createdAt.toLocaleDateString() === today && createdAt.getHours() >= start && createdAt.getHours() < end;
  }).length);
  const maxOrders = Math.max(...orderCounts, 1);
  const chartScale = Math.max(10, Math.ceil(maxOrders / 4) * 4);
  const chartStep = chartScale / 4;
  const labels = timeBins.map((bin) => bin.label);
  const hasTodayOrders = orderCounts.some((count) => count > 0);
  document.getElementById("staffChartLabel").textContent = hasTodayOrders ? "Today · live orders" : "No orders today";
  const points = orderCounts.map((count, index) => {
    const x = 34 + index * (288 / (orderCounts.length - 1));
    const y = 102 - Math.min(count / chartScale, 1) * 78;
    return { x, y, count };
  });
  const pointList = points.map((point) => `${point.x},${point.y}`).join(" ");
  document.getElementById("staffOrderFlow").innerHTML = hasTodayOrders ? `
    <svg viewBox="0 0 370 132" role="img" aria-label="Today's order flow chart">
      <defs><linearGradient id="orderAreaFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#0b70ed" stop-opacity=".22"/><stop offset="1" stop-color="#0b70ed" stop-opacity=".02"/></linearGradient></defs>
      <g class="chartGrid">${[24, 44, 64, 84, 104].map((y) => `<line x1="28" y1="${y}" x2="348" y2="${y}"/>`).join("")}</g>
      <g class="chartAxis">${[4, 3, 2, 1, 0].map((step, index) => `<text x="4" y="${27 + index * 20}">${Math.round(chartStep * step)}</text>`).join("")}</g>
      <polygon class="chartArea" points="34,104 ${pointList} ${points[points.length - 1].x},104"/>
      <polyline class="chartLine" points="${pointList}"/>
      <g class="chartPoints">${points.map((point) => `<circle cx="${point.x}" cy="${point.y}" r="2.7"><title>${point.count} orders</title></circle>`).join("")}</g>
      <g class="chartAxis chartTime">${labels.map((label, index) => `<text x="${34 + index * (288 / (labels.length - 1))}" y="126">${label}</text>`).join("")}</g>
    </svg>` : `<p class="staffNoChartData">No order data recorded today.</p>`;

  const items = snapshot.orders.flatMap((order) => order.items);
  const totalUnits = items.reduce((total, item) => total + item.quantity, 0);
  const dispatched = items.filter((item) => item.status === "dispatched").reduce((total, item) => total + item.quantity, 0);
  const pending = items.filter((item) => ["reserved", "paid"].includes(item.status)).reduce((total, item) => total + item.quantity, 0);
  const dispatchedPercentage = totalUnits ? Math.round(dispatched / totalUnits * 100) : 0;
  const pendingPercentage = totalUnits
    ? Math.min(Math.round(pending / totalUnits * 100), 100 - dispatchedPercentage)
    : 0;
  const percentages = [dispatchedPercentage, pendingPercentage, totalUnits ? 100 - dispatchedPercentage - pendingPercentage : 0];
  const fulfilledRate = percentages[0];
  document.getElementById("staffFulfilmentRate").textContent = `${fulfilledRate}%`;
  document.getElementById("staffFulfilmentSummary").innerHTML = `
    <div class="fulfilmentDonut" style="--fulfilled:${percentages[0]}%;--in-progress:${percentages[0] + percentages[1]}%">
      <span><b>${fulfilledRate}%</b><small>${totalUnits ? "Dispatched" : "No data"}</small></span>
    </div>
    <div class="fulfilmentLegend">
      <div><i class="legendGreen"></i><span>Dispatched</span><b>${percentages[0]}%</b></div>
      <div><i class="legendBlue"></i><span>In Progress</span><b>${percentages[1]}%</b></div>
      <div><i class="legendGold"></i><span>Other</span><b>${percentages[2]}%</b></div>
    </div>`;
}

function renderProducts() {
  const maxBySku = {};
  if (currentUser.role === "customer") {
    snapshot.products.forEach((product) => { maxBySku[product.sku] = product.available; });
  } else {
    snapshot.stores.forEach((store) => store.inventory.forEach((item) => {
      maxBySku[item.sku] = (maxBySku[item.sku] || 0) + item.available;
    }));
  }
  document.getElementById("products").innerHTML = snapshot.products.map((product) => `
    <article class="product">
      <div class="productArt">${product.emoji}</div>
      <h3>${product.name}</h3>
      <p>${maxBySku[product.sku] || 0} units available</p>
      <div class="productBottom"><b>${money(product.price)}</b><button class="add" data-add="${product.sku}" aria-label="Add ${product.name}">+</button></div>
    </article>`).join("");
  document.querySelectorAll("[data-add]").forEach((button) => button.onclick = () => {
    cart[button.dataset.add] = (cart[button.dataset.add] || 0) + 1;
    renderCart();
  });
}

function renderCustomerOrders() {
  const target = document.getElementById("customerOrders");
  target.innerHTML = snapshot.orders.length ? snapshot.orders.map((order) => `
    <article class="orderCard">
      <div class="orderHead"><b>Order ${escapeHtml(order.id)}</b><span class="pill">${escapeHtml(order.status.replaceAll("_", " ").toUpperCase())}</span></div>
      ${order.items.some((item) => item.status === "paid") ? `<label class="refundCodeEntry">Enter unique order code to request a refund<input data-refund-code="${escapeHtml(order.id)}" autocomplete="off"></label>` : ""}
      <div class="customerOrderItems">${order.items.map((item) => `
        <div class="customerOrderItem">
          <span class="part">${escapeHtml(item.name)} ×${item.quantity} · ${escapeHtml(item.storeName || item.storeId)} · ${escapeHtml(item.status)}</span>
          ${["reserved", "paid"].includes(item.status) && !["pending", "hold"].includes(order.paymentStatus) ? `<button type="button" data-cancel-item="${escapeHtml(item.itemId)}" data-order="${escapeHtml(order.id)}" data-item-status="${escapeHtml(item.status)}" data-item-name="${escapeHtml(item.name)}" data-item-amount="${Number(item.amount)}">${item.status === "paid" ? `Cancel & refund ${money(item.amount)}` : "Cancel item"}</button>` : ""}
        </div>`).join("")}</div>
      ${order.status === "reserved" ? `
        <div class="orderPayment" data-payment-qr="${escapeHtml(order.id)}" aria-live="polite"><p class="hint">Loading UPI payment QR…</p></div>
        <div class="paymentProof">
          ${order.paymentStatus === "pending" ? `<p class="paymentStatus pending">Payment proof submitted · Waiting for admin review</p>` : ""}
          ${order.paymentStatus === "hold" ? `<p class="paymentStatus hold">Payment proof is on hold · Contact the store admin</p>` : ""}
          ${order.paymentStatus === "rejected" ? `<p class="paymentStatus rejected">Payment proof rejected${order.paymentReviewNote ? `: ${escapeHtml(order.paymentReviewNote)}` : ""}. Submit corrected details to retry.</p>` : ""}
          ${!order.paymentStatus || order.paymentStatus === "rejected" ? `
            <form class="paymentProofForm" data-payment-proof="${escapeHtml(order.id)}">
              <label>UPI UTR / transaction reference<input name="utr" autocomplete="off" minlength="6" maxlength="35" pattern="[A-Za-z0-9/-]{6,35}" required></label>
              <label>Payment screenshot <span class="optional">(optional, PNG/JPEG/WebP, max 200 KB)</span><input name="proof" type="file" accept="image/png,image/jpeg,image/webp"></label>
              <button type="submit" class="primary">Submit payment for review</button>
            </form>` : ""}
        </div>` : ""}
      <p class="hint">Order total: ${money(order.total)}${order.paidTotal ? `<br>Paid: ${money(order.paidTotal)}` : ""}${order.refundTotal ? `<br>Demo refund recorded: ${money(order.refundTotal)}` : ""}${order.paymentCode ? `<br>Unique order code: <b>${escapeHtml(order.paymentCode)}</b>` : ""}</p>
    </article>`).join("") : `<p class="hint">Your placed orders and their status will appear here.</p>`;
  snapshot.orders.filter((order) => order.status === "reserved").forEach((order) => loadPaymentQr(order.id));
  document.querySelectorAll("[data-payment-proof]").forEach((form) => {
    form.onsubmit = async (event) => {
      event.preventDefault();
      const utr = form.elements.utr.value.trim();
      const proofFile = form.elements.proof.files[0];
      if (proofFile && (proofFile.size > 200 * 1024 || !["image/png", "image/jpeg", "image/webp"].includes(proofFile.type))) {
        return toast("Choose a PNG, JPEG, or WebP screenshot smaller than 200 KB");
      }
      try {
        const proofDataUrl = proofFile ? await readFileAsDataUrl(proofFile) : null;
        await api(`/api/orders/${encodeURIComponent(form.dataset.paymentProof)}/payment-proof`, {
          method:"POST",
          body:JSON.stringify({ utr, proofDataUrl }),
        });
        toast("Payment proof submitted. The admin will review it.");
        await load();
      } catch (error) { toast(error.message); }
    };
  });
  document.querySelectorAll("[data-cancel-item]").forEach((button) => button.onclick = async () => {
    const orderId = button.dataset.order;
    const itemId = button.dataset.cancelItem;
    const paid = button.dataset.itemStatus === "paid";
    const refundCodeInput = paid
      ? [...document.querySelectorAll("[data-refund-code]")].find((input) => input.dataset.refundCode === orderId)
      : null;
    const paymentCode = refundCodeInput?.value.trim() || "";
    if (paid && !paymentCode) return toast("Enter the unique order code shown on this order");
    const prompt = paid
      ? `Cancel ${button.dataset.itemName}? Its refund will be recorded after the order code is verified.`
      : `Cancel ${button.dataset.itemName}? Other items in this order will stay reserved.`;
    if (!window.confirm(prompt)) return;
    try {
      await api(`/api/orders/${orderId}/cancel`, {
        method:"POST",
        body:JSON.stringify({ eventId:`customer-cancel-${orderId}-${itemId}`, itemId, ...(paid ? { paymentCode } : {}) }),
      });
      toast(paid ? `Item cancelled. Refund of ${money(Number(button.dataset.itemAmount))} recorded.` : "Item cancelled; the rest of the order remains.");
      await load();
    } catch (error) { toast(error.message); }
  });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Could not read payment screenshot"));
    reader.readAsDataURL(file);
  });
}

async function loadPaymentQr(orderId) {
  const findTarget = () => [...document.querySelectorAll("[data-payment-qr]")]
    .find((element) => element.dataset.paymentQr === orderId);
  const target = findTarget();
  if (!target) return;
  try {
    const payment = await api(`/api/orders/${encodeURIComponent(orderId)}/payment-qr`);
    const currentTarget = findTarget();
    if (!currentTarget) return;
    currentTarget.innerHTML = `
      <img src="${escapeHtml(payment.qrDataUrl)}" alt="UPI payment QR for order ${escapeHtml(orderId)}">
      <div><b>Scan to pay ${money(payment.amount)}</b><span>UPI ID: ${escapeHtml(payment.upiId)}</span>
      <a href="${escapeHtml(payment.paymentUri)}">Open in a UPI app</a>
      <small>This QR does not automatically verify payment or update your order.</small></div>`;
  } catch (error) {
    const currentTarget = findTarget();
    if (currentTarget) currentTarget.innerHTML = `<p class="hint">${escapeHtml(error.message)}</p>`;
  }
}

function renderPaymentVerification() {
  const submissions = snapshot.paymentSubmissions || [];
  const openCount = submissions.filter((submission) => ["pending", "hold"].includes(submission.status)).length;
  document.getElementById("paymentQueueCount").textContent = openCount;
  document.getElementById("paymentVerificationList").innerHTML = submissions.length
    ? submissions.map((submission) => `
      <article class="paymentReviewCard" data-payment-review-card="${escapeHtml(submission.submissionId)}">
        <div class="paymentReviewHeader">
          <div><b>Order ${escapeHtml(submission.orderId)}</b><span>${escapeHtml(submission.customer)} · ${escapeHtml(submission.customerEmail)}</span></div>
          <strong>${money(submission.amount)}</strong>
        </div>
        <div class="paymentReviewDetails">
          <span><b>UTR:</b> ${escapeHtml(submission.utr)}</span>
          <span><b>Status:</b> ${escapeHtml(submission.status.replaceAll("_", " ").toUpperCase())}</span>
          <span><b>Submitted:</b> ${new Date(submission.submittedAt).toLocaleString()}</span>
          ${submission.reviewNote ? `<span><b>Review note:</b> ${escapeHtml(submission.reviewNote)}</span>` : ""}
          ${submission.paymentCode ? `<span><b>Order code:</b> ${escapeHtml(submission.paymentCode)}</span>` : ""}
        </div>
        ${submission.proofDataUrl ? `<a class="paymentProofImageLink" href="${escapeHtml(submission.proofDataUrl)}" target="_blank" rel="noopener noreferrer"><img src="${escapeHtml(submission.proofDataUrl)}" alt="Payment screenshot for order ${escapeHtml(submission.orderId)}"></a>` : `<p class="hint">No screenshot attached.</p>`}
        ${["pending", "hold"].includes(submission.status) ? `
          <label class="paymentReviewNote">Review note <span class="optional">(required to reject)</span><input data-review-note maxlength="300"></label>
          <div class="paymentReviewActions">
            <button type="button" class="primary" data-payment-decision="approve" data-order="${escapeHtml(submission.orderId)}" data-submission="${escapeHtml(submission.submissionId)}">Received payment · generate code</button>
            <button type="button" class="paymentRejectButton" data-payment-decision="reject" data-order="${escapeHtml(submission.orderId)}" data-submission="${escapeHtml(submission.submissionId)}">Reject</button>
            ${submission.status === "pending" ? `<button type="button" class="paymentHoldButton" data-payment-decision="hold" data-order="${escapeHtml(submission.orderId)}" data-submission="${escapeHtml(submission.submissionId)}">Hold</button>` : ""}
          </div>` : ""}
      </article>`).join("")
    : `<p class="paymentQueueEmpty">No payment submissions to review.</p>`;

  document.querySelectorAll("[data-payment-decision]").forEach((button) => {
    button.onclick = async () => {
      const card = button.closest("[data-payment-review-card]");
      const decision = button.dataset.paymentDecision;
      const note = card.querySelector("[data-review-note]")?.value.trim() || "";
      if (decision === "reject" && note.length < 3) return toast("Add a short reason before rejecting a payment");
      if (decision === "approve" && !window.confirm("Verify this UTR in your UPI/bank app, then confirm payment received to generate this order's code. Continue?")) return;
      try {
        const result = await api(`/api/orders/${encodeURIComponent(button.dataset.order)}/payment-submissions/${encodeURIComponent(button.dataset.submission)}/review`, {
          method:"POST",
          body:JSON.stringify({ decision, note }),
        });
        if (decision === "approve") {
          toast(`Payment received. Order code: ${result.paymentCode}`);
        } else {
          toast(decision === "hold" ? "Payment proof put on hold" : "Payment proof rejected");
        }
        await refreshDashboard();
      } catch (error) { toast(error.message); }
    };
  });
}

function renderCart() {
  const entries = Object.entries(cart).filter(([, quantity]) => quantity > 0);
  let total = 0;
  document.getElementById("cartItems").innerHTML = entries.length ? entries.map(([sku, quantity]) => {
    const product = snapshot.products.find((item) => item.sku === sku);
    total += product.price * quantity;
    return `<div class="cartRow"><span class="cartName"><b>${product.name}</b><small>${quantity} × ${money(product.price)}</small></span><button data-remove="${sku}">−</button></div>`;
  }).join("") : `<p class="hint">Your basket is empty</p>`;
  document.getElementById("cartTotal").textContent = money(total);
  document.querySelectorAll("[data-remove]").forEach((button) => button.onclick = () => {
    cart[button.dataset.remove] -= 1;
    if (cart[button.dataset.remove] <= 0) delete cart[button.dataset.remove];
    renderCart();
  });
}

function renderStores() {
  document.getElementById("storeGrid").innerHTML = snapshot.stores.map((store) => `
    <article class="storeCard">
      <div class="storeHead"><div><b>${store.name}</b><br><small>${store.id}</small></div><span class="status ${store.available ? "" : "offline"}">${store.available ? "AVAILABLE" : "OFFLINE"}</span></div>
      <div class="stockList">${store.inventory.map((item) => `<div class="stockRow"><span>${item.name}</span><b>${item.available} <small>(${item.reserved} held)</small></b></div>`).join("")}</div>
    </article>`).join("");
}

function renderOrders() {
  const storeNames = Object.fromEntries(snapshot.stores.map((store) => [store.id, store.name]));
  document.getElementById("orderBadge").textContent = `${snapshot.orders.length} order${snapshot.orders.length === 1 ? "" : "s"}`;
  document.getElementById("staffOrdersHint").textContent = "Live orders across your stores.";
  document.getElementById("orders").innerHTML = snapshot.orders.length
    ? snapshot.orders.map((order) => {
      const itemCount = order.items.reduce((total, item) => total + item.quantity, 0);
      const orderStatus = order.items.some((item) => item.status === "failed")
        ? { label:"Recovery Needed", state:"stock" }
        : order.status === "reserved" ? { label:"Awaiting Payment", state:"pending" }
          : order.status === "paid" ? { label:"Ready to Ship", state:"ready" }
            : order.status === "partially_fulfilled" ? { label:"In Progress", state:"ready" }
              : order.status === "fulfilled" ? { label:"Fulfilled", state:"complete" }
                : { label:order.status.replaceAll("_", " "), state:"pending" };
      const actions = order.status === "reserved"
        ? `<span class="staffNoAction">Awaiting payment verification</span>`
        : ["paid", "partially_fulfilled"].includes(order.status)
          ? order.items.filter((item) => item.status === "paid").map((item) =>
            `<button class="staffRowAction ready" data-dispatch="${escapeHtml(order.id)}|${escapeHtml(item.storeId)}">Dispatch</button>`).join("")
          : `<span class="staffNoAction">—</span>`;
      const details = order.items.map((item) => `
        <span>${escapeHtml(item.name)} ×${item.quantity} · ${escapeHtml(storeNames[item.storeId] || item.storeId)} · ${escapeHtml(item.status)}</span>`).join("");
      return `
        <article class="staffOrderRow" role="row">
          <div class="staffOrderId">#${escapeHtml(order.id)}</div>
          <span>${escapeHtml(order.customer)}</span><span>${itemCount} ${itemCount === 1 ? "Item" : "Items"}</span><b>${money(order.total)}</b>
          <span><b class="staffOrderStatus ${orderStatus.state}">${escapeHtml(orderStatus.label)}</b></span><div class="staffRowActions">${actions}</div>
          <details class="staffRowDetails"><summary>Items &amp; delivery</summary><div>${details}
            ${order.deliveryDetails ? `<p><b>Deliver to:</b> ${escapeHtml(order.deliveryDetails.fullName)} · ${escapeHtml(order.deliveryDetails.phone)}<br>${escapeHtml(order.deliveryDetails.address)}, ${escapeHtml(order.deliveryDetails.city)} ${escapeHtml(order.deliveryDetails.pincode)}</p>` : ""}
            ${order.items.filter((item) => item.status === "paid").map((item) => `<button data-fail="${escapeHtml(order.id)}|${escapeHtml(item.storeId)}">Mark ${escapeHtml(item.storeId)} unavailable</button>`).join("")}
          </div></details>
        </article>`;
    }).join("")
    : `<p class="staffNoOrders">No orders have been placed yet.</p>`;
  document.querySelectorAll("[data-dispatch]").forEach((button) => button.onclick = async () => {
    const [orderId, storeId] = button.dataset.dispatch.split("|");
    await api(`/api/orders/${orderId}/dispatch/${storeId}`, { method:"POST" }); toast("Fulfilment dispatched"); await load();
  });
  document.querySelectorAll("[data-fail]").forEach((button) => button.onclick = async () => {
    const [orderId, storeId] = button.dataset.fail.split("|");
    await api(`/api/orders/${orderId}/fail-store/${storeId}`, {
      method:"POST",
      body:JSON.stringify({ refundDelayMs:1500 }),
    });
    toast("Store failure recorded; delayed refund and staff issue created");
    await load();
  });
}

function renderTimeline() {
  const openIssues = (snapshot.issues || []).filter((issue) => issue.status === "open");
  document.getElementById("issueCount").textContent = `${openIssues.length} open issue${openIssues.length === 1 ? "" : "s"}`;
  document.getElementById("sidebarIssueCount").textContent = openIssues.length;
  document.getElementById("recoveryIssues").innerHTML = openIssues.length ? openIssues.map((issue) => `
    <article class="recoveryIssue">
      <b>${escapeHtml(issue.message)}</b>
      <p>Order ${escapeHtml(issue.orderId)} · ${escapeHtml(issue.storeName)} · ${issue.affectedItems.map((item) => `${escapeHtml(item.name)} ×${item.quantity} (${escapeHtml(item.status)})`).join(", ")}</p>
      <p>Refunded amount: ${money(issue.amount)} · Reported ${new Date(issue.createdAt).toLocaleString()}</p>
      <button data-resolve-issue="${escapeHtml(issue.id)}" data-order="${escapeHtml(issue.orderId)}">Mark reviewed</button>
    </article>`).join("") : `<p class="recoveryEmpty">No unresolved store failures.</p>`;
  document.querySelectorAll("[data-resolve-issue]").forEach((button) => button.onclick = async () => {
    try {
      await api(`/api/orders/${button.dataset.order}/issues/${button.dataset.resolveIssue}/resolve`, { method:"POST" });
      toast("Recovery issue marked reviewed");
      await load();
    } catch (error) { toast(error.message); }
  });
  document.getElementById("timeline").innerHTML = snapshot.events.map((event) => `
    <article class="event"><b>${escapeHtml(event.message)}</b><br><small>${new Date(event.at).toLocaleTimeString()} · ${escapeHtml(event.type)}${event.orderId ? ` · ${escapeHtml(event.orderId)}` : ""}</small></article>`).join("");
  document.getElementById("financial").innerHTML = snapshot.financial.length ? snapshot.financial.map((operation) => `
    <div class="financeRow"><b>${escapeHtml(operation.type.toUpperCase())} · ${money(operation.amount)}</b><small>${escapeHtml(operation.status)} · ${escapeHtml(operation.eventId)}</small></div>`).join("") : `<p class="hint">No financial operations</p>`;
}

async function loadStaffAccounts() {
  if (currentUser.role !== "admin") return;
  const result = await api("/api/auth/directory");
  document.getElementById("staffCount").textContent = result.counts.staff;
  document.getElementById("customerCount").textContent = result.counts.customers;
  document.getElementById("staffDirectoryCount").textContent = `${result.counts.staff} accounts`;
  document.getElementById("customerDirectoryCount").textContent = `${result.counts.customers} accounts`;
  document.getElementById("staffList").innerHTML = result.staff.length
    ? result.staff.map((person) => `<span class="staffBadge">${person.name} · <b>${person.id}</b></span>`).join("")
    : `<span class="hint">No staff accounts created yet.</span>`;
  document.getElementById("customerList").innerHTML = result.customers.length
    ? result.customers.map((customer) => `<span class="staffBadge"><b>${customer.email}</b><br><small>First seen ${new Date(customer.firstSeenAt).toLocaleDateString()}</small></span>`).join("")
    : `<span class="hint">No customers have signed in yet.</span>`;
}

async function refreshDashboard() {
  await load();
  await loadStaffAccounts();
}

document.getElementById("checkout").onclick = () => {
  if (!Object.values(cart).some((quantity) => quantity > 0)) return toast("Add at least one product");
  document.getElementById("deliveryForm").classList.remove("hidden");
  document.getElementById("checkout").classList.add("hidden");
};
document.getElementById("cancelDelivery").onclick = () => {
  document.getElementById("deliveryForm").classList.add("hidden");
  document.getElementById("checkout").classList.remove("hidden");
};
document.getElementById("deliveryForm").onsubmit = async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = new FormData(form);
  const items = Object.entries(cart).filter(([, quantity]) => quantity > 0).map(([sku, quantity]) => ({ sku, quantity }));
  const deliveryDetails = {
    fullName:values.get("fullName"), phone:values.get("phone"), address:values.get("address"),
    landmark:values.get("landmark"), city:values.get("city"), pincode:values.get("pincode"),
  };
  try {
    await api("/api/orders", { method:"POST", body:JSON.stringify({ items, split:true, deliveryDetails }) });
    Object.keys(cart).forEach((sku) => delete cart[sku]);
    form.reset();
    form.classList.add("hidden");
    document.getElementById("checkout").classList.remove("hidden");
    toast("Order placed. Staff will use your delivery details.");
    await load();
  } catch (error) { toast(error.message); }
};

document.getElementById("reset").onclick = async () => { snapshot = await api("/api/controls/reset", { method:"POST" }); Object.keys(cart).forEach((sku) => delete cart[sku]); toast("Demo reset"); render(); };
document.getElementById("demoScenario").onclick = async () => {
  try {
    snapshot = await api("/api/controls/reset", { method:"POST" });
    await api("/api/orders", { method:"POST", body:JSON.stringify({ items:[{sku:"PHONE-01",quantity:5},{sku:"BUDS-01",quantity:1}], split:true }) });
    toast("Demo order created. Simulate payment, then test store dispatch or failure.");
    await load();
  } catch (error) { toast(error.message); }
};
document.getElementById("concurrency").onclick = async () => { const result = await api("/api/controls/concurrency-demo", { method:"POST" }); snapshot = result.snapshot; const successes = result.responses.filter((entry) => entry.result).length; toast(`${successes} purchases succeeded; overselling blocked`); render(); };
document.getElementById("refreshOrders").onclick = async () => {
  try { await refreshDashboard(); toast("Orders and fulfilment data refreshed"); }
  catch (error) { toast(error.message); }
};

document.getElementById("staffRefreshOrders").onclick = async () => {
  try { await refreshDashboard(); toast("Orders and fulfilment data refreshed"); }
  catch (error) { toast(error.message); }
};

document.querySelectorAll("[data-dashboard-link]").forEach((button) => button.onclick = () => {
  const viewName = button.dataset.view || "admin";
  const view = document.getElementById(`${viewName}View`);
  const target = document.getElementById(button.dataset.section);
  if (!view || !target || target.classList.contains("hidden")) return;
  document.querySelectorAll(".view").forEach((item) => item.classList.add("hidden"));
  view.classList.remove("hidden");
  document.querySelectorAll(".nav").forEach((item) => item.classList.toggle("active", item.dataset.view === viewName));
  document.querySelectorAll("[data-dashboard-link]").forEach((item) => item.classList.remove("active"));
  button.classList.add("active");
  target.scrollIntoView({ behavior:"smooth", block:"start" });
});

document.querySelectorAll(".nav").forEach((button) => button.onclick = () => {
  document.querySelectorAll(".nav").forEach((item) => item.classList.remove("active"));
  document.querySelectorAll("[data-dashboard-link]").forEach((item) => item.classList.remove("active"));
  button.classList.add("active");
  if (button.dataset.view === "admin") {
    const section = currentUser.role === "admin" ? "adminTop" : "orderSection";
    const dashboardLink = [...document.querySelectorAll("[data-dashboard-link]")].find((item) =>
      item.dataset.section === section && !item.classList.contains("hidden"));
    if (dashboardLink) dashboardLink.classList.add("active");
  }
  document.querySelectorAll(".view").forEach((view) => view.classList.add("hidden"));
  document.getElementById(`${button.dataset.view}View`).classList.remove("hidden");
});

function selectLoginMode(mode) {
  loginMode = mode;
  document.body.dataset.role = mode;
  document.getElementById("loginRoleBadge").textContent = `Signing in as ${mode === "admin" ? "Admin / Owner" : mode === "staff" ? "Staff" : "Customer"}`;
  document.querySelectorAll(".loginMode").forEach((button) => button.classList.toggle("active", button.dataset.loginMode === mode));
  document.getElementById("customerLogin").classList.toggle("hidden", mode !== "customer");
  document.getElementById("credentialLogin").classList.toggle("hidden", mode === "customer");
  document.getElementById("credentialIdLabel").firstChild.textContent = mode === "admin" ? "Admin ID" : "Staff ID";
  document.getElementById("credentialSubmit").textContent = mode === "admin" ? "Admin sign in" : "Staff sign in";
  document.getElementById("loginHint").textContent = mode === "customer"
    ? "Email verification is not enabled in this free demo."
    : mode === "admin" ? "Admin can create staff IDs and temporary passwords." : "Use the staff ID and password issued by your admin.";
  document.getElementById("loginError").textContent = "";
}

function showApp(user) {
  currentUser = user;
  document.body.dataset.role = user.role;
  document.body.classList.add("authenticated");
  document.getElementById("authScreen").classList.add("hidden");
  document.getElementById("appMain").classList.remove("hidden");
  document.getElementById("demoNav").classList.remove("hidden");
  document.getElementById("logout").classList.remove("hidden");
  const roleLabels = {
    customer: `Customer · ${user.email}`,
    admin: "Admin / Owner",
    staff: `Staff · ${user.name} (${user.id})`,
  };
  const roleBadge = document.getElementById("roleBadge");
  roleBadge.textContent = roleLabels[user.role];
  roleBadge.classList.remove("hidden");
  document.getElementById("adminTitle").textContent = user.role === "admin" ? "Admin Dashboard" : "Staff Dashboard";
  document.getElementById("adminSubtitle").textContent = user.role === "admin"
    ? "Orders, inventory and fulfilment across every store."
    : "Manage orders, fulfilment and stock across all stores.";
  document.getElementById("sidebarUserName").textContent = user.role === "admin" ? "Store administrator" : user.name;
  document.getElementById("sidebarUserStore").textContent = user.role === "admin" ? "Owner / Admin" : "All stores";
  document.getElementById("sidebarAvatar").textContent = (user.name || user.id || "S").trim().charAt(0).toUpperCase();
  document.querySelectorAll("[data-roles]").forEach((button) => {
    button.classList.toggle("hidden", !button.dataset.roles.split(",").includes(user.role));
  });
  document.getElementById("shopView").classList.toggle("hidden", user.role !== "customer");
  document.getElementById("adminView").classList.toggle("hidden", user.role === "customer");
  document.getElementById("timelineView").classList.toggle("hidden", user.role === "customer");
  document.querySelector(".orderSection").classList.toggle("hidden", user.role === "admin");
  document.getElementById("staffManagement").classList.toggle("hidden", user.role !== "admin");
  document.getElementById("demoControls").classList.toggle("hidden", user.role !== "admin");
  document.querySelector(".opsSummary").classList.toggle("hidden", user.role === "staff");
  document.querySelector(".staffMetrics").classList.toggle("hidden", user.role !== "staff");
  document.querySelector(".staffTabs").classList.toggle("hidden", user.role !== "staff");
  document.getElementById("staffQuickActions").classList.toggle("hidden", user.role !== "staff");
  document.getElementById("reset").classList.toggle("hidden", user.role !== "admin");
  document.getElementById("demoScenario").classList.toggle("hidden", user.role !== "admin");
  document.getElementById("concurrency").classList.toggle("hidden", user.role !== "admin");
  document.getElementById("refreshOrders").classList.toggle("hidden", user.role === "customer");
  if (user.role !== "customer") document.getElementById("shopView").remove();
  if (user.role === "customer") {
    document.getElementById("adminView").remove();
    document.getElementById("timelineView").remove();
  } else if (user.role === "admin") {
    document.getElementById("timelineView").remove();
  } else if (user.role === "staff") {
    document.getElementById("staffManagement").remove();
  }
  document.querySelectorAll(".nav").forEach((button) => button.classList.remove("active"));
  const initialView = user.role === "customer" ? "shop" : "admin";
  document.querySelector(`[data-view="${initialView}"]`).classList.add("active");
  if (user.role !== "customer") {
    const initialSection = user.role === "admin" ? "adminTop" : "orderSection";
    const initialLink = [...document.querySelectorAll("[data-dashboard-link]")].find((button) =>
      button.dataset.section === initialSection && !button.classList.contains("hidden"));
    if (initialLink) initialLink.classList.add("active");
  }
  document.querySelectorAll(".view").forEach((view) => view.classList.add("hidden"));
  document.getElementById(`${initialView}View`).classList.remove("hidden");
  refreshDashboard().catch((error) => toast(error.message));
  if (refreshTimer) window.clearInterval(refreshTimer);
  refreshTimer = window.setInterval(() => {
    const hasPaymentDraft = currentUser?.role === "customer" && (
      [...document.querySelectorAll(".paymentProofForm")].some((form) =>
        form.elements.utr.value.trim() || form.elements.proof.files.length > 0) ||
      [...document.querySelectorAll("[data-refund-code]")].some((input) => input.value.trim())
    );
    if (!document.hidden && currentUser && !hasPaymentDraft) {
      refreshDashboard().catch((error) => console.error("Background refresh failed:", error));
    }
  }, 5000);
}

document.querySelectorAll(".loginMode").forEach((button) => {
  button.onclick = () => selectLoginMode(button.dataset.loginMode);
});

document.getElementById("customerLogin").onsubmit = async (event) => {
  event.preventDefault();
  try {
    const result = await api("/api/auth/customer", { method:"POST", body:JSON.stringify({ email:new FormData(event.currentTarget).get("email") }) });
    authToken = result.token;
    sessionStorage.setItem("resolve-token", authToken);
    showApp(result.user);
  } catch (error) { document.getElementById("loginError").textContent = error.message; }
};

document.getElementById("credentialLogin").onsubmit = async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    const endpoint = loginMode === "admin" ? "/api/auth/admin" : "/api/auth/staff/login";
    const result = await api(endpoint, { method:"POST", body:JSON.stringify({ id:form.get("id"), password:form.get("password") }) });
    authToken = result.token;
    sessionStorage.setItem("resolve-token", authToken);
    showApp(result.user);
  } catch (error) { document.getElementById("loginError").textContent = error.message; }
};

document.getElementById("staffForm").onsubmit = async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(event.currentTarget);
  try {
    await api("/api/auth/staff", { method:"POST", body:JSON.stringify({ id:form.get("id"), name:form.get("name"), password:form.get("password") }) });
    formElement.reset();
    toast("Staff account created. Share the ID and password securely.");
    await loadStaffAccounts();
  } catch (error) { toast(error.message); }
};

document.getElementById("logout").onclick = async () => {
  try { await api("/api/auth/logout", { method:"POST" }); } catch (error) { console.warn("Sign-out cleanup failed", error); }
  sessionStorage.removeItem("resolve-token");
  window.location.href = "/";
};

async function restoreSession() {
  document.getElementById("demoNav").classList.add("hidden");
  document.getElementById("logout").classList.add("hidden");
  if (!authToken) return;
  try {
    const result = await api("/api/auth/me");
    showApp(result.user);
  } catch (_error) {
    sessionStorage.removeItem("resolve-token");
    authToken = null;
  }
}

selectLoginMode("customer");
restoreSession();


async function renderStoreReliability() {
  const grid = document.getElementById("storeGrid");
  if (!grid || !currentUser ||
      !["admin", "staff"].includes(currentUser.role)) return;

  try {
    const data = await api("/api/controls/store-reliability");
    if (!currentUser ||
        !["admin", "staff"].includes(currentUser.role)) return;

    grid.querySelectorAll(".reliabilityBox").forEach(
      node => node.remove()
    );

    grid.querySelectorAll(".storeCard").forEach(card => {
      const storeId = card.querySelector(".storeHead small")?.textContent;
      const entry = data.scores.find(s => s.storeId === storeId);
      if (!entry) return;

      const score = entry.score === null
        ? null
        : Math.max(0, Math.min(100, Number(entry.score)));

      const color = score === null ? "#64748b"
        : score >= 90 ? "#16a34a"
        : score >= 75 ? "#2563eb" : "#f59e0b";

      const box = document.createElement("div");
      box.className = "reliabilityBox";
      box.style.cssText = "margin-top:14px;padding:12px;background:#f1f5f9;border-radius:12px;color:#1e293b;";

      box.innerHTML = `
        <div style="display:flex;justify-content:space-between">
          <b>Reliability Score</b>
          <b style="color:${color}">
            ${score === null ? "No data" : score + "%"}
          </b>
        </div>
        <div style="background:#cbd5e1;height:9px;border-radius:10px;margin:10px 0;overflow:hidden">
          <div style="width:${score ?? 0}%;height:100%;background:${color};border-radius:10px"></div>
        </div>
        <small>Dispatched: ${Number(entry.successful)} |
        Failed: ${Number(entry.failed)}</small>
      `;

      card.appendChild(box);
    });

  } catch (error) {
    console.warn("Reliability score unavailable:", error.message);
  }
}


function attachStoreSwitchButtons() {
  if (currentUser?.role !== "customer") return;

  document.querySelectorAll('[data-cancel-item][data-item-status="paid"]').forEach(cancelButton => {
    const parent = cancelButton.parentElement;

    if (parent.querySelector(".switchStoreButton")) return;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "switchStoreButton";
    button.textContent = "Switch Store";

    button.style.cssText =
      "background:#2563eb;color:white;border:0;border-radius:8px;padding:9px 14px;margin:5px;cursor:pointer;font-weight:600;";

    button.onclick = async () => {
      const orderId = cancelButton.dataset.order;
      const itemId = cancelButton.dataset.cancelItem;

      const codeInput = [...document.querySelectorAll("[data-refund-code]")]
        .find(input => input.dataset.refundCode === orderId);

      const paymentCode = codeInput?.value.trim();

      if (!paymentCode) {
        return toast("Enter your unique order code first");
      }

      button.disabled = true;

      try {
        const data = await api(
          `/api/orders/${encodeURIComponent(orderId)}/alternatives/${encodeURIComponent(itemId)}`
        );

        const alternatives = data.alternatives || [];

        if (!alternatives.length) {
          return toast("No alternative store has sufficient stock");
        }

        const choices = alternatives.map((s, i) =>
          `${i + 1}. ${s.name} - Stock: ${s.available}`
        ).join("\n");

        const answer = window.prompt(
          "Choose an alternative store:\n" + choices
        );

        if (answer === null) return;

        const choice = Number(answer);

        if (!Number.isInteger(choice) ||
            choice < 1 ||
            choice > alternatives.length) {
          return toast("Invalid store selection");
        }

        const target = alternatives[choice - 1];

        if (!window.confirm(
          `Switch to ${target.name}? No additional payment required.`
        )) return;

        await api(
          `/api/orders/${encodeURIComponent(orderId)}/switch-store`,
          {
            method: "POST",
            body: JSON.stringify({
              itemId,
              targetStoreId: target.storeId,
              paymentCode
            })
          }
        );

        toast("Store switched successfully!");
        await load();

      } catch (error) {
        toast(error.message);
      } finally {
        button.disabled = false;
      }
    };

    parent.appendChild(button);
  });
}
