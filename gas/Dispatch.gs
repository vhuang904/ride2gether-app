// Production configuration supplies TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_WEB_APP_URL and FIREBASE_PROJECT_ID.
// Order ownership, fares, GPS and phase transitions are written only by the authenticated API.
function dispatchJson_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

function dispatchOrderId_(value) {
  if (typeof value !== "string" || !/^OD-[a-zA-Z0-9-]{6,80}$/.test(value)) throw new Error("INVALID_ORDER");
  return value;
}

function dispatchDecode_(value) {
  if ("stringValue" in value) return value.stringValue;
  if ("timestampValue" in value) return value.timestampValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("booleanValue" in value) return value.booleanValue;
  if ("nullValue" in value) return null;
  if ("mapValue" in value) return dispatchFields_(value.mapValue.fields || {});
  throw new Error("UNSUPPORTED_ORDER_FIELD");
}

function dispatchFields_(fields) {
  const result = {};
  Object.keys(fields).forEach(key => { result[key] = dispatchDecode_(fields[key]); });
  return result;
}

function dispatchFirestore_(path, method, body) {
  const response = UrlFetchApp.fetch(
    "https://firestore.googleapis.com/v1/projects/" + FIREBASE_PROJECT_ID + "/databases/(default)/documents/" + path, {
      method: method || "get", headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true, followRedirects: false,
      ...(body ? { contentType: "application/json", payload: JSON.stringify(body) } : {})
    });
  if (response.getResponseCode() !== 200) throw new Error("FIRESTORE_REQUEST_FAILED");
  return JSON.parse(response.getContentText());
}

function dispatchReadOrder_(id) {
  const order = dispatchFields_(dispatchFirestore_("ride_orders/" + dispatchOrderId_(id)).fields);
  order.status = { SEARCHING: "pending", MATCHED: "accepted", ARRIVED: "arrived",
    IN_TRANSIT: "in_progress", COMPLETED: "completed", CANCELLED: "cancelled" }[order.status] || order.status;
  if (order.orderId !== id || !["pending", "accepted", "arrived", "in_progress", "completed", "cancelled"].includes(order.status)) {
    throw new Error("UNSUPPORTED_TRIP");
  }
  return order;
}

function dispatchAuthorize_(data) {
  dispatchOrderId_(data.orderId);
  if (typeof data.idToken !== "string" || !data.idToken || data.idToken.length > 12000) throw new Error("SIGN_IN_REQUIRED");
  const response = UrlFetchApp.fetch("https://asia-southeast1-" + FIREBASE_PROJECT_ID + ".cloudfunctions.net/api", {
    method: "post", contentType: "application/json", muteHttpExceptions: true, followRedirects: false,
    headers: { Authorization: "Bearer " + data.idToken, Origin: "https://ride2gether.ph" },
    payload: JSON.stringify({ action: "dispatchOrder", payload: { orderId: data.orderId } })
  });
  if (response.getResponseCode() !== 200) throw new Error("DISPATCH_NOT_AUTHORIZED");
  const result = JSON.parse(response.getContentText());
  if (!result.order || result.order.orderId !== data.orderId) throw new Error("INVALID_DISPATCH_RESPONSE");
}

function dispatchTelegram_(method, body) {
  const response = UrlFetchApp.fetch("https://api.telegram.org/bot" + TELEGRAM_BOT_TOKEN + "/" + method, {
    method: "post", contentType: "application/json", payload: JSON.stringify(body), muteHttpExceptions: true
  });
  const result = JSON.parse(response.getContentText());
  if (method === "editMessageText" && response.getResponseCode() === 400
      && /^Bad Request: message is not modified/.test(result.description || "")) return null;
  if (response.getResponseCode() !== 200 || !result.ok) throw new Error("TELEGRAM_REQUEST_FAILED");
  return result.result;
}

function dispatchMarkup_(order) {
  return { inline_keyboard: order.status === "pending" ? [[{
    text: "CLAIM THIS ORDER",
    callback_data: "CLAIM_" + order.orderId
  }]] : ["accepted", "arrived", "in_progress"].includes(order.status) ? [[{
    text: "OPEN TRIP",
    url: "https://ride2gether.ph/driver.html?order=" + encodeURIComponent(order.orderId)
  }]] : [] };
}

