const crypto = require('crypto');
const { isAdmin } = require('./store-auth');
const { getConfig, saveConfig, getProfile, saveProfile } = require('./store-blobs');

// "Sign in with Google" for ViTrox staff.
//
// The browser gets a Google ID token, this server checks it with Google and
// then hands back its own signed session token, which the browser sends with
// every request in the x-store-session header. Name, employee number and email
// are then taken from that session instead of being typed into each form.

// The OAuth Client ID is public by design (it is also in store/app.js). There
// is no client secret anywhere in this project — this flow does not need one.
const GOOGLE_CLIENT_ID = '725610917729-tou01tupum34inr9smfeb9codh1dounr.apps.googleusercontent.com';
const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];
// Only Google Workspace accounts on these domains may sign in.
const ALLOWED_DOMAINS = ['vitrox.com'];

// A session lasts this long after Google last vouched for the person, and is
// never extended without asking Google again — so someone whose ViTrox account
// has been closed loses access within this window.
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const CONFIG_TTL_MS = 30 * 1000;
const MAX_EMPLOYEE_NO = 30;
const MAX_NAME = 80;

function json(statusCode, payload) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) };
}

function clean(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

// ---- Settings: the signing secret and the "sign-in required" switch ----

let cachedConfig = null;
let cachedAt = 0;

async function loadConfig({ fresh = false } = {}) {
  if (!fresh && cachedConfig && Date.now() - cachedAt < CONFIG_TTL_MS) return cachedConfig;
  const stored = (await getConfig()) || {};
  cachedConfig = {
    sessionSecret: typeof stored.sessionSecret === 'string' ? stored.sessionSecret : '',
    requireSignIn: stored.requireSignIn === true,
  };
  cachedAt = Date.now();
  return cachedConfig;
}

async function writeConfig(config) {
  await saveConfig({ sessionSecret: config.sessionSecret, requireSignIn: config.requireSignIn });
  cachedConfig = { sessionSecret: config.sessionSecret, requireSignIn: config.requireSignIn };
  cachedAt = Date.now();
  return cachedConfig;
}

// The secret that signs session tokens is random, made once, and kept with the
// store's data — never in the code, and not derived from the admin password.
async function ensureSecret() {
  const config = await loadConfig({ fresh: true });
  if (config.sessionSecret) return config;
  await writeConfig({ sessionSecret: crypto.randomBytes(32).toString('hex'), requireSignIn: config.requireSignIn });
  // Read it back: if two requests got here together, both settle on the saved one.
  return loadConfig({ fresh: true });
}

async function setRequireSignIn(value) {
  const config = await ensureSecret();
  return writeConfig({ sessionSecret: config.sessionSecret, requireSignIn: Boolean(value) });
}

// ---- Session tokens: <payload>.<HMAC-SHA256 signature>, both base64url ----

function signPart(part, secret) {
  return crypto.createHmac('sha256', secret).update(part).digest('base64url');
}

function issueToken(user, exp, secret) {
  const payload = { v: 1, e: user.email, n: user.name, no: user.employeeNo || '', x: exp };
  const part = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${part}.${signPart(part, secret)}`;
}

function readToken(token, secret) {
  if (!secret || typeof token !== 'string' || !token || token.length > 2000) return null;
  const pieces = token.split('.');
  if (pieces.length !== 2 || !pieces[0] || !pieces[1]) return null;

  const given = Buffer.from(pieces[1]);
  const expected = Buffer.from(signPart(pieces[0], secret));
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(pieces[0], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || payload.v !== 1 || typeof payload.e !== 'string' || !payload.e) return null;
  if (typeof payload.x !== 'number' || payload.x <= Date.now()) return null;
  return { email: payload.e, name: clean(payload.n), employeeNo: clean(payload.no), exp: payload.x };
}

function sessionToken(event) {
  return (event.headers && event.headers['x-store-session']) || '';
}

// The signed-in person for this request, or null. Settings are cached for a few
// seconds, so a token that fails is checked once more against a fresh copy
// before it is turned away.
async function readSession(event) {
  const token = sessionToken(event);
  if (!token) return null;
  let config = await loadConfig();
  let user = readToken(token, config.sessionSecret);
  if (!user) {
    config = await loadConfig({ fresh: true });
    user = readToken(token, config.sessionSecret);
  }
  return user;
}

function deny(code, error) {
  return json(401, { error, code });
}

const SESSION_EXPIRED = () => deny('session_expired', 'Your sign-in has expired — please sign in again.');

// Called at the top of every store function. Returns { response } when the
// request must stop, otherwise { admin, user }.
//  - A session token that is present but not valid is always refused, so a
//    record is never saved without the name the person expected to be on it.
//  - When sign-in is required, only signed-in staff get through. A valid admin
//    password also gets through, so an admin can never be locked out.
async function checkAccess(event) {
  const admin = isAdmin(event);
  const user = await readSession(event);
  if (sessionToken(event) && !user) return { response: SESSION_EXPIRED() };

  const config = await loadConfig();
  if (config.requireSignIn && !user && !admin) {
    return { response: deny('signin_required', 'Please sign in with your ViTrox account to use the store.') };
  }
  return { admin, user };
}

// Who a record is saved under. Signed in: the name and email come from the
// session and cannot be typed over; the employee number is the saved one (the
// typed one is only used until it has been saved). Not signed in: as typed.
function recordedBy(user, body) {
  const typed = body || {};
  if (!user) return { name: clean(typed.name), employeeNo: clean(typed.employeeNo) };
  return { name: user.name, employeeNo: user.employeeNo || clean(typed.employeeNo), email: user.email };
}

// ---- Staff profiles: remembers each person's employee number ----

// A readable, collision-free blob key: letters and digits stay, anything else
// becomes -<hex code> (so "@" is "-40" and "." is "-2e").
function profileKey(email) {
  return email.replace(/[^a-z0-9]/g, (ch) => `-${ch.charCodeAt(0).toString(16)}`);
}

async function readProfile(email) {
  return getProfile(profileKey(email));
}

async function writeProfile(email, profile) {
  await saveProfile(profileKey(email), profile);
}

function validEmployeeNo(value) {
  const employeeNo = clean(value);
  return employeeNo && employeeNo.length <= MAX_EMPLOYEE_NO ? employeeNo : '';
}

// ---- Checking a Google sign-in ----

// Google itself checks the signature and expiry of the ID token; this then
// checks it was issued for this app, to a verified ViTrox Workspace account.
async function verifyGoogleCredential(credential) {
  const refused = (status, error) => ({ ok: false, status, error });
  if (typeof credential !== 'string' || !credential || credential.length > 5000) {
    return refused(400, 'Sign-in did not complete — please try again.');
  }

  let claims;
  try {
    const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
    if (res.status >= 500) return refused(502, 'Google could not be reached to check your sign-in — please try again.');
    if (!res.ok) return refused(401, 'Google did not accept that sign-in — please try again.');
    claims = await res.json();
  } catch {
    return refused(502, 'Google could not be reached to check your sign-in — please try again.');
  }

  if (!claims || claims.aud !== GOOGLE_CLIENT_ID || !GOOGLE_ISSUERS.includes(claims.iss)) {
    return refused(401, 'Google did not accept that sign-in — please try again.');
  }
  if (!(Number(claims.exp) * 1000 > Date.now())) {
    return refused(401, 'That sign-in has expired — please try again.');
  }

  const email = clean(claims.email).toLowerCase();
  const domain = email.split('@')[1] || '';
  const workspace = clean(claims.hd).toLowerCase();
  const verified = claims.email_verified === true || claims.email_verified === 'true';
  if (!verified || !ALLOWED_DOMAINS.includes(domain) || !ALLOWED_DOMAINS.includes(workspace)) {
    return refused(
      403,
      `Please sign in with your ViTrox account (an @${ALLOWED_DOMAINS[0]} email). Personal Google accounts cannot be used here.`
    );
  }

  const name = (clean(claims.name) || email.split('@')[0]).slice(0, MAX_NAME);
  return { ok: true, email, name };
}

module.exports = {
  SESSION_MS,
  json,
  clean,
  loadConfig,
  ensureSecret,
  setRequireSignIn,
  issueToken,
  readSession,
  sessionToken,
  SESSION_EXPIRED,
  checkAccess,
  recordedBy,
  readProfile,
  writeProfile,
  validEmployeeNo,
  verifyGoogleCredential,
};
