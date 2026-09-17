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
  const card = document.getElementById('activeTripPanel');
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

// Layer 2（行程專屬視窗）最小化狀態：最小化後 Layer 1 主畫面完全恢復自由操作，
// 僅在螢幕邊緣保留一顆懸浮氣泡；lastTripStatus/lastTripData 供還原與氣泡頭像更新使用。
let isActiveTripMinimized = false;
let lastTripStatus = null;
let lastTripData = null;

function prepareNativeTripView() {
  const mainEl = document.querySelector('main');
  if (mainEl) {
    const sections = mainEl.querySelectorAll('section');
    const setupSection = sections[1];
    if (isActiveTripMinimized) {
      // Layer 2 已最小化為懸浮氣泡：讓 Layer 1（分類選擇／價格儀表板）
      // 保持顯示並可自由操作，Layer 2 大容器整個維持隱藏。
      if (sections[0]) sections[0].classList.remove('hidden');
      if (sections[2]) sections[2].classList.remove('hidden');
      if (setupSection) setupSection.classList.add('hidden');
    } else {
      if (sections[0]) sections[0].classList.add('hidden');
      if (sections[2]) sections[2].classList.add('hidden');
      if (setupSection) setupSection.classList.remove('hidden');
    }
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
    // Concierge（Instant Parcel / Pabili）全程去地圖化：無論表單階段或
    // Layer 2 追蹤狀態（searching/accepted/in_progress/completed），
    // 大地圖容器一律強制隱藏，維持純文字/狀態履約介面。
    const isConciergeTrip = (lastTripData?.category === 'concierge');
    if (isConciergeTrip) {
      mapContainer.classList.add('hidden');
    } else {
      mapContainer.classList.remove('hidden');
      mapContainer.classList.remove('mt-3');
      // 縮小地圖高度上限，避免與下方合一後的行程卡片之間出現大片空白斷層。
      mapContainer.style.height = 'min(48vh, 360px)';
      if (mapInstance && window.google) google.maps.event.trigger(mapInstance, 'resize');
    }
  }
  // 起訖點一旦鎖定進入派單/追蹤流程，地圖上絕不可殘留「Confirm Yes/No」拖曳確認彈窗，
  // 亦不需再顯示「Adjusting pin...」拖曳提示（起終點已固定，不再開放調整）。
  if (typeof closePinConfirmBubble === 'function') closePinConfirmBubble();
  document.getElementById('pinLockStatusBadge')?.classList.add('hidden');
  // 行程進行期間「預估路程/時間」卡片已失去意義，隱藏以緊貼地圖與行程卡片。
  document.getElementById('estimatedRouteCard')?.classList.add('hidden');
  const legacyModal = document.getElementById('dispatchModal');
  if (legacyModal) {
    legacyModal.classList.add('hidden');
    legacyModal.setAttribute('aria-hidden', 'true');
    legacyModal.setAttribute('inert', '');
  }
  document.getElementById('mascotCapsule')?.classList.add('hidden');
  // 整併需求：行程進行期間隱藏「小費區塊」，讓合一後的行程卡片取代其視覺空間。
  document.getElementById('priorityTipSection')?.classList.add('hidden');
  // Layer 2 全域最小化鈕：僅在行程進行中顯示，位於 #step2Panel 容器最右上角。
  const minimizeBtn = document.getElementById('btnMinimizeTrip');
  if (minimizeBtn) {
    minimizeBtn.classList.remove('hidden');
    minimizeBtn.classList.add('flex');
  }
  const bottomCard = document.getElementById('activeTripPanel');
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
  // Stage 4/5 生命週期修復：若行程於「氣泡最小化」狀態下轉為 completed，
  // 必須在呼叫 prepareNativeTripView() 之前就先解除最小化狀態，
  // 否則 prepareNativeTripView() 會依舊誤判為最小化中，導致 #step2Panel（含地圖與結算卡）
  // 持續被隱藏 —— 這正是氣泡消失後底層地圖變黑、結算卡未彈出的根因。
  if (status === 'completed' && isActiveTripMinimized) {
    isActiveTripMinimized = false;
    hideActiveTripFloatingBubble();
  }
  prepareNativeTripView();
  lastTripStatus = status;
  lastTripData = data;

  // Stage 2/3 (接單中/抵達/行程進行中)：主地圖鎖定為展示模式，禁止乘客拖曳；
  // Stage 4 (completed)：解鎖手勢，準備讓乘客確認後平滑回到待命視角。
  if (status === 'completed') {
    unlockMainMapGestures();
  } else {
    lockMainMapGestures();
  }

  const title = document.getElementById('activeTripTitle');
  const state = document.getElementById('activeTripStateLabel');
  const driverNameEl = document.getElementById('activeTripDriverName');
  const driver = document.getElementById('activeTripDriver');
  const eta = document.getElementById('activeTripEta');
  const vehicle = document.getElementById('activeTripVehicle');
  const plate = document.getElementById('activeTripPlate');
  const shareSlot = document.getElementById('activeTripShareSlot');
  const conciergeSlot = document.getElementById('activeTripConciergeSlot');
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
  // 司機姓名／車型／車牌一律使用真實資料，嚴禁出現 "--" 或空白；
  // 尚未取得真實資料前，改以有意義的預設文字（而非佔位符號）呈現。
  if (driverNameEl) driverNameEl.textContent = data.driverName ? `Chauffeur: ${data.driverName}` : 'Chauffeur: Assigned Fleet Partner';
  driver.textContent = status === 'accepted' || status === 'matched'
    ? 'Your chauffeur is on the way to the pick-up point.'
    : status === 'arrived'
      ? 'Your chauffeur has arrived. Please proceed to pickup.'
      : status === 'in_progress'
        ? 'Your trip is in progress.'
        : `Final fare: ₱${total}`;
  eta.textContent = status === 'accepted' || status === 'matched' ? 'ETA updating' : status === 'arrived' ? 'Arrived' : status === 'in_progress' ? 'On route' : 'Complete';
  vehicle.textContent = data.driverVehicle || data.driverModel || data.vehicleType || data.serviceName || 'Executive Fleet';
  plate.textContent = data.driverPlate || 'Plate Pending';
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
  // 🛎️ VIP Concierge：在行程進行期間（非 completed）常駐快捷聯繫入口。
  renderConciergeQuickActions(conciergeSlot, status, data);
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

  // 依 Layer 2 最小化狀態決定顯示視窗本體或懸浮氣泡，維持 Layer 1 手勢自由。
  // 是否最小化為懸浮氣泡：由 minimizeActiveTrip()/restoreActiveTripFromBubble()
  // 控制整個 Layer 2 容器（#step2Panel）的顯示，此處僅同步氣泡本身。
  if (isActiveTripMinimized) {
    showActiveTripFloatingBubble(data);
  } else {
    hideActiveTripFloatingBubble();
  }
  renderNativeTripRoute(status, data);
}