function dispatchHtml_(value) {
  return String(value == null ? "" : value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function dispatchText_(order) {
  const html = dispatchHtml_;
  return "<b>DISPATCH REQUEST</b>\n\n"
    + "<b>Order ID:</b> <code>" + html(order.orderId) + "</code>\n"
    + "<b>Guest:</b> " + html(order.customerName) + "\n"
    + "<b>Pickup:</b> " + html(order.origin) + "\n"
    + "<b>Dropoff:</b> " + html(order.destination) + "\n"
    + "<b>Service:</b> " + html(order.serviceName) + "\n"
    + "<b>Total Fare:</b> PHP " + Number(order.totalPay).toFixed(2) + "\n"
    + "<b>Notes:</b> " + html(String(order.notes || "None").slice(0, 500)) + "\n\n"
    + "<b>Status:</b> " + html(order.status.replace("_", " ")) + "\n"
    + (order.driverName ? "<b>Driver:</b> " + html(order.driverName) + "\n" : "")
    + (order.status === "pending" ? "Linked, online drivers can claim here. Open the trip after confirmation to enable location."
      : "This trip is no longer open for claiming.");
}

function dispatchWriteSheet_(order) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Orders_Master");
  if (!sheet) throw new Error("ORDERS_SHEET_MISSING");
  const rows = sheet.getDataRange().getValues();
  const found = rows.findIndex((row, index) => index > 0 && String(row[0]) === order.orderId);
  const status = { pending: "SEARCHING", accepted: "MATCHED", arrived: "ARRIVED",
    in_progress: "IN_TRANSIT", completed: "COMPLETED", cancelled: "CANCELLED" }[order.status];
  const values = [
    order.orderId, Utilities.formatDate(new Date(order.createdAt), "Asia/Manila", "yyyy-MM-dd HH:mm:ss"),
    order.customerName, order.customerPhone, order.category,
    order.serviceName, order.origin, order.destination, order.distance, order.itemCost, order.tip,
    order.totalPay, status, order.telegramMessageId || "-", order.notes || "-", order.driverName || "-"
  ].map(value => typeof value === "string" && /^[=+@-]/.test(value) ? "'" + value : value == null ? "" : value);
  sheet.getRange(found >= 0 ? found + 1 : sheet.getLastRow() + 1, 1, 1, values.length).setValues([values]);
}

function dispatchSync_(id) {
  let order = dispatchReadOrder_(id);
  if (!order.telegramMessageId && !["completed", "cancelled"].includes(order.status)) {
    const sent = dispatchTelegram_("sendMessage", {
      chat_id: TELEGRAM_CHAT_ID, text: dispatchText_(order), parse_mode: "HTML", reply_markup: dispatchMarkup_(order)
    });
    if (!sent || !sent.message_id) throw new Error("TELEGRAM_MESSAGE_MISSING");
    dispatchFirestore_("ride_orders/" + id
      + "?updateMask.fieldPaths=telegramMessageId&updateMask.fieldPaths=telegramChatId&currentDocument.exists=true", "patch", {
      fields: { telegramMessageId: { stringValue: String(sent.message_id) },
        telegramChatId: { stringValue: String(TELEGRAM_CHAT_ID) } }
    });
  }
  // A web claim may commit while sendMessage is in flight. Never render the pre-send state.
  order = dispatchReadOrder_(id);
  if (order.telegramMessageId) {
    if (String(order.telegramChatId) !== String(TELEGRAM_CHAT_ID)) throw new Error("DISPATCH_CHAT_MISMATCH");
    dispatchTelegram_("editMessageText", {
      chat_id: TELEGRAM_CHAT_ID, message_id: order.telegramMessageId,
      text: dispatchText_(order), parse_mode: "HTML", reply_markup: dispatchMarkup_(order)
    });
  }
  dispatchWriteSheet_(order);
}

function dispatchCallback_(query) {
  const match = /^(?:CLAIM_|STATUS_(?:ARRIVED|TRANSIT|COMPLETED)_)(OD-[a-zA-Z0-9-]{6,80})$/.exec(query.data || "");
  if (!match || !query.message || String(query.message.chat.id) !== String(TELEGRAM_CHAT_ID)) {
    throw new Error("INVALID_CALLBACK");
  }
  const order = dispatchReadOrder_(match[1]);
  if (String(order.telegramMessageId) !== String(query.message.message_id)
      || String(order.telegramChatId) !== String(TELEGRAM_CHAT_ID)) throw new Error("INVALID_CALLBACK_MESSAGE");
  if (!query.data.startsWith("CLAIM_")) {
    dispatchTelegram_("answerCallbackQuery", {
      callback_query_id: query.id, show_alert: true, text: "Open Driver Mode to update your trip."
    });
    dispatchSync_(order.orderId);
    return;
  }
  if (!query.from || !Number.isSafeInteger(query.from.id) || query.from.id <= 0 || query.from.is_bot) {
    throw new Error("INVALID_CALLBACK_DRIVER");
  }
  const token = ScriptApp.getIdentityToken();
  if (!token) throw new Error("DISPATCH_IDENTITY_MISSING");
  const response = UrlFetchApp.fetch("https://asia-southeast1-" + FIREBASE_PROJECT_ID + ".cloudfunctions.net/telegramClaim", {
    method: "post", contentType: "application/json", muteHttpExceptions: true, followRedirects: false,
    headers: { Authorization: "Bearer " + token },
    payload: JSON.stringify({ orderId: order.orderId, telegramId: String(query.from.id),
      chatId: String(query.message.chat.id), messageId: String(query.message.message_id) })
  });
  const result = JSON.parse(response.getContentText());
  const accepted = response.getResponseCode() === 200 && result.accepted === true;
  try {
    dispatchTelegram_("answerCallbackQuery", {
      callback_query_id: query.id, show_alert: true,
      text: accepted ? "Trip accepted! The passenger has been notified. Tap OPEN TRIP to enable location."
        : result.code === "ALREADY_CLAIMED" ? "⚠️ Trip already claimed by another driver."
          : String(result.message || "Unable to confirm this claim. Please retry.").slice(0, 200)
    });
  } finally {
    // Always reconcile the card, even if Telegram's callback acknowledgement has expired.
    dispatchSync_(order.orderId);
  }
}

function dispatchVerifyWebhook_(event) {
  const expected = PropertiesService.getScriptProperties().getProperty("TELEGRAM_WEBHOOK_SECRET");
  const supplied = event && event.parameter && event.parameter.telegram_secret;
  if (!expected || typeof supplied !== "string" || supplied.length !== expected.length) throw new Error("INVALID_WEBHOOK");
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ supplied.charCodeAt(i);
  if (difference !== 0) throw new Error("INVALID_WEBHOOK");
}

function installTelegramClaimWebhook() {
  const properties = PropertiesService.getScriptProperties();
  let secret = properties.getProperty("TELEGRAM_WEBHOOK_SECRET");
  if (!secret) {
    secret = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, "");
    properties.setProperty("TELEGRAM_WEBHOOK_SECRET", secret);
  }
  const url = typeof TELEGRAM_WEB_APP_URL === "string" ? TELEGRAM_WEB_APP_URL : ScriptApp.getService().getUrl();
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url || "")) {
    throw new Error("DEPLOY_WEB_APP_FIRST");
  }
  dispatchTelegram_("setWebhook", { url: url + "?telegram_secret=" + encodeURIComponent(secret),
    allowed_updates: ["callback_query"], drop_pending_updates: false });
  return { installed: true };
}

