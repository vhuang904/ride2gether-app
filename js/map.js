// --- 5. 地圖、圖釘鎖定與路線核心 ---
let mapInstance = null;
let pickupMarker = null;
let dropoffMarker = null;
let userLocationMarker = null;
let geocoderInstance = null;
let directionsService = null;
let directionsRenderer = null;

let mobilityPickupCoord = null;
let mobilityDropoffCoord = null;
let conciergePickupCoord = null;
let conciergeDropoffCoord = null;

let activeFieldFocus = 'pickup';
let currentEditingMarkerType = null;

function getPersonPinIcon() {
  return {
    url: "data:image/svg+xml;charset=UTF-8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="36" viewBox="0 0 30 34"><filter id="s" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="1.5" stdDeviation="1.5" flood-color="#000" flood-opacity="0.3"/></filter><g filter="url(#s)"><path d="M5 21 C5 15.5 9.5 13.5 15 13.5 C20.5 13.5 25 15.5 25 21 C25 24 18.5 26 18.5 26 L15 31.5 L11.5 26 C11.5 26 5 24 5 21 Z" fill="#2563eb" stroke="#ffffff" stroke-width="1" stroke-linejoin="round"/><circle cx="15" cy="7.5" r="5" fill="#2563eb" stroke="#ffffff" stroke-width="1"/></g></svg>'),
    scaledSize: new google.maps.Size(28, 32),
    anchor: new google.maps.Point(14, 32)
  };
}

function getDestinationFlagIcon() {
  return {
    url: 'assets/icons/pin-destination.svg',
    scaledSize: new google.maps.Size(42, 50),
    origin: new google.maps.Point(0, 0),
    anchor: new google.maps.Point(21, 46)
  };
}

function getUserGpsIcon() {
  return {
    url: "data:image/svg+xml;charset=UTF-8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#3b82f6" fill-opacity="0.3"/><circle cx="12" cy="12" r="6" fill="#1d4ed8" stroke="#ffffff" stroke-width="2"/></svg>'),
    scaledSize: new google.maps.Size(24, 24),
    anchor: new google.maps.Point(12, 12)
  };
}

function addContextAwareLocationControl(map) {
  const controlDiv = document.createElement("div");
  controlDiv.style.margin = "12px";

  const controlBtn = document.createElement("button");
  controlBtn.type = "button";
  controlBtn.title = "Locate or Center Point";
  controlBtn.style.backgroundColor = "#ffffff";
  controlBtn.style.border = "none";
  controlBtn.style.outline = "none";
  controlBtn.style.width = "40px";
  controlBtn.style.height = "40px";
  controlBtn.style.borderRadius = "50%";
  controlBtn.style.boxShadow = "0 3px 8px rgba(0,0,0,0.3)";
  controlBtn.style.cursor = "pointer";
  controlBtn.style.display = "flex";
  controlBtn.style.alignItems = "center";
  controlBtn.style.justifyContent = "center";
  controlBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#1e40af" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="7"/><polyline points="12 2 12 5"/><polyline points="12 19 12 22"/><polyline points="2 12 5 12"/><polyline points="19 12 22 12"/></svg>';

  controlBtn.addEventListener("click", () => {
    const isMobility = currentCategory === 'mobility';
    const curPickup = isMobility ? mobilityPickupCoord : conciergePickupCoord;
    const curDropoff = isMobility ? mobilityDropoffCoord : conciergeDropoffCoord;

    if (activeFieldFocus === 'dropoff' && curDropoff) {
      map.panTo(curDropoff);
      map.setZoom(17);
      return;
    }

    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const userPos = { lat: position.coords.latitude, lng: position.coords.longitude };
          if (userLocationMarker) {
            userLocationMarker.setPosition(userPos);
            userLocationMarker.setMap(map);
          } else {
            userLocationMarker = new google.maps.Marker({
              position: userPos,
              map: map,
              icon: getUserGpsIcon(),
              zIndex: 999
            });
          }

          if (!curPickup) {
            setPointPosition(userPos, 'pickup', currentCategory);
          } else {
            map.panTo(userPos);
            map.setZoom(16);
          }
        },
        (err) => console.warn("GPS lookup failed:", err),
        { enableHighAccuracy: true, timeout: 6000 }
      );
    }
  });

  controlDiv.appendChild(controlBtn);
  map.controls[google.maps.ControlPosition.RIGHT_BOTTOM].push(controlDiv);
}

