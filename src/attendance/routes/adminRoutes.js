// src/attendance/routes/adminRoutes.js
//
// Mounted at /api/attendance by index.js, for the admin panel in the browser.
//
// Separate from desktopRoutes on purpose. That surface is authenticated by a
// long-lived desktop token tied to a front-desk PC and is allowed to WRITE
// punches; this one is a normal admin JWT. It reads, and it can correct or
// void a visit the desk recorded -- but it can never create one. Keeping them
// apart means a leaked desk token cannot read the whole gym's history, and an
// admin session cannot manufacture attendance.

const express = require('express');
const router = express.Router();

const auth = require('../../middleware/auth');
const requirePermission = require('../../middleware/requirePermission');
const controller = require('../controller/adminAttendanceController');
const corrections = require('../controller/attendanceCorrectionController');
const myController = require('../controller/myAttendanceController');

// A member reading their OWN attendance. Registered before the permission gate
// below, so it needs nothing but a valid token -- asking a member to hold the
// 'attendance' permission to see their own visits would be absurd. The handler
// pins the query to req.user.id and takes no person parameter, so this cannot
// be turned into a way to read somebody else's.
router.get('/me', auth, myController.me);

// The QR code a member shows at the door -- theirs alone, freshly signed
// each time it is asked for. See services/qrToken.js.
router.get('/me/qr', auth, myController.qr);

// Both gates on every route BELOW: `auth` only proves the token is valid, not
// that the account may touch the gym's attendance. The level follows the
// method: a read needs 'view' on the attendance tab -- which is what lets an
// accountant or a shift supervisor open this screen without being made an
// administrator -- and a correction needs 'manage'. One gate per request, so
// each correction is written to the admin audit log exactly once.
//
// On each route rather than router.use(): other attendance routes live
// under /api/attendance too (the fingerprints, in routes/allRoutes.js, with
// gates of their own), and a request for one of those passes through this
// router on its way there. A router-wide gate ran for them as well -- a second
// permission check and a second audit entry for every fingerprint removed.
const gate = [auth, requirePermission('attendance')];

router.get('/records', gate, controller.records);
router.get('/people', gate, controller.people);
router.get('/person/:personType/:personId', gate, controller.person);

router.patch('/records/:id', gate, corrections.editTimes);
router.post('/records/:id/void', gate, corrections.voidVisit);

router.get('/settings', gate, corrections.settings);
router.put('/settings', gate, corrections.updateSettings);

module.exports = router;
