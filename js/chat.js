(() => {
  const activeStatuses = new Set(["accepted", "matched", "arrived", "in_progress", "in_transit"]);
  const quickReplies = {
    driver: ["I have arrived", "Heavy traffic, arriving soon", "Waiting at pickup point"],
    customer: ["Going down now", "Waiting at the lobby", "Please wait 2 mins"]
  };
  const buttonIds = { customer: "btnChatWithDriver", driver: "btnChatWithGuest" };
  const trips = { customer: null, driver: null };
  const modal = document.getElementById("inAppChatModal");
  const messages = document.getElementById("chatMessagesList");
  const input = document.getElementById("chatMessageInput");
  const sendButton = document.getElementById("btnSendChatMessage");
  const status = document.getElementById("chatStatus");
  let currentSession = null;

  function canUseRole(role) {
    if (window.isViewerMode) return false;
    if (role === "driver") {
      return document.body.dataset.appMode === "driver"
        && window.isCurrentDriverAuthorized?.() === true;
    }
    return role === "customer" && document.body.dataset.appMode !== "driver"
      && Boolean(document.getElementById("passengerView"));
  }

  function updateTrip(role, orderId, data) {
    if (!Object.hasOwn(trips, role)) {
      console.warn("[Chat] Ignoring unknown sender role:", role);
      return;
    }
    const active = typeof orderId === "string" && orderId.trim() !== ""
      && orderId !== "Generating..." && !orderId.includes("/")
      && activeStatuses.has(String(data?.status || "").toLowerCase());
    trips[role] = active ? {
      orderId,
      name: role === "customer" ? data.driverName || "Chauffeur" : data.customerName || "Guest"
    } : null;
    document.getElementById(buttonIds[role])?.classList.toggle("hidden", !active || window.isViewerMode === true);
    if (currentSession?.role === role) {
      if (!active || currentSession.orderId !== orderId || !canUseRole(role)) {
        close();
      } else {
        document.getElementById("chatPartnerName").textContent = trips[role].name;
      }
    }
  }

  function clearTrip(role) {
    updateTrip(role, null, null);
  }

  function close() {
    const session = currentSession;
    currentSession = null;
    if (session?.unsubscribe) session.unsubscribe();
    modal.classList.add("hidden");
    modal.classList.remove("flex");
    messages.replaceChildren();
    document.getElementById("chatQuickReplies").replaceChildren();
    input.value = "";
    status.textContent = "";
    sendButton.disabled = false;
  }

  function isCurrent(session) {
    return currentSession === session && canUseRole(session.role)
      && trips[session.role]?.orderId === session.orderId;
  }

  function renderMessages(snapshot, session) {
    const followLatest = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80;
    const firstRender = messages.childElementCount === 0;
    const fragment = document.createDocumentFragment();
    snapshot.forEach((doc) => {
      const message = doc.data();
      if (!Object.hasOwn(quickReplies, message.sender) || typeof message.text !== "string") {
        console.warn("[Chat] Ignoring malformed message:", doc.id);
        return;
      }
      const own = message.sender === session.role;
      const row = document.createElement("div");
      row.className = `flex ${own ? "justify-end" : "justify-start"}`;
      const bubble = document.createElement("p");
      bubble.className = `max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm shadow-sm ${
        own ? "bg-blue-600 text-white" : "border border-slate-200 bg-slate-50 text-slate-900"
      }`;
      bubble.textContent = message.text;
      row.appendChild(bubble);
      fragment.appendChild(row);
    });
    messages.replaceChildren(fragment);
    status.textContent = messages.childElementCount ? "" : "No messages yet. Say hello!";
    if (followLatest || firstRender) messages.scrollTop = messages.scrollHeight;
  }

  function open(role) {
    if (!canUseRole(role) || !trips[role]) {
      console.warn("[Chat] Chat is only available to participants in an active trip.");
      return;
    }
    if (currentSession?.role === role && isCurrent(currentSession)) return;
    close();
    const session = { role, orderId: trips[role].orderId, unsubscribe: null, sending: false, failed: false };
    currentSession = session;
    document.getElementById("chatPartnerName").textContent = trips[role].name;
    modal.classList.remove("hidden");
    modal.classList.add("flex");
    status.textContent = "Connecting to trip chat...";
    const replies = document.getElementById("chatQuickReplies");
    quickReplies[role].forEach((text) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-left text-[11px] font-semibold text-blue-600 transition hover:bg-blue-50 active:scale-95";
      button.textContent = text;
      button.addEventListener("click", () => {
        if (isCurrent(session)) input.value = text;
      });
      replies.appendChild(button);
    });

    function handleError(error) {
      console.error("[Chat] Message listener failed:", error);
      if (currentSession !== session) return;
      session.failed = true;
      if (session.unsubscribe) session.unsubscribe();
      session.unsubscribe = null;
      messages.replaceChildren();
      status.textContent = "Unable to load chat. Close and reopen to try again.";
      sendButton.disabled = true;
    }

    try {
      session.unsubscribe = db.collection("ride_orders").doc(session.orderId)
        .collection("chat_messages").orderBy("timestamp", "asc").onSnapshot(
          (snapshot) => {
            if (currentSession !== session || session.failed) return;
            if (!isCurrent(session)) {
              close();
              return;
            }
            renderMessages(snapshot, session);
          },
          handleError
        );
    } catch (error) {
      handleError(error);
    }
  }

  async function sendMessage(text, senderRole) {
    const session = currentSession;
    if (!session || session.failed || senderRole !== session.role || !isCurrent(session)) {
      console.warn("[Chat] Message blocked: no active chat for this sender.");
      return false;
    }
    if (session.sending) return false;
    const trimmedText = typeof text === "string" ? text.trim() : "";
    if (!trimmedText) {
      status.textContent = "Enter a message before sending.";
      return false;
    }
    const draft = input.value;
    session.sending = true;
    sendButton.disabled = true;
    status.textContent = "Sending...";
    try {
      await db.collection("ride_orders").doc(session.orderId).collection("chat_messages").add({
        sender: senderRole,
        text: trimmedText,
        timestamp: firebase.firestore.FieldValue.serverTimestamp()
      });
      if (isCurrent(session)) {
        if (input.value === draft && draft.trim() === trimmedText) input.value = "";
        status.textContent = "";
      }
      return true;
    } catch (error) {
      console.error("[Chat] Unable to send message:", error);
      if (isCurrent(session)) status.textContent = "Unable to send. Your message was kept; please try again.";
      return false;
    } finally {
      session.sending = false;
      if (isCurrent(session)) sendButton.disabled = session.failed;
    }
  }

  document.getElementById("btnChatWithDriver")?.addEventListener("click", () => open("customer"));
  document.getElementById("btnChatWithGuest")?.addEventListener("click", () => open("driver"));
  document.getElementById("btnCloseChat").addEventListener("click", close);
  document.getElementById("chatMessageForm").addEventListener("submit", (event) => {
    event.preventDefault();
    sendMessage(input.value, currentSession?.role);
  });
  modal.addEventListener("click", (event) => {
    if (event.target === modal) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && currentSession) close();
  });
  window.tripChat = { updateTrip, clearTrip, close };
  window.sendMessage = sendMessage;
})();
