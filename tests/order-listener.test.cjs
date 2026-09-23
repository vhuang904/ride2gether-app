const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function harness() {
  const listeners = [], renders = [], errors = [], nodes = new Map(), timers = new Map();
  let timerId = 0, getResult = Promise.resolve({ exists: false }), startupFailure = false;
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { textContent: "", classList: { add() {}, remove() {} } });
    return nodes.get(id);
  };
  const context = vm.createContext({
    currentOrderId: "OD-first01", unsubscribeOrder: null,
    document: { getElementById: node },
    window: {},
    console: { warn() {}, error: (...args) => errors.push(args) },
    setTimeout(callback, delay) { timers.set(++timerId, { callback, delay }); return timerId; },
    setInterval(callback, delay) { timers.set(++timerId, { callback, delay, interval: true }); return timerId; },
    clearTimeout: id => timers.delete(id), clearInterval: id => timers.delete(id),
    db: { collection: () => ({ doc: id => ({
      get: () => getResult,
      onSnapshot(next, error) {
        if (startupFailure) throw new Error("Listener startup failed");
        const listener = { id, next, error, active: true };
        listeners.push(listener);
        return () => { listener.active = false; };
      }
    }) }) }
  });
  const source = fs.readFileSync(path.join(__dirname, "../js/order.js"), "utf8");
  vm.runInContext(source.slice(0, source.indexOf("// 系統初始化")), context);
  context.renderPendingOrderView = id => renders.push({ status: "pending", id });
  context.renderNativeTripView = (status, data) => renders.push({ status, data });
  context.showTimeoutStage1UI = () => renders.push({ status: "timeout" });
  const h = {
    context, listeners, renders, errors, timers, node,
    emit(status, listener = listeners.at(-1)) {
      listener.next({ exists: true, data: () => ({ status, driverName: "Fleet Driver", driverPlate: "ABC 123" }) });
    },
    runTimer() {
      const [id, timer] = [...timers][0];
      if (!timer.interval) timers.delete(id);
      timer.callback();
      return timer.delay;
    },
    getResult(value) { getResult = value; },
    failStartup(value) { startupFailure = value; }
  };
  return h;
}

test("pending acceptance renders driver details immediately and cancels the dispatch timeout", () => {
  const h = harness();
  h.context.subscribeToOrder("OD-first01");
  h.emit("PENDING");
  vm.runInContext("dispatchStartTime = Date.now(); startDispatchTimeoutChecker();", h.context);
  assert.equal(h.timers.size, 1);
  h.emit("ACCEPTED");
  assert.equal(h.renders.at(-1).status, "accepted");
  assert.equal(h.renders.at(-1).data.driverName, "Fleet Driver");
  assert.equal(h.timers.size, 0);
  assert.equal(h.listeners[0].active, true);
});

test("failed order listeners reconnect with bounded backoff and clear the visible error on recovery", () => {
  const h = harness();
  h.context.subscribeToOrder("OD-first01");
  for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    const old = h.listeners.at(-1);
    old.error(new Error("Connection failed"));
    assert.match(h.node("orderValidationError").textContent, /Reconnecting automatically/);
    assert.equal(old.active, false);
    old.error(new Error("Late duplicate error"));
    h.emit("accepted", old);
    assert.equal(h.renders.length, 0);
    assert.equal(h.timers.size, 1);
    assert.equal(h.runTimer(), delay);
  }
  h.emit("accepted");
  assert.equal(h.renders.length, 1);
  assert.equal(h.node("orderValidationError").textContent, "");
  h.listeners.at(-1).error(new Error("Another outage"));
  assert.equal(h.runTimer(), 1000);
});

test("replaced and stopped subscriptions cannot render or reconnect an obsolete order", () => {
  const h = harness();
  h.context.subscribeToOrder("OD-first01");
  const first = h.listeners[0];
  first.error(new Error("Disconnected"));
  h.context.currentOrderId = "OD-second1";
  h.context.subscribeToOrder("OD-second1");
  assert.equal(h.timers.size, 0);
  h.emit("accepted", first);
  first.error(new Error("Stale error"));
  assert.equal(h.renders.length, 0);
  h.emit("pending");
  assert.equal(h.renders.at(-1).id, "OD-second1");
  h.context.unsubscribeOrder();
  h.emit("accepted");
  h.listeners.at(-1).error(new Error("After sign-out"));
  assert.equal(h.renders.length, 1);
  assert.equal(h.timers.size, 0);
});

test("listener startup errors recover and an already-running timeout cannot overwrite acceptance", async () => {
  const h = harness();
  h.failStartup(true);
  h.context.subscribeToOrder("OD-first01");
  assert.match(h.node("orderValidationError").textContent, /Reconnecting/);
  h.failStartup(false);
  h.runTimer();
  let resolve;
  h.getResult(new Promise(done => { resolve = done; }));
  vm.runInContext("dispatchStartTime = Date.now() - STAGE_DURATION_MS; startDispatchTimeoutChecker();", h.context);
  h.runTimer();
  h.emit("accepted");
  resolve({ exists: true, data: () => ({ status: "pending" }) });
  await new Promise(done => setImmediate(done));
  assert.deepEqual(h.renders.map(render => render.status), ["accepted"]);

  let reject;
  h.getResult(new Promise((_, fail) => { reject = fail; }));
  vm.runInContext("dispatchStartTime = Date.now() - STAGE_DURATION_MS; startDispatchTimeoutChecker();", h.context);
  h.runTimer();
  h.context.currentOrderId = "OD-second1";
  vm.runInContext("dispatchStartTime = Date.now(); startDispatchTimeoutChecker();", h.context);
  reject(new Error("Obsolete timeout read failed"));
  await new Promise(done => setImmediate(done));
  assert.deepEqual(h.renders.map(render => render.status), ["accepted"]);
});
