const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const flush = () => new Promise((resolve) => setImmediate(resolve));

function element(classes = "") {
  const tokens = new Set(classes.split(/\s+/).filter(Boolean));
  return {
    value: "", textContent: "", innerHTML: "", dataset: {}, listeners: new Map(),
    classList: {
      add: (...names) => names.forEach((name) => tokens.add(name)),
      remove: (...names) => names.forEach((name) => tokens.delete(name)),
      contains: (name) => tokens.has(name),
      toggle(name, force = !tokens.has(name)) {
        if (force) tokens.add(name);
        else tokens.delete(name);
      }
    },
    addEventListener(name, callback) {
      const callbacks = this.listeners.get(name) || [];
      callbacks.push(callback);
      this.listeners.set(name, callbacks);
    },
    emit(name, event = {}) {
      return Promise.all((this.listeners.get(name) || []).map((callback) => callback(event)));
    },
    setAttribute(name, value) { this[name] = value; }
  };
}

function roster(empty = false, phone = "+639171234567", profile = {}) {
  const docs = empty ? [] : [{
    id: profile.id || phone,
    data: () => ({ phone, name: "Test driver", plate: "TEST 001", model: "Test sedan", ...profile })
  }];
  return { empty, docs, size: docs.length, metadata: { fromCache: false, hasPendingWrites: false } };
}

function orderSnapshot(data) {
  const docs = data.map((order, index) => ({ id: `order-${index}`, data: () => order }));
  return { docs, size: docs.length, forEach: (callback) => docs.forEach(callback) };
}

function harness({ standalone = false, phone = "09171234567", authenticated = true } = {}) {
  const html = read(standalone ? "driver.html" : "index.html");
  const elements = new Map();
  const liveHtml = html.replace(/<template\b[^>]*>[\s\S]*?<\/template>/g, "");
  for (const match of liveHtml.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
    elements.set(match[1], element(match[0].match(/\bclass="([^"]*)"/)?.[1]));
  }
  const get = (id) => elements.get(id) || null;
  get("prefPhone").value = phone;
  const storage = new Map([["guest_phone", phone], ["user_role", "driver"]]);
  const queries = [];
  const orderListeners = [];
  const historyQueries = [];
  const writes = [];
  const warnings = [];
  const errors = [];
  const frames = [];
  const opened = [];
  const mapCalls = [];
  const body = element();
  const window = element();
  const db = {
    collection(name) {
      if (name === "drivers") {
        const query = {
          where(field, operator, value) {
            assert.equal(field, "phone");
            assert.equal(operator, "==");
            this.phone = value;
            return this;
          },
          limit(count) { assert.equal(count, 2); return this; },
          get(options) {
            assert.equal(options.source, "server");
            return new Promise((resolve, reject) => Object.assign(this, { resolve, reject }));
          },
          onSnapshot(options, next, error) {
            assert.equal(options.includeMetadataChanges, true);
            Object.assign(this, { next, error, active: true });
            return () => { this.active = false; };
          }
        };
        queries.push(query);
        return query;
      }
      assert.equal(name, "ride_orders");
      return {
        where(field, operator, value) {
          assert.ok(["driverId", "status"].includes(field));
          assert.equal(operator, "==");
          assert.ok(value === "+639171234567" || value === "pending" || value === "approved-real-id");
          return this;
        },
        limit() { return this; },
        get() {
          return new Promise((resolve, reject) => historyQueries.push({ resolve, reject }));
        },
        onSnapshot(next, error) {
          const listener = { next, error, active: true };
          orderListeners.push(listener);
          return () => { listener.active = false; };
        },
        doc(id) {
          return {
            set: async (data, options) => { writes.push({ id, data, options }); },
            update: async (data) => { writes.push({ id, data }); }
          };
        }
      };
    }
  };
  const passengerValidator = () => "passenger";
  window.location = { search: "" };
  const context = vm.createContext({
    window, document: { body, getElementById: get }, db, URLSearchParams,
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value)
    },
    console: { log() {}, warn: (...args) => warnings.push(args), error: (...args) => errors.push(args) },
    requestAnimationFrame: (callback) => frames.push(callback),
    navigator: { geolocation: { getCurrentPosition: callback => callback({ coords: { latitude: 0, longitude: 125 } }) } },
    setTimeout: () => 1, clearTimeout() {},
    firebase: { firestore: { FieldValue: { serverTimestamp: () => "timestamp" } } },
    isValidOrderId: passengerValidator,
    openOrderHistoryModal: () => { get("orderHistoryModal").classList.remove("hidden"); },
    mapInstance: {
      getCenter: () => "original-center",
      setCenter: (center) => mapCalls.push(["center", center])
    }
  });
  context.google = window.google = { maps: { event: { trigger: (_, event) => mapCalls.push([event]) } } };
  window.open = (...args) => opened.push(args);
  window.accountAuth = {
    isDriver: () => authenticated, isOnline: () => true,
    notifyDispatch: async () => {},
    api: async (action, data) => { writes.push({ action, data }); return data; }
  };
  vm.runInContext(read("js/driver.js"), context);
  assert.equal(context.isValidOrderId, passengerValidator, "Driver helpers must not replace passenger globals");
  vm.runInContext(read("js/app-mode.js"), context);
  return {
    window, body, get, queries, orderListeners, historyQueries, writes, warnings, errors, opened, mapCalls, storage,
    activeListeners: () => orderListeners.filter((listener) => listener.active).length,
    flushFrames() { while (frames.length) frames.shift()(); }
  };
}

