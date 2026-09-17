// --- 6. 叫車下單與 Firestore 連線 ---
async function requestOrder() {
  const submitBtn = document.getElementById('btnSubmit');
  clearOrderValidationError();
  let from = "", to = "", notes = "";
  if (currentCategory === 'mobility') {
    from = document.getElementById('pickupLoc')?.value.trim() || "";
    to = document.getElementById('dropoffLoc')?.value.trim() || "";
    if (!from || !to) {
      showOrderValidationError("請先輸入起訖點 (Please specify both Pick-up and Drop-off locations).");
      return;
    }
  } else {
    from = document.getElementById('conciergePickup')?.value.trim() || "";
    to = document.getElementById('conciergeDropoff')?.value.trim() || "";
    notes = document.getElementById('itemList')?.value.trim() || "";
    if (!from || !to) {
      showOrderValidationError("請先輸入起訖點 (Please specify both Store/Pickup and Delivery locations).");
      return;
    }
  }

  if (typeof db === "undefined" || !db || typeof firebase === "undefined" || !firebase.firestore) {
    showOrderValidationError("The booking service is still loading. Please try again in a moment.");
    console.error("[Passenger] Order dispatch blocked: Firestore is unavailable.", {
      hasDb: typeof db !== "undefined" && Boolean(db),
      hasFirebase: typeof firebase !== "undefined"
    });
    return;
  }

  const custName = currentUserProfile?.name || "VIP Guest";
  const custPhone = currentUserProfile?.phone || "0917-000-0000";

  const dist = parseFloat(document.getElementById('distance')?.value) || 0;
  const itemCost = (currentService === 'PABILI') ? (parseFloat(document.getElementById('itemCost')?.value) || 0) : 0;
  const tip = parseFloat(document.getElementById('priorityTip')?.value) || 0;
  const finalPrice = parseFloat(document.getElementById('estTotal')?.innerText) || 0;
  const serviceRate = RATES[currentService];

  if (!serviceRate) {
    console.error("Order dispatch blocked: missing service rate.", currentService);
    showOrderValidationError("Unable to calculate this service fare. Please select the service again.");
    return;
  }

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.classList.add('opacity-60', 'pointer-events-none');
  }

  const orderId = 'OD-' + Math.floor(100000 + Math.random() * 900000);
  currentOrderId = orderId;
  localStorage.setItem('r2g_active_order_id', orderId); // 任務3：記憶訂單狀態
  renderPendingOrderView(orderId);
  dispatchStage = 1;
  dispatchStartTime = Date.now();
  startDispatchTimeoutChecker();

  const orderData = {
    orderId: orderId,
    customerName: custName,
    customerPhone: custPhone,
    customerInfo: `${custName} (${custPhone})`,
    category: currentCategory,
    serviceId: currentService,
    serviceName: serviceRate.nameEn,
    origin: from,
    destination: to,
    distance: dist,
    notes: notes || '-',
    itemCost: itemCost,
    tip: tip,
    totalPay: finalPrice,
    pickup: from,
    dropoff: to,
    fare: finalPrice,
    vehicleType: serviceRate.nameEn,
    estimatedFare: finalPrice,
    status: 'pending',
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  };

  try {
    await db.collection("orders").doc(orderId).set(orderData);
    console.log("[Passenger] Order written to Firestore:", {
      orderId,
      collection: "orders",
      status: orderData.status,
      pickup: orderData.pickup,
      destination: orderData.destination,
      fare: orderData.fare
    });
    subscribeToOrder(orderId);

    fetch(GAS_WEBHOOK_URL, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'NEW_ORDER', ...orderData })
    }).catch(e => console.warn('Background sync:', e));
  } catch (err) {
    console.error("[Passenger] Order dispatch failed:", {
      orderId,
      code: err?.code || "unknown",
      message: err?.message || "connection error",
      error: err
    });
    localStorage.removeItem('r2g_active_order_id');
    stopDispatchTimer();
    finishTripAndReset();
    showOrderValidationError(`建立訂單失敗，請稍後再試 (Unable to send order${err?.code ? ` · ${err.code}` : ""}).`);
  }
}

function showOrderValidationError(message) {
  const banner = document.getElementById('orderValidationError');
  if (!banner) return;
  banner.textContent = message;
  banner.classList.remove('hidden');
}