function doPost(event) {
  const lock = LockService.getScriptLock();
  let acquired = false;
  let callback = false;
  let result;
  try {
    const contents = event && event.postData && event.postData.contents;
    if (typeof contents !== "string" || contents.length > 20000) throw new Error("INVALID_REQUEST");
    const data = JSON.parse(contents);
    if (!data || typeof data !== "object") throw new Error("INVALID_REQUEST");
    callback = Boolean(data.callback_query);
    if (callback) dispatchVerifyWebhook_(event);
    else {
      if (data.action !== "SYNC_ORDER") throw new Error("UNSUPPORTED_ACTION");
      dispatchAuthorize_(data);
    }
    lock.waitLock(30000);
    acquired = true;
    if (data.callback_query) dispatchCallback_(data.callback_query);
    else dispatchSync_(data.orderId);
    result = { status: "SUCCESS" };
  } catch (error) {
    console.error("Dispatch failed; verify the canonical order state.", /^[A-Z_]+$/.test(error.message) ? error.message : "DISPATCH_FAILED");
    result = { status: "ERROR", code: "DISPATCH_FAILED" };
  } finally {
    if (acquired) lock.releaseLock();
  }
  // ContentService redirects; Telegram requires a direct webhook acknowledgement.
  return callback ? HtmlService.createHtmlOutput(JSON.stringify(result)) : dispatchJson_(result);
}

function doGet() {
  try {
    const config = dispatchFields_(dispatchFirestore_("rate_config/current").fields);
    return dispatchJson_({ status: "SUCCESS", rates: config.rates });
  } catch (error) {
    console.error("Public pricing read failed.");
    return dispatchJson_({ status: "ERROR", code: "PRICING_UNAVAILABLE" });
  }
}
