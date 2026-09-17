// --- 6. 叫車下單與 Firestore 連線 ---
async function requestOrder() {
  const submitBtn = document.getElementById('btnSubmit');
  let from = "", to = "", notes = "";
  if (currentCategory === 'mobility') {
    from = document.getElementById('pickupLoc').value.trim();
    to = document.getElementById('dropoffLoc').value.trim();
    if (!from || !to) {
      alert("Please specify both Pick-up and Drop-off locations.");
      return;
    }
  } else {
    from = document.getElementById('conciergePickup').value.trim();
    to = document.getElementById('conciergeDropoff').value.trim();
    notes = document.getElementById('itemList').value.trim();
    if (!from || !to) {
      alert("Please specify both Store/Pickup and Delivery locations.");
      return;
    }
  }

  const custName = currentUserProfile.name || "VIP Guest";
  const custPhone = currentUserProfile.phone || "0917-000-0000";

  const dist = parseFloat(document.getElementById('distance').value) || 0;
  const itemCost = (currentService === 'PABILI') ? (parseFloat(document.getElementById('itemCost').value) || 0) : 0;
  const tip = parseFloat(document.getElementById('priorityTip').value) || 0;
  const finalPrice = parseFloat(document.getElementById('estTotal').innerText) || 0;
  const serviceRate = RATES[currentService];

  if (!serviceRate) {
    console.error("Order dispatch blocked: missing service rate.", currentService);
    alert("Unable to calculate this service fare. Please select the service again.");
    return;
  }

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.classList.add('opacity-60', 'pointer-events-none');
  }

  document.getElementById('dispatchModal').classList.remove('hidden');
  document.getElementById('radarSection').classList.remove('hidden');
  document.getElementById('matchedCard').classList.add('hidden');
  document.getElementById('modalOrderId').innerText = 'Generating...';
  document.getElementById('dispatchStatusText').innerText = 'Connecting to exclusive fleet in real-time...';
  document.getElementById('dispatchStatusText').className = 'text-xs text-slate-500 mt-1';

  const orderId = 'OD-' + Math.floor(100000 + Math.random() * 900000);
  currentOrderId = orderId;
  localStorage.setItem('r2g_active_order_id', orderId); // 任務3：記憶訂單狀態

  document.getElementById('modalOrderId').innerText = orderId;
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
    vehicleType: serviceRate.nameEn,
    estimatedFare: finalPrice,
    status: 'pending',
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  };

  try {
    await db.collection("orders").doc(orderId).set(orderData);
    subscribeToOrder(orderId);

    fetch(GAS_WEBHOOK_URL, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'NEW_ORDER', ...orderData })
    }).catch(e => console.warn('Background sync:', e));
  } catch (err) {
    console.error("Order dispatch failed:", err);
    const statusText = document.getElementById('dispatchStatusText');
    if (statusText) {
      statusText.innerText = `Unable to send order: ${err.message || 'connection error'}`;
      statusText.className = 'text-xs text-rose-600 mt-1';
    }
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.classList.remove('opacity-60', 'pointer-events-none');
    }
  }
}

