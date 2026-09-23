"use strict";
const { randomBytes } = require("node:crypto");
const { requireValue } = require("./errors");
const { calculateFare, validateRate } = require("./pricing");
const { DRIVER_SECRETS } = require("./pin");
const active = new Set(["accepted", "arrived", "in_progress"]);
const text = (value, max = 500) => typeof value === "string" && value.trim() && value.length <= max;
function coordinate(value) {
  requireValue(value && Number.isFinite(value.lat) && Math.abs(value.lat) <= 90
    && Number.isFinite(value.lng) && Math.abs(value.lng) <= 180, "GPS_REQUIRED", "A valid location is required.");
  return { lat: value.lat, lng: value.lng };
}

function createTripService({ store, route, now = Date.now, stamp = () => new Date(now()) }) {
  const op = id => {
    requireValue(typeof id === "string" && /^OD-[a-zA-Z0-9-]{6,80}$/.test(id), "INVALID_ORDER", "Invalid trip identifier.");
    return `ride_orders/${id}`;
  };
  const meta = id => `${op(id)}/trip_state/current`;
  const driverPaths = session => [`drivers/${session.phone}`, `${DRIVER_SECRETS}/${session.phone}`, `_driver_work/${session.phone}`];
  const checkDriver = (session, get) => {
    requireValue(session.role === "driver", "DRIVER_REQUIRED", "Only an approved driver may do this.", 403);
    const [dp, cp] = driverPaths(session);
    const driver = get(dp), credential = get(cp);
    requireValue(driver && credential?.enabled && credential.version === session.credentialVersion,
      "DRIVER_REVOKED", "Driver access was revoked.", 403);
    return driver;
  };
  const transaction = (session, paths, callback) => {
    requireValue(/^[a-f0-9]{64}$/.test(session.sessionId || ""), "SIGN_IN_REQUIRED", "Please sign in again.", 401);
    const sp = `_auth_sessions/${session.sessionId}`;
    const extra = [sp, ...driverPaths(session).slice(0, 2)];
    return store.atomic([...new Set([...paths, ...extra])], (get, put) => {
      const current = get(sp);
      requireValue(current && !current.revoked && current.uid === session.uid && current.phone === session.phone
        && current.role === session.role, "SESSION_REVOKED", "Please sign in again.", 401);
      if (session.role === "driver") checkDriver(session, get);
      else requireValue(session.role === "customer" && !get(`drivers/${session.phone}`),
        "DRIVER_PIN_REQUIRED", "Registered drivers must sign in with their company PIN.", 403);
      return callback(get, put);
    });
  };
  const customer = (session, order) => order?.customerPhone === session.phone;
  const shareData = (order, state) => ({
    status: order.status, category: order.category, origin: order.origin, destination: order.destination,
    driverName: order.driverName || "", driverVehicle: order.driverVehicle || "",
    driverPlate: order.driverPlate || "", tripState: state,
    expiresAt: now() + (["completed", "cancelled"].includes(order.status) ? 3_600_000 : 86_400_000)
  });
  const updateShare = (put, order, state) => {
    if (state.shareToken) {
      const { shareToken, totalFare, driverEarnings, customerUid, ...publicState } = state;
      put(`trip_shares/${shareToken}`, shareData(order, publicState));
    }
  };

  async function createOrder(session, input) {
    const path = op(input.orderId);
    const previous = await store.get(path);
    if (previous) {
      return transaction(session, [path], get => {
        const existing = get(path);
        requireValue(customer(session, existing), "ORDER_EXISTS", "This trip identifier is already in use.", 409);
        return { ...existing, createdAt: null };
      });
    }
    requireValue(text(input.origin) && text(input.destination), "ADDRESS_REQUIRED", "Specify pickup and destination.");
    requireValue(["mobility", "concierge"].includes(input.category), "INVALID_SERVICE", "Select a valid service.");
    requireValue(["RIDE_MOTO", "RIDE_CAR", "RIDE_SUV", "EXPRESS", "PABILI"].includes(input.serviceId),
      "INVALID_SERVICE", "Select a valid service.");
    requireValue((input.category === "mobility") === input.serviceId.startsWith("RIDE_"),
      "INVALID_SERVICE", "The service does not belong to this category.");
    const itemCost = input.serviceId === "PABILI" ? Number(input.itemCost) : 0;
    const tip = Number(input.tip);
    requireValue([itemCost, tip].every(v => Number.isFinite(v) && v >= 0 && v <= 100_000),
      "INVALID_AMOUNT", "Invalid item cost or tip.");
    const delivery = await route(input.pickupCoordinate ? coordinate(input.pickupCoordinate) : input.origin,
      input.destinationCoordinate ? coordinate(input.destinationCoordinate) : input.destination);
    const accountPath = `_customer_work/${session.uid}`;
    return transaction(session, [path, "rate_config/current", accountPath], (get, put) => {
      const existing = get(path);
      if (existing) {
        requireValue(customer(session, existing), "ORDER_EXISTS", "This trip identifier is already in use.", 409);
        return { ...existing, createdAt: null };
      }
      requireValue(!get(accountPath)?.activeOrderId, "ACTIVE_TRIP", "Complete or cancel your current trip first.", 409);
      const rule = get("rate_config/current")?.rates?.[input.serviceId];
      requireValue(validateRate(rule), "PRICE_UNAVAILABLE", "This service is unavailable.");
      const distance = Number((delivery.distanceMeters / 1000).toFixed(1));
      const fare = calculateFare(rule, distance, itemCost, tip);
      requireValue(Math.abs(Number(input.totalPay) - fare.total) <= 0.01, "PRICE_CHANGED",
        "The route or price changed. Review the updated fare and submit again.", 409,
        { total: fare.total, distance, driverPayout: fare.driverPayout });
      const name = text(input.customerName, 100) ? input.customerName.trim() : "VIP Guest";
      const order = {
        orderId: input.orderId, customerName: name, customerPhone: session.phone,
        customerInfo: `${name} (${session.phone})`, category: input.category, serviceId: input.serviceId,
        serviceName: rule.nameEn, origin: input.origin.trim(), destination: input.destination.trim(),
        distance, notes: text(input.notes, 2000) ? input.notes : "-", itemCost, tip, totalPay: fare.total,
        pickup: input.origin.trim(), dropoff: input.destination.trim(), fare: fare.total,
        vehicleType: rule.nameEn, estimatedFare: fare.total, status: "pending", createdAt: stamp()
      };
      const state = {
        customerUid: session.uid, delivery, pickup: delivery.start, destination: delivery.end,
        totalFare: fare.total, driverEarnings: fare.driverPayout, phase: "pending", phaseStartedAt: now()
      };
      put(path, order);
      put(meta(input.orderId), state);
      put(accountPath, { activeOrderId: input.orderId });
      return { ...order, createdAt: now() };
    });
  }

  async function setOnline(session, online) {
    requireValue(typeof online === "boolean", "INVALID_PRESENCE", "Invalid availability.");
    const paths = driverPaths(session);
    return transaction(session, paths, (get, put) => {
      checkDriver(session, get);
      put(paths[2], { ...get(paths[2]), online });
      return { online };
    });
  }

  async function claimOrder(session, { orderId, location }) {
    requireValue(session.role === "driver", "DRIVER_REQUIRED", "Only an approved driver may do this.", 403);
    const gps = coordinate(location);
    const path = op(orderId), mp = meta(orderId);
    const initial = await store.get(mp);
    requireValue(initial?.pickup, "LEGACY_TRIP", "This trip needs dispatch assistance.");
    const pickupRoute = await route(gps, initial.pickup);
    const paths = driverPaths(session);
    return transaction(session, [path, mp, ...paths], (get, put) => {
      const profile = checkDriver(session, get);
      return commitClaim(get, put, session.phone, profile, orderId, { gps, pickupRoute });
    });
  }

  function commitClaim(get, put, phone, profile, orderId, { gps, pickupRoute } = {}) {
      const path = op(orderId), mp = meta(orderId), wp = `_driver_work/${phone}`;
      const order = get(path), state = get(mp), work = get(wp) || {};
      if (order?.driverId === phone && active.has(order.status)) return { accepted: true };
      requireValue(work.online, "DRIVER_OFFLINE", "Go online in Driver Mode before accepting an order.", 409);
      requireValue(!work.activeOrderId, "ACTIVE_TRIP", "Complete your active trip first.", 409);
      requireValue(order?.status === "pending", "ALREADY_CLAIMED", "Trip already claimed or unavailable.", 409);
      requireValue(state?.pickup, "LEGACY_TRIP", "This trip needs dispatch assistance.");
      requireValue(order.customerPhone !== phone, "OWN_ORDER", "You cannot accept your own booking.", 409);
      const updated = { ...order, status: "accepted", driverId: phone, driverPhone: phone,
        driverName: profile.name, driverVehicle: profile.model, driverPlate: profile.plate,
        driverGender: "male", ...(gps ? { driverLat: gps.lat, driverLng: gps.lng } : {}), acceptedAt: stamp() };
      const trip = { ...state, ...(pickupRoute ? { pickupRoute } : {}),
        phase: pickupRoute ? "pickup" : "awaiting_location", phaseStartedAt: now() };
      put(path, updated);
      put(mp, trip);
      put(wp, { ...work, activeOrderId: orderId });
      updateShare(put, updated, trip);
      return { accepted: true };
  }

  async function claimTelegramOrder({ orderId, phone, telegramId, chatId, messageId }) {
    const path = op(orderId), mp = meta(orderId), paths = driverPaths({ phone });
    return store.atomic([path, mp, ...paths], (get, put) => {
      const profile = get(paths[0]), credential = get(paths[1]), order = get(path);
      requireValue(profile && profile.telegramId === telegramId && credential?.enabled,
        "DRIVER_REVOKED", "Your Telegram account is not linked to an approved driver. Contact operations.", 403);
      requireValue(order && String(order.telegramChatId) === chatId && String(order.telegramMessageId) === messageId,
        "INVALID_CALLBACK", "This dispatch card is no longer valid.", 403);
      return commitClaim(get, put, phone, profile, orderId);
    });
  }

  async function attachPickupLocation(session, { orderId, location }) {
    requireValue(session.role === "driver", "DRIVER_REQUIRED", "Only an approved driver may do this.", 403);
    const gps = coordinate(location), path = op(orderId), mp = meta(orderId);
    const initial = await transaction(session, [path, mp], get => {
      requireValue(get(path)?.driverId === session.phone, "FORBIDDEN", "This is not your trip.", 403);
      requireValue(get(path).status === "accepted", "INVALID_TRANSITION", "This trip is no longer awaiting pickup.", 409);
      return get(mp);
    });
    requireValue(initial?.pickup, "LEGACY_TRIP", "This trip needs dispatch assistance.");
    if (initial.pickupRoute) return { locationAttached: true };
    const pickupRoute = await route(gps, initial.pickup);
    return transaction(session, [path, mp], (get, put) => {
      const order = get(path), state = get(mp);
      requireValue(order?.driverId === session.phone, "FORBIDDEN", "This is not your trip.", 403);
      requireValue(order.status === "accepted", "INVALID_TRANSITION", "This trip is no longer awaiting pickup.", 409);
      if (state.pickupRoute) return { locationAttached: true };
      requireValue(state.phase === "awaiting_location", "INVALID_TRANSITION", "This trip is not awaiting location.", 409);
      const updated = { ...order, driverLat: gps.lat, driverLng: gps.lng };
      const trip = { ...state, pickupRoute, phase: "pickup", phaseStartedAt: now() };
      put(path, updated);
      put(mp, trip);
      updateShare(put, updated, trip);
      return { locationAttached: true };
    });
  }

  async function advance(session, { orderId, status }) {
    const path = op(orderId), mp = meta(orderId);
    const initial = await store.get(mp);
    requireValue(initial, "LEGACY_TRIP", "This trip needs dispatch assistance.");
    const customerWork = `_customer_work/${initial.customerUid}`;
    const paths = driverPaths(session);
    return transaction(session, [path, mp, customerWork, ...paths], (get, put) => {
      checkDriver(session, get);
      const order = get(path), state = get(mp);
      requireValue(order?.driverId === session.phone, "FORBIDDEN", "This is not your trip.", 403);
      if (order.status === status && ["arrived", "in_progress", "completed"].includes(status)) {
        return { status, totalFare: state.totalFare, driverEarnings: state.driverEarnings };
      }
      requireValue(({ accepted: "arrived", arrived: "in_progress", in_progress: "completed" })[order.status] === status,
        "INVALID_TRANSITION", "The trip has changed. Refresh its status.", 409);
      requireValue(state.phase !== "awaiting_location", "GPS_REQUIRED", "Enable location in Driver Mode before continuing.", 409);
      const next = { ...order, status, updatedAt: stamp(), ...(status === "completed" ? { completedAt: stamp() } : {}) };
      const trip = { ...state, phase: { arrived: "waiting", in_progress: "delivery", completed: "completed" }[status],
        phaseStartedAt: now() };
      put(path, next);
      put(mp, trip);
      if (status === "completed") {
        put(paths[2], { ...get(paths[2]), activeOrderId: null });
        put(customerWork, { activeOrderId: null });
      }
      updateShare(put, next, trip);
      return { status, totalFare: state.totalFare, driverEarnings: state.driverEarnings };
    });
  }

  async function cancel(session, { orderId }) {
    const path = op(orderId), mp = meta(orderId);
    for (let attempt = 0; attempt < 3; attempt++) {
      const initial = await store.get(path);
      const wp = initial?.driverId ? `_driver_work/${initial.driverId}` : `_customer_work/${session.uid}`;
      const result = await transaction(session, [path, mp, wp, `_customer_work/${session.uid}`], (get, put) => {
        const order = get(path), state = get(mp);
        requireValue(customer(session, order), "FORBIDDEN", "This is not your booking.", 403);
        // A claim can commit between the initial lookup and this transaction.
        if (order.driverId !== initial?.driverId) return { retry: true };
        if (order.status === "cancelled") return { status: "cancelled" };
        requireValue(order.status !== "completed", "ALREADY_COMPLETED", "This trip has already ended.", 409);
        const next = { ...order, status: "cancelled", cancelledAt: stamp() };
        put(path, next);
        put(`_customer_work/${session.uid}`, { activeOrderId: null });
        if (order.driverId && get(wp)?.activeOrderId === orderId) put(wp, { ...get(wp), activeOrderId: null });
        if (state) {
          const trip = { ...state, phase: "cancelled", phaseStartedAt: now() };
          put(mp, trip);
          updateShare(put, next, trip);
        }
        return { status: "cancelled" };
      });
      if (!result.retry) return result;
    }
    requireValue(false, "TRIP_CHANGED", "The trip changed while cancelling. Please retry.", 409);
  }

  async function share(session, { orderId }) {
    const path = op(orderId), mp = meta(orderId);
    return transaction(session, [path, mp], (get, put) => {
      const order = get(path), state = get(mp);
      requireValue(customer(session, order) && state, "FORBIDDEN", "Only the passenger may share this trip.", 403);
      requireValue(active.has(order.status), "TRIP_ENDED", "Only an active trip can be shared.");
      const token = state.shareToken || randomBytes(32).toString("hex");
      const next = { ...state, shareToken: token };
      put(mp, next);
      updateShare(put, order, next);
      return { token };
    });
  }
  async function dispatchOrder(session, { orderId }) {
    const path = op(orderId), mp = meta(orderId);
    return transaction(session, [path, mp], get => {
      const order = get(path);
      requireValue(order && (customer(session, order)
        || (session.role === "driver" && order.driverId === session.phone)),
      "FORBIDDEN", "Only a trip participant may synchronize dispatch.", 403);
      requireValue(get(mp), "LEGACY_TRIP", "This trip needs dispatch assistance.");
      return { order };
    });
  }
  return { createOrder, setOnline, claimOrder, claimTelegramOrder, attachPickupLocation, advance, cancel, share, dispatchOrder };
}
module.exports = { createTripService, coordinate };