async function authorize(h) {
  h.queries.at(-1).resolve(roster());
  await flush();
  assert.equal(h.window.isCurrentDriverAuthorized(), true);
}

test("unverified and non-roster phones cannot reveal or initialize the driver panel", async () => {
  const h = harness();
  assert.equal(h.get("btnSwitchMode").classList.contains("hidden"), true);
  h.window.toggleAppMode();
  h.window.driverApp.initialize();
  h.window.openDriverOrderHistory();
  assert.equal(h.orderListeners.length, 0);
  assert.equal(h.get("driverView").classList.contains("hidden"), true);
  assert.equal(h.get("driverOrderHistoryModal").classList.contains("hidden"), true);
  assert.equal(h.warnings[0][0], "Unauthorized access: Not a registered fleet driver.");
  h.queries[0].resolve(roster(true));
  await flush();
  assert.equal(h.window.isCurrentDriverAuthorized(), false);
  assert.equal(h.get("btnSwitchMode").classList.contains("hidden"), true);
});

test("verified-driver badge follows server verification and revocation without fleet success copy", async () => {
  const guest = harness({ authenticated: false });
  assert.equal(guest.get("verifiedDriverBadge").classList.contains("hidden"), true);
  assert.equal(guest.get("driverAccessStatus").classList.contains("hidden"), true);
  const h = harness();
  assert.equal(h.get("verifiedDriverBadge").classList.contains("hidden"), true);
  await authorize(h);
  assert.equal(h.get("verifiedDriverBadge").classList.contains("hidden"), false);
  assert.equal(h.get("driverAccessStatus").textContent, "");
  assert.equal(h.get("driverAccessStatus").classList.contains("hidden"), true);
  h.queries[0].next(roster(true));
  assert.equal(h.get("verifiedDriverBadge").classList.contains("hidden"), true);
  assert.equal(h.get("driverAccessStatus").classList.contains("hidden"), false);
  assert.match(h.get("driverAccessStatus").textContent, /no longer available/);
});