function subscribeToOrder(orderId) {
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
      finishTripAndReset();
      return;
    }
    if (['accepted', 'matched', 'arrived', 'in_progress', 'completed'].includes(status)) {
      renderNativeTripView(status, data);
      updateTripStatusUI(status, data);
      if (status === 'completed' && typeof unsubscribeOrder === 'function') {
        unsubscribeOrder();
        unsubscribeOrder = null;
      }
    }
  }, err => {
    console.error("Realtime listener error:", err);
    const statusText = document.getElementById('dispatchStatusText');
    if (statusText) statusText.innerText = `Live order update failed: ${err.message || 'connection error'}`;
  });
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
  document.getElementById('dispatchModal')?.classList.add('hidden');
  document.getElementById('mascotCapsule')?.classList.add('hidden');
  document.getElementById('activeTripBottomCard')?.classList.remove('hidden');
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
  completionSlot.innerHTML = '';
  shareSlot.classList.toggle('hidden', status !== 'in_progress');
  completionSlot.classList.toggle('hidden', status !== 'completed');

  if (status === 'in_progress') {
    shareSlot.innerHTML = `
      <button type="button" onclick="shareLiveTripStatus()" class="w-full rounded-xl border border-blue-200 bg-blue-50 px-4 py-2.5 text-xs font-bold text-blue-700 transition hover:bg-blue-100">
        Share Trip
      </button>`;
  }
  if (status === 'completed') {
    completionSlot.innerHTML = `
      <div class="rounded-xl border border-blue-100 bg-blue-50 p-3 text-center">
        <p class="text-xs font-semibold text-blue-700">Trip completed · ₱${total}</p>
        <button type="button" onclick="finishTripAndReset()" class="mt-2 w-full rounded-xl bg-blue-600 px-4 py-2.5 text-xs font-bold text-white transition hover:bg-blue-700">
          Done
        </button>
      </div>`;
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
  const orderIdSpan = document.getElementById('modalOrderId');
  const orderId = currentOrderId || (orderIdSpan ? orderIdSpan.innerText.trim() : '');
  if (!orderId || orderId === 'Generating...') {
    alert("Trip details are not ready yet.");
    return;
  }

  const shareUrl = `${window.location.origin}${window.location.pathname}?track=${orderId}`;
  const shareData = {
    title: 'Ride2gether Safe Trip Tracking',
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
  const modal = document.getElementById("dispatchModal");
  if (!modal) return;
  modal.classList.toggle("hidden");
};

// --- 任務 1：司機接單後自動切換全幅大地圖＋底部浮動卡片 ---
function showMatchedDriver(data) {
  stopDispatchTimer();

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
    mapContainer.style.height = '65vh';
    if (mapInstance) {
      google.maps.event.trigger(mapInstance, 'resize');
    }
  }

  document.getElementById('radarSection').classList.add('hidden');
  document.getElementById('matchedCard').classList.remove('hidden');
  document.getElementById('dispatchModal').classList.remove('hidden');
  document.getElementById('mascotCapsule')?.classList.remove('hidden');

  const driverNameEl = document.getElementById('driverName');
  if (driverNameEl) driverNameEl.innerText = data.driverName || 'Executive Chauffeur';

  const driverContactEl = document.getElementById('driverContact');
  if (driverContactEl) {
    const phone = data.driverPhone || '+639171234567';
    const wa = (data.driverWhatsApp || phone).replace(/[^0-9]/g, '');
    const viberNum = encodeURIComponent(data.driverViber || phone);
    const tgUsername = data.driverTelegram ? data.driverTelegram.replace('@', '') : '';

    let buttonsHtml = `
      <div id="chauffeurContactSection" class="mt-2.5 pt-2.5 border-t border-slate-100">
        <div class="text-[10px] font-semibold tracking-wider uppercase text-slate-400 mb-1.5">Direct Chauffeur Contact</div>
        <div class="grid grid-cols-2 gap-2">
          <a href="tel:${phone}" class="flex items-center justify-center py-2 px-3 bg-slate-900 hover:bg-black text-white text-xs font-semibold rounded-xl shadow-sm transition-all active:scale-95">
            <svg class="w-4 h-4 mr-1.5" fill="currentColor" viewBox="0 0 24 24"><path d="M20 15.5c-1.2 0-2.4-.2-3.6-.6-.3-.1-.7 0-1 .2l-2.2 2.2c-2.8-1.4-5.1-3.8-6.6-6.6l2.2-2.2c.3-.3.4-.7.2-1-.4-1.1-.6-2.3-.6-3.5 0-.6-.4-1-1-1H4c-.6 0-1 .4-1 1 0 9.4 7.6 17 17 17 .6 0 1-.4 1-1v-3.5c0-.6-.4-1-1-1z"/></svg>
            Call
          </a>
          <a href="https://wa.me/${wa}" target="_blank" class="flex items-center justify-center py-2 px-3 bg-[#25D366] hover:bg-[#20ba5a] text-white text-xs font-semibold rounded-xl shadow-sm transition-all active:scale-95">
            <svg class="w-4 h-4 mr-1.5" fill="currentColor" viewBox="0 0 24 24"><path d="M.057 24l1.687-6.163c-1.041-1.804-1.588-3.849-1.587-5.946.003-6.556 5.338-11.891 11.893-11.891 3.181.001 6.167 1.24 8.413 3.488 2.245 2.248 3.481 5.236 3.48 8.414-.003 6.557-5.338 11.892-11.893 11.892-1.99-.001-3.951-.5-5.688-1.448l-6.305 1.654zm6.597-3.807c1.676.995 3.276 1.591 5.392 1.592 5.448 0 9.886-4.434 9.889-9.885.002-5.462-4.415-9.89-9.881-9.892-5.452 0-9.887 4.434-9.889 9.884-.001 2.225.651 3.891 1.746 5.634l-.999 3.648 3.742-.981zm11.387-5.464c-.074-.124-.272-.198-.57-.347-.297-.149-1.758-.868-2.031-.967-.272-.099-.47-.149-.669.149-.198.297-.768.967-.941 1.165-.173.198-.347.223-.644.074-.297-.149-1.255-.462-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.297-.347.446-.521.151-.172.2-.296.3-.495.099-.198.05-.372-.025-.521-.075-.148-.669-1.611-.916-2.206-.242-.579-.487-.501-.669-.51l-.57-.01c-.198 0-.52.074-.792.372s-1.04 1.016-1.04 2.479 1.065 2.876 1.213 3.074c.149.198 2.095 3.2 5.076 4.487.709.306 1.263.489 1.694.626.712.226 1.36.194 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.695.248-1.29.173-1.414z"/></svg>
            WhatsApp
          </a>
          <a href="viber://chat?number=${viberNum}" class="flex items-center justify-center py-2 px-3 bg-[#7360F2] hover:bg-[#624ee8] text-white text-xs font-semibold rounded-xl shadow-sm transition-all active:scale-95">
            <svg class="w-4 h-4 mr-1.5" fill="currentColor" viewBox="0 0 24 24"><path d="M11.398 0C4.877 0 .195 4.316.008 10.372c-.12 3.864 1.776 7.428 4.968 9.24v2.964c0 .648.648 1.068 1.2.78l3.192-1.656c.672.108 1.368.168 2.076.168 6.516 0 12.36-4.308 12.552-10.368C24.191 5.436 18.96 0 11.398 0zm6.192 14.196c-.252.696-1.224 1.344-1.992 1.488-.528.096-1.224.168-3.552-.804-2.964-1.236-4.884-4.224-5.028-4.416-.144-.192-1.188-1.584-1.188-3.024 0-1.44.756-2.148 1.02-2.436.264-.288.588-.36.78-.36.204 0 .396.012.564.024.18.012.42-.072.66.504.252.612.852 2.088.924 2.244.072.156.12.336.024.528-.096.204-.144.324-.288.504-.144.18-.312.396-.444.528-.156.144-.312.312-.132.624.18.312.804 1.32 1.728 2.136 1.188 1.056 2.184 1.38 2.496 1.536.312.144.492.12.672-.084.18-.204.78-.912.984-1.224.204-.312.42-.264.696-.156.288.096 1.8.852 2.112 1.008.312.156.516.228.588.36.072.144.072.828-.18 1.524z"/></svg>
            Viber
          </a>
          ${tgUsername ? `
            <a href="https://t.me/${tgUsername}" target="_blank" class="flex items-center justify-center py-2 px-3 bg-[#229ED9] hover:bg-[#1f8fc4] text-white text-xs font-semibold rounded-xl shadow-sm transition-all active:scale-95">
              <svg class="w-4 h-4 mr-1.5" fill="currentColor" viewBox="0 0 24 24"><path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.894 8.221l-1.97 9.28c-.145.658-.537.818-1.084.508l-3-2.21-1.446 1.394c-.16.16-.295.295-.605.295l.213-3.053 5.56-5.023c.242-.213-.054-.333-.373-.121l-6.871 4.326-2.962-.924c-.643-.204-.657-.643.136-.953l11.57-4.461c.537-.194 1.006.131.832.922z"/></svg>
              Telegram
            </a>
          ` : `
            <div class="flex items-center justify-center py-2 px-3 bg-slate-100 text-slate-500 text-xs font-medium rounded-xl">
              <span class="mr-1.5 text-sm">⏱️</span> ~8-12 mins
            </div>
          `}
        </div>
      </div>
    `;
    driverContactEl.innerHTML = buttonsHtml;
  }

  const driverPlateEl = document.getElementById('driverPlate');
  if (driverPlateEl) {
    driverPlateEl.innerText = [data.driverPlate, data.driverModel].filter(Boolean).join(' • ') || 'VIP Fleet';
  }

  const cardPayEl = document.getElementById('cardPay');
  if (cardPayEl) cardPayEl.innerText = `₱${parseFloat(data.totalPay || 0).toFixed(2)}`;

  const cardServiceEl = document.getElementById('cardService');
  if (cardServiceEl) cardServiceEl.innerText = data.serviceName || RATES[currentService].nameEn;
}