// 🛎️ VIP Concierge：行程進行期間（accepted/arrived/in_progress）常駐的
// WhatsApp／撥號快捷聯繫入口；行程結束（completed）不再顯示聯繫按鈕。
function renderConciergeQuickActions(slot, status, data) {
  if (!slot) return;
  slot.innerHTML = '';
  if (status === 'completed') return;
  const phone = String(data.driverPhone || '').trim();
  if (!phone) return;
  const wa = phone.replace(/[^0-9]/g, '');
  slot.innerHTML = `
    <div class="grid grid-cols-2 gap-2">
      <a href="https://wa.me/${wa}" target="_blank" rel="noopener" class="flex items-center justify-center gap-1.5 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-700 transition hover:bg-emerald-100 active:scale-95">
        <span>🛎️</span><span>VIP Concierge</span>
      </a>
      <a href="tel:${phone}" class="flex items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-bold text-slate-600 transition hover:bg-slate-100 active:scale-95">
        <span>📞</span><span>Call Driver</span>
      </a>
    </div>`;
}

// 依司機性別展示對應懸浮氣泡頭像；無資料時退回通用管家圖示。
function updateFloatingBubbleAvatar(data) {
  const img = document.getElementById('floatingBubbleAvatar');
  if (!img) return;
  const gender = String((data && data.driverGender) || '').toLowerCase();
  img.src = gender === 'female'
    ? './assets/icons/mascot-vip-female.svg'
    : gender === 'male'
      ? './assets/icons/mascot-vip-male.svg'
      : './assets/icons/mascot-chauffeur.svg';
}

function showActiveTripFloatingBubble(data) {
  updateFloatingBubbleAvatar(data || lastTripData || {});
  const bubble = document.getElementById('tripFloatingBubble');
  if (!bubble) return;
  bubble.classList.remove('hidden');
  bubble.classList.add('flex');
}

function hideActiveTripFloatingBubble() {
  const bubble = document.getElementById('tripFloatingBubble');
  if (!bubble) return;
  bubble.classList.add('hidden');
  bubble.classList.remove('flex');
}

