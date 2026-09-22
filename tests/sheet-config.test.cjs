const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const read = (name) => fs.readFileSync(path.join(__dirname, "..", name), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));

const rateHeaders = ["Service_ID", "Service_Name", "Base_Fare", "Base_Km", "Per_Km_Rate",
  "Surge_Multiplier", "Flat_Surge_Fee", "Convenience_Fee", "Commission_Type", "Commission_Value"];
const driverHeaders = ["Driver_Name", "Telegram_Username", "Telegram_ID", "Phone_Number",
  "Plate_Number", "Vehicle_Model", "WhatsApp", "Viber"];
const rateRow = ["RIDE_MOTO", "Moto Express", 40, 2, 10, 1.5, 20, 30, "PERCENT", 0.15];
const driverRow = ["Approved Driver", "@approved", "12345", "0917-123-4567", "TEST 001", "Sedan", "", ""];
const rule = { nameEn: "Moto Express", base: 40, baseKm: 2, perKm: 10,
  surgeMultiplier: 1.5, surgeFlat: 20, convenienceFee: 30, commType: "PERCENT", commVal: 0.15 };

function gasHarness() {
  const data = {
    Rate_Config: [rateHeaders.slice(), rateRow.slice()],
    Drivers_Master: [driverHeaders.slice(), driverRow.slice()]
  };
  const properties = new Map([
    ["SHEET_SYNC_SPREADSHEET_ID", "test-sheet"],
    ["SHEET_SYNC_FIREBASE_PROJECT_ID", "test-project"]
  ]);
  const root = "projects/test-project/databases/(default)/documents";
  const requests = [];
  const triggers = [];
  const deletedTriggers = [];
  const state = { released: 0, listPages: [[]], httpStatus: 200 };
  const spreadsheet = {
    getSheetByName: name => data[name] ? { getDataRange: () => ({ getValues: () => data[name] }) } : null
  };
  const h = {
    data, properties, root, requests, triggers, deletedTriggers, state, spreadsheet,
    writes: () => requests.filter(request => request.method === "post").flatMap(request => request.payload.writes)
  };
  h.context = vm.createContext({
    SpreadsheetApp: { openById: id => { assert.equal(id, "test-sheet"); return spreadsheet; } },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: key => properties.get(key), setProperty: (key, value) => properties.set(key, value),
      deleteProperty: key => properties.delete(key)
    }) },
    LockService: { getScriptLock: () => ({ waitLock: ms => assert.equal(ms, 30000), releaseLock: () => state.released++ }) },
    Utilities: { formatDate: (_, zone) => { assert.equal(zone, "Asia/Manila"); return "2026-09-21T13:00:00+08:00"; } },
    console: { log() {}, error() {} },
    ScriptApp: {
      getOAuthToken: () => "mock-admin-token",
      getProjectTriggers: () => [
        { getHandlerFunction: () => "onSheetConfigurationEdit" },
        { getHandlerFunction: () => "otherBusinessHandler" }
      ],
      deleteTrigger: trigger => deletedTriggers.push(trigger.getHandlerFunction()),
      newTrigger(name) {
        const trigger = { name };
        const builder = {
          forSpreadsheet(id) { trigger.spreadsheet = id; return builder; },
          onEdit() { trigger.event = "edit"; return builder; },
          onChange() { trigger.event = "change"; return builder; },
          timeBased() { return builder; },
          everyMinutes(minutes) { trigger.minutes = minutes; return builder; },
          create() { triggers.push(trigger); }
        };
        return builder;
      }
    },
    UrlFetchApp: {
      fetch(url, options) {
        assert.equal(options.headers.Authorization, "Bearer mock-admin-token");
        const payload = options.payload ? JSON.parse(options.payload) : null;
        requests.push({ url, method: options.method, payload });
        let response = {};
        if (options.method === "get") {
          const secondPage = url.includes("pageToken=");
          response = { documents: state.listPages[secondPage ? 1 : 0] || [] };
          if (!secondPage && state.listPages.length > 1) response.nextPageToken = "next page";
        }
        return {
          getResponseCode: () => state.httpStatus,
          getContentText: () => JSON.stringify(state.httpStatus === 200 ? response : { error: "permission denied" })
        };
      }
    }
  });
  vm.runInContext(read("gas/SheetSync.gs"), h.context);
  return h;
}

