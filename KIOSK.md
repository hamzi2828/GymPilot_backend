# Check-in without a fingerprint reader

Three ways in, all writing the same attendance rows:

| | Needs | How |
|---|---|---|
| **Windows attendance app** | a PC + DigitalPersona reader | `GymPilot_desktopApp` |
| **Web kiosk** | any tablet/PC with a browser (camera optional) | `<website>/kiosk` |
| **Member QR code** | the member's phone | account page → **Check-in QR** |

## The web kiosk

`<website>/kiosk`. Staff sign in with an account that has **Allow attendance
app** (granted on the Users/Staff screens or with
`node scripts/attendanceAccess.js --gym <slug> grant <email>`); the session
is a desk token, the same as the Windows app's. Then:

* **Start camera** — scans the member's QR code and checks them in or out;
* **type a member number** (`GP-0184`) — for a phone with no battery;
* **search by name** — staff picking someone from the list.

Each punch shows a receipt (package, valid-to, visits this month, status)
for eight seconds and plays a tone; the "Today" board lists everyone in.
`X-Tenant-Host` is not needed: the browser's origin selects the gym.

## The member's QR code

`GET /api/attendance/me/qr` returns a signed token
(`GPQ1.<type>.<id>.<expiry>.<signature>`, `src/attendance/services/qrToken.js`)
tied to the gym and valid for two days; the account page renders it and
fetches a fresh one each time it opens, so a screenshot goes stale.
`POST /api/desktop/punch { qr }` verifies it; `{ code }` looks a member or
staff number up instead. Attendance rows record the method (`fingerprint`,
`manual`, `qr`, `code`).

`QR_TOKEN_SECRET` (falls back to `JWT_SECRET`) signs the tokens.
