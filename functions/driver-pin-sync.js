"use strict";
const { randomUUID } = require("node:crypto");
const { AppError, requireValue, phoneNumber } = require("./errors");
const { hashPin, verifyPin } = require("./pin");

function createDriverPinSync({ projectId, readSecrets }) {
  return async input => {
    requireValue(typeof projectId === "string" && projectId && input?.projectId === projectId,
      "WRONG_PROJECT", "The sync project does not match.", 400);
    requireValue(Array.isArray(input.drivers) && input.drivers.length <= 500,
      "INVALID_ROSTER", "Provide at most 500 approved driver PINs.");
    const drivers = new Map();
    for (const row of input.drivers) {
      const phone = phoneNumber(row?.phone);
      requireValue(!drivers.has(phone), "DUPLICATE_PHONE", "Duplicate driver phone.");
      requireValue(typeof row.pin === "string" && /^\d{6}$/.test(row.pin),
        "INVALID_PIN_FORMAT", "Every driver PIN must contain exactly six digits.");
      drivers.set(phone, row.pin);
    }
    const existing = await readSecrets();
    const previous = new Map(existing.map(record => [record.phone, record]));
    const updates = [], removals = [], checks = [];
    for (const [phone, pin] of drivers) {
      const old = previous.get(phone);
      if (old?.credential.enabled && old.credential.version && await verifyPin(pin, old.credential)) {
        checks.push({ phone, updateTime: old.updateTime });
        continue;
      }
      // Sequential scrypt keeps memory bounded even for a large roster.
      updates.push({ phone, credential: { ...await hashPin(pin), version: randomUUID(), enabled: true },
        updateTime: old?.updateTime || null });
    }
    for (const record of existing) {
      requireValue(phoneNumber(record.phone) === record.phone && record.updateTime,
        "INVALID_SECRET_RECORD", "Repair the private driver records before syncing.", 409);
      if (!drivers.has(record.phone)) removals.push({ phone: record.phone, updateTime: record.updateTime });
    }
    return { projectId, updates, removals, checks };
  };
}

function firestoreUpdateTime(timestamp) {
  return new Date(timestamp.seconds * 1000).toISOString().replace(".000Z",
    "." + String(timestamp.nanoseconds).padStart(9, "0") + "Z");
}

function createDriverPinSyncHandler({ verifyToken, config, prepare }) {
  return async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      requireValue(req.method === "POST" && req.is("application/json"), "INVALID_REQUEST", "Use JSON POST.", 405);
      const { audience, operators } = config();
      requireValue(audience && operators.length, "SYNC_NOT_CONFIGURED", "Driver PIN sync is not configured.", 503);
      const token = req.get("authorization")?.match(/^Bearer (\S+)$/i)?.[1];
      requireValue(token, "SYNC_UNAUTHORIZED", "Operator authentication required.", 401);
      let claims;
      try { claims = await verifyToken(token, audience); }
      catch { throw new AppError("SYNC_UNAUTHORIZED", "Operator authentication failed.", 401); }
      requireValue(claims?.email_verified === true && typeof claims.email === "string"
        && operators.includes(claims.email.toLowerCase()), "SYNC_FORBIDDEN", "This operator cannot sync driver PINs.", 403);
      requireValue(Buffer.byteLength(JSON.stringify(req.body || {})) <= 65_536,
        "REQUEST_TOO_LARGE", "Driver PIN sync request is too large.", 413);
      const result = await prepare(req.body);
      res.status(200).json(result);
    } catch (error) {
      // Never log the request, PINs, tokens, hashes or provider response bodies.
      const known = error instanceof AppError;
      if (!known) console.error("Driver PIN sync failed", { code: "INTERNAL" });
      res.status(known ? error.status : 500).json({
        code: known ? error.code : "INTERNAL",
        message: known ? error.message : "Driver PIN sync failed. No credentials were published."
      });
    }
  };
}
module.exports = { createDriverPinSync, createDriverPinSyncHandler, firestoreUpdateTime };
