# ride2gether-app

## Passenger / driver views

**Production releases require administrator authorization. Do not push
this frontend to production before completing
the backend, rules, PIN provisioning and GAS compatibility checks below.**

`index.html` starts in passenger mode. Its account dialog defaults to
**Passenger Sign In**, with phone/SMS verification only. Registered drivers
choose **Registered Driver? Sign in with PIN** for the separate phone/PIN
form. `driver.html`, including Telegram claim links, opens **Driver Sign In**
directly. Switching forms preserves pending OTP deadlines and cooldowns.
There is no driver self-registration or
online document/KYC application. Drivers_Master remains the sole approval
list. During in-person approval, operations records the driver's chosen PIN
in `Drivers_Master.Driver_PIN`. The authenticated sync prepares salted scrypt
hashes and atomically publishes them to `driver_auth_secrets`, never the public
roster. There is no mobile PIN setup, activation code or driver SMS step.
An unapproved phone or a registration without a synced PIN cannot sign in.
Passenger and driver forms, validation messages and confirmation dialogs use
English. Firebase authentication also uses English for its verification widget.
The Firebase SDK key in `js/config.js` is a public browser configuration key,
restricted to the production website/Firebase app domains and the Authentication,
Secure Token, Firestore and Firebase Installations APIs. Server keys remain
separate and must never be copied into frontend configuration.

`js/app-mode.js` owns the view switch and client-side access guard. Phone edits,
failed verification, or removal from the live roster revoke access and stop
the driver order listener. Both `index.html` and the existing `driver.html`
use this guard. Returning to passenger mode preserves its form, trip tracking,
timers and map center; the header history button follows the current mode.
Driver mode aligns its availability controls and order list directly below
the header instead of distributing unused viewport height between them.
The trip map stays collapsed while idle (online or paused) and after a trip
ends; an active trip retains its map even when new-order availability is paused.

The header displays the member name above a secondary verification badge.
Only a signed-in driver verified against the live roster sees the compact
44px mode-switch icon beside the header account controls. Guests and passengers
have no mode switch; the PIN entry remains in the sign-in dialog.
Signed-in Profile & Settings and Ride History use responsive, full-width
panels; profile fields and saved places share two columns on wider screens.
Profile, history and saved-address map overlays isolate background interaction
without changing the trip map's gesture settings. Saved Home/custom-place
suggestions are anchored inside their input wrappers and scroll natively
without passing touch/wheel events to the background map.

Firebase Auth LOCAL persistence restores sign-in after closing the browser.
`r2g_bound_identity` in localStorage is a display cache, never an authorization
credential; neither it nor `user_role` grants access. No plaintext PIN or OTP
is stored in the browser. Both modes lock the verified phone. Drivers have no change-phone
button; operations must handle number changes and PIN rotation. A compact green
**Verified Driver** badge beside Mobile Phone reflects live roster verification;
the redundant binding explanation and manual fleet-check link are removed.
Profile & Settings has a **Sign Out** button at the bottom, also available on
the standalone driver page. It signs out Firebase Auth, clears this device's
application identity/profile/trip caches in both storage areas, and returns to
the guest homepage. Driver sign-out confirms server-side offline status first,
even from passenger mode; a network failure reports an error and allows retry
rather than claiming the driver is offline. Already-revoked credentials can
still be cleared. Sign-out never cancels an existing server-side trip or
changes a fare snapshot; signing in again restores any ongoing trip. Online/pause
is saved on the server and affects only new dispatches, not ongoing trips.
Dismissal is local to the driver; it no longer closes another driver's
potential booking globally.

Cloud Functions verifies PINs with salted scrypt, issues a Firebase custom
token tied to a private app session, and rechecks the current roster and PIN
version. Firestore rules enforce the same conditions. Revocation, disabling
credentials or rotating a PIN invalidates old driver sessions. Auth refresh
tokens are managed by the Firebase SDK, not a handcrafted role flag.
Trip mutations recheck the private session inside their transaction, so a
concurrent number reset cannot create an order after revocation. Failed token
signing revokes the unfinished session and reports a retryable sign-in error.
Driver ID is the normalized phone. Name, phone, vehicle and plate are resolved
server-side from the current roster. Existing Sheet columns retain their names;
this upgrade adds the required `Driver_PIN` column.
Legacy history queries are scoped by normalized customerPhone/driverId;
unscoped collection-scan fallbacks are intentionally removed.

