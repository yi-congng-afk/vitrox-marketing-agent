'use strict';

const API = {
  items: '/.netlify/functions/store-items',
  txns: '/.netlify/functions/store-transactions',
  reports: '/.netlify/functions/store-reports',
  loans: '/.netlify/functions/store-loans',
  checkout: '/.netlify/functions/store-checkout',
  session: '/.netlify/functions/store-session',
  admin: '/.netlify/functions/store-admin',
};

// Public identifier of this site's "Sign in with Google" client (not a secret).
const GOOGLE_CLIENT_ID = '725610917729-tou01tupum34inr9smfeb9codh1dounr.apps.googleusercontent.com';

const ADMIN_PW_KEY = 'vitroxStoreAdminPw';
const CART_KEY = 'vitroxStoreCart';
const USER_KEY = 'vitroxStoreUser';
const ITEMS_CACHE_KEY = 'vitroxStoreItemsCache';
const SESSION_KEY = 'vitroxStoreSession';

let items = [];
let categories = [];
let activeCategory = 'All';
let searchTerm = '';
let sortMode = 'default';
let selectedItemId = null;
let pendingAdminAction = null;

const el = (id) => document.getElementById(id);

// ---------- Small helpers ----------

function icon(name) {
  return `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

// Local calendar date (not UTC), so "today" and overdue checks match the wall clock.
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const DAY_FORMAT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const TIME_FORMAT = new Intl.DateTimeFormat('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true });

function parseYmd(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '');
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

// "2026-11-30" -> "30 Nov 2026"
function fmtDate(ymd) {
  const d = parseYmd(ymd);
  return d ? DAY_FORMAT.format(d) : ymd || '';
}

// ISO timestamp -> "16 Nov 2026"
function fmtDay(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : DAY_FORMAT.format(d);
}

// ISO timestamp -> "16 Nov 2026, 9:37 am"
function fmtDateTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${DAY_FORMAT.format(d)}, ${TIME_FORMAT.format(d)}`;
}

// ISO timestamp -> "2026-11-16 09:37" (sorts and filters cleanly in Excel)
function csvDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function readStored(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return value === null || value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

function writeStored(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable (private window etc.) — the cart just won't survive a reload.
  }
}

function rememberedUser() {
  const user = readStored(USER_KEY, {});
  return user && typeof user === 'object' ? user : {};
}

function rememberUser(name, employeeNo) {
  const cleanName = String(name || '').trim();
  const cleanNo = String(employeeNo || '').trim();
  if (cleanName && cleanNo) writeStored(USER_KEY, { name: cleanName, employeeNo: cleanNo });
}

function prefillPerson(nameId, employeeNoId) {
  // Typed details are remembered per browser, which may be a shared PC — so a
  // signed-in person is never offered them as their own.
  const user = session ? {} : rememberedUser();
  el(nameId).value = user.name || '';
  el(employeeNoId).value = user.employeeNo || '';
}

function setFormError(id, message) {
  const node = el(id);
  node.textContent = message || '';
  node.hidden = !message;
  if (message) node.scrollIntoView({ block: 'nearest' });
}

// Cart lines: [{ itemId, quantity }]. Kept in this browser until checkout.
let cart = (() => {
  const stored = readStored(CART_KEY, []);
  return Array.isArray(stored) ? stored.filter((l) => l && l.itemId && l.quantity > 0) : [];
})();

// ---------- Admin session ----------

function isAdminUnlocked() {
  try {
    return Boolean(sessionStorage.getItem(ADMIN_PW_KEY));
  } catch {
    return false;
  }
}

function adminHeaders() {
  let pw = null;
  try {
    pw = sessionStorage.getItem(ADMIN_PW_KEY);
  } catch {
    // no session storage — stay locked
  }
  return pw ? { 'x-admin-password': pw } : {};
}

function lockAdmin() {
  try {
    sessionStorage.removeItem(ADMIN_PW_KEY);
  } catch {
    // nothing to clear
  }
  updateAdminUI();
  if (!el('detail-modal').hidden) renderHistory();
}

function updateAdminUI() {
  const unlocked = isAdminUnlocked();
  const btn = el('admin-btn');
  btn.innerHTML = `${icon(unlocked ? 'unlock' : 'lock')}<span class="btn-label">${unlocked ? 'Admin · On' : 'Admin'}</span>`;
  btn.classList.toggle('is-on', unlocked);
  const label = unlocked ? 'Admin mode is on — click to lock' : 'Unlock admin mode';
  btn.setAttribute('aria-label', label);
  btn.title = label;
  document.querySelectorAll('.admin-only').forEach((node) => {
    node.hidden = !unlocked;
  });
  updateGate();
}

// ---------- ViTrox sign-in (who is using the store) ----------

// { token, user: { email, name, employeeNo, expiresAt } } or null. The token is
// issued by the store server after Google confirms a @vitrox.com account.
function readStoredSession() {
  const stored = readStored(SESSION_KEY, null);
  const usable =
    stored &&
    typeof stored.token === 'string' &&
    stored.user &&
    typeof stored.user.email === 'string' &&
    typeof stored.user.name === 'string' &&
    Number(stored.user.expiresAt) > Date.now();
  return usable ? { token: stored.token, user: stored.user } : null;
}

let session = readStoredSession();
// Whether the admin has made sign-in compulsory. Learned from the server.
let requireSignIn = false;

function signedInUser() {
  return session ? session.user : null;
}

function setSession(next) {
  session = next && next.token && next.user ? { token: next.token, user: next.user } : null;
  if (session) writeStored(SESSION_KEY, session);
  else {
    try {
      localStorage.removeItem(SESSION_KEY);
    } catch {
      // nothing stored
    }
  }
  updateAccountUI();
}

function isGated() {
  return requireSignIn && !session && !isAdminUnlocked();
}

// Shows the sign-in screen instead of the store when sign-in is compulsory.
function updateGate() {
  const gated = isGated();
  const wasGated = document.body.classList.contains('gated');
  document.body.classList.toggle('gated', gated);
  el('signin-gate').hidden = !gated;
  if (gated) {
    drawGoogleButton('gate');
  } else if (wasGated) {
    setFormError('gate-error', '');
    if (!itemsLoaded) renderSkeleton();
    loadItems({ silent: true });
    loadReportsBadge();
  }
}

function setRequireSignIn(value) {
  requireSignIn = Boolean(value);
  updateGate();
  updateRequireSignInButton();
}

// ---------- Talking to the server ----------

const OFFLINE = () => ({
  ok: false,
  status: 0,
  data: {},
  error: 'Could not reach the store server — check your connection and try again.',
});

async function send(url, method, body, token) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['x-store-session'] = token;
  // The admin password also gets an admin past a compulsory sign-in, so it
  // goes with every request while Admin is unlocked.
  Object.assign(headers, adminHeaders());

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
  } catch {
    return null;
  }

  let data = {};
  try {
    data = (await res.json()) || {};
  } catch {
    data = {};
  }
  return { res, data };
}

// Never throws. Returns { ok, status, data, error, unauthorized, sessionExpired, signInRequired }.
// anonymousOk: if the sign-in has run out, try once more signed out (fine for
// reading; not for a record that would then be saved without the person's name).
async function request(url, { method = 'GET', body, admin = false, anonymousOk = method === 'GET' } = {}) {
  const sentToken = session ? session.token : null;
  const sentAdmin = isAdminUnlocked();

  let sent = await send(url, method, body, sentToken);
  if (!sent) return OFFLINE();

  if (sent.res.status === 401 && sent.data.code === 'session_expired') {
    if (session && session.token === sentToken) setSession(null);
    if (!anonymousOk) {
      return {
        ok: false,
        status: 401,
        data: sent.data,
        sessionExpired: true,
        error: requireSignIn
          ? 'Your sign-in has expired — nothing was recorded. Please sign in again, then retry.'
          : 'Your sign-in has expired — nothing was recorded. Sign in again, or type your name and employee number, then retry.',
      };
    }
    sent = await send(url, method, body, null);
    if (!sent) return OFFLINE();
  }

  const { res, data } = sent;

  if (res.status === 401 && data.code === 'signin_required') {
    if (sentAdmin) {
      // A correct admin password would have been let through.
      lockAdmin();
      setRequireSignIn(true);
      return {
        ok: false,
        status: 401,
        data,
        unauthorized: true,
        error: 'Admin session expired or incorrect password — please unlock Admin again.',
      };
    }
    setRequireSignIn(true);
    return {
      ok: false,
      status: 401,
      data,
      signInRequired: true,
      error: data.error || 'Please sign in with your ViTrox account to use the store.',
    };
  }

  if (admin && (res.status === 401 || res.status === 403)) {
    lockAdmin();
    return {
      ok: false,
      status: res.status,
      data,
      unauthorized: true,
      error: 'Admin session expired or incorrect password — please unlock Admin again.',
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      data,
      error: data.error || `Something went wrong (error ${res.status}). Please try again.`,
    };
  }
  return { ok: true, status: res.status, data };
}

// Shows a spinner on the button while the task runs and ignores a second click.
async function withBusy(button, task) {
  if (!button) return task();
  if (button.classList.contains('is-busy')) return undefined;
  button.classList.add('is-busy');
  button.disabled = true;
  try {
    return await task();
  } finally {
    button.classList.remove('is-busy');
    button.disabled = false;
  }
}

function submitButton(form) {
  return form.querySelector('button[type="submit"]');
}

// ---------- Toasts ----------

function showToast(message, type = '', duration) {
  const container = el('toast-container');
  while (container.children.length >= 4) container.firstElementChild.remove();

  const toast = document.createElement('div');
  toast.className = `toast ${type}`.trim();
  if (type === 'success' || type === 'error') {
    toast.insertAdjacentHTML('beforeend', icon(type === 'success' ? 'check' : 'alert'));
  }
  const text = document.createElement('span');
  text.textContent = message;
  toast.appendChild(text);
  toast.title = 'Click to dismiss';
  toast.addEventListener('click', () => toast.remove());
  container.appendChild(toast);
  setTimeout(() => toast.remove(), duration || (type === 'error' ? 6500 : 3500));
}

// ---------- Windows (modals), confirm dialog, photo viewer ----------

// Windows opened from another window (e.g. "Report Issue" from an item) go
// back to that window when they are closed, instead of dropping to the grid.
const SUB_MODALS = new Set(['txn-modal', 'edit-txn-modal', 'edit-loan-modal', 'report-modal', 'item-form-modal', 'return-modal', 'admin-modal', 'account-modal']);
// Forms where a stray click outside should not throw away what was typed.
const KEEP_ON_BACKDROP = new Set(['item-form-modal', 'txn-modal', 'edit-txn-modal', 'edit-loan-modal', 'report-modal', 'return-modal', 'categories-modal', 'cleanup-modal']);
const returnTo = {};
let focusBeforeModal = null;

function visibleModal() {
  return [...document.querySelectorAll('.modal-overlay')].find((overlay) => !overlay.hidden) || null;
}

function syncPageLock() {
  const modalOpen = Boolean(visibleModal());
  const onTop = !el('confirm-dialog').hidden || !el('lightbox').hidden;
  document.body.classList.toggle('modal-open', modalOpen || onTop);
  el('app').inert = modalOpen || onTop;
  document.querySelectorAll('.modal-overlay').forEach((overlay) => {
    overlay.inert = onTop;
  });
}

function focusInside(overlay) {
  const dialog = overlay.querySelector('.modal');
  const target = overlay.querySelector('[data-autofocus]') || dialog;
  if (target) target.focus({ preventScroll: true });
}

function openModal(id) {
  const target = el(id);
  const current = visibleModal();
  const alreadyOpen = !target.hidden;

  if (!current) focusBeforeModal = document.activeElement;
  if (!alreadyOpen) {
    if (current && SUB_MODALS.has(id)) returnTo[id] = current.id;
    else delete returnTo[id];
  }

  document.querySelectorAll('.modal-overlay').forEach((overlay) => {
    overlay.hidden = overlay.id !== id;
  });
  syncPageLock();

  if (!alreadyOpen) {
    const dialog = target.querySelector('.modal');
    if (dialog) dialog.scrollTop = 0;
    focusInside(target);
  }
}

function closeModal(id) {
  const overlay = el(id);
  if (overlay.hidden) return;
  overlay.hidden = true;
  if (id === 'admin-modal') pendingAdminAction = null;

  const parentId = returnTo[id];
  delete returnTo[id];
  if (parentId && !visibleModal()) {
    el(parentId).hidden = false;
    syncPageLock();
    focusInside(el(parentId));
    return;
  }

  syncPageLock();
  if (!visibleModal()) {
    if (focusBeforeModal && document.contains(focusBeforeModal)) focusBeforeModal.focus({ preventScroll: true });
    focusBeforeModal = null;
  }
}

document.addEventListener('click', (e) => {
  const closer = e.target.closest('[data-close]');
  if (!closer) return;
  const overlay = closer.closest('.modal-overlay');
  if (overlay) closeModal(overlay.id);
});

// Clicking the dimmed background closes a window — but only a real click that
// both started and ended there (not a text-selection drag that ends outside).
let pointerDownTarget = null;
document.addEventListener('pointerdown', (e) => {
  pointerDownTarget = e.target;
});
document.addEventListener('click', (e) => {
  const overlay = e.target;
  if (!overlay.classList || !overlay.classList.contains('modal-overlay')) return;
  if (pointerDownTarget !== overlay || KEEP_ON_BACKDROP.has(overlay.id)) return;
  closeModal(overlay.id);
});

let confirmResolver = null;
let focusBeforeConfirm = null;

// A nicer replacement for the browser's built-in confirm(). Resolves true/false.
function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = true }) {
  return new Promise((resolve) => {
    if (confirmResolver) confirmResolver(false);
    confirmResolver = resolve;
    el('confirm-title').textContent = title;
    el('confirm-message').textContent = message;
    const ok = el('confirm-ok');
    ok.textContent = confirmLabel;
    ok.className = danger ? 'danger-btn' : 'primary-btn';
    focusBeforeConfirm = document.activeElement;
    el('confirm-dialog').hidden = false;
    syncPageLock();
    el('confirm-cancel').focus();
  });
}