function nodeElement() {
  const classes = new Set();
  return {
    value: "", textContent: "", innerText: "", disabled: false,
    classList: {
      add: (...values) => values.forEach(value => classes.add(value)),
      remove: (...values) => values.forEach(value => classes.delete(value)),
      toggle: (value, enabled) => enabled ? classes.add(value) : classes.delete(value),
      contains: value => classes.has(value)
    }
  };
}

function ratesHarness() {
  const nodes = new Map();
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, nodeElement());
    return nodes.get(id);
  };
  get("distance").value = "5";
  get("priorityTip").value = "0";
  get("pickupLoc").value = "Pickup";
  get("dropoffLoc").value = "Drop-off";
  const listeners = [];
  const events = {};
  const writes = [];
  const errors = [];
  const context = vm.createContext({
    document: { getElementById: get },
    navigator: { onLine: true },
    window: {
      addEventListener: (name, callback) => { events[name] = callback; },
      accountAuth: {
        requireSession: () => ({ phone: "+639171111111", role: "customer" }),
        api: async (action, data) => {
          assert.equal(action, "createOrder");
          writes.push({ id: data.orderId, data: plain(data) });
          return data;
        }
      }
    },
    console: { log() {}, warn() {}, error: (...args) => errors.push(args) },
    firebase: { firestore: { FieldValue: { serverTimestamp: () => "timestamp" } } },
    currentUserProfile: { name: "Test guest", phone: "09171111111" },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    crypto: require("node:crypto").webcrypto,
    mobilityPickupCoord: null, mobilityDropoffCoord: null,
    GAS_WEBHOOK_URL: "https://example.invalid/test",
    fetch: async () => ({}),
    db: {
      collection(collection) {
        return {
          doc(id) {
            return {
              onSnapshot(options, next, error) {
                assert.equal(collection, "rate_config");
                assert.equal(id, "current");
                assert.equal(options.includeMetadataChanges, true);
                const listener = { next, error, active: true };
                listeners.push(listener);
                return () => { listener.active = false; };
              },
              async set(data) {
                assert.equal(collection, "ride_orders");
                writes.push({ id, data: plain(data) });
              }
            };
          }
        };
      }
    }
  });
  vm.runInContext(read("functions/pricing.js"), context);
  vm.runInContext(read("js/rates.js"), context);
  const h = {
    context, get, events, listeners, writes, errors,
    emit(rates = { RIDE_MOTO: rule }, metadata = {}) {
      listeners.at(-1).next({
        exists: rates !== null, data: () => ({ rates }),
        metadata: { fromCache: false, hasPendingWrites: false, ...metadata }
      });
    },
    loadOrders() {
      const source = read("js/order.js");
      vm.runInContext(source.slice(0, source.indexOf("// 系統初始化")), context);
      context.renderPendingOrderView = () => {};
      context.startDispatchTimeoutChecker = () => {};
      context.subscribeToOrder = () => {};
    }
  };
  return h;
}

