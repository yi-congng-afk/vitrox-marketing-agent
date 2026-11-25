const { requireAdmin } = require('./_shared/store-auth');
const {
  SESSION_MS,
  json,
  loadConfig,
  ensureSecret,
  setRequireSignIn,
  issueToken,
  readSession,
  sessionToken,
  SESSION_EXPIRED,
  readProfile,
  writeProfile,
  validEmployeeNo,
  verifyGoogleCredential,
  roleOf,
} = require('./_shared/store-access');
const { audit } = require('./_shared/audit');

// role / isAdmin only decide which buttons the page shows; every admin or
// manager action is checked again on the server.
//   role: 'admin' | 'manager' | null;  isAdmin: may switch on the admin tools
async function publicUser(user) {
  let role = null;
  try {
    role = await roleOf(user.email);
  } catch {
    // Tools stay hidden; the admin password still works.
  }
  return { email: user.email, name: user.name, employeeNo: user.employeeNo || '', expiresAt: user.exp, isAdmin: Boolean(role), role };
}

function parseBody(event) {
  try {
    const body = JSON.parse(event.body || '{}');
    return body && typeof body === 'object' ? body : null;
  } catch {
    return null;
  }
}

// GET    — is sign-in required, and is the session this browser holds still good?
// POST   — sign in with a Google ID token ({ credential })
// PUT    — save the signed-in person's employee number ({ employeeNo })
// PATCH  — admin: switch "sign-in required" on or off ({ requireSignIn })
exports.handler = async (event) => {
  const method = event.httpMethod;

  if (method === 'GET') {
    let config = await loadConfig();
    if (!config.sessionSecret) config = await ensureSecret();

    let user = await readSession(event);
    let token;
    if (user) {
      // Pick up an employee number saved from another device.
      const profile = await readProfile(user.email);
      if (profile && profile.employeeNo && profile.employeeNo !== user.employeeNo) {
        user = { ...user, employeeNo: profile.employeeNo };
        token = issueToken(user, user.exp, (await loadConfig()).sessionSecret);
      }
    }

    return json(200, {
      requireSignIn: config.requireSignIn,
      user: user ? await publicUser(user) : null,
      expired: Boolean(sessionToken(event)) && !user,
      token,
    });
  }

  if (method === 'POST') {
    const body = parseBody(event);
    if (!body) return json(400, { error: 'Invalid request body' });

    const checked = await verifyGoogleCredential(body.credential);
    if (!checked.ok) return json(checked.status, { error: checked.error });

    const config = await ensureSecret();
    const now = new Date().toISOString();
    let existing = null;
    try {
      existing = await readProfile(checked.email);
    } catch {
      // Sign-in still works; the employee number is simply asked for again.
    }
    const user = {
      email: checked.email,
      name: checked.name,
      employeeNo: (existing && existing.employeeNo) || '',
      exp: Date.now() + SESSION_MS,
    };
    try {
      await writeProfile(checked.email, {
        email: user.email,
        name: user.name,
        employeeNo: user.employeeNo,
        firstSeenAt: (existing && existing.firstSeenAt) || now,
        lastSeenAt: now,
      });
    } catch {
      // Not worth failing the sign-in over.
    }

    return json(200, {
      token: issueToken(user, user.exp, config.sessionSecret),
      user: await publicUser(user),
      requireSignIn: config.requireSignIn,
    });
  }

  if (method === 'PUT') {
    const user = await readSession(event);
    if (!user) return SESSION_EXPIRED();

    const body = parseBody(event);
    if (!body) return json(400, { error: 'Invalid request body' });
    const employeeNo = validEmployeeNo(body.employeeNo);
    if (!employeeNo) return json(400, { error: 'Enter your employee number (30 characters at most).' });

    const now = new Date().toISOString();
    const existing = await readProfile(user.email);
    await writeProfile(user.email, {
      email: user.email,
      name: user.name,
      firstSeenAt: (existing && existing.firstSeenAt) || now,
      lastSeenAt: now,
      employeeNo,
    });

    const updated = { ...user, employeeNo };
    const config = await loadConfig();
    return json(200, { token: issueToken(updated, updated.exp, config.sessionSecret), user: await publicUser(updated) });
  }

  if (method === 'PATCH') {
    const adminError = await requireAdmin(event);
    if (adminError) return adminError;

    const body = parseBody(event);
    if (!body || typeof body.requireSignIn !== 'boolean') {
      return json(400, { error: 'requireSignIn must be true or false' });
    }

    // Turning it on needs a working sign-in from the admin doing it, which
    // proves Google sign-in really works on this site before everyone needs it.
    if (body.requireSignIn && !(await readSession(event))) {
      return json(400, {
        error: 'Sign in with your ViTrox account first — that proves sign-in works before it is required for everyone.',
      });
    }

    const before = (await loadConfig({ fresh: true })).requireSignIn;
    const config = await setRequireSignIn(body.requireSignIn);
    if (before !== config.requireSignIn) {
      await audit(event, 'signin.setting', config.requireSignIn ? 'Made ViTrox sign-in required for everyone' : 'Made sign-in optional');
    }
    return json(200, { requireSignIn: config.requireSignIn });
  }

  return { statusCode: 405, body: 'Method Not Allowed' };
};