function getOrCreateMap(centerLatLng) {
  const container = document.getElementById("mapPreviewContainer");
  if (container) container.classList.remove("hidden");

  if (!mapInstance && window.google && window.google.maps) {
    mapInstance = new google.maps.Map(document.getElementById("map"), {
      center: centerLatLng,
      zoom: 16,
      disableDefaultUI: true,
      zoomControl: true,
      gestureHandling: 'auto'
    });

    directionsRenderer = new google.maps.DirectionsRenderer({
      map: mapInstance,
      suppressMarkers: true,
      preserveViewport: true,
      polylineOptions: { strokeColor: "#1e40af", strokeWeight: 5, strokeOpacity: 0.9 }
    });

    addContextAwareLocationControl(mapInstance);
  }
  return mapInstance;
}

// --- 主地圖鎖定展示模式：司機接單後鎖定拖曳手勢，行程結束後解鎖 ---
function lockMainMapGestures() {
  if (mapInstance) mapInstance.setOptions({ gestureHandling: 'none' });
}

function unlockMainMapGestures() {
  if (mapInstance) mapInstance.setOptions({ gestureHandling: 'auto' });
}

// 行程結束後，將主地圖視角平滑重設回乘客目前 GPS 定位。
function recenterMapToUserGps() {
  if (!mapInstance || !navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    (position) => {
      const userPos = { lat: position.coords.latitude, lng: position.coords.longitude };
      mapInstance.panTo(userPos);
      mapInstance.setZoom(16);
    },
    (err) => console.warn("[Passenger] GPS recenter failed:", err),
    { enableHighAccuracy: true, timeout: 6000 }
  );
}

function setPointPosition(pos, fieldType, catType, optAddressText) {
  const map = getOrCreateMap(pos);
  map.panTo(pos);
  map.setZoom(17);

  currentEditingMarkerType = fieldType;

  if (catType === 'mobility') {
    if (fieldType === 'pickup') mobilityPickupCoord = pos;
    else mobilityDropoffCoord = pos;
  } else {
    if (fieldType === 'pickup') conciergePickupCoord = pos;
    else conciergeDropoffCoord = pos;
  }

  if (fieldType === 'pickup') {
    if (pickupMarker) pickupMarker.setMap(null);
    pickupMarker = new google.maps.Marker({
      position: pos,
      map: map,
      draggable: true,
      icon: getPickupPinIcon()
    });
    pickupMarker.addListener("dragend", () => {
      const newPos = pickupMarker.getPosition();
      if (catType === 'mobility') mobilityPickupCoord = newPos; else conciergePickupCoord = newPos;
      if (mobilityDropoffCoord || conciergeDropoffCoord) calculateAndDisplayRoute(false);
      showPinBubble(pickupMarker, 'pickup', catType);
    });
  } else {
    if (dropoffMarker) dropoffMarker.setMap(null);
    dropoffMarker = new google.maps.Marker({
      position: pos,
      map: map,
      draggable: true,
      icon: getDestinationFlagIcon()
    });
    dropoffMarker.addListener("dragend", () => {
      const newPos = dropoffMarker.getPosition();
      if (catType === 'mobility') mobilityDropoffCoord = newPos; else conciergeDropoffCoord = newPos;
      if (mobilityPickupCoord || conciergePickupCoord) calculateAndDisplayRoute(false);
      showPinBubble(dropoffMarker, 'dropoff', catType);
    });
  }

  // 起終點齊全時，立即繪製路線並更新數據（維持原始視角不縮放）
  const isMobility = catType === 'mobility';
  const curPickup = isMobility ? mobilityPickupCoord : conciergePickupCoord;
  const curDropoff = isMobility ? mobilityDropoffCoord : conciergeDropoffCoord;

  if (curPickup && curDropoff) {
    calculateAndDisplayRoute(false);
  }

  showPinBubble(fieldType === 'pickup' ? pickupMarker : dropoffMarker, fieldType, catType, optAddressText);
}

