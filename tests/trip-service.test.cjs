const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createTripService } = require("../functions/trip-service");
const { memoryStore } = require("./support/store.cjs");
const Motion = require("../js/trip-motion");
const phone = "+639171234567", secondPhone = "+639171234568";
const customer = { uid: "customer", phone: "+639171234500", role: "customer", sessionId: "a".repeat(64) };
const driver = { uid: "driver", phone, role: "driver", credentialVersion: "v1", sessionId: "b".repeat(64) };
const rate = { nameEn: "Car", base: 40, baseKm: 2, perKm: 10, surgeMultiplier: 1.5,
  surgeFlat: 20, convenienceFee: 30, commType: "PERCENT", commVal: 0.15 };
const points = "_p~iF~ps|U_ulLnnqC_mqNvxq`@";
function setup() {
  const store = memoryStore({ "rate_config/current": { rates: { RIDE_CAR: rate } } });
  function grant(value) {
    const session = { ...value, sessionId: value.sessionId || require("node:crypto").randomBytes(32).toString("hex") };
    store.docs.set(`_auth_sessions/${session.sessionId}`, { ...session, revoked: false });
    return session;
  }
  grant(customer);
  grant(driver);
  for (const p of [phone, secondPhone]) {
    store.docs.set(`drivers/${p}`, { phone: p, name: "Real roster", plate: "ABC", model: "SUV" });
    store.docs.set(`driver_auth_secrets/${p}`, { enabled: true, version: "v1" });
  }
  let calls = 0, clock = 1_000_000;
  const route = async () => {
    calls++;
    return { polyline: points, durationSeconds: 600, distanceMeters: 5000,
      start: { lat: 38.5, lng: -120.2 }, end: { lat: 43.252, lng: -126.453 } };
  };
  const service = createTripService({ store, route, now: () => clock, stamp: () => clock });
  const input = { orderId: "OD-test001", category: "mobility", serviceId: "RIDE_CAR", origin: "Pickup", destination: "Dropoff",
    itemCost: 0, tip: 0, totalPay: 155 };
  return { store, service, input, grant, calls: () => calls, tick: ms => { clock += ms; },
    create: () => service.createOrder(customer, input),
    claim: () => service.claimOrder(driver, { orderId: input.orderId, location: { lat: 0, lng: 125 } }),
    state: () => store.docs.get(`ride_orders/${input.orderId}/trip_state/current`) };
}
test("booking snapshots platform fee, all driver surge revenue and included kilometers without repricing", async () => {
  const h = setup();
  const order = await h.create();
  assert.equal(order.totalPay, 155);
  assert.equal(order.customerPhone, customer.phone);
  assert.equal(h.state().driverEarnings, 114.5);
  assert.equal(h.state().totalFare, 155);
  h.store.docs.set("rate_config/current", { rates: { RIDE_CAR: { ...rate, surgeMultiplier: 3 } } });
  const again = await h.create();
  assert.equal(again.totalPay, 155);
  assert.equal(h.calls(), 1, "idempotent booking must not request another route");
});
test("dispatch reads require a current participant session and return only the canonical order", async () => {
  const h = setup();
  await h.create();
  await assert.rejects(h.service.dispatchOrder(driver, { orderId: h.input.orderId }), { code: "FORBIDDEN" });
  assert.equal((await h.service.dispatchOrder(customer, { orderId: h.input.orderId })).order.totalPay, 155);
  await h.service.setOnline(driver, true);
  await h.claim();
  const result = await h.service.dispatchOrder(driver, { orderId: h.input.orderId, totalPay: 1, status: "completed" });
  assert.equal(result.order.totalPay, 155);
  assert.equal(result.order.status, "accepted");
  h.store.docs.get(`_auth_sessions/${driver.sessionId}`).revoked = true;
  await assert.rejects(h.service.dispatchOrder(driver, { orderId: h.input.orderId }), { code: "SESSION_REVOKED" });
  h.store.docs.delete(`ride_orders/${h.input.orderId}/trip_state/current`);
  await assert.rejects(h.service.dispatchOrder(customer, { orderId: h.input.orderId }), { code: "LEGACY_TRIP" });
});
test("edited prices, negative amounts, invalid service and duplicate customer bookings are rejected", async () => {
  const h = setup();
  await assert.rejects(h.service.createOrder(customer, { ...h.input, totalPay: 1 }), { code: "PRICE_CHANGED" });
  await assert.rejects(h.service.createOrder(customer, { ...h.input, tip: -1 }), { code: "INVALID_AMOUNT" });
  await assert.rejects(h.service.createOrder(customer, { ...h.input, serviceId: "FAKE" }), { code: "INVALID_SERVICE" });
  await h.create();
  await assert.rejects(h.service.createOrder(customer, { ...h.input, orderId: "OD-test002" }), { code: "ACTIVE_TRIP" });
  assert.equal(h.store.docs.has("ride_orders/OD-test002"), false);
});
test("atomic claim prevents two drivers taking one trip and writes exactly one GPS fix", async () => {
  const h = setup();
  await h.create();
  await h.service.setOnline(driver, true);
  const other = h.grant({ ...driver, phone: secondPhone, sessionId: "c".repeat(64) });
  await h.service.setOnline(other, true);
  const results = await Promise.allSettled([
    h.claim(), h.service.claimOrder(other, { orderId: h.input.orderId, location: { lat: 1, lng: 125 } })
  ]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.find(r => r.status === "rejected").reason.code, "ALREADY_CLAIMED");
  const order = h.store.docs.get("ride_orders/OD-test001");
  assert.equal(order.driverId, phone);
  assert.equal(order.driverLat, 0, "zero-valued latitude is valid");
  assert.equal(order.driverName, "Real roster");
  assert.equal(h.state().phase, "pickup");
  await h.claim();
  assert.equal(h.store.docs.get("ride_orders/OD-test001").driverLat, 0);
});
test("offline, revoked, self-booking and malformed GPS cannot claim", async () => {
  const h = setup();
  await h.create();
  await assert.rejects(h.claim(), { code: "DRIVER_OFFLINE" });
  await h.service.setOnline(driver, true);
  await assert.rejects(h.service.claimOrder(driver, { orderId: h.input.orderId, location: { lat: 100, lng: 0 } }), { code: "GPS_REQUIRED" });
  h.store.docs.get("ride_orders/OD-test001").customerPhone = phone;
  await assert.rejects(h.claim(), { code: "OWN_ORDER" });
  h.store.docs.delete(`drivers/${phone}`);
  await assert.rejects(h.claim(), { code: "DRIVER_REVOKED" });
});
test("paused driver can advance owned trip; invalid order, foreign driver and skipped phases cannot", async () => {
  const h = setup();
  await h.create();
  await h.service.setOnline(driver, true);
  await h.claim();
  await h.service.setOnline(driver, false);
  await assert.rejects(h.service.advance(driver, { orderId: h.input.orderId, status: "in_progress" }), { code: "INVALID_TRANSITION" });
  await assert.rejects(h.service.advance(driver, { orderId: h.input.orderId, status: "completed" }), { code: "INVALID_TRANSITION" });
  const other = h.grant({ ...driver, phone: secondPhone, sessionId: "c".repeat(64) });
  await assert.rejects(h.service.advance(other, { orderId: h.input.orderId, status: "arrived" }), { code: "FORBIDDEN" });
  for (const [status, phase] of [["arrived", "waiting"], ["in_progress", "delivery"], ["completed", "completed"]]) {
    h.tick(5000);
    const result = await h.service.advance(driver, { orderId: h.input.orderId, status });
    assert.equal(h.state().phase, phase);
    assert.equal(result.totalFare, 155);
    assert.equal(result.driverEarnings, 114.5);
    const startedAt = h.state().phaseStartedAt;
    h.tick(1000);
    await h.service.advance(driver, { orderId: h.input.orderId, status });
    assert.equal(h.state().phaseStartedAt, startedAt, "repeated taps must not restart a phase");
  }
  assert.equal(h.store.docs.get(`_driver_work/${phone}`).activeOrderId, null);
  assert.equal(h.store.docs.get("_customer_work/customer").activeOrderId, null);
  assert.equal(h.calls(), 2, "route calculated once per stage, never on progress updates");
});
test("one driver cannot claim multiple active orders", async () => {
  const h = setup();
  await h.create();
  const other = h.grant({ ...customer, uid: "another", phone: "+639171234599", sessionId: "c".repeat(64) });
  await h.service.createOrder(other, { ...h.input, orderId: "OD-test002" });
  await h.service.setOnline(driver, true);
  await h.claim();
  await assert.rejects(h.service.claimOrder(driver, { orderId: "OD-test002", location: { lat: 0, lng: 125 } }), { code: "ACTIVE_TRIP" });
});
test("passenger cancellation releases both work locks and protects other passengers", async () => {
  const h = setup();
  await h.create();
  await h.service.setOnline(driver, true);
  await h.claim();
  await assert.rejects(h.service.cancel(driver, { orderId: h.input.orderId }), { code: "FORBIDDEN" });
  await h.service.cancel(customer, { orderId: h.input.orderId });
  assert.equal(h.state().phase, "cancelled");
  assert.equal(h.store.docs.get(`_driver_work/${phone}`).activeOrderId, null);
});
test("share token is unguessable, sanitized and updated only with trip transitions", async () => {
  const h = setup();
  await h.create();
  await h.service.setOnline(driver, true);
  await h.claim();
  const { token } = await h.service.share(customer, { orderId: h.input.orderId });
  assert.match(token, /^[a-f0-9]{64}$/);
  let shared = h.store.docs.get(`trip_shares/${token}`);
  assert.equal(shared.customerPhone, undefined);
  assert.equal(shared.driverPhone, undefined);
  assert.equal(shared.tripState.driverEarnings, undefined);
  assert.equal(shared.tripState.customerUid, undefined);
  await h.service.advance(driver, { orderId: h.input.orderId, status: "arrived" });
  shared = h.store.docs.get(`trip_shares/${token}`);
  assert.equal(shared.tripState.phase, "waiting");
});
test("both browsers reconstruct identical route positions and cap progress exactly at 90 percent without writes", () => {
  const path = Motion.measurePath(Motion.decodePolyline(points));
  const state = { phase: "pickup", phaseStartedAt: 0, pickupRoute: { durationSeconds: 100 } };
  assert.equal(Motion.phaseProgress(state, -1), 0);
  assert.equal(Motion.phaseProgress(state, 50_000), 0.5);
  assert.equal(Motion.phaseProgress(state, 100_000), 0.9);
  assert.equal(Motion.phaseProgress(state, 1_000_000), 0.9);
  for (let t = 0; t < 100_000; t += 16) {
    assert.deepEqual(Motion.atProgress(path, Motion.phaseProgress(state, t)),
      Motion.atProgress(path, Motion.phaseProgress(structuredClone(state), t)));
  }
  assert.deepEqual(Motion.atProgress(path, 0), { lat: 38.5, lng: -120.2 });
  assert.deepEqual(Motion.atProgress(path, 1), { lat: 43.252, lng: -126.453 });
  assert.equal(Motion.phaseProgress({ phase: "waiting" }, 0), 1);
  assert.equal(Motion.phaseProgress({ phase: "completed" }, 0), 1);
  assert.equal(Motion.phaseProgress({ phase: "delivery", phaseStartedAt: 5000, delivery: { durationSeconds: 100 } }, 55_000), 0.5);
});

