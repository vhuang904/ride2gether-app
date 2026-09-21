# ride2gether-app

## Passenger / driver views

`index.html` starts in passenger mode. The mode switch appears only after a
server-side lookup of the current VIP phone (`prefPhone`, or `guest_phone` on
the standalone driver page) matches `drivers.phone`. The `drivers` collection
is populated by the administrator-installed Sheet sync described below.
No test-phone allowlist or cached
`user_role` grants access.

`js/app-mode.js` owns the view switch and client-side access guard. Phone edits,
failed verification, or removal from the live roster revoke access and stop
the driver order listener. Both `index.html` and the existing `driver.html`
use this guard. Returning to passenger mode preserves its form, trip tracking,
timers and map center; the header history button follows the current mode.

This is a UI gate, not authentication: VIP phone/localStorage values are
editable. Production authorization still requires verified identity and
Firestore security rules/backend enforcement. Driver ID, name, phone, vehicle
and plate now come from the unique synchronized profile, not fixed identity
constants. Existing order field names remain unchanged. Legacy orders match
by driver ID or normalized phone, never by display name alone. The existing
default avatar gender remains unchanged because Drivers_Master has no gender
column. Profile edits/revocation are observed live, and dismissed cards are
stored separately for each driver.

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

Firestore rules must separately authorize reads and creates in this
subcollection for verified trip participants, validate the sender and fields,
and reject messages after the trip ends. Parent-document permissions do not
automatically apply to subcollections. This frontend change does not deploy
rules or add authentication; editable VIP phone values are not proof of
identity. No spreadsheet or existing order fields are modified.

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
| `rate_config/current` | `rates` map keyed by Service_ID, plus `updatedAt` formatted in Asia/Manila |

The frontend and GAS module both use `rate_config/current`, matching the
administrator's published configuration. They do not read
`system_config/pricing`. Publishing the frontend does not migrate or rewrite
Firestore configuration.

The existing Sheet columns are not renamed, reordered or modified. Header
lookup is by exact label. Phone fields are normalized to E.164; Philippine
`09...`, `9...`, `639...` and `+639...` formats resolve to the same identity.
Store phone numbers and Telegram IDs as text in Sheets to avoid losing digits.
Required driver fields are Driver_Name, Phone_Number, Plate_Number and
Vehicle_Model; blank WhatsApp/Viber use Phone_Number. Telegram fields can be
blank. Missing/duplicate headers, duplicate normalized phones and invalid
rate cells abort the whole sync with an error.

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
panel with a reconnect button. A booking recalculates from the latest received
validated prices, not the amount displayed in the DOM. Rate changes refresh
unsent estimates only; existing order amounts remain unchanged.

### GAS setup and ongoing synchronization

These steps document initial setup and ongoing synchronization. An existing
installation does not need a local service-account script. A successful
manual sync alone does not enable automatic updates: subsequent Sheet edits
reach the app only after another successful sync, run manually or by the
installed triggers.

1. Back up the two sheets and the current Firestore drivers collection. This
   sync owns the **entire drivers collection**: documents not represented in
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
   Requests use the administrator's OAuth token, never anonymous REST writes.
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
       "https://www.googleapis.com/auth/script.scriptapp"
     ]
   }
   ```

4. Run `syncSheetConfiguration` manually as that administrator and approve
   permissions. Inspect `rate_config/current` and `drivers`, including prices,
   normalized phones and deletion behavior. Inspect Apps Script Executions
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
6. Authentication/rules remain a separate, unfinished phase and are required
   before accepting untrusted production traffic. Clients must not write
   `drivers` or `rate_config`. Do not solve
   permission errors by allowing public writes or exposing the full roster.
   Verified participants need scoped order/chat access. Client phone matching
   is still only a UI gate; this phase has not made it secure authentication.
   The existing public GAS `findDriverProfile` fallback and unauthenticated
   order endpoints also require review in that phase; this module does not
   change their behavior.
7. Verify that published rates and approved driver profiles are readable
   through the frontend's configured paths before releasing it. A website
   push alone does **not** install GAS triggers or grant Firebase access.
   Existing doGet pricing defaults remain
   relevant to old clients until they upgrade; the new frontend no longer
   reads doGet.

The sync rejects more than 500 writes in one publication rather than making
a partially applied roster. Unchanged driver documents are skipped. It does
not touch Orders_Master, ride_orders, chat messages, or Telegram dispatch.
Deleting a registration closes the local driver panel after the roster
listener receives the removal; it does not cancel that driver's trip.

Run all local checks with `node --test tests/*.test.cjs`. Apps Script and
Firestore are mocked; no administrator credentials or production writes are
required for these checks.