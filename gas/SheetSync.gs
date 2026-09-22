// Add to the spreadsheet-bound GAS project. Do not expose these functions via doGet/doPost.
const SHEET_SYNC_RATE_HEADERS = [
  "Service_ID", "Service_Name", "Base_Fare", "Base_Km", "Per_Km_Rate",
  "Surge_Multiplier", "Flat_Surge_Fee", "Convenience_Fee", "Commission_Type", "Commission_Value"
];
const SHEET_SYNC_DRIVER_HEADERS = [
  "Driver_Name", "Telegram_Username", "Telegram_ID", "Phone_Number",
  "Plate_Number", "Vehicle_Model", "WhatsApp", "Viber", "Driver_PIN"
];

function sheetSyncRows_(spreadsheet, name, headers) {
  const sheet = spreadsheet.getSheetByName(name);
  if (!sheet) throw new Error("Missing sheet: " + name);
  const rows = sheet.getDataRange().getValues();
  const labels = rows[0].map(value => String(value).trim());
  headers.forEach(label => {
    if (labels.filter(value => value === label).length !== 1) {
      throw new Error(name + ": missing or duplicate column " + label);
    }
  });
  return rows.slice(1).map((row, index) => {
      if (!row.some(value => String(value).trim() !== "")) return null;
      const result = {};
      headers.forEach(label => { result[label] = row[labels.indexOf(label)]; });
      result._row = index + 2;
      return result;
    }).filter(Boolean);
}

function sheetSyncNumber_(row, column, minimum) {
  const value = row[column];
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    throw new Error("Rate_Config row " + row._row + ": invalid " + column);
  }
  return value;
}

function sheetSyncPhone_(value) {
  let phone = String(value == null ? "" : value).replace(/[\s()\-]/g, "");
  if (/^09\d{9}$/.test(phone)) phone = "+63" + phone.slice(1);
  else if (/^9\d{9}$/.test(phone)) phone = "+63" + phone;
  else if (/^639\d{9}$/.test(phone)) phone = "+" + phone;
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw new Error("Invalid fleet phone: " + phone);
  return phone;
}

function sheetSyncReadRates_(spreadsheet) {
  const rates = {};
  sheetSyncRows_(spreadsheet, "Rate_Config", SHEET_SYNC_RATE_HEADERS).forEach(row => {
    const id = String(row.Service_ID).trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(id) || Object.prototype.hasOwnProperty.call(rates, id)) {
      throw new Error("Invalid or duplicate Service_ID at row " + row._row);
    }
    const name = String(row.Service_Name).trim();
    const commType = String(row.Commission_Type).trim().toUpperCase();
    const commVal = sheetSyncNumber_(row, "Commission_Value", 0);
    const surgeMultiplier = sheetSyncNumber_(row, "Surge_Multiplier", 0);
    if (!name || !["PERCENT", "FIXED"].includes(commType)
        || (commType === "PERCENT" && commVal > 1) || surgeMultiplier <= 0) {
      throw new Error("Invalid name, commission or multiplier for " + id);
    }
    rates[id] = {
      nameEn: name,
      base: sheetSyncNumber_(row, "Base_Fare", 0),
      baseKm: sheetSyncNumber_(row, "Base_Km", 0),
      perKm: sheetSyncNumber_(row, "Per_Km_Rate", 0),
      surgeMultiplier: surgeMultiplier,
      surgeFlat: sheetSyncNumber_(row, "Flat_Surge_Fee", 0),
      convenienceFee: sheetSyncNumber_(row, "Convenience_Fee", 0),
      commType: commType,
      commVal: commVal
    };
    if (commType === "FIXED" && commVal > rates[id].base * surgeMultiplier + rates[id].surgeFlat) {
      throw new Error("Commission exceeds the minimum trip fare for " + id);
    }
  });
  return rates;
}

function sheetSyncReadDrivers_(spreadsheet, pins) {
  const drivers = {};
  sheetSyncRows_(spreadsheet, "Drivers_Master", SHEET_SYNC_DRIVER_HEADERS).forEach(row => {
    const phone = sheetSyncPhone_(row.Phone_Number);
    if (Object.prototype.hasOwnProperty.call(drivers, phone)) {
      throw new Error("Duplicate Phone_Number in Drivers_Master: " + phone);
    }
    const name = String(row.Driver_Name).trim();
    const plate = String(row.Plate_Number).trim();
    const model = String(row.Vehicle_Model).trim();
    if (!name || !plate || !model) throw new Error("Incomplete driver profile at row " + row._row);
    const pin = String(row.Driver_PIN == null ? "" : row.Driver_PIN).trim();
    if (!/^\d{6}$/.test(pin)) throw new Error("Drivers_Master row " + row._row + ": Driver_PIN must contain exactly six digits; preserve leading zeros as text.");
    if (pins) pins[phone] = pin;
    drivers[phone] = {
      phone: phone, name: name, plate: plate, model: model,
      telegramUsername: String(row.Telegram_Username || "").trim().replace(/^@/, ""),
      telegramId: String(row.Telegram_ID || "").trim(),
      whatsapp: row.WhatsApp ? sheetSyncPhone_(row.WhatsApp) : phone,
      viber: row.Viber ? sheetSyncPhone_(row.Viber) : phone
    };
  });
  return drivers;
}