Run the isolated view/access regression checks with
`node --test tests/app-mode.test.cjs`. They use mocked Firestore, storage and
browser APIs without reading or writing production orders.

## In-app trip chat

Both views in `index.html` and the standalone `driver.html` offer Trip Chat
during accepted/matched, arrived and in-progress trips. `js/chat.js` also
recognizes the `MATCHED`, `ARRIVED` and `IN_TRANSIT` status spellings without
changing existing order statuses. Quick replies fill the input; Send submits
the message. Opening the drawer never automatically focuses the input.

Messages are stored only in
`ride_orders/{orderId}/chat_messages` as `{ sender, text, timestamp }`, with
`sender` set to `customer` or `driver` and a server-generated timestamp.
The open drawer listens in ascending timestamp order. Closing it, switching
roles/trips, losing driver access, or completing/cancelling the trip detaches
the listener and clears the drawer. Read-only tracking visitors cannot chat.
Read/write failures are shown inside the drawer; failed sends keep the draft.

`firestore.rules` authorizes verified participants, validates sender and
message fields, and rejects new messages after the trip ends. Orders and fare
snapshots are writable only by the backend. Rules are checked locally with
the Firestore emulator; they have not been deployed by this local upgrade.

Run both regression suites with
`node --test tests/app-mode.test.cjs tests/chat.test.cjs`. The chat suite uses
two simulated clients and verifies message synchronization, role restrictions,
quick replies, error handling, and cleanup without contacting production.

## Sheet-owned configuration

Administrators maintain the existing `Rate_Config` and `Drivers_Master`
sheets. Drivers_Master contains approved drivers only; deleting a row revokes
that registration on the next successful synchronization. Do not store
pending or suspended applicants there.

`gas/SheetSync.gs` publishes an atomic Firestore commit containing:

| Firestore path | Content |
| --- | --- |
| `drivers/{normalizedPhone}` | `phone`, `name`, `plate`, `model`, `telegramUsername`, `telegramId`, `whatsapp`, `viber` |
| `driver_auth_secrets/{normalizedPhone}` | Salted scrypt `salt`/`hash`, credential `version`, `enabled`; never client-readable/writable |
| `rate_config/current` | `rates` map keyed by Service_ID, plus `updatedAt` formatted in Asia/Manila |

The frontend and GAS module both use `rate_config/current`, matching the
administrator's published configuration. They do not read
`system_config/pricing`. Publishing the frontend does not migrate or rewrite
Firestore configuration.

The existing Sheet columns are not renamed. Add `Driver_PIN` to Drivers_Master. Header
lookup is by exact label. Phone fields are normalized to E.164; Philippine
`09...`, `9...`, `639...` and `+639...` formats resolve to the same identity.
Store phone numbers and Telegram IDs as text in Sheets to avoid losing digits.
Required driver fields are Driver_Name, Phone_Number, Plate_Number and
Vehicle_Model and Driver_PIN; blank WhatsApp/Viber use Phone_Number. Telegram fields can be
blank. Missing/duplicate headers, duplicate normalized phones and invalid
rate cells or missing/invalid PINs abort the whole sync with an error.

Format `Driver_PIN` as **plain text before entry**, preserving all six digits,
including leading zeros (for example `004321`). A six-digit numeric cell can
be read, but a shortened number is rejected, never padded or guessed.
The Sheet necessarily retains plaintext PINs under this workflow: restrict
the entire spreadsheet, bound script, exports and backups to authorized
operations staff. Hiding/protecting the PIN column does not prevent viewers
from reading it. Never publish the spreadsheet or return PINs through GAS
doGet/doPost. PINs must not enter logs, browser storage or public driver docs.

Unchanged PINs retain the same salt/hash/version, preserving long-lived
sessions. Changing a PIN rotates its credential version; old sessions lose
access and the driver must sign in with the new PIN. Removing a row deletes
both public and private records in one commit. A phone change requires
operations to replace the registration; the old identity is not retained.