function showPinBubble(marker, fieldType, catType, optAddressText) {
  if (window.isViewerMode) return;
  const bubble = document.getElementById('pinActionBubble');
  const title = document.getElementById('bubblePinTitle');
  const badge = document.getElementById('pinLockStatusBadge');

  currentEditingMarkerType = fieldType;
  title.innerText = "Confirm";

  if (badge) {
    badge.innerText = "Adjusting pin...";
    badge.className = "text-[11px] font-semibold px-2 py-0.5 rounded-full bg-amber-50 text-amber-600 border border-amber-200";
  }
  bubble.classList.remove('hidden');
  bubble.classList.add('flex');

  // 若當前處於清空狀態，絕對不自動回填舊地址
  if (isClearingAddress) return;

  if (geocoderInstance && !optAddressText) {
    try {
      geocoderInstance.geocode({ location: marker.getPosition() }, (res, status) => {
        if (isClearingAddress) return;
        if (status === "OK" && res[0]) {
          updateInputBoxText(fieldType, catType, res[0].formatted_address);
        }
      });
    } catch (err) {
      console.error("Reverse geocode failed:", err);
    }
  } else if (optAddressText) {
    updateInputBoxText(fieldType, catType, optAddressText);
  }
}

function updateInputBoxText(fieldType, catType, text) {
  if (catType === 'mobility') {
    const el = (fieldType === 'pickup') ? document.getElementById("pickupLoc") : document.getElementById("dropoffLoc");
    if (el) el.value = text;
  } else {
    const el = (fieldType === 'pickup') ? document.getElementById("conciergePickup") : document.getElementById("conciergeDropoff");
    if (el) el.value = text;
  }
}

function reverseGeocode(pos, targetInputId) {
  if (!geocoderInstance) return;
  try {
    geocoderInstance.geocode({ location: pos }, (res, status) => {
      if (status === "OK" && res[0]) {
        const el = document.getElementById(targetInputId);
        if (el) el.value = res[0].formatted_address;
      }
    });
  } catch (err) {
    console.error("Reverse geocode failed:", err);
  }
}

function lockCurrentPin(isConfirmed) {
  const bubble = document.getElementById('pinActionBubble');
  const badge = document.getElementById('pinLockStatusBadge');
  bubble.classList.add('hidden');
  bubble.classList.remove('flex');

  const isMobility = currentCategory === 'mobility';
  const marker = (currentEditingMarkerType === 'pickup') ? pickupMarker : dropoffMarker;

  if (isConfirmed) {
    if (marker) {
      marker.setDraggable(false);
      const newPos = marker.getPosition();
      if (currentEditingMarkerType === 'pickup') {
        if (isMobility) mobilityPickupCoord = newPos; else conciergePickupCoord = newPos;
        reverseGeocode(newPos, isMobility ? 'pickupLoc' : 'conciergePickup');
      } else {
        if (isMobility) mobilityDropoffCoord = newPos; else conciergeDropoffCoord = newPos;
        reverseGeocode(newPos, isMobility ? 'dropoffLoc' : 'conciergeDropoff');
      }
    }

    if (badge) {
      badge.innerText = "Location Locked 🔒";
      badge.className = "text-[11px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-600 border border-emerald-200";
    }

    // 強制抓取目前最新的起點與終點座標（包含 Marker 實體座標）
    const pCoord = isMobility ? (mobilityPickupCoord || (pickupMarker ? pickupMarker.getPosition() : null))
                              : (conciergePickupCoord || (pickupMarker ? pickupMarker.getPosition() : null));
    const dCoord = isMobility ? (mobilityDropoffCoord || (dropoffMarker ? dropoffMarker.getPosition() : null))
                              : (conciergeDropoffCoord || (dropoffMarker ? dropoffMarker.getPosition() : null));

    if (pCoord && dCoord) {
      if (isMobility) {
        mobilityPickupCoord = pCoord;
        mobilityDropoffCoord = dCoord;
      } else {
        conciergePickupCoord = pCoord;
        conciergeDropoffCoord = dCoord;
      }
      calculateAndDisplayRoute(true);
    } else {
      calculateEstimate();
    }
  } else {
    if (marker) marker.setDraggable(true);
    if (badge) {
      badge.innerText = "Drag pin to adjust";
      badge.className = "text-[11px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200";
    }
  }
}

