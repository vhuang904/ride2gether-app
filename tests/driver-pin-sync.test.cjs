const { test } = require("node:test");
const assert = require("node:assert/strict");
const { generateKeyPairSync, sign } = require("node:crypto");
const { OAuth2Client } = require("../functions/node_modules/google-auth-library");
const { createDriverPinSync, createDriverPinSyncHandler, firestoreUpdateTime } = require("../functions/driver-pin-sync");
const { createAuthService } = require("../functions/auth-service");
const { hashPin, verifyPin } = require("../functions/pin");
const { memoryStore } = require("./support/store.cjs");
const phone = "+639171234567", projectId = "demo-ride2gether";
const updateTime = "2026-09-21T05:00:00.123456000Z";
const input = pin => ({ projectId, drivers: [{ phone: "09171234567", pin }] });

test("operator sync salts six-digit PINs, preserves leading zeros and prepares without database writes", async () => {
  const prepare = createDriverPinSync({ projectId, readSecrets: async () => [] });
  const a = await prepare(input("004321")), b = await prepare(input("004321"));
  assert.equal(a.updates[0].phone, phone);
  assert.equal(a.updates[0].updateTime, null);
  assert.equal(a.updates[0].credential.enabled, true);
  assert.equal(await verifyPin("004321", a.updates[0].credential), true);
  assert.notEqual(a.updates[0].credential.salt, b.updates[0].credential.salt);
  assert.notEqual(a.updates[0].credential.version, b.updates[0].credential.version);
  assert.deepEqual(Object.keys(a.updates[0].credential).sort(), ["enabled", "hash", "salt", "version"]);
  assert.equal(JSON.stringify(a).includes('"pin"'), false);
});
test("unchanged PINs retain sessions; rotation and removal revoke previously issued credentials", async () => {
  const store = memoryStore({ [`drivers/${phone}`]: { phone, name: "Approved", plate: "TEST", model: "Sedan" } });
  const path = `driver_auth_secrets/${phone}`;
  const prepare = createDriverPinSync({ projectId, readSecrets: async () => store.docs.has(path)
    ? [{ phone, credential: store.docs.get(path), updateTime }] : [] });
  const apply = result => {
    result.updates.forEach(row => store.docs.set(`driver_auth_secrets/${row.phone}`, row.credential));
    result.removals.forEach(row => store.docs.delete(`driver_auth_secrets/${row.phone}`));
  };
  apply(await prepare(input("004321")));
  const accounts = createAuthService({ store, identity: {
    driverUid: async () => "driver",
    createToken: async (uid, claims) => JSON.stringify({ uid, ...claims }),
    verifyToken: async token => JSON.parse(token)
  } });
  const first = await accounts.driverLogin({ phone, pin: "004321" }, "test");
  const unchanged = await prepare(input("004321"));
  assert.deepEqual(unchanged.updates, []);
  assert.deepEqual(unchanged.checks, [{ phone, updateTime }]);
  apply(unchanged);
  assert.equal((await accounts.authorize(first.token)).role, "driver");
  const rotated = await prepare(input("765432"));
  assert.equal(rotated.updates[0].updateTime, updateTime);
  apply(rotated);
  await assert.rejects(accounts.authorize(first.token), { code: "DRIVER_REVOKED" });
  await assert.rejects(accounts.driverLogin({ phone, pin: "004321" }, "test"), { code: "INVALID_PIN" });
  const second = await accounts.driverLogin({ phone, pin: "765432" }, "test");
  apply(await prepare({ projectId, drivers: [] }));
  store.docs.delete(`drivers/${phone}`);
  await assert.rejects(accounts.authorize(second.token), { code: "DRIVER_REVOKED" });
  await assert.rejects(accounts.driverLogin({ phone, pin: "765432" }, "test"), { code: "DRIVER_NOT_APPROVED" });
});
test("restoring an approved disabled credential rotates its version even with the same PIN", async () => {
  const credential = { ...await hashPin("654321"), enabled: false, version: "old-version" };
  const prepare = createDriverPinSync({ projectId, readSecrets: async () => [{ phone, credential, updateTime }] });
  const result = await prepare(input("654321"));
  assert.equal(result.updates[0].credential.enabled, true);
  assert.notEqual(result.updates[0].credential.version, credential.version);
  assert.equal(result.updates[0].updateTime, updateTime);
});
test("invalid PINs, duplicate phones, wrong projects and oversized rosters fail before reading secrets", async () => {
  let reads = 0;
  const prepare = createDriverPinSync({ projectId, readSecrets: async () => { reads++; return []; } });
  for (const pin of ["", "123", "1234567", "12ab56", 123456, null, ["654321"]]) {
    await assert.rejects(prepare(input(pin)), { code: "INVALID_PIN_FORMAT" });
    await assert.rejects(hashPin(pin));
    assert.equal(await verifyPin(pin, null), false);
  }
  await assert.rejects(prepare({ ...input("123456"), projectId: "other-project" }), { code: "WRONG_PROJECT" });
  await assert.rejects(prepare({ projectId, drivers: [{ phone, pin: "654321" }, { phone: "09171234567", pin: "123456" }] }),
    { code: "DUPLICATE_PHONE" });
  await assert.rejects(prepare({ projectId, drivers: Array(501).fill({ phone, pin: "654321" }) }), { code: "INVALID_ROSTER" });
  assert.equal(reads, 0);
});
test("Firestore preconditions preserve sub-millisecond update precision", () => {
  assert.equal(firestoreUpdateTime({ seconds: 0, nanoseconds: 123456000 }), "1970-01-01T00:00:00.123456000Z");
  assert.equal(firestoreUpdateTime({ seconds: 1, nanoseconds: 1000 }), "1970-01-01T00:00:01.000001000Z");
});