Keep `Service_Name` in English: it is displayed on new trips in both app modes.
Changing a service label does not change its pricing fields or existing orders.

| Rate_Config column | Firestore rate field |
| --- | --- |
| Service_Name | nameEn |
| Base_Fare | base |
| Base_Km | baseKm |
| Per_Km_Rate | perKm |
| Surge_Multiplier | surgeMultiplier |
| Flat_Surge_Fee | surgeFlat |
| Convenience_Fee | convenienceFee |
| Commission_Type | commType |
| Commission_Value | commVal |

All numeric rate cells must contain numbers, including explicit 0 values
where appropriate. Use 1 for no multiplier. PERCENT commission uses fractions
(15% in a numeric Sheet cell is 0.15), while FIXED uses a monetary amount.
Only distance exceeding Base_Km is charged per kilometer. The surge multiplier
and fixed surge apply to trip fare, not the convenience fee. Commission is
calculated on pre-surge trip fare; surge increases pass through to the driver.
Convenience_Fee is a fixed platform amount. Item costs and tips are added
without surge or commission. Money is rounded to centavos.

For example: Base_Fare 40, Base_Km 2, Per_Km_Rate 10, distance 5,
Surge_Multiplier 1.5, Flat_Surge_Fee 20, Convenience_Fee 30 and PERCENT 0.15
produce a pre-surge fare of 70, trip fare of 125, commission of 10.50,
customer total of 155 and driver payout of 114.50, before tips/items.

`js/rates.js` listens to the published config document. Cached/offline prices
do not authorize new bookings, and missing services are unavailable rather
than replaced with another service's rate. Errors appear in the pricing
panel, inside Estimated Total, without a separate fee card or manual reconnect
button. The platform fee remains included in the total and is not itemized.
Failed price listeners retry automatically with backoff (1 second up to 30
seconds); reconnecting online retries immediately. A booking recalculates from the latest received
validated prices, not the amount displayed in the DOM. Rate changes refresh
unsent estimates only; existing order amounts remain unchanged.

The existing trip sequence remains `accepted -> arrived -> in_progress ->
completed` (`IN_TRIP` is stored as `in_progress`). Accepted drivers see pickup
navigation and **I have arrived at pickup**; arrival changes the primary action
to **Passenger on board / Start Trip**. Both map markers snap to pickup and stop
animation while waiting. A persistent passenger arrival alert remains visible
even when trip details are minimized, and clears on departure, cancellation or
reset. Starting the trip switches both clients to the saved destination route;
no extra GPS reads or periodic Firestore writes are introduced.

### GAS setup and ongoing synchronization

These steps document initial setup and ongoing synchronization. An existing
installation does not need a local service-account script. A successful
manual sync alone does not enable automatic updates: subsequent Sheet edits
reach the app only after another successful sync, run manually or by the
installed triggers.

1. Back up the two sheets and the current Firestore drivers collection. This
   sync owns the **entire drivers and driver_auth_secrets collections**: documents not represented in
   Drivers_Master are deleted, including legacy IDs. The rates map also
   exactly mirrors Rate_Config. A sheet with headers but no data publishes an
   empty roster/rate map. Test against a non-production project first.
2. Open the spreadsheet's bound Apps Script project and add `SheetSync.gs`.
   Keep existing doGet/doPost and order handlers; do not expose the sync
   through the public web-app API. In Script Properties set
   `SHEET_SYNC_SPREADSHEET_ID` and `SHEET_SYNC_FIREBASE_PROJECT_ID` to the
   intended spreadsheet and Firebase project. These are deployment settings,
   not bot tokens or private keys.
