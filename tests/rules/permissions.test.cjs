const { test, before, after } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { initializeTestEnvironment, assertSucceeds, assertFails } = require("@firebase/rules-unit-testing");
const { doc, collection, getDoc, getDocs, setDoc, query, where, serverTimestamp } = require("firebase/firestore");
let env;
const phone = "+639171234567";
const sessions = { customer: "a".repeat(64), driver: "b".repeat(64), stranger: "c".repeat(64) };
before(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Run with the Firestore emulator; never target production.");
  env = await initializeTestEnvironment({ projectId: "demo-ride2gether",
    firestore: { rules: fs.readFileSync(path.join(__dirname, "../../firestore.rules"), "utf8") } });
  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    const entries = {
      [`_auth_sessions/${sessions.customer}`]: { uid: "customer", phone: "+639171234500", role: "customer", revoked: false },
      [`_auth_sessions/${sessions.stranger}`]: { uid: "stranger", phone: "+639171234599", role: "customer", revoked: false },
      [`_auth_sessions/${sessions.driver}`]: { uid: "driver", phone, role: "driver", credentialVersion: "v1", revoked: false },
      [`drivers/${phone}`]: { phone, name: "Driver" },
      [`_driver_credentials/${phone}`]: { enabled: true, version: "v1", hash: "private" },
      [`_driver_work/${phone}`]: { online: true },
      "rate_config/current": { rates: {} },
      "ride_orders/OD-owned1": { customerPhone: "+639171234500", driverId: phone, status: "accepted" },
      "ride_orders/OD-open01": { customerPhone: "+639171234599", status: "pending" },
      "ride_orders/OD-ended1": { customerPhone: "+639171234599", driverId: "+639171234588", status: "completed" },
      "ride_orders/OD-owned1/trip_state/current": { totalFare: 150, driverEarnings: 120 },
      [`trip_shares/${"d".repeat(64)}`]: { status: "accepted", expiresAt: Date.now() + 60_000 }
    };
    for (const [key, value] of Object.entries(entries)) await setDoc(doc(db, key), value);
  });
});
after(async () => { await env?.cleanup(); });
function db(role, raw = false) {
  return role ? env.authenticatedContext(role, raw ? { phone_number: phone } : { appSessionId: sessions[role] }).firestore()
    : env.unauthenticatedContext().firestore();
}
test("only public prices and opaque shared snapshots are accessible anonymously", async () => {
  await assertSucceeds(getDoc(doc(db(), "rate_config/current")));
  await assertSucceeds(getDoc(doc(db(), `trip_shares/${"d".repeat(64)}`)));
  await assertFails(getDocs(collection(db(), "trip_shares")));
  await assertFails(getDoc(doc(db(), "ride_orders/OD-owned1")));
  await assertFails(getDoc(doc(db("driver", true), "ride_orders/OD-owned1")));
});
test("PINs, OTP sessions, app sessions and limits are never client-readable or writable", async () => {
  for (const key of [`_driver_credentials/${phone}`, `_auth_sessions/${sessions.driver}`, "_auth_challenges/secret", "_auth_limits/private"]) {
    await assertFails(getDoc(doc(db("driver"), key)));
    await assertFails(setDoc(doc(db("driver"), key), { enabled: true }));
  }
});
test("scoped queries work, collection scans and unrelated completed trips fail", async () => {
  await assertSucceeds(getDocs(query(collection(db("customer"), "ride_orders"), where("customerPhone", "==", "+639171234500"))));
  await assertSucceeds(getDocs(query(collection(db("driver"), "ride_orders"), where("driverId", "==", phone))));
  await assertSucceeds(getDocs(query(collection(db("driver"), "ride_orders"), where("status", "==", "pending"))));
  await assertSucceeds(getDocs(query(collection(db("driver"), "drivers"), where("phone", "==", phone))));
  await assertFails(getDocs(collection(db("driver"), "ride_orders")));
  await assertFails(getDoc(doc(db("driver"), "ride_orders/OD-ended1")));
  await assertFails(getDoc(doc(db("stranger"), "ride_orders/OD-owned1/trip_state/current")));
});
test("order identity, fare and trip snapshots cannot be client-forged", async () => {
  for (const key of ["ride_orders/OD-owned1", "ride_orders/OD-owned1/trip_state/current"]) {
    await assertFails(setDoc(doc(db("driver"), key), { driverId: phone, status: "accepted", totalPay: 1 }));
  }
});
test("chat allows only trip participants with their real sender role", async () => {
  const path = "ride_orders/OD-owned1/chat_messages/message1";
  await assertSucceeds(setDoc(doc(db("customer"), path), { sender: "customer", text: "Hello", timestamp: serverTimestamp() }));
  await assertSucceeds(setDoc(doc(db("driver"), path.replace("message1", "message2")), { sender: "driver", text: "Arriving", timestamp: serverTimestamp() }));
  await assertFails(setDoc(doc(db("customer"), path.replace("message1", "message3")), { sender: "driver", text: "Spoofed", timestamp: serverTimestamp() }));
  await assertFails(getDocs(collection(db("stranger"), "ride_orders/OD-owned1/chat_messages")));
});
test("pause removes pending reads, while PIN rotation revokes even owned-trip reads", async () => {
  await env.withSecurityRulesDisabled(async context => {
    await setDoc(doc(context.firestore(), `_driver_work/${phone}`), { online: false });
  });
  await assertFails(getDocs(query(collection(db("driver"), "ride_orders"), where("status", "==", "pending"))));
  await assertSucceeds(getDoc(doc(db("driver"), "ride_orders/OD-owned1")));
  await env.withSecurityRulesDisabled(async context => {
    await setDoc(doc(context.firestore(), `_driver_credentials/${phone}`), { enabled: true, version: "v2" });
  });
  await assertFails(getDoc(doc(db("driver"), "ride_orders/OD-owned1")));
});