function sheetSyncValue_(value) {
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "number" && Number.isFinite(value)) return { doubleValue: value };
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const fields = {};
    Object.keys(value).forEach(key => { fields[key] = sheetSyncValue_(value[key]); });
    return { mapValue: { fields: fields } };
  }
  throw new Error("Unsupported Firestore configuration value");
}

function sheetSyncRequest_(url, method, payload) {
  const options = {
    method: method,
    headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true
  };
  if (payload) {
    options.contentType = "application/json";
    options.payload = JSON.stringify(payload);
  }
  const response = UrlFetchApp.fetch(url, options);
  const status = response.getResponseCode();
  if (status < 200 || status >= 300) {
    throw new Error("Firestore sync HTTP " + status + "; publication was not confirmed. Retry synchronization.");
  }
  return JSON.parse(response.getContentText() || "{}");
}

function sheetSyncListDrivers_(baseUrl) {
  let token = "";
  const documents = [];
  do {
    const response = sheetSyncRequest_(baseUrl + "/drivers?pageSize=300"
      + (token ? "&pageToken=" + encodeURIComponent(token) : ""), "get");
    (response.documents || []).forEach(doc => documents.push(doc));
    token = response.nextPageToken || "";
  } while (token);
  return documents;
}

function sheetSyncEqual_(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length
    && keys.every(key => Object.prototype.hasOwnProperty.call(right, key) && sheetSyncEqual_(left[key], right[key]));
}

function sheetSyncPreparePins_(projectId, pins) {
  const token = ScriptApp.getIdentityToken();
  if (!token) throw new Error("Authorize the sync operator's openid and userinfo.email scopes first.");
  const response = UrlFetchApp.fetch("https://asia-southeast1-" + projectId + ".cloudfunctions.net/prepareDriverPins", {
    method: "post", headers: { Authorization: "Bearer " + token },
    contentType: "application/json", muteHttpExceptions: true, followRedirects: false,
    payload: JSON.stringify({ projectId: projectId, drivers: Object.keys(pins).map(phone => ({ phone: phone, pin: pins[phone] })) })
  });
  const status = response.getResponseCode();
  if (status !== 200) throw new Error("Driver PIN preparation HTTP " + status + "; no changes were published.");
  try { return JSON.parse(response.getContentText()); }
  catch (_) { throw new Error("Driver PIN preparation returned invalid JSON; no changes were published."); }
}

function sheetSyncSecretWrites_(root, projectId, drivers, prepared) {
  if (!prepared || prepared.projectId !== projectId || !["updates", "checks", "removals"].every(key => Array.isArray(prepared[key]))) {
    throw new Error("Invalid driver PIN preparation response.");
  }
  const seen = new Set(), writes = [];
  function target(record, desired) {
    const phone = sheetSyncPhone_(record.phone);
    if (phone !== record.phone || seen.has(phone) || Object.prototype.hasOwnProperty.call(drivers, phone) !== desired) {
      throw new Error("Driver PIN response does not match Drivers_Master.");
    }
    seen.add(phone);
    return root + "/driver_auth_secrets/" + phone;
  }
  function existing(record) {
    if (typeof record.updateTime !== "string" || !record.updateTime) throw new Error("Missing private record precondition.");
    return { updateTime: record.updateTime };
  }
  prepared.updates.forEach(record => {
    const name = target(record, true), c = record.credential;
    if (!c || !/^[a-f0-9]{32}$/.test(c.salt) || !/^[a-f0-9]{128}$/.test(c.hash)
        || typeof c.version !== "string" || !c.version || c.enabled !== true) throw new Error("Invalid prepared PIN hash.");
    const fields = sheetSyncValue_({ salt: c.salt, hash: c.hash, version: c.version, enabled: true }).mapValue.fields;
    writes.push({ update: { name: name, fields: fields },
      currentDocument: record.updateTime === null ? { exists: false } : existing(record) });
  });
  prepared.checks.forEach(record => {
    // REST has no verify operation; an empty update mask preserves every field.
    writes.push({ update: { name: target(record, true), fields: {} },
      updateMask: { fieldPaths: [] }, currentDocument: existing(record) });
  });
  prepared.removals.forEach(record => {
    writes.push({ delete: target(record, false), currentDocument: existing(record) });
  });
  if (Object.keys(drivers).some(phone => !seen.has(phone))) throw new Error("Missing prepared driver PIN.");
  return writes;
}

