"use strict";

class AppError extends Error {
  constructor(code, message, status = 400, details = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function requireValue(condition, code, message, status = 400, details) {
  if (!condition) throw new AppError(code, message, status, details);
}

function phoneNumber(value) {
  requireValue(typeof value === "string", "INVALID_PHONE", "Enter a valid phone number.");
  let phone = value.replace(/[\s()-]/g, "");
  if (/^09\d{9}$/.test(phone)) phone = "+63" + phone.slice(1);
  else if (/^9\d{9}$/.test(phone)) phone = "+63" + phone;
  else if (/^639\d{9}$/.test(phone)) phone = "+" + phone;
  requireValue(/^\+[1-9]\d{7,14}$/.test(phone), "INVALID_PHONE", "Enter a valid phone number.");
  return phone;
}

module.exports = { AppError, requireValue, phoneNumber };
