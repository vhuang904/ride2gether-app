const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const Motion = require("../js/trip-motion");
const encoded = "_p~iF~ps|U_ulLnnqC_mqNvxq`@";
function browser() {
  let now = 1000, serial = 0;
  const frames = new Map(), subscriptions = [], markers = [], lines = [], events = [], messages = [];
  const idleListeners = new Set();
  const map = {
    zoom: 15, fittedZoom: 22,
    fitBounds() { this.zoom = this.fittedZoom; events.push("fit"); },
    panToBounds: () => events.push("pan"),
    getZoom() { return this.zoom; },
    setZoom(value) { this.zoom = value; }
  };
  const context = vm.createContext({
    window: {
      accountAuth: { serverTime: () => now },
      google: { maps: {} }
    },
    document: { getElementById: () => ({}) },
    TripMotion: Motion,
    Date: { now: () => now },
    requestAnimationFrame: callback => { const id = ++serial; frames.set(id, callback); return id; },
    cancelAnimationFrame: id => frames.delete(id),
    console: { error: (...args) => messages.push(args) },
    db: {
      collection(name) {
        assert.equal(name, "ride_orders");
        return { doc: () => ({ collection: name => {
          assert.equal(name, "trip_state");
          return { doc: id => {
            assert.equal(id, "current");
            return { onSnapshot(next, error) {
              const subscription = { next, error, active: true };
              subscriptions.push(subscription);
              return () => { subscription.active = false; };
            } };
          } };
        } }) };
      }
    }
  });
  context.google = context.window.google;
  context.google.maps = {
    Map: function () { return map; },
    LatLngBounds: class { extend() {} },
    event: {
      trigger: (_, event) => events.push(event),
      addListenerOnce(target, event, callback) {
        assert.equal(target, map);
        assert.equal(event, "idle");
        idleListeners.add(callback);
        return { remove: () => idleListeners.delete(callback) };
      }
    },
    Polyline: class {
      constructor(options) { this.map = options.map; lines.push(this); }
      setPath(points) { this.points = points; }
      setMap(value) { this.map = value; }
    },
    Marker: class {
      constructor(options) { this.map = options.map; markers.push(this); }
      getPosition() { return this.position ? { toJSON: () => this.position } : null; }
      setPosition(value) { this.position = value; }
      setMap(value) { this.map = value; }
    }
  };
  vm.runInContext(fs.readFileSync(require("node:path").join(__dirname, "../js/trip-mirror.js"), "utf8"), context);
  return {
    mirror: context.window.tripMirror, map, frames, subscriptions, markers, lines, events, idleListeners,
    idle() {
      const callbacks = [...idleListeners];
      idleListeners.clear();
      callbacks.forEach(callback => callback());
    },
    tick(time) {
      now = time;
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach(callback => callback());
    },
    publish(state) { subscriptions.at(-1).next({ exists: true, data: () => state }); }
  };
}
test("two map clients use the same phase snapshots, switch routes, snap on arrival and clean up", () => {
  const customer = browser(), driver = browser();
  const pickup = { lat: 40.7, lng: -120.95 }, destination = { lat: 43.252, lng: -126.453 };
  const state = { phase: "pickup", phaseStartedAt: 1000, pickup, destination,
    pickupRoute: { polyline: encoded, durationSeconds: 100 },
    delivery: { polyline: "_p~iF~ps|U_mqNvxq`@", durationSeconds: 200 } };
  for (const client of [customer, driver]) {
    client.mirror.bind("test", "OD-test001", { map: () => client.map });
    client.publish(state);
    client.tick(51_000);
  }
  assert.deepEqual(customer.markers[0].position, driver.markers[0].position);
  const original = customer.markers[0].position;
  customer.tick(1_000_000);
  driver.tick(1_000_000);
  assert.deepEqual(customer.markers[0].position, driver.markers[0].position);
  assert.notDeepEqual(customer.markers[0].position, original);
  for (const client of [customer, driver]) {
    client.publish({ ...state, phase: "waiting" });
    assert.deepEqual(client.markers[0].position, pickup);
    assert.equal(client.frames.size, 0, "arrival must stop all scheduled movement immediately");
    client.tick(1_010_000);
    assert.deepEqual(client.markers[0].position, pickup, "waiting must remain snapped without polling");
    client.publish({ ...state, phase: "delivery", phaseStartedAt: 1_000_000 });
    client.tick(1_100_000);
    assert.deepEqual(client.lines[0].points, Motion.decodePolyline(state.delivery.polyline));
  }
  assert.deepEqual(customer.markers[0].position, driver.markers[0].position);
  for (const client of [customer, driver]) {
    client.publish({ ...state, phase: "completed" });
    client.tick(1_100_800);
    assert.deepEqual(client.markers[0].position, destination);
    assert.equal(client.events.filter(v => v === "fit").length, 2, "each distinct phase route fits once");
    client.mirror.bind("test", "OD-test001", { map: () => client.map });
    assert.equal(client.subscriptions.length, 1, "same trip does not subscribe twice");
    client.mirror.stopAll();
    assert.equal(client.frames.size, 0);
    assert.equal(client.subscriptions[0].active, false);
    assert.equal(client.markers[0].map, null);
    assert.equal(client.lines[0].map, null);
  }
});
function shortPickup(distanceMeters = 30) {
  return {
    phase: "pickup", phaseStartedAt: 1000, pickup: { lat: 0.00012, lng: 0 },
    destination: { lat: 1, lng: 1 },
    pickupRoute: { polyline: "??S?", distanceMeters, durationSeconds: 100 },
    delivery: { polyline: encoded, distanceMeters: 5000, durationSeconds: 200 }
  };
}
test("short pickup routes visually reach the exact pickup on both clients and sharing without advancing the phase", () => {
  for (const role of ["driver", "customer", "viewer"]) {
    const client = browser(), state = shortPickup();
    const before = JSON.stringify(state);
    if (role === "viewer") client.mirror.showShared("shared", state, { map: () => client.map });
    else {
      client.mirror.bind(role, "OD-short01", { map: () => client.map });
      client.publish(state);
    }
    assert.deepEqual(client.markers[0].position, state.pickup);
    assert.deepEqual(client.lines[0].points.at(-1), state.pickup);
    assert.equal(client.frames.size, 0, "nearby pickups should not run a pointless animation loop");
    client.tick(500_000);
    assert.deepEqual(client.markers[0].position, state.pickup);
    assert.equal(JSON.stringify(state), before, "visual snapping must not mutate authoritative trip state");
  }
});
test("zero-length pickup snaps and the 30-metre limit is inclusive, but detours and mismatched geometry never snap", () => {
  const cases = [
    [shortPickup(30), true],
    [shortPickup(30.01), false],
    [shortPickup(-1), false],
    [shortPickup(NaN), false],
    [{ ...shortPickup(), pickupRoute: { polyline: "????", distanceMeters: 0, durationSeconds: 1 } }, true],
    [{ ...shortPickup(), pickupRoute: { polyline: encoded, distanceMeters: 10, durationSeconds: 100 } }, false],
    [{ ...shortPickup(), pickup: { lat: 1, lng: 1 } }, false]
  ];
  for (const [state, snaps] of cases) {
    const client = browser();
    client.mirror.bind("driver", "OD-short01", { map: () => client.map });
    client.publish(state);
    client.tick(500_000);
    if (snaps) assert.deepEqual(client.markers[0].position, state.pickup);
    else {
      assert.notDeepEqual(client.markers[0].position, state.pickup);
      assert.deepEqual(client.markers[0].position,
        Motion.atProgress(Motion.measurePath(Motion.decodePolyline(state.pickupRoute.polyline)), 0.9));
    }
  }
});
test("short delivery routes still stop at 90 percent until completion", () => {
  const client = browser(), state = shortPickup();
  client.mirror.bind("driver", "OD-short01", { map: () => client.map });
  client.publish({ ...state, phase: "delivery", destination: state.pickup, delivery: state.pickupRoute });
  client.tick(500_000);
  assert.deepEqual(client.markers[0].position,
    Motion.atProgress(Motion.measurePath(Motion.decodePolyline(state.pickupRoute.polyline)), 0.9));
  assert.notDeepEqual(client.markers[0].position, state.pickup);
});
test("automatic framing caps extreme zoom once while preserving manual zoom and wider routes", () => {
  const client = browser(), state = shortPickup();
  client.mirror.bind("driver", "OD-short01", { map: () => client.map });
  client.publish(state);
  client.idle();
  assert.equal(client.map.zoom, 17);
  client.map.setZoom(20);
  client.idle();
  client.publish(state);
  assert.equal(client.map.zoom, 20, "manual zoom must remain available after framing");
  client.map.fittedZoom = 12;
  client.publish({ ...state, phase: "delivery" });
  client.idle();
  assert.equal(client.map.zoom, 12, "long routes must remain fully visible");
});
test("stopping or clearing a trip cancels its pending viewport correction", () => {
  for (const clear of [client => client.mirror.stopAll(),
    client => client.publish({ phase: "awaiting_location" })]) {
    const client = browser();
    client.mirror.bind("driver", "OD-short01", { map: () => client.map });
    client.publish(shortPickup());
    const lateCallback = [...client.idleListeners][0];
    clear(client);
    assert.equal(client.idleListeners.size, 0);
    client.map.setZoom(20);
    client.idle();
    assert.equal(client.map.zoom, 20);
    lateCallback();
    assert.equal(client.map.zoom, 20, "already-queued callbacks cannot reframe a stopped or cleared map");
  }
});
test("queued snapshots from a replaced trip cannot change state, report errors or resurrect a map", () => {
  const client = browser();
  const states = [], errors = [];
  const options = { map: () => client.map, onState: state => states.push(state), onError: error => errors.push(error) };
  client.mirror.bind("test", "OD-oldtrip", options);
  const stale = client.subscriptions[0];
  client.mirror.bind("test", "OD-newtrip", options);
  stale.next({ exists: true, data: () => ({ phase: "pending" }) });
  stale.error({ code: "permission-denied" });
  assert.equal(states.length, 0);
  assert.equal(errors.length, 0);
  assert.equal(client.frames.size, 0);
  client.publish({ phase: "pending" });
  assert.equal(states.length, 1);
});
test("awaiting driver location never renders a delivery route or fictional car and pickup resumes after one attachment", () => {
  const client = browser();
  client.mirror.bind("test", "OD-native1", { map: () => client.map });
  const state = { phase: "awaiting_location", phaseStartedAt: 1000,
    delivery: { polyline: encoded, durationSeconds: 100 } };
  client.publish(state);
  client.tick(100_000);
  assert.equal(client.markers.length, 0);
  assert.equal(client.lines.length, 0);
  assert.equal(client.frames.size, 0);
  client.publish({ ...state, phase: "pickup", pickupRoute: { polyline: encoded, durationSeconds: 100 } });
  assert.equal(client.markers.length, 1);
  client.publish(state);
  assert.equal(client.markers[0].map, null);
  assert.equal(client.lines[0].map, null);
  assert.equal(client.frames.size, 0);
});
