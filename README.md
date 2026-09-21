# ride2gether-app

## Passenger / driver views

`index.html` starts in passenger mode. The mode switch appears only after a
server-side lookup of the current VIP phone (`prefPhone`, or `guest_phone` on
the standalone driver page) matches `drivers.phone`. The `drivers` collection
is the synchronized Drivers_Master roster. No test-phone allowlist or cached
`user_role` grants access.

`js/app-mode.js` owns the view switch and client-side access guard. Phone edits,
failed verification, or removal from the live roster revoke access and stop
the driver order listener. Both `index.html` and the existing `driver.html`
use this guard. Returning to passenger mode preserves its form, trip tracking,
timers and map center; the header history button follows the current mode.

This is a UI gate, not authentication: VIP phone/localStorage values are
editable. Production authorization still requires verified identity and
Firestore security rules/backend enforcement. This change does not alter
database fields, driver identity constants, or order-writing behavior in
`js/driver.js`; its existing fixed driver identity remains unchanged.

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