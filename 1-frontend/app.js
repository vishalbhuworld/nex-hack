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
  } else {
    renderOperationsSummary();
    renderStores();
    if (currentUser.role === "staff") {
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
      <div class="orderHead"><b>Order ${order.id}</b><span class="pill">${order.status.replaceAll("_", " ").toUpperCase()}</span></div>
      <div class="orderParts">${order.items.map((item) => `<span class="part">${item.name} ×${item.quantity} · ${item.status}</span>`).join("")}</div>
      <p class="hint">Order total: ${money(order.total)}</p>
      ${order.items.some((item) => ["reserved", "paid"].includes(item.status)) ? `<div class="actions"><button data-cancel-order="${escapeHtml(order.id)}">Cancel remaining items</button></div>` : ""}
    </article>`).join("") : `<p class="hint">Your placed orders and their status will appear here.</p>`;
  document.querySelectorAll("[data-cancel-order]").forEach((button) => button.onclick = async () => {
    try {
      const eventId = `customer-cancel-${button.dataset.cancelOrder}`;
      const body = JSON.stringify({ eventId, delayMs:1200 });
      await api(`/api/orders/${button.dataset.cancelOrder}/cancel`, {
        method:"POST",
        body,
      });
      await api(`/api/orders/${button.dataset.cancelOrder}/cancel`, { method:"POST", body });
      toast("Delayed cancellation accepted; duplicate notification ignored");
      await load();
    } catch (error) { toast(error.message); }
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
  document.getElementById("orderBadge").textContent = `${snapshot.orders.length} orders`;
  document.getElementById("orders").innerHTML = snapshot.orders.length ? snapshot.orders.map((order) => `
    <article class="orderCard">
      <div class="orderHead"><div><b>${escapeHtml(order.id)}</b><br><small>${escapeHtml(order.customer)}</small></div><div><span class="pill">${order.status.replaceAll("_", " ").toUpperCase()}</span> <b>${money(order.total)}</b></div></div>
      <div class="orderParts">${order.items.map((item) => `<span class="part">${item.name} ×${item.quantity} · ${storeNames[item.storeId] || item.storeId} · <b>${item.status}</b></span>`).join("")}</div>
      ${order.customerEmail ? `<div class="deliveryDetails"><b>Customer:</b> ${escapeHtml(order.customerEmail)}</div>` : ""}
      ${order.deliveryDetails ? `<div class="deliveryDetails"><b>Deliver to:</b> ${escapeHtml(order.deliveryDetails.fullName)} · <a href="tel:${escapeHtml(order.deliveryDetails.phone)}">${escapeHtml(order.deliveryDetails.phone)}</a><br>${escapeHtml(order.deliveryDetails.address)}${order.deliveryDetails.landmark ? `, ${escapeHtml(order.deliveryDetails.landmark)}` : ""}, ${escapeHtml(order.deliveryDetails.city)} ${escapeHtml(order.deliveryDetails.pincode)}</div>` : ""}
      ${order.status === "reserved" ? `<div class="actions"><button data-payment="${order.id}">Simulate payment</button></div>` : ""}
      ${order.status === "paid" || order.status === "partially_fulfilled" ? `<div class="actions">${order.items.filter((item) => item.status === "paid").map((item) => `<button data-dispatch="${order.id}|${item.storeId}">Dispatch ${item.storeId}</button>`).join("")}${order.items.filter((item) => item.status === "paid").map((item) => `<button data-fail="${order.id}|${item.storeId}">Fail ${item.storeId}</button>`).join("")}</div>` : ""}
    </article>`).join("") : `<p class="hint">No orders yet</p>`;
  document.querySelectorAll("[data-payment]").forEach((button) => button.onclick = async () => {
    try {
      const eventId = `payment-${button.dataset.payment}-demo`;
      await api(`/api/orders/${button.dataset.payment}/payment`, { method:"POST", body:JSON.stringify({ eventId, delayMs:2000 }) });
      await api(`/api/orders/${button.dataset.payment}/payment`, { method:"POST", body:JSON.stringify({ eventId, delayMs:2000 }) });
      toast("Duplicate payment event ignored safely");
      await load();
    } catch (error) { toast(error.message); }
  });
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

document.querySelectorAll(".nav").forEach((button) => button.onclick = () => {
  document.querySelectorAll(".nav").forEach((item) => item.classList.remove("active"));
  button.classList.add("active");
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
  document.querySelectorAll("[data-roles]").forEach((button) => {
    button.classList.toggle("hidden", !button.dataset.roles.split(",").includes(user.role));
  });
  document.getElementById("shopView").classList.toggle("hidden", user.role !== "customer");
  document.getElementById("adminView").classList.toggle("hidden", user.role === "customer");
  document.getElementById("timelineView").classList.toggle("hidden", user.role === "customer");
  document.querySelector(".orderSection").classList.toggle("hidden", user.role === "admin");
  document.getElementById("staffManagement").classList.toggle("hidden", user.role !== "admin");
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
  document.querySelectorAll(".view").forEach((view) => view.classList.add("hidden"));
  document.getElementById(`${initialView}View`).classList.remove("hidden");
  refreshDashboard().catch((error) => toast(error.message));
  if (refreshTimer) window.clearInterval(refreshTimer);
  refreshTimer = window.setInterval(() => {
    if (!document.hidden && currentUser) refreshDashboard().catch((error) => console.error("Background refresh failed:", error));
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