test("authorized switches preserve passenger state and attach only one listener per scoped driver query", async () => {
  const h = harness();
  await authorize(h);
  assert.equal(h.orderListeners.length, 0);
  assert.equal(h.get("btnSwitchMode").classList.contains("flex"), true);
  h.get("tripFloatingBubble").classList.remove("hidden");
  h.get("prefName").value = "Unchanged passenger profile";
  h.window.toggleAppMode();
  assert.equal(h.body.dataset.appMode, "driver");
  assert.equal(h.get("passengerView").classList.contains("hidden"), true);
  assert.equal(h.get("btnSwitchMode")["aria-label"], "Switch to Passenger Mode");
  h.window.driverApp.initialize();
  assert.equal(h.activeListeners(), 2);
  h.window.toggleAppMode();
  h.flushFrames();
  assert.equal(h.activeListeners(), 0);
  assert.equal(h.get("prefName").value, "Unchanged passenger profile");
  assert.equal(h.get("tripFloatingBubble").classList.contains("hidden"), false);
  assert.deepEqual(h.mapCalls.slice(-2), [["resize"], ["center", "original-center"]]);
  h.window.openAppOrderHistory();
  assert.equal(h.get("orderHistoryModal").classList.contains("hidden"), false);
  for (let i = 0; i < 3; i += 1) {
    h.window.toggleAppMode();
    assert.equal(h.activeListeners(), 2);
    h.window.toggleAppMode();
    assert.equal(h.activeListeners(), 0);
  }
  assert.equal(h.get("ordersContainer").listeners.get("click").length, 1);
  assert.equal(h.get("activeTripAction").listeners.get("click").length, 1);
  assert.equal(h.get("btnSwitchMode")["aria-label"], "Switch to Driver Mode");
  assert.equal(h.writes.length, 0);
});

test("phone changes revoke access immediately and ignore late order snapshots", async () => {
  const h = harness();
  await authorize(h);
  h.window.toggleAppMode();
  const staleListener = h.orderListeners[0];
  h.get("prefPhone").value = "09990000000";
  await h.get("prefPhone").emit("input");
  assert.equal(h.window.isCurrentDriverAuthorized(), false);
  assert.equal(h.get("driverView").classList.contains("hidden"), true);
  assert.equal(h.get("btnSwitchMode").classList.contains("hidden"), true);
  assert.equal(h.activeListeners(), 0);
  staleListener.next(orderSnapshot([{ status: "pending", pickup: "private address" }]));
  assert.equal(h.get("ordersContainer").innerHTML, "");
  await h.get("activeTripAction").emit("click");
  assert.equal(h.writes.length, 0);
});

test("late whitelist responses cannot authorize a different phone or supersede a newer denial", async () => {
  const h = harness();
  const initial = h.queries[0];
  h.get("prefPhone").value = "09990000000";
  const verification = h.window.checkDriverWhitelist("09990000000");
  h.queries[1].resolve(roster(true));
  assert.equal(await verification, false);
  initial.resolve(roster());
  await flush();
  assert.equal(h.window.isCurrentDriverAuthorized(), false);
  assert.equal(h.get("btnSwitchMode").classList.contains("hidden"), true);
  assert.equal(initial.active, undefined);
});

test("network failures, empty phones, and uncommitted roster writes fail closed", async () => {
  const h = harness();
  h.queries[0].reject(new Error("offline"));
  await flush();
  assert.equal(h.window.isCurrentDriverAuthorized(), false);
  assert.equal(h.errors.length, 1);
  const pending = h.window.checkDriverWhitelist();
  h.queries[1].resolve({ ...roster(), metadata: { hasPendingWrites: true } });
  assert.equal(await pending, false);
  h.get("prefPhone").value = "";
  assert.equal(await h.window.checkDriverWhitelist(), false);
  assert.equal(h.queries.length, 2);
  assert.equal(h.orderListeners.length, 0);
});

test("live roster removal and listener errors revoke access and stop order reads", async () => {
  for (const failure of ["removed", "error"]) {
    const h = harness();
    await authorize(h);
    h.window.toggleAppMode();
    if (failure === "removed") h.queries[0].next(roster(true));
    else h.queries[0].error(new Error("permission-denied"));
    assert.equal(h.window.isCurrentDriverAuthorized(), false);
    assert.equal(h.get("btnSwitchMode").classList.contains("hidden"), true);
    assert.equal(h.body.dataset.appMode, "passenger");
    assert.equal(h.activeListeners(), 0);
    assert.equal(h.queries[0].active, false);
  }
});

test("profile save revalidates and cross-tab profile edits revoke the previous authorization", async () => {
  const h = harness();
  await authorize(h);
  h.get("prefPhone").value = "09990000000";
  const save = h.window.emit("vipprofilechange");
  assert.equal(h.window.isCurrentDriverAuthorized(), false);
  h.queries[1].resolve(roster(false, "+639990000000"));
  await save;
  assert.equal(h.window.isCurrentDriverAuthorized(), true);
  await h.window.emit("storage", { key: "guest_phone" });
  assert.equal(h.window.isCurrentDriverAuthorized(), false);
  assert.equal(h.get("btnSwitchMode").classList.contains("hidden"), true);
});