function settleConfirm(result) {
  if (!confirmResolver) return;
  const resolve = confirmResolver;
  confirmResolver = null;
  el('confirm-dialog').hidden = true;
  syncPageLock();
  if (focusBeforeConfirm && document.contains(focusBeforeConfirm)) focusBeforeConfirm.focus({ preventScroll: true });
  focusBeforeConfirm = null;
  resolve(result);
}

el('confirm-ok').addEventListener('click', () => settleConfirm(true));
el('confirm-cancel').addEventListener('click', () => settleConfirm(false));
el('confirm-dialog').addEventListener('click', (e) => {
  if (e.target === el('confirm-dialog') && pointerDownTarget === e.target) settleConfirm(false);
});

let focusBeforeLightbox = null;

function openLightbox(src, alt) {
  if (!src) return;
  el('lightbox-img').src = src;
  el('lightbox-img').alt = alt || '';
  focusBeforeLightbox = document.activeElement;
  el('lightbox').hidden = false;
  syncPageLock();
  el('lightbox-close').focus();
}

function closeLightbox() {
  if (el('lightbox').hidden) return;
  el('lightbox').hidden = true;
  el('lightbox-img').removeAttribute('src');
  syncPageLock();
  if (focusBeforeLightbox && document.contains(focusBeforeLightbox)) focusBeforeLightbox.focus({ preventScroll: true });
  focusBeforeLightbox = null;
}

el('lightbox').addEventListener('click', closeLightbox);

function isTypingTarget(node) {
  return Boolean(node && node.closest && node.closest('input, textarea, select, [contenteditable="true"]'));
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    // Let Escape clear a filled search box first, like it does everywhere else.
    if (e.target && e.target.type === 'search' && e.target.value) return;
    if (!el('lightbox').hidden) closeLightbox();
    else if (confirmResolver) settleConfirm(false);
    else {
      const modal = visibleModal();
      if (!modal) return;
      closeModal(modal.id);
    }
    e.preventDefault();
    return;
  }
  if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !visibleModal() && !isTypingTarget(e.target)) {
    e.preventDefault();
    el('search-input').focus();
  }
});

// − / + buttons beside every quantity box.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-step]');
  if (!btn) return;
  const stepper = btn.closest('.stepper');
  const input = stepper && stepper.querySelector('input[type="number"]');
  if (!input || input.disabled) return;
  const min = input.min !== '' ? Number(input.min) : -Infinity;
  const max = input.max !== '' ? Number(input.max) : Infinity;
  let next = (Math.round(Number(input.value)) || 0) + Number(btn.dataset.step);
  next = Math.min(max, Math.max(min, next));
  if (String(next) !== input.value) {
    input.value = String(next);
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
});

// A photo that fails to load is swapped for the neutral placeholder.
document.addEventListener(
  'error',
  (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.getAttribute('src')) return;
    if (img.classList.contains('item-card-image')) {
      img.insertAdjacentHTML('afterend', `<span class="item-card-image placeholder">${icon('package')}</span>`);
      img.remove();
    } else if (img.classList.contains('cart-line-thumb')) {
      img.insertAdjacentHTML('afterend', `<div class="cart-line-thumb">${icon('package')}</div>`);
      img.remove();
    } else if (img.id === 'detail-item-image') {
      setDetailPhoto('item', null);
    } else if (img.id === 'detail-location-image') {
      setDetailPhoto('location', null);
    }
  },
  true
);

// ---------- Admin unlock ----------

function showAdminPrompt() {
  el('admin-password-input').value = '';
  setFormError('admin-form-error', '');
  openModal('admin-modal');
}

function requireAdminThen(action) {
  if (isAdminUnlocked()) {
    action();
    return;
  }
  pendingAdminAction = action;
  showAdminPrompt();
}

el('admin-btn').addEventListener('click', () => {
  if (isAdminUnlocked()) {
    lockAdmin();
    showToast('Admin mode locked.');
  } else {
    pendingAdminAction = null;
    showAdminPrompt();
  }
});

el('admin-form').addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy(submitButton(e.currentTarget), async () => {
    const pw = el('admin-password-input').value;
    if (!pw) {
      setFormError('admin-form-error', 'Enter the admin password.');
      return;
    }
    try {
      sessionStorage.setItem(ADMIN_PW_KEY, pw);
    } catch {
      setFormError('admin-form-error', 'This browser is blocking session storage, so Admin mode cannot be unlocked here.');
      return;
    }

    // DELETE with a nonexistent id: the server rejects a bad password before the
    // id is even looked up, so this verifies the password without changing data.
    const probe = await request(`${API.items}?id=__admin_probe__`, { method: 'DELETE', admin: true, anonymousOk: true });
    if (probe.unauthorized) {
      setFormError('admin-form-error', 'Incorrect admin password.');
      el('admin-password-input').select();
      return;
    }
    if (probe.status === 0 || probe.status >= 500) {
      lockAdmin();
      setFormError('admin-form-error', probe.status === 0 ? probe.error : 'Could not check the password right now — please try again.');
      return;
    }

    const action = pendingAdminAction;
    pendingAdminAction = null;
    closeModal('admin-modal');
    updateAdminUI();
    if (!el('detail-modal').hidden) renderHistory();
    showToast('Admin mode unlocked.', 'success');
    if (action) action();
  });
});

// ---------- Account: sign in with Google, employee number, sign out ----------

// Every form that asks "who are you?". Signed-in staff are not asked.
const PERSON_FIELDS = [
  { name: 'checkout-name', employeeNo: 'checkout-employee-no', note: 'checkout-person-note' },
  { name: 'txn-name', employeeNo: 'txn-employee-no', note: 'txn-person-note' },
  { name: 'return-name', employeeNo: 'return-employee-no', note: 'return-person-note' },
  { name: 'report-name', employeeNo: 'report-employee-no', note: 'report-person-note' },
];

function firstNameOf(name) {
  return String(name || '').trim().split(/\s+/)[0] || 'Account';
}

function initialsOf(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  return (
    words
      .slice(0, 2)
      .map((word) => Array.from(word)[0])
      .join('')
      .toUpperCase() || '?'
  );
}

// Hides the name / employee-number boxes the store can already fill in. Hidden
// boxes are also disabled so the browser does not insist they be filled.
function syncPersonFields() {
  const user = signedInUser();
  const hasNumber = Boolean(user && user.employeeNo);

  PERSON_FIELDS.forEach((field) => {
    const nameInput = el(field.name);
    const numberInput = el(field.employeeNo);
    nameInput.disabled = Boolean(user);
    nameInput.closest('label').hidden = Boolean(user);
    numberInput.disabled = hasNumber;
    numberInput.closest('label').hidden = hasNumber;
    nameInput.closest('.form-row').hidden = hasNumber;

    const note = el(field.note);
    note.hidden = false;
    note.classList.toggle('is-signed-in', Boolean(user));
    if (hasNumber) {
      note.innerHTML =
        `${icon('user')}<span>Recorded as <strong>${escapeHtml(user.name)}</strong> (${escapeHtml(user.employeeNo)}) · ` +
        `<button type="button" class="link-btn" data-open-account>Change</button></span>`;
    } else if (user) {
      note.innerHTML =
        `${icon('user')}<span>Recorded as <strong>${escapeHtml(user.name)}</strong>. ` +
        `Enter your employee number just this once — the store will remember it.</span>`;
    } else {
      note.innerHTML =
        `${icon('user')}<span><button type="button" class="link-btn" data-open-account>Sign in with your ViTrox account</button> ` +
        `to skip typing your name and employee number.</span>`;
    }
  });
}

// Who a form is being submitted by: the signed-in person, or whatever was typed.
function personFrom(nameId, employeeNoId) {
  const user = signedInUser();
  const typedNumber = el(employeeNoId).value;
  if (!user) return { name: el(nameId).value, employeeNo: typedNumber };
  return { name: user.name, employeeNo: user.employeeNo || typedNumber };
}

// After a form went through: remember who it was, for next time.
async function rememberPerson(person) {
  const user = signedInUser();
  if (!user) {
    rememberUser(person.name, person.employeeNo);
    return;
  }
  const typed = String(person.employeeNo || '').trim();
  if (user.employeeNo || !typed) return;
  // First record since signing in: keep the employee number with the account.
  const res = await request(API.session, { method: 'PUT', body: { employeeNo: typed } });
  if (res.ok && res.data.token && res.data.user) setSession({ token: res.data.token, user: res.data.user });
}

function updateAccountUI() {
  const user = signedInUser();
  const btn = el('account-btn');
  btn.innerHTML = `${icon('user')}<span class="btn-label">${user ? escapeHtml(firstNameOf(user.name)) : 'Sign in'}</span>`;
  btn.classList.toggle('is-on', Boolean(user));
  const label = user ? `Signed in as ${user.name} — open your account` : 'Sign in with your ViTrox account';
  btn.setAttribute('aria-label', label);
  btn.title = label;

  syncPersonFields();
  if (!el('account-modal').hidden) renderAccountModal();
  updateGate();
}

function renderAccountModal() {
  const user = signedInUser();
  el('account-title-text').textContent = user ? 'Your account' : 'Sign in';
  el('account-signed-out').hidden = Boolean(user);
  el('account-form').hidden = !user;

  if (!user) {
    drawGoogleButton('modal');
    return;
  }
  el('account-avatar').textContent = initialsOf(user.name);
  el('account-name').textContent = user.name;
  el('account-email').textContent = user.email;
  el('account-first-note').hidden = Boolean(user.employeeNo);
  const input = el('account-employee-no');
  if (document.activeElement !== input) input.value = user.employeeNo || '';
}

function openAccountModal() {
  setFormError('account-signin-error', '');
  setFormError('account-form-error', '');
  // Opened first: Google can only draw its button inside something visible.
  openModal('account-modal');
  renderAccountModal();
  const user = signedInUser();
  if (user && !user.employeeNo) el('account-employee-no').focus({ preventScroll: true });
}

el('account-btn').addEventListener('click', openAccountModal);

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-open-account]')) openAccountModal();
});

el('account-form').addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy(submitButton(e.currentTarget), async () => {
    setFormError('account-form-error', '');
    const user = signedInUser();
    if (!user) return;
    const employeeNo = el('account-employee-no').value.trim();
    if (!employeeNo) {
      setFormError('account-form-error', 'Enter your employee number.');
      return;
    }
    if (employeeNo === user.employeeNo) {
      closeModal('account-modal');
      return;
    }

    const res = await request(API.session, { method: 'PUT', body: { employeeNo } });
    if (!res.ok) {
      // An expired sign-in has already switched this window back to "Sign in".
      if (res.sessionExpired) setFormError('account-signin-error', 'Your sign-in has expired — please sign in again.');
      else setFormError('account-form-error', res.error);
      return;
    }
    setSession({ token: res.data.token, user: res.data.user });
    closeModal('account-modal');
    showToast('Saved — the store will fill in your details from now on.', 'success');
  });
});

el('signout-btn').addEventListener('click', () => {
  signedOutByChoice = true;
  try {
    googleId().disableAutoSelect();
  } catch {
    // Google's script is not loaded — nothing to switch off.
  }
  setSession(null);
  closeModal('account-modal');
  showToast('Signed out.');
});

// ----- Google Identity Services -----

let googleReady = false;
let googleFailed = false;
let signingIn = false;
let signedOutByChoice = false;
let sessionChecked = false;
let oneTapOffered = false;

const GOOGLE_SLOTS = {
  modal: { slot: 'google-btn-modal', note: 'google-note-modal' },
  gate: { slot: 'google-btn-gate', note: 'google-note-gate' },
};

function googleId() {
  return (window.google && window.google.accounts && window.google.accounts.id) || null;
}

function initGoogle() {
  if (googleReady) return true;
  const gsi = googleId();
  if (!gsi) return false;
  try {
    gsi.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: onGoogleCredential,
      auto_select: true,
      hd: 'vitrox.com',
      context: 'signin',
    });
  } catch {
    return false;
  }
  googleReady = true;
  googleFailed = false;
  if (!el('account-modal').hidden && !session) drawGoogleButton('modal');
  if (isGated()) drawGoogleButton('gate');
  offerOneTap();
  return true;
}

// Google calls this itself once its script has finished loading.
window.onGoogleLibraryLoad = initGoogle;

function drawGoogleButton(which) {
  const slot = el(GOOGLE_SLOTS[which].slot);
  const note = el(GOOGLE_SLOTS[which].note);
  const unavailable = 'Google sign-in could not load here. Check your connection (or an ad blocker), then reload the page.';

  if (!googleReady && !initGoogle()) {
    note.textContent = googleFailed ? unavailable : 'Loading Google sign-in…';
    note.hidden = false;
    return;
  }
  note.hidden = true;
  if (slot.childElementCount > 0) return;
  try {
    googleId().renderButton(slot, {
      type: 'standard',
      theme: 'outline',
      size: 'large',
      text: 'signin_with',
      shape: 'pill',
      logo_alignment: 'left',
      width: 280,
    });
  } catch {
    note.textContent = unavailable;
    note.hidden = false;
  }
}

// Google's own small "Continue as …" prompt, for people who are not signed in yet.
function offerOneTap() {
  if (!googleReady || !sessionChecked || session || signedOutByChoice || oneTapOffered) return;
  oneTapOffered = true;
  try {
    googleId().prompt();
  } catch {
    // The button in the Sign in window still works.
  }
}

function showSignInError(message) {
  if (!el('account-modal').hidden) setFormError('account-signin-error', message);
  else if (isGated()) setFormError('gate-error', message);
  else showToast(message, 'error');
}

// Google hands over a signed proof of who the person is; the store server
// checks it (and that it is a @vitrox.com account) and starts a store session.
async function onGoogleCredential(response) {
  const credential = response && response.credential;
  if (!credential || signingIn) return;
  signingIn = true;
  setFormError('account-signin-error', '');
  setFormError('gate-error', '');
  const res = await request(API.session, { method: 'POST', body: { credential }, anonymousOk: true });
  signingIn = false;

  if (!res.ok) {
    if (res.status === 403) {
      // Wrong kind of account — let them pick another one next time.
      try {
        googleId().disableAutoSelect();
      } catch {
        // not loaded
      }
    }
    showSignInError(res.error);
    return;
  }
  if (!res.data.token || !res.data.user) {
    showSignInError('Sign-in did not complete — please try again.');
    return;
  }

  signedOutByChoice = false;
  requireSignIn = Boolean(res.data.requireSignIn);
  setSession({ token: res.data.token, user: res.data.user });
  updateRequireSignInButton();

  const user = signedInUser();
  if (!user.employeeNo) {
    // One last step, once: the employee number Google does not know. Any number
    // already sitting in a form was remembered for whoever typed it last.
    PERSON_FIELDS.forEach((field) => {
      el(field.employeeNo).value = '';
    });
    openAccountModal();
  } else {
    closeModal('account-modal');
    showToast(`Signed in as ${user.name}.`, 'success');
  }
}