test("GAS reads exact headers, includes all surge/convenience fields, and normalizes approved phones", () => {
  const h = gasHarness();
  assert.deepEqual(plain(h.context.sheetSyncReadRates_(h.spreadsheet)), { RIDE_MOTO: rule });
  const driver = plain(h.context.sheetSyncReadDrivers_(h.spreadsheet))["+639171234567"];
  assert.equal(driver.name, "Approved Driver");
  assert.equal(driver.phone, "+639171234567");
  assert.equal(driver.whatsapp, driver.phone);
  assert.equal(driver.telegramUsername, "approved");
  for (const phone of ["0917-123-4567", "9171234567", "+63 (917) 123 4567", "639171234567"]) {
    assert.equal(h.context.sheetSyncPhone_(phone), "+639171234567");
  }
  assert.throws(() => h.context.sheetSyncPhone_("123"), /Invalid fleet phone/);
  // Columns may move, but labels must never be renamed.
  h.data.Rate_Config = h.data.Rate_Config.map(row => row.slice().reverse());
  assert.deepEqual(plain(h.context.sheetSyncReadRates_(h.spreadsheet)), { RIDE_MOTO: rule });
});

test("GAS validates all source rows before writing and does not invent missing services", () => {
  for (const mutate of [
    h => { h.data.Rate_Config[0][2] = "Renamed_Base"; },
    h => { h.data.Rate_Config[1][5] = ""; },
    h => { h.data.Rate_Config[1][6] = -20; },
    h => { h.data.Rate_Config[1][9] = 15; },
    h => { h.data.Rate_Config.push(rateRow.slice()); },
    h => { h.data.Drivers_Master.push(driverRow.slice()); },
    h => { h.data.Drivers_Master[1][4] = ""; },
    h => { delete h.data.Drivers_Master; }
  ]) {
    const h = gasHarness();
    mutate(h);
    assert.throws(() => h.context.syncSheetConfiguration());
    assert.equal(h.requests.length, 0);
    assert.ok(h.properties.get("SHEET_SYNC_LAST_ERROR"));
    assert.equal(h.state.released, 1);
  }
  const h = gasHarness();
  assert.equal(h.context.sheetSyncReadRates_(h.spreadsheet).RIDE_SUV, undefined);
});

test("GAS atomically mirrors approved registrations, removes revoked docs, and never touches orders", () => {
  const h = gasHarness();
  h.state.listPages = [
    [{ name: h.root + "/drivers/old-driver", updateTime: "old-time" }],
    [{ name: h.root + "/drivers/+639171234567", updateTime: "existing-time", fields: {} }]
  ];
  h.context.syncSheetConfiguration();
  assert.equal(h.requests.filter(request => request.method === "post").length, 1);
  const writes = h.writes();
  assert.equal(writes.length, 3);
  assert.deepEqual(writes[0].currentDocument, { updateTime: "existing-time" });
  assert.equal(writes[0].update.fields.phone.stringValue, "+639171234567");
  assert.deepEqual(writes[1], { delete: h.root + "/drivers/old-driver", currentDocument: { updateTime: "old-time" } });
  assert.equal(writes[2].update.name, h.root + "/rate_config/current");
  assert.equal(writes[2].update.fields.rates.mapValue.fields.RIDE_MOTO.mapValue.fields.convenienceFee.doubleValue, 30);
  assert.ok(h.properties.get("SHEET_SYNC_LAST_SUCCESS"));
  assert.equal(h.properties.has("SHEET_SYNC_LAST_ERROR"), false);
  assert.ok(h.requests.every(request => !request.url.includes("ride_orders")));
  assert.ok(h.requests[1].url.includes("pageToken=next%20page"));
});

test("empty sheets publish empty mirrors and unchanged drivers avoid repeated writes", () => {
  const h = gasHarness();
  const profile = h.context.sheetSyncReadDrivers_(h.spreadsheet)["+639171234567"];
  h.state.listPages = [[{
    name: h.root + "/drivers/+639171234567", updateTime: "time",
    fields: plain(h.context.sheetSyncValue_(profile).mapValue.fields)
  }]];
  h.context.syncSheetConfiguration();
  assert.equal(h.writes().length, 1);
  h.requests.length = 0;
  h.data.Rate_Config = [rateHeaders];
  h.data.Drivers_Master = [driverHeaders];
  h.context.syncSheetConfiguration();
  assert.equal(h.writes()[0].delete, h.root + "/drivers/+639171234567");
  assert.deepEqual(h.writes()[1].update.fields.rates.mapValue.fields, {});
});

