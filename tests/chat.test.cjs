const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const read = (name) => fs.readFileSync(path.join(__dirname, "..", name), "utf8");
const flush = () => new Promise((resolve) => setImmediate(resolve));

function element(classes = "") {
  const tokens = new Set(classes.split(/\s+/).filter(Boolean));
  return {
    className: "", children: [], textContent: "", value: "", disabled: false,
    dataset: {}, style: {}, listeners: new Map(), scrollTop: 0, scrollHeight: 500, clientHeight: 400,
    classList: {
      add: (...names) => names.forEach((name) => tokens.add(name)),
      remove: (...names) => names.forEach((name) => tokens.delete(name)),
      contains: (name) => tokens.has(name),
      toggle(name, enabled) {
        if (enabled) tokens.add(name);
        else tokens.delete(name);
      }
    },
    get childElementCount() { return this.children.length; },
    appendChild(child) { this.children.push(child); },
    replaceChildren(...children) {
      this.children = children.flatMap((child) => child.fragment ? child.children : [child]);
    },
    addEventListener(name, callback) {
      const callbacks = this.listeners.get(name) || [];
      callbacks.push(callback);
      this.listeners.set(name, callbacks);
    },
    async emit(name, event = {}) {
      for (const callback of this.listeners.get(name) || []) await callback(event);
    },
    querySelector() { return null; }
  };
}

function backend() {
  const chats = new Map();
  const listeners = [];
  const parentListeners = [];
  const driverListeners = [];
  const writes = [];
  const orderSnapshot = (orders) => {
    const docs = orders.map((order) => ({ id: order.id, data: () => order }));
    return { docs, size: docs.length, forEach: (callback) => docs.forEach(callback) };
  };
  const snapshot = (id) => ({
    forEach: (callback) => (chats.get(id) || []).forEach((data, index) => callback({
      id: `message-${index}`, data: () => data
    }))
  });
  const api = {
    listeners, parentListeners, driverListeners, writes, orderSnapshot,
    writeError: null, listenerError: null, holdWrite: false, pendingWrite: null,
    active: () => listeners.filter((listener) => listener.active),
    publish(id, data) {
      chats.set(id, data);
      listeners.filter((listener) => listener.active && listener.id === id)
        .forEach((listener) => listener.next(snapshot(id)));
    },
    db: {
      collection(name) {
        assert.equal(name, "ride_orders", "Chat must never modify another collection");
        return {
          where() { return this; },
          onSnapshot(next, error) {
            const listener = { next, error, active: true };
            driverListeners.push(listener);
            return () => { listener.active = false; };
          },
          doc(id) {
            assert.ok(id && id !== "Generating...");
            return {
              onSnapshot(next, error) {
                const listener = { id, next, error, active: true };
                parentListeners.push(listener);
                return () => { listener.active = false; };
              },
              collection(child) {
                assert.equal(child, "chat_messages");
                const ref = {
                  orderBy(field, direction) {
                    assert.equal(field, "timestamp");
                    assert.equal(direction, "asc");
                    return ref;
                  },
                  onSnapshot(next, error) {
                    if (api.listenerError) throw api.listenerError;
                    const listener = { id, next, error, active: true };
                    listeners.push(listener);
                    return () => { listener.active = false; };
                  },
                  async add(data) {
                    writes.push({ id, data });
                    if (api.holdWrite) await new Promise((resolve) => { api.pendingWrite = resolve; });
                    if (api.writeError) throw api.writeError;
                    api.publish(id, [...(chats.get(id) || []), data]);
                  }
                };
                return ref;
              }
            };
          }
        };
      }
    }
  };
  return api;
}