function clearOrderValidationError() {
  const banner = document.getElementById('orderValidationError');
  if (!banner) return;
  banner.textContent = '';
  banner.classList.add('hidden');
}

// 防呆：orderId 為空、非字串或仍為 'Generating...' 佔位字串時，
// 嚴禁向 Firestore 發起 doc()/onSnapshot 請求，避免觸發 400 Bad Request。
function isValidOrderId(orderId) {
  return typeof orderId === 'string' && orderId.trim().length > 0 && orderId.trim() !== 'Generating...';
}

function subscribeToOrder(orderId) {
  if (!isValidOrderId(orderId)) {
    console.warn('[Passenger] Skipping subscribeToOrder: invalid orderId.', orderId);
    return;
  }

  if (unsubscribeOrder) unsubscribeOrder();

  unsubscribeOrder = db.collection("orders").doc(orderId).onSnapshot(doc => {
    if (!doc.exists) return;
    const data = doc.data();
    const status = String(data.status || "").toLowerCase();

    if (data.driverLat && data.driverLng) {
      updateDriverLocationOnMap(data.driverLat, data.driverLng);
    }

    if (status === 'cancelled') {
      showDriverNoticeToPassenger("This trip was cancelled.");
      resetAppToIdle();
      return;
    }
    if (status === 'pending') {
      renderPendingOrderView(orderId);
      return;
    }
    if (['accepted', 'matched', 'arrived', 'in_progress', 'completed'].includes(status)) {
      // 每次 snapshot 更新（包含司機座標移動）都重新渲染，
      // 讓地圖鏡頭與底部卡片持續跟隨最新行程階段。
      renderNativeTripView(status, data);
      // Keep the listener active until the passenger confirms the settlement card.
    }
  }, err => {
    console.error("Realtime listener error:", err);
    const statusText = document.getElementById('dispatchStatusText');
    if (statusText) statusText.innerText = `Live order update failed: ${err.message || 'connection error'}`;
  });
}

function renderPendingOrderView(orderId) {
  prepareNativeTripView();
  const card = document.getElementById('activeTripBottomCard');
  const state = document.getElementById('activeTripStateLabel');
  const title = document.getElementById('activeTripTitle');
  const driver = document.getElementById('activeTripDriver');
  const eta = document.getElementById('activeTripEta');
  const pendingSlot = document.getElementById('activeTripPendingSlot');
  const shareSlot = document.getElementById('activeTripShareSlot');
  const completionSlot = document.getElementById('activeTripCompletionSlot');
  if (!card || !state || !title || !driver || !eta || !pendingSlot) return;

  state.textContent = 'Looking for drivers';
  title.textContent = 'Finding a chauffeur for you';
  driver.textContent = `Order ${orderId} is being dispatched in real time.`;
  eta.textContent = 'Searching';
  pendingSlot.innerHTML = `
    <button type="button" id="btnCancelActiveOrder" class="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-xs font-bold text-slate-600 transition hover:bg-slate-50">
      Cancel order
    </button>`;
  pendingSlot.querySelector('#btnCancelActiveOrder')?.addEventListener('click', cancelAndReset);
  pendingSlot.classList.remove('hidden');
  shareSlot?.classList.add('hidden');
  completionSlot?.classList.add('hidden');
  card.classList.remove('hidden');
  card.style.display = '';
}

function prepareNativeTripView() {
  const mainEl = document.querySelector('main');
  if (mainEl) {
    const sections = mainEl.querySelectorAll('section');
    const setupSection = sections[1];
    if (sections[0]) sections[0].classList.add('hidden');
    if (sections[2]) sections[2].classList.add('hidden');
    if (setupSection) setupSection.classList.remove('hidden');
    const gridMobility = document.getElementById('grid-mobility');
    const gridConcierge = document.getElementById('grid-concierge');
    const fieldsMobility = document.getElementById('fields-mobility');
    const fieldsConcierge = document.getElementById('fields-concierge');
    const savedPlaces = document.getElementById('mainSavedPlacesChips');
    [gridMobility, gridConcierge, fieldsMobility, fieldsConcierge, savedPlaces].forEach(element => {
      if (element) element.classList.add('hidden');
    });
    const submitBtn = document.getElementById('btnSubmit');
    if (submitBtn) submitBtn.classList.add('hidden');
  }

  const mapContainer = document.getElementById('mapPreviewContainer');
  if (mapContainer) {
    mapContainer.classList.remove('hidden');
    mapContainer.classList.remove('mt-3');
    mapContainer.style.height = 'calc(100vh - 150px)';
    if (mapInstance && window.google) google.maps.event.trigger(mapInstance, 'resize');
  }
  const legacyModal = document.getElementById('dispatchModal');
  if (legacyModal) {
    legacyModal.classList.add('hidden');
    legacyModal.setAttribute('aria-hidden', 'true');
    legacyModal.setAttribute('inert', '');
  }
  document.getElementById('mascotCapsule')?.classList.add('hidden');
  const bottomCard = document.getElementById('activeTripBottomCard');
  if (bottomCard) {
    bottomCard.classList.remove('hidden');
    bottomCard.style.display = '';
  }
}

