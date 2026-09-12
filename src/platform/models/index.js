// src/platform/models/index.js
//
// Compiles every platform model on the platform connection. Called once
// before the platform routes run so populate() can resolve refs by name --
// a `ref: 'PlatformPlan'` looked up before that model has been touched would
// otherwise fail with "schema hasn't been registered".

const Gym = require('./gymModel');
const PlatformPlan = require('./platformPlanModel');
const PlatformAddon = require('./platformAddonModel');
const PlatformSettings = require('./platformSettingsModel');
const SuperAdmin = require('./superAdminModel');
const PlatformAuditLog = require('./platformAuditLogModel');
const DemoRequest = require('./demoRequestModel');
const MemberDirectory = require('./memberDirectoryModel');
const PlatformStripeEvent = require('./platformStripeEventModel');

let warmed = false;

function warmPlatformModels() {
  if (warmed) return;
  // Reading .schema through the proxy compiles the model on the connection.
  void Gym.schema;
  void PlatformPlan.schema;
  void PlatformAddon.schema;
  void PlatformSettings.schema;
  void SuperAdmin.schema;
  void PlatformAuditLog.schema;
  void DemoRequest.schema;
  void MemberDirectory.schema;
  void PlatformStripeEvent.schema;
  warmed = true;
}

module.exports = {
  Gym,
  PlatformPlan,
  PlatformAddon,
  PlatformSettings,
  SuperAdmin,
  PlatformAuditLog,
  DemoRequest,
  MemberDirectory,
  PlatformStripeEvent,
  warmPlatformModels
};
