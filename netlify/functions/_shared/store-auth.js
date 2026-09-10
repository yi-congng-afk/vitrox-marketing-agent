const crypto = require('crypto');

function isAdmin(event) {
  const provided = event.headers['x-admin-password'] || '';
  const expected = process.env.STORE_ADMIN_PASSWORD || '';
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function requireAdmin(event) {
  if (!isAdmin(event)) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Admin password required' }) };
  }
  return null;
}

module.exports = { isAdmin, requireAdmin };