function getOrderCoordinate(value) {
  if (!value) return null;
  if (typeof value.lat === 'function' && typeof value.lng === 'function') return value;
  if (typeof value.lat === 'number' && typeof value.lng === 'number') return value;
  return null;
}

function renderNativeTripRoute(status, data) {
  if (!['accepted', 'matched', 'arrived', 'in_progress'].includes(status)) return;
  if (!directionsService || !directionsRenderer || !mapInstance) return;
  const driverPosition = data.driverLat && data.driverLng
    ? { lat: Number(data.driverLat), lng: Number(data.driverLng) }
    : null;
  const destination = status === 'in_progress'
    ? getOrderCoordinate(mobilityDropoffCoord || conciergeDropoffCoord)
    : getOrderCoordinate(mobilityPickupCoord || conciergePickupCoord);
  const fallbackOrigin = status === 'in_progress'
    ? getOrderCoordinate(mobilityPickupCoord || conciergePickupCoord)
    : getOrderCoordinate(mobilityPickupCoord || conciergePickupCoord);
  const origin = driverPosition || fallbackOrigin;

  if (!origin || !destination) return;
  directionsService.route({
    origin,
    destination,
    travelMode: google.maps.TravelMode.DRIVING
  }, (response, routeStatus) => {
    if (routeStatus !== 'OK') return;
    directionsRenderer.setDirections(response);
    const bounds = new google.maps.LatLngBounds();
    bounds.extend(origin);
    bounds.extend(destination);
    mapInstance.fitBounds(bounds, { top: 80, bottom: 180, left: 40, right: 40 });
  });
}

function renderNativeTripView(status, data) {
  prepareNativeTripView();

  // Stage 2/3 (接單中/抵達/行程進行中)：主地圖鎖定為展示模式，禁止乘客拖曳；
  // Stage 4 (completed)：解鎖手勢，準備讓乘客確認後平滑回到待命視角。
  if (status === 'completed') {
    unlockMainMapGestures();
  } else {
    lockMainMapGestures();
  }

  const card = document.getElementById('activeTripBottomCard');
  const title = document.getElementById('activeTripTitle');
  const state = document.getElementById('activeTripStateLabel');
  const driver = document.getElementById('activeTripDriver');
  const eta = document.getElementById('activeTripEta');
  const vehicle = document.getElementById('activeTripVehicle');
  const plate = document.getElementById('activeTripPlate');
  const shareSlot = document.getElementById('activeTripShareSlot');
  const completionSlot = document.getElementById('activeTripCompletionSlot');
  const total = Number(data.totalPay || data.estimatedFare || 0).toFixed(2);

  state.textContent = status === 'completed' ? 'Trip Completed' : 'Active Trip';
  title.textContent = status === 'accepted' || status === 'matched'
    ? 'Driver accepted your trip'
    : status === 'arrived'
      ? 'Driver has arrived'
      : status === 'in_progress'
        ? 'Heading to destination'
        : 'Trip Completed';
  driver.textContent = status === 'accepted' || status === 'matched'
    ? 'Your chauffeur is on the way to the pick-up point.'
    : status === 'arrived'
      ? 'Your chauffeur has arrived. Please proceed to pickup.'
      : status === 'in_progress'
        ? 'Your trip is in progress.'
        : `Final fare: ₱${total}`;
  eta.textContent = status === 'accepted' || status === 'matched' ? 'ETA updating' : status === 'arrived' ? 'Arrived' : status === 'in_progress' ? 'On route' : 'Complete';
  vehicle.textContent = data.driverModel || data.vehicleType || data.serviceName || 'Private Fleet';
  plate.textContent = data.driverPlate || 'Private Fleet';
  shareSlot.innerHTML = '';
  document.getElementById('activeTripPendingSlot')?.classList.add('hidden');
  completionSlot.innerHTML = '';
  shareSlot.classList.toggle('hidden', status !== 'in_progress');
  completionSlot.classList.toggle('hidden', status !== 'completed');

  // Stage 3：唯有行程正式出發（in_progress）才顯示「Share Trip」分享按鈕。
  if (status === 'in_progress') {
    shareSlot.innerHTML = `
      <button type="button" id="btnShareTrip" class="w-full rounded-xl border border-blue-200 bg-blue-50 px-4 py-2.5 text-xs font-bold text-blue-700 transition hover:bg-blue-100">
        Share Trip
      </button>`;
    shareSlot.querySelector('#btnShareTrip')?.addEventListener('click', shareLiveTripStatus);
  }
  // Stage 4/5：結算卡片，Done 按鈕先跳出二次確認彈窗，避免誤觸直接結束行程。
  if (status === 'completed') {
    completionSlot.innerHTML = `
      <div class="rounded-xl border border-blue-100 bg-blue-50 p-3 text-center">
        <p class="text-xs font-semibold text-blue-700">Trip completed · ₱${total}</p>
        <button type="button" id="btnTripDone" class="mt-2 w-full rounded-xl bg-blue-600 px-4 py-2.5 text-xs font-bold text-white transition hover:bg-blue-700">
          Done
        </button>
      </div>`;
    completionSlot.querySelector('#btnTripDone')?.addEventListener('click', openTripEndConfirmDialog);
  }
  card.classList.remove('hidden');
  renderNativeTripRoute(status, data);
}

