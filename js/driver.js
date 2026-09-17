const DRIVER_ORDERS_COLLECTION = "orders";
const DRIVER_ID = "DRV-001";
const DRIVER_NAME = "BigV904";
const DRIVER_VEHICLE = "Executive Sedan";
const pendingClaims = new Set();

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function displayValue(value, fallback = "Not provided") {
  return escapeHtml(value || fallback);
}

function formatCreatedAt(value) {
  if (!value) return "Time unavailable";
  const date = typeof value.toDate === "function" ? value.toDate() : new Date(value);
  if (Number.isNaN(date.getTime())) return "Time unavailable";
  return date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function renderOrders(snapshot) {
  const container = document.getElementById("ordersContainer");
  const count = document.getElementById("orderCount");
  const pendingOrders = [];

  snapshot.forEach((doc) => {
    const order = doc.data();
    if (String(order.status || "").toLowerCase() === "pending") {
      pendingOrders.push({ id: doc.id, ...order });
    }
  });
  pendingOrders.sort((left, right) => {
    const leftTime = left.createdAt?.toMillis?.() || new Date(left.createdAt || 0).getTime();
    const rightTime = right.createdAt?.toMillis?.() || new Date(right.createdAt || 0).getTime();
    return rightTime - leftTime;
  });

  count.textContent = `${pendingOrders.length} pending`;
  if (!pendingOrders.length) {
    container.innerHTML = `
      <div class="rounded-2xl border border-slate-100 bg-white p-8 text-center text-sm text-slate-600 shadow-sm">
        No pending orders right now.
      </div>`;
    return;
  }

  container.innerHTML = pendingOrders.map((order) => `
    <article class="rounded-2xl border border-slate-100 bg-white p-5 shadow-sm">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p class="font-mono text-xs font-semibold text-blue-600">${displayValue(order.id)}</p>
          <h3 class="mt-1 text-base font-bold text-slate-900">${displayValue(order.vehicleType || order.serviceName || order.vehicle, "Standard ride")}</h3>
        </div>
        <p class="text-lg font-bold text-slate-900">${displayValue(order.estimatedFare || order.fare || order.totalPay, "Fare pending")}</p>
      </div>
      <dl class="mt-4 space-y-3 border-t border-slate-100 pt-4 text-sm">
        <div class="flex gap-3">
          <dt class="w-20 shrink-0 font-semibold text-slate-600">Pickup</dt>
          <dd class="text-slate-900">${displayValue(order.pickup || order.origin)}</dd>
        </div>
        <div class="flex gap-3">
          <dt class="w-20 shrink-0 font-semibold text-slate-600">Drop-off</dt>
          <dd class="text-slate-900">${displayValue(order.dropoff || order.destination)}</dd>
        </div>
        <div class="flex gap-3">
          <dt class="w-20 shrink-0 font-semibold text-slate-600">Created</dt>
          <dd class="text-slate-600">${formatCreatedAt(order.createdAt)}</dd>
        </div>
      </dl>
      <button type="button" data-order-id="${escapeHtml(order.id)}"
        class="claim-order mt-5 w-full rounded-xl bg-blue-600 px-4 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-blue-700 active:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-300">
        Accept order
      </button>
    </article>
  `).join("");
}

async function claimOrder(orderId, button) {
  if (!orderId || pendingClaims.has(orderId)) return;
  pendingClaims.add(orderId);
  button.disabled = true;
  button.textContent = "Processing...";

  try {
    await db.collection(DRIVER_ORDERS_COLLECTION).doc(orderId).update({
      status: "accepted",
      driverId: DRIVER_ID,
      driverName: DRIVER_NAME,
      driverVehicle: DRIVER_VEHICLE,
      acceptedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    button.textContent = "Order accepted";
  } catch (error) {
    console.error("Unable to accept order:", error);
    button.disabled = false;
    button.textContent = "Accept order";
    document.getElementById("driverStatus").textContent = "Unable to accept that order. Please try again.";
    pendingClaims.delete(orderId);
  }
}

function listenForPendingOrders() {
  document.getElementById("driverStatus").textContent = "Connecting to pending orders...";
  console.log(`[Driver] Listening to ${DRIVER_ORDERS_COLLECTION} without composite index query.`);

  db.collection(DRIVER_ORDERS_COLLECTION).onSnapshot(
    (snapshot) => {
      console.log(`[Driver] Order snapshot received: ${snapshot.size} documents.`);
      renderOrders(snapshot);
      document.getElementById("driverStatus").textContent = "Connected. Listening for new pending orders.";
    },
    (error) => {
      console.error("[Driver] Pending order listener failed:", error);
      document.getElementById("driverStatus").textContent = `Connection error: ${error.message || "Unable to load orders."}`;
    }
  );
}

document.getElementById("ordersContainer").addEventListener("click", (event) => {
  const button = event.target.closest(".claim-order");
  if (button) claimOrder(button.dataset.orderId, button);
});

listenForPendingOrders();