// Layer 2 → 懸浮氣泡：最小化後 Layer 1 主畫面（分類選擇、價格儀表板、地圖手勢）
// 完全恢復自由，司機資訊持續在背景（Firestore 監聽）更新，乘客可隨時點擊氣泡還原完整視窗。
function minimizeActiveTrip() {
  isActiveTripMinimized = true;
  // 整個 Layer 2 大容器（#step2Panel，內含地圖與行程資訊卡）一併隱藏，
  // 而非只隱藏底下的資訊卡，確保地圖也隨之收起、不殘留佔位空白。
  const panel = document.getElementById('step2Panel');
  if (panel) panel.classList.add('hidden');
  // 露出原本的主應用程式畫面（分類選擇區、價格儀表板），讓乘客可自由操作。
  setLayer1Visible(true);

  // 最小化直通純文字管家頁：Concierge 已全程去地圖化，秒開零黑屏破圖，
  // 讓乘客在等車/行程中仍可自由操作叫車以外的管家下單。skipMinimizeGuard
  // 旗標避免觸發 switchCategory() 內針對 Mobility 的最小化召回守衛（見下方）。
  if (typeof switchCategory === 'function') switchCategory('concierge', { skipMinimizeGuard: true });

  // 修復既有缺陷：prepareNativeTripView() 每次都會無條件隱藏這些 Layer1 表單元件，
  // 最小化當下需主動補回，否則分類選擇區雖可見卻是空殼、看不到任何管家輸入框。
  ['grid-concierge', 'fields-concierge', 'mainSavedPlacesChips', 'btnSubmit'].forEach(id => {
    document.getElementById(id)?.classList.remove('hidden');
  });

  if (typeof unlockMainMapGestures === 'function') unlockMainMapGestures();
  showActiveTripFloatingBubble(lastTripData);
}

function restoreActiveTripFromBubble() {
  isActiveTripMinimized = false;
  hideActiveTripFloatingBubble();
  // 收起 Layer 1 主畫面，將 Layer 2 大容器完整彈回全螢幕。
  setLayer1Visible(false);

  // 收回最小化期間為了露出管家表單而解除隱藏的 Layer1 內容，讓下次
  // prepareNativeTripView() 的既有隱藏邏輯與畫面狀態保持一致，不留殘影。
  ['grid-concierge', 'fields-concierge', 'mainSavedPlacesChips', 'btnSubmit'].forEach(id => {
    document.getElementById(id)?.classList.add('hidden');
  });

  const panel = document.getElementById('step2Panel');
  if (panel) panel.classList.remove('hidden');

  // 修復：最小化期間 switchCategory('concierge') 曾透過 syncCategoryCoords()
  // 將乘客起點圖釘 setMap(null)。還原時強制歸位為 Mobility，重新同步座標
  // 讓圖釘與路線接回地圖，不依賴使用者再次觸發任何互動。
  currentCategory = 'mobility';
  if (typeof syncCategoryCoords === 'function') syncCategoryCoords('mobility');

  if (mapInstance && window.google) {
    // ① resize：容器由 hidden 恢復可視後尺寸快取可能過期，先行校正。
    google.maps.event.trigger(mapInstance, 'resize');
    // ② fitBounds/panTo：重新校正視角，不等待路線 API 回應即可秒級定位。
    if (mobilityPickupCoord && mobilityDropoffCoord) {
      const bounds = new google.maps.LatLngBounds();
      bounds.extend(mobilityPickupCoord);
      bounds.extend(mobilityDropoffCoord);
      mapInstance.fitBounds(bounds, { top: 40, bottom: 40, left: 40, right: 40 });
    } else if (mobilityPickupCoord) {
      mapInstance.panTo(mobilityPickupCoord);
    }
  }
  // ③ 強制重新掛載並顯示乘客起點圖釘與司機即時 Marker，確保秒級重現。
  if (pickupMarker) {
    if (mobilityPickupCoord) pickupMarker.setMap(mapInstance);
    pickupMarker.setVisible(true);
  }
  if (typeof driverMarker !== 'undefined' && driverMarker) {
    driverMarker.setMap(mapInstance);
    driverMarker.setVisible(true);
  }

  if (lastTripStatus && lastTripStatus !== 'completed' && typeof lockMainMapGestures === 'function') {
    lockMainMapGestures();
  }
}

