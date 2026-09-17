// --- 4. 服務與費率 ---
let currentCategory = 'mobility';
let currentService = 'RIDE_MOTO';
let unsubscribeOrder = null;
let currentOrderId = null;

let RATES = {
  RIDE_MOTO: { base: 40, baseKm: 2, perKm: 10, commType: 'PERCENT', commVal: 0.15, nameEn: 'Moto Express' },
  RIDE_CAR:  { base: 70, baseKm: 2, perKm: 18, commType: 'PERCENT', commVal: 0.20, nameEn: 'Executive Sedan' },
  RIDE_SUV:  { base: 120, baseKm: 2, perKm: 25, commType: 'PERCENT', commVal: 0.20, nameEn: 'Premium SUV' },
  EXPRESS:   { base: 50, baseKm: 2, perKm: 12, commType: 'FIXED',   commVal: 15,   nameEn: 'Instant Parcel' },
  PABILI:    { base: 60, baseKm: 2, perKm: 11, commType: 'FIXED',   commVal: 10,   nameEn: 'Pabili Concierge' }
};

function updateCardBadges() {
  const setBadge = (id, base) => {
    const el = document.getElementById(id);
    if (el) el.innerText = `From ₱${base}`;
  };
  setBadge('badge-RIDE_MOTO', RATES.RIDE_MOTO.base);
  setBadge('badge-RIDE_CAR', RATES.RIDE_CAR.base);
  setBadge('badge-RIDE_SUV', RATES.RIDE_SUV.base);
  setBadge('badge-EXPRESS', RATES.EXPRESS.base);
  setBadge('badge-PABILI', RATES.PABILI.base);
}

function switchCategory(cat, opts = {}) {
  // 行程進行中且已最小化為氣泡時，禁止在 Layer1 展開 Mobility 叫車表單/大地圖，
  // 直接視為「乘客想看行程」，無縫召回 Layer2。skipMinimizeGuard 供
  // minimizeActiveTrip() 內部自動切至 Concierge 時使用，避免誤觸此守衛。
  if (!opts.skipMinimizeGuard && typeof isActiveTripMinimized !== 'undefined'
      && isActiveTripMinimized && cat === 'mobility') {
    if (typeof restoreActiveTripFromBubble === 'function') restoreActiveTripFromBubble();
    return;
  }

  currentCategory = cat;
  const tabMobility = document.getElementById('tab-mobility');
  const tabConcierge = document.getElementById('tab-concierge');
  const gridMobility = document.getElementById('grid-mobility');
  const gridConcierge = document.getElementById('grid-concierge');
  const fieldsMobility = document.getElementById('fields-mobility');
  const fieldsConcierge = document.getElementById('fields-concierge');

  if (cat === 'mobility') {
    tabMobility.className = "py-2.5 rounded-lg text-xs font-semibold tracking-wider flex items-center justify-center space-x-2 transition-all duration-300 bg-white text-royal shadow-sm";
    tabConcierge.className = "py-2.5 rounded-lg text-xs font-semibold tracking-wider flex items-center justify-center space-x-2 transition-all duration-300 text-slate-400 hover:text-white";
    gridMobility.classList.remove('hidden');
    gridConcierge.classList.add('hidden');
    fieldsMobility.classList.remove('hidden');
    fieldsConcierge.classList.add('hidden');
    selectService('RIDE_MOTO');
    syncCategoryCoords('mobility');
  } else {
    tabConcierge.className = "py-2.5 rounded-lg text-xs font-semibold tracking-wider flex items-center justify-center space-x-2 transition-all duration-300 bg-white text-royal shadow-sm";
    tabMobility.className = "py-2.5 rounded-lg text-xs font-semibold tracking-wider flex items-center justify-center space-x-2 transition-all duration-300 text-slate-400 hover:text-white";
    gridConcierge.classList.remove('hidden');
    gridMobility.classList.add('hidden');
    fieldsConcierge.classList.remove('hidden');
    fieldsMobility.classList.add('hidden');
    selectService('EXPRESS');
    syncCategoryCoords('concierge');
  }
}

function selectService(type) {
  currentService = type;
  document.querySelectorAll('.service-card').forEach(c => {
    c.classList.remove('card-active');
    const iconBox = c.querySelector('.card-icon');
    const iconSvg = c.querySelector('svg');
    if (iconBox) {
      iconBox.classList.remove('bg-royal-soft');
      iconBox.classList.add('bg-slate-100');
    }
    if (iconSvg) {
      iconSvg.classList.remove('text-royal');
      iconSvg.classList.add('text-slate-700');
    }
  });

  const target = document.getElementById(`card-${type}`);
  if (target) {
    target.classList.add('card-active');
    const iconBox = target.querySelector('.card-icon');
    const iconSvg = target.querySelector('svg');
    if (iconBox) {
      iconBox.classList.remove('bg-slate-100');
      iconBox.classList.add('bg-royal-soft');
    }
    if (iconSvg) {
      iconSvg.classList.remove('text-slate-700');
      iconSvg.classList.add('text-royal');
    }
  }

  const pabiliFields = document.getElementById('pabiliFieldGroup');
  if (type === 'PABILI') {
    pabiliFields.classList.remove('hidden');
  } else {
    pabiliFields.classList.add('hidden');
  }
  calculateEstimate();
}

function setTip(val) {
  document.getElementById('priorityTip').value = val;
  document.querySelectorAll('.tip-btn').forEach(btn => {
    btn.className = "tip-btn py-1.5 rounded-lg border border-slate-200 text-xs font-medium text-slate-600 bg-slate-50 active:scale-95 transition";
  });
  event.target.className = "tip-btn py-1.5 rounded-lg border border-royal text-xs font-semibold text-royal bg-royal-soft active:scale-95 transition";
  calculateEstimate();
}

function calculateEstimate() {
  const dist = parseFloat(document.getElementById('distance').value) || 0;
  document.getElementById('distVal').innerText = `${dist.toFixed(1)} km`;

  const itemCost = (currentService === 'PABILI') ? (parseFloat(document.getElementById('itemCost').value) || 0) : 0;
  const tip = parseFloat(document.getElementById('priorityTip').value) || 0;
  const rule = RATES[currentService] || RATES.RIDE_MOTO;

  const extraKm = Math.max(0, dist - rule.baseKm);
  const surgeMultiplier = rule.surgeMultiplier || 1;
  const surgeFlat = rule.surgeFlat || 0;

  const deliveryFee = (rule.base + (extraKm * rule.perKm)) * surgeMultiplier + surgeFlat;
  const totalCustomerPay = deliveryFee + itemCost + tip;

  let commission = (rule.commType === 'PERCENT') ? (deliveryFee * rule.commVal) : rule.commVal;
  const driverPayout = totalCustomerPay - commission;

  document.getElementById('estTotal').innerText = totalCustomerPay.toFixed(2);
  document.getElementById('estPayout').innerText = `approx. ₱${driverPayout.toFixed(2)}`;
}
