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
    rows: [Array(16).fill("header")], requests: [], errors: [], released: 0, authorized: true, onSend: null,
    claimFailure: null, properties: { TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret" }
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
    HtmlService: { createHtmlOutput: text => { h.directWebhookReply = true; return JSON.parse(text); } },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() { h.released++; } }) },
    ScriptApp: { getOAuthToken: () => "operator-token", getIdentityToken: () => "operator-identity",
      getService: () => ({ getUrl: () => "https://script.google.com/macros/s/test/exec" }) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: key => h.properties[key], setProperty: (key, value) => { h.properties[key] = value; }
    }) },
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
      } else if (url.endsWith("cloudfunctions.net/telegramClaim")) {
        assert.equal(options.headers.Authorization, "Bearer operator-identity");
        assert.deepEqual(body, { orderId: h.order.orderId, telegramId: "1234567", chatId: "-100000", messageId: "42" });
        if (h.claimFailure) { status = 409; response = h.claimFailure; }
        else {
          Object.assign(h.order, { status: "accepted", driverId: "+639171234567", driverName: "Approved driver" });
          response = { accepted: true };
        }
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
  h.post = (data, secret) => plain(context.doPost({ postData: { contents: JSON.stringify(data) },
    parameter: { telegram_secret: secret } }));
  h.callback = (secret = "test-webhook-secret", data = "CLAIM_" + h.order.orderId) =>
    h.post({ callback_query: { id: "callback", data, from: { id: 1234567, is_bot: false },
      message: { message_id: 42, chat: { id: "-100000" } } } }, secret);
  h.sync = () => h.post({ action: "SYNC_ORDER", orderId: h.order.orderId, idToken: "participant-token", totalPay: 1, status: "completed" });
  h.context = context;
  return h;
}
test("dispatch authenticates the participant and sends a native claim callback rather than opening the app", () => {
  const h = harness();
  assert.equal(h.sync().status, "SUCCESS");
  const message = h.requests.find(request => request.url.endsWith("/sendMessage")).body;
  assert.match(message.text, /155\.00/);
  assert.match(message.text, /&lt;Guest&gt;/);
  assert.equal(message.reply_markup.inline_keyboard[0][0].url, undefined);
  assert.equal(message.reply_markup.inline_keyboard[0][0].callback_data, "CLAIM_OD-dispatch1");
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
  assert.equal(edited.reply_markup.inline_keyboard[0][0].text, "OPEN TRIP");
  assert.equal(edited.reply_markup.inline_keyboard[0][0].callback_data, undefined);
  assert.match(edited.text, /Approved driver/);
  assert.equal(h.rows[1][12], "MATCHED");
  assert.equal(h.order.driverId, "+639171234567");
  assert.equal(h.order.totalPay, 155);
});
test("authenticated callback commits acceptance before success popup and Open Trip link", () => {
  const h = harness();
  Object.assign(h.order, { telegramChatId: "-100000", telegramMessageId: "42" });
  assert.equal(h.callback().status, "SUCCESS");
  assert.equal(h.directWebhookReply, true);
  const claimIndex = h.requests.findIndex(request => request.url.endsWith("/telegramClaim"));
  const answerIndex = h.requests.findIndex(request => request.url.endsWith("/answerCallbackQuery"));
  const editIndex = h.requests.findIndex(request => request.url.endsWith("/editMessageText"));
  assert.ok(claimIndex < answerIndex && answerIndex < editIndex);
  assert.match(h.requests[answerIndex].body.text, /Trip accepted!/);
  assert.equal(h.requests[answerIndex].body.show_alert, true);
  assert.deepEqual(h.requests[editIndex].body.reply_markup.inline_keyboard, [[{
    text: "OPEN TRIP", url: "https://ride2gether.ph/driver.html?order=OD-dispatch1"
  }]]);
  assert.equal(h.order.status, "accepted");
  assert.equal(h.rows[1][12], "MATCHED");
});
test("webhook acknowledgements avoid ContentService redirects without changing browser JSON responses", () => {
  const h = harness();
  assert.equal(h.callback("invalid-secret").status, "ERROR");
  assert.equal(h.directWebhookReply, true);
  assert.equal(h.requests.length, 0);
  h.directWebhookReply = false;
  assert.equal(h.sync().status, "SUCCESS");
  assert.equal(h.directWebhookReply, false);
});
test("claimed and offline callback errors show truthful popups, never success or unauthorized changes", () => {
  for (const code of ["ALREADY_CLAIMED", "DRIVER_OFFLINE", "TELEGRAM_NOT_LINKED"]) {
    const h = harness();
    const status = code === "ALREADY_CLAIMED" ? "accepted" : "pending";
    Object.assign(h.order, { status, telegramChatId: "-100000", telegramMessageId: "42" });
    h.claimFailure = { code, message: "Go online or contact operations." };
    assert.equal(h.callback().status, "SUCCESS");
    const answer = h.requests.find(request => request.url.endsWith("/answerCallbackQuery")).body;
    assert.equal(answer.show_alert, true);
    assert.equal(answer.text, code === "ALREADY_CLAIMED" ? "⚠️ Trip already claimed by another driver." : h.claimFailure.message);
    assert.equal(h.requests.filter(request => request.options.method === "patch").length, 0);
    assert.equal(h.order.status, status);
  }
});
test("forged webhook callbacks never reach Firestore, the backend or Telegram", () => {
  const h = harness();
  assert.equal(h.callback("").status, "ERROR");
  assert.equal(h.callback("fake-webhook-secret").status, "ERROR");
  assert.equal(h.requests.length, 0);
});
test("legacy status buttons cannot advance a trip and webhook installation preserves pending updates", () => {
  const h = harness();
  Object.assign(h.order, { status: "accepted", telegramChatId: "-100000", telegramMessageId: "42" });
  assert.equal(h.callback(undefined, "STATUS_COMPLETED_" + h.order.orderId).status, "SUCCESS");
  assert.equal(h.requests.some(request => request.url.endsWith("/telegramClaim")), false);
  assert.equal(h.order.status, "accepted");
  h.context.installTelegramClaimWebhook();
  const webhook = h.requests.find(request => request.url.endsWith("/setWebhook")).body;
  assert.equal(webhook.drop_pending_updates, false);
  assert.match(webhook.url, /\/exec\?telegram_secret=test-webhook-secret$/);
});
test("callbacks cannot edit unrelated messages and cancellation never creates a fresh claim card", () => {
  const h = harness();
  Object.assign(h.order, { status: "cancelled" });
  assert.equal(h.sync().status, "SUCCESS");
  assert.equal(h.requests.some(request => request.url.includes("api.telegram.org")), false);
  h.requests.length = 0;
  assert.equal(h.post({ callback_query: { id: "callback", data: "CLAIM_" + h.order.orderId,
    message: { message_id: 999, chat: { id: "-100000" } } } }, "test-webhook-secret").status, "ERROR");
  assert.equal(h.requests.some(request => request.url.includes("api.telegram.org")), false);
});