function request(handler, { method = "POST", json = true, token = "operator", body = input("654321") } = {}) {
  const result = { headers: {}, status: null, body: null };
  const req = { method, is: type => json && type === "application/json", body,
    get: name => name === "authorization" && token ? `Bearer ${token}` : undefined };
  const res = { set: (key, value) => { result.headers[key] = value; },
    status: status => { result.status = status; return res; }, json: body => { result.body = body; } };
  return handler(req, res).then(() => result);
}
test("PIN preparation fails closed without operator config and rejects invalid HTTP bodies before preparation", async () => {
  let preparations = 0, configured = false;
  const handler = createDriverPinSyncHandler({
    config: () => ({ audience: configured ? "script-client" : "", operators: ["operator@example.test"] }),
    verifyToken: async () => ({ email: "operator@example.test", email_verified: true }),
    prepare: async () => { preparations++; return {}; }
  });
  assert.equal((await request(handler)).status, 503);
  configured = true;
  assert.equal((await request(handler, { method: "GET" })).status, 405);
  assert.equal((await request(handler, { method: "OPTIONS" })).status, 405);
  assert.equal((await request(handler, { json: false })).status, 405);
  assert.equal((await request(handler, { token: null })).status, 401);
  assert.equal((await request(handler, { body: { padding: "x".repeat(65_537) } })).status, 413);
  assert.equal(preparations, 0);
});
test("real Google verifier enforces signature, issuer, expiry, audience and approved verified operator email", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const client = new OAuth2Client();
  // Replace only Google's certificate fetch; signature/claims verification remains real.
  client.getFederatedSignonCertsAsync = async () => ({ certs: { test: publicKey.export({ type: "spki", format: "pem" }) } });
  const now = Math.floor(Date.now() / 1000), audience = "script-client.apps.googleusercontent.com";
  const token = changes => {
    const payload = { iss: "https://accounts.google.com", aud: audience, sub: "operator",
      email: "operator@example.test", email_verified: true, iat: now - 60, exp: now + 3600, ...changes };
    const unsigned = [JSON.stringify({ alg: "RS256", kid: "test" }), JSON.stringify(payload)]
      .map(value => Buffer.from(value).toString("base64url")).join(".");
    return unsigned + "." + sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url");
  };
  let preparations = 0;
  const handler = createDriverPinSyncHandler({
    config: () => ({ audience, operators: ["operator@example.test"] }),
    verifyToken: async (idToken, expected) => (await client.verifyIdToken({ idToken, audience: expected })).getPayload(),
    prepare: async () => { preparations++; return { projectId, updates: [], checks: [], removals: [] }; }
  });
  for (const claims of [{ aud: "another-client" }, { iss: "https://example.test" }, { exp: now - 600 }]) {
    assert.equal((await request(handler, { token: token(claims) })).status, 401);
  }
  assert.equal((await request(handler, { token: token({}) + "tampered" })).status, 401);
  assert.equal((await request(handler, { token: "firebase-driver-token" })).status, 401);
  for (const claims of [{ email: "stranger@example.test" }, { email_verified: false }]) {
    assert.equal((await request(handler, { token: token(claims) })).status, 403);
  }
  assert.equal(preparations, 0);
  const result = await request(handler, { token: token({}) });
  assert.equal(result.status, 200);
  assert.equal(result.headers["Cache-Control"], "no-store");
  assert.equal(result.headers["Access-Control-Allow-Origin"], undefined);
  assert.equal(preparations, 1);
});