let isClearingAddress = false;

function clearLocationInput(inputId, fieldType, catType) {
  isClearingAddress = true;
  const el = document.getElementById(inputId);
  if (el) {
    el.value = '';
  }

  const isMobility = (catType === 'mobility');

  // 清除對應點的座標與地圖 Marker
  if (fieldType === 'pickup') {
    if (isMobility) mobilityPickupCoord = null;
    else conciergePickupCoord = null;
    if (pickupMarker) {
      pickupMarker.setMap(null);
      pickupMarker = null;
    }
    activeFieldFocus = 'pickup';
  } else {
    if (isMobility) mobilityDropoffCoord = null;
    else conciergeDropoffCoord = null;
    if (dropoffMarker) {
      dropoffMarker.setMap(null);
      dropoffMarker = null;
    }
    activeFieldFocus = 'dropoff';
  }

  // 路線計算重置並移除導航折線
  if (directionsRenderer) directionsRenderer.set('directions', null);
  document.getElementById("distance").value = "0";
  document.getElementById("distVal").innerText = "-- km";
  document.getElementById("durationVal").innerText = "-- mins";
  const bubble = document.getElementById('pinActionBubble');
  if (bubble) bubble.classList.add('hidden');
  calculateEstimate();

  // 檢查是否還有另一個保留的點：若有，地圖平滑平移並近距離聚焦（Zoom 17）
  const remainingCoord = (fieldType === 'pickup')
    ? (isMobility ? mobilityDropoffCoord : conciergeDropoffCoord)
    : (isMobility ? mobilityPickupCoord : conciergePickupCoord);

  if (remainingCoord && mapInstance) {
    mapInstance.panTo(remainingCoord);
    mapInstance.setZoom(17);
  }

  // 延遲解除清空旗標，避免非同步逆編碼回填
  setTimeout(() => { isClearingAddress = false; }, 400);
}

// 行程徹底重置（resetAppToIdle 的一部分）：清除兩種服務類別的起訖點座標、
// 地圖 Marker 與導航路線，並將金額/距離顯示欄位歸零。與 clearLocationInput()
// 不同，此函式不綁定單一輸入框，供整趟行程結束後一次性徹底清空使用。
function clearAllTripCoordsAndRoute() {
  mobilityPickupCoord = null;
  mobilityDropoffCoord = null;
  conciergePickupCoord = null;
  conciergeDropoffCoord = null;

  if (pickupMarker) {
    pickupMarker.setMap(null);
    pickupMarker = null;
  }
  if (dropoffMarker) {
    dropoffMarker.setMap(null);
    dropoffMarker = null;
  }
  if (directionsRenderer) directionsRenderer.set('directions', null);

  const distanceEl = document.getElementById("distance");
  const distValEl = document.getElementById("distVal");
  const durationValEl = document.getElementById("durationVal");
  if (distanceEl) distanceEl.value = "0";
  if (distValEl) distValEl.innerText = "-- km";
  if (durationValEl) durationValEl.innerText = "-- mins";

  const pickupInput = document.getElementById("pickupLoc");
  const dropoffInput = document.getElementById("dropoffLoc");
  const cPickupInput = document.getElementById("conciergePickup");
  const cDropoffInput = document.getElementById("conciergeDropoff");
  [pickupInput, dropoffInput, cPickupInput, cDropoffInput].forEach(el => { if (el) el.value = ''; });

  if (typeof calculateEstimate === 'function') calculateEstimate();
}

