const crypto = require('crypto');
const { createSessionToken, SESSION_MAX_AGE_MS } = require('./_shared/auth');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let password;
  try {
    ({ password } = JSON.parse(event.body || '{}'));
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  const expected = process.env.SHARED_PASSWORD || '';
  const provided = password || '';
  const isMatch =
    expected.length > 0 &&
    provided.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));

  if (!isMatch) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Incorrect password' }) };
  }

  const token = createSessionToken();
  const maxAgeSeconds = Math.floor(SESSION_MAX_AGE_MS / 1000);

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': `session=${token}; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}; Path=/`,
    },
    body: JSON.stringify({ ok: true }),
  };
};
