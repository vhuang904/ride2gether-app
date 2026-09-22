(() => {
const DRIVER_ORDERS_COLLECTION = "ride_orders";
const pendingClaims = new Set();
const DISMISSED_ORDERS_KEY = "ride2gether_driver_dismissed_orders";
const dismissedOrderIds = new Set();
let dismissedOrderProfileId = null;
const observedOrderStatuses = new Map();
const ORDER_STALE_AFTER_MS = 5 * 60 * 1000;
const ACTIVE_TRIP_STATUSES = new Set(["accepted", "arrived", "in_progress"]);
let activeTrip = null;
let noticeTimer = null;
let unsubscribeOrders = null;
let unsubscribePending = null;
let ownedDocs = [];
let pendingDocs = [];
let advancing = false;
let activeTripState = null;
let listenerGeneration = 0;
let driverPanelInitialized = false;
let historyRequestId = 0;
const requestedOrderId = new URLSearchParams(window.location.search).get("order");

function hasDriverPanelAccess() {
  return typeof window.isCurrentDriverAuthorized === "function"
    && window.isCurrentDriverAuthorized()
    && Boolean(window.getCurrentDriverProfile?.())
    && !document.getElementById("driverView").classList.contains("hidden");
}

function requireDriverPanelAccess() {
  if (hasDriverPanelAccess()) return true;
  console.warn("Unauthorized access: Not a registered fleet driver.");
  return false;
}

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
  localStorage.setItem(`${DISMISSED_ORDERS_KEY}:${dismissedOrderProfileId}`, JSON.stringify([...dismissedOrderIds]));
}

function belongsToCurrentDriver(order, profile = window.getCurrentDriverProfile()) {
  const phone = normalizeDriverPhone(order.driverPhone);
  return Boolean(profile) && (order.driverId === profile.id
    || (phone && phone === normalizeDriverPhone(profile.phone)));
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
  window.tripMirror?.stop("driver");
  window.tripChat?.clearTrip("driver");
  activeTrip = null;
  activeTripState = null;
  document.getElementById("activeTripContainer").classList.add("hidden");
}

function renderActiveTrip(order) {
  window.tripChat?.updateTrip("driver", order.id, order);
  activeTrip = order;
  const container = document.getElementById("activeTripContainer");
  const status = String(order.status || "").toLowerCase();
  const action = document.getElementById("activeTripAction");
  document.getElementById("activeTripStatus").textContent = status.replace("_", " ");
  document.getElementById("activeTripPickup").textContent = order.pickup || order.origin || "Not provided";
  document.getElementById("activeTripDropoff").textContent = order.dropoff || order.destination || "Not provided";
  document.getElementById("driverActiveTripVehicle").textContent = order.vehicleType || order.serviceName || "Standard ride";
  document.getElementById("activeTripFare").textContent = formatFare(order.estimatedFare ?? order.fare ?? order.totalPay);
  action.disabled = advancing;
  action.textContent = status === "accepted"
    ? "I have arrived at pickup"
    : status === "arrived"
      ? "Passenger on board / Start Trip"
      : "Complete Trip";
  container.classList.remove("hidden");
  const nav = document.getElementById("driverPickupNavigation");
  if (nav) nav.classList.toggle("hidden", status !== "accepted");
  window.tripMirror?.bind("driver", order.id, {
    map: window.tripMirror.getDriverMap,
    onState(state) {
      activeTripState = state;
      const earnings = document.getElementById("driverTripEarnings");
      if (earnings) earnings.textContent = formatFare(state.driverEarnings);
      if (nav && state.pickup) nav.href = `https://www.google.com/maps/dir/?api=1&destination=${state.pickup.lat},${state.pickup.lng}&travelmode=driving`;
    },
    onError: showDriverNotice
  });
}

async function advanceActiveTrip() {
  if (!requireDriverPanelAccess()) return;
  if (!activeTrip || advancing) return;
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

  if (currentStatus === "arrived") {
    const destination = (activeTrip.destination || activeTrip.dropoff || "").trim();
    if (destination) {
      const destUrl = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}`;
      window.open(destUrl, '_blank');
    }
  }

  const action = document.getElementById("activeTripAction");
  const orderId = activeTrip.id;
  const generation = listenerGeneration;
  advancing = true;
  action.disabled = true;
  action.textContent = "Updating...";
  try {
    const result = await window.accountAuth.api("advanceTrip", { orderId, status: nextStatus });
    window.accountAuth.notifyDispatch(orderId).catch(error => console.warn("[Driver] Dispatch status sync failed:", error));
    if (generation !== listenerGeneration || !hasDriverPanelAccess()) return;
    if (nextStatus === "completed" && (!activeTrip || activeTrip.id === orderId)) {
      showSettlement(result);
      clearActiveTrip();
      showDriverNotice("Trip completed. Ready for the next order.");
    }
  } catch (error) {
    console.error("[Driver] Unable to advance trip:", error);
    if (generation !== listenerGeneration || !hasDriverPanelAccess()) return;
    action.disabled = false;
    action.textContent = "Try again";
    showDriverNotice(error.message || "Unable to update trip status.");
  } finally {
    advancing = false;
    if (generation === listenerGeneration && activeTrip?.id === orderId && hasDriverPanelAccess()) {
      renderActiveTrip(activeTrip);
    }
  }
}

function showSettlement(state) {
  const card = document.getElementById("driverSettlement");
  if (!card) return;
  document.getElementById("settlementTotal").textContent = formatFare(state.totalFare);
  document.getElementById("settlementEarnings").textContent = formatFare(state.driverEarnings);
  card.classList.remove("hidden");
}

function renderOrders(snapshot) {
  if (!snapshot) return;
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
    if (activeTrip?.id === doc.id) window.tripChat?.updateTrip("driver", doc.id, order);
    const status = String(order.status || "").toLowerCase();
    const createdAtMillis = getCreatedAtMillis(order.createdAt);
    const previousStatus = observedOrderStatuses.get(doc.id);
    if (status === "cancelled" && previousStatus === "pending") {
      showDriverNotice("Passenger cancelled this trip.");
      pendingClaims.delete(doc.id);
    }
    observedOrderStatuses.set(doc.id, status);
    const belongsToDriver = belongsToCurrentDriver(order);
    if (belongsToDriver && ACTIVE_TRIP_STATUSES.has(status)) {
      snapshotActiveTrip = { id: doc.id, ...order };
    } else if (belongsToDriver && status === "cancelled" && activeTrip?.id === doc.id) {
      clearActiveTrip();
      showDriverNotice("Passenger cancelled the active trip.");
    } else if (belongsToDriver && status === "completed" && activeTrip?.id === doc.id) {
      if (activeTripState) showSettlement(activeTripState);
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
  else if (activeTrip) clearActiveTrip();
  pendingOrders.sort((a, b) => Number(b.id === requestedOrderId) - Number(a.id === requestedOrderId)
    || b.createdAtMillis - a.createdAtMillis);

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
          ${order.id === requestedOrderId ? '<p class="mt-1 text-xs font-semibold text-blue-600">Opened from Telegram — review and accept below.</p>' : ''}
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
  if (!requireDriverPanelAccess()) return;
  if (!window.accountAuth.isOnline()) { showDriverNotice("Go online before accepting an order."); return; }
  if (!isValidOrderId(orderId)) {
    console.warn("[Driver] Ignoring claim request: invalid orderId.", orderId);
    return;
  }
  if (pendingClaims.has(orderId)) return;
  pendingClaims.add(orderId);
  button.disabled = true;
  button.textContent = "Processing...";

  try {
    const location = await new Promise((resolve, reject) => {
      if (!navigator.geolocation) { reject(new Error("Location is unavailable on this device.")); return; }
      navigator.geolocation.getCurrentPosition(
        position => resolve({ lat: position.coords.latitude, lng: position.coords.longitude }),
        () => reject(new Error("Allow location access to accept a trip. Your location is saved only once.")),
        { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 }
      );
    });
    await window.accountAuth.api("claimOrder", { orderId, location });
    button.textContent = "Order accepted";

    // Notify GAS/Telegram after successful accept; failures never block the Firestore dispatch flow.
    if (typeof GAS_WEBHOOK_URL !== 'undefined' && GAS_WEBHOOK_URL) {
      let telegramMessageId = null;
      try {
        const orderSnap = await db.collection(DRIVER_ORDERS_COLLECTION).doc(orderId).get();
        telegramMessageId = orderSnap.data()?.telegramMessageId || null;
      } catch (err) {
        console.warn('[Driver] Unable to read telegramMessageId:', err);
      }
      window.accountAuth.notifyDispatch(orderId).catch(err => console.warn('[Driver] GAS claim notify failed:', err));

      // 若 Telegram 訊息尚未建立 (telegramMessageId 為空)，延遲 2 秒補發鎖定請求以防競態延遲
      if (!telegramMessageId) {
        setTimeout(async () => {
          try {
            await window.accountAuth.notifyDispatch(orderId);
          } catch (err) {
            console.warn('[Driver] Retry check for telegramMessageId failed:', err);
          }
        }, 2000);
      }
    }
  } catch (error) {
    console.error("Unable to accept order:", error);
    button.disabled = false;
    button.textContent = "Accept order";
    document.getElementById("driverStatus").textContent = error.message || "Unable to accept that order. Please try again.";
    pendingClaims.delete(orderId);
  }
}

async function dismissOrder(orderId) {
  if (!requireDriverPanelAccess()) return;
  if (!isValidOrderId(orderId)) {
    console.warn("[Driver] Ignoring dismiss request: invalid orderId.", orderId);
    return;
  }
  dismissedOrderIds.add(orderId);
  persistDismissedOrderIds();
  renderOrders(lastOrderSnapshot);
  showDriverNotice("Order dismissed from this panel.");

}

let lastOrderSnapshot = null;

function clearAllOrders() {
  if (!requireDriverPanelAccess()) return;
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
  if (!requireDriverPanelAccess() || unsubscribeOrders) return;
  const generation = ++listenerGeneration;
  document.getElementById("driverStatus").textContent = "Connecting to pending orders...";
  unsubscribeOrders = db.collection(DRIVER_ORDERS_COLLECTION).where("driverId", "==", window.getCurrentDriverProfile().id).onSnapshot(
    (snapshot) => {
      if (generation !== listenerGeneration || !hasDriverPanelAccess()) return;
      console.log(`[Driver] Order snapshot received: ${snapshot.size} documents.`);
      ownedDocs = snapshot.docs || [];
      renderCombinedOrders();
    },
    (error) => {
      if (generation !== listenerGeneration || !hasDriverPanelAccess()) return;
      console.error("[Driver] Pending order listener failed:", error);
      window.tripChat?.clearTrip("driver");
      document.getElementById("driverStatus").textContent = `Connection error: ${error.message || "Unable to load orders."}`;
    }
  );
  listenForAvailableOrders();
}

function renderCombinedOrders() {
  const docs = [...ownedDocs, ...pendingDocs.filter(doc => !ownedDocs.some(owned => owned.id === doc.id))];
  lastOrderSnapshot = { docs, size: docs.length, forEach: callback => docs.forEach(callback) };
  renderOrders(lastOrderSnapshot);
  document.getElementById("driverStatus").textContent = window.accountAuth.isOnline()
    ? "Connected. Listening for new pending orders." : "Paused. Your active trip remains available.";
}

function listenForAvailableOrders() {
  if (unsubscribePending) unsubscribePending();
  unsubscribePending = null;
  pendingDocs = [];
  if (!hasDriverPanelAccess() || !unsubscribeOrders) return;
  renderCombinedOrders();
  if (!window.accountAuth.isOnline()) return;
  const generation = listenerGeneration;
  unsubscribePending = db.collection(DRIVER_ORDERS_COLLECTION).where("status", "==", "pending").onSnapshot(snapshot => {
    if (generation !== listenerGeneration || !hasDriverPanelAccess() || !window.accountAuth.isOnline()) return;
    pendingDocs = snapshot.docs;
    renderCombinedOrders();
  }, error => {
    if (generation !== listenerGeneration) return;
    pendingDocs = [];
    renderCombinedOrders();
    console.error("[Driver] Available orders failed:", error);
    showDriverNotice("Unable to listen for new orders. Reconnect or toggle availability.");
  });
}
window.addEventListener("driveravailabilitychange", listenForAvailableOrders);

function handleDriverOrderClick(event) {
  if (!requireDriverPanelAccess()) return;
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
}

function initializeDriverPanel() {
  if (!requireDriverPanelAccess()) return;
  const profile = window.getCurrentDriverProfile();
  if (dismissedOrderProfileId !== profile.id) {
    dismissedOrderProfileId = profile.id;
    dismissedOrderIds.clear();
    try {
      const cached = JSON.parse(localStorage.getItem(`${DISMISSED_ORDERS_KEY}:${profile.id}`) || "[]");
      if (!Array.isArray(cached)) throw new Error("Dismissed order cache must be an array.");
      cached.filter(id => typeof id === "string").forEach(id => dismissedOrderIds.add(id));
    } catch (error) {
      console.warn("[Driver] Ignoring invalid dismissed order cache:", error);
    }
  }
  if (requestedOrderId && dismissedOrderIds.delete(requestedOrderId)) persistDismissedOrderIds();
  if (!driverPanelInitialized) {
    document.getElementById("ordersContainer").addEventListener("click", handleDriverOrderClick);
    document.getElementById("activeTripAction").addEventListener("click", advanceActiveTrip);
    document.getElementById("clearAllOrders").addEventListener("click", clearAllOrders);
    driverPanelInitialized = true;
  }
  listenForPendingOrders();
}

function stopDriverPanel() {
  listenerGeneration += 1;
  historyRequestId += 1;
  if (unsubscribeOrders) unsubscribeOrders();
  if (unsubscribePending) unsubscribePending();
  unsubscribePending = null;
  unsubscribeOrders = null;
  ownedDocs = [];
  pendingDocs = [];
  lastOrderSnapshot = null;
  observedOrderStatuses.clear();
  clearActiveTrip();
  closeDriverOrderHistory();
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = null;
  document.getElementById("driverNotice").classList.add("hidden");
  document.getElementById("ordersContainer").innerHTML = "";
  document.getElementById("orderCount").textContent = "0 pending";
  document.getElementById("driverOrderHistoryList").innerHTML = "";
}

// --- Order History Drawer ---
function normalizeDriverPhone(phone) {
  return window.normalizeFleetPhone?.(phone) || "";
}

function openDriverOrderHistory() {
  if (!requireDriverPanelAccess()) return;
  const modal = document.getElementById("driverOrderHistoryModal");
  if (modal) {
    modal.classList.remove("hidden");
    modal.classList.add("flex");
  }
  loadDriverOrderHistory();
}

function closeDriverOrderHistory() {
  const modal = document.getElementById("driverOrderHistoryModal");
  if (modal) {
    modal.classList.add("hidden");
    modal.classList.remove("flex");
  }
}

function filterAndSortDriverOrderDocs(docs, normalizedPhone, profile) {
  const seen = new Set();
  const matched = docs.filter((doc) => {
    if (seen.has(doc.id)) return false;
    seen.add(doc.id);
    const o = doc.data();
    // Reconcile legacy phone formats without authorizing by display name.
    if (normalizedPhone && normalizeDriverPhone(o.driverPhone) === normalizedPhone) return true;
    return o.driverId === profile.id;
  });
  matched.sort((a, b) => {
    const aMs = getCreatedAtMillis(a.data().createdAt) || 0;
    const bMs = getCreatedAtMillis(b.data().createdAt) || 0;
    return bMs - aMs;
  });
  return matched;
}

function loadDriverOrderHistory() {
  if (!requireDriverPanelAccess()) return;
  const requestId = ++historyRequestId;
  const profile = window.getCurrentDriverProfile();
  const listEl = document.getElementById("driverOrderHistoryList");
  if (!listEl) return;
  listEl.innerHTML = '<p class="py-6 text-center text-xs text-slate-400">Loading order history...</p>';
  const normalizedPhone = normalizeDriverPhone(profile.phone);
  // No orderBy() paired with where(): avoids requiring a Firestore composite index.
  // Sorting and phone-format reconciliation both happen client-side instead.
  db.collection(DRIVER_ORDERS_COLLECTION)
    .where("driverId", "==", profile.id)
    .limit(50)
    .get()
    .then((snap) => {
      if (requestId !== historyRequestId || !hasDriverPanelAccess()) return;
      const matched = filterAndSortDriverOrderDocs(snap.docs, normalizedPhone, profile);
      return renderDriverOrderHistory(listEl, matched);
    })
    .catch((err) => {
      console.warn("[Driver] Order history query failed:", err);
      if (requestId !== historyRequestId || !hasDriverPanelAccess()) return;
      listEl.innerHTML = '<p class="py-6 text-center text-xs text-slate-400">Unable to load order history.</p>';
    });
}

function renderDriverOrderHistory(listEl, docs) {
  if (!docs.length) {
    listEl.innerHTML = '<p class="py-6 text-center text-xs text-slate-400">No past orders yet.</p>';
    return;
  }
  listEl.innerHTML = docs.map((doc) => {
    const o = doc.data();
    const dateStr = formatCreatedAt(o.createdAt);
    const status = String(o.status || "pending").toUpperCase();
    const statusClass = status === "COMPLETED" ? "bg-emerald-50 text-emerald-600 border-emerald-200"
      : status === "CANCELLED" ? "bg-slate-100 text-slate-500 border-slate-200"
      : "bg-blue-50 text-blue-600 border-blue-200";
    return `
      <div class="rounded-xl border border-slate-100 bg-slate-50 p-3 text-xs">
        <div class="flex items-center justify-between">
          <span class="font-bold text-slate-900">#${String(doc.id).slice(-6)}</span>
          <span class="rounded-full border px-2 py-0.5 text-[10px] font-bold ${statusClass}">${status}</span>
        </div>
        <p class="mt-1 text-slate-400">${dateStr}</p>
        <p class="mt-1.5 text-slate-700"><span class="text-slate-400">From:</span> ${displayValue(o.origin || o.pickup)}</p>
        <p class="text-slate-700"><span class="text-slate-400">To:</span> ${displayValue(o.destination || o.dropoff)}</p>
        <div class="mt-1.5 flex items-center justify-between">
          <span class="text-slate-500">${displayValue(o.vehicleType || o.serviceName)}</span>
          <span class="font-bold text-blue-600">${formatFare(o.totalPay ?? o.fare)}</span>
        </div>
      </div>
    `;
  }).join("");
}

window.driverApp = { initialize: initializeDriverPanel, stop: stopDriverPanel };
window.openDriverOrderHistory = openDriverOrderHistory;
window.closeDriverOrderHistory = closeDriverOrderHistory;
})();
