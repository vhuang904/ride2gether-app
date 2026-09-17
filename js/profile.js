// --- 3. VIP 會員與自訂常用地點核心 ---
function openProfileModal() {
  const modal = document.getElementById('profileModal');
  if (modal) modal.classList.remove('hidden');
}

function closeProfileModal() {
  const modal = document.getElementById('profileModal');
  if (modal) modal.classList.add('hidden');
}

let currentUserProfile = {
  name: "Mr. Vincent",
  gender: "male",
  phone: "0917-888-9999",
  home: {
    address: "Villa Josefina Resort Village, Dumoy, Davao City",
    lat: 7.0512,
    lng: 125.5684
  },
  customPlaces: []
};

function loadProfile() {
  const saved = localStorage.getItem('r2g_vip_profile');
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      if (typeof parsed.home === 'string') {
        currentUserProfile.home = { address: parsed.home, lat: null, lng: null };
      } else {
        currentUserProfile.home = parsed.home || { address: "", lat: null, lng: null };
      }
      currentUserProfile.name = parsed.name || "VIP Guest";
      currentUserProfile.gender = parsed.gender || "male";
      currentUserProfile.phone = parsed.phone || "0917-000-0000";
      currentUserProfile.customPlaces = parsed.customPlaces || [];
    } catch(e) { console.warn("Load profile error:", e); }
  }
  updateHeaderProfileUI();
  renderMainSavedPlacesChips();
  renderCustomPlacesList();
}

function updateHeaderProfileUI() {
  const nameEl = document.getElementById('headerMemberName');
  const avatarEl = document.getElementById('memberAvatarText');
  if (nameEl) nameEl.innerText = currentUserProfile.name || "VIP Guest";
  if (avatarEl) avatarEl.innerText = (currentUserProfile.name || "V").charAt(0).toUpperCase();

  document.getElementById('prefName').value = currentUserProfile.name || "";
  document.getElementById('prefPhone').value = currentUserProfile.phone || "";
  document.getElementById('prefHome').value = (currentUserProfile.home && currentUserProfile.home.address) ? currentUserProfile.home.address : "";
  updateTitleButtonsUI();
}

function setGuestTitle(gender) {
  currentUserProfile.gender = gender;
  updateTitleButtonsUI();
  if (pickupMarker) {
    pickupMarker.setIcon(getPickupPinIcon());
  }
}

function updateTitleButtonsUI() {
  const isFemale = currentUserProfile.gender === 'female';
  const btnM = document.getElementById('titleBtnMale');
  const btnF = document.getElementById('titleBtnFemale');
  if (!btnM || !btnF) return;

  if (isFemale) {
    btnF.className = "py-2 rounded-xl border border-rose-400 bg-rose-50 text-rose-600 font-bold text-xs flex items-center justify-center space-x-1.5 transition active:scale-95";
    btnM.className = "py-2 rounded-xl border border-slate-200 bg-slate-50 text-slate-600 font-medium text-xs flex items-center justify-center space-x-1.5 transition active:scale-95";
  } else {
    btnM.className = "py-2 rounded-xl border border-royal bg-royal-soft text-royal font-bold text-xs flex items-center justify-center space-x-1.5 transition active:scale-95";
    btnF.className = "py-2 rounded-xl border border-slate-200 bg-slate-50 text-slate-600 font-medium text-xs flex items-center justify-center space-x-1.5 transition active:scale-95";
  }
}

function getPickupPinIcon() {
  const isFemale = currentUserProfile.gender === 'female';
  return {
    url: isFemale ? './assets/icons/mascot-vip-female.svg' : './assets/icons/mascot-vip-male.svg',
    scaledSize: new google.maps.Size(42, 50),
    anchor: new google.maps.Point(21, 48)
  };
}

function renderMainSavedPlacesChips() {
  const container = document.getElementById('mainSavedPlacesChips');
  if (!container) return;
  container.innerHTML = '';

  if (currentUserProfile.home && currentUserProfile.home.address) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = "px-2.5 py-1 rounded-full bg-slate-100 hover:bg-royal-soft text-slate-700 hover:text-royal text-[11px] font-semibold transition border border-slate-200 flex-shrink-0 flex items-center";
    btn.innerHTML = `🏠 Home`;
    btn.onclick = () => applyPlaceToRoute(currentUserProfile.home);
    container.appendChild(btn);
  }

  if (currentUserProfile.customPlaces && currentUserProfile.customPlaces.length > 0) {
    currentUserProfile.customPlaces.forEach(p => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = "px-2.5 py-1 rounded-full bg-slate-100 hover:bg-royal-soft text-slate-700 hover:text-royal text-[11px] font-semibold transition border border-slate-200 flex-shrink-0 flex items-center";
      btn.innerHTML = `📍 ${p.label}`;
      btn.onclick = () => applyPlaceToRoute(p);
      container.appendChild(btn);
    });
  }
}