function showDriverNoticeToPassenger(message) {
  const statusText = document.getElementById('dispatchStatusText');
  if (statusText) {
    statusText.innerText = message;
    statusText.className = 'text-xs text-rose-600 mt-1 font-semibold';
  }
}

// --- 任務 2：司機即時動態追蹤 (平滑補間動畫 Lerp 1.5s) ---
let driverMarker = null;
let driverAnimFrame = null;

function updateDriverLocationOnMap(lat, lng) {
  const toLat = parseFloat(lat);
  const toLng = parseFloat(lng);
  if (isNaN(toLat) || isNaN(toLng)) return;

  const targetPos = new google.maps.LatLng(toLat, toLng);
  const map = mapInstance || (typeof getOrCreateMap === 'function' ? getOrCreateMap(targetPos) : null);
  if (!map) return;

  if (!driverMarker) {
    driverMarker = new google.maps.Marker({
      position: targetPos,
      map: map,
      title: "Chauffeur Live Location",
      zIndex: 999,
      icon: {
        url: './assets/icons/mascot-chauffeur.svg',
        scaledSize: new google.maps.Size(42, 50),
        anchor: new google.maps.Point(21, 48)
      }
    });
    return;
  }

  const fromPos = driverMarker.getPosition();
  const fromLat = fromPos.lat();
  const fromLng = fromPos.lng();
  if (fromLat === toLat && fromLng === toLng) return;

  if (driverAnimFrame) cancelAnimationFrame(driverAnimFrame);

  const duration = 1500;
  const startTime = performance.now();

  function animateMarker(currentTime) {
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const currentLat = fromLat + (toLat - fromLat) * progress;
    const currentLng = fromLng + (toLng - fromLng) * progress;

    driverMarker.setPosition(new google.maps.LatLng(currentLat, currentLng));

    if (progress < 1) {
      driverAnimFrame = requestAnimationFrame(animateMarker);
    }
  }
  driverAnimFrame = requestAnimationFrame(animateMarker);
}

function removeDriverMarker() {
  if (driverAnimFrame) cancelAnimationFrame(driverAnimFrame);
  if (driverMarker) {
    driverMarker.setMap(null);
    driverMarker = null;
  }
}

