// Admin checks now live in store-access.js (an admin can be a signed-in ViTrox
// account or the admin password). Kept so existing imports keep working.
// requireAdmin(event) is async: always `await` it.
const { isAdmin, requireAdmin, adminFor } = require('./store-access');

module.exports = { isAdmin, requireAdmin, adminFor };