3. Enable the Firestore API for the target project. The installing
   administrator must be authorized to access the spreadsheet and have
   Firestore IAM access (for example `roles/datastore.user`) on that project.
   Firestore requests use the administrator's OAuth token, never anonymous REST writes.
   PIN preparation calls the separate `prepareDriverPins` Cloud Function with
   `ScriptApp.getIdentityToken()`, not the Firestore access token.
   Before running this upgraded sync, deploy that function to the target
   staging project with `SHEET_SYNC_OAUTH_CLIENT_ID` set to the bound script's
   OAuth client ID and `SHEET_SYNC_OPERATOR_EMAILS` set to the explicit
   comma-separated administrator/trigger-owner emails. The function validates
   Google's signature, issuer, expiry and exact audience plus verified email
   membership. Missing configuration fails closed. Do not allow all Google
   accounts or Firebase app tokens. Its HTTPS endpoint is network-public
   only so GAS can reach it; operator authentication is mandatory.
   Merge the following settings/scopes into the existing Apps Script manifest;
   preserve any existing scopes needed by Telegram and order handlers:

   ```json
   {
     "timeZone": "Asia/Manila",
     "runtimeVersion": "V8",
     "oauthScopes": [
       "https://www.googleapis.com/auth/spreadsheets",
       "https://www.googleapis.com/auth/script.external_request",
       "https://www.googleapis.com/auth/datastore",
       "https://www.googleapis.com/auth/script.scriptapp",
       "openid",
       "https://www.googleapis.com/auth/userinfo.email"
     ]
   }
   ```

4. Run `syncSheetConfiguration` manually as that administrator and approve
   permissions. Inspect `rate_config/current` and `drivers`, including prices,
   normalized phones, private hashes and deletion behavior. Inspect Apps Script Executions
   and the `SHEET_SYNC_LAST_SUCCESS` / `SHEET_SYNC_LAST_ERROR` properties.
   HTTP failures, concurrent document edits and invalid data are reported and
   rethrown; no partial commit is published. Last valid config remains on a
   failed synchronization; administrators must resolve failures promptly.
5. Run `installSheetConfigurationTriggers` once from one administrator account.
   It performs a successful initial sync before replacing only this module's
   triggers. Installable edit/change triggers handle manual changes/deletions;
   a one-minute trigger reconciles formula, import or API changes. Delivery is
   subject to Apps Script scheduling/quotas, not instantaneous or guaranteed
   within exactly one minute. Keep other project triggers intact.
6. Deploy the authenticated backend/rules only after the release gate below.
   Clients must not write `drivers` or `rate_config`. Do not solve permission
   errors by allowing public writes or exposing the full roster.
   Replace legacy order/callback handlers with authenticated `gas/Dispatch.gs`
   as described in the release checklist. Sheet synchronization alone does
   not replace those handlers.
7. Verify that published rates and approved driver profiles are readable
   through the frontend's configured paths before releasing it. A website
   push alone does **not** install GAS triggers or grant Firebase access.
   Existing doGet pricing defaults remain
   relevant to old clients until they upgrade; the new frontend no longer
   reads doGet.

The preparation function only computes hashes; it does not publish credentials.
GAS includes its results with profiles and rates in a single Firestore commit.
Update-time preconditions retain nanosecond precision; unchanged credentials
use preconditioned empty-mask updates that preserve every field, so concurrent
changes abort the publication.
Failures never publish partial credentials or reset existing driver sessions.
If a commit response is lost, publication may already have completed; inspect
Firestore and retry the sync. Repeating the same PIN does not rotate it.
The sync rejects more than 500 operations (including unchanged-credential checks)
in one publication rather than making a partially applied roster. Unchanged
driver profiles and hashes are not rewritten. It does
not touch Orders_Master, ride_orders, chat messages, or Telegram dispatch.
Deleting a registration closes the local driver panel after the roster
listener receives the removal; it does not cancel that driver's trip.

Run all local checks with `node --test tests/*.test.cjs`. Apps Script and
Firestore are mocked; no administrator credentials or production writes are
required for these checks.

## Passenger phone verification

The browser obtains a Firebase reCAPTCHA token. The backend calls Firebase
Phone Auth, keeps `sessionInfo` private and returns only an opaque challenge.
Sending immediately disables the button for 60 seconds. Backend transactions
enforce the same per-phone resend limit across tabs, reloads and cleared
storage. The app challenge expires after 300 seconds. Three incorrect
six-digit codes destroy its redemption capability and impose a 300-second
per-phone lock. Infrastructure errors do not count as wrong codes.