// --- 一鍵分享即時行程 (Native Share / Clipboard) ---
async function shareLiveTripStatus() {
  const orderId = currentOrderId;
  if (!isValidOrderId(orderId)) {
    alert("Trip details are not ready yet.");
    return;
  }

  const shareUrl = `${window.location.origin}/track.html?tripId=${encodeURIComponent(orderId)}`;
  const shareData = {
    title: 'Ride2gether Live Trip Tracking',
    text: `I am riding with Ride2gether! Track my trip in real-time:`,
    url: shareUrl
  };

  if (navigator.share) {
    try {
      await navigator.share(shareData);
    } catch (err) {
      console.log('Share dismissed:', err);
    }
  } else {
    navigator.clipboard.writeText(shareUrl).then(() => {
      alert("✅ Tracking link copied to clipboard!\nShare it with your contacts to track your trip live.");
    }).catch(() => {
      prompt("Copy this live tracking link:", shareUrl);
    });
  }
}

// --- 任務 4：訪客唯讀追蹤模式 (免登入、唯讀地圖、即時狀態膠囊) ---
function checkViewerTrackingMode() {
  const urlParams = new URLSearchParams(window.location.search);
  const trackOrderId = urlParams.get('track');
  if (!trackOrderId || !db) return;

  window.isViewerMode = true; // 標記為親友唯讀模式
  const bubble = document.getElementById('pinActionBubble');
  if (bubble) bubble.classList.add('hidden');

  const mainEl = document.querySelector('main');
  if (mainEl) {
    const sec1 = mainEl.querySelector('section:nth-of-type(1)');
    if (sec1) sec1.classList.add('hidden');
    const sec3 = mainEl.querySelector('section:nth-of-type(3)');
    if (sec3) sec3.classList.add('hidden');
    const submitBtn = document.getElementById('btnSubmit');
    if (submitBtn) submitBtn.classList.add('hidden');

    const fieldsMobility = document.getElementById('fields-mobility');
    if (fieldsMobility) fieldsMobility.classList.add('hidden');
    const fieldsConcierge = document.getElementById('fields-concierge');
    if (fieldsConcierge) fieldsConcierge.classList.add('hidden');
    const mainSavedPlaces = document.getElementById('mainSavedPlacesChips');
    if (mainSavedPlaces) mainSavedPlaces.classList.add('hidden');
  }

  const mapContainer = document.getElementById('mapPreviewContainer');
  if (mapContainer) {
    mapContainer.classList.remove('hidden');
    mapContainer.classList.remove('mt-3');
    mapContainer.style.height = '80vh';
  }

  const defaultCenter = { lat: 7.0512, lng: 125.5684 };
  const map = getOrCreateMap(defaultCenter);
  setTimeout(() => {
    if (window.google && map) {
      google.maps.event.trigger(map, 'resize');
      map.setCenter(defaultCenter);
      map.setZoom(16);
    }
  }, 300);

  db.collection("orders").doc(trackOrderId).onSnapshot(doc => {
    if (!doc.exists) {
      alert("Trip not found or has concluded.");
      return;
    }
    const data = doc.data();
    if (data.driverLat && data.driverLng) {
      updateDriverLocationOnMap(data.driverLat, data.driverLng);
      if (mapInstance) {
        mapInstance.panTo({ lat: parseFloat(data.driverLat), lng: parseFloat(data.driverLng) });
      }
    }

    // 訪客頂部即時狀態同步徽章
    const statusBadge = document.getElementById('pinLockStatusBadge');
    const status = String(data.status || '').toLowerCase();
    if (statusBadge && status) {
      if (status === 'matched' || status === 'accepted') {
        statusBadge.innerText = 'Chauffeur En Route 🚗';
        statusBadge.className = 'text-[11px] font-semibold px-2 py-0.5 rounded-full bg-blue-50 text-royal border border-blue-200';
      } else if (status === 'arrived') {
        statusBadge.innerText = 'Chauffeur Has Arrived 📍';
        statusBadge.className = 'text-[11px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-600 border border-emerald-200';
      } else if (status === 'in_progress') {
        statusBadge.innerText = 'Trip In Progress 🛣️';
        statusBadge.className = 'text-[11px] font-semibold px-2 py-0.5 rounded-full bg-purple-50 text-purple-600 border border-purple-200';
      } else if (status === 'completed') {
        statusBadge.innerText = 'Trip Completed ✓';
        statusBadge.className = 'text-[11px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-300';
      }
    }
  });
}

// 點擊管家膠囊展開或收合司機資訊卡
window.toggleMatchedCard = function() {
  prepareNativeTripView();
};

