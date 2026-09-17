const DRIVER_ORDERS_COLLECTION = "orders";
const DRIVER_ID = "DRV-001";
const DRIVER_NAME = "BigV904";
const DRIVER_VEHICLE = "Executive Sedan";
const pendingClaims = new Set();
const DISMISSED_ORDERS_KEY = "ride2gether_driver_dismissed_orders";
let storedDismissedOrderIds = [];
try {
  const parsedDismissedOrderIds = JSON.parse(localStorage.getItem(DISMISSED_ORDERS_KEY) || "[]");
  storedDismissedOrderIds = Array.isArray(parsedDismissedOrderIds) ? parsedDismissedOrderIds : [];
} catch (error) {
  console.warn("[Driver] Ignoring invalid dismissed order cache:", error);
}
const dismissedOrderIds = new Set(storedDismissedOrderIds);
const observedOrderStatuses = new Map();
const ORDER_STALE_AFTER_MS = 5 * 60 * 1000;
const ACTIVE_TRIP_STATUSES = new Set(["accepted", "arrived", "in_progress"]);
let activeTrip = null;
let noticeTimer = null;

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

function getCreatedAtMillis(value) {
  if (value == null) return null;
  if (value && typeof value.toMillis === "function") return value.toMillis();
  if (value && typeof value.toDate === "function") return value.toDate().getTime();
  const millis = new Date(value || 0).getTime();
  return Number.isNaN(millis) ? null : millis;
}

function formatFare(value) {
  const fare = Number(value);
  return Number.isFinite(fare) ? `₱${fare.toFixed(2)}` : "Fare pending";
}

function isStaleOrder(createdAtMillis) {
  return createdAtMillis != null && Date.now() - createdAtMillis > ORDER_STALE_AFTER_MS;
}

// 防呆：嚴禁對非法 orderId（空值、非字串、或佔位字串 'Generating...'）
// 發起 Firestore doc()/onSnapshot 請求，避免觸發 400 Bad Request 並掐斷 WebChannel。
function isValidOrderId(orderId) {
  return typeof orderId === "string" && orderId.trim().length > 0 && orderId.trim() !== "Generating...";
}

function persistDismissedOrderIds() {
  localStorage.setItem(DISMISSED_ORDERS_KEY, JSON.stringify([...dismissedOrderIds]));
}

function showDriverNotice(message) {
  const notice = document.getElementById("driverNotice");
  if (!notice) return;
  notice.textContent = message;
  notice.classList.remove("hidden");
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => notice.classList.add("hidden"), 5000);
}

function clearActiveTrip() {
  activeTrip = null;
  document.getElementById("activeTripContainer").classList.add("hidden");
}

function renderActiveTrip(order) {
  activeTrip = order;
  const container = document.getElementById("activeTripContainer");
  const status = String(order.status || "").toLowerCase();
  const action = document.getElementById("activeTripAction");
  document.getElementById("activeTripStatus").textContent = status.replace("_", " ");
  document.getElementById("activeTripPickup").textContent = order.pickup || order.origin || "Not provided";
  document.getElementById("activeTripDropoff").textContent = order.dropoff || order.destination || "Not provided";
  document.getElementById("activeTripVehicle").textContent = order.vehicleType || order.serviceName || "Standard ride";
  document.getElementById("activeTripFare").textContent = formatFare(order.estimatedFare ?? order.fare ?? order.totalPay);
  action.disabled = false;
  action.textContent = status === "accepted"
    ? "Arrived at Pickup"
    : status === "arrived"
      ? "Start Trip"
      : "Complete Trip";
  container.classList.remove("hidden");
}

async function advanceActiveTrip() {
  if (!activeTrip) return;
  if (!isValidOrderId(activeTrip.id)) {
    console.warn("[Driver] Skipping trip advance: invalid activeTrip.id.", activeTrip.id);
    return;
  }
  const currentStatus = String(activeTrip.status || "").toLowerCase();
  const nextStatus = currentStatus === "accepted"
    ? "arrived"
    : currentStatus === "arrived"
      ? "in_progress"
      : currentStatus === "in_progress"
        ? "completed"
        : null;
  if (!nextStatus) return;

  const action = document.getElementById("activeTripAction");
  action.disabled = true;
  action.textContent = "Updating...";
  try {
    await db.collection(DRIVER_ORDERS_COLLECTION).doc(activeTrip.id).set({
      status: nextStatus,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      ...(nextStatus === "completed" ? { completedAt: firebase.firestore.FieldValue.serverTimestamp() } : {})
    }, { merge: true });
    if (nextStatus === "completed") {
      clearActiveTrip();
      showDriverNotice("Trip completed. Ready for the next order.");
    }
  } catch (error) {
    console.error("[Driver] Unable to advance trip:", error);
    action.disabled = false;
    action.textContent = "Try again";
    showDriverNotice("Unable to update trip status.");
  }
}