function applyPlaceToRoute(placeObj) {
  if (!placeObj || !placeObj.address) return;

  const isMobility = currentCategory === 'mobility';
  const pInput = isMobility ? document.getElementById('pickupLoc') : document.getElementById('conciergePickup');
  const dInput = isMobility ? document.getElementById('dropoffLoc') : document.getElementById('conciergeDropoff');

  const targetField = (!pInput.value) ? 'pickup' : 'dropoff';
  const targetInput = (!pInput.value) ? pInput : dInput;

  targetInput.value = placeObj.address;

  if (placeObj.lat && placeObj.lng) {
    setPointPosition({ lat: placeObj.lat, lng: placeObj.lng }, targetField, currentCategory, placeObj.address);
  } else {
    geocodeAndFocus(placeObj.address, targetField, currentCategory);
  }
}

function renderCustomPlacesList() {
  const listEl = document.getElementById('customPlacesList');
  if (!listEl) return;
  listEl.innerHTML = '';

  if (!currentUserProfile.customPlaces || currentUserProfile.customPlaces.length === 0) {
    listEl.innerHTML = '<div class="text-[10px] text-slate-400 py-1 italic">No custom places added yet.</div>';
    return;
  }

  currentUserProfile.customPlaces.forEach((item, index) => {
    const row = document.createElement('div');
    row.className = "flex items-center justify-between bg-slate-50 px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs";
    row.innerHTML = `
      <div class="truncate mr-2">
        <span class="font-bold text-navy-900">${item.label}</span>
        <p class="text-[10px] text-slate-500 truncate">${item.address}</p>
      </div>
      <button type="button" onclick="deleteCustomPlace(${index})" class="text-slate-400 hover:text-rose-600 font-bold px-1 text-sm">🗑️</button>
    `;
    listEl.appendChild(row);
  });
}

function openAddPlaceForm() {
  document.getElementById('addPlaceBox').classList.remove('hidden');
  document.getElementById('newPlaceLabel').value = '';
  document.getElementById('newPlaceAddress').value = '';
}

function closeAddPlaceForm() {
  document.getElementById('addPlaceBox').classList.add('hidden');
}

function confirmSaveNewPlace() {
  const label = document.getElementById('newPlaceLabel').value.trim();
  const addr = document.getElementById('newPlaceAddress').value.trim();

  if (!label || !addr) {
    alert("Please provide both label name and address.");
    return;
  }

  const lat = window._tempCustomPos?.lat || null;
  const lng = window._tempCustomPos?.lng || null;

  currentUserProfile.customPlaces.push({ label, address: addr, lat, lng });
  saveProfileToStorage();
  window._tempCustomPos = null;
  closeAddPlaceForm();
  renderCustomPlacesList();
  renderMainSavedPlacesChips();
}

function deleteCustomPlace(index) {
  currentUserProfile.customPlaces.splice(index, 1);
  saveProfileToStorage();
  renderCustomPlacesList();
  renderMainSavedPlacesChips();
}

function saveProfile() {
  currentUserProfile.name = document.getElementById('prefName').value.trim() || "VIP Guest";
  currentUserProfile.gender = currentUserProfile.gender || "male";
  currentUserProfile.phone = document.getElementById('prefPhone').value.trim() || "0917-000-0000";
  const homeInputVal = document.getElementById('prefHome').value.trim();

  if (homeInputVal !== (currentUserProfile.home?.address || '')) {
    currentUserProfile.home = { address: homeInputVal, lat: null, lng: null };
  }

  saveProfileToStorage();
  updateHeaderProfileUI();
  renderMainSavedPlacesChips();
  closeProfileModal();
}

function saveProfileToStorage() {
  localStorage.setItem('r2g_vip_profile', JSON.stringify(currentUserProfile));
}

// --- 3.1 會員中心專屬地圖微調與 GPS 邏輯 ---
let pickerMapInstance = null;
let pickerMarker = null;
let currentPickerTarget = 'home';
let temporaryPickerPos = null;
let temporaryPickerAddress = "";