// 舊版 showMatchedDriver()/updateTripStatusUI() 已隨全螢幕彈窗一併淘汰
// （其操作對象 #matchedCard、#txt-matched-badge 皆位於已徹底棄用的
// <template id="dispatchModal">，屬於死碼）。司機接單後的畫面統一由
// renderNativeTripView() 驅動主地圖與底部懸浮卡片。
function showMatchedDriver(data) {
  stopDispatchTimer();
  renderNativeTripView('accepted', data);
}

// --- 派單超時兩階段計時控制 ---
let dispatchTimer = null;
let dispatchStartTime = null;
let dispatchStage = 1;
const STAGE_DURATION_MS = 180 * 1000;

function startDispatchTimeoutChecker() {
  if (dispatchTimer) clearInterval(dispatchTimer);
  dispatchTimer = setInterval(async () => {
    if (!dispatchStartTime) return;
    const elapsed = Date.now() - dispatchStartTime;

    if ((dispatchStage === 1 || dispatchStage === 2) && elapsed >= STAGE_DURATION_MS) {
      clearInterval(dispatchTimer);

      if (currentOrderId && db) {
        try {
          const docSnap = await db.collection("orders").doc(currentOrderId).get();
          if (docSnap.exists) {
            const data = docSnap.data();
            const matchedStatuses = ['accepted', 'matched', 'arrived', 'in_progress', 'completed'];
            const status = String(data.status || '').toLowerCase();
            if (matchedStatuses.includes(status)) {
              stopDispatchTimer();
              renderNativeTripView(status, data);
              return;
            }
          }
        } catch (err) {
          console.warn("Race condition check error:", err);
        }
      }

      if (dispatchStage === 1) {
        showTimeoutStage1UI();
      } else {
        showTimeoutStage2UI();
      }
    }
  }, 1000);
}

function showTimeoutStage1UI() {
  const pendingSlot = document.getElementById('activeTripPendingSlot');
  if (pendingSlot) {
    pendingSlot.innerHTML = '<p class="mb-2 text-xs font-semibold text-amber-700">Drivers are currently busy. We are still looking.</p><button type="button" id="btnCancelActiveOrder" class="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-xs font-bold text-slate-600">Cancel order</button>';
    pendingSlot.querySelector('#btnCancelActiveOrder')?.addEventListener('click', cancelAndReset);
    pendingSlot.classList.remove('hidden');
  }
}

function extendDispatchWait() {
  document.getElementById('activeTripPendingSlot')?.classList.remove('hidden');
  dispatchStage = 2;
  dispatchStartTime = Date.now();
  startDispatchTimeoutChecker();
}

function showTimeoutStage2UI() {
  const pendingSlot = document.getElementById('activeTripPendingSlot');
  if (pendingSlot) {
    pendingSlot.innerHTML = '<p class="mb-2 text-xs font-semibold text-slate-600">No chauffeur is available yet. You can keep waiting or cancel.</p><button type="button" id="btnCancelActiveOrder" class="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-xs font-bold text-slate-600">Cancel order</button>';
    pendingSlot.querySelector('#btnCancelActiveOrder')?.addEventListener('click', cancelAndReset);
    pendingSlot.classList.remove('hidden');
  }
}

function stopDispatchTimer() {
  if (dispatchTimer) clearInterval(dispatchTimer);
  dispatchTimer = null;
  dispatchStartTime = null;
  dispatchStage = 1;
  const t1 = document.getElementById('timeoutStage1Card');
  const t2 = document.getElementById('timeoutStage2Card');
  if (t1) t1.classList.add('hidden');
  if (t2) t2.classList.add('hidden');
}

