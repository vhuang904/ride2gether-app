(() => {
  const auth = firebase.auth();
  auth.languageCode = "en";
  const BINDING_KEY = "r2g_bound_identity";
  const CHALLENGE_KEY = "r2g_otp_challenge";
  let session = null;
  let challenge = null;
  let challengeRevision = 0;
  let generation = 0;
  let busy = false;
  let resetting = false;
  let serverOffset = 0;
  let captcha = null;
  let stopPresence = null;
  let online = false;
  const get = id => document.getElementById(id);
  const clock = () => Date.now() + serverOffset;
  const normalize = value => {
    let phone = String(value || "").replace(/[\s()-]/g, "");
    if (/^09\d{9}$/.test(phone)) phone = "+63" + phone.slice(1);
    else if (/^9\d{9}$/.test(phone)) phone = "+63" + phone;
    else if (/^639\d{9}$/.test(phone)) phone = "+" + phone;
    return /^\+[1-9]\d{7,14}$/.test(phone) ? phone : "";
  };
  const controls = get("accountControls");
  const driverEntry = controls?.dataset.loginMode === "driver";
  let loginMode = driverEntry ? "driver" : "passenger";
  if (controls) controls.innerHTML = `
    <div id="accountLoginControls" class="space-y-3">
      <div id="driverPinFields" class="hidden flex flex-wrap gap-2">
        <p class="w-full text-xs text-slate-600">Enter the 6-digit driver PIN registered at our office. Contact the operations team to change your PIN.</p>
        <input id="driverPin" type="password" inputmode="numeric" maxlength="6" autocomplete="current-password" aria-label="Driver PIN" placeholder="6-digit driver PIN" class="min-w-0 flex-1 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-base">
        <button id="btnConfirmPin" type="button" class="rounded-xl bg-blue-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-50">Sign in</button>
        <p id="driverPinCountdown" class="w-full text-xs text-slate-600"></p>
      </div>
      <div id="passengerSignInFields" class="space-y-3">
        <button id="btnSendOtp" type="button" class="w-full rounded-xl bg-blue-600 px-3 py-2 text-sm font-bold text-white hover:bg-blue-700 disabled:opacity-50">Send verification code</button>
        <div id="otpFields" class="hidden space-y-2">
          <div class="flex gap-2">
            <input id="otpCode" type="text" inputmode="numeric" maxlength="6" autocomplete="one-time-code" aria-label="Verification code" placeholder="6-digit code" class="min-w-0 flex-1 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-base">
            <button id="btnConfirmOtp" type="button" class="rounded-xl bg-blue-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-50">Verify</button>
          </div>
          <p id="otpCountdown" class="text-xs text-slate-600"></p>
        </div>
        <div id="authCaptcha"></div>
      </div>
      <button id="btnDriverSignIn" type="button" class="w-full rounded-xl px-2 py-2 text-sm font-medium text-blue-600 hover:text-blue-700 disabled:opacity-50">Registered Driver? Sign in with PIN</button>
      <button id="btnPassengerSignIn" type="button" class="hidden w-full rounded-xl px-2 py-2 text-sm font-medium text-blue-600 hover:text-blue-700 disabled:opacity-50">Passenger? Sign in with SMS</button>
    </div>
    <button id="btnChangePhone" type="button" class="hidden rounded-xl px-2 py-1 text-xs font-semibold text-blue-600">Change phone number</button>
    <p id="accountStatus" role="status" class="text-xs text-slate-600"></p>`;
  function notice(message, error = false) {
    const node = get("accountStatus");
    if (node) {
      node.textContent = message;
      node.classList.toggle("hidden", !message);
      node.classList.toggle("text-red-600", error);
      node.classList.toggle("text-slate-600", !error);
    }
  }
  function saveChallenge() {
    challengeRevision += 1;
    if (!challenge) { localStorage.removeItem(CHALLENGE_KEY); return; }
    // Provider timestamps and error metadata must not echo between browser tabs.
    const fields = ["phone", "challengeId", "resendAt", "expiresAt", "lockedUntil", "pinLockedUntil", "attemptsLeft", "active"];
    const saved = JSON.stringify(Object.fromEntries(fields.filter(key => challenge[key] !== undefined).map(key => [key, challenge[key]])));
    if (localStorage.getItem(CHALLENGE_KEY) !== saved) localStorage.setItem(CHALLENGE_KEY, saved);
  }
  function mergeChallenge(data) {
    challenge = { ...challenge, ...data };
    if (Number.isFinite(data.serverNow)) serverOffset = data.serverNow - Date.now();
    saveChallenge();
    render();
  }
  async function api(action, payload = {}, publicRequest = false) {
    const headers = { "Content-Type": "application/json" };
    if (!publicRequest) {
      if (!auth.currentUser) throw Object.assign(new Error("Please sign in first."), { code: "SIGN_IN_REQUIRED" });
      headers.Authorization = `Bearer ${await auth.currentUser.getIdToken()}`;
    }
    const response = await fetch(ACCOUNT_API_URL, {
      method: "POST", headers, body: JSON.stringify({ action, payload }),
      cache: "no-store", signal: AbortSignal.timeout(55_000)
    });
    const result = await response.json();
    if (Number.isFinite(result.serverNow)) serverOffset = result.serverNow - Date.now();
    if (!response.ok) {
      const error = Object.assign(new Error(result.message || "The request failed."), result);
      console.error("[Account] Request rejected:", action, result.code);
      if (["SESSION_REVOKED", "SIGN_IN_REQUIRED", "DRIVER_REVOKED", "DRIVER_PIN_REQUIRED"].includes(result.code)) {
        applySession(null);
        notice(error.message, true);
      }
      throw error;
    }
    return result;
  }
  async function notifyDispatch(orderId) {
    if (!session || !auth.currentUser) throw new Error("Sign in before synchronizing dispatch.");
    if (typeof GAS_WEBHOOK_URL === "undefined" || !GAS_WEBHOOK_URL) throw new Error("Dispatch is not configured.");
    const idToken = await auth.currentUser.getIdToken();
    await fetch(GAS_WEBHOOK_URL, {
      method: "POST", mode: "no-cors",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({ action: "SYNC_ORDER", orderId, idToken }),
      signal: AbortSignal.timeout(30_000)
    });
  }
  function render() {
    const phone = get("prefPhone");
    const lockedUntil = Math.max(challenge?.lockedUntil || 0, challenge?.pinLockedUntil || 0);
    const locked = lockedUntil > clock();
    if (phone) {
      if (session) phone.value = session.phone;
      phone.readOnly = Boolean(session);
      phone.disabled = !session && (busy || locked || Boolean(challenge?.challengeId && challenge.expiresAt > clock()));
    }
    get("accountLoginControls")?.classList.toggle("hidden", Boolean(session));
    get("driverPinFields")?.classList.toggle("hidden", loginMode !== "driver");
    get("passengerSignInFields")?.classList.toggle("hidden", loginMode !== "passenger");
    get("btnDriverSignIn")?.classList.toggle("hidden", loginMode !== "passenger");
    get("btnPassengerSignIn")?.classList.toggle("hidden", loginMode !== "driver" || driverEntry);
    for (const id of ["btnDriverSignIn", "btnPassengerSignIn"]) if (get(id)) get(id).disabled = busy;
    if (get("accountHeading")) get("accountHeading").textContent = session ? "Profile & Settings"
      : loginMode === "driver" ? "Driver Sign In" : "Passenger Sign In";
    if (get("accountDescription")) get("accountDescription").textContent = session ? "Manage your profile and saved places."
      : loginMode === "driver" ? "For drivers approved in person by our operations team."
        : "Verify your mobile number with a code sent by SMS.";
    if (get("profileModal")) get("profileModal").dataset.signedIn = String(Boolean(session));
    document.querySelectorAll("[data-profile-settings]").forEach(node => node.classList.toggle("hidden", !session));
    get("btnChangePhone")?.classList.toggle("hidden", !session || session.role === "driver");
    const signOutButton = get("btnSignOut");
    if (signOutButton) {
      signOutButton.classList.toggle("hidden", !session && !auth.currentUser);
      signOutButton.disabled = busy;
      signOutButton.textContent = resetting ? "Signing out..." : "Sign Out";
    }
    const badge = get("identityBadge");
    if (badge) badge.textContent = session ? "Phone verified" : "Guest";
    if (get("identityIndicator")) get("identityIndicator").classList.toggle("is-verified", Boolean(session));
    const resend = Math.ceil(Math.max(0, (challenge?.resendAt || 0) - clock()) / 1000);
    const cooldown = Math.ceil(Math.max(0, lockedUntil - clock()) / 1000);
    const expiry = Math.ceil(Math.max(0, (challenge?.expiresAt || 0) - clock()) / 1000);
    const send = get("btnSendOtp");
    if (send) {
      send.disabled = busy || locked || resend > 0;
      send.textContent = locked ? `Locked (${cooldown}s)` : resend ? `Resend (${resend}s)` : "Send verification code";
    }
    get("otpFields")?.classList.toggle("hidden", !challenge?.challengeId);
    if (get("otpCode")) get("otpCode").disabled = busy || locked || expiry === 0 || challenge?.active === false;
    if (get("btnConfirmOtp")) get("btnConfirmOtp").disabled = busy || locked || expiry === 0 || challenge?.active === false;
    if (get("driverPin")) get("driverPin").disabled = busy || locked;
    if (get("btnConfirmPin")) get("btnConfirmPin").disabled = busy || locked;
    if (get("driverPinCountdown")) get("driverPinCountdown").textContent = locked ? `Try again in ${cooldown}s.` : "";
    if (get("otpCountdown")) get("otpCountdown").textContent = locked ? `Try again in ${cooldown}s.`
      : expiry ? `Code expires in ${expiry}s.` : "Code expired. Request a new code.";
    const availability = get("btnDriverAvailability");
    if (availability) {
      availability.disabled = !session || busy;
      availability.textContent = online ? "🟢 Online — listening" : "🚫 Paused — not accepting";
      availability.setAttribute("aria-pressed", String(online));
    }
  }
  function setLoginMode(mode) {
    if (session || busy) return;
    loginMode = mode === "driver" || driverEntry ? "driver" : "passenger";
    if (get("driverPin")) get("driverPin").value = "";
    notice("");
    render();
  }
  function applySession(value) {
    session = value ? Object.freeze(value) : null;
    if (stopPresence) stopPresence();
    stopPresence = null;
    online = false;
    if (session) {
      localStorage.setItem(BINDING_KEY, JSON.stringify({ phone: session.phone, role: session.role }));
      localStorage.setItem("guest_phone", session.phone);
      challenge = null;
      saveChallenge();
      if (typeof currentUserProfile !== "undefined") {
        currentUserProfile.phone = session.phone;
        saveProfileToStorage();
      }
      if (session.role === "driver") {
        stopPresence = db.collection("_driver_work").doc(session.phone).onSnapshot(doc => {
          online = doc.exists && doc.data().online === true;
          render();
          window.dispatchEvent(new Event("driveravailabilitychange"));
        }, error => {
          online = false;
          console.error("[Account] Availability read failed:", error);
          notice("Unable to check availability. New orders are paused.", true);
          render();
          window.dispatchEvent(new Event("driveravailabilitychange"));
        });
      }
    } else localStorage.removeItem(BINDING_KEY);
    render();
    window.dispatchEvent(new Event("accountchange"));
  }
  async function restore(user) {
    if (resetting) return;
    const request = ++generation;
    if (!user) { applySession(null); return; }
    try {
      const current = await api("session");
      if (request !== generation) return;
      applySession(current);
      notice("");
    } catch (error) {
      if (request !== generation) return;
      applySession(null);
      notice(error.message, true);
    }
  }
  async function signIn(result) {
    get("driverPin").value = "";
    get("otpCode").value = "";
    await auth.signInWithCustomToken(result.token);
  }
  async function perform(work) {
    if (busy) return;
    busy = true;
    render();
    try { await work(); }
    catch (error) {
      console.error("[Account] Operation failed:", error.code || error.name);
      notice(error.message || "Unable to complete the request. Please retry.", true);
    } finally { busy = false; render(); }
  }
  async function sendOtp() {
    if (session || loginMode !== "passenger" || get("btnSendOtp")?.disabled) return;
    const phone = normalize(get("prefPhone")?.value);
    if (!phone) { notice("Enter a valid phone number.", true); return; }
    mergeChallenge({ phone, resendAt: clock() + 60_000 });
    await perform(async () => {
      try {
        if (captcha) captcha.clear();
        captcha = new firebase.auth.RecaptchaVerifier("authCaptcha", { size: "normal" });
        const recaptchaToken = await captcha.verify();
        const result = await api("otpSend", { phone, recaptchaToken }, true);
        mergeChallenge({ ...result, phone, active: true });
        notice("Verification code sent.");
      } catch (error) {
        mergeChallenge({ ...error, phone });
        throw error;
      } finally {
        if (captcha) captcha.clear();
        captcha = null;
      }
    });
  }
  async function confirmOtp() {
    if (session || loginMode !== "passenger" || get("btnConfirmOtp")?.disabled) return;
    await perform(async () => {
      try {
        await signIn(await api("otpConfirm", { challengeId: challenge?.challengeId, code: get("otpCode").value.trim() }, true));
      } catch (error) {
        mergeChallenge(error);
        if (["EXPIRED", "SIGN_IN_UNAVAILABLE"].includes(error.code)) mergeChallenge({ active: false, expiresAt: clock() });
        if (error.code === "INVALID_CODE") {
          error.message = error.attemptsLeft === 2 ? "Incorrect verification code. 2 attempts remaining."
            : error.attemptsLeft === 1 ? "Incorrect verification code. 1 attempt remaining. Another incorrect attempt will invalidate this code."
              : "Verification code invalidated. Please try again in 5 minutes.";
          if (error.attemptsLeft === 0) get("otpCode").value = "";
        }
        throw error;
      }
    });
  }
  async function loginDriver() {
    if (session || loginMode !== "driver" || get("btnConfirmPin")?.disabled) return;
    await perform(async () => {
      try {
        const result = await api("driverLogin", { phone: normalize(get("prefPhone").value), pin: get("driverPin").value }, true);
        await signIn(result);
      } catch (error) {
        get("driverPin").value = "";
        if (error.code === "DRIVER_NOT_APPROVED") error.message = "This phone number is not approved for Driver Mode. Contact the operations team.";
        if (error.code === "DRIVER_PIN_NOT_READY") error.message = "Your driver PIN has not been synced yet. Contact the operations team to confirm your registration.";
        if (error.lockedUntil) mergeChallenge({ pinLockedUntil: error.lockedUntil });
        throw error;
      }
    });
  }
  async function changePhone() {
    if (!session || session.role === "driver") return;
    if (!window.confirm("Change phone number? This signs you out and clears this device's saved profile, places and trip cache.")) return;
    await perform(async () => {
      await api("changePhone");
      await resetLocalAccount();
    });
  }
  async function resetLocalAccount() {
    generation += 1;
    window.tripChat?.close();
    window.driverApp?.stop();
    window.tripMirror?.stopAll();
    if (typeof unsubscribeOrder === "function") unsubscribeOrder();
    if (typeof stopDispatchTimer === "function") stopDispatchTimer();
    await auth.signOut();
    applySession(null);
    await db.terminate();
    await db.clearPersistence();
    for (const storage of [localStorage, sessionStorage]) {
      for (const key of Object.keys(storage)) {
        if (/^(r2g_|ride2gether_|guest_|firebase:authUser:)/.test(key) || key === "user_role") storage.removeItem(key);
      }
    }
    if ("caches" in window) {
      for (const key of await caches.keys()) if (key.startsWith("ride2gether-cache-")) await caches.delete(key);
    }
    if (typeof closeProfileModal === "function") closeProfileModal();
    window.location.replace(new URL("index.html", window.location.href).href);
  }
  async function signOut() {
    if (!session && !auth.currentUser) return;
    await perform(async () => {
      resetting = true;
      generation += 1;
      render();
      try {
        try {
          const current = session || await api("session");
          if (current.role === "driver") await api("setOnline", { online: false });
        } catch (error) {
          // Revoked credentials already prevent dispatch; they must still be removable.
          if (!["SESSION_REVOKED", "SIGN_IN_REQUIRED", "DRIVER_REVOKED", "DRIVER_PIN_REQUIRED"].includes(error.code)) {
            throw new Error("Unable to sign out. Reconnect and try again so we can confirm your account is offline.", { cause: error });
          }
        }
        await resetLocalAccount();
      } catch (error) {
        const driverNotice = driverEntry ? get("driverNotice") : null;
        if (driverNotice) {
          driverNotice.textContent = error.message;
          driverNotice.classList.remove("hidden");
        }
        throw error;
      } finally {
        resetting = false;
      }
    });
  }
  async function setOnline() {
    if (session?.role !== "driver") return;
    await perform(async () => {
      const result = await api("setOnline", { online: !online });
      online = result.online;
      window.dispatchEvent(new Event("driveravailabilitychange"));
    });
  }
  window.accountAuth = {
    api, getSession: () => session, isDriver: () => session?.role === "driver", isOnline: () => online, serverTime: clock,
    syncPhone: render, setLoginMode, changePhone, signOut, setOnline, notifyDispatch,
    requireSession() {
      if (!session) {
        if (typeof openProfileModal === "function") openProfileModal();
        throw new Error("Verify your phone to continue.");
      }
      return session;
    }
  };
  get("btnSendOtp")?.addEventListener("click", sendOtp);
  get("btnConfirmOtp")?.addEventListener("click", confirmOtp);
  get("btnConfirmPin")?.addEventListener("click", loginDriver);
  get("btnDriverSignIn")?.addEventListener("click", () => setLoginMode("driver"));
  get("btnPassengerSignIn")?.addEventListener("click", () => setLoginMode("passenger"));
  get("btnChangePhone")?.addEventListener("click", changePhone);
  get("btnSignOut")?.addEventListener("click", signOut);
  get("btnDriverAvailability")?.addEventListener("click", setOnline);
  window.addEventListener("vipprofilechange", render);
  window.addEventListener("online", () => restore(auth.currentUser));
  window.addEventListener("storage", event => {
    if (event.key === CHALLENGE_KEY) restoreChallenge();
  });
  async function restoreChallenge() {
    const revision = ++challengeRevision;
    try {
      challenge = JSON.parse(localStorage.getItem(CHALLENGE_KEY) || "null");
      if (challenge?.phone && get("prefPhone") && !session) get("prefPhone").value = challenge.phone;
      render();
      if (challenge?.challengeId && !session) {
        const state = await api("otpStatus", { challengeId: challenge.challengeId }, true);
        if (revision === challengeRevision && !session) mergeChallenge(state);
      }
    } catch (error) {
      if (revision !== challengeRevision || session) return;
      console.error("[Account] Challenge restore failed:", error.code || error.name);
      if (challenge) challenge.active = false;
      notice("Unable to restore verification. Reconnect or request a new code after the countdown.", true);
      render();
    }
  }
  restoreChallenge();
  setInterval(render, 1000);
  auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).then(() => {
    auth.onAuthStateChanged(restore, error => {
      applySession(null);
      console.error("[Account] Authentication listener failed:", error.code);
      notice("Unable to restore sign-in. Please reconnect.", true);
    });
  }).catch(error => {
    console.error("[Account] Persistent sign-in unavailable:", error.code);
    notice("This browser cannot keep you signed in. Allow website storage and reload.", true);
  });
})();
