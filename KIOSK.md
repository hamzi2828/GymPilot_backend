# Checking in at the front desk

Members check in three ways, all writing the same attendance rows:

| | Needs | How | `method` on the visit |
|---|---|---|---|
| **Desk code (phone)** | the member's phone, signed in to the member app or the gym website | scan the rotating QR code on the desk screen — the Windows app or `<website>/kiosk` | `desk_code` |
| **Fingerprint** | the Windows attendance app + a DigitalPersona reader | `GymPilot_desktopApp` | `fingerprint` |
| **Face** | the Windows attendance app + a USB webcam | `GymPilot_desktopApp` | `face` |

**Staff check someone in by hand** as the backup: the desk app's person
picker, or the kiosk's **Staff** unlock → search → pick (`manual`).

A member no longer shows their own QR code, and no longer types their member
number: both could be borrowed. Member IDs (`GP-0001`, `TR-0001`) stay, for
searching and on receipts. Visits recorded before keep their `qr` / `code`
method.

## The desk code

The screen shows a code that names the desk, never a person:

    GPD1.<desk token id>.<expiry, unix seconds>.<signature>

signed with `QR_TOKEN_SECRET` (falling back to `JWT_SECRET`) over
`desk-code|<gym id>|<desk token id>|<expiry>` (`src/attendance/services/deskCode.js`),
so it cannot be made up, used at another gym or moved to another desk. It is
good for 60 seconds, with 5 seconds' grace for the trip; the screen fetches a
new one every 20.

* `POST /api/desktop/checkin-code` — any desk token, the kiosk's included, no
  staff unlock →
  `{ success, data: { code, expires_at, valid_seconds: 60, refresh_after_seconds: 20, checkin_path: "/checkin" } }`.
* The QR code holds `https://<gym website>/checkin?c=<code>`, so a phone's
  ordinary camera opens the website's check-in page. The member app and the
  member area scan it themselves and accept that address or the bare `GPD1.`
  code.
