"use strict";
const { initializeApp, applicationDefault } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { randomUUID } = require("node:crypto");
const readline = require("node:readline/promises");
const { phoneNumber } = require("./errors");
const { hashPin } = require("./pin");

async function main() {
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  if (!project) throw new Error("Set GOOGLE_CLOUD_PROJECT explicitly; no default project is used.");
  if (!process.stdin.isTTY) throw new Error("Run interactively in an operator terminal. Do not pipe PINs or pass them as arguments.");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const phone = phoneNumber(await rl.question("Approved driver's registered phone: "));
  const confirmed = await rl.question(`Provision/rotate PIN for ${phone} in ${project}? Type YES: `);
  rl.close();
  if (confirmed !== "YES") return;
  function hiddenPin(label) {
    process.stdout.write(label);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    return new Promise((resolve, reject) => {
      let pin = "";
      function finish(error) {
        process.stdin.removeListener("data", input);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write("\n");
        if (error) reject(error); else resolve(pin);
      }
      function input(buffer) {
        for (const character of buffer.toString()) {
          if (character === "\u0003") { finish(new Error("Cancelled.")); return; }
          if (character === "\r" || character === "\n") { finish(); return; }
          if (character === "\u007f" || character === "\b") pin = pin.slice(0, -1);
          else if (/\d/.test(character) && pin.length < 6) pin += character;
        }
      }
      process.stdin.on("data", input);
    });
  }
  let pin = await hiddenPin("New six-digit PIN (hidden): ");
  const repeat = await hiddenPin("Repeat PIN (hidden): ");
  if (pin !== repeat) throw new Error("PINs do not match.");
  const credential = await hashPin(pin);
  pin = "";
  initializeApp({ credential: applicationDefault(), projectId: project });
  const db = getFirestore();
  await db.runTransaction(async tx => {
    const driver = await tx.get(db.doc(`drivers/${phone}`));
    if (!driver.exists) throw new Error("Not in the synced Drivers_Master roster. No credential was written.");
    tx.set(db.doc(`_driver_credentials/${phone}`), {
      ...credential, version: randomUUID(), enabled: true, updatedAt: FieldValue.serverTimestamp()
    });
  });
  console.log("PIN provisioned. Previous driver sessions are now invalid. Deliver the PIN privately.");
}
main().catch(error => { console.error("Provisioning failed:", error.message); process.exitCode = 1; });
