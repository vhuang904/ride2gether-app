const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createTelegramClaimHandler } = require("../functions/telegram-claim");

function setup() {
  const h = { config: { audience: "gas", operators: ["operator@example.test"], chatId: "-100000" },
    claims: { email: "operator@example.test", email_verified: true }, drivers: [{ id: "+639171234567" }],
    calls: [], lookups: [], tokenError: false };
  const handler = createTelegramClaimHandler({
    config: () => h.config,
    verifyToken: async (token, audience) => {
      assert.equal(token, "operator-token");
      assert.equal(audience, "gas");
      if (h.tokenError) throw new Error("Invalid signature or expired token");
      return h.claims;
    },
    findDrivers: async id => { h.lookups.push(id); return h.drivers; },
    claim: async input => { h.calls.push(input); return { accepted: true }; }
  });
  h.input = { telegramId: "1234567", chatId: "-100000", messageId: "42", orderId: "OD-telegram1" };
  h.post = async (body = h.input, options = {}) => {
    const response = { set() {}, status(status) { this.statusCode = status; return this; }, json(value) { this.body = value; } };
    await handler({ method: "POST", is: () => true, get: () => "Bearer operator-token", body, ...options }, response);
    return response;
  };
  return h;
}
test("Telegram claim derives the phone from the unique roster match, never a supplied identity", async () => {
  const h = setup();
  assert.equal((await h.post({ ...h.input, phone: "+639199999999", driverName: "Fake" })).statusCode, 200);
  assert.deepEqual(h.lookups, ["1234567"]);
  assert.deepEqual(h.calls, [{ ...h.input, phone: "+639171234567" }]);
});
test("Telegram claim requires verified operator identity and configured audience/chat", async () => {
  const h = setup();
  assert.equal((await h.post(undefined, { get: () => "" })).statusCode, 401);
  h.tokenError = true;
  assert.equal((await h.post()).statusCode, 401);
  h.tokenError = false;
  h.claims.email_verified = false;
  assert.equal((await h.post()).statusCode, 403);
  h.claims = { email: "attacker@example.test", email_verified: true };
  assert.equal((await h.post()).statusCode, 403);
  h.config.audience = "";
  assert.equal((await h.post()).statusCode, 503);
  assert.equal(h.lookups.length, 0);
  assert.equal(h.calls.length, 0);
});
test("Telegram claim refuses malformed callbacks, unrelated chats and non-unique roster links", async () => {
  const h = setup();
  for (const body of [null, [], { ...h.input, telegramId: "../driver" }, { ...h.input, chatId: "-100001" },
    { ...h.input, messageId: "0" }, { ...h.input, orderId: "../order" }]) {
    assert.equal((await h.post(body)).statusCode, 400);
  }
  for (const drivers of [[], [{ id: "one" }, { id: "two" }]]) {
    h.drivers = drivers;
    assert.equal((await h.post()).body.code, "TELEGRAM_NOT_LINKED");
  }
  assert.equal(h.calls.length, 0);
});