test("driver history uses its own drawer and stale history results cannot populate a stopped panel", async () => {
  const h = harness();
  await authorize(h);
  h.window.toggleAppMode();
  h.window.openAppOrderHistory();
  assert.equal(h.get("driverOrderHistoryModal").classList.contains("hidden"), false);
  assert.equal(h.get("orderHistoryModal").classList.contains("hidden"), true);
  h.historyQueries[0].resolve(orderSnapshot([{
    driverPhone: "+639171234567", status: "completed", origin: "History pickup", destination: "History drop-off"
  }]));
  await flush();
  assert.match(h.get("driverOrderHistoryList").innerHTML, /History pickup/);
  h.window.openAppOrderHistory();
  h.window.toggleAppMode();
  h.historyQueries[1].resolve(orderSnapshot([{ driverPhone: "+639171234567", origin: "Stale address" }]));
  await flush();
  assert.equal(h.get("driverOrderHistoryModal").classList.contains("hidden"), true);
  assert.equal(h.get("driverOrderHistoryList").innerHTML, "");
});

test("cached roster snapshots cannot revoke or grant access before server confirmation", async () => {
  const h = harness();
  await authorize(h);
  h.queries[0].next({ ...roster(true), metadata: { fromCache: true, hasPendingWrites: false } });
  assert.equal(h.window.isCurrentDriverAuthorized(), true);
  h.queries[0].next(roster(true));
  assert.equal(h.window.isCurrentDriverAuthorized(), false);
  h.queries[0].next(roster());
  assert.equal(h.window.isCurrentDriverAuthorized(), false);
});

test("standalone driver page uses the same whitelist and cannot bypass the index guard", async () => {
  const denied = harness({ standalone: true });
  denied.window.driverApp.initialize();
  denied.queries[0].resolve(roster(true));
  await flush();
  assert.equal(denied.get("driverView").classList.contains("hidden"), true);
  assert.equal(denied.orderListeners.length, 0);
  const allowed = harness({ standalone: true });
  await authorize(allowed);
  assert.equal(allowed.get("driverView").classList.contains("hidden"), false);
  assert.equal(allowed.get("driverAccessPanel").classList.contains("hidden"), true);
  assert.equal(allowed.activeListeners(), 2);
});

test("Start Trip preserves navigation, blank destination handling, and existing status writes", async () => {
  for (const destination of ["Davao City & Airport", ""]) {
    const h = harness();
    await authorize(h);
    h.window.toggleAppMode();
    h.get("activeTripVehicle").textContent = "Passenger vehicle";
    h.orderListeners[0].next(orderSnapshot([{
      status: "arrived", destination, driverId: "+639171234567", vehicleType: "Driver vehicle"
    }]));
    assert.equal(h.get("activeTripVehicle").textContent, "Passenger vehicle");
    assert.equal(h.get("driverActiveTripVehicle").textContent, "Driver vehicle");
    await h.get("activeTripAction").emit("click");
    assert.equal(h.writes.length, 1);
    assert.equal(h.writes[0].data.status, "in_progress");
    assert.equal(h.writes[0].action, "advanceTrip");
    assert.equal(h.opened.length, destination ? 1 : 0);
    if (destination) {
      assert.deepEqual(h.opened[0], [
        `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}`, "_blank"
      ]);
    }
  }
});

test("a phase snapshot arriving before its HTTP response cannot leave the next trip action disabled", async () => {
  const h = harness();
  await authorize(h);
  h.window.toggleAppMode();
  const order = { status: "accepted", driverId: "+639171234567" };
  h.orderListeners[0].next(orderSnapshot([order]));
  let finish;
  h.window.accountAuth.api = () => new Promise(resolve => { finish = resolve; });
  const pending = h.get("activeTripAction").emit("click");
  h.orderListeners[0].next(orderSnapshot([{ ...order, status: "arrived" }]));
  assert.equal(h.get("activeTripAction").disabled, true);
  finish({ status: "arrived" });
  await pending;
  assert.equal(h.get("activeTripAction").disabled, false);
  assert.equal(h.get("activeTripAction").textContent, "Passenger on board / Start Trip");
});

