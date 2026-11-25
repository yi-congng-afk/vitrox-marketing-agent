// Admin checks live in store-access.js (an admin can be a signed-in ViTrox
// account or the admin password; a Store Manager is a signed-in account).
// Kept so existing imports keep working. Both checks are async: always `await`.
//   requireAdmin   — admins only (people, settings, categories, housekeeping)
//   requireManager — admins and Store Managers (inventory, bookings, loans, stock, reports)
const { isAdmin, isManager, requireAdmin, requireManager, adminFor } = require('./store-access');

module.exports = { isAdmin, isManager, requireAdmin, requireManager, adminFor };