// 共用：還原乘客端首頁預約畫面（地圖、分類欄位、送出按鈕等）。
// 供 cancelAndReset() 與 finishTripAndReset() 共用，避免取消訂單後
// 畫面停留在被 prepareNativeTripView() 隱藏的空白狀態。
function restoreBookingHomeView() {
  const dispatchModal = document.getElementById('dispatchModal');
  if (dispatchModal) {
    dispatchModal.classList.add('hidden');
    dispatchModal.style.display = 'none';
  }
  const radarSection = document.getElementById('radarSection');
  if (radarSection) radarSection.classList.remove('hidden');
  document.getElementById('matchedCard')?.classList.add('hidden');
  document.getElementById('mascotCapsule')?.classList.add('hidden');
  const activeTripBottomCard = document.getElementById('activeTripBottomCard');
  if (activeTripBottomCard) {
    activeTripBottomCard.classList.add('hidden');
    activeTripBottomCard.style.display = 'none';
  }
  // 重置懸浮卡片內的訂單狀態文字，避免下次顯示前殘留舊資訊。
  const dispatchStatusText = document.getElementById('dispatchStatusText');
  if (dispatchStatusText) dispatchStatusText.textContent = 'Connecting to exclusive fleet in real-time...';
  const modalOrderId = document.getElementById('modalOrderId');
  if (modalOrderId) modalOrderId.textContent = '';
  const pendingSlot = document.getElementById('activeTripPendingSlot');
  if (pendingSlot) pendingSlot.innerHTML = '';
  if (typeof directionsRenderer !== 'undefined' && directionsRenderer) {
    directionsRenderer.set('directions', null);
  }
  const mapContainer = document.getElementById('mapPreviewContainer');
  if (mapContainer) {
    mapContainer.style.height = '';
    mapContainer.classList.add('mt-3');
  }
  const mainEl = document.querySelector('main');
  if (mainEl) {
    const sections = mainEl.querySelectorAll('section');
    if (sections[0]) sections[0].classList.remove('hidden');
    if (sections[2]) sections[2].classList.remove('hidden');
    const gridMobility = document.getElementById('grid-mobility');
    const gridConcierge = document.getElementById('grid-concierge');
    const fieldsMobility = document.getElementById('fields-mobility');
    const fieldsConcierge = document.getElementById('fields-concierge');
    const savedPlaces = document.getElementById('mainSavedPlacesChips');
    [gridMobility, gridConcierge, fieldsMobility, fieldsConcierge, savedPlaces].forEach(element => {
      if (element) element.classList.remove('hidden');
    });
    if (typeof switchCategory === 'function') switchCategory(currentCategory);
  }
  const submitBtn = document.getElementById('btnSubmit');
  if (submitBtn) {
    submitBtn.disabled = false;
    submitBtn.classList.remove('opacity-60', 'pointer-events-none');
  }
}

async function cancelAndReset() {
  const rawOrderId = String(currentOrderId || '').trim();
  const targetOrderId = isValidOrderId(rawOrderId) ? rawOrderId : '';
  console.log('[Passenger] Cancel requested for order:', targetOrderId || '(no valid orderId - forcing local reset only)');

  // 【無條件優先】不論 orderId 是否合法、Firestore 是否可用，
  // 一律先做完整的本機與 UI 重置，避免卡在派單等待卡片。
  resetAppToIdle();

  // 只有在確實取得合法 orderId 時，才嘗試向 Firestore / GAS 送出取消請求。
  // 'Generating...' 屬於佔位字串，代表尚未取得真實訂單 ID，直接略過遠端請求。
  if (!targetOrderId) {
    console.warn('[Passenger] Cancellation skipped remote write: no valid orderId available.', {
      orderId: rawOrderId,
      hasDb: Boolean(db)
    });
    return;
  }

  if (db) {
    try {
      const orderRef = db.collection("orders").doc(targetOrderId);
      await orderRef.set({
        status: 'cancelled',
        cancelledAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      console.log('[Passenger] Cancellation written to Firestore:', targetOrderId);
    } catch (err) {
      console.error('[Passenger] Cancellation write failed:', {
        orderId: targetOrderId,
        code: err.code || 'unknown',
        message: err.message || 'unknown',
        error: err
      });
    }
  } else {
    console.error('[Passenger] Cancellation Firestore write skipped: no db instance.', { orderId: targetOrderId });
  }

  try {
    await fetch(GAS_WEBHOOK_URL, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'CANCEL_ORDER', orderId: targetOrderId })
    });
  } catch (err) {
    console.error('Failed to cancel:', err);
  }
}

// Stage 6：行程徹底結束後的完整重置。統一收斂所有清理動作（計時器、
// 監聽器、本機暫存、地圖手勢/路線/座標、UI）於單一函式，
// cancelAndReset()／確認結束彈窗／finishTripAndReset() 皆委派至此。
function resetAppToIdle() {
  closeTripEndConfirmDialog();
  stopDispatchTimer();
  removeDriverMarker();
  localStorage.removeItem('r2g_active_order_id');

  if (typeof unsubscribeOrder === 'function') {
    try {
      unsubscribeOrder();
    } catch (err) {
      console.error('[Passenger] Failed to unsubscribe order listener:', err);
    }
    unsubscribeOrder = null;
  }

  if (typeof unlockMainMapGestures === 'function') unlockMainMapGestures();
  if (typeof clearAllTripCoordsAndRoute === 'function') clearAllTripCoordsAndRoute();
  if (typeof recenterMapToUserGps === 'function') recenterMapToUserGps();

  restoreBookingHomeView();
  currentOrderId = null;
}