function updateTripStatusUI(status, data = {}) {
  const badge = document.getElementById('txt-matched-badge');
  if (!badge) return;
  const normalizedStatus = String(status || '').toLowerCase();
  const driverContact = document.getElementById('driverContact');
  const doneButton = document.querySelector('#matchedCard button[onclick="finishTripAndReset()"]');

  if (normalizedStatus === 'accepted' || normalizedStatus === 'matched') {
    badge.innerText = 'CHAUFFEUR ACCEPTED';
    badge.className = 'text-[10px] tracking-widest font-semibold uppercase text-blue-600 bg-blue-50 px-2.5 py-1 rounded-full border border-blue-200 inline-block';
    if (driverContact) driverContact.innerText = 'Your chauffeur accepted the trip and is heading to the pick-up point.';
  } else if (normalizedStatus === 'arrived') {
    badge.innerText = 'CHAUFFEUR HAS ARRIVED';
    badge.className = 'text-[10px] tracking-widest font-semibold uppercase text-emerald-600 bg-emerald-50 px-2.5 py-1 rounded-full border border-emerald-200 inline-block';
    if (driverContact) driverContact.innerText = 'Your chauffeur has arrived at the pick-up point.';
  } else if (normalizedStatus === 'in_progress') {
    badge.innerText = 'TRIP IN PROGRESS';
    badge.className = 'text-[10px] tracking-widest font-semibold uppercase text-blue-600 bg-blue-50 px-2.5 py-1 rounded-full border border-blue-200 inline-block';
    if (driverContact) driverContact.innerText = 'Heading to your destination.';
  } else if (normalizedStatus === 'completed') {
    badge.innerText = 'TRIP COMPLETED';
    badge.className = 'text-[10px] tracking-widest font-semibold uppercase text-slate-600 bg-slate-100 px-2.5 py-1 rounded-full border border-slate-300 inline-block';
    if (driverContact) driverContact.innerText = `Trip completed. Total paid: ₱${Number(data.totalPay || data.estimatedFare || 0).toFixed(2)}`;
    if (doneButton) doneButton.innerText = 'Finish and return to booking';
    const contactSec = document.getElementById('chauffeurContactSection');
    if (contactSec) contactSec.style.display = 'none';
  }
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
              showMatchedDriver(data);
              updateTripStatusUI(status, data);
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
  document.getElementById('radarSection').classList.add('hidden');
  document.getElementById('timeoutStage1Card').classList.remove('hidden');
}