// Asks the server whether sign-in is compulsory and whether the sign-in this
// browser remembers is still good.
async function checkSession() {
  const sentToken = session ? session.token : null;
  const res = await request(API.session);
  sessionChecked = true;
  if (res.ok) {
    if (session && session.token === sentToken) {
      if (res.data.user) setSession({ token: res.data.token || session.token, user: res.data.user });
      else {
        setSession(null);
        showToast('Your sign-in has expired — please sign in again.');
      }
    }
    setRequireSignIn(res.data.requireSignIn);
  }
  offerOneTap();
}

// Signing in or out in one tab carries over to the other open tabs.
window.addEventListener('storage', (e) => {
  if (e.key !== null && e.key !== SESSION_KEY) return;
  const stored = readStoredSession();
  if ((stored ? stored.token : null) === (session ? session.token : null)) return;
  session = stored;
  updateAccountUI();
});

// ----- Admin: make sign-in compulsory, or optional again -----

function updateRequireSignInButton() {
  const btn = el('require-signin-btn');
  btn.innerHTML = `${icon(requireSignIn ? 'lock' : 'user')} Sign-in: ${requireSignIn ? 'Required' : 'Optional'}`;
  btn.title = requireSignIn
    ? 'Everyone must sign in with a ViTrox account. Click to make sign-in optional again.'
    : 'Sign-in is optional. Click to require a ViTrox account from everyone.';
}

el('require-signin-btn').addEventListener('click', async () => {
  const turningOn = !requireSignIn;
  if (turningOn && !session) {
    showToast('Sign in with your own ViTrox account first — that proves sign-in works before everyone needs it.', 'error', 8000);
    openAccountModal();
    return;
  }

  const confirmed = await confirmDialog(
    turningOn
      ? {
          title: 'Require ViTrox sign-in?',
          message:
            'Everyone will have to sign in with their @vitrox.com Google account before they can see or use the store. ' +
            'The admin password still gets you in without signing in, so you can always switch this back.',
          confirmLabel: 'Require sign-in',
          danger: false,
        }
      : {
          title: 'Make sign-in optional again?',
          message:
            'Anyone with the link will be able to use the store and type their name and employee number by hand. ' +
            'Staff who do sign in are still recorded automatically.',
          confirmLabel: 'Make optional',
          danger: false,
        }
  );
  if (!confirmed) return;

  withBusy(el('require-signin-btn'), async () => {
    const res = await request(API.session, { method: 'PATCH', admin: true, body: { requireSignIn: turningOn } });
    if (!res.ok) {
      showToast(res.error, 'error', 8000);
      return;
    }
    setRequireSignIn(res.data.requireSignIn);
    showToast(
      res.data.requireSignIn ? 'Sign-in is now required for everyone.' : 'Sign-in is now optional.',
      'success'
    );
  });
});

// ---------- Photos ----------

function readImageAsCompressedDataUrl(file, maxDim = 900, quality = 0.72) {
  return new Promise((resolve, reject) => {
    if (!file) return resolve(null);
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that file'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('That file is not a photo this browser can open'));
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const scale = maxDim / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        // JPEG has no transparency — without this, see-through PNG areas turn black.
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// ---------- Loading the stock list ----------

let itemsLoaded = false;
let itemsSignature = '';
let loadSeq = 0;
let latestLoad = null;
let lastLoadedAt = 0;
let lastLoadAttemptAt = 0;

function updateLastUpdated() {
  el('last-updated').textContent = lastLoadedAt ? `Updated ${TIME_FORMAT.format(new Date(lastLoadedAt))}` : 'Refresh';
}

function setRefreshing(on) {
  el('refresh-btn').classList.toggle('is-refreshing', on);
  if (on) el('last-updated').textContent = 'Updating…';
  else updateLastUpdated();
}

function renderSkeleton() {
  el('empty-state').hidden = true;
  el('load-error').hidden = true;
  el('results-count').textContent = 'Loading items…';
  el('item-grid').innerHTML = '<div class="skeleton-card" aria-hidden="true"></div>'.repeat(8);
}

function showLoadError(message) {
  el('item-grid').innerHTML = '';
  el('empty-state').hidden = true;
  el('results-count').textContent = '';
  el('load-error-text').textContent = message;
  el('load-error').hidden = false;
}

// Returns true when the list on screen actually changed.
function applyItems(nextItems, nextCategories, { fromCache = false } = {}) {
  const signature = JSON.stringify([nextItems, nextCategories]);
  const changed = !itemsLoaded || signature !== itemsSignature;
  itemsLoaded = true;
  el('load-error').hidden = true;

  if (changed) {
    itemsSignature = signature;
    items = nextItems;
    categories = nextCategories;
    if (activeCategory !== 'All' && !items.some((i) => i.category === activeCategory)) activeCategory = 'All';
  }

  if (!fromCache) {
    // Drop cart lines whose item has since been deleted from the catalog.
    const stillExists = cart.filter((line) => items.some((i) => i.id === line.itemId));
    if (stillExists.length !== cart.length) {
      cart = stillExists;
      saveCart();
    }
    // Keep a copy for an instant first paint next time (skipped while photos are
    // still stored inside the list, which would be too big for browser storage).
    if (signature.length < 300000) writeStored(ITEMS_CACHE_KEY, { items, categories });
    else {
      try {
        localStorage.removeItem(ITEMS_CACHE_KEY);
      } catch {
        // nothing cached
      }
    }
  }

  if (!changed) return false;
  renderCategoryChips();
  renderGrid();
  renderLowStockBanner();
  refreshOpenViews();
  return true;
}

// Keeps whichever window is open in step with freshly loaded stock numbers.
function refreshOpenViews() {
  if (!el('detail-modal').hidden && selectedItemId) {
    const item = items.find((i) => i.id === selectedItemId);
    if (item) renderDetail(item, { resetQty: false });
    else {
      closeModal('detail-modal');
      showToast('That item has been removed from the catalog.');
    }
  }
  if (!el('cart-modal').hidden && !el('cart-lines').contains(document.activeElement)) renderCart();
}

function loadItems(options) {
  const promise = runLoadItems(options);
  latestLoad = promise;
  return promise;
}

async function runLoadItems({ silent = false } = {}) {
  const seq = ++loadSeq;
  lastLoadAttemptAt = Date.now();
  setRefreshing(true);
  const res = await request(API.items);
  // A newer load started meanwhile — its answer is the one that counts.
  if (seq !== loadSeq) return latestLoad;

  if (!res.ok) {
    setRefreshing(false);
    // "Please sign in" is shown by the sign-in screen, not as a loading failure.
    if (res.signInRequired || isGated()) return false;
    if (!itemsLoaded) showLoadError(res.error);
    else if (!silent) showToast(`Could not refresh the stock list. ${res.error}`, 'error');
    return false;
  }

  lastLoadedAt = Date.now();
  setRefreshing(false);
  // The list came back without a sign-in, so sign-in is no longer compulsory.
  if (isGated()) setRequireSignIn(false);
  applyItems(res.data.items || [], res.data.categories || []);
  return true;
}

const BADGE_OWNERS = {
  'cart-badge': { button: 'cart-btn', label: 'Open cart', counted: (n) => `Open cart — ${plural(n, 'item', 'items')} in it` },
  'loans-badge': { button: 'loans-btn', label: 'Loan records', counted: (n) => `Loan records — ${n} not yet returned` },
  'reports-badge': { button: 'reports-btn', label: 'Alerts and reports', counted: (n) => `Alerts and reports — ${n} open` },
};

function setBadge(id, count) {
  const badge = el(id);
  badge.hidden = count <= 0;
  badge.textContent = String(count);
  const owner = BADGE_OWNERS[id];
  if (owner) el(owner.button).setAttribute('aria-label', count > 0 ? owner.counted(count) : owner.label);
}

async function loadReportsBadge() {
  const [reports, loans] = await Promise.all([request(`${API.reports}?status=open`), request(`${API.loans}?status=open`)]);
  if (!loans.ok) return;
  const openLoans = loans.data.loans || [];
  setBadge('loans-badge', openLoans.length);
  if (!reports.ok) return;
  setBadge('reports-badge', (reports.data.reports || []).length + openLoans.filter(isOverdue).length);
}

function refreshIfStale(maxAgeMs) {
  if (document.visibilityState !== 'visible') return;
  if (Date.now() - lastLoadAttemptAt < maxAgeMs) return;
  loadItems({ silent: true });
  loadReportsBadge();
}

// Someone else may have moved stock while this tab sat in the background.
document.addEventListener('visibilitychange', () => refreshIfStale(60 * 1000));
window.addEventListener('focus', () => refreshIfStale(60 * 1000));
setInterval(() => refreshIfStale(9 * 60 * 1000), 10 * 60 * 1000);

el('refresh-btn').addEventListener('click', () => {
  loadItems();
  loadReportsBadge();
});

el('retry-btn').addEventListener('click', () => {
  renderSkeleton();
  loadItems();
  loadReportsBadge();
});

// ---------- Dashboard: banner, filters, grid ----------

function availableQty(item) {
  const available = item.returnable ? item.quantity - (item.quantityOnLoan || 0) : item.quantity;
  return Math.max(0, available || 0);
}

function lowStockItems() {
  return items.filter((i) => availableQty(i) <= i.lowStockThreshold);
}

function renderLowStockBanner() {
  const low = lowStockItems();
  const banner = el('low-stock-banner');
  if (low.length === 0) {
    banner.hidden = true;
    banner.innerHTML = '';
    return;
  }
  const names = low.slice(0, 3).map((i) => i.name).join(', ');
  const more = low.length > 3 ? ` +${low.length - 3} more` : '';
  banner.innerHTML = `${icon('alert')}<span class="banner-text"></span><button type="button">View</button>`;
  banner.querySelector('.banner-text').textContent = `${low.length} item${low.length > 1 ? 's are' : ' is'} running low: ${names}${more}`;
  banner.querySelector('button').addEventListener('click', () => openReportsPanel());
  banner.hidden = false;
}

function renderCategoryChips() {
  const counts = {};
  items.forEach((i) => {
    counts[i.category] = (counts[i.category] || 0) + 1;
  });
  const unlisted = [...new Set(items.map((i) => i.category))].filter((c) => c && !categories.includes(c));
  el('category-filters').innerHTML = ['All', ...categories, ...unlisted]
    .map((cat) => {
      const active = cat === activeCategory;
      const count = cat === 'All' ? items.length : counts[cat] || 0;
      return `<button type="button" class="chip${active ? ' active' : ''}" data-category="${escapeHtml(cat)}" aria-pressed="${active}">${escapeHtml(cat)}<span class="chip-count">${count}</span></button>`;
    })
    .join('');
}

el('category-filters').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-category]');
  if (!chip) return;
  activeCategory = chip.dataset.category;
  renderCategoryChips();
  renderGrid();
  const again = [...el('category-filters').children].find((c) => c.dataset.category === activeCategory);
  if (again) again.focus({ preventScroll: true });
});