This is **application-level expiry and revocation**, not a claim to change
Firebase's native SMS token lifetime. A directly obtained Firebase Phone
Auth ID token does not grant access: rules require the server-issued
`appSessionId` and a matching, unrevoked private session. Initial verification
requests are additionally limited to 20/hour/IP. Driver PIN guesses use
three attempts and a five-minute lock as well.

The challenge/cooldown cache contains no OTP or provider session. Reload
reconciles it with the server; cross-tab synchronization omits changing server
timestamps to prevent request echo loops. After success, the phone is readonly. Passenger
Change phone requires confirmation, revokes the app session, signs out,
clears this application's profile/places/trip cache and Firestore persistence,
and reloads. Unrelated origin storage is retained. A passenger must finish
or cancel an active trip before changing numbers. Drivers cannot use this
endpoint or passenger OTP to bypass PIN login.

Private collections: `driver_auth_secrets`, `_auth_sessions`,
`_auth_challenges`, `_auth_limits`, `_ip_limits`, `_customer_work`,
`_driver_work`. Clients can only read their own driver availability.
TTL policies remove old challenges and IP rate-limit records; session
revocation/expiry checks never depend on the asynchronous TTL deletion job.
Long-lived sessions and per-phone counters require an operator retention
policy; do not prune active sessions to satisfy a TTL blindly.

## Trip mirror and immutable fares

The backend calculates the booking route and fare using Sheet pricing.
`functions/pricing.js` is the one shared pricing implementation used by the
browser and server. Distance uses the existing one-decimal-kilometer rounding.
A changed quote is rejected for review, never silently charged.
Its pickup/destination inputs remain available for review and resubmission;
the pending trip/cancel UI appears only after the booking is confirmed.
Total Fare and Driver Earnings are frozen in
`ride_orders/{orderId}/trip_state/current`; later rate changes cannot reprice it.
Repeated booking IDs are idempotent, and one passenger cannot create multiple
active bookings. Completion/cancellation releases the work lock.
Cancellation rechecks the assigned driver if a concurrent claim wins, so the
new driver's work lock is also released.

Accept order requests one fresh GPS fix (`getCurrentPosition`, no
`watchPosition`). If location is unavailable/denied, acceptance stops with an
explicit error. The backend transaction checks online status, current
approval, pending order and driver work lock before assigning it. Simultaneous
claims cannot overwrite another driver. The GPS fix is stored once.

The shared trip subdocument holds encoded route geometry, duration and server
phase-start times. Accepted -> arrived -> in_progress -> completed maps to
pickup -> waiting -> delivery -> completed. `trip-motion.js` interpolates by
distance along the route in each browser, with a 90% cap until an explicit
arrival/completion. Arrival snaps to pickup; start changes to the destination
route; completion shows only the two frozen settlement amounts.
`trip-mirror.js` renders via the existing Google Maps SDK, cleans up animation
frames/listeners, and never writes position updates to Firestore.
Each distinct phase route is framed once; queued callbacks from a replaced
trip cannot update its replacement's map or settlement.
The UI explicitly says **Estimated position — not live GPS**. Concierge
retains its existing passenger no-large-map presentation.

Open Google Maps to pickup uses route coordinates. Start Trip preserves the
existing destination navigation shortcut. Public sharing now uses a random
256-bit capability in `trip_shares`, excluding phone numbers, account UID,
fare and earnings. Share documents update only on trip transitions and expire
after 24 hours (one hour after completion/cancellation). Old order-ID-only
share URLs are rejected. Anyone holding a new share URL can see its route;
share it only with trusted contacts.

## Local checks and deployment gate

Use Node 22 for Functions (matching `functions/package.json`) and Java 21
for the Firestore emulator. In PowerShell use `npm.cmd`/`npx.cmd` if script
execution policy prevents invoking npm.ps1:

```powershell
npm.cmd ci
npm.cmd ci --prefix functions
npm.cmd test
npm.cmd run test:rules
npx.cmd playwright install chromium
npm.cmd run test:e2e
```