// 共用：切換 Layer 1（分類選擇 sections[0] 與價格儀表板 sections[2]）的顯示狀態，
// 供最小化／還原 Layer 2 時呼叫，避免重複撰寫 section 索引邏輯。
function setLayer1Visible(visible) {
  const mainEl = document.querySelector('main');
  if (!mainEl) return;
  const sections = mainEl.querySelectorAll('section');
  if (sections[0]) sections[0].classList.toggle('hidden', !visible);
  if (sections[2]) sections[2].classList.toggle('hidden', !visible);
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
  // Concierge 訂單全程去地圖化：跑腿員/司機即時位置更新一律提前返回，
  // 絕不因收到座標而意外觸發 getOrCreateMap() 建立大地圖。
  if (lastTripData?.category === 'concierge') return;

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
  const activeTripBottomCard = document.getElementById('activeTripPanel');
  if (activeTripBottomCard) {
    activeTripBottomCard.classList.add('hidden');
    activeTripBottomCard.style.display = 'none';
  }
  // Stage 6 徹底重置：連同 Layer 2 懸浮氣泡一併銷毀，並清除最小化狀態暫存，
  // 避免下一趟行程開始時殘留上一趟的司機資料或最小化偏好。
  hideActiveTripFloatingBubble();
  isActiveTripMinimized = false;
  lastTripStatus = null;
  lastTripData = null;
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
  document.getElementById('estimatedRouteCard')?.classList.remove('hidden');
  document.getElementById('pinLockStatusBadge')?.classList.remove('hidden');
  const mainEl = document.querySelector('main');
  if (mainEl) {
    const sections = mainEl.querySelectorAll('section');
    if (sections[0]) sections[0].classList.remove('hidden');
    if (sections[1]) sections[1].classList.remove('hidden');
    if (sections[2]) sections[2].classList.remove('hidden');
    const gridMobility = document.getElementById('grid-mobility');
    const gridConcierge = document.getElementById('grid-concierge');
    const fieldsMobility = document.getElementById('fields-mobility');
    const fieldsConcierge = document.getElementById('fields-concierge');
    const savedPlaces = document.getElementById('mainSavedPlacesChips');
    const priorityTipSection = document.getElementById('priorityTipSection');
    [gridMobility, gridConcierge, fieldsMobility, fieldsConcierge, savedPlaces, priorityTipSection].forEach(element => {
      if (element) element.classList.remove('hidden');
    });
    if (typeof switchCategory === 'function') switchCategory(currentCategory);
  }
  // Layer 2 全域最小化鈕：待命狀態下沒有進行中行程，強制隱藏。
  const minimizeBtn = document.getElementById('btnMinimizeTrip');
  if (minimizeBtn) {
    minimizeBtn.classList.add('hidden');
    minimizeBtn.classList.remove('flex');
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

  // #map 容器歸位：先讓 Layer 1 主容器（含 #map／#mapPreviewContainer）
  // 精準恢復可視，才能對地圖執行 resize／視角重置；若在容器仍隱藏
  // （高度為 0）時就先 pan/zoom，會導致地圖回到 Layer 1 後維持黑塊。
  restoreBookingHomeView();

  if (mapInstance && window.google) {
    google.maps.event.trigger(mapInstance, 'resize');
  }
  if (typeof recenterMapToUserGps === 'function') recenterMapToUserGps();

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


// --- 管家（Concierge）彈出式選點地圖 Picker Modal ---
// 管家日常介面為輕量文字表單，平時不加載大型地圖；僅在乘客點擊
// 地址欄旁「在地圖上微調」時，才以 Lazy-Singleton 方式建立/重用獨立的
// 輕量地圖實例（conciergePickerMapInstance），確認或取消後即隱藏 Modal 釋放畫面，
// 但保留地圖實例供下次快速重用，避免重複觸發 Google Maps 地圖載入計費事件。
let conciergePickerMapInstance = null;
let conciergePickerMarker = null;
let conciergePickerFieldType = 'pickup';
let conciergePickerTempPos = null;
let conciergePickerTempAddress = "";

function openConciergeLocationPicker(fieldType) {
  conciergePickerFieldType = fieldType;
  const modal = document.getElementById('locationPickerModal');
  const title = document.getElementById('locationPickerTitle');
  if (!modal) return;

  if (title) {
    title.innerText = (fieldType === 'pickup') ? 'Adjust Store / Pickup Point' : 'Adjust Delivery Destination';
  }
  modal.classList.remove('hidden');

  setTimeout(() => {
    if (!window.google || !window.google.maps) return;

    const existingCoord = (fieldType === 'pickup') ? conciergePickupCoord : conciergeDropoffCoord;
    const initialPos = existingCoord || { lat: 7.0722, lng: 125.6125 };

    if (!conciergePickerMapInstance) {
      conciergePickerMapInstance = new google.maps.Map(document.getElementById("conciergePickerMap"), {
        center: initialPos,
        zoom: 17,
        disableDefaultUI: true,
        zoomControl: true
      });
    } else {
      google.maps.event.trigger(conciergePickerMapInstance, 'resize');
      conciergePickerMapInstance.setCenter(initialPos);
      conciergePickerMapInstance.setZoom(17);
    }

    if (conciergePickerMarker) conciergePickerMarker.setMap(null);
    // 嚴禁自創圖示：起點沿用系統既有男女專屬圖釘 getPickupPinIcon()（js/profile.js，
    // 依 currentUserProfile.gender 切換），終點沿用既有目的地旗幟 getDestinationFlagIcon()
    // （js/map.js），與主地圖、Concierge 表單左側 Pin 完全同一套官方資產。
    const pickerIcon = (fieldType === 'pickup')
      ? (typeof getPickupPinIcon === 'function' ? getPickupPinIcon() : undefined)
      : (typeof getDestinationFlagIcon === 'function' ? getDestinationFlagIcon() : undefined);
    conciergePickerMarker = new google.maps.Marker({
      position: initialPos,
      map: conciergePickerMapInstance,
      draggable: true,
      icon: pickerIcon
    });

    conciergePickerTempPos = initialPos;
    const addressInput = document.getElementById(fieldType === 'pickup' ? 'conciergePickup' : 'conciergeDropoff');
    const existingAddress = addressInput ? addressInput.value.trim() : "";
    if (existingAddress) {
      conciergePickerTempAddress = existingAddress;
      const addrText = document.getElementById('conciergePickerAddressText');
      if (addrText) addrText.innerText = existingAddress;
    } else {
      reverseGeocodeConciergePicker(initialPos);
    }

    conciergePickerMarker.addListener("dragend", () => {
      const newPos = conciergePickerMarker.getPosition();
      conciergePickerTempPos = { lat: newPos.lat(), lng: newPos.lng() };
      reverseGeocodeConciergePicker(conciergePickerTempPos);
    });
  }, 200);
}

function locateConciergePickerGps() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    (position) => {
      const userPos = { lat: position.coords.latitude, lng: position.coords.longitude };
      if (conciergePickerMapInstance && conciergePickerMarker) {
        conciergePickerMapInstance.panTo(userPos);
        conciergePickerMapInstance.setZoom(17);
        conciergePickerMarker.setPosition(userPos);
        conciergePickerTempPos = userPos;
        reverseGeocodeConciergePicker(userPos);
      }
    },
    (err) => console.warn("[Concierge Picker] GPS locate failed:", err),
    { enableHighAccuracy: true, timeout: 6000 }
  );
}

