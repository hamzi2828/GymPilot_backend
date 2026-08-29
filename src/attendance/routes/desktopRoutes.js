// src/attendance/routes/desktopRoutes.js
//
// Mounted at /api/desktop by index.js. Every route is POST: the desktop
// client speaks one HTTP verb, which keeps its networking layer to a single
// method with one shape of response.

const express = require('express');
const router = express.Router();

const controller = require('../controller/desktopAppController');
const { desktopAuth, requireEnrollPermission } = require('../middleware/desktopAuth');

// Unauthenticated -- this is what issues the token, and the palette the
// sign-in window paints itself with before it has one.
router.post('/login', controller.login);
router.post('/theme', controller.theme);

// Everything past here needs a live desktop token AND an account that still
// holds allowAttendanceApp, re-checked per request.
router.post('/session', desktopAuth, controller.session);
router.post('/logout', desktopAuth, controller.logout);
router.post('/templates', desktopAuth, controller.templates);
router.post('/people', desktopAuth, controller.people);
router.post('/punch', desktopAuth, controller.punch);
router.post('/recent', desktopAuth, controller.recent);

// Enrolment is a second, narrower grant on top of app access.
router.post('/enroll', desktopAuth, requireEnrollPermission, controller.enroll);

module.exports = router;