function calculateAndDisplayRoute(fitRoute = true) {
  const isMobility = currentCategory === 'mobility';
  const curPickup = isMobility ? mobilityPickupCoord : conciergePickupCoord;
  const curDropoff = isMobility ? mobilityDropoffCoord : conciergeDropoffCoord;

  if (!curPickup || !curDropoff || !directionsService || !directionsRenderer) return;

  directionsService.route(
    { origin: curPickup, destination: curDropoff, travelMode: google.maps.TravelMode.DRIVING },
    (response, status) => {
      if (status === "OK") {
        directionsRenderer.setDirections(response);
        if (fitRoute && mapInstance) {
          const bounds = new google.maps.LatLngBounds();
          bounds.extend(curPickup);
          bounds.extend(curDropoff);
          mapInstance.fitBounds(bounds, { top: 40, bottom: 40, left: 40, right: 40 });
        }

        const leg = response.routes[0]?.legs[0];
        if (leg) {
          const distanceInKm = (leg.distance.value / 1000).toFixed(1);
          document.getElementById("distance").value = distanceInKm;
          document.getElementById("distVal").innerText = `${distanceInKm} km`;
          document.getElementById("durationVal").innerText = leg.duration.text;
          calculateEstimate();
        }
      }
    }
  );
}

function syncCategoryCoords(cat) {
  const isMobility = (cat === 'mobility');
  const curPickup = isMobility ? mobilityPickupCoord : conciergePickupCoord;
  const curDropoff = isMobility ? mobilityDropoffCoord : conciergeDropoffCoord;

  if (pickupMarker) {
    if (curPickup) { pickupMarker.setPosition(curPickup); pickupMarker.setMap(mapInstance); }
    else { pickupMarker.setMap(null); }
  }
  if (dropoffMarker) {
    if (curDropoff) { dropoffMarker.setPosition(curDropoff); dropoffMarker.setMap(mapInstance); }
    else { dropoffMarker.setMap(null); }
  }

  if (curPickup && curDropoff) {
    calculateAndDisplayRoute(true);
  } else {
    if (directionsRenderer) directionsRenderer.set('directions', null);
    document.getElementById("distance").value = "0";
    document.getElementById("distVal").innerText = "-- km";
    document.getElementById("durationVal").innerText = "-- mins";
    calculateEstimate();
  }
}

// 安全初始化 Geocoder / DirectionsService：Maps JS API 在 loading=async 模式下，
// 部分函式庫 (如 geocoding) 可能尚未就緒，直接 new 會拋出
// "google.maps.Geocoder is not a constructor"。此處以型別檢查 + try/catch 防禦，
// 避免單點錯誤中斷全域 JavaScript 執行（進而波及 order.js 的按鈕綁定）。
function ensureMapsCoreServicesReady() {
  if (!(window.google && window.google.maps)) return false;
  try {
    if (!geocoderInstance && typeof google.maps.Geocoder === "function") {
      geocoderInstance = new google.maps.Geocoder();
    }
  } catch (err) {
    console.error("Failed to initialize google.maps.Geocoder:", err);
  }
  try {
    if (!directionsService && typeof google.maps.DirectionsService === "function") {
      directionsService = new google.maps.DirectionsService();
    }
  } catch (err) {
    console.error("Failed to initialize google.maps.DirectionsService:", err);
  }
  return !!(geocoderInstance && directionsService);
}

let mapsGeocodingRetryScheduled = false;

