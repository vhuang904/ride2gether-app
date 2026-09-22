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
async function setup(context, { driver = false, driverPin = "654321", store = memoryStore(), customerPhone = phone } = {}) {
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
      return { uid: "customer", phone: customerPhone };
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
  if (entry === "/index.html") await page.locator("#btnDriverSignIn").click();
  await page.locator("#driverPin").fill(pin);
  await page.locator("#btnConfirmPin").click();
}
test("driver PIN, long-lived reload, locked phone in both modes and online/pause without logout", async ({ page, context }) => {
  const h = await setup(context, { driver: true });
  await loginDriver(page);
  await expect(page.locator("#prefPhone")).toHaveAttribute("readonly", "");
  await expect(page.locator("#btnChangePhone")).toBeHidden();
  await expect(page.locator("#phoneBindingNotice")).toHaveCount(0);
  await expect(page.locator("#verifiedDriverBadge")).toBeVisible();
  await expect(page.locator("#verifiedDriverBadge")).toContainText("Verified Driver");
  await expect(page.locator("#driverAccessStatus")).toBeHidden();
  await expect(page.getByText("Check fleet registration", { exact: true })).toHaveCount(0);
  await page.evaluate(() => closeProfileModal());
  await page.locator("#btnSwitchMode").click();
  await expect(page.locator("#driverView")).toBeVisible();
  await page.locator("#btnDriverAvailability").click();
  await expect(page.locator("#btnDriverAvailability")).toContainText("Online");
  await page.locator("#btnDriverAvailability").click();
  await expect(page.locator("#btnDriverAvailability")).toContainText("Paused");
  await page.evaluate(() => openProfileModal());
  await page.getByRole("button", { name: "Ride History", exact: true }).click();
  await expect(page.locator("#driverOrderHistoryModal")).toBeVisible();
  await expect(page.locator("#driverOrderHistoryList")).not.toHaveText("Loading order history...");
  await page.locator("#driverOrderHistoryModal").getByRole("button", { name: "Close history" }).click();
  await expect(page.locator("#driverView")).toHaveAttribute("inert", "");
  await page.evaluate(() => closeProfileModal());
  await expect(page.locator("#driverView")).not.toHaveAttribute("inert", "");
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
test("passenger and driver account forms and verification widgets use English", async ({ page, context }) => {
  await setup(context);
  for (const entry of ["/index.html", "/driver.html"]) {
    await page.goto(entry);
    if (entry === "/index.html") await page.evaluate(() => openProfileModal());
    if (entry === "/index.html") {
      await expect(page.locator("#accountHeading")).toHaveText("Passenger Sign In");
      await expect(page.locator("#driverPin")).toBeHidden();
      await expect(page.locator("#btnDriverSignIn")).toHaveText("Registered Driver? Sign in with PIN");
      await page.locator("#btnDriverSignIn").click();
    }
    await expect(page.locator("#accountHeading")).toHaveText("Driver Sign In");
    await expect(page.locator("#btnSendOtp")).toBeHidden();
    await expect(page.locator("#driverPinFields")).toContainText(
      "Enter the 6-digit driver PIN registered at our office. Contact the operations team to change your PIN.");
    await expect(page.locator("#driverPin")).toHaveAttribute("placeholder", "6-digit driver PIN");
    await expect(page.locator("#btnSendOtp")).toHaveText("Send verification code");
    await expect(page.locator("#btnChangePhone")).toHaveText("Change phone number");
    expect(await page.locator("#accountControls").textContent()).not.toMatch(/\p{Script=Han}/u);
    expect(await page.evaluate(() => firebase.auth().languageCode)).toBe("en");
  }
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
  await expect(page.locator("#driverPin")).toBeVisible();
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
  await expect(page.locator("#accountStatus")).toHaveText("This phone number is not approved for Driver Mode. Contact the operations team.");
  await expect(page.locator("#accountStatus")).toHaveClass(/text-red-600/);
  await expect(page.locator("#btnSwitchMode")).toBeHidden();
  h.store.docs.set(`drivers/${phone}`, { phone, name: "Approved", plate: "TEST", model: "Sedan" });
  await page.locator("#driverPin").fill("654321");
  await page.locator("#btnConfirmPin").click();
  await expect(page.locator("#accountStatus")).toHaveText("Your driver PIN has not been synced yet. Contact the operations team to confirm your registration.");
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
  for (const text of ["2 attempts remaining.", "1 attempt remaining.", "Verification code invalidated."]) {
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
  page.once("dialog", async dialog => {
    expect(dialog.message()).toBe("Change phone number? This signs you out and clears this device's saved profile, places and trip cache.");
    await dialog.accept();
  });
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

async function seedSignOutStorage(page) {
  await page.evaluate(() => {
    for (const storage of [localStorage, sessionStorage]) {
      storage.setItem("r2g_test_token", "old-token");
      storage.setItem("ride2gether_driver", "old-driver");
      storage.setItem("guest_private_phone", "+639171234567");
      storage.setItem("user_role", "driver");
      storage.setItem("firebase:authUser:obsolete:test", "old-token");
      storage.setItem("unrelated_preference", "keep");
    }
  });
}

async function expectSignedOutHome(page) {
  await expect(page).toHaveURL(/\/index\.html$/);
  await expect(page.locator("#identityBadge")).toHaveText("Guest");
  await expect(page.locator("#headerMemberName")).toHaveText("VIP Guest");
  await expect(page.locator("#profileModal")).toBeHidden();
  await expect(page.locator("#driverView")).toBeHidden();
  await expect(page.locator("#btnSwitchMode")).toBeHidden();
  await expect(page.locator("#btnSignOut")).toBeHidden();
  await expect(page.locator("#verifiedDriverBadge")).toBeHidden();
  await expect(page.locator("body")).toHaveAttribute("data-app-mode", "passenger");
  await expect(page.locator("#prefPhone")).toHaveValue("");
  await expect(page.locator("#prefPhone")).not.toHaveAttribute("readonly", "");
  expect(await page.evaluate(() => ({
    session: accountAuth.getSession(), firebaseUser: firebase.auth().currentUser,
    binding: localStorage.getItem("r2g_bound_identity"), token: localStorage.getItem("test_firebase_auth")
  }))).toEqual({ session: null, firebaseUser: null, binding: null, token: null });
  expect(await page.evaluate(() => [localStorage, sessionStorage].map(storage => ({
    token: storage.getItem("r2g_test_token"), driver: storage.getItem("ride2gether_driver"),
    phone: storage.getItem("guest_private_phone"), oldAuth: storage.getItem("firebase:authUser:obsolete:test"),
    driverRole: storage.getItem("user_role") === "driver", unrelated: storage.getItem("unrelated_preference")
  })))).toEqual(Array(2).fill({ token: null, driver: null, phone: null, oldAuth: null, driverRole: false, unrelated: "keep" }));
}

test("passenger Sign Out clears device identity and closes the profile without changing driver availability", async ({ page, context }) => {
  const h = await setup(context);
  await page.goto("/index.html");
  await page.evaluate(() => openProfileModal());
  await expect(page.locator("#btnSignOut")).toBeHidden();
  await loginPassenger(page);
  await expect(page.locator("#verifiedDriverBadge")).toBeHidden();
  await expect(page.locator("#btnSignOut")).toBeVisible();
  await seedSignOutStorage(page);
  const reloaded = page.waitForEvent("domcontentloaded");
  await page.locator("#btnSignOut").click();
  await reloaded;
  await expectSignedOutHome(page);
  expect(h.requests.some(request => ["setOnline", "changePhone", "cancelOrder"].includes(request.action))).toBe(false);
  await page.reload();
  await expectSignedOutHome(page);
});

for (const mode of ["passenger", "driver", "standalone"]) {
  test(`driver Sign Out from ${mode} confirms offline before clearing credentials and returns to guest home`, async ({ page, context }) => {
    const h = await setup(context, { driver: true });
    h.store.docs.set(`_driver_work/${phone}`, { online: true, activeOrderId: "OD-EXISTING-TRIP" });
    await loginDriver(page, mode === "standalone" ? "/driver.html" : "/index.html");
    await expect(page.locator("#prefPhone")).toHaveAttribute("readonly", "");
    if (mode !== "standalone") {
      await expect(page.locator("#verifiedDriverBadge")).toBeVisible();
      if (mode === "driver") {
        await page.evaluate(() => closeProfileModal());
        await page.locator("#btnSwitchMode").click();
        await expect(page.locator("#driverView")).toBeVisible();
        await page.evaluate(() => openProfileModal());
      }
    }
    await seedSignOutStorage(page);
    const reloaded = page.waitForEvent("domcontentloaded");
    await page.locator("#btnSignOut").click();
    await reloaded;
    await expectSignedOutHome(page);
    expect(h.store.docs.get(`_driver_work/${phone}`)).toEqual({ online: false, activeOrderId: "OD-EXISTING-TRIP" });
    expect(h.requests.filter(request => request.action === "setOnline")).toEqual([{ action: "setOnline", payload: { online: false } }]);
    expect(h.requests.some(request => ["changePhone", "cancelOrder", "advanceTrip"].includes(request.action))).toBe(false);
    await page.reload();
    await expectSignedOutHome(page);
  });
}

for (const entry of ["/index.html", "/driver.html"]) {
test(`driver sign-out failure is visible and retryable without bypassing offline acknowledgement (${entry})`, async ({ page, context }) => {
  const h = await setup(context, { driver: true });
  h.store.docs.set(`_driver_work/${phone}`, { online: true });
  await loginDriver(page, entry);
  await expect(page.locator("#btnSignOut")).toBeVisible();
  await expect(page.locator("#prefPhone")).toHaveAttribute("readonly", "");
  let pending;
  const requested = new Promise(resolve => { pending = resolve; });
  let attempts = 0;
  await context.route("https://*.cloudfunctions.net/api", async route => {
    if (route.request().postDataJSON().action === "setOnline" && attempts++ === 0) {
      pending(route);
      return;
    }
    await route.fallback();
  });
  await page.locator("#btnSignOut").click();
  const failed = await requested;
  await expect(page.locator("#btnSignOut")).toBeDisabled();
  await expect(page.locator("#btnSignOut")).toHaveText("Signing out...");
  await page.evaluate(() => accountAuth.signOut());
  expect(attempts).toBe(1);
  await failed.fulfill({ status: 503, json: { code: "UNAVAILABLE", message: "Offline update failed." } });
  const notice = page.locator(entry === "/driver.html" ? "#driverNotice" : "#accountStatus");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("Unable to sign out. Reconnect and try again");
  await expect(page.locator("#btnSignOut")).toBeEnabled();
  expect(h.store.docs.get(`_driver_work/${phone}`).online).toBe(true);
  expect(await page.evaluate(() => accountAuth.isDriver())).toBe(true);
  await seedSignOutStorage(page);
  const reloaded = page.waitForEvent("domcontentloaded");
  await page.locator("#btnSignOut").click();
  await reloaded;
  await expectSignedOutHome(page);
  expect(h.store.docs.get(`_driver_work/${phone}`).online).toBe(false);
});
}

test("revoked driver credentials remain removable without showing a verified badge", async ({ page, context }) => {
  const h = await setup(context, { driver: true });
  await loginDriver(page);
  await expect(page.locator("#verifiedDriverBadge")).toBeVisible();
  h.store.docs.delete(`drivers/${phone}`);
  await page.evaluate(() => window.__refreshFirestore());
  await expect(page.locator("#verifiedDriverBadge")).toBeHidden();
  await expect(page.locator("#driverAccessStatus")).toContainText("no longer available");
  await expect(page.locator("#btnSignOut")).toBeVisible();
  await seedSignOutStorage(page);
  const reloaded = page.waitForEvent("domcontentloaded");
  await page.locator("#btnSignOut").click();
  await reloaded;
  await expectSignedOutHome(page);
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
  for (const text of ["2 attempts remaining.", "1 attempt remaining.", "Verification code invalidated."]) {
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
for (const entry of ["/index.html", "/driver.html"]) {
  test(`idle driver controls stay below the header without reserving map space (${entry})`, async ({ page, context }) => {
    await setup(context, { driver: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await loginDriver(page, entry);
    if (entry === "/index.html") {
      await page.evaluate(() => closeProfileModal());
      await page.locator("#btnSwitchMode").click();
    }
    await expect(page.locator("#driverView")).toBeVisible();
    // External Tailwind is mocked; reproduce its root flex utilities for this layout regression.
    await page.addStyleTag({ content: `
      body { margin: 0; }
      :where(body).min-h-screen { min-height: 100vh; }
      :where(body).flex { display: flex; }
      :where(body).flex-col { flex-direction: column; }
      :where(body).justify-between { justify-content: space-between; }
      body > header svg { width: 20px; height: 20px; }
      body > header img { width: 40px; height: 40px; }
    ` });
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      for (const state of ["Paused", "Online", "Paused"]) {
        if (await page.locator("#btnDriverAvailability").getAttribute("aria-pressed") !== String(state === "Online")) {
          await page.locator("#btnDriverAvailability").click();
        }
        await expect(page.locator("#btnDriverAvailability")).toContainText(state);
        await expect(page.locator("#activeTripContainer")).toBeHidden();
        await expect(page.locator("#driverTripMap")).toBeHidden();
        const bounds = await page.evaluate(() => ({
          gap: document.getElementById("btnDriverAvailability").getBoundingClientRect().top
            - document.querySelector("body > header").getBoundingClientRect().bottom,
          mapHeight: document.getElementById("driverTripMap").getBoundingClientRect().height
        }));
        expect(bounds.gap).toBeGreaterThanOrEqual(0);
        expect(bounds.gap).toBeLessThanOrEqual(32);
        expect(bounds.mapHeight).toBe(0);
      }
    }
    expect(await page.evaluate(() => window.__gpsCalls)).toBe(0);
    if (entry === "/index.html") {
      await page.evaluate(() => toggleAppMode());
      await expect(page.locator("#passengerView")).toBeVisible();
      expect(await page.evaluate(() => getComputedStyle(document.body).justifyContent)).toBe("space-between");
    }
  });
}
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
  await expect(page.locator("#activeTripAction")).toHaveText("I have arrived at pickup");
  await expect(page.locator("#driverPickupNavigation")).toBeVisible();
  await expect(page.locator("#driverPickupNavigation")).toHaveAttribute("href", /destination=38.5,-120.2/);
  await expect.poll(() => page.evaluate(() => window.__mapPaths.at(-1)?.length)).toBe(2);
  await page.locator("#btnDriverAvailability").click();
  await expect(page.locator("#btnDriverAvailability")).toContainText("Paused");
  await page.locator("#activeTripAction").click();
  await expect(page.locator("#activeTripStatus")).toHaveText("arrived");
  await expect(page.locator("#activeTripAction")).toHaveText("Passenger on board / Start Trip");
  await expect(page.locator("#driverPickupNavigation")).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.__vehiclePosition)).toEqual({ lat: 38.5, lng: -120.2 });
  await page.evaluate(() => { window.open = () => null; });
  await page.locator("#activeTripAction").click();
  await expect(page.locator("#activeTripStatus")).toHaveText("in progress");
  await expect(page.locator("#activeTripAction")).toHaveText("Complete Trip");
  await expect.poll(() => page.evaluate(() => window.__mapPaths.at(-1)?.length)).toBe(3);
  await page.locator("#activeTripAction").click();
  await expect(page.locator("#driverSettlement")).toBeVisible();
  await expect(page.locator("#activeTripContainer")).toBeHidden();
  await expect(page.locator("#driverTripMap")).toBeHidden();
  await expect(page.locator("#settlementTotal")).toHaveText("₱155.00");
  await expect(page.locator("#settlementEarnings")).toHaveText("₱114.50");
  expect(await page.evaluate(() => window.__gpsCalls)).toBe(1);
  expect(h.requests.filter(r => r.action === "claimOrder")).toHaveLength(1);
  expect(h.requests.filter(r => r.action === "advanceTrip").map(r => r.payload.status)).toEqual(["arrived", "in_progress", "completed"]);
});
test("Telegram links preserve PIN and online gates and never claim or request GPS automatically", async ({ page, context }) => {
  const h = await setup(context, { driver: true });
  const customer = { uid: "passenger", phone: "+639171234599", role: "customer", sessionId: "d".repeat(64), revoked: false };
  h.store.docs.set(`_auth_sessions/${customer.sessionId}`, customer);
  await h.trips.createOrder(customer, {
    orderId: "OD-telegram1", category: "mobility", serviceId: "RIDE_MOTO", origin: "Pickup", destination: "Airport",
    itemCost: 0, tip: 0, totalPay: 155
  });
  await page.goto("/driver.html?order=OD-telegram1");
  await expect(page.locator("#driverView")).toBeHidden();
  expect(await page.evaluate(() => window.__gpsCalls)).toBe(0);
  await loginDriver(page, "/driver.html?order=OD-telegram1");
  await expect(page.locator("#driverView")).toBeVisible();
  await expect(page.locator("#btnDriverAvailability")).toContainText("Paused");
  await expect(page.locator(".claim-order")).toHaveCount(0);
  await page.locator("#btnDriverAvailability").click();
  await expect(page.locator('[data-order-card-id="OD-telegram1"]')).toContainText("Opened from Telegram");
  expect(h.requests.filter(r => r.action === "claimOrder")).toHaveLength(0);
  expect(await page.evaluate(() => window.__gpsCalls)).toBe(0);
  await page.locator(".claim-order").click();
  await expect(page.locator("#activeTripContainer")).toBeVisible();
  expect(h.requests.filter(r => r.action === "claimOrder")).toHaveLength(1);
  expect(await page.evaluate(() => window.__gpsCalls)).toBe(1);
});

async function loginPassenger(page, customerPhone = phone) {
  await page.goto("/index.html");
  await page.evaluate(() => openProfileModal());
  await page.locator("#prefPhone").fill(customerPhone);
  await page.locator("#btnSendOtp").click();
  await page.locator("#otpCode").fill("123456");
  await page.locator("#btnConfirmOtp").click();
  await expect(page.locator("#accountLoginControls")).toBeHidden();
}

test("booking shows only the inclusive total and automatically reconnects prices without a fee card", async ({ page, context }) => {
  await setup(context);
  let reads = 0;
  await context.route("**/__test/firestore?**", async route => {
    if (new URL(route.request().url()).searchParams.get("path") === "rate_config/current" && ++reads === 1) {
      await route.fulfill({ status: 503, body: "Temporary test outage" });
    } else await route.fallback();
  });
  await page.clock.install();
  await page.goto("/index.html");
  await expect(page.locator("#rateStatus")).toHaveText("Reconnecting to current prices...");
  await expect(page.locator("#estTotal")).toHaveText("--");
  await page.clock.fastForward(1000);
  await expect(page.locator("#estTotal")).toHaveText("110.00");
  await expect(page.locator("#rateStatus")).toBeHidden();
  expect(reads).toBe(2);
  await expect(page.locator("#estConvenienceFee")).toHaveCount(0);
  await expect(page.getByText(/Platform booking fee|Refresh connection/)).toHaveCount(0);
  expect(await page.locator("#estTotal").evaluate(node =>
    node.closest("section").nextElementSibling.id)).toBe("btnSubmit");
  await page.evaluate(() => { document.getElementById("distance").value = "5"; calculateEstimate(); });
  await expect(page.locator("#estTotal")).toHaveText("155.00");
  expect(await page.evaluate(() => calculateEstimate().convenienceFee)).toBe(30);
});

test("only an authenticated roster driver sees a one-row 44px header mode icon", async ({ page, context }) => {
  const h = await setup(context);
  await page.addInitScript(() => localStorage.setItem("user_role", "driver"));
  await page.goto("/index.html");
  await expect(page.locator("#btnSwitchMode")).toBeHidden();
  await loginPassenger(page);
  await page.evaluate(() => closeProfileModal());
  await expect(page.locator("#btnSwitchMode")).toBeHidden();

  h.store.docs.set(`drivers/${phone}`, { phone, name: "Roster Driver", model: "Sedan", plate: "TEST 1" });
  await page.evaluate(() => checkDriverWhitelist());
  await expect(page.locator("#btnSwitchMode")).toBeHidden();
  const prepare = createDriverPinSync({ projectId: "demo-ride2gether", readSecrets: async () => [] });
  const prepared = await prepare({ projectId: "demo-ride2gether", drivers: [{ phone, pin: "654321" }] });
  h.store.docs.set(`driver_auth_secrets/${phone}`, prepared.updates[0].credential);
  await page.evaluate(() => firebase.auth().signOut());
  await loginDriver(page);
  await page.evaluate(() => {
    closeProfileModal();
    currentUserProfile.name = "Wei Lun Huang with a longer family name";
    updateHeaderProfileUI();
  });
  await expect(page.locator("#btnSwitchMode")).toBeVisible();
  await expect(page.locator("#btnSwitchMode")).toHaveAccessibleName("Switch to Driver Mode");
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    const bounds = await page.evaluate(() => {
      const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
      return { mode: rect("#btnSwitchMode"), avatar: rect(".header-profile-button"),
        identity: rect(".header-identity"), actions: rect(".header-account-actions"),
        inHeader: Boolean(document.querySelector("body > header #btnSwitchMode")) };
    });
    expect(bounds.inHeader).toBe(true);
    expect(bounds.mode.width).toBe(44);
    expect(bounds.mode.height).toBe(44);
    expect(bounds.mode.top).toBe(bounds.avatar.top);
    expect(bounds.mode.left).toBeGreaterThanOrEqual(bounds.identity.right);
    expect(bounds.avatar.right).toBeLessThanOrEqual(bounds.actions.right + 1);
    expect(bounds.actions.right).toBeLessThanOrEqual(width);
  }
  await page.locator("#btnSwitchMode").click();
  await expect(page.locator("#driverView")).toBeVisible();
  await expect(page.locator("#btnSwitchMode")).toHaveAccessibleName("Switch to Passenger Mode");
  await page.locator("#btnSwitchMode").click();
  h.store.docs.delete(`drivers/${phone}`);
  await page.evaluate(() => window.__refreshFirestore());
  await expect(page.locator("#btnSwitchMode")).toBeHidden();
  await expect(page.locator("#passengerView")).toBeVisible();
});

async function mockTripMap(page, passenger = false) {
  await page.evaluate(passenger => {
    window.__mapPaths = [];
    window.__vehiclePosition = null;
    window.google = { maps: {
      Map: class { fitBounds() {} panToBounds() {} setOptions() {} },
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
    if (passenger) mapInstance = new google.maps.Map();
    window.open = () => null;
  }, passenger);
}

test("ARRIVED snaps both clients, notifies a minimized passenger, and requires Start Trip before delivery", async ({ page, context, browser }) => {
  const h = await setup(context, { driver: true });
  const customerPhone = "+639171234599";
  const passengerContext = await browser.newContext({ baseURL: "http://127.0.0.1:4175", serviceWorkers: "block" });
  try {
    await setup(passengerContext, { store: h.store, customerPhone });
    const passenger = await passengerContext.newPage();
    await loginPassenger(passenger, customerPhone);
    await passenger.evaluate(() => closeProfileModal());
    await mockTripMap(passenger, true);
    const customer = { uid: "customer", phone: customerPhone, role: "customer", sessionId: "e".repeat(64), revoked: false };
    h.store.docs.set(`_auth_sessions/${customer.sessionId}`, customer);
    await h.trips.createOrder(customer, {
      orderId: "OD-arrival1", category: "mobility", serviceId: "RIDE_MOTO", origin: "Pickup", destination: "Airport",
      itemCost: 0, tip: 0, totalPay: 155
    });
    await passenger.evaluate(() => { currentOrderId = "OD-arrival1"; subscribeToOrder(currentOrderId); });
    await loginDriver(page, "/driver.html");
    await mockTripMap(page);
    await page.locator("#btnDriverAvailability").click();
    await page.locator(".claim-order").click();
    await expect(page.locator("#activeTripAction")).toHaveText("I have arrived at pickup");
    await expect(page.locator("#driverPickupNavigation")).toHaveAttribute("href", /destination=38.5,-120.2/);
    await passenger.evaluate(() => window.__refreshFirestore());
    await expect(passenger.locator("#activeTripTitle")).toHaveText("Driver accepted your trip");
    for (const client of [page, passenger]) {
      await expect.poll(() => client.evaluate(() => window.__mapPaths.at(-1)?.length)).toBe(2);
    }
    await passenger.locator("#btnMinimizeTrip").click();
    await expect(passenger.locator("#activeTripPanel")).toBeHidden();
    await page.locator("#activeTripAction").click();
    await expect(page.locator("#activeTripStatus")).toHaveText("arrived");
    await expect(page.locator("#activeTripAction")).toHaveText("Passenger on board / Start Trip");
    await expect(page.locator("#driverPickupNavigation")).toBeHidden();
    await passenger.evaluate(() => window.__refreshFirestore());
    await expect(passenger.locator("#tripArrivalNotice")).toBeVisible();
    await expect(passenger.getByRole("alert")).toHaveText("Your driver has arrived at the pickup point. Please proceed to your ride.");
    await expect(passenger.locator("#activeTripPanel")).toBeHidden();
    for (const client of [page, passenger]) {
      await expect.poll(() => client.evaluate(() => window.__vehiclePosition)).toEqual({ lat: 38.5, lng: -120.2 });
    }
    expect(h.store.docs.get("ride_orders/OD-arrival1/trip_state/current").phase).toBe("waiting");
    expect(h.requests.filter(r => r.action === "advanceTrip").map(r => r.payload.status)).toEqual(["arrived"]);
    await passenger.locator("#tripFloatingBubble").click();
    await expect(passenger.locator("#activeTripPanel")).toBeVisible();
    await expect(passenger.locator("#tripArrivalNotice")).toBeVisible();
    await page.locator("#activeTripAction").click();
    await expect(page.locator("#activeTripStatus")).toHaveText("in progress");
    await passenger.evaluate(() => window.__refreshFirestore());
    await expect(passenger.locator("#tripArrivalNotice")).toBeHidden();
    await expect(passenger.locator("#activeTripTitle")).toHaveText("Heading to destination");
    for (const client of [page, passenger]) {
      await expect.poll(() => client.evaluate(() => window.__mapPaths.at(-1)?.length)).toBe(3);
    }
    await page.locator("#activeTripAction").click();
    await expect(page.locator("#driverSettlement")).toBeVisible();
    await passenger.evaluate(() => window.__refreshFirestore());
    await expect(passenger.locator("#activeTripTitle")).toHaveText("Trip Completed");
    await expect(passenger.locator("#tripArrivalNotice")).toBeHidden();
    expect(h.requests.filter(r => r.action === "advanceTrip").map(r => r.payload.status)).toEqual(["arrived", "in_progress", "completed"]);
    expect(await page.evaluate(() => window.__gpsCalls)).toBe(1);
    expect(await passenger.evaluate(() => window.__gpsCalls)).toBe(0);
  } finally {
    await passengerContext.close();
  }
});

test("passenger-first login switches explicitly without resetting OTP limits or revealing driver access", async ({ page, context }) => {
  const h = await setup(context);
  await page.goto("/index.html");
  await page.evaluate(() => openProfileModal());
  await expect(page.locator("#accountHeading")).toHaveText("Passenger Sign In");
  await expect(page.locator("#driverPin")).toBeHidden();
  await expect(page.locator("#prefName")).toBeHidden();
  await expect(page.locator("#prefHome")).toBeHidden();
  await expect(page.locator("#driverRegistrationControls")).toHaveCount(0);
  await page.locator("#prefPhone").fill("09171234567");
  await page.locator("#btnSendOtp").click();
  await expect(page.locator("#otpFields")).toBeVisible();
  const challenge = await page.evaluate(() => localStorage.getItem("r2g_otp_challenge"));
  await page.locator("#btnDriverSignIn").click();
  await expect(page.locator("#accountHeading")).toHaveText("Driver Sign In");
  await expect(page.locator("#btnSendOtp")).toBeHidden();
  await expect(page.locator("#otpCode")).toBeHidden();
  await page.locator("#driverPin").fill("004321");
  await page.locator("#btnPassengerSignIn").click();
  await expect(page.locator("#driverPin")).toHaveValue("");
  await expect(page.locator("#driverPin")).toBeHidden();
  await expect(page.locator("#btnSendOtp")).toBeDisabled();
  expect(await page.evaluate(() => localStorage.getItem("r2g_otp_challenge"))).toBe(challenge);
  expect(h.requests.filter(r => r.action === "otpSend")).toHaveLength(1);
  expect(h.requests.some(r => r.action === "driverLogin")).toBe(false);
  await page.evaluate(() => { closeProfileModal(); toggleAppMode(); });
  await expect(page.locator("#accountHeading")).toHaveText("Driver Sign In");
  await expect(page.locator("#driverView")).toBeHidden();
  await page.evaluate(() => { closeProfileModal(); openProfileModal(); });
  await expect(page.locator("#accountHeading")).toHaveText("Passenger Sign In");
});

test("pending SMS verification cannot switch forms or issue a PIN request", async ({ page, context }) => {
  const h = await setup(context);
  await page.goto("/index.html");
  await page.evaluate(() => {
    openProfileModal();
    firebase.auth.RecaptchaVerifier = class {
      verify() { return new Promise(resolve => { window.__finishCaptcha = resolve; }); }
      clear() {}
    };
  });
  await page.locator("#prefPhone").fill("09171234567");
  await page.locator("#btnSendOtp").click();
  await expect(page.locator("#btnDriverSignIn")).toBeDisabled();
  await page.evaluate(() => {
    accountAuth.setLoginMode("driver");
    document.getElementById("btnConfirmPin").click();
    window.__finishCaptcha("captcha");
  });
  await expect(page.locator("#otpFields")).toBeVisible();
  await expect(page.locator("#accountHeading")).toHaveText("Passenger Sign In");
  expect(h.requests.some(r => r.action === "driverLogin")).toBe(false);
});

test("profile and history use available width and the header puts the name above verification", async ({ page, context }) => {
  await setup(context);
  await loginPassenger(page);
  await page.evaluate(() => {
    currentUserProfile.name = "Wei Lun Huang with a longer family name";
    updateHeaderProfileUI();
  });
  await expect(page.locator("#driverRegistrationControls")).toHaveCount(0);
  await expect(page.locator("#prefName")).toBeVisible();
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    const bounds = await page.evaluate(() => {
      const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
      const grid = document.querySelector(".profile-grid");
      return { viewport: innerWidth, panel: rect("#profileModal .profile-panel"),
        name: rect("#headerMemberName"), badge: rect("#identityBadge"),
        actions: rect(".header-account-actions"),
        columns: getComputedStyle(grid).gridTemplateColumns.split(" ").length,
        overflow: grid.scrollWidth > grid.clientWidth };
    });
    expect(bounds.name.bottom).toBeLessThanOrEqual(bounds.badge.top + 1);
    expect(bounds.actions.right).toBeLessThanOrEqual(width);
    expect(bounds.panel.x).toBeGreaterThanOrEqual(15);
    expect(bounds.panel.right).toBeLessThanOrEqual(width - 15);
    expect(bounds.panel.width).toBeGreaterThanOrEqual(width < 640 ? width - 33 : 740);
    expect(bounds.columns).toBe(width < 640 ? 1 : 2);
    expect(bounds.overflow).toBe(false);
  }
  await page.getByRole("button", { name: "Ride History", exact: true }).click();
  await expect(page.locator("#orderHistoryModal")).toBeVisible();
  expect(await page.locator("#orderHistoryModal .profile-panel").evaluate(node => node.getBoundingClientRect().width)).toBeGreaterThan(740);
  await page.evaluate(() => closeOrderHistoryModal());
  await expect(page.locator("#passengerView")).toHaveAttribute("inert", "");
  await page.evaluate(() => closeProfileModal());
  await expect(page.locator("#passengerView")).not.toHaveAttribute("inert", "");
});

async function mockProfilePlaces(page, deferred = false) {
  await page.evaluate(deferred => {
    window.__autocomplete = {};
    window.__backgroundMoves = 0;
    document.body.addEventListener("touchmove", () => window.__backgroundMoves++);
    document.body.addEventListener("wheel", () => window.__backgroundMoves++);
    window.google = { maps: {
      Geocoder: class {}, DirectionsService: class {},
      Size: class {}, Point: class {},
      Map: class { setCenter() {} setZoom() {} },
      Marker: class { setMap() {} addListener() {} },
      event: { addDomListener: (node, type, callback) => node.addEventListener(type, callback) },
      places: { Autocomplete: class {
        constructor(input) {
          this.listeners = {};
          window.__autocomplete[input.id] = this;
          const create = () => {
            const list = document.createElement("div");
            list.className = "pac-container pac-logo";
            list.id = "test-pac-" + input.id;
            list.style.cssText = "position:absolute;left:900px;top:900px;width:900px;display:none";
            for (let i = 0; i < 12; i++) {
              const item = document.createElement("div");
              item.className = "pac-item";
              item.textContent = "Davao saved address " + i;
              item.addEventListener("click", () => {
                this.listeners.place_changed?.();
                list.style.display = "none";
              });
              list.appendChild(item);
            }
            document.body.appendChild(list);
            if (deferred === true) input.setAttribute("aria-controls", list.id);
            input.addEventListener("input", () => {
              if (deferred === "unlinked") {
                const rect = input.getBoundingClientRect();
                list.style.left = `${rect.left + scrollX}px`;
                list.style.top = `${rect.bottom + scrollY}px`;
                list.style.width = `${rect.width}px`;
              }
              list.style.display = "block";
            });
          };
          if (deferred) setTimeout(create, 0);
          else create();
        }
        addListener(event, callback) { this.listeners[event] = callback; }
        getPlace() { return { name: "Saved Home", formatted_address: "Davao City",
          geometry: { location: { lat: () => 7.1, lng: () => 125.6 } } }; }
      } }
    } };
    initAutocomplete();
  }, deferred);
}

for (const deferred of [false, true, "unlinked"]) {
  test(`saved-place suggestions stay attached through scrolling and preserve selection (${deferred === "unlinked" ? "deferred without ARIA" : deferred ? "deferred" : "immediate"} Google portal)`, async ({ page, context }) => {
    await setup(context);
    await page.setViewportSize({ width: 390, height: 640 });
    await loginPassenger(page);
    await mockProfilePlaces(page, deferred);
    await expect(page.locator("#test-pac-prefHome")).toHaveCount(1);
    await page.locator("#prefHome").fill("Davao");
    const list = page.locator('[data-profile-input="prefHome"]');
    await expect(list).toHaveCount(1);
    expect(await list.evaluate(node => node.parentElement.contains(document.getElementById("prefHome")))).toBe(true);
    expect(await page.locator("#test-pac-pickupLoc").evaluate(node => node.parentElement === document.body)).toBe(true);
    await expect(list).toBeVisible();
    const assertAnchored = async () => {
      const bounds = await page.evaluate(() => {
        const input = document.getElementById("prefHome").getBoundingClientRect();
        const list = document.querySelector('[data-profile-input="prefHome"]').getBoundingClientRect();
        return { gap: list.top - input.bottom, left: list.left - input.left, width: list.width - input.width };
      });
      expect(Math.abs(bounds.gap - 2)).toBeLessThan(2);
      expect(Math.abs(bounds.left)).toBeLessThan(2);
      expect(Math.abs(bounds.width)).toBeLessThan(2);
    };
    await assertAnchored();
    await page.locator("#profileModal .profile-panel").evaluate(node => { node.scrollTop += 60; });
    await assertAnchored();
    await page.setViewportSize({ width: 390, height: 440 });
    await assertAnchored();
    await list.evaluate(node => {
      node.style.top = "2000px";
      node.style.left = "2000px";
      node.dispatchEvent(new Event("touchmove", { bubbles: true }));
      node.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
    });
    await assertAnchored();
    expect(await page.evaluate(() => window.__backgroundMoves)).toBe(0);
    await expect(page.locator("#passengerView")).toHaveAttribute("inert", "");
    await page.setViewportSize({ width: 390, height: 844 });
    await list.scrollIntoViewIfNeeded();
    const box = await list.boundingBox();
    const panelScroll = await page.locator("#profileModal .profile-panel").evaluate(node => node.scrollTop);
    const backgroundScroll = await page.evaluate(() => scrollY);
    const touch = await context.newCDPSession(page);
    await touch.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    const x = box.x + box.width / 2, y = box.y + box.height - 20;
    await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (let step = 1; step <= 8; step++) {
      await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - step * 18 }] });
    }
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(() => list.evaluate(node => node.scrollTop)).toBeGreaterThan(40);
    expect(await page.locator("#profileModal .profile-panel").evaluate(node => node.scrollTop)).toBe(panelScroll);
    expect(await page.evaluate(() => scrollY)).toBe(backgroundScroll);
    expect(await page.evaluate(() => window.__backgroundMoves)).toBe(0);
    await touch.detach();
    await list.locator(".pac-item").first().click();
    await expect(page.locator("#pickerMapModal")).toBeVisible();
    await expect(list).toBeHidden();
    await expect.poll(() => page.evaluate(() => temporaryPickerPos)).toEqual({ lat: 7.1, lng: 125.6 });
    await page.evaluate(() => confirmPickerLocation());
    expect(await page.evaluate(() => currentUserProfile.home)).toEqual({
      address: "Saved Home, Davao City", lat: 7.1, lng: 125.6
    });
    await expect(page.locator("#passengerView")).toHaveAttribute("inert", "");
    await page.evaluate(() => openAddPlaceForm());
    const custom = page.locator('[data-profile-input="newPlaceAddress"]');
    await page.locator("#newPlaceAddress").fill("Office");
    await expect(custom).toBeVisible();
    expect(await custom.evaluate(node => node.parentElement.contains(document.getElementById("newPlaceAddress")))).toBe(true);
    await page.evaluate(() => closeProfileModal());
    await expect(custom).toBeHidden();
    await expect(page.locator("#passengerView")).not.toHaveAttribute("inert", "");
    await expect(page.locator("html")).not.toHaveClass(/profile-overlay-open/);
  });
}