// finishTripAndReset() 保留為 resetAppToIdle() 的別名，
// 相容於既有（已棄用模板內）的 onclick="finishTripAndReset()" 參照。
function finishTripAndReset() {
  resetAppToIdle();
}

// Stage 4/5：乘客點擊「Done」時彈出的二次確認彈窗，避免誤觸直接結束行程。
function openTripEndConfirmDialog() {
  const dialog = document.getElementById('tripEndConfirmDialog');
  if (!dialog) {
    // 找不到彈窗元素時，直接安全回退為立即重置，避免卡在結算卡片。
    resetAppToIdle();
    return;
  }
  dialog.classList.remove('hidden');
  dialog.classList.add('flex');
}

function closeTripEndConfirmDialog() {
  const dialog = document.getElementById('tripEndConfirmDialog');
  if (!dialog) return;
  dialog.classList.add('hidden');
  dialog.classList.remove('flex');
}


// --- 任務 3：網頁載入時自動恢復正在進行的訂單 (防跳App或刷新丟失) ---
function checkActiveOrderOnLoad() {
  const activeId = localStorage.getItem('r2g_active_order_id');
  const urlParams = new URLSearchParams(window.location.search);

  // 防止幽靈訂單：id 為空、遺失或仍是 "Generating..." 佔位字串時，
  // 一律視為無效訂單，直接清除本機暫存，絕不渲染待接單卡片。
  const isGhostId = !activeId || !activeId.trim() || activeId.trim() === 'Generating...';
  if (isGhostId) {
    if (activeId) {
      console.warn('[Passenger] Clearing ghost active order id on load:', activeId);
      localStorage.removeItem('r2g_active_order_id');
    }
    return;
  }

  if (!urlParams.has('track')) {
    currentOrderId = activeId;
    renderPendingOrderView(activeId);
    subscribeToOrder(activeId);
  }
}

async function fetchLatestRates() {
  try {
    const res = await fetch(GAS_WEBHOOK_URL);
    const data = await res.json();
    if (data.status === "SUCCESS" && data.rates) {
      Object.keys(data.rates).forEach(k => {
        if (RATES[k]) {
          RATES[k].base = data.rates[k].base;
          RATES[k].baseKm = data.rates[k].baseKm;
          RATES[k].perKm = data.rates[k].perKm;
          RATES[k].commType = data.rates[k].commType;
          RATES[k].commVal = data.rates[k].commVal;
        }
      });
      updateCardBadges();
      calculateEstimate();
    }
  } catch (err) {
    console.warn("Using local rates:", err);
  }
}

// 系統初始化
// safeInvoke：確保任何單一初始化流程（包含地圖模組）拋出例外時，
// 都不會阻斷其他全域事件監聽器的註冊與執行。
function safeInvoke(fn, label) {
  return function (...args) {
    try {
      return fn.apply(this, args);
    } catch (err) {
      console.error(`[Passenger] ${label} failed:`, err);
    }
  };
}

loadProfile();
updateCardBadges();
fetchLatestRates();
window.addEventListener("DOMContentLoaded", safeInvoke(initAutocomplete, "initAutocomplete"));
window.addEventListener("load", safeInvoke(initAutocomplete, "initAutocomplete"));
window.addEventListener("DOMContentLoaded", safeInvoke(checkViewerTrackingMode, "checkViewerTrackingMode"));
window.addEventListener("DOMContentLoaded", safeInvoke(checkActiveOrderOnLoad, "checkActiveOrderOnLoad"));
window.addEventListener("DOMContentLoaded", safeInvoke(function () {
  document.getElementById('btnTripEndCancel')?.addEventListener('click', closeTripEndConfirmDialog);
  document.getElementById('btnTripEndConfirm')?.addEventListener('click', function () {
    closeTripEndConfirmDialog();
    resetAppToIdle();
  });
}, "wireTripEndConfirmDialog"));
