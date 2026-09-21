// --- 4. 服務與費率 ---
let currentCategory = 'mobility';
let currentService = 'RIDE_MOTO';
let unsubscribeOrder = null;
let currentOrderId = null;

let RATES = {};
let ratesReady = false;
let ratesUnsubscribe = null;
let ratesListenerGeneration = 0;
let ratesUnavailableReason = 'Loading current prices...';
const RATE_SERVICE_IDS = ['RIDE_MOTO', 'RIDE_CAR', 'RIDE_SUV', 'EXPRESS', 'PABILI'];

function validateRate(rule) {
  if (!rule || typeof rule.nameEn !== 'string' || !rule.nameEn.trim()) return false;
  if (!['base', 'baseKm', 'perKm', 'surgeFlat', 'convenienceFee', 'commVal'].every(
    key => typeof rule[key] === 'number' && Number.isFinite(rule[key]) && rule[key] >= 0
  )) return false;
  return Number.isFinite(rule.surgeMultiplier) && rule.surgeMultiplier > 0
    && ['PERCENT', 'FIXED'].includes(rule.commType)
    && (rule.commType !== 'PERCENT' || rule.commVal <= 1)
    && (rule.commType !== 'FIXED' || rule.commVal <= rule.base * rule.surgeMultiplier + rule.surgeFlat);
}

function calculateFare(rule, distance, itemCost, tip) {
  if (!validateRate(rule) || ![distance, itemCost, tip].every(value => Number.isFinite(value) && value >= 0)) {
    throw new Error('A valid current price and non-negative amounts are required.');
  }
  const round = value => Math.round((value + Number.EPSILON) * 100) / 100;
  const baseFare = round(rule.base + Math.max(0, distance - rule.baseKm) * rule.perKm);
  const tripFare = round(baseFare * rule.surgeMultiplier + rule.surgeFlat);
  const commission = round(rule.commType === 'PERCENT' ? baseFare * rule.commVal : rule.commVal);
  const convenienceFee = round(rule.convenienceFee);
  const total = round(tripFare + convenienceFee + itemCost + tip);
  const driverPayout = round(tripFare - commission + itemCost + tip);
  if (![total, driverPayout].every(value => Number.isFinite(value) && value >= 0)) {
    throw new Error('The configured price produces an invalid total or driver payout.');
  }
  return { total, driverPayout, convenienceFee, commission, tripFare };
}

function invalidateRates(message) {
  ratesReady = false;
  RATES = {};
  ratesUnavailableReason = message;
  updateCardBadges();
  calculateEstimate();
}

function startRatesListener() {
  if (ratesUnsubscribe) return;
  const generation = ++ratesListenerGeneration;
  try {
    ratesUnsubscribe = db.collection('rate_config').doc('current').onSnapshot(
      { includeMetadataChanges: true },
      snapshot => {
        if (generation !== ratesListenerGeneration) return;
        if (snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites || navigator.onLine === false) {
          invalidateRates('Connect online to verify current prices before booking.');
          return;
        }
        const rates = snapshot.exists ? snapshot.data().rates : null;
        if (!rates || typeof rates !== 'object' || Array.isArray(rates)
            || !Object.values(rates).every(validateRate)) {
          console.error('[Rates] Missing or invalid published Rate_Config.');
          invalidateRates('Current prices are unavailable. Please contact dispatch.');
          return;
        }
        RATES = rates;
        ratesReady = true;
        ratesUnavailableReason = '';
        updateCardBadges();
        calculateEstimate();
      },
      error => {
        if (generation !== ratesListenerGeneration) return;
        ratesListenerGeneration += 1;
        console.error('[Rates] Price listener failed:', error);
        if (ratesUnsubscribe) ratesUnsubscribe();
        ratesUnsubscribe = null;
        invalidateRates('Unable to load current prices. Please retry online.');
      }
    );
  } catch (error) {
    ratesListenerGeneration += 1;
    console.error('[Rates] Unable to start price listener:', error);
    invalidateRates('Unable to load current prices. Please retry online.');
  }
}

window.addEventListener('offline', () => invalidateRates('Connect online to verify current prices before booking.'));
window.addEventListener('online', () => {
  if (ratesUnsubscribe) ratesUnsubscribe();
  ratesUnsubscribe = null;
  startRatesListener();
});

function updateCardBadges() {
  RATE_SERVICE_IDS.forEach(id => {
    const el = document.getElementById(`badge-${id}`);
    if (!el) return;
    const rule = ratesReady && RATES[id];
    el.innerText = 'Price unavailable';
    if (rule) {
      try {
        el.innerText = `From ₱${calculateFare(rule, 0, 0, 0).total.toFixed(2)}`;
      } catch (error) {
        console.error('[Rates] Invalid minimum fare:', id, error);
      }
    }
  });
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
  const dist = Number(document.getElementById('distance').value || 0);
  document.getElementById('distVal').innerText = `${dist.toFixed(1)} km`;

  const itemCost = (currentService === 'PABILI') ? Number(document.getElementById('itemCost').value || 0) : 0;
  const tip = Number(document.getElementById('priorityTip').value || 0);
  const rule = ratesReady && navigator.onLine !== false && RATES[currentService];
  let quote = null;
  let message = ratesUnavailableReason || 'This service is not available at the current price.';
  if (rule) {
    try {
      quote = calculateFare(rule, dist, itemCost, tip);
    } catch (error) {
      console.error('[Rates] Unable to calculate current fare:', error);
      message = 'This price is invalid. Please contact dispatch.';
    }
  }
  document.getElementById('estTotal').innerText = quote ? quote.total.toFixed(2) : '--';
  document.getElementById('estPayout').innerText = quote ? `approx. ₱${quote.driverPayout.toFixed(2)}` : 'Unavailable';
  const fee = document.getElementById('estConvenienceFee');
  if (fee) fee.textContent = quote ? `₱${quote.convenienceFee.toFixed(2)}` : '--';
  const status = document.getElementById('rateStatus');
  if (status) {
    status.textContent = quote ? '' : message;
    status.classList.toggle('hidden', Boolean(quote));
  }
  return quote;
}
