const { test } = require("node:test");
const assert = require("node:assert/strict");
process.env.APP_ORIGINS = "http://localhost:4175";
const { api } = require("../functions");

async function request({ method = "POST", origin = process.env.APP_ORIGINS, body = {}, json = true } = {}) {
  const response = {
    headers: {}, statusCode: 200,
    set(key, value) { this.headers[key] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    end() { return this; }
  };
  await api({ method, body, is: () => json, get: key => key === "origin" ? origin : undefined }, response);
  return response;
}
test("HTTP gate enforces exact origins, JSON POST, preflight and no-store without contacting providers", async () => {
  const denied = await request({ origin: "http://localhost:4175.attacker.example" });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.headers["Access-Control-Allow-Origin"], undefined);
  const preflight = await request({ method: "OPTIONS" });
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers["Access-Control-Allow-Origin"], process.env.APP_ORIGINS);
  for (const options of [{ method: "GET" }, { json: false }]) {
    const result = await request(options);
    assert.equal(result.statusCode, 405);
    assert.equal(result.headers["Cache-Control"], "no-store");
  }
});
test("malformed auth payloads and oversized requests are rejected before provider or database access", async () => {
  for (const body of [[], null, { action: "otpSend", payload: null }, { action: "otpSend", payload: [] }]) {
    const result = await request({ body });
    assert.equal(result.statusCode, 400);
    assert.equal(result.body.code, "INVALID_REQUEST");
  }
  const huge = await request({ body: { action: "otpSend", payload: { phone: "x".repeat(17000) } } });
  assert.equal(huge.statusCode, 413);
  const pin = await request({ body: { action: "driverLogin", payload: { phone: "+639171234567", pin: ["123456"] } } });
  assert.equal(pin.body.code, "INVALID_PIN_FORMAT");
  const otp = await request({ body: { action: "otpConfirm", payload: { code: ["123456"] } } });
  assert.equal(otp.body.code, "INVALID_CODE_FORMAT");
  const phone = await request({ body: { action: "otpSend", payload: { phone: ["+639171234567"] } } });
  assert.equal(phone.body.code, "INVALID_PHONE");
  const protectedRequest = await request({ body: { action: "createOrder" } });
  assert.equal(protectedRequest.statusCode, 401);
  assert.equal(protectedRequest.body.code, "SIGN_IN_REQUIRED");
});
