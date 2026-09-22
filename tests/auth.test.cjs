const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createAuthService } = require("../functions/auth-service");
const { hashPin, verifyPin } = require("../functions/pin");
const { AppError, phoneNumber } = require("../functions/errors");
const { memoryStore } = require("./support/store.cjs");
const phone = "+639171234567";
function setup({ driver = false } = {}) {
  const store = memoryStore(driver ? {
    [`drivers/${phone}`]: { phone, name: "Approved", model: "SUV", plate: "TEST" },
    [`driver_auth_secrets/${phone}`]: { enabled: true, version: "v1" }
  } : {});
  let clock = 1_000_000, counter = 1, resultError = null, providerCalls = 0;
  const identity = {
    sendCode: async () => "private-provider-session",
    confirmCode: async (_, code) => {
      providerCalls++;
      if (resultError) throw resultError;
      if (code !== "123456") throw new AppError("INVALID_CODE", "bad");
      return { uid: "uid-1", phone };
    },
    driverUid: async () => "driver-1",
    createToken: async (uid, claims) => JSON.stringify({ uid, ...claims }),
    verifyToken: async token => JSON.parse(token)
  };
  const service = createAuthService({ store, identity, now: () => clock, id: () => (counter++).toString(16).padStart(64, "0"),
    checkPin: async (pin, credential) => Boolean(credential) && pin === "654321" });
  return { service, store, identity, tick: ms => { clock += ms; }, now: () => clock,
    fail: error => { resultError = error; }, calls: () => providerCalls,
    send: () => service.sendCode({ phone, recaptchaToken: "captcha" }, "127.0.0.1"),
    login: pin => service.driverLogin({ phone, pin: pin || "654321" }, "127.0.0.1") };
}
test("phone IDs normalize PH forms and reject invalid or path-bearing input", () => {
  for (const value of ["0917-123-4567", "9171234567", "639171234567", "+63 (917) 1234567"]) assert.equal(phoneNumber(value), phone);
  for (const value of ["abc", "../drivers", "+0000000000"]) assert.throws(() => phoneNumber(value));
});
test("PIN hashes are salted, never plaintext, and verify with scrypt", async () => {
  const a = await hashPin("654321"), b = await hashPin("654321");
  assert.notEqual(a.hash, b.hash);
  assert.equal(await verifyPin("654321", a), true);
  assert.equal(await verifyPin("123456", a), false);
  assert.equal(await verifyPin("654321", null), false);
  await assert.rejects(hashPin("123"));
});
test("SMS resend reservation is atomic, lasts 60 seconds and keeps provider session private", async () => {
  const h = setup();
  const results = await Promise.allSettled([h.send(), h.send()]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  const first = results.find(r => r.status === "fulfilled").value;
  assert.equal(first.resendAt - h.now(), 60_000);
  assert.equal(first.expiresAt - h.now(), 300_000);
  assert.equal(JSON.stringify(first).includes("private-provider-session"), false);
  h.tick(59_999);
  await assert.rejects(h.send(), { code: "RESEND_WAIT" });
  h.tick(1);
  await h.send();
});
test("three wrong OTPs destroy app challenge and enforce 300-second server cooldown across new requests", async () => {
  const h = setup(), sent = await h.send();
  for (const remaining of [2, 1, 0]) {
    await assert.rejects(h.service.confirmCode({ challengeId: sent.challengeId, code: "000000" }), error => {
      assert.equal(error.code, "INVALID_CODE"); assert.equal(error.details.attemptsLeft, remaining); return true;
    });
  }
  assert.equal(h.store.docs.get(`_auth_challenges/${sent.challengeId}`).sessionInfo, null);
  assert.equal((await h.service.challengeStatus(sent.challengeId)).active, false);
  await assert.rejects(h.service.confirmCode({ challengeId: sent.challengeId, code: "123456" }), { code: "COOLDOWN" });
  h.tick(299_999);
  await assert.rejects(h.send(), { code: "COOLDOWN" });
  h.tick(1);
  assert.ok((await h.send()).challengeId);
});
test("OTP expires exactly at 300 seconds and a resend invalidates the previous challenge", async () => {
  const h = setup(), first = await h.send();
  h.tick(60_000);
  const second = await h.send();
  await assert.rejects(h.service.confirmCode({ challengeId: first.challengeId, code: "123456" }), { code: "EXPIRED" });
  h.tick(300_000);
  await assert.rejects(h.service.confirmCode({ challengeId: second.challengeId, code: "123456" }), { code: "EXPIRED" });
  assert.equal(h.calls(), 0);
});
test("parallel OTP verification permits one redemption and rejects replay after success", async () => {
  const h = setup(), sent = await h.send();
  const results = await Promise.allSettled([1, 2].map(() => h.service.confirmCode({ challengeId: sent.challengeId, code: "123456" })));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(h.calls(), 1);
  const result = results.find(r => r.status === "fulfilled").value;
  assert.equal((await h.service.authorize(result.token)).phone, phone);
  await assert.rejects(h.service.confirmCode({ challengeId: sent.challengeId, code: "123456" }), { code: "EXPIRED" });
});
test("provider failures do not consume OTP guesses, but sending failures preserve resend cooldown", async () => {
  const h = setup(), sent = await h.send();
  h.fail(new Error("network"));
  await assert.rejects(h.service.confirmCode({ challengeId: sent.challengeId, code: "123456" }), { code: "VERIFY_UNAVAILABLE" });
  assert.equal((await h.service.challengeStatus(sent.challengeId)).attemptsLeft, 3);
  h.fail(null);
  await h.service.confirmCode({ challengeId: sent.challengeId, code: "123456" });
  const other = setup();
  other.identity.sendCode = async () => { throw new Error("network"); };
  await assert.rejects(other.send(), { code: "SMS_FAILED" });
  await assert.rejects(other.send(), { code: "RESEND_WAIT" });
});
test("raw Firebase identity tokens cannot bypass app challenge authorization", async () => {
  const h = setup();
  await assert.rejects(h.service.authorize(JSON.stringify({ uid: "uid-1", phone_number: phone })), { code: "SIGN_IN_REQUIRED" });
});
test("driver requires both PIN and current whitelist; credentials alone never authorize", async () => {
  const h = setup({ driver: true });
  await assert.rejects(h.login("000000"), { code: "INVALID_PIN" });
  const token = (await h.login()).token;
  h.tick(86_400_000 * 30);
  const session = await h.service.authorize(token);
  assert.equal(session.role, "driver");
  h.store.docs.delete(`drivers/${phone}`);
  await assert.rejects(h.service.authorize(token), { code: "DRIVER_REVOKED" });
  await assert.rejects(h.login(), { code: "DRIVER_NOT_APPROVED" });
});
test("PIN rotation or disabled credentials immediately invalidate old sessions", async () => {
  const h = setup({ driver: true }), result = await h.login();
  h.store.docs.set(`driver_auth_secrets/${phone}`, { enabled: true, version: "v2" });
  await assert.rejects(h.service.authorize(result.token), { code: "DRIVER_REVOKED" });
  const second = await h.login();
  h.store.docs.set(`driver_auth_secrets/${phone}`, { enabled: false, version: "v2" });
  await assert.rejects(h.service.authorize(second.token), { code: "DRIVER_REVOKED" });
});
test("drivers cannot use passenger OTP or change their phone", async () => {
  const h = setup({ driver: true });
  await assert.rejects(h.send(), { code: "DRIVER_PIN_REQUIRED" });
  const session = await h.service.authorize((await h.login()).token);
  await assert.rejects(h.service.changePhone(session), { code: "DRIVER_PHONE_LOCKED" });
});
test("passenger change-phone revokes session; active booking prevents orphaning an order", async () => {
  const h = setup(), sent = await h.send();
  const result = await h.service.confirmCode({ challengeId: sent.challengeId, code: "123456" });
  const session = await h.service.authorize(result.token);
  h.store.docs.set("_customer_work/uid-1", { activeOrderId: "OD-active" });
  await assert.rejects(h.service.changePhone(session), { code: "ACTIVE_TRIP" });
  h.store.docs.delete("_customer_work/uid-1");
  await h.service.changePhone(session);
  await assert.rejects(h.service.authorize(result.token), { code: "SESSION_REVOKED" });
});
test("PIN provider failure releases verification lease for a genuine retry", async () => {
  const h = setup({ driver: true });
  h.identity.driverUid = async () => { throw new Error("network"); };
  await assert.rejects(h.login(), { code: "SIGN_IN_UNAVAILABLE" });
  h.identity.driverUid = async () => "driver-1";
  await h.login();
});
test("PIN brute-force locks after three failures and recovers after cooldown", async () => {
  const h = setup({ driver: true });
  for (let i = 0; i < 3; i++) await assert.rejects(h.login("000000"), { code: "INVALID_PIN" });
  await assert.rejects(h.login(), { code: "PIN_COOLDOWN" });
  h.tick(300_000);
  await h.login();
});
test("failed custom-token signing revokes its orphaned session and reports failure", async () => {
  const h = setup({ driver: true });
  h.identity.createToken = async () => { throw new Error("signing unavailable"); };
  await assert.rejects(h.login(), { code: "SIGN_IN_UNAVAILABLE" });
  const sessions = [...h.store.docs].filter(([key]) => key.startsWith("_auth_sessions/"));
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0][1].revoked, true);
});
test("approved drivers without a synced PIN cannot self-enroll through login", async () => {
  const h = setup({ driver: true });
  h.store.docs.delete(`driver_auth_secrets/${phone}`);
  await assert.rejects(h.login(), { code: "DRIVER_PIN_NOT_READY" });
  assert.equal(h.store.docs.has(`driver_auth_secrets/${phone}`), false);
  assert.equal([...h.store.docs.keys()].some(key => key.startsWith("_auth_sessions/")), false);
});