test("HTTP errors and oversized commits fail explicitly without partial publications", () => {
  const h = gasHarness();
  h.state.httpStatus = 403;
  assert.throws(() => h.context.syncSheetConfiguration(), /HTTP 403/);
  assert.equal(h.writes().length, 0);
  assert.equal(h.properties.has("SHEET_SYNC_LAST_SUCCESS"), false);
  h.state.httpStatus = 200;
  h.state.listPages = [Array.from({ length: 500 }, (_, i) => ({
    name: h.root + "/drivers/old-" + i, updateTime: "time"
  }))];
  assert.throws(() => h.context.syncSheetConfiguration(), /500 atomic writes/);
  assert.equal(h.writes().length, 0);
});

test("trigger installation preserves unrelated handlers and covers edits, row deletion and reconciliation", () => {
  const h = gasHarness();
  h.context.installSheetConfigurationTriggers();
  assert.deepEqual(h.deletedTriggers, ["onSheetConfigurationEdit"]);
  assert.deepEqual(h.triggers.map(trigger => trigger.name), [
    "onSheetConfigurationEdit", "onSheetConfigurationChange", "syncSheetConfiguration"
  ]);
  assert.equal(h.triggers[2].minutes, 1);
  h.requests.length = 0;
  h.context.onSheetConfigurationEdit({ range: { getSheet: () => ({ getName: () => "Orders_Master" }) } });
  assert.equal(h.requests.length, 0);
  h.context.onSheetConfigurationChange({ changeType: "REMOVE_ROW" });
  assert.equal(h.writes().length, 2);
});

test("pricing preserves included kilometers, fixed platform fee and driver-only surge revenue", () => {
  const h = ratesHarness();
  const quote = h.context.calculateFare(rule, 5, 100, 20);
  assert.deepEqual(plain(quote), { total: 275, driverPayout: 234.5, convenienceFee: 30, commission: 10.5, tripFare: 125 });
  assert.equal(h.context.calculateFare(rule, 1, 0, 0).total, 110);
  assert.equal(h.context.calculateFare(rule, 2, 0, 0).total, 110);
  const normal = h.context.calculateFare({ ...rule, surgeMultiplier: 1, surgeFlat: 0 }, 5, 0, 0);
  const surge = h.context.calculateFare(rule, 5, 0, 0);
  assert.equal(surge.total - normal.total, surge.driverPayout - normal.driverPayout);
  assert.equal(surge.commission, normal.commission);
  assert.equal(surge.convenienceFee, normal.convenienceFee);
  assert.equal(h.context.calculateFare({ ...rule, commType: "FIXED", commVal: 15 }, 5, 0, 0).driverPayout, 110);
  assert.throws(() => h.context.calculateFare(rule, -1, 0, 0));
  assert.throws(() => h.context.calculateFare({ ...rule, convenienceFee: undefined }, 5, 0, 0));
});

test("only server-confirmed prices allow quotes; updates and service removal immediately change estimates", () => {
  const h = ratesHarness();
  assert.equal(h.context.calculateEstimate(), null);
  h.context.startRatesListener();
  h.context.startRatesListener();
  assert.equal(h.listeners.length, 1);
  h.emit(undefined, { fromCache: true });
  assert.equal(h.context.calculateEstimate(), null);
  h.emit();
  assert.equal(h.get("estTotal").innerText, "155.00");
  assert.equal(h.get("estConvenienceFee").textContent, "\u20b130.00");
  h.emit({ RIDE_MOTO: { ...rule, surgeMultiplier: 2, convenienceFee: 45 } });
  assert.equal(h.get("estTotal").innerText, "205.00");
  h.emit({});
  assert.equal(h.context.calculateEstimate(), null);
  assert.equal(h.get("estTotal").innerText, "--");
  assert.equal(h.get("badge-RIDE_SUV").innerText, "Price unavailable");
  h.emit({ RIDE_MOTO: { ...rule, surgeMultiplier: "2" } });
  assert.equal(h.context.calculateEstimate(), null);
  assert.match(h.get("rateStatus").textContent, /unavailable/);
});