function initAutocomplete() {
  try {
    const options = {
      componentRestrictions: { country: "ph" },
      fields: ["formatted_address", "geometry", "name"]
    };

    const pickupInput = document.getElementById("pickupLoc");
    const dropoffInput = document.getElementById("dropoffLoc");
    const cPickupInput = document.getElementById("conciergePickup");
    const cDropoffInput = document.getElementById("conciergeDropoff");

    const coreReady = ensureMapsCoreServicesReady();

    // 若 Geocoder/DirectionsService 尚未就緒（函式庫非同步載入中），
    // 稍後重試一次，且僅註冊一次 retry 監聽，避免重複堆疊。
    if (!coreReady && !mapsGeocodingRetryScheduled) {
      mapsGeocodingRetryScheduled = true;
      window.addEventListener("googlemapsready", () => {
        mapsGeocodingRetryScheduled = false;
        ensureMapsCoreServicesReady();
      });
    }

    const bindAuto = (input, fieldType, catType) => {
      if (!input || !window.google || !window.google.maps || !window.google.maps.places) return;

      input.addEventListener("focus", () => { activeFieldFocus = fieldType; });

      try {
        const auto = new google.maps.places.Autocomplete(input, options);
        google.maps.event.addDomListener(input, "keydown", (e) => { if (e.keyCode === 13) e.preventDefault(); });

        auto.addListener("place_changed", () => {
          const place = auto.getPlace();
          if (!place || !place.geometry || !place.geometry.location) return;

          const addressText = place.name ? `${place.name}, ${place.formatted_address}` : place.formatted_address;
          input.value = addressText;
          setPointPosition(place.geometry.location, fieldType, catType, addressText);
        });
      } catch (err) {
        console.error(`Failed to bind Autocomplete for ${fieldType}/${catType}:`, err);
      }
    };

    bindAuto(pickupInput, "pickup", "mobility");
    bindAuto(dropoffInput, "dropoff", "mobility");
    bindAuto(cPickupInput, "pickup", "concierge");
    bindAuto(cDropoffInput, "dropoff", "concierge");

    const prefHomeInput = document.getElementById("prefHome");
    if (prefHomeInput && window.google && window.google.maps && window.google.maps.places) {
      try {
        const homeAuto = new google.maps.places.Autocomplete(prefHomeInput, options);
        homeAuto.addListener("place_changed", () => {
          const place = homeAuto.getPlace();
          if (place && place.geometry && place.geometry.location) {
            const loc = place.geometry.location;
            const chosenPos = { lat: loc.lat(), lng: loc.lng() };
            const chosenAddr = place.name ? `${place.name}, ${place.formatted_address}` : place.formatted_address;
            prefHomeInput.value = chosenAddr;
            openPickerFor('home', chosenPos, chosenAddr);
          }
        });
      } catch (err) {
        console.error("Failed to bind Autocomplete for prefHome:", err);
      }
    }

    const newPlaceAddressInput = document.getElementById("newPlaceAddress");
    if (newPlaceAddressInput && window.google && window.google.maps && window.google.maps.places) {
      try {
        const customAuto = new google.maps.places.Autocomplete(newPlaceAddressInput, options);
        customAuto.addListener("place_changed", () => {
          const place = customAuto.getPlace();
          if (place && place.geometry && place.geometry.location) {
            const loc = place.geometry.location;
            const chosenPos = { lat: loc.lat(), lng: loc.lng() };
            const chosenAddr = place.name ? `${place.name}, ${place.formatted_address}` : place.formatted_address;
            newPlaceAddressInput.value = chosenAddr;
            openPickerFor('custom', chosenPos, chosenAddr);
          }
        });
      } catch (err) {
        console.error("Failed to bind Autocomplete for newPlaceAddress:", err);
      }
    }
  } catch (err) {
    // 任何未預期的例外都不可讓 initAutocomplete 拋出，避免阻斷後續全域腳本
    // (js/order.js) 的事件綁定與執行。
    console.error("initAutocomplete failed unexpectedly:", err);
  }
}
