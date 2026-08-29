// src/attendance/routes/adminRoutes.js
//
// Mounted at /api/attendance by index.js, for the admin panel in the browser.
//
// Separate from desktopRoutes on purpose. That surface is authenticated by a
// long-lived desktop token tied to a front-desk PC and is allowed to WRITE
// punches; this one is a normal admin JWT and is read-only. Keeping them apart
// means a leaked desk token cannot read the whole gym's history, and an admin
// session cannot manufacture attendance.

const express = require('express');
const router = express.Router();

const auth = require('../../middleware/auth');
const requirePermission = require('../../middleware/requirePermission');
const controller = require('../controller/adminAttendanceController');
const myController = require('../controller/myAttendanceController');

// A member reading their OWN attendance. Registered before the permission gate
// below, so it needs nothing but a valid token -- asking a member to hold the
// 'attendance' permission to see their own visits would be absurd. The handler
// pins the query to req.user.id and takes no person parameter, so this cannot
// be turned into a way to read somebody else's.
router.get('/me', auth, myController.me);

// Both gates on every route BELOW: `auth` only proves the token is valid, not that
// the account may read the gym's attendance. Everything here is a read, so
// 'view' on the attendance tab is enough -- which is what lets an accountant
// or a shift supervisor open this screen without being made an administrator.
router.use(auth, requirePermission('attendance', 'view'));

router.get('/records', controller.records);
router.get('/people', controller.people);
router.get('/person/:personType/:personId', controller.person);

module.exports = router;
