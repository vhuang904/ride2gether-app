"use strict";
const { randomBytes, scrypt, timingSafeEqual } = require("node:crypto");
const { promisify } = require("node:util");
const derive = promisify(scrypt);
const options = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const DRIVER_SECRETS = "driver_auth_secrets";

async function hashPin(pin, salt = randomBytes(16).toString("hex")) {
  if (typeof pin !== "string" || !/^\d{6}$/.test(pin)) throw new Error("A PIN must contain exactly six digits.");
  return { salt, hash: (await derive(pin, salt, 64, options)).toString("hex") };
}

async function verifyPin(pin, record) {
  if (typeof pin !== "string" || !/^\d{6}$/.test(pin)) return false;
  const valid = /^[a-f0-9]{32}$/.test(record?.salt || "") && /^[a-f0-9]{128}$/.test(record?.hash || "");
  const salt = valid ? record.salt : "0".repeat(32);
  const expected = valid ? record.hash : "0".repeat(128);
  const actual = await derive(pin, salt, 64, options);
  return timingSafeEqual(actual, Buffer.from(expected, "hex")) && valid;
}

module.exports = { hashPin, verifyPin, DRIVER_SECRETS };