If an installed Chrome is preferred, set `$env:PLAYWRIGHT_CHANNEL = 'chrome'`.
Rules tests explicitly target `demo-ride2gether`, never production.
Browser E2E uses real app pages with mocked Firebase/Maps/SMS transport and
the actual backend service state machines; it sends no SMS and creates no
production orders. The emulator independently exercises real Firestore
rules, including forbidden reads/writes and spoofed chat senders.

**Production release requires administrator authorization and all checks below.**
The production frontend uses the existing GitHub Pages `main` deployment;
do not migrate it to Firebase Hosting or change DNS as part of this release.
Before release:

1. Obtain Firebase administrator authorization and approve any SMS/Functions/
   Maps billing. Enable Phone Auth, PH SMS region policy and production
   authorized domains. Configure `IDENTITY_WEB_API_KEY`, exact `APP_ORIGINS`
   and the Secret Manager `MAPS_SERVER_KEY` (Directions REST enabled; separate
   from the referrer-restricted browser key). Enable custom-token signing/IAM
   for the Functions service account. Never commit credentials or PINs.
2. Add and restrict `Drivers_Master.Driver_PIN`, recording the six-digit PIN
   selected during in-person approval. Configure/deploy `prepareDriverPins`,
   authorize the GAS operator scopes and run the atomic sync described above.
   Verify first login, unchanged-PIN session retention, rotation, revocation
   and three-failure cooldown in staging. The old manual PIN provisioning CLI
   is removed; the Sheet is the only PIN source. This version uses
   `driver_auth_secrets`, not the earlier `_driver_credentials` schema. If a
   separate environment used that old schema, explicitly migrate from the
   approved Sheet and retire its old credentials before switching clients;
   there is no fallback to old credentials.
3. Replace the legacy GAS dispatch handlers with `gas/Dispatch.gs`, retaining
   the production-only Telegram/project configuration outside Git. Never
   commit the bot token. Deploy the existing web-app deployment ID rather
   than changing the client webhook URL. Preserve the existing manifest
   `webapp` settings (`executeAs: "USER_DEPLOYING"` and
   `access: "ANYONE_ANONYMOUS"`) when deploying with clasp; omitting them can
   remove the web-app entry point. Verify the deployed URL returns rate JSON,
   not just that the deployment command succeeds. `SYNC_ORDER` notifications include
   a Firebase ID token; GAS calls the backend `dispatchOrder` operation to
   validate the current participant session before reading canonical values.
   It mirrors those values to `Orders_Master` and Telegram and only patches
   Telegram message metadata in Firestore, never fares, ownership or phases.
   Cards open `driver.html?order=...` with a claim intent. After PIN sign-in,
   roster verification and going online, the page automatically accepts only
   that trip with one GPS fix through the existing atomic `claimOrder` API.
   Already-online drivers continue immediately; paused drivers must choose
   Online first. No extra Accept tap is required. Permission/GPS/claim failures
   stay visible and allow a manual retry, never an automatic retry loop.
   Unavailable trips are reported without claiming another order. A committed
   `ride_orders/{orderId}` snapshot, not Telegram delivery, drives the
   passenger's accepted card and driver details. Failed passenger subscriptions
   reconnect with 1–30 second backoff; replaced listeners cannot render stale
   trips, and acceptance cancels the pending dispatch timeout.
   Old callback buttons only refresh their
   known card and show an alert, never claim or advance a trip. Notifications
   cover booking, claim, cancellation and each phase; the two-second claim
   retry and a post-send status reread cover delayed Telegram delivery.
   Browser no-cors completion is not proof of successful delivery; inspect
   GAS failures and verify the real Telegram card before cutover.
4. Drain or explicitly migrate old active orders before the cutover: they
   lack the immutable trip snapshot/work locks. Never compute an old driver's
   earnings from today's rates. Reconcile historical raw-phone fields before
   enabling the scoped history queries; do not reopen public collection scans.
5. Validate backend, rules, reCAPTCHA/SMS, PIN provisioning and Maps on a
   staging project, then obtain release approval. Only then deploy Firebase,
   commit/merge/push main, and confirm Pages and mobile end-to-end behavior.