function filteredItems() {
  const terms = searchTerm.toLowerCase().split(/\s+/).filter(Boolean);
  const list = items.filter((item) => {
    if (activeCategory !== 'All' && item.category !== activeCategory) return false;
    if (terms.length === 0) return true;
    const haystack = `${item.name} ${item.category} ${item.locationText || ''} ${item.notes || ''}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });

  if (sortMode === 'name') list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  else if (sortMode === 'low') list.sort((a, b) => availableQty(a) - availableQty(b));
  else if (sortMode === 'high') list.sort((a, b) => availableQty(b) - availableQty(a));
  return list;
}

function cardHtml(item) {
  const available = availableQty(item);
  const unit = escapeHtml(item.unit || 'pcs');
  const low = available <= item.lowStockThreshold;
  const onLoan = item.returnable ? item.quantityOnLoan || 0 : 0;
  const inCart = cartQty(item.id);
  const room = available - inCart;
  const name = escapeHtml(item.name);

  const media = item.itemImage
    ? `<img class="item-card-image" src="${escapeHtml(item.itemImage)}" alt="" loading="lazy" decoding="async" />`
    : `<span class="item-card-image placeholder">${icon('package')}</span>`;

  const pills =
    `<span class="qty-pill ${low ? 'low' : 'ok'}">${available} ${unit} avail.</span>` +
    (onLoan > 0 ? `<span class="on-loan-tag">${onLoan} on loan</span>` : '') +
    (inCart > 0 ? `<span class="in-cart-tag">${icon('cart')} ${inCart} in cart</span>` : '');

  let cartRow;
  if (available <= 0) {
    cartRow = `<span class="muted">${onLoan > 0 ? 'All out on loan' : 'Out of stock'}</span>`;
  } else if (room <= 0) {
    cartRow = `<span class="muted">All ${available} already in your cart</span>`;
  } else {
    cartRow =
      `<span class="stepper">` +
      `<button type="button" class="step-btn" data-step="-1" tabindex="-1" aria-label="Decrease quantity">${icon('minus')}</button>` +
      `<input type="number" inputmode="numeric" data-role="qty" min="1" max="${room}" step="1" value="1" aria-label="Quantity of ${name} to add to cart" />` +
      `<button type="button" class="step-btn" data-step="1" tabindex="-1" aria-label="Increase quantity">${icon('plus')}</button>` +
      `</span>` +
      `<button type="button" class="primary-btn" data-role="add" aria-label="Add ${name} to cart">${icon('cart')} Add</button>`;
  }

  return (
    `<article class="item-card${available <= 0 ? ' is-out' : ''}" data-id="${escapeHtml(item.id)}">` +
    `<button type="button" class="item-card-main" data-role="open">` +
    `<span class="item-card-media">${media}</span>` +
    `<span class="item-card-body">` +
    `<span class="tag">${escapeHtml(item.category)}</span>` +
    `<span class="item-card-name">${name}</span>` +
    `<span class="item-card-qty">${pills}</span>` +
    `</span></button>` +
    `<div class="card-cart-row">${cartRow}</div>` +
    `</article>`
  );
}

function findCard(itemId) {
  return [...el('item-grid').querySelectorAll('.item-card')].find((card) => card.dataset.id === itemId) || null;
}

function renderGrid() {
  if (!itemsLoaded) return;
  const grid = el('item-grid');
  const list = filteredItems();

  // Remember half-typed quantities and where the keyboard focus is, so a
  // background refresh never interrupts someone in the middle of something.
  const typed = {};
  grid.querySelectorAll('.item-card').forEach((card) => {
    const input = card.querySelector('[data-role="qty"]');
    if (input && input.value !== '1') typed[card.dataset.id] = input.value;
  });
  let focusOn = null;
  const active = document.activeElement;
  if (active && grid.contains(active)) {
    const card = active.closest('.item-card');
    if (card) {
      focusOn = {
        id: card.dataset.id,
        selector: active.dataset.step ? `[data-step="${active.dataset.step}"]` : `[data-role="${active.dataset.role || 'open'}"]`,
      };
    }
  }

  grid.innerHTML = list.map(cardHtml).join('');

  Object.keys(typed).forEach((id) => {
    const card = findCard(id);
    const input = card && card.querySelector('[data-role="qty"]');
    if (input) input.value = typed[id];
  });
  if (focusOn) {
    const card = findCard(focusOn.id);
    const target = card && (card.querySelector(focusOn.selector) || card.querySelector('[data-role="open"]'));
    if (target) target.focus({ preventScroll: true });
  }

  el('results-count').textContent =
    list.length === items.length ? plural(items.length, 'item', 'items') : `${list.length} of ${plural(items.length, 'item', 'items')}`;

  const empty = el('empty-state');
  empty.hidden = list.length > 0;
  if (list.length === 0) {
    const noItems = items.length === 0;
    empty.querySelector('.state-title').textContent = noItems ? 'No items yet' : 'No items match';
    empty.querySelector('.state-text').textContent = noItems
      ? 'Unlock Admin to add the first item to the store.'
      : 'Try a different search word or category.';
    el('clear-filters-btn').hidden = noItems;
  }
}

function addFromCard(card) {
  const input = card.querySelector('[data-role="qty"]');
  if (!input) return;
  const wanted = input.value;
  input.value = '1';
  if (!addToCart(card.dataset.id, wanted)) input.value = wanted;
}

el('item-grid').addEventListener('click', (e) => {
  const card = e.target.closest('.item-card');
  if (!card) return;
  if (e.target.closest('[data-role="add"]')) addFromCard(card);
  else if (e.target.closest('[data-role="open"]')) openDetail(card.dataset.id);
});

el('item-grid').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !e.target.matches('[data-role="qty"]')) return;
  e.preventDefault();
  addFromCard(e.target.closest('.item-card'));
});

el('search-input').addEventListener('input', (e) => {
  searchTerm = e.target.value;
  renderGrid();
});

el('sort-select').addEventListener('change', (e) => {
  sortMode = e.target.value;
  renderGrid();
});

el('clear-filters-btn').addEventListener('click', () => {
  searchTerm = '';
  activeCategory = 'All';
  el('search-input').value = '';
  renderCategoryChips();
  renderGrid();
  el('search-input').focus();
});

// ---------- Item detail ----------

function setDetailPhoto(kind, url, alt) {
  const img = el(`detail-${kind}-image`);
  if (url) {
    if (img.getAttribute('src') !== url) img.src = url;
    img.alt = alt || '';
  } else {
    img.removeAttribute('src');
  }
  el(`detail-${kind}-frame`).hidden = !url;
  el(`detail-${kind}-empty`).hidden = Boolean(url);
}

['item', 'location'].forEach((kind) => {
  el(`detail-${kind}-frame`).addEventListener('click', () => {
    const img = el(`detail-${kind}-image`);
    openLightbox(img.currentSrc || img.src, img.alt);
  });
});

function renderDetailStock(item, resetQty) {
  const available = availableQty(item);
  const onLoan = item.returnable ? item.quantityOnLoan || 0 : 0;
  const inCart = cartQty(item.id);
  const room = available - inCart;

  el('detail-qty').textContent = available;
  el('detail-low-stock').hidden = available > item.lowStockThreshold;
  el('detail-on-loan-row').hidden = onLoan <= 0;
  el('detail-on-loan').textContent = onLoan;

  const qty = el('detail-cart-qty');
  if (resetQty) qty.value = '1';
  qty.max = String(Math.max(room, 1));
  qty.disabled = room <= 0;
  qty.closest('.stepper')
    .querySelectorAll('.step-btn')
    .forEach((btn) => {
      btn.disabled = room <= 0;
    });

  let label = 'Add to Cart';
  if (available <= 0) label = onLoan > 0 ? 'All out on loan' : 'Out of stock';
  else if (room <= 0) label = `All ${available} in your cart`;
  else if (inCart > 0) label = `Add to Cart (${inCart} in cart)`;
  const btn = el('detail-cart-btn');
  btn.disabled = room <= 0;
  btn.innerHTML = `${icon('cart')} ${escapeHtml(label)}`;
}

function renderDetail(item, { resetQty }) {
  const unit = item.unit || 'pcs';
  el('detail-category').textContent = item.category;
  el('detail-name').textContent = item.name;
  el('detail-location-text').textContent = item.locationText || 'Location not specified';
  el('detail-unit').textContent = unit;
  el('detail-unit-2').textContent = unit;
  el('detail-notes').textContent = item.notes || '';
  el('detail-return-btn').hidden = !item.returnable;
  el('detail-loanable-note').hidden = !item.returnable;
  setDetailPhoto('item', item.itemImage, `Photo of ${item.name}`);
  setDetailPhoto('location', item.locationImage, `Where ${item.name} is kept`);
  renderDetailStock(item, resetQty);
}

async function openDetail(itemId) {
  const item = items.find((i) => i.id === itemId);
  if (!item) return;
  const fresh = selectedItemId !== itemId || el('detail-modal').hidden;
  selectedItemId = itemId;
  renderDetail(item, { resetQty: true });
  openModal('detail-modal');
  await loadHistory(itemId, { showLoading: fresh });
}

let historySeq = 0;
let historyEvents = [];
let historyTotal = 0;

async function loadHistory(itemId, { showLoading = true } = {}) {
  const seq = ++historySeq;
  const body = el('detail-history-body');
  if (showLoading) body.innerHTML = '<tr><td colspan="6" class="muted-cell">Loading activity…</td></tr>';

  const id = encodeURIComponent(itemId);
  const [txns, loans] = await Promise.all([request(`${API.txns}?itemId=${id}`), request(`${API.loans}?itemId=${id}`)]);
  // The person has opened a different item meanwhile — drop this answer.
  if (seq !== historySeq) return;

  if (!txns.ok || !loans.ok) {
    historyEvents = [];
    historyTotal = 0;
    body.innerHTML = '<tr><td colspan="6" class="muted-cell">Could not load the activity for this item. Close and reopen it to try again.</td></tr>';
    return;
  }

  const events = [];
  (txns.data.transactions || []).forEach((t) => events.push({ timestamp: t.timestamp, kind: 'txn', data: t }));
  (loans.data.loans || []).forEach((l) => {
    events.push({ timestamp: l.loanedAt, kind: 'loan-out', data: l });
    (l.returns || []).forEach((r) => events.push({ timestamp: r.returnedAt, kind: 'loan-return', data: { ...r, loan: l } }));
  });
  events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  historyTotal = events.length;
  historyEvents = events.slice(0, 15);
  renderHistory();
}

function renderHistory() {
  const body = el('detail-history-body');
  if (historyEvents.length === 0) {
    body.innerHTML = '<tr><td colspan="6" class="muted-cell">No activity yet.</td></tr>';
    return;
  }
  const admin = isAdminUnlocked();
  const person = (p) => `${escapeHtml(p.name)} (${escapeHtml(p.employeeNo)})`;

  const rows = historyEvents.map((event) => {
    const date = `<td class="nowrap">${escapeHtml(fmtDateTime(event.timestamp))}</td>`;
    if (event.kind === 'txn') {
      const t = event.data;
      const type = t.type === 'add' ? '<span class="type-label add">Add On</span>' : '<span class="type-label">Move Out</span>';
      const actions = admin
        ? `<button type="button" class="icon-btn" data-txn-edit="${escapeHtml(t.id)}" aria-label="Edit this record" title="Edit this record">${icon('pencil')}</button>` +
          `<button type="button" class="icon-btn danger-text" data-txn-delete="${escapeHtml(t.id)}" aria-label="Delete this record" title="Delete this record">${icon('trash')}</button>`
        : '';
      return `<tr>${date}<td>${type}</td><td>${t.quantity}</td><td>${person(t)}</td><td>${escapeHtml(t.remarks || '')}</td><td class="row-actions">${actions}</td></tr>`;
    }
    if (event.kind === 'loan-out') {
      const l = event.data;
      const due = l.expectedReturnDate ? ` · due ${escapeHtml(fmtDate(l.expectedReturnDate))}` : '';
      return `<tr>${date}<td><span class="type-label">Move Out</span></td><td>${l.quantity}</td><td>${person(l)}</td><td>${escapeHtml(l.purpose)}${due}</td><td class="row-actions">${admin ? loanAdminButtons(l) : ''}</td></tr>`;
    }
    const r = event.data;
    const remarks = [r.notes, `against loan to ${r.loan.name}`].filter(Boolean).join(' · ');
    const who = r.employeeNo ? person(r) : escapeHtml(r.name);
    if (r.adjustment) {
      const qty = r.quantity > 0 ? `+${r.quantity}` : String(r.quantity);
      return `<tr>${date}<td><span class="type-label">Correction</span></td><td>${qty} returned</td><td>${who}</td><td>${escapeHtml(remarks)}</td><td class="row-actions"></td></tr>`;
    }
    return `<tr>${date}<td><span class="type-label ret">Return</span></td><td>${r.quantity}</td><td>${who}</td><td>${escapeHtml(remarks)}</td><td class="row-actions"></td></tr>`;
  });

  if (historyTotal > historyEvents.length) {
    rows.push(
      `<tr><td colspan="6" class="muted-cell">Showing the latest ${historyEvents.length} of ${historyTotal} — export the Activity log for the full history.</td></tr>`
    );
  }
  body.innerHTML = rows.join('');
}

el('detail-history-body').addEventListener('click', (e) => {
  const loanBtn = e.target.closest('[data-loan-edit], [data-loan-delete]');
  if (loanBtn) {
    const loanId = loanBtn.dataset.loanEdit || loanBtn.dataset.loanDelete;
    const event = historyEvents.find((ev) => ev.kind === 'loan-out' && ev.data.id === loanId);
    if (!event) return;
    if (loanBtn.dataset.loanEdit) requireAdminThen(() => openEditLoanModal(event.data, 'detail'));
    else requireAdminThen(() => deleteLoan(event.data, 'detail'));
    return;
  }
  const editBtn = e.target.closest('[data-txn-edit]');
  const deleteBtn = e.target.closest('[data-txn-delete]');
  const id = editBtn ? editBtn.dataset.txnEdit : deleteBtn ? deleteBtn.dataset.txnDelete : null;
  if (!id) return;
  const event = historyEvents.find((ev) => ev.kind === 'txn' && ev.data.id === id);
  if (!event) return;
  if (editBtn) requireAdminThen(() => openEditTxnModal(event.data));
  else requireAdminThen(() => deleteTxn(event.data));
});

let editingTxnId = null;

function openEditTxnModal(t) {
  editingTxnId = t.id;
  el('edit-txn-type').value = t.type;
  el('edit-txn-quantity').value = t.quantity;
  el('edit-txn-name').value = t.name;
  el('edit-txn-employee-no').value = t.employeeNo;
  el('edit-txn-remarks').value = t.remarks || '';
  setFormError('edit-txn-form-error', '');
  openModal('edit-txn-modal');
}

el('edit-txn-form').addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy(submitButton(e.currentTarget), async () => {
    setFormError('edit-txn-form-error', '');
    const res = await request(`${API.txns}?id=${encodeURIComponent(editingTxnId)}`, {
      method: 'PATCH',
      admin: true,
      body: {
        type: el('edit-txn-type').value,
        quantity: Number(el('edit-txn-quantity').value),
        name: el('edit-txn-name').value,
        employeeNo: el('edit-txn-employee-no').value,
        remarks: el('edit-txn-remarks').value,
      },
    });
    if (!res.ok) {
      setFormError('edit-txn-form-error', res.error);
      return;
    }
    closeModal('edit-txn-modal');
    showToast('Activity record updated.', 'success');
    await loadItems({ silent: true });
    await openDetail(selectedItemId);
  });
});

async function deleteTxn(t) {
  const confirmed = await confirmDialog({
    title: 'Delete this activity record?',
    message: 'The item’s current quantity will be adjusted to compensate. This cannot be undone.',
    confirmLabel: 'Delete record',
  });
  if (!confirmed) return;

  const res = await request(`${API.txns}?id=${encodeURIComponent(t.id)}`, { method: 'DELETE', admin: true });
  if (!res.ok) {
    showToast(res.error, 'error');
    return;
  }
  showToast('Activity record deleted.', 'success');
  await loadItems({ silent: true });
  await openDetail(selectedItemId);
}

// ---------- Add On (admin only) ----------

el('detail-addon-btn').addEventListener('click', () => requireAdminThen(openAddOnModal));

function openAddOnModal() {
  const item = items.find((i) => i.id === selectedItemId);
  if (!item) return;
  el('txn-modal-item').textContent = `${item.name} — currently ${item.quantity} ${item.unit || 'pcs'} in total`;
  prefillPerson('txn-name', 'txn-employee-no');
  el('txn-quantity').value = '';
  el('txn-remarks').value = '';
  setFormError('txn-form-error', '');
  openModal('txn-modal');
}

el('txn-form').addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy(submitButton(e.currentTarget), async () => {
    setFormError('txn-form-error', '');
    const body = {
      itemId: selectedItemId,
      type: 'add',
      quantity: Number(el('txn-quantity').value),
      ...personFrom('txn-name', 'txn-employee-no'),
      remarks: el('txn-remarks').value,
    };
    const res = await request(API.txns, { method: 'POST', admin: true, body });
    if (!res.ok) {
      setFormError('txn-form-error', res.error);
      return;
    }
    rememberPerson(body);
    closeModal('txn-modal');
    showToast(`Added ${body.quantity} to stock.`, 'success');
    await loadItems({ silent: true });
    await openDetail(selectedItemId);
  });
});

// ---------- Cart + checkout (the only way stock is moved out) ----------

function saveCart() {
  writeStored(CART_KEY, cart);
  setBadge('cart-badge', cart.length);
}

function cartQty(itemId) {
  const line = cart.find((l) => l.itemId === itemId);
  return line ? line.quantity : 0;
}

function cartLoanableItems() {
  return cart.map((line) => items.find((i) => i.id === line.itemId)).filter((item) => item && item.returnable);
}

// Call after any change to the cart so every view that shows it stays in step.
function cartChanged() {
  saveCart();
  renderGrid();
  if (!el('detail-modal').hidden) {
    const item = items.find((i) => i.id === selectedItemId);
    if (item) renderDetailStock(item, true);
  }
}

function addToCart(itemId, rawQuantity) {
  const item = items.find((i) => i.id === itemId);
  if (!item) return false;
  const quantity = Math.round(Number(rawQuantity));
  if (!quantity || quantity <= 0) {
    showToast('Enter a quantity of at least 1.', 'error');
    return false;
  }

  const unit = item.unit || 'pcs';
  const available = availableQty(item);
  const already = cartQty(itemId);
  if (already + quantity > available) {
    showToast(
      already > 0
        ? `Only ${available} ${unit} of "${item.name}" available — you already have ${already} in your cart.`
        : `Only ${available} ${unit} of "${item.name}" available.`,
      'error'
    );
    return false;
  }

  const line = cart.find((l) => l.itemId === itemId);
  if (line) line.quantity += quantity;
  else cart.push({ itemId, quantity });
  cartChanged();
  showToast(`Added ${quantity} × ${item.name} to cart.`, 'success');
  return true;
}

el('detail-cart-btn').addEventListener('click', () => addToCart(selectedItemId, el('detail-cart-qty').value));

el('detail-cart-qty').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  addToCart(selectedItemId, el('detail-cart-qty').value);
});

function cartLineWarning(line, available) {
  if (line.quantity <= available) return '';
  return available > 0 ? `Only ${available} left — lower the quantity.` : 'No longer available — remove this line.';
}

function renderCart() {
  const container = el('cart-lines');
  container.innerHTML = '';
  el('cart-empty').hidden = cart.length > 0;
  el('checkout-form').hidden = cart.length === 0;

  cart.forEach((line) => {
    const item = items.find((i) => i.id === line.itemId);
    if (!item) return;
    const available = availableQty(item);
    const unit = item.unit || 'pcs';
    const name = escapeHtml(item.name);
    const warning = cartLineWarning(line, available);

    const thumb = item.itemImage
      ? `<img class="cart-line-thumb" src="${escapeHtml(item.itemImage)}" alt="" loading="lazy" decoding="async" />`
      : `<div class="cart-line-thumb">${icon('package')}</div>`;

    const row = document.createElement('div');
    row.className = 'cart-line';
    row.dataset.itemId = item.id;
    row.innerHTML =
      thumb +
      `<div class="line-info"><strong>${name}</strong>` +
      `<div class="line-meta">${available} ${escapeHtml(unit)} available` +
      (item.returnable ? `<span class="on-loan-tag">${icon('return')} Loan — must return</span>` : '') +
      `</div>` +
      `<div class="line-warning"${warning ? '' : ' hidden'}>${escapeHtml(warning)}</div></div>` +
      `<span class="stepper">` +
      `<button type="button" class="step-btn" data-step="-1" aria-label="Decrease quantity">${icon('minus')}</button>` +
      `<input type="number" inputmode="numeric" min="1" max="${Math.max(available, 1)}" step="1" value="${line.quantity}" aria-label="Quantity of ${name}" />` +
      `<button type="button" class="step-btn" data-step="1" aria-label="Increase quantity">${icon('plus')}</button>` +
      `</span>` +
      `<button type="button" class="icon-btn danger-text" data-remove aria-label="Remove ${name} from cart" title="Remove from cart">${icon('trash')}</button>`;
    container.appendChild(row);
  });

  const loanable = cartLoanableItems();
  const hasLoanable = loanable.length > 0;
  el('checkout-return-label').hidden = !hasLoanable;
  el('checkout-return-date').required = hasLoanable;
  const note = el('checkout-loan-note');
  note.hidden = !hasLoanable;
  note.innerHTML = hasLoanable
    ? `${icon('return')}<span>${escapeHtml(loanable.map((i) => i.name).join(', '))} will be recorded as on loan under your name until returned (Loan Records → Return).</span>`
    : '';
  el('checkout-submit-btn').innerHTML = `${icon('check')} Checkout ${plural(cart.length, 'item', 'items')}`;
}

el('cart-lines').addEventListener('change', (e) => {
  const row = e.target.closest('.cart-line');
  if (!row || e.target.type !== 'number') return;
  const line = cart.find((l) => l.itemId === row.dataset.itemId);
  const item = items.find((i) => i.id === row.dataset.itemId);
  if (!line || !item) return;

  const available = availableQty(item);
  let next = Math.round(Number(e.target.value));
  if (!next || next < 1) next = 1;
  if (available > 0 && next > available) next = available;
  line.quantity = next;
  e.target.value = String(next);
  const warning = cartLineWarning(line, available);
  const warningEl = row.querySelector('.line-warning');
  warningEl.textContent = warning;
  warningEl.hidden = !warning;
  cartChanged();
});

el('cart-lines').addEventListener('click', (e) => {
  const removeBtn = e.target.closest('[data-remove]');
  if (!removeBtn) return;
  const row = removeBtn.closest('.cart-line');
  cart = cart.filter((l) => l.itemId !== row.dataset.itemId);
  cartChanged();
  renderCart();
  focusInside(el('cart-modal'));
});

function openCart() {
  const user = session ? {} : rememberedUser();
  if (!el('checkout-name').value) el('checkout-name').value = user.name || '';
  if (!el('checkout-employee-no').value) el('checkout-employee-no').value = user.employeeNo || '';
  el('checkout-return-date').min = todayStr();
  setFormError('checkout-form-error', '');
  renderCart();
  openModal('cart-modal');
}

el('cart-btn').addEventListener('click', openCart);

el('cart-clear-btn').addEventListener('click', async () => {
  const confirmed = await confirmDialog({
    title: 'Clear the cart?',
    message: `This removes ${plural(cart.length, 'item', 'items')} from your cart. Nothing has been moved out yet.`,
    confirmLabel: 'Clear cart',
  });
  if (!confirmed) return;
  cart = [];
  cartChanged();
  renderCart();
});

function showCheckoutSuccess(summary, body, loanCount) {
  el('success-subtitle').textContent = `Recorded under ${body.name.trim()} (${body.employeeNo.trim()}) for “${body.purpose.trim()}”.`;
  el('success-lines').innerHTML = summary
    .map(
      (line) =>
        `<li><span>${escapeHtml(line.name)}${line.returnable ? ` <span class="on-loan-tag">On loan</span>` : ''}</span>` +
        `<strong>${line.quantity} ${escapeHtml(line.unit)}</strong></li>`
    )
    .join('');

  const note = el('success-loan-note');
  note.hidden = loanCount === 0;
  note.innerHTML =
    loanCount > 0
      ? `${icon('return')}<span>Please bring the loaned ${loanCount > 1 ? 'items' : 'item'} back by <strong>${escapeHtml(fmtDate(body.expectedReturnDate))}</strong>, then record it under Loan Records → Return.</span>`
      : '';
  el('success-loans-btn').hidden = loanCount === 0;
  openModal('success-modal');
}

el('success-loans-btn').addEventListener('click', () => openLoansPanel());

el('checkout-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (cart.length === 0) return;

  withBusy(el('checkout-submit-btn'), async () => {
    setFormError('checkout-form-error', '');
    const hasLoanable = cartLoanableItems().length > 0;
    const body = {
      ...personFrom('checkout-name', 'checkout-employee-no'),
      purpose: el('checkout-purpose').value,
      expectedReturnDate: hasLoanable ? el('checkout-return-date').value || null : null,
      lines: cart.map((line) => ({ itemId: line.itemId, quantity: line.quantity })),
    };

    const res = await request(API.checkout, { method: 'POST', body });
    if (!res.ok) {
      if (res.status === 0) {
        setFormError('checkout-form-error', 'Could not reach the store server — nothing was recorded. Please try again.');
        return;
      }
      setFormError('checkout-form-error', res.error);
      // Stock may have changed since the cart was filled — refresh so the lines show it.
      await loadItems({ silent: true });
      renderCart();
      return;
    }

    rememberPerson(body);
    const summary = cart.map((line) => {
      const item = items.find((i) => i.id === line.itemId) || {};
      return { name: item.name || 'Item', quantity: line.quantity, unit: item.unit || 'pcs', returnable: Boolean(item.returnable) };
    });
    cart = [];
    saveCart();
    el('checkout-purpose').value = '';
    el('checkout-return-date').value = '';
    // Show the name the server actually recorded (the signed-in person's).
    const recorded = (res.data.transactions || [])[0] || (res.data.loans || [])[0] || {};
    showCheckoutSuccess(
      summary,
      { ...body, name: recorded.name || body.name, employeeNo: recorded.employeeNo || body.employeeNo },
      (res.data.loans || []).length
    );
    renderGrid();
    await loadItems({ silent: true });
    loadReportsBadge();
  });
});

// ---------- Returns (one or several loans in a single submit) ----------

let returnOrigin = 'detail';

function loanOutstanding(loan) {
  return loan.quantity - loan.quantityReturned;
}

function isOverdue(loan) {
  return loan.status === 'open' && Boolean(loan.expectedReturnDate) && loan.expectedReturnDate < todayStr();
}

function openReturnModal(loans, { origin, checkAll }) {
  returnOrigin = origin;
  const container = el('return-lines');
  container.innerHTML = '';

  loans.forEach((loan, index) => {
    const outstanding = loanOutstanding(loan);
    const checked = checkAll || loans.length === 1;
    const checkId = `return-check-${index}`;
    const due = loan.expectedReturnDate ? ` · due ${fmtDate(loan.expectedReturnDate)}` : '';

    const row = document.createElement('div');
    row.className = `return-line${checked ? '' : ' is-off'}`;
    row.innerHTML =
      `<input type="checkbox" id="${checkId}"${checked ? ' checked' : ''} />` +
      `<label class="line-info" for="${checkId}">` +
      `<strong>${escapeHtml(loan.itemName)} — ${outstanding} not returned</strong>` +
      `<span class="line-meta">${escapeHtml(`Borrowed by ${loan.name} (${loan.employeeNo}) · ${loan.purpose}${due}`)}</span>` +
      `</label>` +
      `<span class="stepper">` +
      `<button type="button" class="step-btn" data-step="-1" aria-label="Decrease quantity">${icon('minus')}</button>` +
      `<input type="number" inputmode="numeric" min="1" max="${outstanding}" step="1" value="${outstanding}" aria-label="Quantity of ${escapeHtml(loan.itemName)} being returned" />` +
      `<button type="button" class="step-btn" data-step="1" aria-label="Increase quantity">${icon('plus')}</button>` +
      `</span>`;
    row.querySelector('input[type="checkbox"]').dataset.loanId = loan.id;
    container.appendChild(row);
  });

  prefillPerson('return-name', 'return-employee-no');
  el('return-notes').value = '';
  setFormError('return-form-error', '');
  openModal('return-modal');
}

el('return-lines').addEventListener('change', (e) => {
  if (e.target.type !== 'checkbox') return;
  e.target.closest('.return-line').classList.toggle('is-off', !e.target.checked);
});

el('detail-return-btn').addEventListener('click', () => {
  const item = items.find((i) => i.id === selectedItemId);
  if (!item || !item.returnable) return;

  withBusy(el('detail-return-btn'), async () => {
    const res = await request(`${API.loans}?itemId=${encodeURIComponent(item.id)}&status=open`);
    if (!res.ok) {
      showToast(`Could not load the loans for this item. ${res.error}`, 'error');
      return;
    }
    const openLoans = res.data.loans || [];
    if (openLoans.length === 0) {
      showToast(`Nothing to return — no "${item.name}" is out on loan right now.`);
      return;
    }
    openReturnModal(openLoans, { origin: 'detail', checkAll: false });
  });
});

el('return-form').addEventListener('submit', (e) => {
  e.preventDefault();

  const returns = [];
  el('return-lines')
    .querySelectorAll('.return-line')
    .forEach((row) => {
      const check = row.querySelector('input[type="checkbox"]');
      if (!check.checked) return;
      returns.push({
        loanId: check.dataset.loanId,
        quantity: Math.round(Number(row.querySelector('input[type="number"]').value)),
      });
    });

  if (returns.length === 0) {
    setFormError('return-form-error', 'Tick at least one item that is being returned.');
    return;
  }
  if (returns.some((r) => !r.quantity || r.quantity <= 0)) {
    setFormError('return-form-error', 'Every ticked item needs a return quantity of at least 1.');
    return;
  }

  withBusy(el('return-submit-btn'), async () => {
    setFormError('return-form-error', '');
    const body = {
      returns,
      ...personFrom('return-name', 'return-employee-no'),
      notes: el('return-notes').value,
    };
    const res = await request(API.loans, { method: 'PATCH', body });
    if (!res.ok) {
      setFormError(
        'return-form-error',
        res.status === 0 ? 'Could not reach the store server — nothing was recorded. Please try again.' : res.error
      );
      return;
    }

    rememberPerson(body);
    closeModal('return-modal');
    showToast(`Return recorded for ${plural(returns.length, 'item', 'items')}.`, 'success');
    await loadItems({ silent: true });
    loadReportsBadge();
    if (returnOrigin === 'loans') await openLoansPanel();
    else await openDetail(selectedItemId);
  });
});

// ---------- Loan records: what is still out, and who has borrowed what ----------

let allLoans = [];
let loansLoaded = false;
let loansTab = 'open';
let loansSearch = '';
const selectedLoanIds = new Set();

async function openLoansPanel() {
  selectedLoanIds.clear();
  renderLoansPanel();
  openModal('loans-modal');

  const res = await request(API.loans);
  if (!res.ok) {
    if (loansLoaded) showToast(`Could not refresh the loan records. ${res.error}`, 'error');
    else {
      el('loans-empty').textContent = `Could not load the loan records. ${res.error}`;
      el('loans-empty').hidden = false;
    }
    return;
  }
  allLoans = res.data.loans || [];
  loansLoaded = true;
  setBadge('loans-badge', allLoans.filter((l) => l.status === 'open').length);
  renderLoansPanel();
}

function filteredLoans() {
  const term = loansSearch.trim().toLowerCase();
  return allLoans.filter((loan) => {
    if (loansTab === 'open' && loan.status !== 'open') return false;
    if (!term) return true;
    return [loan.itemName, loan.name, loan.employeeNo, loan.purpose].some((value) =>
      String(value || '').toLowerCase().includes(term)
    );
  });
}

function loanStatusHtml(loan) {
  if (loan.status === 'returned') {
    const returns = loan.returns || [];
    const last = returns[returns.length - 1];
    const detail = last ? ` ${escapeHtml(fmtDay(last.returnedAt))} by ${escapeHtml(last.name)}` : '';
    return `<span class="qty-pill ok">Returned</span>${detail}`;
  }
  const overdue = isOverdue(loan) ? ' <span class="qty-pill low">Overdue</span>' : '';
  return `<span class="on-loan-tag">${loanOutstanding(loan)} not returned</span>${overdue}`;
}

function updateReturnSelectedButton() {
  const count = selectedLoanIds.size;
  el('loans-return-selected-btn').innerHTML = `${icon('return')} Return Selected${count > 0 ? ` (${count})` : ''}`;
}

function syncSelectAll(list) {
  const all = el('loans-select-all');
  if (!all) return;
  all.disabled = list.length === 0;
  all.checked = list.length > 0 && list.every((loan) => selectedLoanIds.has(loan.id));
}

function renderLoansPanel() {
  const openTab = loansTab === 'open';
  el('loans-tab-open').classList.toggle('active', openTab);
  el('loans-tab-open').setAttribute('aria-pressed', String(openTab));
  el('loans-tab-all').classList.toggle('active', !openTab);
  el('loans-tab-all').setAttribute('aria-pressed', String(!openTab));
  el('loans-return-selected-btn').hidden = !openTab;

  el('loans-head').innerHTML = openTab
    ? '<tr><th><input type="checkbox" id="loans-select-all" aria-label="Select every loan shown" /></th><th>Item</th><th>Not returned</th><th>Borrowed by</th><th>Purpose / event</th><th>Moved out</th><th>Due back</th><th><span class="sr-only">Return</span></th></tr>'
    : `<tr><th>Item</th><th>Qty</th><th>Borrowed by</th><th>Purpose / event</th><th>Moved out</th><th>Due back</th><th>Status</th>${isAdminUnlocked() ? '<th><span class="sr-only">Admin</span></th>' : ''}</tr>`;

  const list = filteredLoans();
  const body = el('loans-body');
  body.innerHTML = '';

  const empty = el('loans-empty');
  empty.hidden = list.length > 0;
  if (!loansLoaded) empty.textContent = 'Loading loan records…';
  else if (loansSearch.trim()) empty.textContent = 'No loan records match your search.';
  else empty.textContent = openTab ? 'Everything has been returned — nothing is out on loan.' : 'No loan records yet.';

  list.forEach((loan) => {
    const row = document.createElement('tr');
    const overdueNow = isOverdue(loan);
    if (overdueNow && openTab) row.className = 'is-overdue';
    const borrower = `${escapeHtml(loan.name)} (${escapeHtml(loan.employeeNo)})`;
    const movedOut = `<td class="nowrap">${escapeHtml(fmtDay(loan.loanedAt))}</td>`;
    const due = loan.expectedReturnDate ? escapeHtml(fmtDate(loan.expectedReturnDate)) : '—';

    if (openTab) {
      const checkCell = document.createElement('td');
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = selectedLoanIds.has(loan.id);
      check.setAttribute('aria-label', `Select ${loan.itemName} borrowed by ${loan.name}`);
      check.addEventListener('change', () => {
        if (check.checked) selectedLoanIds.add(loan.id);
        else selectedLoanIds.delete(loan.id);
        updateReturnSelectedButton();
        syncSelectAll(list);
      });
      checkCell.appendChild(check);
      row.appendChild(checkCell);

      const partial = loan.quantityReturned > 0 ? ` of ${loan.quantity}` : '';
      const overdue = overdueNow ? ' <span class="qty-pill low">Overdue</span>' : '';
      row.insertAdjacentHTML(
        'beforeend',
        `<td><strong>${escapeHtml(loan.itemName)}</strong></td><td>${loanOutstanding(loan)}${partial}</td><td>${borrower}</td><td>${escapeHtml(loan.purpose)}</td>${movedOut}<td class="nowrap">${due}${overdue}</td>`
      );

      const actionCell = document.createElement('td');
      actionCell.className = 'row-actions';
      const returnBtn = document.createElement('button');
      returnBtn.type = 'button';
      returnBtn.className = 'ghost-btn sky-btn';
      returnBtn.innerHTML = `${icon('return')} Return`;
      returnBtn.addEventListener('click', () => openReturnModal([loan], { origin: 'loans', checkAll: true }));
      actionCell.appendChild(returnBtn);
      if (isAdminUnlocked()) actionCell.insertAdjacentHTML('beforeend', loanAdminButtons(loan));
      row.appendChild(actionCell);
    } else {
      row.innerHTML = `<td><strong>${escapeHtml(loan.itemName)}</strong></td><td>${loan.quantity}</td><td>${borrower}</td><td>${escapeHtml(loan.purpose)}</td>${movedOut}<td class="nowrap">${due}</td><td>${loanStatusHtml(loan)}</td>${isAdminUnlocked() ? `<td class="row-actions">${loanAdminButtons(loan)}</td>` : ''}`;
    }

    body.appendChild(row);
  });

  const selectAll = el('loans-select-all');
  if (selectAll) {
    syncSelectAll(list);
    selectAll.addEventListener('change', () => {
      list.forEach((loan) => {
        if (selectAll.checked) selectedLoanIds.add(loan.id);
        else selectedLoanIds.delete(loan.id);
      });
      renderLoansPanel();
      const again = el('loans-select-all');
      if (again) again.focus({ preventScroll: true });
    });
  }

  updateReturnSelectedButton();
}

el('loans-btn').addEventListener('click', openLoansPanel);

el('loans-body').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-loan-edit], [data-loan-delete]');
  if (!btn) return;
  const loan = allLoans.find((l) => l.id === (btn.dataset.loanEdit || btn.dataset.loanDelete));
  if (!loan) return;
  if (btn.dataset.loanEdit) requireAdminThen(() => openEditLoanModal(loan, 'loans'));
  else requireAdminThen(() => deleteLoan(loan, 'loans'));
});

// ---------- Admin: correct or delete a loan record ----------

let editingLoan = null;
let loanEditOrigin = null;

function loanAdminButtons(loan) {
  return (
    `<button type="button" class="icon-btn" data-loan-edit="${escapeHtml(loan.id)}" aria-label="Edit this loan record" title="Edit this loan record">${icon('pencil')}</button>` +
    `<button type="button" class="icon-btn danger-text" data-loan-delete="${escapeHtml(loan.id)}" aria-label="Delete this loan record" title="Delete this loan record">${icon('trash')}</button>`
  );
}

function openEditLoanModal(loan, origin) {
  editingLoan = loan;
  loanEditOrigin = origin;
  el('edit-loan-item').textContent = loan.itemName;
  el('edit-loan-quantity').value = loan.quantity;
  el('edit-loan-returned').value = loan.quantityReturned;
  el('edit-loan-name').value = loan.name || '';
  el('edit-loan-employee-no').value = loan.employeeNo || '';
  el('edit-loan-email').value = loan.email || '';
  el('edit-loan-purpose').value = loan.purpose || '';
  el('edit-loan-due').value = loan.expectedReturnDate || '';
  setFormError('edit-loan-form-error', '');
  openModal('edit-loan-modal');
}

async function afterLoanChange(origin) {
  await loadItems({ silent: true });
  loadReportsBadge();
  if (origin === 'loans') await openLoansPanel();
  else if (origin === 'detail' && selectedItemId) await openDetail(selectedItemId);
}

el('edit-loan-form').addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy(submitButton(e.currentTarget), async () => {
    setFormError('edit-loan-form-error', '');
    const res = await request(`${API.loans}?id=${encodeURIComponent(editingLoan.id)}`, {
      method: 'PUT',
      admin: true,
      body: {
        quantity: Number(el('edit-loan-quantity').value),
        quantityReturned: Number(el('edit-loan-returned').value),
        name: el('edit-loan-name').value,
        employeeNo: el('edit-loan-employee-no').value,
        email: el('edit-loan-email').value,
        purpose: el('edit-loan-purpose').value,
        expectedReturnDate: el('edit-loan-due').value,
      },
    });
    if (!res.ok) {
      setFormError('edit-loan-form-error', res.error);
      return;
    }
    closeModal('edit-loan-modal');
    showToast('Loan record updated.', 'success');
    await afterLoanChange(loanEditOrigin);
  });
});

async function deleteLoan(loan, origin) {
  const out = loanOutstanding(loan);
  const confirmed = await confirmDialog({
    title: 'Delete this loan record?',
    message:
      `${loan.itemName} × ${loan.quantity}, borrowed by ${loan.name} for ${loan.purpose}. ` +
      (out > 0
        ? `The ${out} still marked as out will stop counting as on loan. If they are lost rather than back, also lower the item's total with Edit. `
        : '') +
      'Use this for a mistake, a test or an old record. This cannot be undone.',
    confirmLabel: 'Delete record',
  });
  if (!confirmed) return;
  const res = await request(`${API.loans}?id=${encodeURIComponent(loan.id)}`, { method: 'DELETE', admin: true });
  if (!res.ok) {
    showToast(res.error, 'error');
    return;
  }
  showToast('Loan record deleted.', 'success');
  await afterLoanChange(origin);
}