function harness({ role = "customer", viewer = false, authorized = true, standalone = false, server = backend() } = {}) {
  const html = read(standalone ? "driver.html" : "index.html")
    .replace(/<template\b[^>]*>[\s\S]*?<\/template>/g, "");
  const nodes = new Map([...html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)].map((match) => [
    match[1], element(match[0].match(/\bclass="([^"]*)"/)?.[1])
  ]));
  const get = (id) => nodes.get(id) || null;
  const document = element();
  document.body = element();
  document.body.dataset.appMode = role === "driver" ? "driver" : "passenger";
  document.getElementById = get;
  document.createElement = () => element();
  document.createDocumentFragment = () => ({ ...element(), fragment: true });
  const window = {
    addEventListener() {}, accountAuth: { isOnline: () => false },
    isViewerMode: viewer, isCurrentDriverAuthorized: () => authorized,
    getCurrentDriverProfile: () => authorized
      ? { id: "DRV-001", phone: "+639171234567", name: "Test driver", model: "Test sedan", plate: "TEST 001" }
      : null
  };
  const errors = [];
  const warnings = [];
  const context = vm.createContext({
    window, document, db: server.db,
    firebase: { firestore: { FieldValue: { serverTimestamp: () => "SERVER_TIMESTAMP" } } },
    console: { log() {}, error: (...args) => errors.push(args), warn: (...args) => warnings.push(args) },
    localStorage: { getItem: () => null, setItem() {} },
    setTimeout: () => 1, clearTimeout() {}
  });
  vm.runInContext(read("js/chat.js"), context);
  const h = {
    context, window, document, get, server, warnings, errors,
    setTrip(status = "accepted", orderId = "trip-a", tripRole = role) {
      window.tripChat.updateTrip(tripRole, orderId, { status, driverName: "Chauffeur A", customerName: "Guest A" });
    },
    open: () => get(role === "driver" ? "btnChatWithGuest" : "btnChatWithDriver").emit("click"),
    visible: () => !get("inAppChatModal").classList.contains("hidden"),
    send(text, senderRole = role) {
      get("chatMessageInput").value = text;
      return window.sendMessage(text, senderRole);
    }
  };
  return h;
}

test("both roles show chat only for eligible existing and requested status spellings", async () => {
  for (const role of ["customer", "driver"]) {
    const h = harness({ role });
    const button = h.get(role === "driver" ? "btnChatWithGuest" : "btnChatWithDriver");
    assert.equal(button.classList.contains("hidden"), true);
    for (const status of ["pending", "SEARCHING", "COMPLETED", "CANCELLED", "closed", "unknown"]) {
      h.setTrip(status);
      assert.equal(button.classList.contains("hidden"), true);
      await h.open();
      assert.equal(h.visible(), false);
    }
    for (const status of ["accepted", "matched", "MATCHED", "arrived", "ARRIVED", "in_progress", "IN_TRANSIT"]) {
      h.setTrip(status);
      assert.equal(button.classList.contains("hidden"), false);
      await h.open();
      assert.equal(h.visible(), true);
      h.window.tripChat.close();
    }
    for (const id of ["", null, "Generating...", "bad/path"]) {
      h.setTrip("accepted", id);
      await h.open();
      assert.equal(h.visible(), false);
    }
  }
});

test("two clients synchronize messages on the exact trip subcollection with distinct bubbles", async () => {
  const server = backend();
  const customer = harness({ server });
  const driver = harness({ server, role: "driver" });
  customer.setTrip();
  driver.setTrip();
  await customer.open();
  await driver.open();
  assert.equal(server.active().length, 2);
  assert.equal(await customer.send("  Going down now  "), true);
  assert.equal(await driver.send("I have arrived"), true);
  assert.deepEqual(JSON.parse(JSON.stringify(server.writes)), [
    { id: "trip-a", data: { sender: "customer", text: "Going down now", timestamp: "SERVER_TIMESTAMP" } },
    { id: "trip-a", data: { sender: "driver", text: "I have arrived", timestamp: "SERVER_TIMESTAMP" } }
  ]);
  for (const h of [customer, driver]) {
    const rows = h.get("chatMessagesList").children;
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.children[0].textContent), ["Going down now", "I have arrived"]);
    assert.match(rows[h === customer ? 0 : 1].className, /justify-end/);
    assert.match(rows[h === customer ? 1 : 0].className, /justify-start/);
  }
  server.publish("trip-b", [{ sender: "driver", text: "Private other trip" }]);
  assert.equal(customer.get("chatMessagesList").children.length, 2);
});

