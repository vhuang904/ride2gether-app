"use strict";
const { AppError, requireValue } = require("./errors");

function createTelegramClaimHandler({ config, verifyToken, findDrivers, claim }) {
  return async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      requireValue(req.method === "POST" && req.is("application/json"), "INVALID_REQUEST", "Use JSON POST.", 405);
      const { audience, operators, chatId } = config();
      requireValue(audience && operators.length && /^-\d+$/.test(chatId),
        "DISPATCH_NOT_CONFIGURED", "Telegram dispatch is not configured.", 503);
      const token = req.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
      requireValue(token, "DISPATCH_UNAUTHORIZED", "Dispatch authentication required.", 401);
      let claims;
      try { claims = await verifyToken(token, audience); }
      catch { throw new AppError("DISPATCH_UNAUTHORIZED", "Dispatch authentication failed.", 401); }
      requireValue(claims?.email_verified === true && typeof claims.email === "string"
        && operators.includes(claims.email.toLowerCase()), "DISPATCH_FORBIDDEN", "Unapproved dispatch operator.", 403);
      requireValue(Buffer.byteLength(JSON.stringify(req.body || {})) <= 4096, "REQUEST_TOO_LARGE", "Request is too large.", 413);
      const input = req.body;
      requireValue(input && typeof input === "object" && !Array.isArray(input)
        && typeof input.telegramId === "string" && /^[1-9]\d{0,15}$/.test(input.telegramId)
        && input.chatId === chatId && typeof input.messageId === "string" && /^[1-9]\d{0,15}$/.test(input.messageId)
        && typeof input.orderId === "string" && /^OD-[a-zA-Z0-9-]{6,80}$/.test(input.orderId),
      "INVALID_CALLBACK", "Invalid dispatch callback.");
      const drivers = await findDrivers(input.telegramId);
      requireValue(drivers.length === 1, "TELEGRAM_NOT_LINKED",
        "Your Telegram account is not uniquely linked to an approved driver. Contact operations.", 403);
      const result = await claim({ orderId: input.orderId, telegramId: input.telegramId, chatId,
        messageId: input.messageId, phone: drivers[0].id });
      res.status(200).json(result);
    } catch (error) {
      const known = error instanceof AppError;
      if (!known) console.error("Telegram claim failed", { code: "INTERNAL" });
      res.status(known ? error.status : 500).json({
        code: known ? error.code : "INTERNAL",
        message: known ? error.message : "Unable to confirm this claim. Please retry."
      });
    }
  };
}
module.exports = { createTelegramClaimHandler };