function useCurrentGpsForHome() {
  if (!navigator.geolocation) {
    alert("Geolocation is not supported by your device.");
    return;
  }

  const prefHomeInput = document.getElementById('prefHome');
  prefHomeInput.value = "Locating via GPS...";

  navigator.geolocation.getCurrentPosition(
    (position) => {
      const userPos = {
        lat: position.coords.latitude,
        lng: position.coords.longitude
      };

      if (geocoderInstance) {
        geocoderInstance.geocode({ location: userPos }, (res, status) => {
          let addrText = `GPS: ${userPos.lat.toFixed(5)}, ${userPos.lng.toFixed(5)}`;
          if (status === "OK" && res[0]) {
            addrText = res[0].formatted_address;
          }
          prefHomeInput.value = addrText;
          currentUserProfile.home = {
            address: addrText,
            lat: userPos.lat,
            lng: userPos.lng
          };
          saveProfileToStorage();
          renderMainSavedPlacesChips();
          alert("🏠 Home location successfully set from your GPS!");
        });
      }
    },
    (err) => {
      console.warn("GPS error:", err);
      alert("Unable to retrieve your location. Please ensure location permissions are enabled.");
      prefHomeInput.value = currentUserProfile.home?.address || "";
    },
    { enableHighAccuracy: true, timeout: 8000 }
  );
}

function openPickerFor(target, optPos, optAddress) {
  currentPickerTarget = target;
  const modal = document.getElementById('pickerMapModal');
  const title = document.getElementById('pickerMapTitle');
  title.innerText = `Adjust ${target.toUpperCase()} Location`;
  modal.classList.remove('hidden');

  setTimeout(() => {
    let initialPos = optPos || { lat: 7.0722, lng: 125.6125 };
    if (!optPos && target === 'home' && currentUserProfile.home?.lat) {
      initialPos = { lat: currentUserProfile.home.lat, lng: currentUserProfile.home.lng };
    }

    if (!pickerMapInstance && window.google && window.google.maps) {
      pickerMapInstance = new google.maps.Map(document.getElementById("pickerMap"), {
        center: initialPos,
        zoom: 17,
        disableDefaultUI: true,
        zoomControl: true
      });
    } else if (pickerMapInstance) {
      pickerMapInstance.setCenter(initialPos);
      pickerMapInstance.setZoom(17);
    }

    if (pickerMarker) pickerMarker.setMap(null);
    pickerMarker = new google.maps.Marker({
      position: initialPos,
      map: pickerMapInstance,
      draggable: true,
      icon: getPersonPinIcon()
    });

    temporaryPickerPos = initialPos;
    if (optAddress) {
      temporaryPickerAddress = optAddress;
      document.getElementById('pickerCurrentAddressText').innerText = optAddress;
    } else {
      reverseGeocodePicker(initialPos);
    }

    pickerMarker.addListener("dragend", () => {
      const newPos = pickerMarker.getPosition();
      temporaryPickerPos = { lat: newPos.lat(), lng: newPos.lng() };
      reverseGeocodePicker(temporaryPickerPos);
    });
  }, 200);
}

function locatePickerGps() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    (position) => {
      const userPos = { lat: position.coords.latitude, lng: position.coords.longitude };
      if (pickerMapInstance && pickerMarker) {
        pickerMapInstance.panTo(userPos);
        pickerMapInstance.setZoom(17);
        pickerMarker.setPosition(userPos);
        temporaryPickerPos = userPos;
        reverseGeocodePicker(userPos);
      }
    },
    (err) => console.warn(err),
    { enableHighAccuracy: true, timeout: 6000 }
  );
}

function reverseGeocodePicker(pos) {
  if (!geocoderInstance) return;
  geocoderInstance.geocode({ location: pos }, (res, status) => {
    if (status === "OK" && res[0]) {
      temporaryPickerAddress = res[0].formatted_address;
      document.getElementById('pickerCurrentAddressText').innerText = temporaryPickerAddress;
    }
  });
}

function confirmPickerLocation() {
  const finalAddr = temporaryPickerAddress || (currentPickerTarget === 'home' ? document.getElementById('prefHome').value : document.getElementById('newPlaceAddress').value);
  const finalLat = temporaryPickerPos?.lat || null;
  const finalLng = temporaryPickerPos?.lng || null;

  if (currentPickerTarget === 'home') {
    currentUserProfile.home = {
      address: finalAddr,
      lat: finalLat,
      lng: finalLng
    };
    document.getElementById('prefHome').value = finalAddr;
    saveProfileToStorage();
    renderMainSavedPlacesChips();
  } else if (currentPickerTarget === 'custom') {
    document.getElementById('newPlaceAddress').value = finalAddr;
    window._tempCustomPos = { lat: finalLat, lng: finalLng };
  }
  closePickerMap();
}

function closePickerMap() {
  document.getElementById('pickerMapModal').classList.add('hidden');
}