test("quick replies are role-specific, fill the draft without sending, and do not focus the input", async () => {
  const expected = {
    customer: ["Going down now", "Waiting at the lobby", "Please wait 2 mins"],
    driver: ["I have arrived", "Heavy traffic, arriving soon", "Waiting at pickup point"]
  };
  for (const role of ["customer", "driver"]) {
    const h = harness({ role });
    h.setTrip();
    await h.open();
    assert.equal(h.get("chatPartnerName").textContent, role === "driver" ? "Guest A" : "Chauffeur A");
    const replies = h.get("chatQuickReplies").children;
    assert.deepEqual(replies.map((reply) => reply.textContent), expected[role]);
    await replies[1].emit("click");
    assert.equal(h.get("chatMessageInput").value, expected[role][1]);
    assert.equal(h.server.writes.length, 0);
  }
  assert.doesNotMatch(read("js/chat.js"), /\.focus\s*\(/);
});

test("repeat opens do not duplicate listeners; close/reopen isolates stale callbacks", async () => {
  const h = harness();
  h.setTrip();
  await h.open();
  await h.open();
  assert.equal(h.server.listeners.length, 1);
  const previous = h.server.listeners[0];
  await h.get("btnCloseChat").emit("click");
  assert.equal(h.server.active().length, 0);
  assert.equal(h.visible(), false);
  h.setTrip("arrived", "trip-b");
  await h.open();
  previous.next({ forEach: (callback) => callback({ data: () => ({ sender: "driver", text: "old trip" }) }) });
  assert.equal(h.get("chatMessagesList").children.length, 0);
  assert.equal(h.server.active().length, 1);
  await h.document.emit("keydown", { key: "Escape" });
  assert.equal(h.server.active().length, 0);
});

test("completed, cancelled, changed and cleared trips close the drawer and reject new sends", async () => {
  for (const role of ["customer", "driver"]) {
    for (const end of ["COMPLETED", "CANCELLED", "pending", "changed", "clear"]) {
      const h = harness({ role });
      h.setTrip();
      await h.open();
      if (end === "clear") h.window.tripChat.clearTrip(role);
      else h.setTrip(end === "changed" ? "accepted" : end, end === "changed" ? "trip-b" : "trip-a");
      assert.equal(h.visible(), false);
      assert.equal(h.server.active().length, 0);
      assert.equal(await h.send("late message"), false);
      assert.equal(h.server.writes.length, 0);
    }
  }
});

test("read-only viewers, wrong modes, unverified drivers, and mismatched senders are blocked", async () => {
  for (const options of [{ viewer: true }, { viewer: true, role: "driver" }, { role: "driver", authorized: false }]) {
    const h = harness(options);
    h.setTrip();
    await h.open();
    assert.equal(h.visible(), false);
    assert.equal(h.server.listeners.length, 0);
    assert.equal(await h.send("blocked"), false);
  }
  const h = harness();
  h.setTrip();
  await h.open();
  assert.equal(await h.send("wrong sender", "driver"), false);
  h.document.body.dataset.appMode = "driver";
  assert.equal(await h.send("wrong mode"), false);
  h.server.publish("trip-a", []);
  assert.equal(h.visible(), false);
  assert.equal(h.server.active().length, 0);
});

test("empty and duplicate sends are prevented; send failures preserve drafts and expose errors", async () => {
  const h = harness();
  h.setTrip();
  await h.open();
  assert.equal(await h.send("   "), false);
  assert.match(h.get("chatStatus").textContent, /Enter a message/);
  assert.equal(h.server.writes.length, 0);
  h.server.holdWrite = true;
  const first = h.send("Please wait");
  assert.equal(h.get("btnSendChatMessage").disabled, true);
  assert.equal(await h.window.sendMessage("Please wait", "customer"), false);
  assert.equal(h.server.writes.length, 1);
  h.server.pendingWrite();
  assert.equal(await first, true);
  assert.equal(h.get("chatMessageInput").value, "");
  assert.equal(h.get("btnSendChatMessage").disabled, false);
  h.server.holdWrite = false;
  h.server.writeError = new Error("permission-denied");
  assert.equal(await h.send("Keep this draft"), false);
  assert.equal(h.get("chatMessageInput").value, "Keep this draft");
  assert.match(h.get("chatStatus").textContent, /Unable to send/);
  assert.equal(h.errors.length, 1);
});

test("late send completion cannot clear a newer draft or a different trip's drawer", async () => {
  const h = harness();
  h.setTrip();
  await h.open();
  h.server.holdWrite = true;
  const pending = h.send("first draft");
  h.get("chatMessageInput").value = "new draft";
  h.server.pendingWrite();
  await pending;
  assert.equal(h.get("chatMessageInput").value, "new draft");
  const previous = h.send("old trip message");
  h.setTrip("accepted", "trip-b");
  await h.open();
  h.get("chatMessageInput").value = "trip-b draft";
  h.server.pendingWrite();
  await previous;
  assert.equal(h.get("chatMessageInput").value, "trip-b draft");
  assert.equal(h.get("chatMessagesList").children.length, 0);
});

test("message read errors stop subscription, disable sending and allow a fresh retry", async () => {
  const h = harness();
  h.setTrip();
  await h.open();
  h.server.listeners[0].error(new Error("permission-denied"));
  assert.equal(h.server.active().length, 0);
  assert.match(h.get("chatStatus").textContent, /Unable to load chat/);
  assert.equal(h.get("btnSendChatMessage").disabled, true);
  assert.equal(await h.send("blocked after error"), false);
  h.window.tripChat.close();
  await h.open();
  assert.equal(h.server.active().length, 1);
  h.window.tripChat.close();
  h.server.listenerError = new Error("synchronous setup failure");
  await h.open();
  assert.match(h.get("chatStatus").textContent, /Unable to load chat/);
});

test("message text is rendered literally; new snapshots preserve manual scroll position", async () => {
  const h = harness();
  h.setTrip();
  await h.open();
  const message = '<img src=x onerror="alert(1)">';
  h.server.publish("trip-a", [{ sender: "driver", text: message }, { sender: "unknown", text: "bad" }]);
  assert.equal(h.get("chatMessagesList").children.length, 1);
  assert.equal(h.get("chatMessagesList").children[0].children[0].textContent, message);
  assert.equal(h.get("chatMessagesList").scrollTop, 500);
  h.get("chatMessagesList").scrollTop = 0;
  h.server.publish("trip-a", [{ sender: "driver", text: "new message" }]);
  assert.equal(h.get("chatMessagesList").scrollTop, 0);
});

test("existing passenger order snapshots enable chat and close it on completion or disappearance", async () => {
  const h = harness();
  const source = read("js/order.js");
  vm.runInContext(source.slice(0, source.indexOf("// 系統初始化")), h.context);
  Object.assign(h.context, {
    currentOrderId: "trip-a", unsubscribeOrder: null,
    renderNativeTripView() {}, renderPendingOrderView() {}
  });
  h.context.subscribeToOrder("trip-a");
  const listener = h.server.parentListeners[0];
  listener.next({ exists: true, data: () => ({ status: "accepted", driverName: "Live driver" }) });
  await h.open();
  assert.equal(h.visible(), true);
  assert.equal(h.get("chatPartnerName").textContent, "Live driver");
  listener.next({ exists: true, data: () => ({ status: "completed" }) });
  assert.equal(h.visible(), false);
  assert.equal(h.server.active().length, 0);
  listener.next({ exists: true, data: () => ({ status: "arrived" }) });
  await h.open();
  listener.next({ exists: false });
  assert.equal(h.visible(), false);
  h.context.currentOrderId = "trip-b";
  h.context.subscribeToOrder("trip-b");
  h.server.parentListeners[1].next({ exists: true, data: () => ({ status: "accepted" }) });
  await h.open();
  listener.next({ exists: false });
  listener.error(new Error("stale order listener"));
  assert.equal(h.visible(), true);
  assert.equal(h.server.active()[0].id, "trip-b");
});

test("standalone driver's existing snapshot/reset lifecycle updates and clears chat", async () => {
  const h = harness({ role: "driver", standalone: true });
  vm.runInContext(read("js/driver.js"), h.context);
  h.get("driverView").classList.remove("hidden");
  h.window.driverApp.initialize();
  const listener = h.server.driverListeners[0];
  listener.next(h.server.orderSnapshot([{
    id: "trip-a", status: "accepted", driverId: "DRV-001", customerName: "Live guest"
  }]));
  await h.open();
  assert.equal(h.get("chatPartnerName").textContent, "Live guest");
  assert.equal(h.visible(), true);
  listener.next(h.server.orderSnapshot([{
    id: "trip-a", status: "cancelled", driverId: "DRV-001"
  }]));
  assert.equal(h.visible(), false);
  assert.equal(h.server.active().length, 0);
  listener.next(h.server.orderSnapshot([{
    id: "trip-b", status: "in_progress", driverId: "DRV-001"
  }]));
  await h.open();
  assert.equal(h.visible(), true);
  h.window.driverApp.stop();
  assert.equal(h.visible(), false);
  assert.equal(h.server.active().length, 0);
});

test("both HTML entrypoints retain identical hidden drawers and load chat before order handlers", () => {
  const index = read("index.html");
  const driver = read("driver.html");
  const drawer = (html) => html.slice(html.indexOf('  <div id="inAppChatModal"'), html.indexOf('  <script src="js/config.js"'));
  assert.equal(drawer(index), drawer(driver));
  for (const html of [index, driver]) {
    assert.match(drawer(html), /class="[^"]*\bhidden\b/);
    assert.match(html, /id="btnChatWithGuest"[^>]+class="hidden /);
    assert.ok(html.indexOf('src="js/chat.js"') < html.indexOf('src="js/driver.js"'));
  }
  assert.ok(index.indexOf('src="js/chat.js"') < index.indexOf('src="js/order.js"'));
  assert.match(read("sw.js"), /'\.\/js\/chat\.js'/);
  assert.match(read("js/app-mode.js"), /function setAppMode\(driverMode\) \{\s*window\.tripChat\?\.close\(\)/);
});