test("view markup, shared assets, and protected passenger controls remain wired", () => {
  const index = read("index.html");
  const driver = read("driver.html");
  for (const html of [index, driver]) {
    const liveHtml = html.replace(/<template\b[^>]*>[\s\S]*?<\/template>/g, "");
    const ids = [...liveHtml.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(new Set(ids).size, ids.length, "IDs must be unique");
    assert.match(html, /<main id="driverView" class="hidden /);
    for (const match of html.matchAll(/<script[^>]+src="(js\/[^"]+)"/g)) {
      assert.equal(fs.existsSync(path.join(root, match[1])), true);
    }
    assert.ok(html.indexOf('src="js/driver.js"') < html.indexOf('src="js/app-mode.js"'));
  }
  assert.equal(
    index.match(/<main id="driverView"[^>]*>([\s\S]*?)<\/main>/)[1],
    driver.match(/<main id="driverView"[^>]*>([\s\S]*?)<\/main>/)[1]
  );
  assert.match(index, /id="btnSwitchMode"[^>]+class="hidden /);
  for (const name of [
    "cancelAndReset", "timeoutStage1Card", "timeoutStage2Card", "shareLiveTripStatus",
    "mainSavedPlacesChips", "locationPickerModal"
  ]) assert.ok(index.includes(name), `${name} must remain available`);
  assert.match(read("sw.js"), /'\.\/js\/app-mode\.js'/);
  assert.match(read("js/profile.js"), /dispatchEvent\(new Event\('vipprofilechange'\)\)/);
  assert.doesNotMatch(read("js/app-mode.js"), /\.focus\(/);
});

test("registration queries normalize local phone formats and require complete unique profiles", async () => {
  const h = harness({ phone: "0917-123-4567" });
  assert.equal(h.queries[0].phone, "+639171234567");
  await authorize(h);
  for (const phone of ["09171234567", "9171234567", "639171234567", "+63 (917) 123 4567"]) {
    assert.equal(h.window.normalizeFleetPhone(phone), "+639171234567");
  }
  assert.equal(h.window.normalizeFleetPhone("not a phone"), "");
  const check = h.window.checkDriverWhitelist();
  h.queries.at(-1).resolve(roster(false, "+639171234567", { plate: "" }));
  assert.equal(await check, false);
  assert.equal(h.window.getCurrentDriverProfile(), null);
  assert.equal(h.storage.get("user_role"), "customer");
  const duplicate = h.window.checkDriverWhitelist();
  const result = roster();
  result.docs.push(result.docs[0]);
  result.size = 2;
  h.queries.at(-1).resolve(result);
  assert.equal(await duplicate, false);
});

test("claims send only one GPS fix and the order ID; identity is resolved by the authenticated backend", async () => {
  const h = harness();
  h.queries[0].resolve(roster(false, "+639171234567", {
    id: "approved-real-id", name: "Roster driver", model: "Roster SUV", plate: "ROSTER 5"
  }));
  await flush();
  h.window.toggleAppMode();
  const claim = async id => {
    const button = { dataset: { orderId: id } };
    await h.get("ordersContainer").emit("click", { target: {
      closest: selector => selector === ".claim-order" ? button : null
    } });
    await flush();
  };
  await claim("real-order");
  const saved = h.writes[0].data;
  assert.equal(h.writes[0].action, "claimOrder");
  assert.deepEqual(JSON.parse(JSON.stringify(saved)), { orderId: "real-order", location: { lat: 0, lng: 125 } });
  assert.equal(h.window.getCurrentDriverProfile().name, "Roster driver");
  h.queries[0].next(roster(false, "+639171234567", { id: "approved-real-id", name: "Updated roster name" }));
  await claim("next-order");
  assert.equal(h.window.getCurrentDriverProfile().name, "Updated roster name");
  assert.equal(h.writes[1].data.driverName, undefined);
  h.orderListeners[0].next(orderSnapshot([{
    driverId: "unrelated-id", driverName: "Updated roster name", driverPhone: "+639999999999", status: "arrived"
  }]));
  assert.equal(h.get("activeTripContainer").classList.contains("hidden"), true, "Same display name does not prove ownership");
});
