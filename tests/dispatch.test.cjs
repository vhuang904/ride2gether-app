const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const plain = value => JSON.parse(JSON.stringify(value));
function harness() {
  const h = {
    order: { orderId: "OD-dispatch1", status: "pending", customerName: "<Guest>", customerPhone: "+639171234500",
      serviceName: "Car", category: "mobility", origin: "Pickup", destination: "Airport", distance: 5,
      itemCost: 0, tip: 0, totalPay: 155, notes: "=IMPORTDATA(\"invalid\")", createdAt: "2026-09-22T00:00:00Z" },
    rows: [Array(16).fill("header")], requests: [], errors: [], released: 0, authorized: true, onSend: null
  };
  function field(value) {
    if (value === null) return { nullValue: null };
    if (typeof value === "number") return { doubleValue: value };
    return { stringValue: value };
  }
  const context = vm.createContext({
    TELEGRAM_BOT_TOKEN: "test-token", TELEGRAM_CHAT_ID: "-100000", FIREBASE_PROJECT_ID: "test-project",
    console: { error: (...args) => h.errors.push(args) },
    ContentService: { MimeType: { JSON: "json" }, createTextOutput: text => ({ setMimeType: () => JSON.parse(text) }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() { h.released++; } }) },
    ScriptApp: { getOAuthToken: () => "operator-token" },
    Utilities: { formatDate: date => date.toISOString() },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: name => {
      assert.equal(name, "Orders_Master");
      return {
        getDataRange: () => ({ getValues: () => h.rows }), getLastRow: () => h.rows.length,
        getRange: row => ({ setValues: rows => { h.rows[row - 1] = plain(rows[0]); } })
      };
    } }) },
    UrlFetchApp: { fetch(url, options) {
      const body = options.payload ? JSON.parse(options.payload) : undefined;
      h.requests.push({ url, options, body });
      let response, status = 200;
      if (url.endsWith("cloudfunctions.net/api")) {
        assert.equal(options.headers.Authorization, "Bearer participant-token");
        assert.deepEqual(body, { action: "dispatchOrder", payload: { orderId: h.order.orderId } });
        status = h.authorized ? 200 : 403;
        response = h.authorized ? { order: h.order } : { code: "FORBIDDEN" };
      } else if (url.includes("firestore.googleapis.com")) {
        assert.equal(options.headers.Authorization, "Bearer operator-token");
        if (options.method === "patch") {
          assert.deepEqual(Object.keys(body.fields).sort(), ["telegramChatId", "telegramMessageId"]);
          assert.ok(url.includes("currentDocument.exists=true"));
          for (const [key, value] of Object.entries(body.fields)) h.order[key] = value.stringValue;
        }
        response = { fields: Object.fromEntries(Object.entries(h.order).map(([key, value]) => [key, field(value)])) };
      } else {
        assert.ok(url.startsWith("https://api.telegram.org/bottest-token/"));
        if (url.endsWith("/sendMessage")) {
          if (h.onSend) h.onSend();
          response = { ok: true, result: { message_id: 42 } };
        } else response = { ok: true, result: true };
      }
      return { getResponseCode: () => status, getContentText: () => JSON.stringify(response) };
    } }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../gas/Dispatch.gs"), "utf8"), context);
  h.post = data => plain(context.doPost({ postData: { contents: JSON.stringify(data) } }));
  h.sync = () => h.post({ action: "SYNC_ORDER", orderId: h.order.orderId, idToken: "participant-token", totalPay: 1, status: "completed" });
  h.context = context;
  return h;
}
test("dispatch authenticates the participant, mirrors authoritative values and sends an app link without callback claims", () => {
  const h = harness();
  assert.equal(h.sync().status, "SUCCESS");
  const message = h.requests.find(request => request.url.endsWith("/sendMessage")).body;
  assert.match(message.text, /155\.00/);
  assert.match(message.text, /&lt;Guest&gt;/);
  assert.equal(message.reply_markup.inline_keyboard[0][0].url, "https://ride2gether.ph/driver.html?order=OD-dispatch1");
  assert.equal(message.reply_markup.inline_keyboard[0][0].callback_data, undefined);
  assert.equal(h.rows[1][11], 155);
  assert.equal(h.rows[1][12], "SEARCHING");
  assert.ok(h.rows[1][14].startsWith("'="), "untrusted notes must not become a Sheet formula");
  assert.equal(h.order.status, "pending");
  assert.equal(h.order.telegramMessageId, "42");
  assert.equal(h.sync().status, "SUCCESS");
  assert.equal(h.rows.length, 2);
  assert.equal(h.requests.filter(request => request.url.endsWith("/sendMessage")).length, 1);
});
test("missing tokens, foreign sessions, forged legacy mutations and malformed IDs cannot touch Sheet or Telegram", () => {
  const h = harness();
  for (const data of [
    { action: "NEW_ORDER", orderId: h.order.orderId },
    { action: "CANCEL_ORDER", orderId: h.order.orderId },
    { action: "SYNC_ORDER", orderId: h.order.orderId },
    { action: "SYNC_ORDER", orderId: "../drivers/example", idToken: "participant-token" }
  ]) assert.equal(h.post(data).status, "ERROR");
  assert.equal(h.requests.length, 0);
  h.authorized = false;
  assert.equal(h.sync().status, "ERROR");
  assert.equal(h.requests.length, 1);
  assert.equal(h.rows.length, 1);
  assert.equal(h.order.status, "pending");
  assert.equal(h.released, 0);
});
test("a web claim during Telegram delivery removes the new button and preserves ownership and fare", () => {
  const h = harness();
  h.onSend = () => Object.assign(h.order, { status: "accepted", driverName: "Approved driver", driverId: "+639171234567" });
  assert.equal(h.sync().status, "SUCCESS");
  const edited = h.requests.find(request => request.url.endsWith("/editMessageText")).body;
  assert.deepEqual(edited.reply_markup.inline_keyboard, []);
  assert.match(edited.text, /Approved driver/);
  assert.equal(h.rows[1][12], "MATCHED");
  assert.equal(h.order.driverId, "+639171234567");
  assert.equal(h.order.totalPay, 155);
});
test("old Telegram callbacks only refresh their canonical card, show an alert and never claim or advance", () => {
  for (const status of ["pending", "accepted", "COMPLETED"]) {
    const h = harness();
    Object.assign(h.order, { status, telegramChatId: "-100000", telegramMessageId: "42" });
    const data = { callback_query: { id: "callback", data: "CLAIM_" + h.order.orderId,
      message: { message_id: 42, chat: { id: "-100000" } } } };
    assert.equal(h.post(data).status, "SUCCESS");
    const answer = h.requests.find(request => request.url.endsWith("/answerCallbackQuery")).body;
    assert.equal(answer.show_alert, true);
    assert.equal(answer.text, status === "pending" ? "Open Driver Mode to sign in and accept this trip."
      : "⚠️ Trip already claimed by another driver.");
    const markup = h.requests.find(request => request.url.endsWith("/editMessageReplyMarkup")).body.reply_markup;
    assert.equal(markup.inline_keyboard.length, status === "pending" ? 1 : 0);
    assert.equal(h.requests.filter(request => request.options.method === "patch").length, 0);
    assert.equal(h.order.status, status);
    assert.equal(h.rows.length, 1);
  }
});
test("callbacks cannot edit unrelated messages and cancellation never creates a fresh claim card", () => {
  const h = harness();
  Object.assign(h.order, { status: "cancelled" });
  assert.equal(h.sync().status, "SUCCESS");
  assert.equal(h.requests.some(request => request.url.includes("api.telegram.org")), false);
  h.requests.length = 0;
  assert.equal(h.post({ callback_query: { id: "callback", data: "CLAIM_" + h.order.orderId,
    message: { message_id: 999, chat: { id: "-100000" } } } }).status, "ERROR");
  assert.equal(h.requests.some(request => request.url.includes("api.telegram.org")), false);
});
