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