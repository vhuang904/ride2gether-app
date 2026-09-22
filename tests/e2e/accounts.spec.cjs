const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const { createAuthService } = require("../../functions/auth-service");
const { createTripService } = require("../../functions/trip-service");
const { createDriverPinSync } = require("../../functions/driver-pin-sync");
const { AppError } = require("../../functions/errors");
const { memoryStore } = require("../support/store.cjs");
const phone = "+639171234567";
const sdk = fs.readFileSync(path.join(__dirname, "../support/browser-firebase.js"), "utf8");
function encode(points) {
  let lat = 0, lng = 0, result = "";
  function number(delta) {
    let value = delta < 0 ? ~(delta << 1) : delta << 1;
    while (value >= 32) { result += String.fromCharCode((32 | (value & 31)) + 63); value >>= 5; }
    result += String.fromCharCode(value + 63);
  }
  for (const point of points) {
    const a = Math.round(point.lat * 1e5), b = Math.round(point.lng * 1e5);
    number(a - lat); number(b - lng); lat = a; lng = b;
  }
  return result;
}
async function setup(context, { driver = false, driverPin = "654321" } = {}) {
  const store = memoryStore();
  const requests = [];
  let clock = Date.now();
  const rate = { nameEn: "Moto Express", base: 40, baseKm: 2, perKm: 10, surgeMultiplier: 1.5,
    surgeFlat: 20, convenienceFee: 30, commType: "PERCENT", commVal: 0.15 };
  store.docs.set("rate_config/current", { rates: { RIDE_MOTO: rate } });
  if (driver) {
    store.docs.set(`drivers/${phone}`, { phone, name: "Roster Driver", model: "Sedan", plate: "TEST 1" });
    if (driverPin) {
      const prepare = createDriverPinSync({ projectId: "demo-ride2gether", readSecrets: async () => [] });
      const result = await prepare({ projectId: "demo-ride2gether", drivers: [{ phone, pin: driverPin }] });
      store.docs.set(`driver_auth_secrets/${phone}`, result.updates[0].credential);
    }
  }
  const identity = {
    sendCode: async () => "server-only-session",
    confirmCode: async (_, code) => {
      if (code !== "123456") throw new AppError("INVALID_CODE", "Incorrect code.");
      return { uid: "customer", phone };
    },
    driverUid: async () => "driver",
    createToken: async (uid, claims) => JSON.stringify({ uid, ...claims }),
    verifyToken: async token => JSON.parse(token)
  };
  const accounts = createAuthService({ store, identity, now: () => clock });
  const trips = createTripService({ store, now: () => clock, route: async (origin, destination) => ({
    polyline: typeof origin === "object" ? encode([origin, destination]) : "_p~iF~ps|U_ulLnnqC_mqNvxq`@", distanceMeters: 5000, durationSeconds: 100,
    start: { lat: 38.5, lng: -120.2 }, end: { lat: 43.252, lng: -126.453 }
  }) });
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.hostname === "127.0.0.1" && url.pathname === "/__test/firestore") {
      const key = url.searchParams.get("path"), filters = JSON.parse(url.searchParams.get("filters"));
      const isDoc = key.split("/").length % 2 === 0;
      const entry = key => ({ id: key.split("/").at(-1), exists: store.docs.has(key), value: store.docs.get(key) });
      const docs = [...store.docs.keys()].filter(k => k.startsWith(key + "/") && k.split("/").length === key.split("/").length + 1)
        .filter(k => filters.every(([field, , value]) => store.docs.get(k)[field] === value))
        .slice(0, Number(url.searchParams.get("count"))).map(entry);
      await route.fulfill({ json: isDoc ? entry(key) : { docs } }); return;
    }
    if (url.hostname === "127.0.0.1") { await route.continue(); return; }
    if (url.hostname.endsWith("cloudfunctions.net")) {
      const { action, payload } = route.request().postDataJSON();
      requests.push({ action, payload });
      try {
        let value;
        if (action === "driverLogin") value = await accounts.driverLogin(payload, "test");
        else if (action === "otpSend") value = await accounts.sendCode(payload, "test");
        else if (action === "otpConfirm") value = await accounts.confirmCode(payload);
        else if (action === "otpStatus") value = await accounts.challengeStatus(payload.challengeId);
        else {
          const session = await accounts.authorize(route.request().headers().authorization?.slice(7));
          if (action === "session") value = await accounts.sessionInfo(session);
          else if (action === "changePhone") value = await accounts.changePhone(session);
          else if (action === "setOnline") value = await trips.setOnline(session, payload.online);
          else if (action === "claimOrder") value = await trips.claimOrder(session, payload);
          else if (action === "advanceTrip") value = await trips.advance(session, payload);
          else if (action === "createOrder") value = await trips.createOrder(session, payload);
          else throw new Error("Unmocked action: " + action);
        }
        await route.fulfill({ json: { ...value, serverNow: clock } });
      } catch (error) {
        await route.fulfill({ status: error.status || 500, json: { code: error.code, message: error.message, ...error.details, serverNow: clock } });
      }
      return;
    }
    if (url.pathname.endsWith("firebase-app-compat.js")) {
      await route.fulfill({ contentType: "text/javascript", body: sdk }); return;
    }
    await route.fulfill({ contentType: route.request().resourceType() === "stylesheet" ? "text/css" : "text/javascript", body: "" });
  });
  await context.addInitScript(() => {
    window.addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent = ".hidden{display:none!important}input,button{min-height:32px}#profileModal{background:white}";
      document.head.appendChild(style);
    });
    window.__gpsCalls = 0;
    Object.defineProperty(navigator, "geolocation", { value: {
      getCurrentPosition(callback) { window.__gpsCalls++; callback({ coords: { latitude: 10.3, longitude: 123.8 } }); }
    } });
  });
  return { store, requests, tick: ms => { clock += ms; }, trips };
}
async function loginDriver(page, entry = "/index.html", pin = "654321") {
  await page.goto(entry);
  if (entry === "/index.html") await page.evaluate(() => openProfileModal());
  await page.locator("#prefPhone").fill("09171234567");
  await page.locator("#btnDriverSignIn").click();
  await page.locator("#driverPin").fill(pin);
  await page.locator("#btnConfirmPin").click();
}
test("driver PIN, long-lived reload, locked phone in both modes and online/pause without logout", async ({ page, context }) => {
  const h = await setup(context, { driver: true });
  await loginDriver(page);
  await expect(page.locator("#prefPhone")).toHaveAttribute("readonly", "");
  await expect(page.locator("#btnChangePhone")).toBeHidden();
  await expect(page.locator("#phoneBindingNotice")).toContainText("司機帳號綁定");
  await page.evaluate(() => closeProfileModal());
  await page.locator("#btnSwitchMode").click();
  await expect(page.locator("#driverView")).toBeVisible();
  await page.locator("#btnDriverAvailability").click();
  await expect(page.locator("#btnDriverAvailability")).toContainText("Online");
  await page.locator("#btnDriverAvailability").click();
  await expect(page.locator("#btnDriverAvailability")).toContainText("Paused");
  await page.locator("#btnSwitchMode").click();
  await page.evaluate(() => openProfileModal());
  await expect(page.locator("#prefPhone")).toHaveValue(phone);
  await expect(page.locator("#prefPhone")).toHaveAttribute("readonly", "");
  await page.reload();
  await expect(page.locator("#btnSwitchMode")).toBeVisible();
  await page.evaluate(() => openProfileModal());
  await expect(page.locator("#accountLoginControls")).toBeHidden();
  expect(h.requests.filter(r => r.action === "driverLogin")).toHaveLength(1);
  expect(await page.evaluate(() => localStorage.getItem("r2g_bound_identity"))).toContain(phone);
});
test("first login uses the in-person Sheet PIN including leading zeros and survives reopening the page", async ({ page, context }) => {
  const h = await setup(context, { driver: true, driverPin: "004321" });
  await loginDriver(page, "/driver.html", "004321");
  await expect(page.locator("#driverView")).toBeVisible();
  await expect(page.locator("#driverPin")).toHaveValue("");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("r2g_bound_identity")))).toEqual({ phone, role: "driver" });
  await page.close();
  h.tick(86_400_000);
  const next = await context.newPage();
  await next.goto("/driver.html");
  await expect(next.locator("#driverView")).toBeVisible();
  await expect(next.locator("#prefPhone")).toHaveAttribute("readonly", "");
  await expect(next.locator("#btnChangePhone")).toBeHidden();
  expect(h.requests.filter(r => r.action === "driverLogin")).toHaveLength(1);
  expect(h.requests.some(r => r.action === "otpSend" || /setPin/i.test(r.action))).toBe(false);
});
test("three wrong driver PINs lock for 300 seconds across reload before accepting the registered PIN", async ({ page, context }) => {
  const h = await setup(context, { driver: true });
  await page.clock.install();
  await loginDriver(page, "/driver.html", "000000");
  await expect(page.locator("#accountStatus")).toContainText("incorrect");
  for (let i = 0; i < 2; i++) {
    await page.locator("#driverPin").fill("000000");
    await page.locator("#btnConfirmPin").click();
    await expect(page.locator("#driverPin")).toHaveValue("");
  }
  await expect(page.locator("#btnConfirmPin")).toBeDisabled();
  await page.reload();
  await page.locator("#btnDriverSignIn").click();
  await expect(page.locator("#driverPin")).toBeDisabled();
  h.tick(299_000);
  await page.clock.fastForward(299_000);
  await expect(page.locator("#btnConfirmPin")).toBeDisabled();
  h.tick(1000);
  await page.clock.fastForward(1000);
  await expect(page.locator("#btnConfirmPin")).toBeEnabled();
  await page.locator("#prefPhone").fill("09171234567");
  await page.locator("#driverPin").fill("654321");
  await page.locator("#btnConfirmPin").click();
  await expect(page.locator("#driverView")).toBeVisible();
  expect(h.requests.filter(r => r.action === "driverLogin")).toHaveLength(4);
});
test("unapproved and approved-but-unsynced phones show red operations errors without mobile enrollment", async ({ page, context }) => {
  const h = await setup(context);
  await loginDriver(page);
  await expect(page.locator("#accountStatus")).toHaveText("該門號尚未開通司機權限，請洽營運團隊辦理");
  await expect(page.locator("#accountStatus")).toHaveClass(/text-red-600/);
  await expect(page.locator("#btnSwitchMode")).toBeHidden();
  h.store.docs.set(`drivers/${phone}`, { phone, name: "Approved", plate: "TEST", model: "Sedan" });
  await page.locator("#driverPin").fill("654321");
  await page.locator("#btnConfirmPin").click();
  await expect(page.locator("#accountStatus")).toHaveText("司機密碼尚未同步，請洽營運團隊確認登記資料");
  expect(h.store.docs.has(`driver_auth_secrets/${phone}`)).toBe(false);
  await expect(page.locator('input[type="password"]')).toHaveCount(1);
  expect(h.requests.some(r => r.action === "otpSend")).toBe(false);
});
test("OTP countdown survives reload; third error locks input and resend for full five minutes", async ({ page, context }) => {
  const h = await setup(context);
  await page.clock.install();
  await page.goto("/index.html");
  await page.evaluate(() => openProfileModal());
  await page.locator("#prefPhone").fill("09171234567");
  await page.locator("#btnSendOtp").click();
  await expect(page.locator("#btnSendOtp")).toBeDisabled();
  await expect(page.locator("#otpFields")).toBeVisible();
  await page.reload();
  await page.evaluate(() => openProfileModal());
  await expect(page.locator("#btnSendOtp")).toBeDisabled();
  for (const text of ["剩餘 2 次", "剩餘 1 次", "已作廢"]) {
    await page.locator("#otpCode").fill("000000");
    await page.locator("#btnConfirmOtp").click();
    await expect(page.locator("#accountStatus")).toContainText(text);
  }
  await expect(page.locator("#otpCode")).toBeDisabled();
  await expect(page.locator("#btnSendOtp")).toBeDisabled();
  h.tick(299_000);
  await page.clock.fastForward(299_000);
  await expect(page.locator("#btnSendOtp")).toBeDisabled();
  h.tick(2000);
  await page.clock.fastForward(2000);
  await expect(page.locator("#btnSendOtp")).toBeEnabled();
  expect(h.requests.filter(r => r.action === "otpSend")).toHaveLength(1);
});
test("passenger verification locks phone and confirmed number change resets only application data", async ({ page, context }) => {
  await setup(context);
  await page.goto("/index.html");
  await page.evaluate(() => { localStorage.setItem("unrelated_preference", "keep"); openProfileModal(); });
  await page.locator("#prefPhone").fill("09171234567");
  await page.locator("#btnSendOtp").click();
  await expect(page.locator("#otpFields")).toBeVisible();
  await page.locator("#otpCode").fill("123456");
  await page.locator("#btnConfirmOtp").click();
  await expect(page.locator("#btnChangePhone")).toBeVisible();
  await expect(page.locator("#prefPhone")).toHaveAttribute("readonly", "");
  page.once("dialog", dialog => dialog.accept());
  const reloaded = page.waitForEvent("domcontentloaded");
  await page.locator("#btnChangePhone").click();
  await reloaded;
  await page.waitForFunction(() => typeof openProfileModal === "function");
  await expect(page.locator("#identityBadge")).toHaveText("Guest");
  await page.evaluate(() => openProfileModal());
  await expect(page.locator("#prefPhone")).toHaveValue("");
  await expect(page.locator("#prefPhone")).not.toHaveAttribute("readonly", "");
  expect(await page.evaluate(() => localStorage.getItem("r2g_bound_identity"))).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem("test_firebase_auth"))).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem("unrelated_preference"))).toBe("keep");
});
test("OTP attempts and cooldown synchronize between tabs without a status-request echo loop", async ({ page, context }) => {
  const h = await setup(context);
  context.on("request", request => {
    if (request.url().includes("cloudfunctions.net") && request.method() === "POST"
        && request.postDataJSON().action === "otpStatus") h.tick(1);
  });
  await page.goto("/index.html");
  await page.evaluate(() => openProfileModal());
  await page.locator("#prefPhone").fill("09171234567");
  await page.locator("#btnSendOtp").click();
  await expect(page.locator("#otpFields")).toBeVisible();
  const second = await context.newPage();
  await second.goto("/index.html");
  await second.evaluate(() => openProfileModal());
  await expect(second.locator("#otpCode")).toBeEnabled();
  for (const text of ["剩餘 2 次", "剩餘 1 次", "已作廢"]) {
    await page.locator("#otpCode").fill("000000");
    await page.locator("#btnConfirmOtp").click();
    await expect(page.locator("#accountStatus")).toContainText(text);
  }
  await expect(second.locator("#btnSendOtp")).toBeDisabled();
  await expect(second.locator("#otpCode")).toBeDisabled();
  await expect(second.locator("#otpCountdown")).toContainText("Try again");
  await second.waitForTimeout(400);
  expect(h.requests.filter(r => r.action === "otpStatus").length).toBeLessThanOrEqual(5);
  expect(await second.evaluate(() => localStorage.getItem("r2g_otp_challenge"))).not.toContain("serverNow");
});
test("fake localStorage driver role never reveals driver mode without backend sign-in", async ({ page, context }) => {
  await setup(context, { driver: true });
  await page.addInitScript(() => {
    localStorage.setItem("user_role", "driver");
    localStorage.setItem("r2g_bound_identity", JSON.stringify({ role: "driver", phone: "+639171234567" }));
    localStorage.setItem("guest_phone", "+639171234567");
  });
  await page.goto("/driver.html");
  await expect(page.locator("#driverView")).toBeHidden();
  await expect(page.locator("#accountLoginControls")).toBeVisible();
});
test("claim performs one GPS read; paused active driver completes both phases with fixed settlement", async ({ page, context }) => {
  const h = await setup(context, { driver: true });
  const customer = { uid: "passenger", phone: "+639171234599", role: "customer", sessionId: "c".repeat(64), revoked: false };
  h.store.docs.set(`_auth_sessions/${customer.sessionId}`, customer);
  await h.trips.createOrder(customer, {
    orderId: "OD-browser1", category: "mobility", serviceId: "RIDE_MOTO", origin: "Pickup", destination: "Airport",
    itemCost: 0, tip: 0, totalPay: 155
  });
  await loginDriver(page, "/driver.html");
  await expect(page.locator("#driverView")).toBeVisible();
  await page.evaluate(() => {
    window.__mapPaths = [];
    window.__vehiclePosition = null;
    window.google = { maps: {
      Map: class { fitBounds() {} panToBounds() {} },
      LatLngBounds: class { extend() {} },
      event: { trigger() {} },
      Polyline: class {
        setPath(points) { window.__mapPaths.push(points); }
        setMap() {}
      },
      Marker: class {
        getPosition() { return window.__vehiclePosition ? { toJSON: () => window.__vehiclePosition } : null; }
        setPosition(point) { window.__vehiclePosition = point; }
        setMap() {}
      }
    } };
  });
  await page.locator("#btnDriverAvailability").click();
  await page.locator(".claim-order").click();
  await expect(page.locator("#activeTripContainer")).toBeVisible();
  await expect(page.locator("#driverPickupNavigation")).toHaveAttribute("href", /destination=38.5,-120.2/);
  await expect.poll(() => page.evaluate(() => window.__mapPaths.at(-1)?.length)).toBe(2);
  await page.locator("#btnDriverAvailability").click();
  await expect(page.locator("#btnDriverAvailability")).toContainText("Paused");
  await page.locator("#activeTripAction").click();
  await expect(page.locator("#activeTripStatus")).toHaveText("arrived");
  await expect.poll(() => page.evaluate(() => window.__vehiclePosition)).toEqual({ lat: 38.5, lng: -120.2 });
  await page.evaluate(() => { window.open = () => null; });
  await page.locator("#activeTripAction").click();
  await expect(page.locator("#activeTripStatus")).toHaveText("in progress");
  await expect.poll(() => page.evaluate(() => window.__mapPaths.at(-1)?.length)).toBe(3);
  await page.locator("#activeTripAction").click();
  await expect(page.locator("#driverSettlement")).toBeVisible();
  await expect(page.locator("#settlementTotal")).toHaveText("₱155.00");
  await expect(page.locator("#settlementEarnings")).toHaveText("₱114.50");
  expect(await page.evaluate(() => window.__gpsCalls)).toBe(1);
  expect(h.requests.filter(r => r.action === "claimOrder")).toHaveLength(1);
  expect(h.requests.filter(r => r.action === "advanceTrip").map(r => r.payload.status)).toEqual(["arrived", "in_progress", "completed"]);
});
