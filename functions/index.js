"use strict";
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret, defineString } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { createAuthService } = require("./auth-service");
const { createTripService } = require("./trip-service");
const { AppError, requireValue } = require("./errors");
const { OAuth2Client } = require("google-auth-library");
const { createDriverPinSync, createDriverPinSyncHandler, firestoreUpdateTime } = require("./driver-pin-sync");
const { DRIVER_SECRETS } = require("./pin");
initializeApp();
const db = getFirestore(), auth = getAuth();
const mapsKey = defineSecret("MAPS_SERVER_KEY");
const identityKey = defineString("IDENTITY_WEB_API_KEY");
const allowedOrigins = defineString("APP_ORIGINS", { default: "https://ride2gether.ph,https://www.ride2gether.ph" });
const syncAudience = defineString("SHEET_SYNC_OAUTH_CLIENT_ID", { default: "" });
const syncOperators = defineString("SHEET_SYNC_OPERATOR_EMAILS", { default: "" });
const store = {
  async get(path) { const doc = await db.doc(path).get(); return doc.exists ? doc.data() : null; },
  async atomic(paths, callback) {
    return db.runTransaction(async tx => {
      const unique = [...new Set(paths)];
      const docs = await tx.getAll(...unique.map(path => db.doc(path)));
      const existing = new Map(docs.map((doc, i) => [unique[i], doc.exists ? doc.data() : null]));
      const writes = new Map();
      const value = callback(path => {
        if (!existing.has(path)) throw new Error("Transaction attempted an undeclared read.");
        return existing.get(path);
      }, (path, data) => writes.set(path, data));
      for (const [path, data] of writes) tx.set(db.doc(path), data);
      return value;
    });
  }
};

async function identityRequest(method, body) {
  const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:${method}?key=${identityKey.value()}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000)
  });
  const result = await response.json();
  if (!response.ok) {
    const code = result.error?.message || "";
    if (code.startsWith("INVALID_CODE")) throw new AppError("INVALID_CODE", "Incorrect code.");
    if (/SESSION_EXPIRED|INVALID_SESSION_INFO|CODE_EXPIRED/.test(code)) throw new AppError("EXPIRED", "Code expired.");
    throw new AppError("IDENTITY_UNAVAILABLE", "Verification provider rejected the request.", 503);
  }
  return result;
}
const identity = {
  async sendCode(phoneNumber, recaptchaToken) {
    const result = await identityRequest("sendVerificationCode", { phoneNumber, recaptchaToken });
    requireValue(result.sessionInfo, "SMS_FAILED", "SMS provider did not create a challenge.", 503);
    return result.sessionInfo;
  },
  async confirmCode(sessionInfo, code) {
    const result = await identityRequest("signInWithPhoneNumber", { sessionInfo, code });
    return { uid: result.localId, phone: result.phoneNumber };
  },
  async driverUid(phone) {
    try { return (await auth.getUserByPhoneNumber(phone)).uid; }
    catch (error) {
      if (error.code !== "auth/user-not-found") throw error;
      try { return (await auth.createUser({ phoneNumber: phone })).uid; }
      catch (createError) {
        if (createError.code !== "auth/phone-number-already-exists") throw createError;
        return (await auth.getUserByPhoneNumber(phone)).uid;
      }
    }
  },
  createToken: (uid, claims) => auth.createCustomToken(uid, claims),
  async verifyToken(token) {
    try { return await auth.verifyIdToken(token, true); }
    catch { throw new AppError("SIGN_IN_REQUIRED", "Your session is no longer valid. Please sign in.", 401); }
  }
};
async function route(origin, destination) {
  const location = value => typeof value === "string" ? value : `${value.lat},${value.lng}`;
  const query = new URLSearchParams({ origin: location(origin), destination: location(destination), mode: "driving",
    key: mapsKey.value(), region: "ph" });
  const response = await fetch(`https://maps.googleapis.com/maps/api/directions/json?${query}`, { signal: AbortSignal.timeout(15_000) });
  const result = await response.json();
  requireValue(response.ok && result.status === "OK", "ROUTE_UNAVAILABLE", "Unable to calculate this route. Please retry.", 503);
  const selected = result.routes[0], leg = selected?.legs?.[0];
  requireValue(leg?.distance?.value >= 0 && leg.duration?.value > 0 && selected.overview_polyline?.points,
    "ROUTE_UNAVAILABLE", "The route is incomplete.", 503);
  return { polyline: selected.overview_polyline.points, durationSeconds: leg.duration.value, distanceMeters: leg.distance.value,
    start: leg.start_location, end: leg.end_location };
}
const accounts = createAuthService({ store, identity });
const trips = createTripService({ store, route, stamp: () => FieldValue.serverTimestamp() });
const operatorAuth = new OAuth2Client();
exports.prepareDriverPins = onRequest({
  region: "asia-southeast1", invoker: "public", timeoutSeconds: 300,
  memory: "512MiB", concurrency: 1, maxInstances: 1
}, createDriverPinSyncHandler({
  config: () => ({
    audience: syncAudience.value(),
    operators: syncOperators.value().split(",").map(value => value.trim().toLowerCase()).filter(Boolean)
  }),
  verifyToken: async (token, audience) => (await operatorAuth.verifyIdToken({ idToken: token, audience })).getPayload(),
  prepare: input => createDriverPinSync({
    projectId: process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT,
    readSecrets: async () => {
      const snapshot = await db.collection(DRIVER_SECRETS).get();
      return snapshot.docs.map(doc => ({
        phone: doc.id, credential: doc.data(), updateTime: firestoreUpdateTime(doc.updateTime)
      }));
    }
  })(input)
}));