function extendDispatchWait() {
  document.getElementById('timeoutStage1Card').classList.add('hidden');
  document.getElementById('radarSection').classList.remove('hidden');
  dispatchStage = 2;
  dispatchStartTime = Date.now();
  startDispatchTimeoutChecker();
}

function showTimeoutStage2UI() {
  document.getElementById('radarSection').classList.add('hidden');
  document.getElementById('timeoutStage1Card').classList.add('hidden');
  document.getElementById('timeoutStage2Card').classList.remove('hidden');
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

async function cancelAndReset() {
  const orderIdSpan = document.getElementById('modalOrderId');
  const targetOrderId = String(currentOrderId || (orderIdSpan ? orderIdSpan.innerText.trim() : '')).trim();
  console.log('[Passenger] Cancel requested for order:', targetOrderId || '(missing orderId)');

  stopDispatchTimer();
  removeDriverMarker();
  localStorage.removeItem('r2g_active_order_id'); // 清空本地記憶

  if (typeof unsubscribeOrder === 'function') {
    unsubscribeOrder();
    unsubscribeOrder = null;
  }

  if (targetOrderId && targetOrderId !== 'Generating...' && db) {
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
    console.error('[Passenger] Cancellation skipped: no valid orderId or Firestore instance.', {
      orderId: targetOrderId,
      hasDb: Boolean(db)
    });
  }

  document.getElementById('dispatchModal').classList.add('hidden');
  document.getElementById('radarSection').classList.remove('hidden');
  document.getElementById('matchedCard').classList.add('hidden');
  document.getElementById('mascotCapsule')?.classList.add('hidden');
  const submitBtn = document.getElementById('btnSubmit');
  if (submitBtn) {
    submitBtn.disabled = false;
    submitBtn.classList.remove('opacity-60', 'pointer-events-none');
  }

  if (targetOrderId && targetOrderId !== 'Generating...') {
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
  currentOrderId = null;
}

function finishTripAndReset() {
  removeDriverMarker();
  localStorage.removeItem('r2g_active_order_id'); // 清空本地記憶

  if (typeof unsubscribeOrder === 'function') {
    unsubscribeOrder();
    unsubscribeOrder = null;
  }
  document.getElementById('dispatchModal').classList.add('hidden');
  document.getElementById('radarSection').classList.remove('hidden');
  document.getElementById('matchedCard').classList.add('hidden');
  document.getElementById('mascotCapsule')?.classList.add('hidden');
  document.getElementById('activeTripBottomCard')?.classList.add('hidden');
  if (directionsRenderer) directionsRenderer.set('directions', null);
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
    switchCategory(currentCategory);
  }
  const submitBtn = document.getElementById('btnSubmit');
  if (submitBtn) {
    submitBtn.disabled = false;
    submitBtn.classList.remove('opacity-60', 'pointer-events-none');
  }
  currentOrderId = null;
}

// --- 任務 3：網頁載入時自動恢復正在進行的訂單 (防跳App或刷新丟失) ---
function checkActiveOrderOnLoad() {
  const activeId = localStorage.getItem('r2g_active_order_id');
  const urlParams = new URLSearchParams(window.location.search);
  if (activeId && !urlParams.has('track')) {
    currentOrderId = activeId;
    const modalIdEl = document.getElementById('modalOrderId');
    if (modalIdEl) modalIdEl.innerText = activeId;
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
loadProfile();
updateCardBadges();
fetchLatestRates();
window.addEventListener("DOMContentLoaded", initAutocomplete);
window.addEventListener("load", initAutocomplete);
window.addEventListener("DOMContentLoaded", checkViewerTrackingMode);
window.addEventListener("DOMContentLoaded", checkActiveOrderOnLoad);