el('loans-tab-open').addEventListener('click', () => {
  loansTab = 'open';
  renderLoansPanel();
});

el('loans-tab-all').addEventListener('click', () => {
  loansTab = 'all';
  renderLoansPanel();
});

el('loans-search').addEventListener('input', (e) => {
  loansSearch = e.target.value;
  renderLoansPanel();
});

el('loans-return-selected-btn').addEventListener('click', () => {
  const selected = allLoans.filter((loan) => loan.status === 'open' && selectedLoanIds.has(loan.id));
  if (selected.length === 0) {
    showToast('Tick the items being returned first.', 'error');
    return;
  }
  openReturnModal(selected, { origin: 'loans', checkAll: true });
});

el('loans-export-btn').addEventListener('click', () => {
  if (!loansLoaded) return;
  const rows = [
    ['Item', 'Quantity', 'Returned', 'Not Returned', 'Borrowed By', 'Employee No', 'Purpose', 'Moved Out', 'Due Back', 'Status', 'Last Returned On', 'Last Returned By', 'Email'],
    ...allLoans.map((loan) => {
      const returns = loan.returns || [];
      const last = returns[returns.length - 1];
      return [
        loan.itemName,
        loan.quantity,
        loan.quantityReturned,
        loanOutstanding(loan),
        loan.name,
        loan.employeeNo,
        loan.purpose,
        csvDateTime(loan.loanedAt),
        loan.expectedReturnDate || '',
        loan.status === 'returned' ? 'Returned' : isOverdue(loan) ? 'Overdue' : 'Not returned',
        last ? csvDateTime(last.returnedAt) : '',
        last ? `${last.name} (${last.employeeNo})` : '',
        loan.email || '',
      ];
    }),
  ];
  downloadCsv(`vitrox-store-loan-records-${todayStr()}.csv`, rows);
});

