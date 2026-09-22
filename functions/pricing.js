(function (root) {
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
  if (typeof module === 'object' && module.exports) module.exports = { validateRate, calculateFare };
  else Object.assign(root, { validateRate, calculateFare });
})(globalThis);