function reverseGeocodeConciergePicker(pos) {
  if (typeof geocoderInstance === 'undefined' || !geocoderInstance) return;
  try {
    geocoderInstance.geocode({ location: pos }, (res, status) => {
      if (status === "OK" && res[0]) {
        conciergePickerTempAddress = res[0].formatted_address;
        const addrText = document.getElementById('conciergePickerAddressText');
        if (addrText) addrText.innerText = conciergePickerTempAddress;
      }
    });
  } catch (err) {
    console.error("[Concierge Picker] Reverse geocode failed:", err);
  }
}

function confirmConciergeLocationPicker() {
  if (!conciergePickerTempPos) {
    closeLocationPickerModal();
    return;
  }

  const finalPos = conciergePickerTempPos;
  const finalAddr = conciergePickerTempAddress ||
    document.getElementById(conciergePickerFieldType === 'pickup' ? 'conciergePickup' : 'conciergeDropoff')?.value || "";

  if (conciergePickerFieldType === 'pickup') {
    conciergePickupCoord = finalPos;
  } else {
    conciergeDropoffCoord = finalPos;
  }

  const addressInput = document.getElementById(conciergePickerFieldType === 'pickup' ? 'conciergePickup' : 'conciergeDropoff');
  if (addressInput) addressInput.value = finalAddr;

  if (conciergePickupCoord && conciergeDropoffCoord && typeof calculateAndDisplayRoute === 'function') {
    calculateAndDisplayRoute(false);
  }

  closeLocationPickerModal();
}

function closeLocationPickerModal() {
  const modal = document.getElementById('locationPickerModal');
  if (modal) modal.classList.add('hidden');
  conciergePickerTempPos = null;
  conciergePickerTempAddress = "";
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
window.addEventListener("DOMContentLoaded", safeInvoke(function () {
  document.getElementById('btnMinimizeTrip')?.addEventListener('click', minimizeActiveTrip);
  document.getElementById('tripFloatingBubble')?.addEventListener('click', restoreActiveTripFromBubble);
}, "wireActiveTripMinimizeControls"));
