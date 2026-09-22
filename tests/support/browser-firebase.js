(() => {
  const rawFetch = window.fetch.bind(window);
  const listeners = new Set();
  function ref(path, filters = [], count = Infinity) {
    const hydrate = raw => ({
      id: raw.id, exists: raw.exists, metadata: { fromCache: false, hasPendingWrites: false },
      data: () => raw.value,
      docs: raw.docs?.map(item => hydrate(item)),
      size: raw.docs?.length || 0,
      empty: !raw.docs?.length,
      forEach(callback) { this.docs.forEach(callback); }
    });
    const api = {
      doc: id => ref(path + "/" + id),
      collection: name => ref(path + "/" + name),
      where: (field, operator, value) => ref(path, [...filters, [field, operator, value]], count),
      limit: value => ref(path, filters, value),
      orderBy: () => api,
      async get() {
        const response = await rawFetch("/__test/firestore?" + new URLSearchParams({ path, filters: JSON.stringify(filters), count }));
        if (!response.ok) throw new Error("Test Firestore read failed");
        return hydrate(await response.json());
      },
      onSnapshot(...args) {
        const next = typeof args[0] === "function" ? args[0] : args[1];
        const error = typeof args[0] === "function" ? args[1] : args[2];
        let active = true;
        const listener = async () => { try { const data = await api.get(); if (active) next(data); } catch (e) { if (active) error?.(e); } };
        listeners.add(listener);
        listener();
        return () => { active = false; listeners.delete(listener); };
      },
      async set() { throw new Error("Unexpected client write in E2E"); }
    };
    return api;
  }
  const db = { collection: name => ref(name), terminate: async () => listeners.clear(), clearPersistence: async () => {} };
  window.__refreshFirestore = () => Promise.all([...listeners].map(listener => listener()));
  window.fetch = async (...args) => {
    const response = await rawFetch(...args);
    if (String(args[0]).includes("cloudfunctions.net")) setTimeout(window.__refreshFirestore, 0);
    return response;
  };
  const callbacks = new Set();
  let token = localStorage.getItem("test_firebase_auth");
  const auth = {
    get currentUser() { return token ? { uid: JSON.parse(token).uid, getIdToken: async () => token } : null; },
    setPersistence: async mode => {
      if (mode !== "local") throw new Error("Expected long-lived LOCAL persistence.");
    },
    onAuthStateChanged(callback) { callbacks.add(callback); setTimeout(() => callback(auth.currentUser), 0); },
    async signInWithCustomToken(value) {
      token = value;
      localStorage.setItem("test_firebase_auth", value);
      callbacks.forEach(callback => callback(auth.currentUser));
    },
    async signOut() {
      token = null;
      localStorage.removeItem("test_firebase_auth");
      callbacks.forEach(callback => callback(null));
    }
  };
  const authFunction = () => auth;
  authFunction.Auth = { Persistence: { LOCAL: "local" } };
  authFunction.RecaptchaVerifier = class {
    async verify() { return "fake-captcha-no-sms"; }
    clear() {}
  };
  const firestore = () => db;
  firestore.FieldValue = { serverTimestamp: () => Date.now() };
  window.firebase = { apps: [], initializeApp() { this.apps.push({}); }, auth: authFunction, firestore };
})();
