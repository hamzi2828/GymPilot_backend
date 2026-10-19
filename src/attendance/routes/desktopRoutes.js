// src/attendance/routes/desktopRoutes.js
//
// Mounted at /api/desktop by index.js. Every route is POST: the desktop
// client speaks one HTTP verb, which keeps its networking layer to a single
// method with one shape of response.

const express = require('express');
const router = express.Router();

const controller = require('../controller/desktopAppController');
const deskCode = require('../controller/deskCodeController');
const faces = require('../controller/faceController');
const {
  desktopAuth,
  requireEnrollPermission,
  kioskStaffOnly,
  notOnKiosk,
  refuseRemovedMethods
} = require('../middleware/desktopAuth');
const { desktopLoginLimiter, twoFactorLimiter } = require('../../middleware/rateLimit');

// The website's code-step limiter reads the challenge from `challengeId`; the
// desk sends `challenge_id`, the one field loginTwoFactor reads. Copied over
// it (whatever else was sent there), so the limiter counts the challenge the
// handler checks and a decoy in the other field buys no fresh count.
function challengeForLimiter(req, res, next) {
  if (req.body && typeof req.body === 'object') req.body.challengeId = req.body.challenge_id;
  next();
}

// Unauthenticated -- this is what issues the token, and the palette the
// sign-in window paints itself with before it has one.
//
// The limiter counts failures only, and sits higher than the website's: a gym
// may run several front desks behind one office connection, and locking all of
// them out because one receptionist mistyped a password would stop the counter
// working. /theme is left open -- it returns a colour scheme and nothing else,
// and the sign-in window needs it before it can draw itself.
//
// The emailed-code step shares the desk's limiter (a wrong password and a
// wrong code are one allowance) and is held to the website's code-step
// limiter as well, per address and per challenge.
router.post('/login', desktopLoginLimiter, controller.login);
router.post('/login/2fa', desktopLoginLimiter, challengeForLimiter, twoFactorLimiter, controller.loginTwoFactor);
router.post('/theme', controller.theme);

// Everything past here needs a live desktop token AND an account that still
// holds allowAttendanceApp, re-checked per request.
router.post('/session', desktopAuth, controller.session);
router.post('/logout', desktopAuth, controller.logout);
router.post('/recent', desktopAuth, controller.recent);

// The rotating code the screen shows for members to scan with their phone
// (services/deskCode.js). Both the Windows desk and the web kiosk show it, with
// no staff unlock: it names the desk, never a person.
router.post('/checkin-code', desktopAuth, deskCode.checkinCode);

// The fingerprint side -- decrypted templates and enrolment -- is the Windows
// app's alone: a web kiosk is refused both, unlocked or not (notOnKiosk).
// Enrolment is a second, narrower grant on top of app access.
router.post('/templates', desktopAuth, notOnKiosk, controller.templates);
router.post('/enroll', desktopAuth, notOnKiosk, requireEnrollPermission, controller.enroll);

// Faces for the desk's webcam, on the same terms (faceController.js): the
// Windows app's alone, and registering or removing one needs the enrolment
// grant, as a finger does.
router.post('/face-templates', desktopAuth, notOnKiosk, faces.faceTemplates);
router.post('/face-enroll', desktopAuth, notOnKiosk, requireEnrollPermission, faces.faceEnroll);
router.post('/face-remove', desktopAuth, notOnKiosk, requireEnrollPermission, faces.faceRemove);

// A web kiosk stands on the public side of the counter (see kioskStaffOnly):
// there the people list, and every punch -- checking someone in by hand, the
// staff's backup -- need the desk password typed again. Members check in
// there with their phone, through the screen's code, never through /punch.
// A punch carrying the retired member QR or member number is told so first.
router.post('/unlock', desktopAuth, controller.unlock);
router.post('/people', desktopAuth, kioskStaffOnly(), controller.people);
router.post('/punch', desktopAuth, refuseRemovedMethods, kioskStaffOnly(), controller.punch);

module.exports = router;
