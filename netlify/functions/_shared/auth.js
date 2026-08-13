const crypto = require('crypto');

const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function sign(payload) {
  const secret = process.env.SESSION_SECRET;
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function createSessionToken() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_MAX_AGE_MS })).toString('base64url');
  const signature = sign(payload);
  return `${payload}.${signature}`;
}

function verifySessionToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return false;
  const [payload, signature] = token.split('.');
  const expectedSignature = sign(payload);
  const signaturesMatch =
    signature &&
    signature.length === expectedSignature.length &&
    crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
  if (!signaturesMatch) return false;

  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof exp === 'number' && Date.now() < exp;
  } catch {
    return false;
  }
}

function getCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  const match = cookieHeader.split(';').map((c) => c.trim()).find((c) => c.startsWith(`${name}=`));
  return match ? match.slice(name.length + 1) : null;
}

module.exports = { createSessionToken, verifySessionToken, getCookie, SESSION_MAX_AGE_MS };
