(() => {
  let authorizedPhone = "";
  let verificationId = 0;
  let unsubscribeWhitelist = null;

  function currentPhone() {
    const input = document.getElementById("prefPhone");
    return (input ? input.value : localStorage.getItem("guest_phone") || "").trim();
  }

  function setAppMode(driverMode) {
    const passengerView = document.getElementById("passengerView");
    document.body.dataset.appMode = driverMode ? "driver" : "passenger";
    passengerView?.classList.toggle("hidden", driverMode);
    document.getElementById("driverView").classList.toggle("hidden", !driverMode);
    document.getElementById("driverHeaderControls")?.classList.toggle("hidden", !driverMode);
    document.getElementById("driverAccessPanel")?.classList.toggle("hidden", driverMode);
    const icon = document.getElementById("switchModeIcon");
    const text = document.getElementById("switchModeText");
    if (icon) icon.textContent = driverMode ? "👤" : "🚘";
    if (text) text.textContent = driverMode ? "Passenger" : "Driver Mode";
    document.getElementById("btnSwitchMode")?.setAttribute("aria-pressed", String(driverMode));

    if (driverMode) {
      window.driverApp.initialize();
    } else {
      window.driverApp.stop();
      if (passengerView) {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (document.body.dataset.appMode !== "passenger") return;
          if (typeof mapInstance === "undefined" || !mapInstance || !window.google?.maps) return;
          const center = mapInstance.getCenter();
          google.maps.event.trigger(mapInstance, "resize");
          if (center) mapInstance.setCenter(center);
        }));
      }
    }
  }

  function revokeDriverAccess() {
    authorizedPhone = "";
    verificationId += 1;
    if (unsubscribeWhitelist) unsubscribeWhitelist();
    unsubscribeWhitelist = null;
    const button = document.getElementById("btnSwitchMode");
    button?.classList.add("hidden");
    button?.classList.remove("flex");
    setAppMode(false);
  }

  function isCurrentDriverAuthorized() {
    if (authorizedPhone && authorizedPhone !== currentPhone()) revokeDriverAccess();
    return authorizedPhone !== "" && authorizedPhone === currentPhone();
  }

  async function checkDriverWhitelist(phone = currentPhone()) {
    revokeDriverAccess();
    const requestId = verificationId;
    const requestedPhone = String(phone || "").trim();
    const status = document.getElementById("driverAccessStatus");
    if (status) status.textContent = "Checking driver access...";
    if (!requestedPhone || requestedPhone !== currentPhone()) {
      if (status) status.textContent = "A registered fleet phone is required.";
      return false;
    }

    try {
      const query = db.collection("drivers").where("phone", "==", requestedPhone).limit(1);
      // Never authorize from the locally cached role or an offline roster.
      const snapshot = await query.get({ source: "server" });
      if (requestId !== verificationId || requestedPhone !== currentPhone()) return false;
      if (snapshot.empty || snapshot.metadata.hasPendingWrites) {
        if (status) status.textContent = "This phone is not registered as a fleet driver.";
        return false;
      }

      authorizedPhone = requestedPhone;
      const button = document.getElementById("btnSwitchMode");
      button?.classList.remove("hidden");
      button?.classList.add("flex");
      unsubscribeWhitelist = query.onSnapshot(
        { includeMetadataChanges: true },
        (updatedSnapshot) => {
          if (requestId !== verificationId || updatedSnapshot.metadata.fromCache) return;
          if (updatedSnapshot.empty || updatedSnapshot.metadata.hasPendingWrites) {
            revokeDriverAccess();
            if (status) status.textContent = "Driver access is no longer available.";
          }
        },
        (error) => {
          if (requestId !== verificationId) return;
          console.error("[App mode] Driver roster listener failed:", error);
          revokeDriverAccess();
          if (status) status.textContent = "Unable to verify driver access. Please try again online.";
        }
      );
      if (!document.getElementById("passengerView")) setAppMode(true);
      return true;
    } catch (error) {
      if (requestId !== verificationId) return false;
      console.error("[App mode] Driver whitelist verification failed:", error);
      revokeDriverAccess();
      if (status) status.textContent = "Unable to verify driver access. Please try again online.";
      return false;
    }
  }

  function toggleAppMode() {
    if (!isCurrentDriverAuthorized()) {
      console.warn("Unauthorized access: Not a registered fleet driver.");
      return;
    }
    setAppMode(document.body.dataset.appMode !== "driver");
  }

  function openAppOrderHistory() {
    if (document.body.dataset.appMode === "driver") {
      window.openDriverOrderHistory();
    } else {
      openOrderHistoryModal();
    }
  }

  window.isCurrentDriverAuthorized = isCurrentDriverAuthorized;
  window.checkDriverWhitelist = checkDriverWhitelist;
  window.toggleAppMode = toggleAppMode;
  window.openAppOrderHistory = openAppOrderHistory;

  document.getElementById("prefPhone")?.addEventListener("input", revokeDriverAccess);
  document.getElementById("prefPhone")?.addEventListener("change", () => checkDriverWhitelist());
  window.addEventListener("vipprofilechange", () => checkDriverWhitelist());
  window.addEventListener("storage", (event) => {
    if (event.key === "guest_phone" || event.key === "r2g_vip_profile" || event.key === null) {
      revokeDriverAccess();
    }
  });
  checkDriverWhitelist();
})();
