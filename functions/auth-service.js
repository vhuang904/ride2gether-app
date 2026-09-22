"use strict";
const { randomBytes, createHash } = require("node:crypto");
const { AppError, requireValue, phoneNumber } = require("./errors");
const { verifyPin, DRIVER_SECRETS } = require("./pin");
const RESEND_MS = 60_000;
const WINDOW_MS = 300_000;
const newId = () => randomBytes(32).toString("hex");
const hash = value => createHash("sha256").update(value).digest("hex");

function createAuthService({ store, identity, now = Date.now, id = newId, checkPin = verifyPin }) {
  const limitPath = phone => `_auth_limits/${hash(phone)}`;
  const driverPath = phone => `drivers/${phone}`;
  const credentialPath = phone => `${DRIVER_SECRETS}/${phone}`;
  const challengePath = challengeId => {
    requireValue(typeof challengeId === "string" && /^[a-f0-9]{64}$/.test(challengeId), "INVALID_CHALLENGE", "Request a new code.");
    return `_auth_challenges/${challengeId}`;
  };
  const publicState = (challenge, limits) => ({
    challengeId: challenge?.id || null,
    expiresAt: challenge?.expiresAt || 0,
    resendAt: limits?.resendAt || 0,
    lockedUntil: limits?.lockedUntil || 0,
    attemptsLeft: Math.max(0, 3 - (challenge?.attempts || 0)),
    serverNow: now()
  });
  const ensureUnlocked = limits => requireValue(
    !(limits.lockedUntil > now()), "COOLDOWN", "Too many incorrect codes. Please wait.",
    429, { lockedUntil: limits.lockedUntil, serverNow: now() }
  );

  async function ipLimit(ip) {
    const path = `_ip_limits/${hash(ip || "unknown")}`;
    await store.atomic([path], (get, put) => {
      const old = get(path) || {};
      const current = old.until > now() ? old : { until: now() + 3_600_000, count: 0 };
      requireValue(current.count < 20, "RATE_LIMITED", "Too many attempts from this connection. Please wait.", 429);
      put(path, { ...current, count: current.count + 1, deleteAfter: new Date(current.until + WINDOW_MS) });
    });
  }

  async function sendCode({ phone: value, recaptchaToken }, ip) {
    const phone = phoneNumber(value);
    requireValue(typeof recaptchaToken === "string" && recaptchaToken.length > 0 && recaptchaToken.length < 20_000,
      "CAPTCHA_REQUIRED", "Complete the anti-abuse check.");
    await ipLimit(ip);
    const challengeId = id();
    const cp = challengePath(challengeId);
    const lp = limitPath(phone);
    const dp = driverPath(phone);
    const started = now();
    const state = await store.atomic([lp, dp], (get, put) => {
      const limits = get(lp) || {};
      ensureUnlocked(limits);
      requireValue(!get(dp), "DRIVER_PIN_REQUIRED", "Registered drivers must sign in with their company PIN.");
      requireValue(!(limits.resendAt > started), "RESEND_WAIT", "Please wait before requesting another code.", 429,
        { resendAt: limits.resendAt, serverNow: started });
      const challenge = {
        id: challengeId, phone, expiresAt: started + WINDOW_MS, attempts: 0,
        status: "sending", sessionInfo: null, deleteAfter: new Date(started + 86_400_000)
      };
      const next = { ...limits, activeChallenge: challengeId, resendAt: started + RESEND_MS };
      put(lp, next);
      put(cp, challenge);
      return publicState(challenge, next);
    });
    try {
      const sessionInfo = await identity.sendCode(phone, recaptchaToken);
      await store.atomic([lp, cp], (get, put) => {
        const challenge = get(cp);
        requireValue(get(lp)?.activeChallenge === challengeId && challenge?.expiresAt > now(),
          "EXPIRED", "This request expired. Request a new code.");
        put(cp, { ...challenge, status: "ready", sessionInfo });
      });
    } catch (error) {
      await store.atomic([cp], (get, put) => {
        const challenge = get(cp);
        if (challenge) put(cp, { ...challenge, status: "failed", sessionInfo: null });
      });
      throw new AppError("SMS_FAILED", "Unable to send a code. Please retry after the countdown.", 503, state);
    }
    return state;
  }

  async function challengeStatus(challengeId) {
    const challenge = await store.get(challengePath(challengeId));
    requireValue(challenge, "EXPIRED", "Request a new code.");
    const limits = await store.get(limitPath(challenge.phone));
    return { ...publicState(challenge, limits),
      active: limits?.activeChallenge === challengeId && challenge.status === "ready" && challenge.expiresAt > now() };
  }

  async function issueToken(sessionId, session) {
    try {
      const token = await identity.createToken(session.uid, { appSessionId: sessionId });
      return { token, phone: session.phone, role: session.role };
    } catch {
      await store.atomic([`_auth_sessions/${sessionId}`], (get, put) => {
        const previous = get(`_auth_sessions/${sessionId}`);
        put(`_auth_sessions/${sessionId}`, { ...previous, revoked: true });
      });
      throw new AppError("SIGN_IN_UNAVAILABLE", session.role === "customer"
        ? "Sign-in could not be completed. Please request a new verification code."
        : "Sign-in could not be completed. Please retry.", 503);
    }
  }

  async function confirmCode({ challengeId, code }) {
    requireValue(typeof code === "string" && /^\d{6}$/.test(code), "INVALID_CODE_FORMAT", "Enter the six-digit verification code.");
    const cp = challengePath(challengeId);
    const initial = await store.get(cp);
    requireValue(initial, "EXPIRED", "Request a new code.");
    const lp = limitPath(initial.phone);
    const ticket = id();
    const sessionInfo = await store.atomic([cp, lp], (get, put) => {
      const c = get(cp);
      const limits = get(lp) || {};
      ensureUnlocked(limits);
      requireValue(c?.status === "ready" && c.expiresAt > now() && limits.activeChallenge === challengeId
        && c.attempts < 3 && c.sessionInfo, "EXPIRED", "This code has expired. Request a new code.");
      requireValue(!(c.verifyingUntil > now()), "BUSY", "Verification is already in progress.", 409);
      put(cp, { ...c, ticket, verifyingUntil: now() + 30_000 });
      return c.sessionInfo;
    });
    let account;
    try {
      account = await identity.confirmCode(sessionInfo, code);
    } catch (error) {
      const invalid = error.code === "INVALID_CODE";
      const expired = error.code === "EXPIRED";
      const details = await store.atomic([cp, lp], (get, put) => {
        const c = get(cp);
        const limits = get(lp) || {};
        requireValue(c?.ticket === ticket, "EXPIRED", "This verification was superseded.");
        const attempts = c.attempts + (invalid ? 1 : 0);
        const exhausted = attempts >= 3;
        const next = { ...limits, ...(exhausted ? { lockedUntil: now() + WINDOW_MS } : {}) };
        const updated = {
          ...c, attempts, verifyingUntil: 0, ticket: null,
          ...(exhausted || expired ? { status: "expired", sessionInfo: null, expiresAt: now() } : {})
        };
        put(cp, updated);
        put(lp, next);
        return publicState(updated, next);
      });
      if (invalid) throw new AppError("INVALID_CODE", "Incorrect verification code.", 400, details);
      if (expired) throw new AppError("EXPIRED", "This code has expired. Request a new code.", 400, details);
      throw new AppError("VERIFY_UNAVAILABLE", "Unable to verify right now. Please retry.", 503, details);
    }
    requireValue(phoneNumber(account.phone) === initial.phone, "IDENTITY_MISMATCH", "Phone verification failed.", 403);
    const sessionId = id();
    const session = { uid: account.uid, phone: initial.phone, role: "customer", revoked: false, createdAt: now() };
    const dp = driverPath(initial.phone);
    await store.atomic([cp, lp, dp], (get, put) => {
      const c = get(cp);
      const limits = get(lp) || {};
      ensureUnlocked(limits);
      requireValue(!get(dp), "DRIVER_PIN_REQUIRED", "Registered drivers must sign in with their company PIN.");
      requireValue(c?.ticket === ticket && c.status === "ready" && c.expiresAt > now()
        && limits.activeChallenge === challengeId, "EXPIRED", "This code has expired. Request a new code.");
      put(cp, { ...c, status: "used", sessionInfo: null, ticket: null, verifyingUntil: 0 });
      put(`_auth_sessions/${sessionId}`, session);
    });
    return issueToken(sessionId, session);
  }

  async function driverLogin({ phone: value, pin }, ip) {
    const phone = phoneNumber(value);
    requireValue(typeof pin === "string" && /^\d{6}$/.test(pin), "INVALID_PIN_FORMAT", "Enter your six-digit driver PIN.");
    await ipLimit(ip);
    const lp = limitPath(phone), dp = driverPath(phone), cp = credentialPath(phone);
    const ticket = id();
    const credential = await store.atomic([lp, cp, dp], (get, put) => {
      const limits = get(lp) || {};
      requireValue(!(limits.pinLockedUntil > now()), "PIN_COOLDOWN", "Too many attempts. Please wait.", 429,
        { lockedUntil: limits.pinLockedUntil, serverNow: now() });
      requireValue(!(limits.pinVerifyingUntil > now()), "BUSY", "Sign-in is already in progress.", 409);
      requireValue(get(dp), "DRIVER_NOT_APPROVED", "This phone has not been approved. Contact operations.", 403);
      requireValue(get(cp), "DRIVER_PIN_NOT_READY", "Your driver PIN has not been synced. Contact operations.", 403);
      requireValue(get(cp).enabled, "DRIVER_REVOKED", "Driver access was revoked. Contact operations.", 403);
      put(lp, { ...limits, pinTicket: ticket, pinVerifyingUntil: now() + 30_000 });
      return get(cp);
    });
    let correct, uid;
    try {
      correct = await checkPin(pin, credential);
      uid = correct ? await identity.driverUid(phone) : null;
    } catch {
      await store.atomic([lp], (get, put) => {
        const limits = get(lp);
        if (limits?.pinTicket === ticket) put(lp, { ...limits, pinTicket: null, pinVerifyingUntil: 0 });
      });
      throw new AppError("SIGN_IN_UNAVAILABLE", "Unable to sign in. Please retry.", 503);
    }
    const sessionId = id();
    const result = await store.atomic([lp, cp, dp], (get, put) => {
      const limits = get(lp) || {};
      requireValue(limits.pinTicket === ticket, "BUSY", "This sign-in was superseded.", 409);
      const active = get(cp);
      const driver = get(dp);
      if (!correct || !active?.enabled || !driver || active.version !== credential?.version) {
        const attempts = (limits.pinAttempts || 0) + 1;
        const lockedUntil = attempts >= 3 ? now() + WINDOW_MS : 0;
        put(lp, { ...limits, pinAttempts: lockedUntil ? 0 : attempts, pinLockedUntil: lockedUntil,
          pinTicket: null, pinVerifyingUntil: 0 });
        return { error: true, lockedUntil };
      }
      if (!["name", "plate", "model"].every(key => typeof driver[key] === "string" && driver[key].trim())) {
        put(lp, { ...limits, pinTicket: null, pinVerifyingUntil: 0 });
        return { incomplete: true };
      }
      const session = { uid, phone, role: "driver", credentialVersion: active.version, revoked: false, createdAt: now() };
      put(`_auth_sessions/${sessionId}`, session);
      put(lp, { ...limits, pinAttempts: 0, pinLockedUntil: 0, pinTicket: null, pinVerifyingUntil: 0 });
      return { session };
    });
    if (result.error) throw new AppError("INVALID_PIN", "Phone or PIN is incorrect.", 401,
      { lockedUntil: result.lockedUntil, serverNow: now() });
    if (result.incomplete) throw new AppError("INCOMPLETE_DRIVER", "Contact operations to complete your registration.", 403);
    return issueToken(sessionId, result.session);
  }

  async function authorize(token) {
    requireValue(token, "SIGN_IN_REQUIRED", "Please sign in first.", 401);
    const claims = await identity.verifyToken(token);
    requireValue(/^[a-f0-9]{64}$/.test(claims.appSessionId || ""), "SIGN_IN_REQUIRED", "Please sign in again.", 401);
    const session = await store.get(`_auth_sessions/${claims.appSessionId}`);
    requireValue(session && !session.revoked && session.uid === claims.uid, "SESSION_REVOKED", "Please sign in again.", 401);
    if (session.role === "driver") {
      const driver = await store.get(driverPath(session.phone));
      const credential = await store.get(credentialPath(session.phone));
      requireValue(driver && credential?.enabled && credential.version === session.credentialVersion,
        "DRIVER_REVOKED", "Driver access was revoked. Contact operations.", 403);
    } else {
      requireValue(!(await store.get(driverPath(session.phone))), "DRIVER_PIN_REQUIRED",
        "This phone is now a registered driver. Sign in with your company PIN.", 403);
    }
    return { ...session, sessionId: claims.appSessionId };
  }

  async function sessionInfo(session) {
    const driver = session.role === "driver" ? await store.get(driverPath(session.phone)) : null;
    const work = await store.get(`_customer_work/${session.uid}`);
    return { phone: session.phone, role: session.role,
      activeOrderId: work?.activeOrderId || null,
      driver: driver ? { id: session.phone, phone: session.phone, name: driver.name, model: driver.model, plate: driver.plate } : null,
      serverNow: now() };
  }

  async function changePhone(session) {
    requireValue(session.role !== "driver" && !(await store.get(driverPath(session.phone))),
      "DRIVER_PHONE_LOCKED", "Driver accounts are bound. Contact operations to change your number.", 403);
    await store.atomic([`_auth_sessions/${session.sessionId}`, `_customer_work/${session.uid}`], (get, put) => {
      requireValue(!get(`_customer_work/${session.uid}`)?.activeOrderId, "ACTIVE_TRIP",
        "Complete or cancel your current trip before changing phone number.", 409);
      const previous = get(`_auth_sessions/${session.sessionId}`);
      put(`_auth_sessions/${session.sessionId}`, { ...previous, revoked: true });
    });
    return { reset: true };
  }

  return { sendCode, confirmCode, challengeStatus, driverLogin, authorize, sessionInfo, changePhone };
}

module.exports = { createAuthService, RESEND_MS, WINDOW_MS };