// ---------- Report an issue ----------

el('detail-report-btn').addEventListener('click', () => {
  const item = items.find((i) => i.id === selectedItemId);
  if (!item) return;
  el('report-modal-item').textContent = item.name;
  el('report-type').value = 'damage';
  prefillPerson('report-name', 'report-employee-no');
  el('report-quantity').value = '';
  el('report-message').value = '';
  setFormError('report-form-error', '');
  openModal('report-modal');
});

el('report-form').addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy(submitButton(e.currentTarget), async () => {
    setFormError('report-form-error', '');
    const body = {
      itemId: selectedItemId,
      type: el('report-type').value,
      ...personFrom('report-name', 'report-employee-no'),
      quantity: el('report-quantity').value || null,
      message: el('report-message').value,
    };
    const res = await request(API.reports, { method: 'POST', body });
    if (!res.ok) {
      setFormError('report-form-error', res.error);
      return;
    }
    rememberPerson(body);
    closeModal('report-modal');
    showToast('Report sent to the admin. Thank you!', 'success');
    loadReportsBadge();
  });
});

// ---------- Alerts & reports panel ----------

el('reports-btn').addEventListener('click', openReportsPanel);

function renderLowStockPanel() {
  const low = lowStockItems();
  el('low-stock-list-panel').innerHTML = low.length
    ? `<h3>Low stock</h3>${low
        .map(
          (i) =>
            `<button type="button" class="low-stock-row" data-item-id="${escapeHtml(i.id)}">` +
            `<span><strong>${escapeHtml(i.name)}</strong><small>${escapeHtml(i.category)}</small></span>` +
            `<span class="qty-pill low">${availableQty(i)} ${escapeHtml(i.unit || 'pcs')} left</span></button>`
        )
        .join('')}`
    : '<h3>Low stock</h3><p class="muted-text">Nothing is running low right now.</p>';
}

el('low-stock-list-panel').addEventListener('click', (e) => {
  const row = e.target.closest('[data-item-id]');
  if (row) openDetail(row.dataset.itemId);
});

// ---- Recent move-outs: one row per checkout, e.g. "x@vitrox.com moved out
// Goodies Bag × 1000, Programme Flyers × 100 — for Open Day" ----

const MOVEOUT_DAYS = 14;
const MOVEOUT_MAX = 20;