function renderOrders(snapshot) {
  const container = document.getElementById("ordersContainer");
  const count = document.getElementById("orderCount");
  const pendingOrders = [];

  container.innerHTML = "";

  let snapshotActiveTrip = null;
  snapshot.forEach((doc) => {
    if (!isValidOrderId(doc.id)) {
      console.warn("[Driver] Skipping snapshot doc with invalid id.", doc.id);
      return;
    }
    const order = doc.data();
    const status = String(order.status || "").toLowerCase();
    const createdAtMillis = getCreatedAtMillis(order.createdAt);
    const previousStatus = observedOrderStatuses.get(doc.id);
    if (status === "cancelled" && previousStatus === "pending") {
      showDriverNotice("Passenger cancelled this trip.");
      pendingClaims.delete(doc.id);
    }
    observedOrderStatuses.set(doc.id, status);
    const belongsToDriver = order.driverId === DRIVER_ID || order.driverName === DRIVER_NAME;
    if (belongsToDriver && ACTIVE_TRIP_STATUSES.has(status)) {
      snapshotActiveTrip = { id: doc.id, ...order };
    } else if (belongsToDriver && status === "cancelled" && activeTrip?.id === doc.id) {
      clearActiveTrip();
      showDriverNotice("Passenger cancelled the active trip.");
    } else if (belongsToDriver && status === "completed" && activeTrip?.id === doc.id) {
      clearActiveTrip();
    }
    if (status === "pending" && !dismissedOrderIds.has(doc.id) && !isStaleOrder(createdAtMillis)) {
      pendingOrders.push({
        id: doc.id,
        ...order,
        createdAtMillis
      });
    }
  });
  if (snapshotActiveTrip) renderActiveTrip(snapshotActiveTrip);
  else if (activeTrip && !snapshot.docs.some((doc) => doc.id === activeTrip.id)) clearActiveTrip();
  pendingOrders.sort((a, b) => b.createdAtMillis - a.createdAtMillis);

  count.textContent = `${pendingOrders.length} pending`;
  if (!pendingOrders.length) {
    container.innerHTML = `
      <div class="rounded-2xl border border-slate-100 bg-white p-8 text-center text-sm text-slate-600 shadow-sm">
        No pending orders right now.
      </div>`;
    return;
  }

  container.innerHTML = pendingOrders.map((order) => `
    <article data-order-card-id="${escapeHtml(order.id)}" class="rounded-2xl border border-slate-100 bg-white p-5 shadow-sm">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p class="font-mono text-xs font-semibold text-blue-600">${displayValue(order.id)}</p>
          <h3 class="mt-1 text-base font-bold text-slate-900">${displayValue(order.vehicleType || order.serviceName || order.vehicle, "Standard ride")}</h3>
        </div>
        <div class="flex items-start gap-2">
          <p class="text-lg font-bold text-slate-900">${formatFare(order.estimatedFare ?? order.fare ?? order.totalPay)}</p>
          <button type="button" data-order-id="${escapeHtml(order.id)}" class="dismiss-order rounded-lg bg-slate-100 px-2 py-1 text-xs font-bold text-slate-600 transition hover:bg-slate-200" aria-label="Dismiss order">×</button>
        </div>
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
  if (!isValidOrderId(orderId)) {
    console.warn("[Driver] Ignoring claim request: invalid orderId.", orderId);
    return;
  }
  if (pendingClaims.has(orderId)) return;
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

async function dismissOrder(orderId) {
  if (!isValidOrderId(orderId)) {
    console.warn("[Driver] Ignoring dismiss request: invalid orderId.", orderId);
    return;
  }
  dismissedOrderIds.add(orderId);
  persistDismissedOrderIds();
  renderOrders(lastOrderSnapshot);
  showDriverNotice("Order dismissed from this panel.");

  try {
    await db.collection(DRIVER_ORDERS_COLLECTION).doc(orderId).set({
      status: "closed",
      closedAt: firebase.firestore.FieldValue.serverTimestamp(),
      closedBy: DRIVER_ID
    }, { merge: true });
  } catch (error) {
    console.error("[Driver] Unable to close dismissed order:", {
      orderId,
      code: error.code || "unknown",
      message: error.message || "unknown",
      error
    });
  }
}

let lastOrderSnapshot = null;

function clearAllOrders() {
  if (!lastOrderSnapshot) return;
  lastOrderSnapshot.forEach((doc) => {
    const order = doc.data();
    const status = String(order.status || "").toLowerCase();
    const createdAtMillis = getCreatedAtMillis(order.createdAt);
    if (status === "pending" && !isStaleOrder(createdAtMillis)) {
      dismissedOrderIds.add(doc.id);
    }
  });
  persistDismissedOrderIds();
  renderOrders(lastOrderSnapshot);
  showDriverNotice("All visible orders dismissed.");
}

function listenForPendingOrders() {
  document.getElementById("driverStatus").textContent = "Connecting to pending orders...";
  console.log(`[Driver] Listening to ${DRIVER_ORDERS_COLLECTION} without composite index query.`);

  db.collection(DRIVER_ORDERS_COLLECTION).onSnapshot(
    (snapshot) => {
      console.log(`[Driver] Order snapshot received: ${snapshot.size} documents.`);
      lastOrderSnapshot = snapshot;
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
  const dismissButton = event.target.closest(".dismiss-order");
  if (dismissButton) {
    const dismissOrderId = dismissButton.dataset.orderId;
    if (!isValidOrderId(dismissOrderId)) {
      console.warn("[Driver] Ignoring dismiss click: invalid orderId in dataset.", dismissOrderId);
      return;
    }
    dismissOrder(dismissOrderId);
    return;
  }
  const button = event.target.closest(".claim-order");
  if (button) {
    const claimOrderId = button.dataset.orderId;
    if (!isValidOrderId(claimOrderId)) {
      console.warn("[Driver] Ignoring claim click: invalid orderId in dataset.", claimOrderId);
      return;
    }
    claimOrder(claimOrderId, button);
  }
});

document.getElementById("activeTripAction").addEventListener("click", advanceActiveTrip);
document.getElementById("clearAllOrders").addEventListener("click", clearAllOrders);

listenForPendingOrders();