function syncSheetConfiguration() {
  const properties = PropertiesService.getScriptProperties();
  const spreadsheetId = properties.getProperty("SHEET_SYNC_SPREADSHEET_ID");
  const projectId = properties.getProperty("SHEET_SYNC_FIREBASE_PROJECT_ID");
  if (!spreadsheetId || !projectId || !/^[a-z0-9-]+$/.test(projectId)) {
    throw new Error("Set SHEET_SYNC_SPREADSHEET_ID and SHEET_SYNC_FIREBASE_PROJECT_ID first.");
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
    // Validate the entire source before making any Firestore writes.
    const rates = sheetSyncReadRates_(spreadsheet);
    const pins = {};
    const drivers = sheetSyncReadDrivers_(spreadsheet, pins);
    const root = "projects/" + projectId + "/databases/(default)/documents";
    const baseUrl = "https://firestore.googleapis.com/v1/" + root;
    const existing = sheetSyncListDrivers_(baseUrl);
    const updatedAt = Utilities.formatDate(new Date(), "Asia/Manila", "yyyy-MM-dd'T'HH:mm:ssXXX");
    const desiredNames = new Set();
    const writes = [];
    Object.keys(drivers).forEach(id => {
      const name = root + "/drivers/" + id;
      desiredNames.add(name);
      const previous = existing.find(doc => doc.name === name);
      const fields = sheetSyncValue_(drivers[id]).mapValue.fields;
      if (previous && sheetSyncEqual_(previous.fields, fields)) return;
      writes.push({
        update: { name: name, fields: fields },
        currentDocument: previous ? { updateTime: previous.updateTime } : { exists: false }
      });
    });
    existing.forEach(doc => {
      if (!desiredNames.has(doc.name)) {
        writes.push({ delete: doc.name, currentDocument: { updateTime: doc.updateTime } });
      }
    });
    if (writes.length >= 500) throw new Error("Sync exceeds 500 atomic writes; no changes were published.");
    const prepared = sheetSyncPreparePins_(projectId, pins);
    writes.push(...sheetSyncSecretWrites_(root, projectId, drivers, prepared));
    writes.push({
      update: {
        name: root + "/rate_config/current",
        fields: sheetSyncValue_({ rates: rates, updatedAt: updatedAt }).mapValue.fields
      }
    });
    if (writes.length > 500) throw new Error("Sync exceeds 500 atomic writes; no changes were published.");
    sheetSyncRequest_(baseUrl + ":commit", "post", { writes: writes });
    properties.setProperty("SHEET_SYNC_LAST_SUCCESS", updatedAt);
    properties.deleteProperty("SHEET_SYNC_LAST_ERROR");
    console.log("Published " + Object.keys(drivers).length + " approved drivers and "
      + Object.keys(rates).length + " rates at " + updatedAt);
  } catch (error) {
    properties.setProperty("SHEET_SYNC_LAST_ERROR", String(error));
    console.error("Sheet configuration sync failed:", error);
    throw error;
  } finally {
    lock.releaseLock();
  }
}

function onSheetConfigurationEdit(event) {
  if (event && event.range && ["Rate_Config", "Drivers_Master"].includes(event.range.getSheet().getName())) {
    syncSheetConfiguration();
  }
}

function onSheetConfigurationChange(event) {
  if (event && event.changeType !== "EDIT" && event.changeType !== "FORMAT") syncSheetConfiguration();
}

function installSheetConfigurationTriggers() {
  const id = PropertiesService.getScriptProperties().getProperty("SHEET_SYNC_SPREADSHEET_ID");
  if (!id) throw new Error("Set SHEET_SYNC_SPREADSHEET_ID first.");
  syncSheetConfiguration();
  const handlers = ["onSheetConfigurationEdit", "onSheetConfigurationChange", "syncSheetConfiguration"];
  ScriptApp.getProjectTriggers().forEach(trigger => {
    if (handlers.includes(trigger.getHandlerFunction())) ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger("onSheetConfigurationEdit").forSpreadsheet(id).onEdit().create();
  ScriptApp.newTrigger("onSheetConfigurationChange").forSpreadsheet(id).onChange().create();
  // Formula/import/API changes do not reliably fire spreadsheet edit triggers.
  ScriptApp.newTrigger("syncSheetConfiguration").timeBased().everyMinutes(1).create();
}