* `POST /api/attendance/me/checkin { code, request_id? }` — a signed-in
  website or member-app session, ten tries a minute per account
  (`429 CHECKIN_PAUSED`, with `retry_after`). The person is the signed-in
  account (staff when it is on the staff); the visit is the desk's — under the
  desk account and the PC that showed the code (its name, app, Windows user and
  address from the desk token), method `desk_code`. The answer is the desk
  punch's own: `{ success, message, detail, repeated?, ignored?, refused?, code?, reason? }`.
  Refusals: `400 CODE_INVALID` (not a code, tampered with, or another gym's),
  `410 CODE_EXPIRED` (the screen has moved on), `409 DESK_SIGNED_OUT` (that
  screen has been signed out, or its account lost **Allow attendance app**).

## The web kiosk

`<website>/kiosk`. Staff sign in with an account that has **Allow attendance
app** (granted on the Users/Staff screens or with
`node scripts/attendanceAccess.js --gym <slug> grant <email>`); the session
is a desk token, the same as the Windows app's. It shows the desk code for
members to scan, and the "Today" board. Everything else is staff only and
needs the **Staff** unlock — the desk account's password again
(`POST /api/desktop/unlock`): the people search, and every punch
(`POST /api/desktop/punch` from a kiosk is always a hand-picked check-in).
The kiosk never reaches the fingerprint or face routes (`403 KIOSK_NOT_ALLOWED`).

Each punch shows a receipt (package, valid-to, visits this month, status)
for eight seconds and plays a tone. A member's punch carries `detail.alert`
(`punchService.memberAlert`): a rising tone when all is well, two level mid
tones for a warning (expiring soon), a falling low tone for a problem
(expired, unpaid, frozen) — then, unless the gym has turned the voice off,
the kiosk speaks `alert.speech` with the browser's speech synthesis: the
gym's own words from the attendance page's **Desk settings**
(`attendance.voice`). `X-Tenant-Host` is not needed: the browser's origin
selects the gym.

## Faces

Matching happens on the desk PC, so it works offline; the server never sees
a picture. The desk finds and lines up the face (YuNet) and sends SFace
feature vectors (`sface-2021dec`: 128 numbers each, L2-normalised).

* `POST /api/desktop/face-enroll { person_type, person_id, model, embeddings, consent: true }`
  — 1 to 10 vectors; needs the enrolment grant a finger needs
  (`allowFingerprintEnrollment`), as `face-remove` does. `400 CONSENT_REQUIRED` unless `consent` is `true`, `400 BAD_TEMPLATE`
  for another model or anything but finite numbers in that shape, `404` for
  somebody no longer on file. One face per person: enrolling again replaces it.
* `POST /api/desktop/face-templates` → `{ success, data: { model, templates: [{ person_type, person_id, embeddings }], unreadable } }`
  — like the fingerprint `/templates`: decrypted for the desk, every download in
  the audit trail, departed people and faces this server cannot decrypt left out.
* `POST /api/desktop/face-remove { person_type, person_id }` → `{ success, removed }`.
* A recognised face is punched with `POST /api/desktop/punch`, `method: "face"`
  and an optional `match_score` (0 to 1, kept to three places on the visit's
  half as `matchScore` and in the audit row). The desk punches by itself only
  when it is sure and asks staff "Is this …?" when it is not.

Consent, removal and how faces are kept: SECURITY_AND_DATA.md → *Biometric
consent*.

## A punch sent twice — `request_id`

A punch can be recorded and its answer lost on the way back (a timeout, a
dropped connection). The desk then shows "Not recorded", the person scans
again, and more than a minute later that second scan would be taken for the
way out. So `POST /api/desktop/punch` and `POST /api/attendance/me/checkin`
take an optional `request_id` — 8 to 100 letters, digits, `_` or `-`; a UUID
will do, anything else is a `400` — that the client makes up for one attempt
and sends again unchanged when it retries the same person:

* the id is kept on the half of the visit the punch recorded
  (`checkIn.requestId` or `checkOut.requestId`);
* the same id for the same person again is answered with the first result —
  the same `{ success, message, detail }`, plus `repeated: true` — and
  nothing is recorded (looked for among that person's visits of the last two
  days);
* a punch that recorded nothing ("already checked in a moment ago",
  answered with `ignored: true`) is not remembered and is judged afresh;
  without a `request_id` every punch is a new one, as before.

The Windows app sends one with every punch and, when a punch got no answer
(or a 5xx), re-sends the same id if that person is scanned or picked again
within two minutes.

## A punch sent late — `scanned_at`

With no connection the Windows desk keeps matching, saves each punch with its
`request_id` and the moment it was scanned, and sends them oldest-first once
it is back, each with `scanned_at` (only from the Windows desk, only with a
`request_id`, at most 72 hours old — `ATTENDANCE_OFFLINE_MAX_HOURS`). Other
desks and the daily job may have recorded this person in the meantime, so the
punch is placed by its own time (`punchService` → *A scan sent late*):

* a visit open at the scan time is closed at the scan time — including one the
  daily job marked "No check-out" after it, which then loses that mark;
* within a minute of another punch on either side, it is that punch's repeat
  (`ignored: true`);
* inside a visit recorded in and out around it, nothing is recorded:
  `ignored: true, code: "INSIDE_RECORDED_VISIT"`, with the times;
* otherwise it is a check-in at the scan time. Before the person's latest
  visit it is an earlier visit of its own — recorded, never the open one, shown
  as "No check-out" (`autoClosed`, from the moment the next visit began) unless
  a later punch in the queue closes it.

Its membership is judged as it stood at the scan time, not when the punch
arrived. And it is never refused under the gym's entry rules: the offline desk
could not ask, so it let the person in, and the visit happened. A queued
check-in those rules would have turned away is recorded with its verdict and
flagged — `admitted_offline: true` and `reason` in the answer, `LET IN
OFFLINE — …` as the receipt's warning, `entryRefusal { reason, text }` on the
visit and `entry_refusal` on the office's attendance log (with
`check_in_by.offline`).

## Gone

* `GET /api/attendance/me/qr` → `410 { code: "QR_CHECKIN_REMOVED" }`, kept for
  a release so an old app is told why.
* `POST /api/desktop/punch` carrying `qr` or `code` →
  `400 { code: "METHOD_REMOVED" }`, from a kiosk too, before it is asked for
  an unlock.