function groupMoveOuts(transactions, loans) {
  const groups = new Map();
  const add = (key, at, who, purpose, line) => {
    if (!groups.has(key)) groups.set(key, { key, at, who, purpose, lines: [] });
    groups.get(key).lines.push(line);
  };
  transactions
    .filter((t) => t.type === 'remove')
    .forEach((t) => add(t.checkoutId || t.id, t.timestamp, t, t.remarks, { name: t.itemName, qty: t.quantity }));
  loans.forEach((l) =>
    add(l.checkoutId || l.id, l.loanedAt, l, l.purpose, { name: l.itemName, qty: l.quantity, due: l.expectedReturnDate, loan: true })
  );
  const since = Date.now() - MOVEOUT_DAYS * 86400000;
  return [...groups.values()]
    .filter((g) => new Date(g.at).getTime() >= since)
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, MOVEOUT_MAX);
}

let moveOutGroups = [];

function renderMoveOuts(transactions, loans) {
  const box = el('recent-moveouts');
  if (!transactions || !loans) {
    box.innerHTML = '<p class="muted-text">Could not load recent move-outs.</p>';
    return;
  }
  const groups = groupMoveOuts(transactions, loans);
  moveOutGroups = groups;
  if (groups.length === 0) {
    box.innerHTML = `<p class="muted-text">Nothing moved out in the last ${MOVEOUT_DAYS} days.</p>`;
    return;
  }
  const admin = isAdminUnlocked();
  box.innerHTML = groups
    .map((g) => {
      const w = g.who;
      const headline = w.email || w.name || 'Someone';
      const person = w.email ? `${w.name} (${w.employeeNo})` : `(${w.employeeNo})`;
      const lines = g.lines
        .map((l) => `${escapeHtml(l.name)} × ${escapeHtml(l.qty)}${l.loan ? ' <span class="moveout-loan">loan</span>' : ''}`)
        .join(', ');
      const dues = [...new Set(g.lines.filter((l) => l.due).map((l) => l.due))].sort();
      const returnBy = dues.length ? ` · return by ${dues.map((d) => escapeHtml(fmtDate(d))).join(', ')}` : '';
      return (
        `<div class="report-row moveout-row"><div class="report-row-info">` +
        `<strong>${escapeHtml(headline)} <span class="moveout-verb">moved out</span> ${lines}</strong>` +
        `<span>For ${escapeHtml(g.purpose || '—')}${returnBy} · ${escapeHtml(person)} · ${escapeHtml(fmtDateTime(g.at))}</span></div>` +
        (admin
          ? `<button type="button" class="icon-btn danger-text" data-moveout-delete="${escapeHtml(g.key)}" aria-label="Delete this move-out" title="Delete this move-out">${icon('trash')}</button>`
          : '') +
        `</div>`
      );
    })
    .join('');
}

el('recent-moveouts').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-moveout-delete]');
  if (!btn) return;
  const group = moveOutGroups.find((g) => g.key === btn.dataset.moveoutDelete);
  if (group) requireAdminThen(() => deleteMoveOut(group));
});

async function deleteMoveOut(group) {
  const what = group.lines.map((l) => `${l.name} × ${l.qty}`).join(', ');
  const consumables = group.lines.filter((l) => !l.loan);
  const loaned = group.lines.filter((l) => l.loan);
  const effects = [
    consumables.length ? `${consumables.map((l) => `${l.name} × ${l.qty}`).join(', ')} will be put back into stock.` : '',
    loaned.length ? `${loaned.map((l) => l.name).join(', ')} will no longer count as out on loan.` : '',
  ].filter(Boolean);
  const confirmed = await confirmDialog({
    title: 'Delete this move-out?',
    message:
      `${what} — for ${group.purpose || 'no purpose given'}. ${effects.join(' ')} ` +
      'Use this only for a mistake or a test. To tidy up old history without changing stock, use Clear Old History instead.',
    confirmLabel: 'Delete move-out',
  });
  if (!confirmed) return;
  const res = await request(`${API.checkout}?id=${encodeURIComponent(group.key)}`, { method: 'DELETE', admin: true });
  if (!res.ok) {
    showToast(res.error, 'error');
    return;
  }
  showToast('Move-out deleted.', 'success');
  await loadItems({ silent: true });
  loadReportsBadge();
  await openReportsPanel();
}

// ---- Overdue reminder emails (admin view) ----

function renderReminderStatus(res) {
  const box = el('reminder-status');
  if (!isAdminUnlocked()) {
    box.innerHTML = '';
    return;
  }
  if (!res || !res.ok) {
    box.innerHTML = `<div class="reminder-box"><p>Could not check the reminder emails. ${escapeHtml((res && res.error) || '')}</p></div>`;
    return;
  }
  const { emailReady, everyDays, lastRun } = res.data;
  let status;
  if (!emailReady) {
    status =
      `<strong>${icon('bell')} Reminder emails are off.</strong> ` +
      `The email (SMTP) settings have not been added to Netlify yet, so no emails are sent — not for overdue loans, and not for low stock. ` +
      `Overdue loans are still listed above.`;
  } else {
    const last = lastRun
      ? `Last run ${escapeHtml(fmtDateTime(lastRun.at))}: ` +
        (lastRun.due === 0
          ? 'nobody was due a reminder.'
          : `${plural(lastRun.peopleEmailed, 'person', 'people')} emailed` +
            (lastRun.failed ? `, ${plural(lastRun.failed, 'email', 'emails')} failed` : '') +
            (lastRun.noEmail ? `, ${plural(lastRun.noEmail, 'loan', 'loans')} with no email on record` : '') +
            (lastRun.adminNotified ? ' — summary sent to the admin.' : '.'))
      : 'It has not run yet.';
    status =
      `<strong>${icon('bell')} Reminder emails are on.</strong> ` +
      `Every day at 9:00 am, people with overdue items are emailed (again every ${escapeHtml(everyDays)} days until returned), ` +
      `and the admin gets a summary. ${last}`;
  }
  box.innerHTML =
    `<div class="reminder-box"><p>${status}</p>` +
    (emailReady ? `<button type="button" id="send-reminders-btn" class="ghost-btn">${icon('bell')} Send reminders now</button>` : '') +
    `</div>`;
}

el('reminder-status').addEventListener('click', (e) => {
  const btn = e.target.closest('#send-reminders-btn');
  if (!btn) return;
  withBusy(btn, async () => {
    const res = await request(`${API.loans}?action=remind`, { method: 'POST', admin: true, body: {} });
    if (!res.ok) {
      showToast(res.error, 'error');
      return;
    }
    const r = res.data.lastRun;
    showToast(
      !r.emailReady
        ? 'Email is not set up yet, so no reminders were sent.'
        : r.due === 0
        ? 'Nobody is due a reminder right now (each person is reminded at most every few days).'
        : `Reminders sent to ${plural(r.peopleEmailed, 'person', 'people')}.`,
      r.failed ? 'error' : 'success'
    );
    renderReminderStatus(res);
  });
});

async function openReportsPanel() {
  renderLowStockPanel();
  el('overdue-loans-panel').innerHTML = '';
  el('reminder-status').innerHTML = '';
  el('reports-list').innerHTML = '<p class="muted-text">Loading…</p>';
  el('recent-moveouts').innerHTML = '<p class="muted-text">Loading…</p>';
  openModal('reports-panel-modal');

  const admin = isAdminUnlocked();
  const [allLoans, reports, txns, reminders] = await Promise.all([
    request(API.loans),
    request(showResolvedReports && admin ? API.reports : `${API.reports}?status=open`),
    request(API.txns),
    admin ? request(`${API.loans}?view=reminders`, { admin: true }) : null,
  ]);
  renderMoveOuts(txns.ok ? txns.data.transactions || [] : null, allLoans.ok ? allLoans.data.loans || [] : null);
  renderReminderStatus(reminders);

  const overdue = allLoans.ok ? (allLoans.data.loans || []).filter(isOverdue) : [];
  const today = parseYmd(todayStr());
  el('overdue-loans-panel').innerHTML = overdue.length
    ? `<h3>Overdue loans</h3>${overdue
        .map((l) => {
          const days = Math.round((today - parseYmd(l.expectedReturnDate)) / 86400000);
          return (
            `<div class="low-stock-row"><span><strong>${escapeHtml(l.itemName)} × ${loanOutstanding(l)}</strong>` +
            `<small>With ${escapeHtml(l.name)} (${escapeHtml(l.employeeNo)}) for ${escapeHtml(l.purpose)} · due ${escapeHtml(fmtDate(l.expectedReturnDate))}</small></span>` +
            `<span class="qty-pill low">${plural(days, 'day', 'days')} overdue</span></div>`
          );
        })
        .join('')}`
    : '';

  const list = el('reports-list');
  const showingResolved = showResolvedReports && admin;
  el('reports-heading').textContent = showingResolved ? 'All reports' : 'Open reports';
  el('reports-resolved-toggle').textContent = showingResolved ? 'Show open only' : 'Show resolved';
  if (!reports.ok) {
    list.innerHTML = `<p class="muted-text">Could not load the reports. ${escapeHtml(reports.error)}</p>`;
    return;
  }
  const shown = reports.data.reports || [];
  if (shown.length === 0) {
    list.innerHTML = `<p class="muted-text">${showingResolved ? 'No reports yet.' : 'No open reports.'}</p>`;
    return;
  }
  list.innerHTML = shown
    .map((r) => {
      const kind = r.type === 'damage' ? `${icon('flag')} Damaged` : `${icon('package')} Restock request`;
      const qty = r.quantity ? ` · quantity affected: ${escapeHtml(r.quantity)}` : '';
      const resolved = r.status === 'resolved';
      const state = resolved ? ` <span class="qty-pill ok">Resolved${r.resolvedAt ? ' ' + escapeHtml(fmtDay(r.resolvedAt)) : ''}</span>` : '';
      const actions = admin
        ? `<div class="row-actions">` +
          (resolved
            ? `<button type="button" class="ghost-btn" data-reopen="${escapeHtml(r.id)}">${icon('refresh')} Reopen</button>`
            : `<button type="button" class="ghost-btn" data-resolve="${escapeHtml(r.id)}">${icon('check')} Resolve</button>`) +
          `<button type="button" class="icon-btn danger-text" data-report-delete="${escapeHtml(r.id)}" aria-label="Delete this report" title="Delete this report">${icon('trash')}</button>` +
          `</div>`
        : '';
      return (
        `<div class="report-row${resolved ? ' is-resolved' : ''}"><div class="report-row-info">` +
        `<strong>${kind} — ${escapeHtml(r.itemName)}${state}</strong>` +
        `<span>${escapeHtml(r.message)}${qty}</span>` +
        `<span>By ${escapeHtml(r.name)} (${escapeHtml(r.employeeNo)}) · ${escapeHtml(fmtDateTime(r.createdAt))}</span></div>` +
        actions +
        `</div>`
      );
    })
    .join('');
  if (!admin) list.insertAdjacentHTML('beforeend', '<p class="muted-text">Unlock Admin to mark reports as resolved.</p>');
}

let showResolvedReports = false;

el('reports-resolved-toggle').addEventListener('click', () => {
  showResolvedReports = !showResolvedReports;
  openReportsPanel();
});

el('reports-list').addEventListener('click', (e) => {
  const resolveBtn = e.target.closest('[data-resolve]');
  const reopenBtn = e.target.closest('[data-reopen]');
  const deleteBtn = e.target.closest('[data-report-delete]');
  if (resolveBtn) withBusy(resolveBtn, () => setReportStatus(resolveBtn.dataset.resolve, 'resolved'));
  else if (reopenBtn) withBusy(reopenBtn, () => setReportStatus(reopenBtn.dataset.reopen, 'open'));
  else if (deleteBtn) requireAdminThen(() => deleteReport(deleteBtn.dataset.reportDelete));
});

function setReportStatus(id, status) {
  return new Promise((done) => {
    if (!isAdminUnlocked()) done();
    requireAdminThen(async () => {
      const res = await request(`${API.reports}?id=${encodeURIComponent(id)}`, {
        method: 'PATCH',
        admin: true,
        body: { status },
      });
      if (!res.ok) showToast(res.error, 'error');
      else showToast(status === 'resolved' ? 'Report resolved.' : 'Report reopened.', 'success');
      done();
      if (res.ok) {
        loadReportsBadge();
        openReportsPanel();
      }
    });
  });
}

async function deleteReport(id) {
  const confirmed = await confirmDialog({
    title: 'Delete this report?',
    message: 'The report is removed for good. Stock is not changed. This cannot be undone.',
    confirmLabel: 'Delete report',
  });
  if (!confirmed) return;
  const res = await request(`${API.reports}?id=${encodeURIComponent(id)}`, { method: 'DELETE', admin: true });
  if (!res.ok) {
    showToast(res.error, 'error');
    return;
  }
  showToast('Report deleted.', 'success');
  loadReportsBadge();
  await openReportsPanel();
}

// ---------- Add / edit / remove items (admin only) ----------

el('detail-edit-btn').addEventListener('click', () => {
  requireAdminThen(() => openItemForm(selectedItemId));
});

el('add-item-btn').addEventListener('click', () => {
  requireAdminThen(() => openItemForm(null));
});

async function deleteItem(item, { afterDelete }) {
  const confirmed = await confirmDialog({
    title: `Delete “${item.name}”?`,
    message: 'The item, its photos and its details are removed from the catalog. This cannot be undone.',
    confirmLabel: 'Delete item',
  });
  if (!confirmed) return;

  const res = await request(`${API.items}?id=${encodeURIComponent(item.id)}`, { method: 'DELETE', admin: true });
  if (!res.ok) {
    showToast(res.error, 'error');
    return;
  }
  afterDelete();
  showToast(`“${item.name}” deleted.`, 'success');
  loadItems({ silent: true });
}

el('detail-delete-btn').addEventListener('click', () => {
  requireAdminThen(() => {
    const item = items.find((i) => i.id === selectedItemId);
    if (item) deleteItem(item, { afterDelete: () => closeModal('detail-modal') });
  });
});

// What the form will save for each photo: the item's current photo URL
// (unchanged), a newly picked photo (data: URL), or null (removed).
const formImages = { item: null, location: null };

function setFormImage(kind, value) {
  formImages[kind] = value || null;
  const preview = el(`form-${kind}-image-preview`);
  if (value) preview.src = value;
  else preview.removeAttribute('src');
  el(`form-${kind}-image-row`).hidden = !value;
}