test("offline, pending local writes and listener errors cannot authorize bookings; reconnect reattaches once", () => {
  const h = ratesHarness();
  h.context.startRatesListener();
  h.emit();
  h.events.offline();
  assert.equal(h.context.calculateEstimate(), null);
  h.events.online();
  assert.equal(h.listeners.filter(listener => listener.active).length, 1);
  h.emit(undefined, { hasPendingWrites: true });
  assert.equal(h.context.calculateEstimate(), null);
  h.listeners.at(-1).error(new Error("permission denied"));
  assert.equal(h.listeners.filter(listener => listener.active).length, 0);
  assert.match(h.get("rateStatus").textContent, /retry online/);
  h.context.startRatesListener();
  h.emit();
  assert.equal(h.context.calculateEstimate().total, 155);
  h.listeners[0].next({
    exists: true, data: () => ({ rates: { RIDE_MOTO: { ...rule, base: 999 } } }),
    metadata: { fromCache: false, hasPendingWrites: false }
  });
  assert.equal(h.context.calculateEstimate().total, 155, "Stale listeners must not overwrite current rates");
});

test("new orders use validated prices rather than edited DOM totals; published changes never reprice saved orders", async () => {
  const h = ratesHarness();
  h.loadOrders();
  await h.context.requestOrder();
  assert.equal(h.writes.length, 0);
  h.context.startRatesListener();
  h.emit();
  h.get("estTotal").innerText = "1";
  await h.context.requestOrder();
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].data.totalPay, 155);
  assert.equal(h.writes[0].data.status, "pending");
  assert.equal(h.writes[0].data.convenienceFee, undefined, "Order schema must stay unchanged");
  const saved = plain(h.writes[0]);
  h.emit({ RIDE_MOTO: { ...rule, surgeMultiplier: 3 } });
  assert.deepEqual(h.writes, [saved]);
  assert.equal(h.get("estTotal").innerText, "260.00");
});

test("changed backend quote preserves locations for confirmation and never exposes an uncreated cancellable trip", async () => {
  const h = ratesHarness();
  h.loadOrders();
  h.context.startRatesListener();
  h.emit();
  let pendingRenders = 0;
  h.context.renderPendingOrderView = () => { pendingRenders++; };
  h.context.window.accountAuth.api = async () => {
    throw Object.assign(new Error("Review the updated fare."), { code: "PRICE_CHANGED", distance: 6 });
  };
  await h.context.requestOrder();
  assert.equal(h.get("pickupLoc").value, "Pickup");
  assert.equal(h.get("dropoffLoc").value, "Drop-off");
  assert.equal(h.get("estTotal").innerText, "170.00");
  assert.equal(h.get("btnSubmit").disabled, false);
  assert.equal(vm.runInContext("currentOrderId", h.context), null);
  assert.equal(pendingRenders, 0);
});
test("an in-flight booking blocks duplicates even if another UI update re-enables the submit button", async () => {
  const h = ratesHarness();
  h.loadOrders();
  h.context.startRatesListener();
  h.emit();
  let finish, calls = 0;
  h.context.window.accountAuth.api = (action, payload) => {
    calls++;
    return new Promise(resolve => { finish = () => resolve(payload); });
  };
  const booking = h.context.requestOrder();
  h.get("btnSubmit").disabled = false;
  await h.context.requestOrder();
  assert.equal(calls, 1);
  finish();
  await booking;
  assert.equal(h.get("btnSubmit").disabled, false);
});