test("session revocation between route lookup and commit cannot leave a new booking after change-phone", async () => {
  const h = setup();
  const service = createTripService({ store: h.store, route: async () => {
    h.store.docs.get(`_auth_sessions/${customer.sessionId}`).revoked = true;
    return { distanceMeters: 5000 };
  } });
  await assert.rejects(service.createOrder(customer, h.input), { code: "SESSION_REVOKED" });
  assert.equal(h.store.docs.has("ride_orders/OD-test001"), false);
});
test("claim racing cancellation releases the newly assigned driver work lock", async () => {
  const h = setup();
  await h.create();
  await h.service.setOnline(driver, true);
  const originalGet = h.store.get;
  let race = true;
  h.store.get = async path => {
    const value = await originalGet(path);
    if (path === "ride_orders/OD-test001" && race) {
      race = false;
      await h.claim();
    }
    return value;
  };
  await h.service.cancel(customer, { orderId: h.input.orderId });
  assert.equal(h.store.docs.get(`_driver_work/${phone}`).activeOrderId, null);
  assert.equal(h.store.docs.get("ride_orders/OD-test001").status, "cancelled");
});

async function telegramTrip() {
  const h = setup();
  await h.create();
  h.store.docs.get(`drivers/${phone}`).telegramId = "1234567";
  Object.assign(h.store.docs.get("ride_orders/OD-test001"), { telegramChatId: "-100000", telegramMessageId: "42" });
  h.callback = { orderId: h.input.orderId, phone, telegramId: "1234567", chatId: "-100000", messageId: "42" };
  h.nativeClaim = () => h.service.claimTelegramOrder(h.callback);
  h.attach = () => h.service.attachPickupLocation(driver, { orderId: h.input.orderId, location: { lat: 0, lng: 125 } });
  return h;
}
test("Telegram acceptance notifies the passenger before any GPS or pickup route, with unchanged fare", async () => {
  const h = await telegramTrip();
  await h.service.setOnline(driver, true);
  assert.equal((await h.nativeClaim()).accepted, true);
  const order = h.store.docs.get("ride_orders/OD-test001");
  assert.equal(order.status, "accepted");
  assert.equal(order.driverName, "Real roster");
  assert.equal(order.driverLat, undefined);
  assert.equal(h.state().phase, "awaiting_location");
  assert.equal(h.state().pickupRoute, undefined);
  assert.equal(h.state().totalFare, 155);
  assert.equal(h.state().driverEarnings, 114.5);
  assert.equal(h.calls(), 1);
  const before = structuredClone(h.state());
  await h.nativeClaim();
  assert.deepEqual(h.state(), before);
  await assert.rejects(h.service.advance(driver, { orderId: h.input.orderId, status: "arrived" }), { code: "GPS_REQUIRED" });
  await h.service.setOnline(driver, false);
  await h.attach();
  assert.equal(h.state().phase, "pickup");
  assert.equal(h.store.docs.get("ride_orders/OD-test001").driverLat, 0);
  const startedAt = h.state().phaseStartedAt;
  h.tick(5000);
  await h.service.attachPickupLocation(driver, { orderId: h.input.orderId, location: { lat: 2, lng: 124 } });
  assert.equal(h.state().phaseStartedAt, startedAt);
  assert.equal(h.store.docs.get("ride_orders/OD-test001").driverLat, 0);
  assert.equal(h.calls(), 2, "repeat attachment never recomputes or overwrites the one GPS fix");
});
test("native claim rejects offline, unlinked, revoked, forged cards, self orders and work conflicts", async () => {
  const h = await telegramTrip();
  await assert.rejects(h.nativeClaim(), { code: "DRIVER_OFFLINE" });
  await h.service.setOnline(driver, true);
  for (const input of [{ ...h.callback, telegramId: "7654321" }, { ...h.callback, phone: secondPhone }]) {
    await assert.rejects(h.service.claimTelegramOrder(input), { code: "DRIVER_REVOKED" });
  }
  for (const input of [{ ...h.callback, chatId: "-100001" }, { ...h.callback, messageId: "99" }]) {
    await assert.rejects(h.service.claimTelegramOrder(input), { code: "INVALID_CALLBACK" });
  }
  h.store.docs.get(`driver_auth_secrets/${phone}`).enabled = false;
  await assert.rejects(h.nativeClaim(), { code: "DRIVER_REVOKED" });
  h.store.docs.get(`driver_auth_secrets/${phone}`).enabled = true;
  h.store.docs.get(`_driver_work/${phone}`).activeOrderId = "OD-another";
  await assert.rejects(h.nativeClaim(), { code: "ACTIVE_TRIP" });
  h.store.docs.get(`_driver_work/${phone}`).activeOrderId = null;
  h.store.docs.get("ride_orders/OD-test001").customerPhone = phone;
  await assert.rejects(h.nativeClaim(), { code: "OWN_ORDER" });
  assert.equal(h.store.docs.get("ride_orders/OD-test001").status, "pending");
});
test("web and Telegram claims share the atomic lock, and a late web claim cannot replace native ownership", async () => {
  const h = await telegramTrip();
  await h.service.setOnline(driver, true);
  const other = h.grant({ ...driver, phone: secondPhone, sessionId: "c".repeat(64) });
  await h.service.setOnline(other, true);
  const results = await Promise.allSettled([h.nativeClaim(),
    h.service.claimOrder(other, { orderId: h.input.orderId, location: { lat: 1, lng: 125 } })]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.find(result => result.status === "rejected").reason.code, "ALREADY_CLAIMED");
  assert.equal(h.store.docs.get("ride_orders/OD-test001").driverId, phone);
  assert.equal(h.state().phase, "awaiting_location");
});
test("deferred location is owner-only and rechecks revocation or cancellation after route lookup", async () => {
  for (const conflict of ["revoked", "cancelled"]) {
    const h = await telegramTrip();
    await h.service.setOnline(driver, true);
    await h.nativeClaim();
    const other = h.grant({ ...driver, phone: secondPhone, sessionId: "c".repeat(64) });
    await assert.rejects(h.service.attachPickupLocation(other, { orderId: h.input.orderId, location: { lat: 0, lng: 125 } }),
      { code: "FORBIDDEN" });
    const service = createTripService({ store: h.store, route: async () => {
      if (conflict === "revoked") h.store.docs.get(`_auth_sessions/${driver.sessionId}`).revoked = true;
      else await h.service.cancel(customer, { orderId: h.input.orderId });
      return { polyline: points };
    } });
    await assert.rejects(service.attachPickupLocation(driver, { orderId: h.input.orderId, location: { lat: 0, lng: 125 } }),
      { code: conflict === "revoked" ? "SESSION_REVOKED" : "INVALID_TRANSITION" });
    assert.equal(h.store.docs.get("ride_orders/OD-test001").driverLat, undefined);
    assert.equal(h.state().pickupRoute, undefined);
  }
});