function openItemForm(itemId) {
  const item = itemId ? items.find((i) => i.id === itemId) : null;
  el('item-form').dataset.id = item ? item.id : '';
  el('item-form-title').textContent = item ? `Edit ${item.name}` : 'Add New Item';

  const options = categories.slice();
  if (item && item.category && !options.includes(item.category)) options.push(item.category);
  const categorySelect = el('form-category');
  categorySelect.innerHTML = options.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');

  el('form-name').value = item ? item.name : '';
  categorySelect.value = item ? item.category : options[0] || '';
  el('form-unit').value = item ? item.unit || 'pcs' : 'pcs';
  el('form-quantity').value = item ? item.quantity : 0;
  el('form-threshold').value = item ? item.lowStockThreshold : 5;
  el('form-location-text').value = item ? item.locationText || '' : '';
  el('form-notes').value = item ? item.notes || '' : '';
  el('form-returnable').checked = item ? Boolean(item.returnable) : false;

  el('form-item-image').value = '';
  el('form-location-image').value = '';
  setFormImage('item', item ? item.itemImage : null);
  setFormImage('location', item ? item.locationImage : null);

  setFormError('item-form-error', '');
  openModal('item-form-modal');
}

['item', 'location'].forEach((kind) => {
  el(`form-${kind}-image`).addEventListener('change', async (e) => {
    const file = e.target.files[0];
    // Closing the file picker without choosing keeps the photo already there.
    if (!file) return;
    try {
      setFormImage(kind, await readImageAsCompressedDataUrl(file));
    } catch (err) {
      e.target.value = '';
      showToast(`${err.message || 'That photo could not be read'}. Please pick a JPEG or PNG photo.`, 'error');
    }
  });

  el(`form-${kind}-image-remove`).addEventListener('click', () => {
    el(`form-${kind}-image`).value = '';
    setFormImage(kind, null);
  });
});

el('item-form').addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy(submitButton(e.currentTarget), async () => {
    setFormError('item-form-error', '');
    const id = el('item-form').dataset.id;
    const body = {
      name: el('form-name').value,
      category: el('form-category').value,
      unit: el('form-unit').value,
      quantity: Number(el('form-quantity').value),
      lowStockThreshold: Number(el('form-threshold').value),
      locationText: el('form-location-text').value,
      notes: el('form-notes').value,
      returnable: el('form-returnable').checked,
      itemImage: formImages.item,
      locationImage: formImages.location,
    };

    const res = await request(id ? `${API.items}?id=${encodeURIComponent(id)}` : API.items, {
      method: id ? 'PUT' : 'POST',
      admin: true,
      body,
    });
    if (!res.ok) {
      setFormError('item-form-error', res.error);
      return;
    }

    closeModal('item-form-modal');
    showToast(id ? 'Item updated.' : `“${body.name.trim()}” added.`, 'success');
    await loadItems({ silent: true });
  });
});

el('remove-item-btn').addEventListener('click', () => {
  requireAdminThen(() => {
    if (items.length === 0) {
      showToast('There are no items to remove.');
      return;
    }
    el('remove-picker-select').innerHTML = items
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
      .map((i) => `<option value="${escapeHtml(i.id)}">${escapeHtml(i.name)} (${escapeHtml(i.category)})</option>`)
      .join('');
    openModal('remove-picker-modal');
  });
});

el('remove-picker-confirm').addEventListener('click', () => {
  const item = items.find((i) => i.id === el('remove-picker-select').value);
  if (!item) return;
  requireAdminThen(() => deleteItem(item, { afterDelete: () => closeModal('remove-picker-modal') }));
});

// ---------- Admin: categories ----------

let categoryRows = [];

function categoryItemCount(name) {
  return items.filter((i) => i.category === name).length;
}

function openCategoriesModal() {
  categoryRows = categories.map((c) => ({ original: c, name: c }));
  items.forEach((i) => {
    if (i.category && !categoryRows.some((r) => r.original === i.category)) categoryRows.push({ original: i.category, name: i.category });
  });
  el('category-new').value = '';
  setFormError('categories-form-error', '');
  renderCategoryRows();
  openModal('categories-modal');
}

function renderCategoryRows() {
  el('categories-list').innerHTML = categoryRows
    .map((r, i) => {
      const count = r.original ? categoryItemCount(r.original) : 0;
      const removeTitle = count ? `Move its ${plural(count, 'item', 'items')} to another category first` : 'Remove this category';
      return (
        `<li class="category-row">` +
        `<input type="text" maxlength="60" value="${escapeHtml(r.name)}" data-cat-index="${i}" aria-label="Category name" required />` +
        `<span class="category-count" title="Items in this category">${plural(count, 'item', 'items')}</span>` +
        `<button type="button" class="icon-btn" data-cat-up="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Move up" title="Move up">↑</button>` +
        `<button type="button" class="icon-btn" data-cat-down="${i}" ${i === categoryRows.length - 1 ? 'disabled' : ''} aria-label="Move down" title="Move down">↓</button>` +
        `<button type="button" class="icon-btn danger-text" data-cat-remove="${i}" ${count ? 'disabled' : ''} aria-label="${escapeHtml(removeTitle)}" title="${escapeHtml(removeTitle)}">${icon('trash')}</button>` +
        `</li>`
      );
    })
    .join('');
}

el('categories-list').addEventListener('input', (e) => {
  const index = e.target.dataset.catIndex;
  if (index !== undefined) categoryRows[Number(index)].name = e.target.value;
});

el('categories-list').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn || btn.disabled) return;
  const swap = (a, b) => {
    [categoryRows[a], categoryRows[b]] = [categoryRows[b], categoryRows[a]];
    renderCategoryRows();
  };
  if (btn.dataset.catUp) swap(Number(btn.dataset.catUp), Number(btn.dataset.catUp) - 1);
  else if (btn.dataset.catDown) swap(Number(btn.dataset.catDown), Number(btn.dataset.catDown) + 1);
  else if (btn.dataset.catRemove) {
    categoryRows.splice(Number(btn.dataset.catRemove), 1);
    renderCategoryRows();
  }
});

function addCategoryRow() {
  const name = el('category-new').value.trim();
  if (!name) {
    setFormError('categories-form-error', 'Type a name for the new category first.');
    return;
  }
  if (categoryRows.some((r) => r.name.trim().toLowerCase() === name.toLowerCase())) {
    setFormError('categories-form-error', `"${name}" is already in the list.`);
    return;
  }
  setFormError('categories-form-error', '');
  categoryRows.push({ original: null, name });
  el('category-new').value = '';
  renderCategoryRows();
}

el('category-add-btn').addEventListener('click', addCategoryRow);
el('category-new').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    addCategoryRow();
  }
});

el('categories-form').addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy(submitButton(e.currentTarget), async () => {
    setFormError('categories-form-error', '');
    const renames = {};
    categoryRows.forEach((r) => {
      if (r.original && r.name.trim() && r.name.trim() !== r.original) renames[r.original] = r.name.trim();
    });
    const res = await request(`${API.items}?action=categories`, {
      method: 'POST',
      admin: true,
      body: { categories: categoryRows.map((r) => r.name), renames },
    });
    if (!res.ok) {
      setFormError('categories-form-error', res.error);
      return;
    }
    if (renames[activeCategory]) activeCategory = renames[activeCategory];
    if (activeCategory !== 'All' && !res.data.categories.includes(activeCategory)) activeCategory = 'All';
    closeModal('categories-modal');
    showToast(res.data.moved ? `Categories saved — ${plural(res.data.moved, 'item', 'items')} moved with the rename.` : 'Categories saved.', 'success');
    await loadItems({ silent: true });
  });
});

el('categories-btn').addEventListener('click', () => requireAdminThen(openCategoriesModal));

// ---------- Admin: clear old history, backup ----------

let cleanupChecked = null;

function cleanupBody() {
  return {
    before: el('cleanup-before').value,
    activity: el('cleanup-activity').checked,
    loans: el('cleanup-loans').checked,
    reports: el('cleanup-reports').checked,
  };
}

function resetCleanupPreview() {
  cleanupChecked = null;
  el('cleanup-preview').hidden = true;
  el('cleanup-submit-btn').textContent = 'Check what will be cleared';
  setFormError('cleanup-form-error', '');
}

function openCleanupModal() {
  const d = new Date();
  d.setMonth(d.getMonth() - 6);
  el('cleanup-before').value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  el('cleanup-before').max = todayStr();
  ['cleanup-activity', 'cleanup-loans', 'cleanup-reports'].forEach((id) => (el(id).checked = true));
  resetCleanupPreview();
  openModal('cleanup-modal');
}

el('cleanup-form').addEventListener('input', resetCleanupPreview);
el('cleanup-form').addEventListener('change', resetCleanupPreview);

el('cleanup-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const body = cleanupBody();
  const key = JSON.stringify(body);
  withBusy(el('cleanup-submit-btn'), async () => {
    setFormError('cleanup-form-error', '');
    if (cleanupChecked !== key) {
      const res = await request(`${API.admin}?action=cleanup`, { method: 'POST', admin: true, body: { ...body, dryRun: true } });
      if (!res.ok) {
        setFormError('cleanup-form-error', res.error);
        return;
      }
      const n = res.data.removed;
      const total = n.activity + n.loans + n.reports;
      const preview = el('cleanup-preview');
      preview.hidden = false;
      if (total === 0) {
        preview.textContent = `Nothing from before ${fmtDate(body.before)} to clear.`;
        return;
      }
      const parts = [];
      if (body.activity) parts.push(plural(n.activity, 'activity record', 'activity records'));
      if (body.loans) parts.push(plural(n.loans, 'returned loan', 'returned loans'));
      if (body.reports) parts.push(plural(n.reports, 'resolved report', 'resolved reports'));
      preview.textContent = `From before ${fmtDate(body.before)}: ${parts.join(', ')}. Stock quantities stay as they are.`;
      cleanupChecked = key;
      el('cleanup-submit-btn').textContent = `Clear ${plural(total, 'record', 'records')}`;
      return;
    }
    const confirmed = await confirmDialog({
      title: 'Clear this history for good?',
      message: `${el('cleanup-preview').textContent} This cannot be undone — download a backup first if you may need it.`,
      confirmLabel: 'Clear history',
    });
    if (!confirmed) return;
    const res = await request(`${API.admin}?action=cleanup`, { method: 'POST', admin: true, body });
    if (!res.ok) {
      setFormError('cleanup-form-error', res.error);
      return;
    }
    const n = res.data.removed;
    closeModal('cleanup-modal');
    showToast(`Cleared ${plural(n.activity + n.loans + n.reports, 'record', 'records')}.`, 'success');
    loadReportsBadge();
  });
});

el('cleanup-btn').addEventListener('click', () => requireAdminThen(openCleanupModal));

async function downloadBackup() {
  const res = await request(`${API.admin}?action=backup`, { admin: true });
  if (!res.ok) {
    showToast(`Could not make the backup. ${res.error}`, 'error');
    return;
  }
  const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `vitrox-store-backup-${todayStr()}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  const d = res.data;
  showToast(
    `Backup downloaded: ${plural(d.items.length, 'item', 'items')}, ${plural(d.transactions.length, 'activity record', 'activity records')}, ` +
      `${plural(d.loans.length, 'loan', 'loans')}, ${plural(d.reports.length, 'report', 'reports')}. Photos stay on the site.`,
    'success'
  );
}

el('backup-btn').addEventListener('click', (e) => {
  const btn = e.currentTarget;
  requireAdminThen(() => withBusy(btn, downloadBackup));
});
el('cleanup-backup-btn').addEventListener('click', (e) => {
  const btn = e.currentTarget;
  withBusy(btn, downloadBackup);
});

// ---------- CSV exports ----------

function toCsvValue(value) {
  let str = String(value ?? '');
  // Text starting with = + - @ would be run as a formula by Excel — neutralise it.
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(str)) str = `'${str}`;
  if (/[",\r\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function downloadCsv(filename, rows) {
  // The leading BOM makes Excel read names with accents / Chinese characters correctly.
  const csv = `﻿${rows.map((row) => row.map(toCsvValue).join(',')).join('\r\n')}`;
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

el('export-items-btn').addEventListener('click', () => {
  if (!itemsLoaded) return;
  const rows = [
    ['Name', 'Category', 'Total Quantity', 'On Loan', 'Available', 'Unit', 'Low Stock Threshold', 'Returnable', 'Location'],
    ...items.map((i) => [
      i.name,
      i.category,
      i.quantity,
      i.quantityOnLoan || 0,
      availableQty(i),
      i.unit,
      i.lowStockThreshold,
      i.returnable ? 'Yes' : 'No',
      i.locationText,
    ]),
  ];
  downloadCsv(`vitrox-store-inventory-${todayStr()}.csv`, rows);
});

el('export-txns-btn').addEventListener('click', () => {
  withBusy(el('export-txns-btn'), async () => {
    const res = await request(API.txns);
    if (!res.ok) {
      showToast(`Could not export the activity log. ${res.error}`, 'error');
      return;
    }
    const rows = [
      ['Date', 'Item', 'Type', 'Quantity', 'Before', 'After', 'Name', 'Employee No', 'Remarks', 'Email'],
      ...(res.data.transactions || []).map((t) => [
        csvDateTime(t.timestamp),
        t.itemName,
        t.type === 'add' ? 'Add On' : 'Move Out',
        t.quantity,
        t.quantityBefore,
        t.quantityAfter,
        t.name,
        t.employeeNo,
        t.remarks,
        t.email || '',
      ]),
    ];
    downloadCsv(`vitrox-store-activity-log-${todayStr()}.csv`, rows);
  });
});

// ---------- Start ----------

updateAdminUI();
updateAccountUI();
updateRequireSignInButton();
setBadge('cart-badge', cart.length);

// Show the last known stock list straight away, then replace it with the live one.
(() => {
  const cached = readStored(ITEMS_CACHE_KEY, null);
  if (cached && Array.isArray(cached.items) && cached.items.length > 0) {
    applyItems(cached.items, Array.isArray(cached.categories) ? cached.categories : [], { fromCache: true });
  } else {
    renderSkeleton();
  }
})();

loadItems();
loadReportsBadge();
checkSession();

// Google's script loads on its own schedule: start now if it is already here,
// otherwise it calls initGoogle itself. If it never arrives, say so.
initGoogle();
setTimeout(() => {
  if (googleReady || initGoogle()) return;
  googleFailed = true;
  if (!el('account-modal').hidden && !session) drawGoogleButton('modal');
  if (isGated()) drawGoogleButton('gate');
}, 8000);
