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
A member's punch carries `detail.alert` (`punchService.memberAlert`): a
rising tone when all is well, two level mid tones for a warning (expiring
soon), a falling low tone for a problem (expired, unpaid, frozen) — then,
unless the gym has turned the voice off, the kiosk speaks `alert.speech` with
the browser's speech synthesis: the gym's own words from the attendance
page's **Desk settings** (`attendance.voice`).
`X-Tenant-Host` is not needed: the browser's origin selects the gym.

## The member's QR code

`GET /api/attendance/me/qr` returns a signed token
(`GPQ1.<type>.<id>.<expiry>.<signature>`, `src/attendance/services/qrToken.js`)
tied to the gym and valid for two days; the account page renders it and
fetches a fresh one each time it opens, so a screenshot goes stale.
`POST /api/desktop/punch { qr }` verifies it; `{ code }` looks a member or
staff number up instead. Attendance rows record the method (`fingerprint`,
`manual`, `qr`, `code`).

## A punch sent twice — `request_id`

A punch can be recorded and its answer lost on the way back (a timeout, a
dropped connection). The desk then shows "Not recorded", the person scans
again, and more than a minute later that second scan would be taken for the
way out. So `POST /api/desktop/punch` takes an optional `request_id` — 8 to
100 letters, digits, `_` or `-`; a UUID will do, anything else is a `400` —
that the client makes up for one attempt and sends again unchanged when it
retries the same person:

* the id is kept on the half of the visit the punch recorded
  (`checkIn.requestId` or `checkOut.requestId`);
* the same id for the same person again is answered with the first result —
  the same `{ success, message, detail }`, plus `repeated: true` — and
  nothing is recorded (looked for among that person's visits of the last two
  days);
* a punch that recorded nothing ("already checked in a moment ago") is not
  remembered and is judged afresh; without a `request_id` every punch is a
  new one, as before.

The Windows app sends one with every punch and, when a punch got no answer
(or a 5xx), re-sends the same id if that person is scanned or picked again
within two minutes. The web kiosk sends none.

`QR_TOKEN_SECRET` (falls back to `JWT_SECRET`) signs the tokens.