exports.api = onRequest({ region: "asia-southeast1", secrets: [mapsKey], maxInstances: 5, timeoutSeconds: 60 }, async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.set("Vary", "Origin");
  const origin = req.get("origin");
  if (!allowedOrigins.value().split(",").map(value => value.trim()).includes(origin)) {
    res.status(403).json({ code: "ORIGIN_DENIED", message: "Unapproved application origin." });
    return;
  }
  res.set("Access-Control-Allow-Origin", origin);
  res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  try {
    requireValue(req.method === "POST" && req.is("application/json"), "INVALID_REQUEST", "Use JSON POST requests.", 405);
    requireValue(Buffer.byteLength(JSON.stringify(req.body || {})) <= 16_384, "REQUEST_TOO_LARGE", "Request is too large.", 413);
    requireValue(req.body && typeof req.body === "object" && !Array.isArray(req.body),
      "INVALID_REQUEST", "Use a JSON request object.");
    const { action, payload = {} } = req.body || {};
    requireValue(typeof action === "string" && payload && typeof payload === "object" && !Array.isArray(payload),
      "INVALID_REQUEST", "Provide an operation and a JSON payload object.");
    let result;
    if (action === "otpSend") result = await accounts.sendCode(payload, req.ip);
    else if (action === "otpConfirm") result = await accounts.confirmCode(payload);
    else if (action === "otpStatus") result = await accounts.challengeStatus(payload.challengeId);
    else if (action === "driverLogin") result = await accounts.driverLogin(payload, req.ip);
    else {
      const session = await accounts.authorize(req.get("authorization")?.replace(/^Bearer /, ""));
      const actions = {
        session: () => accounts.sessionInfo(session),
        changePhone: () => accounts.changePhone(session),
        createOrder: () => trips.createOrder(session, payload),
        setOnline: () => trips.setOnline(session, payload.online),
        claimOrder: () => trips.claimOrder(session, payload),
        advanceTrip: () => trips.advance(session, payload),
        cancelOrder: () => trips.cancel(session, payload),
        shareTrip: () => trips.share(session, payload)
      };
      requireValue(Object.hasOwn(actions, action), "UNKNOWN_ACTION", "Unknown operation.", 404);
      result = await actions[action]();
    }
    res.status(200).json({ ...result, serverNow: Date.now() });
  } catch (error) {
    if (!(error instanceof AppError)) console.error("API operation failed", { code: error.code || "internal" });
    res.status(error instanceof AppError ? error.status : 500).json({
      code: error instanceof AppError ? error.code : "INTERNAL",
      message: error instanceof AppError ? error.message : "The operation failed. Please retry.",
      ...(error instanceof AppError ? error.details : {})
    });
  }
});
