'use strict';

const API = {
  items: '/.netlify/functions/store-items',
  txns: '/.netlify/functions/store-transactions',
  reports: '/.netlify/functions/store-reports',
  loans: '/.netlify/functions/store-loans',
  checkout: '/.netlify/functions/store-checkout',
  session: '/.netlify/functions/store-session',
  admin: '/.netlify/functions/store-admin',
  bookings: '/.netlify/functions/store-bookings',
};

// Public identifier of this site's "Sign in with Google" client (not a secret).
const GOOGLE_CLIENT_ID = '725610917729-tou01tupum34inr9smfeb9codh1dounr.apps.googleusercontent.com';

const ADMIN_PW_KEY = 'vitroxStoreAdminPw';
// Set while an admin who is signed in with their ViTrox account has Admin on.
const ADMIN_MODE_KEY = 'vitroxStoreAdminMode';
const CART_KEY = 'vitroxStoreCart';
const USER_KEY = 'vitroxStoreUser';
const ITEMS_CACHE_KEY = 'vitroxStoreItemsCache';
const SESSION_KEY = 'vitroxStoreSession';
// The booking whose items are in the cart (from "Move out" on a booking).
const CART_BOOKING_KEY = 'vitroxStoreCartBooking';

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

// Admin mode is on when either the admin password was entered in this tab, or
// someone on the admin list is signed in and switched Admin on. The server
// checks every admin action again either way.
let accountAdminOn = (() => {
  try {
    return sessionStorage.getItem(ADMIN_MODE_KEY) === '1';
  } catch {
    return false;
  }
})();

// Signed in as someone allowed to switch on the staff tools (admin or Store Manager).
function isAccountAdmin() {
  return Boolean(session && session.user && session.user.isAdmin);
}

// 'admin' | 'manager' | null — what the tools are switched on as. The admin
// password always counts as admin. The server checks every action again.
function adminRole() {
  if (hasAdminPassword()) return 'admin';
  if (!accountAdminOn || !isAccountAdmin()) return null;
  return session.user.role === 'manager' ? 'manager' : 'admin';
}

function isFullAdmin() {
  return adminRole() === 'admin';
}

function hasAdminPassword() {
  try {
    return Boolean(sessionStorage.getItem(ADMIN_PW_KEY));
  } catch {
    return false;
  }
}

function isAdminUnlocked() {
  return hasAdminPassword() || (accountAdminOn && isAccountAdmin());
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

function setAccountAdminOn(on) {
  accountAdminOn = on;
  try {
    if (on) sessionStorage.setItem(ADMIN_MODE_KEY, '1');
    else sessionStorage.removeItem(ADMIN_MODE_KEY);
  } catch {
    // Still works for this page; just not remembered across reloads.
  }
}

function unlockWithAccount() {
  setAccountAdminOn(true);
  updateAdminUI();
}

function lockAdmin() {
  try {
    sessionStorage.removeItem(ADMIN_PW_KEY);
  } catch {
    // nothing to clear
  }
  setAccountAdminOn(false);
  updateAdminUI();
}

let adminUIUnlocked = null;

function updateAdminUI() {
  const unlocked = isAdminUnlocked();
  const changed = adminUIUnlocked !== null && adminUIUnlocked !== unlocked;
  adminUIUnlocked = unlocked;
  if (changed) {
    if (!unlocked) showArchived = false;
    if (!unlocked && currentView === 'reports') showView('inventory');
    else if (currentView === 'dashboard') renderDashboard();
    if (itemsLoaded) {
      renderCategoryChips();
      renderGrid();
    }
    if (!el('detail-modal').hidden) {
      renderHistory();
      const open = items.find((i) => i.id === selectedItemId);
      if (open) el('detail-variations').innerHTML = renderVariationChips(open);
    }
  }
  const btn = el('admin-btn');
  const manager = adminRole() === 'manager';
  btn.innerHTML = `${icon(unlocked ? 'unlock' : 'lock')}<span class="btn-label">${unlocked ? (manager ? 'Manager · On' : 'Admin · On') : 'Admin'}</span>`;
  btn.classList.toggle('is-on', unlocked);
  const label = unlocked ? 'Admin mode is on — click to lock' : 'Unlock admin mode';
  btn.setAttribute('aria-label', label);
  btn.title = label;
  document.querySelectorAll('.admin-only').forEach((node) => {
    node.hidden = !unlocked;
  });
  // Admin-only tools (people, settings, categories, housekeeping) stay hidden for Store Managers.
  document.querySelectorAll('.owner-only').forEach((node) => {
    node.hidden = !unlocked || manager;
  });
  el('admin-bar-role').textContent = manager ? 'Store Manager tools' : 'Admin tools';
  el('audit-btn').innerHTML = `${icon('clipboard')} ${manager ? 'Activity Log' : 'Admins &amp; Log'}`;
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
    loadBookings();
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
  const sentAdmin = hasAdminPassword();

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
    const viaAccount = !sentAdmin && isAccountAdmin();
    if (viaAccount && session) {
      // The server no longer lists this account as an admin.
      setSession({ token: session.token, user: { ...session.user, isAdmin: false } });
    }
    lockAdmin();
    return {
      ok: false,
      status: res.status,
      data,
      unauthorized: true,
      error: viaAccount
        ? 'Your ViTrox account no longer has admin access. Ask an admin, or unlock with the admin password.'
        : 'Admin session expired or incorrect password — please unlock Admin again.',
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
const SUB_MODALS = new Set(['unused-modal', 'txn-modal', 'edit-txn-modal', 'edit-loan-modal', 'report-modal', 'item-form-modal', 'return-modal', 'admin-modal', 'account-modal', 'admins-modal', 'labels-modal']);
// Forms where a stray click outside should not throw away what was typed.
const KEEP_ON_BACKDROP = new Set(['item-form-modal', 'txn-modal', 'edit-txn-modal', 'edit-loan-modal', 'report-modal', 'return-modal', 'categories-modal', 'cleanup-modal', 'admins-modal']);
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
  if (isAccountAdmin()) {
    unlockWithAccount();
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
  } else if (isAccountAdmin()) {
    unlockWithAccount();
    showToast(`${session.user.role === 'manager' ? 'Store Manager' : 'Admin'} tools on — signed in as ${session.user.email}.`, 'success');
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
  // Signing out (or losing admin rights) also switches account-based Admin off.
  // (A sign-in saved before admins existed has no isAdmin yet; the server check
  // on page load fills it in.)
  if (accountAdminOn && (!session || session.user.isAdmin === false)) setAccountAdminOn(false);
  updateAdminUI();
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
    showToast(
      user.isAdmin && !isAdminUnlocked()
        ? `Signed in as ${user.name}. You are ${user.role === 'manager' ? 'a Store Manager' : 'an admin'} — press Admin to switch your tools on, no password needed.`
        : `Signed in as ${user.name}.`,
      'success',
      user.isAdmin ? 6000 : undefined
    );
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
  if (typeof currentView !== 'undefined' && (currentView === 'dashboard' || currentView === 'reports')) refreshEventViews();
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
  followPendingLink();
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
  // Damaged units returned from loans are held until repaired or written off.
  const held = item.quantityDamaged || 0;
  const available = (item.returnable ? item.quantity - (item.quantityOnLoan || 0) : item.quantity) - held;
  return Math.max(0, available || 0);
}

// Items still in use (archived ones are kept only for their history).
function activeItems() {
  return items.filter((i) => !i.archived);
}

let showArchived = false;

function lowStockItems() {
  return activeItems().filter((i) => availableQty(i) <= i.lowStockThreshold);
}

function activeVariations(item) {
  return item.hasVariations && Array.isArray(item.variations) ? item.variations.filter((v) => v.active) : [];
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
  const listed = activeItems();
  listed.forEach((i) => {
    counts[i.category] = (counts[i.category] || 0) + 1;
  });
  const unlisted = [...new Set(items.map((i) => i.category))].filter((c) => c && !categories.includes(c));
  el('category-filters').innerHTML = ['All', ...categories, ...unlisted]
    .map((cat) => {
      const active = cat === activeCategory;
      const count = cat === 'All' ? listed.length : counts[cat] || 0;
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
  const archivedView = showArchived && isAdminUnlocked();
  const list = items.filter((item) => {
    if (Boolean(item.archived) !== archivedView) return false;
    if (activeCategory !== 'All' && item.category !== activeCategory) return false;
    if (terms.length === 0) return true;
    const designs = (item.variations || []).map((v) => `${v.code} ${v.name}`).join(' ');
    const haystack = `${item.name} ${item.code || ''} ${item.category} ${item.locationText || ''} ${item.notes || ''} ${designs}`.toLowerCase();
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

  const designs = activeVariations(item).length;
  const pills =
    (item.archived ? `<span class="qty-pill muted-pill">Archived</span>` : '') +
    `<span class="qty-pill ${low ? 'low' : 'ok'}">${available} ${unit} avail.</span>` +
    (designs ? `<span class="design-tag">${plural(designs, 'design', 'designs')}</span>` : '') +
    (onLoan > 0 ? `<span class="on-loan-tag">${onLoan} on loan</span>` : '') +
    (item.quantityDamaged ? `<span class="qty-pill low" title="Returned damaged — held until repaired or written off">${item.quantityDamaged} damaged</span>` : '') +
    (inCart > 0 ? `<span class="in-cart-tag">${icon('cart')} ${inCart} in cart</span>` : '');

  let cartRow;
  if (item.archived) {
    cartRow = `<span class="muted">Archived — open it to restore</span>`;
  } else if (available <= 0) {
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
    (item.code ? `<span class="item-card-code">${escapeHtml(item.code)}</span>` : '') +
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

  const pool = items.filter((i) => Boolean(i.archived) === (showArchived && isAdminUnlocked()));
  el('results-count').textContent =
    (list.length === pool.length ? plural(pool.length, 'item', 'items') : `${list.length} of ${plural(pool.length, 'item', 'items')}`) +
    (showArchived && isAdminUnlocked() ? ' archived' : '');
  const archivedCount = items.length - activeItems().length;
  const toggle = el('archived-toggle');
  toggle.hidden = !isAdminUnlocked() || (archivedCount === 0 && !showArchived);
  toggle.textContent = showArchived ? 'Back to items in use' : `Show archived (${archivedCount})`;

  const empty = el('empty-state');
  empty.hidden = list.length > 0;
  if (list.length === 0) {
    const noItems = pool.length === 0;
    empty.querySelector('.state-title').textContent = noItems ? 'No items yet' : 'No items match';
    empty.querySelector('.state-text').textContent = noItems
      ? showArchived && isAdminUnlocked()
        ? 'Nothing is archived.'
        : 'Unlock Admin to add the first item to the store.'
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
  const room = item.archived ? 0 : available - inCart;
  const reserved = liveBookingsFor(item.id).reduce((sum, b) => sum + bookingQty(b, item.id), 0);

  el('detail-total').textContent = item.quantity;
  el('detail-reserved-row').hidden = reserved <= 0;
  el('detail-damaged-row').hidden = !item.quantityDamaged;
  el('detail-damaged').textContent = item.quantityDamaged || 0;
  el('detail-reserved').textContent = reserved;
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
  if (item.archived) label = 'Archived';
  else if (available <= 0) label = onLoan > 0 ? 'All out on loan' : 'Out of stock';
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
  el('detail-code').textContent = item.code || '';
  el('detail-code').hidden = !item.code;
  el('detail-archived').hidden = !item.archived;
  el('detail-archive-btn').innerHTML = `${icon('package')} ${item.archived ? 'Restore' : 'Archive'}`;
  el('detail-variations').hidden = !item.hasVariations || !(item.variations || []).length;
  const designs = activeVariations(item);
  const designSelect = el('detail-design');
  const keepDesign = designSelect.dataset.itemId === item.id ? designSelect.value : '';
  designSelect.hidden = designs.length === 0;
  designSelect.dataset.itemId = item.id;
  designSelect.innerHTML =
    `<option value="">Design…</option>` + designs.map((v) => `<option value="${escapeHtml(v.id)}">${escapeHtml(v.name)}</option>`).join('');
  designSelect.value = designs.some((v) => v.id === keepDesign) ? keepDesign : '';
  el('detail-variations').innerHTML = renderVariationChips(item);
  if (el('detail-qr').dataset.itemId !== item.id) hideDetailQr();
  el('detail-location-text').textContent = item.locationText || 'Location not specified';
  el('detail-unit').textContent = unit;
  el('detail-unit-2').textContent = unit;
  el('detail-notes').textContent = item.notes || '';
  el('detail-return-btn').hidden = !item.returnable || Boolean(item.archived);
  el('detail-loanable-note').hidden = !item.returnable;
  setDetailPhoto('item', item.itemImage, `Photo of ${item.name}`);
  setDetailPhoto('location', item.locationImage, `Where ${item.name} is kept`);
  renderDetailStock(item, resetQty);
  renderDetailBookings(item);
  renderDetailMine(item);
}

// The signed-in person's own open loans of this item — e.g. after scanning
// the item's QR label when bringing it back.
function myOpenLoans(item) {
  if (!session || !item.returnable) return [];
  return allLoans.filter((l) => l.itemId === item.id && l.status === 'open' && l.email === session.user.email);
}

function renderDetailMine(item) {
  const box = el('detail-mine');
  const mine = myOpenLoans(item);
  box.hidden = mine.length === 0;
  if (!mine.length) {
    box.innerHTML = '';
    return;
  }
  const count = mine.reduce((s, l) => s + loanOutstanding(l), 0);
  const due = mine.map((l) => l.expectedReturnDate).filter(Boolean).sort()[0];
  box.innerHTML =
    `${icon('return')}<span>You have <strong>${count}</strong> of these out (${escapeHtml([...new Set(mine.map((l) => l.purpose))].join(', '))})` +
    `${due ? ` — due back ${escapeHtml(fmtDate(due))}` : ''}.</span>` +
    `<button type="button" class="ghost-btn sky-btn" id="detail-return-mine">${icon('return')} Return mine</button>`;
}

el('detail-mine').addEventListener('click', (e) => {
  if (!e.target.closest('#detail-return-mine')) return;
  const item = items.find((i) => i.id === selectedItemId);
  if (item) openReturnModal(myOpenLoans(item), { origin: 'detail', checkAll: true });
});

async function openDetail(itemId) {
  const item = items.find((i) => i.id === itemId);
  if (!item) return;
  const fresh = selectedItemId !== itemId || el('detail-modal').hidden;
  selectedItemId = itemId;
  renderDetail(item, { resetQty: true });
  openModal('detail-modal');
  loadEventData().then((ok) => {
    const current = items.find((i) => i.id === itemId);
    if (ok && current && selectedItemId === itemId && !el('detail-modal').hidden) {
      renderDetailBookings(current);
      renderDetailStock(current, false);
      renderDetailMine(current);
    }
  });
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
    const condition = [r.damaged ? `${r.damaged} damaged` : '', r.missing ? `${r.missing} missing` : '', r.conditionNote || ''].filter(Boolean).join(' · ');
    return `<tr>${date}<td><span class="type-label ret">Return</span></td><td>${r.quantity}${r.missing ? ` <span class="muted-text">(+${r.missing} missing)</span>` : ''}</td><td>${who}</td><td>${escapeHtml([condition, remarks].filter(Boolean).join(' · '))}</td><td class="row-actions"></td></tr>`;
  });

  if (historyTotal > historyEvents.length) {
    rows.push(
      `<tr><td colspan="6" class="muted-cell">Showing the latest ${historyEvents.length} of ${historyTotal} — export the Activity log for the full history.</td></tr>`
    );
  }
  body.innerHTML = rows.join('');
  labelTableCells(body.closest('table'));
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

// 'now' = move the items out now; 'book' = reserve them for an event's dates.
// Always 'now' — booking for an event is done in the event form.
const cartMode = 'now';
let cartBookingId = (() => {
  const stored = readStored(CART_BOOKING_KEY, null);
  return typeof stored === 'string' && cart.length > 0 ? stored : null;
})();

function saveCart() {
  if (cart.length === 0) cartBookingId = null;
  writeStored(CART_KEY, cart);
  writeStored(CART_BOOKING_KEY, cartBookingId);
  setBadge('cart-badge', cart.length);
}

// Most of an item one cart line can hold: what is free now, or (when booking
// for later) everything the store owns.
function cartLineMax(item) {
  return cartMode === 'book' ? Math.max(0, item.quantity || 0) : availableQty(item);
}

// A cart line is one item, or one design of an item: { itemId, variationId?, quantity }.
// Designs of an item share its stock, so limits are checked per item.
function cartKey(line) {
  return `${line.itemId}|${line.variationId || ''}`;
}

function cartQty(itemId) {
  return cart.filter((l) => l.itemId === itemId).reduce((sum, l) => sum + l.quantity, 0);
}

function cartLoanableItems() {
  const seen = new Set();
  return cart
    .map((line) => items.find((i) => i.id === line.itemId))
    .filter((item) => item && item.returnable && !seen.has(item.id) && seen.add(item.id));
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

function addToCart(itemId, rawQuantity, variationId) {
  const item = items.find((i) => i.id === itemId);
  if (!item) return false;
  const quantity = Math.round(Number(rawQuantity));
  if (!quantity || quantity <= 0) {
    showToast('Enter a quantity of at least 1.', 'error');
    return false;
  }

  const unit = item.unit || 'pcs';
  const available = cartLineMax(item);
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

  const designs = activeVariations(item);
  const variation = designs.find((v) => v.id === variationId) || null;
  const key = cartKey({ itemId, variationId: variation ? variation.id : null });
  const line = cart.find((l) => cartKey(l) === key);
  if (line) line.quantity += quantity;
  else cart.push(variation ? { itemId, variationId: variation.id, quantity } : { itemId, quantity });
  cartChanged();
  showToast(`Added ${quantity} × ${item.name}${variation ? ` (${variation.name})` : ''} to cart.`, 'success');
  return true;
}

function detailDesign() {
  const select = el('detail-design');
  return select && !select.hidden ? select.value || null : null;
}

el('detail-cart-btn').addEventListener('click', () => addToCart(selectedItemId, el('detail-cart-qty').value, detailDesign()));

el('detail-cart-qty').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  addToCart(selectedItemId, el('detail-cart-qty').value, detailDesign());
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
    const available = cartLineMax(item);
    const unit = item.unit || 'pcs';
    const name = escapeHtml(item.name);
    // Several designs of one item share what is available.
    const others = cartQty(item.id) - line.quantity;
    const room = Math.max(0, available - others);
    const warning = cartLineWarning(line, room);
    const headsUp = bookingHeadsUp(item, cartQty(item.id));
    const designs = activeVariations(item);

    const thumb = item.itemImage
      ? `<img class="cart-line-thumb" src="${escapeHtml(item.itemImage)}" alt="" loading="lazy" decoding="async" />`
      : `<div class="cart-line-thumb">${icon('package')}</div>`;
    const designPicker = designs.length
      ? `<select class="cart-design${line.variationId ? '' : ' needs-choice'}" data-design aria-label="Design of ${name}">` +
        `<option value="">Choose design…</option>` +
        designs.map((v) => `<option value="${escapeHtml(v.id)}"${v.id === line.variationId ? ' selected' : ''}>${escapeHtml(v.name)}</option>`).join('') +
        `</select>`
      : '';

    const row = document.createElement('div');
    row.className = 'cart-line';
    row.dataset.itemId = item.id;
    row.dataset.key = cartKey(line);
    row.innerHTML =
      thumb +
      `<div class="line-info"><strong>${name}</strong>` +
      `<div class="line-meta">${available} ${escapeHtml(unit)} available` +
      (item.returnable ? `<span class="on-loan-tag">${icon('return')} Loan — must return</span>` : '') +
      `</div>` +
      designPicker +
      `<div class="line-warning"${warning ? '' : ' hidden'}>${escapeHtml(warning)}</div>` +
      (headsUp ? `<div class="line-booked">${icon('calendar')}<span>${escapeHtml(headsUp)}</span></div>` : '') +
      `</div>` +
      `<span class="stepper">` +
      `<button type="button" class="step-btn" data-step="-1" aria-label="Decrease quantity">${icon('minus')}</button>` +
      `<input type="number" inputmode="numeric" min="1" max="${Math.max(room, 1)}" step="1" value="${line.quantity}" aria-label="Quantity of ${name}" />` +
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
    ? `${icon('return')}<span>${escapeHtml(loanable.map((i) => i.name).join(', '))} will be recorded as on loan under your name until returned (Loans &amp; Returns → Return).</span>`
    : '';

  const fromBooking = cartBookingId ? allBookings.find((b) => b.id === cartBookingId) : null;
  const bookingNote = el('cart-booking-note');
  bookingNote.hidden = !fromBooking;
  bookingNote.innerHTML = fromBooking
    ? `${icon('calendar')}<span>Moving out the event <strong>“${escapeHtml(fromBooking.event)}”</strong> (${escapeHtml(fmtRange(fromBooking.startDate, fromBooking.endDate))}). ` +
      `It will be marked as collected. Change the quantities to what is actually taken. ` +
      `<button type="button" class="link-btn" id="cart-unlink-booking">Not this event</button></span>`
    : '';
  el('cart-book-btn').hidden = Boolean(fromBooking);

  el('checkout-submit-btn').innerHTML = `${icon('check')} ${fromBooking ? 'Collect' : 'Checkout'} ${plural(cart.length, 'item', 'items')}`;
}

el('cart-booking-note').addEventListener('click', (e) => {
  if (!e.target.closest('#cart-unlink-booking')) return;
  cartBookingId = null;
  saveCart();
  renderCart();
});

function cartLineFromRow(row) {
  return row ? cart.find((l) => cartKey(l) === row.dataset.key) || null : null;
}

el('cart-lines').addEventListener('change', (e) => {
  const row = e.target.closest('.cart-line');
  const line = cartLineFromRow(row);
  if (!line) return;
  const item = items.find((i) => i.id === line.itemId);
  if (!item) return;

  if (e.target.matches('[data-design]')) {
    const next = e.target.value || null;
    const same = cart.find((l) => l !== line && l.itemId === line.itemId && (l.variationId || null) === next);
    if (same) {
      // Already a line for that design: add the two together.
      same.quantity += line.quantity;
      cart = cart.filter((l) => l !== line);
    } else if (next) line.variationId = next;
    else delete line.variationId;
    cartChanged();
    renderCart();
    return;
  }
  if (e.target.type !== 'number') return;

  const room = Math.max(0, cartLineMax(item) - (cartQty(item.id) - line.quantity));
  let next = Math.round(Number(e.target.value));
  if (!next || next < 1) next = 1;
  if (room > 0 && next > room) next = room;
  line.quantity = next;
  e.target.value = String(next);
  cartChanged();
  // Redraw so warnings and booking heads-ups follow the new quantity.
  const key = cartKey(line);
  renderCart();
  const again = [...el('cart-lines').querySelectorAll('.cart-line')].find((r) => r.dataset.key === key);
  const input = again && again.querySelector('input[type="number"]');
  if (input && document.activeElement === document.body) input.focus({ preventScroll: true });
});

el('cart-lines').addEventListener('click', (e) => {
  const removeBtn = e.target.closest('[data-remove]');
  if (!removeBtn) return;
  const line = cartLineFromRow(removeBtn.closest('.cart-line'));
  cart = cart.filter((l) => l !== line);
  cartChanged();
  renderCart();
  focusInside(el('cart-modal'));
});

el('cart-book-btn').addEventListener('click', () => {
  const lines = cart.map((l) => ({ itemId: l.itemId, variationId: l.variationId || null, quantity: l.quantity }));
  closeModal('cart-modal');
  openEventForm({ lines, fromCart: true, event: el('checkout-purpose').value.trim() });
});


function openCart() {
  const user = session ? {} : rememberedUser();
  if (!el('checkout-name').value) el('checkout-name').value = user.name || '';
  if (!el('checkout-employee-no').value) el('checkout-employee-no').value = user.employeeNo || '';
  el('checkout-return-date').min = todayStr();
  setFormError('checkout-form-error', '');
  renderCart();
  openModal('cart-modal');
  // Fresh bookings for the heads-up notes on each line.
  loadBookings().then((ok) => {
    if (ok && !el('cart-modal').hidden) renderCart();
  });
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
  el('success-title').textContent = 'Checkout recorded';
  el('success-loans-btn').textContent = 'View Loans & Returns';
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
      ? `${icon('return')}<span>Please bring the loaned ${loanCount > 1 ? 'items' : 'item'} back by <strong>${escapeHtml(fmtDate(body.expectedReturnDate))}</strong>, then record it under Loans &amp; Returns → Return.</span>`
      : '';
  el('success-loans-btn').hidden = loanCount === 0;
  openModal('success-modal');
}

el('success-loans-btn').addEventListener('click', () => openLoansPanel('open'));

el('checkout-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (cart.length === 0) return;

  withBusy(el('checkout-submit-btn'), async () => {
    setFormError('checkout-form-error', '');
    const missingDesign = cart.find((l) => {
      const item = items.find((i) => i.id === l.itemId);
      return item && activeVariations(item).length && !l.variationId;
    });
    if (missingDesign) {
      setFormError('checkout-form-error', `Choose a design for “${items.find((i) => i.id === missingDesign.itemId).name}”.`);
      return;
    }
    const hasLoanable = cartLoanableItems().length > 0;
    const body = {
      ...personFrom('checkout-name', 'checkout-employee-no'),
      purpose: el('checkout-purpose').value,
      expectedReturnDate: hasLoanable ? el('checkout-return-date').value || null : null,
      lines: cart.map((line) => ({ itemId: line.itemId, variationId: line.variationId || undefined, quantity: line.quantity })),
    };
    if (cartBookingId) body.bookingId = cartBookingId;

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
      const design = (item.variations || []).find((v) => v.id === line.variationId);
      return { name: `${item.name || 'Item'}${design ? ` (${design.name})` : ''}`, quantity: line.quantity, unit: item.unit || 'pcs', returnable: Boolean(item.returnable) };
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
    if (res.data.booking) {
      el('success-subtitle').textContent += ` Event “${res.data.booking.event}” is now marked as collected.`;
      loadEventData().then(refreshEventViews);
    }
    renderGrid();
    await loadItems({ silent: true });
    loadReportsBadge();
  });
});

// ---------- Returns (one or several loans in a single submit) ----------

let returnOrigin = 'detail';

function loanOutstanding(loan) {
  return loan.quantity - loan.quantityReturned - (loan.quantityMissing || 0);
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
    const name = `${loan.itemName}${loan.variationName ? ` (${loan.variationName})` : ''}`;

    const row = document.createElement('div');
    row.className = `return-line${checked ? '' : ' is-off'}`;
    row.dataset.outstanding = String(outstanding);
    row.innerHTML =
      `<input type="checkbox" id="${checkId}"${checked ? ' checked' : ''} />` +
      `<label class="line-info" for="${checkId}">` +
      `<strong>${escapeHtml(name)} — ${outstanding} not returned</strong>` +
      `<span class="line-meta">${escapeHtml(`Borrowed by ${loan.name} (${loan.employeeNo}) · ${loan.purpose}${due}`)}</span>` +
      `</label>` +
      `<span class="stepper" title="Coming back in good condition">` +
      `<button type="button" class="step-btn" data-step="-1" aria-label="Decrease quantity">${icon('minus')}</button>` +
      `<input type="number" inputmode="numeric" min="0" max="${outstanding}" step="1" value="${outstanding}" data-cond="good" aria-label="${escapeHtml(name)} back in good condition" />` +
      `<button type="button" class="step-btn" data-step="1" aria-label="Increase quantity">${icon('plus')}</button>` +
      `</span>` +
      `<button type="button" class="link-btn return-cond-toggle" data-cond-toggle aria-expanded="false">Damaged or missing?</button>` +
      `<div class="return-condition" hidden>` +
      `<label>Damaged <input type="number" inputmode="numeric" min="0" max="${outstanding}" step="1" value="0" data-cond="damaged" /></label>` +
      `<label>Missing <input type="number" inputmode="numeric" min="0" max="${outstanding}" step="1" value="0" data-cond="missing" /></label>` +
      `<label class="return-cond-note">What happened? <input type="text" maxlength="300" data-cond="note" placeholder="e.g. leg cracked, one left at the venue" /></label>` +
      `</div>`;
    row.querySelector('input[type="checkbox"]').dataset.loanId = loan.id;
    container.appendChild(row);
  });

  prefillPerson('return-name', 'return-employee-no');
  el('return-notes').value = '';
  setFormError('return-form-error', '');
  openModal('return-modal');
}

function returnRowValues(row) {
  const num = (cond) => Math.max(0, Math.round(Number(row.querySelector(`[data-cond="${cond}"]`).value)) || 0);
  return { good: num('good'), damaged: num('damaged'), missing: num('missing'), note: row.querySelector('[data-cond="note"]').value.trim() };
}

el('return-lines').addEventListener('change', (e) => {
  const row = e.target.closest('.return-line');
  if (!row) return;
  if (e.target.type === 'checkbox') {
    row.classList.toggle('is-off', !e.target.checked);
    return;
  }
  // Damaged / missing come out of the "good" count, so the line never adds up to more than is out.
  const cond = e.target.dataset.cond;
  if (cond === 'damaged' || cond === 'missing') {
    const v = returnRowValues(row);
    const outstanding = Number(row.dataset.outstanding);
    const good = row.querySelector('[data-cond="good"]');
    if (v.good + v.damaged + v.missing > outstanding) good.value = String(Math.max(0, outstanding - v.damaged - v.missing));
    if (v.damaged + v.missing > 0) row.querySelector('input[type="checkbox"]').checked = true;
    row.classList.toggle('is-off', !row.querySelector('input[type="checkbox"]').checked);
  }
});

el('return-lines').addEventListener('click', (e) => {
  const toggle = e.target.closest('[data-cond-toggle]');
  if (!toggle) return;
  const box = toggle.closest('.return-line').querySelector('.return-condition');
  box.hidden = !box.hidden;
  toggle.setAttribute('aria-expanded', String(!box.hidden));
  if (!box.hidden) box.querySelector('[data-cond="damaged"]').focus();
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
  let problem = '';
  el('return-lines')
    .querySelectorAll('.return-line')
    .forEach((row) => {
      const check = row.querySelector('input[type="checkbox"]');
      if (!check.checked) return;
      const v = returnRowValues(row);
      const total = v.good + v.damaged + v.missing;
      const name = row.querySelector('strong').textContent.split(' — ')[0];
      if (total <= 0) problem = problem || `“${name}”: enter how many are coming back (or damaged / missing).`;
      else if (total > Number(row.dataset.outstanding)) problem = problem || `“${name}”: only ${row.dataset.outstanding} are still out.`;
      else if ((v.damaged || v.missing) && !v.note) problem = problem || `“${name}”: say briefly what happened to the damaged or missing items.`;
      returns.push({ loanId: check.dataset.loanId, quantity: v.good, damaged: v.damaged, missing: v.missing, note: v.note });
    });

  if (returns.length === 0) {
    setFormError('return-form-error', 'Tick at least one item that is being returned.');
    return;
  }
  if (problem) {
    setFormError('return-form-error', problem);
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
    const flagged = returns.reduce((sum, r) => sum + r.damaged + r.missing, 0);
    showToast(
      flagged
        ? `Return recorded. ${plural(flagged, 'damaged or missing item has', 'damaged or missing items have')} been reported to the store team.`
        : `Return recorded for ${plural(returns.length, 'item', 'items')}.`,
      'success',
      flagged ? 6000 : undefined
    );
    await loadItems({ silent: true });
    loadReportsBadge();
    if (returnOrigin === 'loans') await openLoansPanel();
    else if (returnOrigin === 'event') {
      await loadEventData();
      refreshEventViews();
    } else await openDetail(selectedItemId);
  });
});

// ---------- Loan records: what is still out, and who has borrowed what ----------

let allLoans = [];
let loansLoaded = false;
let loansTab = 'open';
let loansSearch = '';
const selectedLoanIds = new Set();

async function openLoansPanel(tab) {
  if (tab === 'open' || tab === 'all') loansTab = tab;
  selectedLoanIds.clear();
  renderLoansPanel();
  openModal('loans-modal');

  const [res] = await Promise.all([
    request(API.loans),
    loadBookings(),
  ]);
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
    return `<span class="qty-pill ok">Returned</span>${conditionPills(loan)}${detail}`;
  }
  const overdue = isOverdue(loan) ? ' <span class="qty-pill low">Overdue</span>' : '';
  return `<span class="on-loan-tag">${loanOutstanding(loan)} not returned</span>${conditionPills(loan)}${overdue}`;
}

function conditionPills(loan) {
  return (
    (loan.quantityDamaged ? ` <span class="qty-pill low">${loan.quantityDamaged} damaged</span>` : '') +
    (loan.quantityMissing ? ` <span class="qty-pill low">${loan.quantityMissing} missing</span>` : '')
  );
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
  const allTab = !openTab;
  el('loans-tab-open').classList.toggle('active', openTab);
  el('loans-tab-open').setAttribute('aria-pressed', String(openTab));
  el('loans-tab-all').classList.toggle('active', allTab);
  el('loans-tab-all').setAttribute('aria-pressed', String(allTab));
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
  labelTableCells(el('loans-body').closest('table'));
}

el('loans-btn').addEventListener('click', openLoansPanel);

el('loans-body').addEventListener('click', (e) => {
  const bookingBtn = e.target.closest('[data-booking-collect], [data-booking-cancel], [data-booking-delete]');
  if (bookingBtn) {
    const id = bookingBtn.dataset.bookingCollect || bookingBtn.dataset.bookingCancel || bookingBtn.dataset.bookingDelete;
    const booking = allBookings.find((b) => b.id === id);
    if (!booking) return;
    if (bookingBtn.dataset.bookingCollect) collectBooking(booking);
    else if (bookingBtn.dataset.bookingCancel) cancelBooking(booking, bookingBtn);
    else requireAdminThen(() => deleteBooking(booking));
    return;
  }
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


// ---------- Event bookings ----------

let allBookings = [];
let bookingsLoaded = false;

async function loadBookings() {
  const res = await request(API.bookings);
  if (!res.ok) return false;
  allBookings = Array.isArray(res.data.bookings) ? res.data.bookings : [];
  bookingsLoaded = true;
  return true;
}

// "14 Dec 2026" or "14 Dec 2026 – 15 Dec 2026"
function fmtRange(start, end) {
  return !end || end === start ? fmtDate(start) : `${fmtDate(start)} – ${fmtDate(end)}`;
}

// Booked, and the event has not finished yet.
function isLiveBooking(b) {
  return b.status === 'booked' && b.endDate >= todayStr();
}

function bookingQty(b, itemId) {
  return (b.lines || []).filter((l) => l.itemId === itemId).reduce((sum, l) => sum + l.quantity, 0);
}

function liveBookingsFor(itemId, { except } = {}) {
  return allBookings
    .filter((b) => b.id !== except && isLiveBooking(b) && bookingQty(b, itemId) > 0)
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
}

// Taking items out now while some are booked for an event: a gentle note.
function bookingHeadsUp(item, quantity) {
  const list = liveBookingsFor(item.id, { except: cartBookingId });
  if (list.length === 0) return '';
  const booked = list.reduce((sum, b) => sum + bookingQty(b, item.id), 0);
  if (availableQty(item) - quantity >= booked) return '';
  const first = list[0];
  return list.length === 1
    ? `${booked} booked for “${first.event}” from ${fmtDate(first.startDate)} — check with ${first.name} before taking these.`
    : `${booked} booked for ${list.length} upcoming events (first: “${first.event}”, ${fmtDate(first.startDate)}) — check before taking these.`;
}

function renderDetailBookings(item) {
  const box = el('detail-bookings');
  const list = liveBookingsFor(item.id);
  box.hidden = list.length === 0;
  if (list.length === 0) {
    box.innerHTML = '';
    return;
  }
  const shown = list.slice(0, 5);
  box.innerHTML =
    `<p class="detail-bookings-title">${icon('calendar')}<strong>Booked for upcoming events</strong></p><ul>` +
    shown
      .map(
        (b) =>
          `<li><strong>${bookingQty(b, item.id)} ${escapeHtml(item.unit || 'pcs')}</strong> for “${escapeHtml(b.event)}” · ` +
          `${escapeHtml(fmtRange(b.startDate, b.endDate))} · ${escapeHtml(b.name)}</li>`
      )
      .join('') +
    `</ul>` +
    (list.length > shown.length ? `<p class="muted-text">+ ${list.length - shown.length} more in Events</p>` : '');
}

function bookingStatusHtml(b) {
  const today = todayStr();
  if (b.status === 'cancelled') return '<span class="qty-pill muted-pill">Cancelled</span>';
  if (b.status === 'collected') return `<span class="qty-pill ok">Collected</span> ${escapeHtml(fmtDay(b.collectedAt))}`;
  if (b.endDate < today) return '<span class="qty-pill low">Not collected</span>';
  const clash = b.clashesAccepted ? ' <span class="qty-pill low" title="Booked even though some items clash with other bookings">Clash</span>' : '';
  if (b.startDate <= today) return `<span class="qty-pill booking-now">On now</span>${clash}`;
  return `<span class="qty-pill booking-soon">Upcoming</span>${clash}`;
}

function ownsBooking(b) {
  return Boolean(session && b.email && session.user.email === b.email);
}

// Upcoming and current first (soonest first), then the rest (newest first).
function sortedBookings() {
  const live = allBookings.filter(isLiveBooking).sort((a, b) => a.startDate.localeCompare(b.startDate));
  const rest = allBookings.filter((b) => !isLiveBooking(b)).sort((a, b) => b.startDate.localeCompare(a.startDate));
  return live.concat(rest);
}

// "Move out" on a booking: fills the cart with its items, event and return date.
async function collectBooking(b) {
  const lines = (b.lines || [])
    .filter((l) => items.some((i) => i.id === l.itemId))
    .map((l) => (l.variationId ? { itemId: l.itemId, variationId: l.variationId, quantity: l.quantity } : { itemId: l.itemId, quantity: l.quantity }));
  if (lines.length === 0) {
    showToast('The items in this booking are no longer in the store.', 'error');
    return;
  }
  if (cart.length > 0 && cartBookingId !== b.id) {
    const ok = await confirmDialog({
      title: 'Replace what is in your cart?',
      message: `Your cart has ${plural(cart.length, 'item', 'items')}. Moving out “${b.event}” puts this booking's items in the cart instead.`,
      confirmLabel: 'Use this booking',
      danger: false,
    });
    if (!ok) return;
  }
  cart = lines;
  cartBookingId = b.id;
  saveCart();
  renderGrid();
  el('checkout-purpose').value = b.event;
  el('checkout-return-date').value = b.endDate >= todayStr() ? b.endDate : '';
  closeModal('loans-modal');
  openCart();
}

async function cancelBooking(b, button) {
  const ok = await confirmDialog({
    title: 'Cancel this event?',
    message: `“${b.event}” (${fmtRange(b.startDate, b.endDate)}), booked by ${b.name}. The items will be free for other events again.`,
    confirmLabel: 'Cancel event',
  });
  if (!ok) return;
  await withBusy(button, async () => {
    const res = await request(`${API.bookings}?id=${encodeURIComponent(b.id)}`, { method: 'PATCH', body: { status: 'cancelled' } });
    if (!res.ok) {
      showToast(res.error, 'error');
      return;
    }
    showToast('Event cancelled — its items are free again.', 'success');
    await loadEventData();
    refreshEventViews();
  });
}

async function deleteBooking(b) {
  const ok = await confirmDialog({
    title: 'Delete this event record?',
    message: `“${b.event}” (${fmtRange(b.startDate, b.endDate)}), booked by ${b.name}. This removes the record for good — to just call it off, use Cancel.`,
    confirmLabel: 'Delete record',
  });
  if (!ok) return;
  const res = await request(`${API.bookings}?id=${encodeURIComponent(b.id)}`, { method: 'DELETE', admin: true });
  if (!res.ok) {
    showToast(res.error, 'error');
    return;
  }
  showToast('Event record deleted.', 'success');
  closeModal('event-modal');
  await loadEventData();
  refreshEventViews();
}

// ---------- Phones: tables as cards ----------

// Copies each column heading onto its cells (data-label), so on a narrow
// screen CSS can show every row as a card of "Heading: value" lines.
function labelTableCells(table) {
  if (!table) return;
  const heads = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim());
  table.querySelectorAll('tbody tr').forEach((tr) =>
    [...tr.children].forEach((td, i) => {
      if (heads[i] && td.colSpan === 1) td.dataset.label = heads[i];
    })
  );
}

// ---------- Dashboard ----------
// Every figure is worked out from the live stock, events and loans.

let openReportCount = 0;

async function loadDashboardData() {
  const [ok, reports] = await Promise.all([loadEventData(), request(`${API.reports}?status=open`)]);
  if (reports.ok) openReportCount = (reports.data.reports || []).length;
  return ok;
}

function dashboardFigures() {
  const today = todayStr();
  const in7 = addDays(today, 7);
  const active = activeItems();
  const sum = (list, fn) => list.reduce((s, x) => s + (fn(x) || 0), 0);
  const reservedFor = (item) => liveBookingsFor(item.id).reduce((s, b) => s + bookingQty(b, item.id), 0);
  const openLoans = allLoans.filter((l) => l.status === 'open');
  const live = allBookings.filter((b) => b.status !== 'cancelled');
  return {
    items: active.length,
    stock: sum(active, (i) => i.quantity),
    available: sum(active, availableQty),
    onLoan: sum(active, (i) => (i.returnable ? i.quantityOnLoan : 0)),
    reserved: sum(active, reservedFor),
    damaged: sum(active, (i) => i.quantityDamaged),
    low: lowStockItems(),
    overdue: openLoans.filter(isOverdue),
    upcoming: live.filter((b) => b.status === 'booked' && b.startDate > today),
    today: live.filter((b) => b.startDate <= today && b.endDate >= today),
    activeBookings: allBookings.filter((b) => isLiveBooking(b) && (b.lines || []).length),
    collections: allBookings.filter((b) => b.status === 'booked' && (b.lines || []).length && b.startDate >= today && b.startDate <= in7),
    returns: openLoans.filter((l) => l.expectedReturnDate && l.expectedReturnDate >= today && l.expectedReturnDate <= in7),
    notCollected: allBookings.filter((b) => b.status === 'booked' && b.endDate < today && (b.lines || []).length),
    completed: allBookings.filter((b) => eventState(b) === 'returned' && b.endDate >= addDays(today, -30)),
  };
}

function tile(num, label, sub, go, tone) {
  return (
    `<button type="button" class="dash-tile${tone ? ` t-${tone}` : ''}" data-go="${go}">` +
    `<span class="dash-num">${escapeHtml(String(num))}</span><span class="dash-label">${escapeHtml(label)}</span>` +
    (sub ? `<span class="dash-sub">${escapeHtml(sub)}</span>` : '') +
    `</button>`
  );
}

function renderDashboard() {
  const f = dashboardFigures();
  const admin = isAdminUnlocked();
  el('dash-actions').innerHTML = [
    admin ? `<button type="button" class="ghost-btn" data-go="add-item">${icon('plus')} Add New Item</button>` : '',
    `<button type="button" class="primary-btn" data-go="create-event">${icon('calendar')} Create Event</button>`,
    `<button type="button" class="ghost-btn" data-go="book-items">${icon('cart')} Book Items</button>`,
    `<button type="button" class="ghost-btn sky-btn" data-go="returns">${icon('return')} Process Return</button>`,
    `<button type="button" class="ghost-btn" data-go="calendar">${icon('calendar')} View Calendar</button>`,
    admin ? `<button type="button" class="ghost-btn" data-go="labels">${icon('qr')} Generate QR Labels</button>` : '',
  ].join('');
  el('dash-inventory').innerHTML = [
    tile(f.items, 'Registered items', 'In use (not archived)', 'inventory'),
    tile(f.stock, 'Total stock', 'Physical units', 'inventory'),
    tile(f.available, 'Available now', 'Ready to take out', 'inventory', 'ok'),
    tile(f.onLoan, 'On loan', 'Out with staff', 'returns', f.onLoan ? 'active' : ''),
    tile(f.reserved, 'Reserved', 'Booked for upcoming events', 'events', f.reserved ? 'event' : ''),
    tile(f.low.length, 'Low-stock items', f.low.slice(0, 2).map((i) => i.name).join(', '), 'low-stock', f.low.length ? 'warn' : ''),
    tile(f.overdue.length, 'Overdue loans', f.overdue.length ? `${plural(sum(f.overdue), 'item', 'items')} not back` : 'Nothing overdue', 'overdue', f.overdue.length ? 'bad' : ''),
    tile(f.damaged, 'Held as damaged', 'Waiting for repair / write-off', 'alerts', f.damaged ? 'bad' : ''),
  ].join('');
  el('dash-events').innerHTML = [
    tile(f.today.length, "Today's events", f.today.map((b) => b.event).slice(0, 2).join(', '), 'events', f.today.length ? 'event' : ''),
    tile(f.upcoming.length, 'Upcoming events', f.upcoming[0] ? `Next: ${f.upcoming.sort((a, b) => a.startDate.localeCompare(b.startDate))[0].event}` : '', 'events', 'event'),
    tile(f.activeBookings.length, 'Active bookings', 'Items reserved, not collected', 'events'),
    tile(f.collections.length, 'Collections (7 days)', 'Events whose items go out soon', 'events', f.collections.length ? 'active' : ''),
    tile(f.returns.length, 'Returns due (7 days)', 'Loans due back soon', 'returns', f.returns.length ? 'active' : ''),
    tile(f.notCollected.length, 'Not collected', 'Past events never collected', 'events-past', f.notCollected.length ? 'warn' : ''),
    tile(f.completed.length, 'Recently completed', 'Events finished, all returned (30 days)', 'events-past', 'ok'),
    tile(openReportCount, 'Open reports', 'Damage, missing, restock', 'alerts', openReportCount ? 'warn' : ''),
  ].join('');

  // The next week: collections and returns, soonest first.
  const today = todayStr();
  const soon = [
    ...f.collections.map((b) => ({ day: b.startDate, kind: 'Collect', text: b.event, sub: linesSummary(b.lines), ref: b.id, tone: 'event' })),
    ...f.returns.map((l) => ({ day: l.expectedReturnDate, kind: 'Return', text: `${l.itemName} × ${loanOutstanding(l)}`, sub: `${l.name} · ${l.purpose}`, loan: true, tone: 'active' })),
    ...f.overdue.map((l) => ({ day: l.expectedReturnDate, kind: 'Overdue', text: `${l.itemName} × ${loanOutstanding(l)}`, sub: `${l.name} · ${l.purpose}`, loan: true, tone: 'overdue' })),
  ].sort((a, b) => a.day.localeCompare(b.day));
  el('dash-upcoming').innerHTML = soon.length
    ? soon
        .slice(0, 12)
        .map(
          (x) =>
            `<button type="button" class="dash-row s-${x.tone}" ${x.ref ? `data-event-ref="${escapeHtml(x.ref)}"` : 'data-go="returns"'}>` +
            `<span class="dash-row-day">${x.day === today ? 'Today' : escapeHtml(fmtDate(x.day))}</span>` +
            `<span class="status-pill s-${x.tone === 'overdue' ? 'overdue' : x.tone}">${escapeHtml(x.kind)}</span>` +
            `<span class="dash-row-text"><strong>${escapeHtml(x.text)}</strong><span class="muted-text">${escapeHtml(x.sub || '')}</span></span></button>`
        )
        .join('')
    : '<p class="muted-text">No collections or returns in the next 7 days.</p>';

  function sum(loans) {
    return loans.reduce((s, l) => s + loanOutstanding(l), 0);
  }
}

el('view-dashboard').addEventListener('click', (e) => {
  const ev = e.target.closest('[data-event-ref]');
  if (ev) {
    openEventDetail(ev.dataset.eventRef);
    return;
  }
  const btn = e.target.closest('[data-go]');
  if (!btn) return;
  const go = btn.dataset.go;
  if (go === 'inventory') showView('inventory');
  else if (go === 'low-stock') {
    showView('inventory');
    sortMode = 'low';
    el('sort-select').value = 'low';
    renderGrid();
  } else if (go === 'events' || go === 'events-past') {
    eventsFilter = go === 'events' ? 'upcoming' : 'past';
    showView('events');
  } else if (go === 'calendar') showView('calendar');
  else if (go === 'returns') openLoansPanel('open');
  else if (go === 'overdue') {
    loansSearch = '';
    el('loans-search').value = '';
    openLoansPanel('open');
  } else if (go === 'alerts') el('reports-btn').click();
  else if (go === 'create-event' || go === 'book-items') {
    showView('events');
    openEventForm({});
  } else if (go === 'add-item') requireAdminThen(() => openItemForm(null));
  else if (go === 'labels') requireAdminThen(() => openLabelsModal());
});

// ---------- Reports (admins and Store Managers) ----------

const REPORTS = {
  inventory: { label: 'Inventory listing', dated: false },
  availability: { label: 'Stock availability', dated: false },
  lowstock: { label: 'Low-stock items', dated: false },
  borrowing: { label: 'Borrowing history', dated: true },
  returns: { label: 'Return history', dated: true },
  overdue: { label: 'Overdue items', dated: false },
  events: { label: 'Event booking history', dated: true },
  popular: { label: 'Most frequently borrowed / used items', dated: true },
  adjustments: { label: 'Stock adjustments', dated: true },
  cancelled: { label: 'Cancelled bookings', dated: true },
};

let reportTxns = [];
let reportReports = [];

async function loadReportData() {
  const [, txns, reps] = await Promise.all([loadEventData(), request(API.txns), request(API.reports)]);
  if (txns.ok) reportTxns = txns.data.transactions || [];
  if (reps.ok) reportReports = reps.data.reports || [];
}

function inRange(day) {
  const from = el('rp-from').value;
  const to = el('rp-to').value;
  return Boolean(day) && (!from || day >= from) && (!to || day <= to);
}

function designOf(x) {
  return x.variationName || '';
}

// [header, ...rows] for the chosen report.
function reportRows(kind) {
  const reserved = (item) => liveBookingsFor(item.id).reduce((s, b) => s + bookingQty(b, item.id), 0);
  const today = todayStr();
  switch (kind) {
    case 'inventory':
      return [
        ['Item Code', 'Name', 'Category', 'Unit', 'Total', 'Loanable', 'Low-stock Alert At', 'Storage Location', 'Design Variations', 'Status', 'Notes'],
        ...items
          .slice()
          .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name))
          .map((i) => [
            i.code || '', i.name, i.category, i.unit || 'pcs', i.quantity, i.returnable ? 'Yes' : 'No', i.lowStockThreshold, i.locationText || '',
            i.hasVariations ? (i.variations || []).filter((v) => v.active).map((v) => `${v.code} ${v.name}`).join('; ') : '', i.archived ? 'Archived' : 'In use', i.notes || '',
          ]),
      ];
    case 'availability':
      return [
        ['Item Code', 'Name', 'Category', 'Total', 'On Loan', 'Held as Damaged', 'Reserved (upcoming events)', 'Available Now', 'Unit'],
        ...activeItems().map((i) => [i.code || '', i.name, i.category, i.quantity, i.returnable ? i.quantityOnLoan || 0 : 0, i.quantityDamaged || 0, reserved(i), availableQty(i), i.unit || 'pcs']),
      ];
    case 'lowstock':
      return [
        ['Item Code', 'Name', 'Category', 'Available Now', 'Alert At', 'Total', 'Shortfall to Alert Level', 'Unit'],
        ...lowStockItems().map((i) => [i.code || '', i.name, i.category, availableQty(i), i.lowStockThreshold, i.quantity, Math.max(0, i.lowStockThreshold - availableQty(i)), i.unit || 'pcs']),
      ];
    case 'borrowing':
      return [
        ['Borrowed', 'Item', 'Design', 'Quantity', 'Borrowed By', 'Employee No', 'Email', 'Purpose / Event', 'Due Back', 'Status', 'Returned', 'Damaged', 'Missing'],
        ...allLoans
          .filter((l) => inRange(isoDay(l.loanedAt)))
          .sort((a, b) => b.loanedAt.localeCompare(a.loanedAt))
          .map((l) => [
            csvDateTime(l.loanedAt), l.itemName, designOf(l), l.quantity, l.name, l.employeeNo || '', l.email || '', l.purpose, l.expectedReturnDate || '',
            l.status === 'returned' ? 'Returned' : isOverdue(l) ? 'Overdue' : 'Out', l.quantityReturned, l.quantityDamaged || 0, l.quantityMissing || 0,
          ]),
      ];
    case 'returns': {
      const rows = [];
      allLoans.forEach((l) =>
        (l.returns || []).forEach((r) => {
          if (r.adjustment || !inRange(isoDay(r.returnedAt))) return;
          rows.push({ at: r.returnedAt, row: [csvDateTime(r.returnedAt), l.itemName, designOf(l), r.quantity - (r.damaged || 0), r.damaged || 0, r.missing || 0, r.conditionNote || r.notes || '', r.name, l.name, l.purpose, l.expectedReturnDate || '', l.expectedReturnDate && isoDay(r.returnedAt) > l.expectedReturnDate ? 'Late' : 'On time'] });
        })
      );
      rows.sort((a, b) => b.at.localeCompare(a.at));
      return [['Returned', 'Item', 'Design', 'Good', 'Damaged', 'Missing', 'Notes', 'Returned By', 'Borrower', 'Purpose / Event', 'Was Due', 'Timing'], ...rows.map((x) => x.row)];
    }
    case 'overdue':
      return [
        ['Item', 'Design', 'Not Returned', 'Borrower', 'Employee No', 'Email', 'Purpose / Event', 'Due Back', 'Days Overdue'],
        ...allLoans
          .filter(isOverdue)
          .sort((a, b) => a.expectedReturnDate.localeCompare(b.expectedReturnDate))
          .map((l) => [l.itemName, designOf(l), loanOutstanding(l), l.name, l.employeeNo || '', l.email || '', l.purpose, l.expectedReturnDate, Math.round((parseYmd(today) - parseYmd(l.expectedReturnDate)) / 86400000)]),
      ];
    case 'events':
      return [
        ['Start', 'End', 'Event', 'Category', 'Venue', 'Organiser', 'Department', 'Contact', 'Booked By', 'Items', 'Status'],
        ...allBookings
          .filter((b) => inRange(b.startDate))
          .sort((a, b) => b.startDate.localeCompare(a.startDate))
          .map((b) => [b.startDate, b.endDate, b.event, b.category || '', b.venue || '', b.organiser || '', b.department || '', b.contact || '', b.name, linesSummary(b.lines), STATE_LABEL[eventState(b)]]),
      ];
    case 'popular': {
      const tally = new Map();
      const add = (id, name, kind, qty, at) => {
        const t = tally.get(id) || { name, kind, times: 0, qty: 0, last: '' };
        t.times += 1;
        t.qty += qty;
        if (at > t.last) t.last = at;
        tally.set(id, t);
      };
      allLoans.filter((l) => inRange(isoDay(l.loanedAt))).forEach((l) => add(l.itemId, l.itemName, 'Borrowed (loanable)', l.quantity, l.loanedAt));
      reportTxns.filter((t) => t.type === 'remove' && inRange(isoDay(t.timestamp))).forEach((t) => add(t.itemId, t.itemName, 'Used (consumable)', t.quantity, t.timestamp));
      return [
        ['Rank', 'Item', 'Kind', 'Times Taken Out', 'Total Quantity', 'Last Taken Out'],
        ...[...tally.values()].sort((a, b) => b.times - a.times || b.qty - a.qty).map((t, i) => [i + 1, t.name, t.kind, t.times, t.qty, csvDateTime(t.last)]),
      ];
    }
    case 'adjustments': {
      const rows = [];
      reportTxns
        .filter((t) => t.type === 'add' && inRange(isoDay(t.timestamp)))
        .forEach((t) => rows.push({ at: t.timestamp, row: [csvDateTime(t.timestamp), t.itemName, `+${t.quantity}`, t.unusedReturn ? 'Unused items returned from an event' : 'Stock added', t.remarks || '', t.name] }));
      allLoans.forEach((l) =>
        (l.returns || []).forEach((r) => {
          if (r.missing && inRange(isoDay(r.returnedAt))) rows.push({ at: r.returnedAt, row: [csvDateTime(r.returnedAt), l.itemName, `-${r.missing}`, 'Missing on return', r.conditionNote || '', r.name] });
        })
      );
      const OUT = { written_off: ['-', 'Damaged items written off'], repaired: ['±0', 'Damaged items repaired — back in use'], found: ['+', 'Missing items found'] };
      reportReports
        .filter((r) => r.status === 'resolved' && r.outcome && inRange(isoDay(r.resolvedAt)))
        .forEach((r) => {
          if (r.type === 'missing' && r.outcome === 'written_off') return; // already counted when it went missing
          const [sign, why] = OUT[r.outcome];
          rows.push({ at: r.resolvedAt, row: [csvDateTime(r.resolvedAt), r.itemName, sign === '±0' ? '0' : `${sign}${r.quantity}`, why, r.message, ''] });
        });
      rows.sort((a, b) => b.at.localeCompare(a.at));
      return [['Date', 'Item', 'Change', 'Reason', 'Details', 'By'], ...rows.map((x) => x.row)];
    }
    case 'cancelled':
      return [
        ['Cancelled', 'Event', 'Start', 'End', 'Venue', 'Booked By', 'Cancelled By', 'Items'],
        ...allBookings
          .filter((b) => b.status === 'cancelled' && inRange(isoDay(b.cancelledAt) || b.startDate))
          .sort((a, b) => String(b.cancelledAt).localeCompare(String(a.cancelledAt)))
          .map((b) => [csvDateTime(b.cancelledAt), b.event, b.startDate, b.endDate, b.venue || '', b.name, b.cancelledBy || '', linesSummary(b.lines)]),
      ];
    default:
      return [[]];
  }
}

const REPORT_PREVIEW_ROWS = 200;

function renderReport() {
  const kind = el('rp-type').value;
  const conf = REPORTS[kind];
  el('rp-dates').hidden = !conf.dated;
  const [head, ...rows] = reportRows(kind);
  el('rp-head').innerHTML = `<tr>${head.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr>`;
  el('rp-body').innerHTML = rows.length
    ? rows
        .slice(0, REPORT_PREVIEW_ROWS)
        .map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c === null || c === undefined ? '' : c)}</td>`).join('')}</tr>`)
        .join('')
    : `<tr><td colspan="${head.length}" class="muted-cell">Nothing to show${conf.dated ? ' for these dates' : ''}.</td></tr>`;
  el('rp-summary').textContent =
    `${plural(rows.length, 'row', 'rows')}${conf.dated ? ` · ${el('rp-from').value ? fmtDate(el('rp-from').value) : 'the start'} to ${el('rp-to').value ? fmtDate(el('rp-to').value) : 'today'}` : ' · as of now'}` +
    (rows.length > REPORT_PREVIEW_ROWS ? ` · showing the first ${REPORT_PREVIEW_ROWS} here; the download has them all` : '');
}

function reportFileName(kind, ext) {
  const conf = REPORTS[kind];
  const slug = conf.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const range = conf.dated ? `-${el('rp-from').value || 'start'}-to-${el('rp-to').value || todayStr()}` : `-${todayStr()}`;
  return `vitrox-store-${slug}${range}.${ext}`;
}

function downloadXlsx(filename, sheets) {
  const bytes = window.XlsxLite.build(sheets);
  const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

el('rp-type').addEventListener('change', renderReport);
el('rp-from').addEventListener('change', renderReport);
el('rp-to').addEventListener('change', renderReport);
el('rp-csv-btn').addEventListener('click', () => {
  const kind = el('rp-type').value;
  downloadCsv(reportFileName(kind, 'csv'), reportRows(kind));
});
el('rp-xlsx-btn').addEventListener('click', () => {
  const kind = el('rp-type').value;
  downloadXlsx(reportFileName(kind, 'xlsx'), [{ name: REPORTS[kind].label, rows: reportRows(kind) }]);
});
el('rp-all-btn').addEventListener('click', () => {
  // Every report in one workbook, one sheet each.
  downloadXlsx(
    `vitrox-store-all-reports-${todayStr()}.xlsx`,
    Object.keys(REPORTS).map((kind) => ({ name: REPORTS[kind].label.replace('Most frequently borrowed / used items', 'Most borrowed or used'), rows: reportRows(kind) }))
  );
});

function initReportDates() {
  if (el('rp-from').value || el('rp-to').value) return;
  const d = new Date();
  d.setMonth(d.getMonth() - 3);
  el('rp-from').value = ymdOf(d);
  // Ahead too, so upcoming events show in the event reports.
  el('rp-to').value = addDays(todayStr(), 90);
}


// ---------- Sections: Dashboard · Inventory · Calendar · Events · Reports ----------

// Inventory first: recording a move-out is what most people come for
// (including everyone arriving from a scanned QR label).
let currentView = 'inventory';

function showView(view) {
  if (!['dashboard', 'inventory', 'calendar', 'events', 'reports'].includes(view)) view = 'inventory';
  if (view === 'reports' && !isAdminUnlocked()) view = 'inventory';
  currentView = view;
  document.querySelectorAll('.view-tab').forEach((tab) => {
    const on = tab.dataset.view === view;
    tab.classList.toggle('active', on);
    tab.setAttribute('aria-selected', String(on));
  });
  ['dashboard', 'inventory', 'calendar', 'events', 'reports'].forEach((v) => {
    el(`view-${v}`).hidden = v !== view;
  });
  if (view === 'dashboard') {
    renderDashboard();
    loadDashboardData().then(() => currentView === 'dashboard' && renderDashboard());
  }
  if (view === 'reports') {
    initReportDates();
    renderReport();
    loadReportData().then(() => currentView === 'reports' && renderReport());
  }
  if (view === 'calendar') {
    renderCalendar();
    loadEventData().then(() => currentView === 'calendar' && renderCalendar());
  }
  if (view === 'events') {
    renderEventsList();
    loadEventData().then(() => currentView === 'events' && renderEventsList());
  }
}

document.querySelectorAll('.view-tab').forEach((tab) => tab.addEventListener('click', () => showView(tab.dataset.view)));

// Bookings and loans together: events show whether their items are out or back.
async function loadEventData() {
  const [ok, loans] = await Promise.all([loadBookings(), request(API.loans)]);
  if (loans.ok) {
    allLoans = loans.data.loans || [];
    loansLoaded = true;
  }
  return ok;
}

function refreshEventViews() {
  if (currentView === 'dashboard') renderDashboard();
  if (currentView === 'reports') renderReport();
  if (currentView === 'calendar') renderCalendar();
  if (currentView === 'events') renderEventsList();
  if (!el('event-modal').hidden && shownEventId) renderEventDetail(shownEventId);
}

// ---------- Event status ----------

const EVENT_CATEGORIES = ['Open Day', 'Experience Day', 'Education Fair', 'School Exhibition', 'Talk', 'Graduation Ceremony', 'Other'];

function eventLoans(b) {
  return allLoans.filter((l) => l.bookingId === b.id || (b.checkoutId && l.checkoutId === b.checkoutId));
}

// 'event' (booked, items not yet collected) · 'active' (items out) · 'overdue'
// · 'returned' (everything back, or nothing to return) · 'cancelled' · 'missed' (never collected)
function eventState(b) {
  if (b.status === 'cancelled') return 'cancelled';
  if (b.status === 'collected') {
    const loans = eventLoans(b);
    const open = loans.filter((l) => l.status === 'open');
    if (open.length === 0) return 'returned';
    return open.some((l) => isOverdue(l)) ? 'overdue' : 'active';
  }
  if (b.endDate < todayStr()) return 'missed';
  return 'event';
}

const STATE_LABEL = {
  event: 'Booked',
  active: 'Items out',
  overdue: 'Overdue',
  returned: 'Completed',
  cancelled: 'Cancelled',
  missed: 'Not collected',
};

function eventStatusHtml(b) {
  const state = eventState(b);
  let label = STATE_LABEL[state];
  if (state === 'event') label = b.startDate <= todayStr() ? 'On now' : 'Upcoming';
  return (
    `<span class="status-pill s-${state}">${escapeHtml(label)}</span>` +
    (b.clashesAccepted && b.status === 'booked' ? ' <span class="status-pill s-overdue" title="Booked over the available stock by an admin / Store Manager">Over capacity</span>' : '')
  );
}

function canEditEvent(b) {
  return b.status === 'booked' && (ownsBooking(b) || isAdminUnlocked());
}

function linesSummary(lines) {
  return (lines || []).map((l) => `${l.itemName}${l.variationName ? ` (${l.variationName})` : ''} × ${l.quantity}`).join(', ');
}

// ---------- Events list ----------

let eventsFilter = 'upcoming';

function filteredEvents() {
  const today = todayStr();
  const term = el('events-search').value.trim().toLowerCase();
  const me = session ? session.user.email : null;
  let list = allBookings.filter((b) => {
    if (eventsFilter === 'upcoming' && !(b.status !== 'cancelled' && b.endDate >= today)) return false;
    if (eventsFilter === 'past' && !(b.status !== 'cancelled' && b.endDate < today)) return false;
    if (eventsFilter === 'cancelled' && b.status !== 'cancelled') return false;
    if (eventsFilter === 'mine' && !(me && b.email === me)) return false;
    if (!term) return true;
    return [b.event, b.category, b.venue, b.organiser, b.department, b.name, linesSummary(b.lines)].some((v) => String(v || '').toLowerCase().includes(term));
  });
  const upcomingFirst = eventsFilter === 'upcoming';
  list = list.sort((a, b) => (upcomingFirst ? a.startDate.localeCompare(b.startDate) : b.startDate.localeCompare(a.startDate)));
  return list;
}

const MONTH_SHORT = new Intl.DateTimeFormat('en-GB', { month: 'short' });

function renderEventsList() {
  document.querySelectorAll('#events-filters [data-events-filter]').forEach((chip) => {
    const on = chip.dataset.eventsFilter === eventsFilter;
    chip.classList.toggle('active', on);
    chip.setAttribute('aria-pressed', String(on));
  });
  el('events-filters').querySelector('[data-events-filter="mine"]').hidden = !session;
  const list = filteredEvents();
  const empty = el('events-empty');
  empty.hidden = list.length > 0;
  if (!bookingsLoaded) empty.textContent = 'Loading events…';
  else if (el('events-search').value.trim()) empty.textContent = 'No events match your search.';
  else empty.textContent = eventsFilter === 'upcoming' ? 'No upcoming events yet. Press “Create Event” to plan one and reserve its items.' : 'Nothing here yet.';

  el('events-list').innerHTML = list
    .map((b) => {
      const d = parseYmd(b.startDate);
      return (
        `<button type="button" class="event-card s-${eventState(b)}" data-event-id="${escapeHtml(b.id)}">` +
        `<span class="event-date"><span class="event-day">${d ? d.getDate() : ''}</span><span class="event-month">${d ? escapeHtml(MONTH_SHORT.format(d)) : ''}</span></span>` +
        `<span class="event-body">` +
        `<span class="event-title">${escapeHtml(b.event)}</span>` +
        `<span class="event-meta">${b.category ? `<span class="tag">${escapeHtml(b.category)}</span>` : ''}${eventStatusHtml(b)}</span>` +
        `<span class="event-sub">${escapeHtml(fmtRange(b.startDate, b.endDate))}${b.venue ? ` · ${escapeHtml(b.venue)}` : ''} · ${escapeHtml(b.organiser || b.name)}</span>` +
        `<span class="event-items">${(b.lines || []).length ? escapeHtml(linesSummary(b.lines)) : '<em>No items reserved yet</em>'}</span>` +
        `</span></button>`
      );
    })
    .join('');
}

el('events-list').addEventListener('click', (e) => {
  const card = e.target.closest('[data-event-id]');
  if (card) openEventDetail(card.dataset.eventId);
});
el('events-filters').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-events-filter]');
  if (!chip) return;
  eventsFilter = chip.dataset.eventsFilter;
  renderEventsList();
});
el('events-search').addEventListener('input', renderEventsList);
el('create-event-btn').addEventListener('click', () => openEventForm({}));

// ---------- Event detail ----------

let shownEventId = null;

function openEventDetail(id) {
  shownEventId = id;
  if (!renderEventDetail(id)) {
    showToast('That event no longer exists.', 'error');
    return;
  }
  openModal('event-modal');
  loadEventData().then(() => {
    if (!el('event-modal').hidden && shownEventId === id) renderEventDetail(id);
  });
}

function renderEventDetail(id) {
  const b = allBookings.find((x) => x.id === id);
  if (!b) return false;
  el('ev-d-category').textContent = b.category || 'Event';
  el('ev-d-status').innerHTML = eventStatusHtml(b);
  el('ev-d-name').textContent = b.event;
  el('ev-d-dates').textContent = fmtRange(b.startDate, b.endDate);
  const info = [
    ['Venue', b.venue],
    ['Organiser', b.organiser],
    ['Department', b.department],
    ['Contact', b.contact],
    ['Collect items on', fmtDate(b.startDate)],
    ['Return items by', fmtDate(b.endDate)],
    ['Booked by', `${b.name}${b.employeeNo ? ` (${b.employeeNo})` : ''}`],
  ].filter(([, v]) => v);
  el('ev-d-info').innerHTML = info.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`).join('');
  el('ev-d-description').textContent = [b.description, b.notes ? `Notes: ${b.notes}` : ''].filter(Boolean).join('\n\n');
  el('ev-d-description').hidden = !b.description && !b.notes;

  // Booked, collected and returned per item + design.
  const loans = eventLoans(b);
  const collected = b.collectedLines || [];
  const key = (l) => `${l.itemId}|${l.variationId || ''}`;
  const keys = [...new Set((b.lines || []).map(key).concat(collected.map(key)))];
  const rows = keys.map((k) => {
    const booked = (b.lines || []).find((l) => key(l) === k);
    const took = collected.find((l) => key(l) === k);
    const ref = booked || took;
    const itemLoans = loans.filter((l) => key(l) === k);
    const returned = itemLoans.reduce((sum, l) => sum + l.quantityReturned, 0);
    const item = items.find((i) => i.id === ref.itemId);
    const loanable = item ? item.returnable : itemLoans.length > 0;
    let back = '—';
    const damaged = itemLoans.reduce((sum, l) => sum + (l.quantityDamaged || 0), 0);
    const missing = itemLoans.reduce((sum, l) => sum + (l.quantityMissing || 0), 0);
    const unused = (b.unusedReturned || []).filter((u) => key(u) === k).reduce((sum, u) => sum + u.quantity, 0);
    if (b.status === 'collected' && took) {
      back = loanable
        ? `${returned} of ${took.quantity}${damaged ? ` (${damaged} damaged)` : ''}${missing ? ` · ${missing} missing` : ''}`
        : unused
          ? `${took.quantity - unused} used · ${unused} back unused`
          : 'Used';
    }
    return (
      `<tr><td><strong>${escapeHtml(ref.itemName)}</strong>${ref.itemCode ? ` <span class="item-code">${escapeHtml(ref.itemCode)}</span>` : ''}</td>` +
      `<td>${escapeHtml(ref.variationName || '—')}</td>` +
      `<td>${booked ? booked.quantity : '—'}</td>` +
      `<td>${took ? took.quantity : b.status === 'collected' ? '0' : '—'}</td>` +
      `<td>${escapeHtml(back)}</td></tr>`
    );
  });
  el('ev-d-lines').innerHTML = rows.length ? rows.join('') : '<tr><td colspan="5" class="muted-cell">No items reserved yet.</td></tr>';
  labelTableCells(el('ev-d-lines').closest('table'));

  const state = eventState(b);
  const open = loans.filter((l) => l.status === 'open');
  let collection = '';
  if (b.status === 'collected') {
    collection =
      `Collected ${fmtDateTime(b.collectedAt)}${b.collectedBy ? ` by ${b.collectedBy}` : ''}. ` +
      (open.length
        ? `${open.reduce((s, l) => s + loanOutstanding(l), 0)} still to be returned (due ${fmtDate(b.endDate)})${state === 'overdue' ? ' — overdue' : ''}.`
        : 'Everything has been returned.');
  } else if (b.status === 'booked') {
    collection = (b.lines || []).length
      ? `Items reserved — collect them on ${fmtDate(b.startDate)} with “Move out”, and return them by ${fmtDate(b.endDate)}.`
      : 'No items reserved yet — use Edit to add the items this event needs.';
  } else if (b.status === 'cancelled') {
    collection = `Cancelled ${fmtDateTime(b.cancelledAt)}. Its items are free for other events.`;
  }
  el('ev-d-collection').textContent = collection;

  const actions = [];
  const live = b.status === 'booked' && b.endDate >= todayStr();
  if (live && (b.lines || []).length) actions.push(`<button type="button" class="primary-btn" data-ev-action="collect">${icon('cart')} Move out (collect)</button>`);
  if (open.length) actions.push(`<button type="button" class="ghost-btn sky-btn" data-ev-action="return">${icon('return')} Return items</button>`);
  if (unusedRoom(b).length) actions.push(`<button type="button" class="ghost-btn" data-ev-action="unused">${icon('package')} Return unused</button>`);
  if (canEditEvent(b)) actions.push(`<button type="button" class="ghost-btn" data-ev-action="edit">${icon('pencil')} Edit</button>`);
  actions.push(`<button type="button" class="ghost-btn" data-ev-action="duplicate">${icon('plus')} Duplicate</button>`);
  if (canEditEvent(b)) actions.push(`<button type="button" class="ghost-btn danger-text" data-ev-action="cancel">Cancel event</button>`);
  if (isAdminUnlocked()) actions.push(`<button type="button" class="icon-btn danger-text" data-ev-action="delete" aria-label="Delete this event record" title="Delete this event record">${icon('trash')}</button>`);
  el('ev-d-actions').innerHTML = actions.join('');

  const history = (b.history || []).slice().reverse();
  el('ev-d-history').innerHTML = history.length
    ? history
        .map(
          (h) =>
            `<li><span class="muted-text">${escapeHtml(fmtDateTime(h.at))}</span> <strong>${escapeHtml(h.action[0].toUpperCase() + h.action.slice(1))}</strong>` +
            `${h.by ? ` by ${escapeHtml(h.by)}` : ''}${h.detail ? ` — ${escapeHtml(h.detail)}` : ''}</li>`
        )
        .join('')
    : `<li class="muted-text">Booked ${escapeHtml(fmtDateTime(b.createdAt))} by ${escapeHtml(b.name)}.</li>`;
  return true;
}

el('ev-d-actions').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-ev-action]');
  const b = btn && allBookings.find((x) => x.id === shownEventId);
  if (!b) return;
  const action = btn.dataset.evAction;
  if (action === 'collect') {
    closeModal('event-modal');
    collectBooking(b);
  } else if (action === 'return') {
    const open = eventLoans(b).filter((l) => l.status === 'open');
    openReturnModal(open, { origin: 'event', checkAll: true });
  } else if (action === 'unused') {
    openUnusedModal(b);
  } else if (action === 'edit') {
    openEventForm({ booking: b });
  } else if (action === 'duplicate') {
    openEventForm({ duplicateOf: b });
  } else if (action === 'cancel') {
    await cancelBooking(b, btn);
  } else if (action === 'delete') {
    requireAdminThen(() => deleteBooking(b));
  }
});

// ---------- Unused consumables back from an event ----------

PERSON_FIELDS.push({ name: 'unused-name', employeeNo: 'unused-employee-no', note: 'unused-person-note' });

// Consumables taken for the event that could still come back: [{ line, room }]
function unusedRoom(b) {
  if (b.status !== 'collected') return [];
  const key = (l) => `${l.itemId}|${l.variationId || ''}`;
  return (b.collectedLines || [])
    .filter((l) => {
      const item = items.find((i) => i.id === l.itemId);
      return item ? !item.returnable : l.returnable === false;
    })
    .map((l) => ({
      line: l,
      room: l.quantity - (b.unusedReturned || []).filter((u) => key(u) === key(l)).reduce((sum, u) => sum + u.quantity, 0),
    }))
    .filter((x) => x.room > 0);
}

let unusedFor = null;

function openUnusedModal(b) {
  unusedFor = b.id;
  el('unused-subtitle').textContent = `Leftovers from “${b.event}” go back into stock. Enter how many of each came back unused.`;
  el('unused-lines').innerHTML = unusedRoom(b)
    .map(
      ({ line, room }, i) =>
        `<div class="return-line"><span class="line-info"><strong>${escapeHtml(line.itemName)}${line.variationName ? ` (${escapeHtml(line.variationName)})` : ''}</strong>` +
        `<span class="line-meta">${line.quantity} taken · up to ${room} can come back</span></span>` +
        `<span class="stepper">` +
        `<button type="button" class="step-btn" data-step="-1" aria-label="Decrease quantity">${icon('minus')}</button>` +
        `<input type="number" inputmode="numeric" min="0" max="${room}" step="1" value="0" data-unused="${i}" data-item-id="${escapeHtml(line.itemId)}" data-variation-id="${escapeHtml(line.variationId || '')}" aria-label="${escapeHtml(line.itemName)} back unused" />` +
        `<button type="button" class="step-btn" data-step="1" aria-label="Increase quantity">${icon('plus')}</button>` +
        `</span></div>`
    )
    .join('');
  prefillPerson('unused-name', 'unused-employee-no');
  setFormError('unused-form-error', '');
  openModal('unused-modal');
}

el('unused-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const lines = [...el('unused-lines').querySelectorAll('[data-unused]')]
    .map((input) => ({ itemId: input.dataset.itemId, variationId: input.dataset.variationId || undefined, quantity: Math.max(0, Math.round(Number(input.value)) || 0) }))
    .filter((l) => l.quantity > 0);
  if (!lines.length) {
    setFormError('unused-form-error', 'Enter how many came back unused.');
    return;
  }
  withBusy(el('unused-submit-btn'), async () => {
    setFormError('unused-form-error', '');
    const body = { bookingId: unusedFor, lines, ...personFrom('unused-name', 'unused-employee-no') };
    const res = await request(`${API.checkout}?action=unused`, { method: 'POST', body });
    if (!res.ok) {
      setFormError('unused-form-error', res.error);
      return;
    }
    rememberPerson(body);
    closeModal('unused-modal');
    showToast(`${plural(lines.reduce((s, l) => s + l.quantity, 0), 'item', 'items')} put back into stock.`, 'success');
    await loadItems({ silent: true });
    await loadEventData();
    refreshEventViews();
  });
});

// ---------- Event form: create, edit, duplicate ----------

PERSON_FIELDS.push({ name: 'ev-person-name', employeeNo: 'ev-person-no', note: 'event-person-note' });

let eventFormMode = { kind: 'create' };
let eventLines = [];
let eventClashAck = null;

function setEventCategoryOptions(selected) {
  const options = EVENT_CATEGORIES.includes(selected) || !selected ? EVENT_CATEGORIES : EVENT_CATEGORIES.concat([selected]);
  el('ev-category').innerHTML =
    `<option value="">Choose…</option>` + options.map((c) => `<option value="${escapeHtml(c)}"${c === selected ? ' selected' : ''}>${escapeHtml(c)}</option>`).join('');
}

function fillAddItemPicker() {
  const byCategory = {};
  activeItems()
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach((i) => (byCategory[i.category] = byCategory[i.category] || []).push(i));
  el('ev-add-item').innerHTML =
    `<option value="">Add an item…</option>` +
    Object.keys(byCategory)
      .sort()
      .map(
        (cat) =>
          `<optgroup label="${escapeHtml(cat)}">` +
          byCategory[cat].map((i) => `<option value="${escapeHtml(i.id)}">${escapeHtml(i.name)}${i.code ? ` (${escapeHtml(i.code)})` : ''}</option>`).join('') +
          `</optgroup>`
      )
      .join('');
}

// options: { booking } edit · { duplicateOf } copy · { lines, fromCart, event } from the cart · {} new
function openEventForm(options = {}) {
  const source = options.booking || options.duplicateOf || null;
  eventFormMode = options.booking ? { kind: 'edit', id: options.booking.id } : { kind: 'create', fromCart: Boolean(options.fromCart) };
  el('event-form-title').textContent = options.booking ? `Edit ${options.booking.event}` : options.duplicateOf ? `Duplicate ${options.duplicateOf.event}` : 'Create Event';
  el('ev-name').value = source ? source.event : options.event || '';
  setEventCategoryOptions(source ? source.category || '' : '');
  el('ev-venue').value = source ? source.venue || '' : '';
  el('ev-organiser').value = source ? source.organiser || '' : session ? session.user.name : '';
  el('ev-department').value = source ? source.department || '' : '';
  el('ev-contact').value = source ? source.contact || '' : session ? session.user.email : '';
  el('ev-description').value = source ? source.description || '' : '';
  el('ev-notes').value = source ? source.notes || '' : '';
  // A copy is for a new date: the dates are left for the person to pick.
  el('ev-start').value = options.booking ? options.booking.startDate : '';
  el('ev-end').value = options.booking ? options.booking.endDate : '';
  el('ev-start').min = options.booking && options.booking.startDate < todayStr() ? options.booking.startDate : todayStr();
  el('ev-end').min = el('ev-start').value || el('ev-start').min;
  const lines = source ? source.lines || [] : options.lines || [];
  eventLines = lines
    .filter((l) => items.some((i) => i.id === l.itemId && (!i.archived || options.booking)))
    .map((l) => ({ itemId: l.itemId, variationId: l.variationId || null, quantity: l.quantity }));
  eventClashAck = null;
  el('ev-clashes').hidden = true;
  el('ev-person-row').hidden = Boolean(options.booking);
  el('ev-submit').innerHTML = `${icon('calendar')} ${options.booking ? 'Save changes' : 'Book event'}`;
  fillAddItemPicker();
  setFormError('event-form-error', '');
  syncPersonFields();
  if (options.booking) {
    // Editing keeps the person who booked it; no "who are you" boxes.
    el('event-person-note').hidden = true;
    el('ev-person-row').hidden = true;
    el('ev-person-name').disabled = true;
    el('ev-person-no').disabled = true;
  }
  renderEventLines();
  openModal('event-form-modal');
  loadEventData().then(() => !el('event-form-modal').hidden && renderEventLines());
}

// How many of an item are free on these dates, before this form's own lines.
// Mirrors the server's rule (the server checks again when saving).
function freeOnDates(item, start, end, excludeId) {
  const today = todayStr();
  const booked = allBookings
    .filter((b) => b.id !== excludeId && b.status === 'booked' && b.endDate >= today && bookingQty(b, item.id) > 0)
    .filter((b) => !item.returnable || (b.startDate <= end && b.endDate >= start))
    .reduce((sum, b) => sum + bookingQty(b, item.id), 0);
  let out = 0;
  if (item.returnable) {
    allLoans.forEach((l) => {
      if (l.itemId !== item.id || l.status !== 'open') return;
      const due = l.expectedReturnDate || '';
      if (due && due >= today && due < start) return;
      out += loanOutstanding(l);
    });
  }
  return Math.max(0, item.quantity - out - booked);
}

function renderEventLines() {
  const start = el('ev-start').value;
  const end = el('ev-end').value || start;
  const excludeId = eventFormMode.kind === 'edit' ? eventFormMode.id : null;
  const totals = {};
  eventLines.forEach((l) => (totals[l.itemId] = (totals[l.itemId] || 0) + (Number(l.quantity) || 0)));
  el('ev-lines').innerHTML = eventLines.length
    ? eventLines
        .map((l, i) => {
          const item = items.find((x) => x.id === l.itemId);
          if (!item) return '';
          const designs = activeVariations(item);
          const free = start ? freeOnDates(item, start, end, excludeId) : null;
          const short = free !== null && totals[item.id] > free;
          const hint =
            free === null
              ? `${item.quantity} ${escapeHtml(item.unit || 'pcs')} in the store — pick the dates to check availability`
              : `${free} of ${item.quantity} free on these dates`;
          return (
            `<li class="ev-line${short ? ' is-short' : ''}">` +
            `<div class="ev-line-info"><strong>${escapeHtml(item.name)}</strong>${item.code ? ` <span class="item-code">${escapeHtml(item.code)}</span>` : ''}` +
            `<span class="ev-line-hint">${hint}${short ? ` — you have ${totals[item.id]}` : ''}</span></div>` +
            (designs.length
              ? `<select data-ev-design="${i}" aria-label="Design of ${escapeHtml(item.name)}" class="${l.variationId ? '' : 'needs-choice'}"><option value="">Choose design…</option>` +
                designs.map((v) => `<option value="${escapeHtml(v.id)}"${v.id === l.variationId ? ' selected' : ''}>${escapeHtml(v.name)}</option>`).join('') +
                `</select>`
              : '<span class="ev-line-nodesign"></span>') +
            `<input type="number" inputmode="numeric" min="1" max="${item.quantity}" step="1" value="${Number(l.quantity) || 1}" data-ev-qty="${i}" aria-label="Quantity of ${escapeHtml(item.name)}" />` +
            `<button type="button" class="icon-btn danger-text" data-ev-remove="${i}" aria-label="Remove ${escapeHtml(item.name)}" title="Remove">${icon('trash')}</button>` +
            `</li>`
          );
        })
        .join('')
    : `<li class="muted-text">No items yet. You can book the event now and add items later.</li>`;
}

function resetEventClash() {
  if (!eventClashAck && el('ev-clashes').hidden) return;
  eventClashAck = null;
  el('ev-clashes').hidden = true;
  el('ev-submit').innerHTML = `${icon('calendar')} ${eventFormMode.kind === 'edit' ? 'Save changes' : 'Book event'}`;
}

el('ev-add-btn').addEventListener('click', () => {
  const id = el('ev-add-item').value;
  if (!id) {
    el('ev-add-item').focus();
    return;
  }
  const item = items.find((i) => i.id === id);
  const designs = item ? activeVariations(item) : [];
  const existing = !designs.length && eventLines.find((l) => l.itemId === id);
  if (existing) existing.quantity = Number(existing.quantity || 0) + 1;
  else eventLines.push({ itemId: id, variationId: null, quantity: 1 });
  el('ev-add-item').value = '';
  resetEventClash();
  renderEventLines();
});
el('ev-lines').addEventListener('change', (e) => {
  if (e.target.dataset.evDesign !== undefined) eventLines[Number(e.target.dataset.evDesign)].variationId = e.target.value || null;
  if (e.target.dataset.evQty !== undefined) eventLines[Number(e.target.dataset.evQty)].quantity = Math.max(1, Math.round(Number(e.target.value)) || 1);
  resetEventClash();
  renderEventLines();
});
el('ev-lines').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-ev-remove]');
  if (!btn) return;
  eventLines.splice(Number(btn.dataset.evRemove), 1);
  resetEventClash();
  renderEventLines();
});
el('event-form').addEventListener('input', (e) => {
  if (e.target.id === 'ev-start') {
    if (el('ev-end').value && el('ev-end').value < e.target.value) el('ev-end').value = e.target.value;
    el('ev-end').min = e.target.value || todayStr();
  }
  if (e.target.id === 'ev-start' || e.target.id === 'ev-end') renderEventLines();
  if (!e.target.closest('#ev-lines')) resetEventClash();
});

function showEventClashes(clashes, canOverride) {
  const box = el('ev-clashes');
  box.innerHTML =
    `<p class="clash-title">${icon('alert')}<strong>Not enough available for these dates — nothing was booked</strong></p><ul>` +
    clashes
      .map((c) => {
        const why = c.conflicts.map((x) => `${x.quantity} booked for “${x.event}” (${fmtRange(x.startDate, x.endDate)}, ${x.name})`);
        if (c.out) why.push(`${c.out} out on loan and not due back before then`);
        return (
          `<li><strong>${escapeHtml(c.itemName)}</strong>: you asked for ${c.wanted}, only ${c.available} available — short by ${c.wanted - c.available}` +
          `${why.length ? `<br><span class="muted-text">${escapeHtml(why.join('; '))}</span>` : ''}</li>`
        );
      })
      .join('') +
    `</ul><p>${
      canOverride
        ? 'Lower the quantity, remove the item or pick other dates. As an admin / Store Manager you can still press <strong>Book anyway</strong> if it has been agreed (it is logged).'
        : 'Lower the quantity, remove the item or pick other dates. If you need more, ask an admin or Store Manager.'
    }</p>`;
  box.hidden = false;
  box.scrollIntoView({ block: 'nearest' });
}

el('event-form').addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy(el('ev-submit'), async () => {
    setFormError('event-form-error', '');
    const needsDesign = eventLines.find((l) => {
      const item = items.find((i) => i.id === l.itemId);
      return item && activeVariations(item).length && !l.variationId;
    });
    if (needsDesign) {
      setFormError('event-form-error', `Choose a design for “${items.find((i) => i.id === needsDesign.itemId).name}”.`);
      return;
    }
    const editing = eventFormMode.kind === 'edit';
    const body = {
      event: el('ev-name').value,
      category: el('ev-category').value,
      venue: el('ev-venue').value,
      startDate: el('ev-start').value,
      endDate: el('ev-end').value || el('ev-start').value,
      organiser: el('ev-organiser').value,
      department: el('ev-department').value,
      contact: el('ev-contact').value,
      description: el('ev-description').value,
      notes: el('ev-notes').value,
      lines: eventLines.map((l) => ({ itemId: l.itemId, variationId: l.variationId || undefined, quantity: Number(l.quantity) || 1 })),
    };
    if (!editing) Object.assign(body, personFrom('ev-person-name', 'ev-person-no'));
    const key = JSON.stringify(body);
    const res = await request(editing ? `${API.bookings}?id=${encodeURIComponent(eventFormMode.id)}` : API.bookings, {
      method: editing ? 'PUT' : 'POST',
      body: { ...body, acceptClashes: eventClashAck === key },
    });
    if (!res.ok) {
      if (res.status === 409 && res.data.code === 'clash') {
        eventClashAck = res.data.canOverride ? key : null;
        showEventClashes(res.data.clashes || [], Boolean(res.data.canOverride));
        if (eventClashAck) el('ev-submit').innerHTML = `${icon('calendar')} Book anyway`;
        return;
      }
      setFormError('event-form-error', res.status === 0 ? 'Could not reach the store server — nothing was saved. Please try again.' : res.error);
      return;
    }
    if (!editing) rememberPerson(body);
    const saved = res.data.booking;
    if (eventFormMode.fromCart) {
      cart = [];
      cartBookingId = null;
      saveCart();
      renderGrid();
    }
    closeModal('event-form-modal');
    await loadEventData();
    showToast(
      editing ? 'Event updated.' : saved.lines.length ? `“${saved.event}” booked — its items are reserved.` : `“${saved.event}” added to the calendar.`,
      'success'
    );
    refreshEventViews();
    openEventDetail(saved.id);
  });
});

// ---------- Calendar ----------

let calMode = 'month';
let calAnchor = todayStr();
let calFilter = 'all';

const CAL_MONTH = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' });
const CAL_WEEKDAY = new Intl.DateTimeFormat('en-GB', { weekday: 'short' });

function ymdOf(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function addDays(ymd, n) {
  const d = parseYmd(ymd);
  d.setDate(d.getDate() + n);
  return ymdOf(d);
}

function isoDay(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : ymdOf(d);
}

// Everything the calendar can show, as { kind, start, end, title, sub, state, ref, mine }.
function calendarEntries() {
  const me = session ? session.user.email : null;
  const today = todayStr();
  const out = [];
  allBookings.forEach((b) => {
    const state = eventState(b);
    out.push({
      kind: 'event',
      start: b.startDate,
      end: b.endDate,
      title: b.event,
      sub: [b.venue, b.organiser || b.name].filter(Boolean).join(' · '),
      detail: linesSummary(b.lines),
      state: state === 'missed' ? 'cancelled' : state,
      ref: b.id,
      hasItems: (b.lines || []).length > 0,
      mine: Boolean(me && b.email === me),
    });
  });
  // Walk-in move-outs of loanable items (not from an event), one entry per checkout.
  const groups = new Map();
  allLoans.forEach((l) => {
    if (l.bookingId) return;
    const key = l.checkoutId || l.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(l);
  });
  groups.forEach((loans, key) => {
    const first = loans[0];
    const open = loans.filter((l) => l.status === 'open');
    const mine = Boolean(me && first.email === me);
    if (open.length) {
      const due = open.map((l) => l.expectedReturnDate || today).sort().slice(-1)[0];
      out.push({
        kind: 'loan',
        start: isoDay(first.loanedAt) || today,
        end: due < isoDay(first.loanedAt) ? isoDay(first.loanedAt) : due,
        title: first.purpose || 'Borrowed',
        sub: first.name,
        detail: open.map((l) => `${l.itemName}${l.variationName ? ` (${l.variationName})` : ''} × ${loanOutstanding(l)}`).join(', '),
        state: open.some((l) => isOverdue(l)) ? 'overdue' : 'active',
        ref: key,
        purpose: first.purpose,
        mine,
      });
    }
    const byDay = new Map();
    loans.forEach((l) =>
      (l.returns || []).forEach((r) => {
        if (r.adjustment) return;
        const day = isoDay(r.returnedAt);
        if (!byDay.has(day)) byDay.set(day, []);
        byDay.get(day).push(`${l.itemName} × ${r.quantity}`);
      })
    );
    byDay.forEach((what, day) =>
      out.push({ kind: 'return', start: day, end: day, title: `Returned: ${first.purpose || 'items'}`, sub: first.name, detail: what.join(', '), state: 'returned', ref: key, purpose: first.purpose, mine })
    );
  });
  // Returns for event items show on the day they came back.
  allBookings.forEach((b) => {
    if (b.status !== 'collected') return;
    const byDay = new Map();
    eventLoans(b).forEach((l) =>
      (l.returns || []).forEach((r) => {
        if (r.adjustment) return;
        const day = isoDay(r.returnedAt);
        if (!byDay.has(day)) byDay.set(day, []);
        byDay.get(day).push(`${l.itemName} × ${r.quantity}`);
      })
    );
    byDay.forEach((what, day) =>
      out.push({ kind: 'return', start: day, end: day, title: `Returned: ${b.event}`, sub: b.name, detail: what.join(', '), state: 'returned', ref: b.id, event: true, mine: Boolean(me && b.email === me) })
    );
  });
  return out.filter((e) => e.start && e.end).filter(calFilterMatch).sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
}

function calFilterMatch(e) {
  switch (calFilter) {
    case 'events':
      return e.kind === 'event';
    case 'bookings':
      return e.kind === 'event' && e.hasItems && e.state !== 'cancelled';
    case 'borrowings':
      return (e.kind === 'loan' || e.kind === 'event') && (e.state === 'active' || e.state === 'overdue');
    case 'returns':
      return e.kind === 'return';
    case 'mine':
      return e.mine;
    default:
      return true;
  }
}

function entryButton(e, { long = false } = {}) {
  const label = long
    ? `<strong>${escapeHtml(e.title)}</strong><span class="cal-entry-sub">${escapeHtml(e.kind === 'event' ? fmtRange(e.start, e.end) : e.kind === 'loan' ? `Out ${fmtRange(e.start, e.end)}` : fmtDate(e.start))}${e.sub ? ` · ${escapeHtml(e.sub)}` : ''}</span>${e.detail ? `<span class="cal-entry-sub">${escapeHtml(e.detail)}</span>` : ''}`
    : escapeHtml(e.title);
  return (
    `<button type="button" class="cal-entry s-${e.state}${long ? ' is-long' : ''}" data-cal-kind="${e.kind}" data-cal-ref="${escapeHtml(e.ref)}"` +
    `${e.event ? ' data-cal-event="1"' : ''} data-cal-purpose="${escapeHtml(e.purpose || '')}" title="${escapeHtml(`${e.title}${e.sub ? ` — ${e.sub}` : ''}${e.detail ? `\n${e.detail}` : ''}`)}">${label}</button>`
  );
}

function renderCalendar() {
  document.querySelectorAll('#cal-modes [data-cal-mode]').forEach((b) => {
    const on = b.dataset.calMode === calMode;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
  document.querySelectorAll('#cal-filters [data-cal-filter]').forEach((b) => {
    const on = b.dataset.calFilter === calFilter;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
  el('cal-filters').querySelector('[data-cal-filter="mine"]').hidden = !session;
  const entries = calendarEntries();
  const onDay = (day) => entries.filter((e) => e.start <= day && e.end >= day);
  const today = todayStr();
  const anchor = parseYmd(calAnchor);
  const body = el('cal-body');

  if (calMode === 'month') {
    el('cal-title').textContent = CAL_MONTH.format(anchor);
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const startOffset = (first.getDay() + 6) % 7; // weeks start on Monday
    const gridStart = ymdOf(new Date(first.getFullYear(), first.getMonth(), 1 - startOffset));
    let html = '<div class="cal-month"><div class="cal-weekdays">' + ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `<span>${d}</span>`).join('') + '</div><div class="cal-grid">';
    for (let i = 0; i < 42; i++) {
      const day = addDays(gridStart, i);
      const d = parseYmd(day);
      const list = onDay(day);
      const outside = d.getMonth() !== anchor.getMonth();
      html +=
        `<div class="cal-cell${outside ? ' is-outside' : ''}${day === today ? ' is-today' : ''}">` +
        `<button type="button" class="cal-daynum" data-cal-day="${day}" aria-label="${escapeHtml(fmtDate(day))}: ${plural(list.length, 'entry', 'entries')}">${d.getDate()}</button>` +
        list.slice(0, 3).map((e) => entryButton(e)).join('') +
        (list.length > 3 ? `<button type="button" class="cal-more" data-cal-day="${day}">+${list.length - 3} more</button>` : '') +
        `</div>`;
    }
    body.innerHTML = html + '</div></div>';
  } else if (calMode === 'week') {
    const offset = (anchor.getDay() + 6) % 7;
    const weekStart = addDays(calAnchor, -offset);
    el('cal-title').textContent = `Week of ${fmtDate(weekStart)}`;
    let html = '<div class="cal-week">';
    for (let i = 0; i < 7; i++) {
      const day = addDays(weekStart, i);
      const list = onDay(day);
      html +=
        `<div class="cal-week-day${day === today ? ' is-today' : ''}"><button type="button" class="cal-week-head" data-cal-day="${day}">${escapeHtml(CAL_WEEKDAY.format(parseYmd(day)))} <strong>${parseYmd(day).getDate()}</strong></button>` +
        (list.length ? list.map((e) => entryButton(e)).join('') : '<span class="muted-text cal-none">—</span>') +
        `</div>`;
    }
    body.innerHTML = html + '</div>';
  } else if (calMode === 'day') {
    el('cal-title').textContent = `${CAL_WEEKDAY.format(anchor)}, ${fmtDate(calAnchor)}`;
    const list = onDay(calAnchor);
    body.innerHTML = list.length
      ? `<div class="cal-list">${list.map((e) => entryButton(e, { long: true })).join('')}</div>`
      : '<p class="empty-state">Nothing on this day.</p>';
  } else {
    const until = addDays(calAnchor, 60);
    el('cal-title').textContent = `${fmtDate(calAnchor)} – ${fmtDate(until)}`;
    const list = entries.filter((e) => e.end >= calAnchor && e.start <= until);
    const byDay = new Map();
    list.forEach((e) => {
      const day = e.start < calAnchor ? calAnchor : e.start;
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(e);
    });
    const days = [...byDay.keys()].sort();
    body.innerHTML = days.length
      ? `<div class="cal-agenda">${days
          .map(
            (day) =>
              `<section><h3 class="cal-agenda-day${day === today ? ' is-today' : ''}">${escapeHtml(CAL_WEEKDAY.format(parseYmd(day)))}, ${escapeHtml(fmtDate(day))}</h3>` +
              `<div class="cal-list">${byDay.get(day).map((e) => entryButton(e, { long: true })).join('')}</div></section>`
          )
          .join('')}</div>`
      : '<p class="empty-state">Nothing in the next 60 days.</p>';
  }
}

function moveCalendar(step) {
  const d = parseYmd(calAnchor);
  if (calMode === 'month') d.setMonth(d.getMonth() + step, 1);
  else if (calMode === 'week') d.setDate(d.getDate() + 7 * step);
  else if (calMode === 'day') d.setDate(d.getDate() + step);
  else d.setDate(d.getDate() + 30 * step);
  calAnchor = ymdOf(d);
  renderCalendar();
}

el('cal-prev').addEventListener('click', () => moveCalendar(-1));
el('cal-next').addEventListener('click', () => moveCalendar(1));
el('cal-today').addEventListener('click', () => {
  calAnchor = todayStr();
  renderCalendar();
});
el('cal-modes').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cal-mode]');
  if (!b) return;
  calMode = b.dataset.calMode;
  renderCalendar();
});
el('cal-filters').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cal-filter]');
  if (!b) return;
  calFilter = b.dataset.calFilter;
  renderCalendar();
});
el('cal-body').addEventListener('click', (e) => {
  const day = e.target.closest('[data-cal-day]');
  if (day) {
    calAnchor = day.dataset.calDay;
    calMode = 'day';
    renderCalendar();
    return;
  }
  const entry = e.target.closest('[data-cal-ref]');
  if (!entry) return;
  if (entry.dataset.calKind === 'event' || entry.dataset.calEvent) {
    openEventDetail(entry.dataset.calRef);
    return;
  }
  // A walk-in loan or return: open Loans & Returns on it.
  loansSearch = entry.dataset.calPurpose || '';
  el('loans-search').value = loansSearch;
  openLoansPanel(entry.dataset.calKind === 'return' ? 'all' : 'open');
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
      'Use this only for a mistake or a test. To tidy up old history without changing stock, use Clear History in the admin tools instead.',
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
    const ahead =
      lastRun && lastRun.collectionsTomorrow !== undefined
        ? ` Day-ahead: ${plural(lastRun.collectionEmails || 0, 'collection reminder', 'collection reminders')}, ${plural(lastRun.dueTomorrowEmails || 0, '“due tomorrow” email', '“due tomorrow” emails')}.`
        : '';
    status =
      `<strong>${icon('bell')} Reminder emails are on.</strong> ` +
      `Every day at 9:00 am: people with overdue items are emailed (again every ${escapeHtml(everyDays)} days until returned); ` +
      `bookers are reminded the day before their event to collect; borrowers get a “due back tomorrow” note; the admin gets summaries. ` +
      `Bookings also send a confirmation, and a booker is told if someone else cancels their event. ${last}${ahead}`;
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
      const kind = r.type === 'damage' ? `${icon('flag')} Damaged` : r.type === 'missing' ? `${icon('alert')} Missing` : `${icon('package')} Restock request`;
      const OUTCOME = { repaired: 'Repaired', written_off: 'Written off', found: 'Found' };
      const qty = r.quantity ? ` · quantity affected: ${escapeHtml(r.quantity)}` : '';
      const resolved = r.status === 'resolved';
      const state = resolved
        ? ` <span class="qty-pill ok">${r.outcome ? OUTCOME[r.outcome] : 'Resolved'}${r.resolvedAt ? ' ' + escapeHtml(fmtDay(r.resolvedAt)) : ''}</span>`
        : r.held
          ? ' <span class="qty-pill low">Held out of use</span>'
          : '';
      const stockMoved = resolved && r.outcome && (r.held || r.type === 'missing');
      const resolveButtons = r.held
        ? `<button type="button" class="ghost-btn" data-resolve="${escapeHtml(r.id)}" data-outcome="repaired">${icon('check')} Repaired</button>` +
          `<button type="button" class="ghost-btn danger-text" data-resolve="${escapeHtml(r.id)}" data-outcome="written_off">Write off</button>`
        : r.type === 'missing'
          ? `<button type="button" class="ghost-btn" data-resolve="${escapeHtml(r.id)}" data-outcome="found">${icon('check')} Found</button>` +
            `<button type="button" class="ghost-btn danger-text" data-resolve="${escapeHtml(r.id)}" data-outcome="written_off">Written off</button>`
          : `<button type="button" class="ghost-btn" data-resolve="${escapeHtml(r.id)}">${icon('check')} Resolve</button>`;
      const actions = admin
        ? `<div class="row-actions">` +
          (resolved
            ? stockMoved
              ? ''
              : `<button type="button" class="ghost-btn" data-reopen="${escapeHtml(r.id)}">${icon('refresh')} Reopen</button>`
            : resolveButtons) +
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
  if (resolveBtn) withBusy(resolveBtn, () => setReportStatus(resolveBtn.dataset.resolve, 'resolved', resolveBtn.dataset.outcome));
  else if (reopenBtn) withBusy(reopenBtn, () => setReportStatus(reopenBtn.dataset.reopen, 'open'));
  else if (deleteBtn) requireAdminThen(() => deleteReport(deleteBtn.dataset.reportDelete));
});

function setReportStatus(id, status, outcome) {
  return new Promise((done) => {
    if (!isAdminUnlocked()) done();
    requireAdminThen(async () => {
      if (outcome === 'written_off') {
        const ok = await confirmDialog({
          title: 'Write these items off?',
          message: 'They come off the item’s total for good (the history is kept).',
          confirmLabel: 'Write off',
        });
        if (!ok) {
          done();
          return;
        }
      }
      const res = await request(`${API.reports}?id=${encodeURIComponent(id)}`, {
        method: 'PATCH',
        admin: true,
        body: outcome ? { status, outcome } : { status },
      });
      const said = { repaired: 'Marked repaired — back in use.', written_off: 'Written off.', found: 'Marked found — back in stock.' };
      if (!res.ok) showToast(res.error, 'error');
      else showToast(status === 'resolved' ? said[outcome] || 'Report resolved.' : 'Report reopened.', 'success');
      done();
      if (res.ok) {
        loadReportsBadge();
        openReportsPanel();
        if (outcome) loadItems({ silent: true });
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
  el('form-code').value = item ? item.code || '' : '';
  formVariations = item && Array.isArray(item.variations) ? item.variations.map((v) => ({ ...v })) : [];
  el('form-has-variations').checked = Boolean(item && item.hasVariations);
  renderVariationRows();
  el('form-variations').hidden = !el('form-has-variations').checked;
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
      code: el('form-code').value,
      category: el('form-category').value,
      hasVariations: el('form-has-variations').checked,
      variations: formVariations.map((v) => ({ id: v.id || undefined, code: v.code, name: v.name, active: v.active !== false })),
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
    bookings: el('cleanup-bookings').checked,
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
  ['cleanup-activity', 'cleanup-loans', 'cleanup-reports', 'cleanup-bookings'].forEach((id) => (el(id).checked = true));
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
      const total = n.activity + n.loans + n.reports + (n.bookings || 0);
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
      if (body.bookings) parts.push(plural(n.bookings || 0, 'past booking', 'past bookings'));
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
    showToast(`Cleared ${plural(n.activity + n.loans + n.reports + (n.bookings || 0), 'record', 'records')}.`, 'success');
    loadBookings();
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

// ---------- Admin: activity log ----------

let auditEntries = [];
let auditMonth = '';
let auditLoadSeq = 0;

// "2026-11" -> "November 2026"
function monthLabel(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(ym || '');
  if (!m) return ym || '';
  return new Date(Number(m[1]), Number(m[2]) - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function auditWho(entry) {
  if (entry.via === 'system') return 'System (automatic update)';
  if (entry.via === 'password') {
    return entry.email ? `${entry.name || entry.email} (with the admin password)` : 'Someone with the admin password';
  }
  return entry.name || entry.email || 'Unknown';
}

function renderAudit() {
  const list = el('audit-list');
  const q = el('audit-search').value.trim().toLowerCase();
  const shown = q
    ? auditEntries.filter((e) => [e.summary, e.name, e.email, e.action].join(' ').toLowerCase().includes(q))
    : auditEntries;
  if (shown.length === 0) {
    list.innerHTML = `<p class="muted-text">${auditEntries.length ? 'No changes match that search.' : `No admin changes in ${escapeHtml(monthLabel(auditMonth))}.`}</p>`;
    return;
  }
  list.innerHTML = shown
    .map(
      (e) =>
        `<div class="audit-row">` +
        `<div class="audit-meta"><strong title="${escapeHtml(e.email || '')}">${escapeHtml(auditWho(e))}</strong>` +
        `<span>${escapeHtml(fmtDateTime(e.at))}</span></div>` +
        `<p>${escapeHtml(e.summary)}</p>` +
        `</div>`
    )
    .join('');
}

async function loadAudit(month) {
  const seq = ++auditLoadSeq;
  el('audit-list').innerHTML = '<p class="muted-text">Loading…</p>';
  const res = await request(`${API.admin}?action=log${month ? `&month=${encodeURIComponent(month)}` : ''}`, { admin: true });
  if (seq !== auditLoadSeq) return;
  if (!res.ok) {
    el('audit-list').innerHTML = `<p class="error-text">${escapeHtml(res.error)}</p>`;
    return;
  }
  auditEntries = Array.isArray(res.data.entries) ? res.data.entries : [];
  auditMonth = res.data.month;
  el('audit-month').innerHTML = (res.data.months || [auditMonth])
    .map((m) => `<option value="${escapeHtml(m)}"${m === auditMonth ? ' selected' : ''}>${escapeHtml(monthLabel(m))}</option>`)
    .join('');
  renderAudit();
}

function openAuditModal() {
  el('audit-search').value = '';
  auditEntries = [];
  openModal('audit-modal');
  loadAudit('');
}

el('audit-btn').addEventListener('click', () => requireAdminThen(openAuditModal));
el('audit-month').addEventListener('change', (e) => loadAudit(e.target.value));
el('audit-search').addEventListener('input', renderAudit);

// ---------- Admin: who the admins and Store Managers are ----------

let adminRows = [];
let managerRows = [];
let adminYou = null;

const ROLE_LISTS = {
  admin: { rows: () => adminRows, list: 'admins-list', input: 'admin-new', label: 'admin' },
  manager: { rows: () => managerRows, list: 'managers-list', input: 'manager-new', label: 'Store Manager' },
};

function renderRoleRows(kind) {
  const conf = ROLE_LISTS[kind];
  const rows = conf.rows();
  const lastAdmin = kind === 'admin' && rows.length === 1;
  el(conf.list).innerHTML = rows.length
    ? rows
        .map(
          (email, i) =>
            `<li class="category-row">` +
            `<span class="admin-email">${escapeHtml(email)}${email === adminYou ? ' <span class="category-count">you</span>' : ''}</span>` +
            `<button type="button" class="icon-btn danger-text" data-role-kind="${kind}" data-role-remove="${i}" ${lastAdmin ? 'disabled' : ''} ` +
            `aria-label="Remove ${escapeHtml(email)}" title="${lastAdmin ? 'Keep at least one admin' : 'Remove'}">${icon('trash')}</button>` +
            `</li>`
        )
        .join('')
    : `<li class="muted-text">${kind === 'manager' ? 'No Store Managers yet.' : ''}</li>`;
}

function renderAdminRows() {
  renderRoleRows('admin');
  renderRoleRows('manager');
}

async function openAdminsModal() {
  setFormError('admins-form-error', '');
  el('admin-new').value = '';
  el('manager-new').value = '';
  el('admins-list').innerHTML = '<li class="muted-text">Loading…</li>';
  el('managers-list').innerHTML = '';
  openModal('admins-modal');
  const res = await request(`${API.admin}?action=admins`, { admin: true });
  if (!res.ok) {
    el('admins-list').innerHTML = '';
    setFormError('admins-form-error', res.error);
    return;
  }
  adminRows = res.data.admins.slice();
  managerRows = (res.data.managers || []).slice();
  adminYou = res.data.you;
  renderAdminRows();
}

// Adds what is typed in that list's box. Returns false (with a message) if it can't.
function addRoleRow(kind) {
  const conf = ROLE_LISTS[kind];
  const email = el(conf.input).value.trim().toLowerCase();
  if (!email) return true;
  if (!/^[^\s@]+@vitrox\.com$/.test(email)) {
    setFormError('admins-form-error', 'Enter a ViTrox email address (ending in @vitrox.com).');
    return false;
  }
  if (adminRows.includes(email) || managerRows.includes(email)) {
    setFormError('admins-form-error', `${email} is already ${adminRows.includes(email) ? 'an admin' : 'a Store Manager'}.`);
    return false;
  }
  setFormError('admins-form-error', '');
  conf.rows().push(email);
  el(conf.input).value = '';
  renderAdminRows();
  return true;
}

function addAdminRow() {
  addRoleRow('admin');
}

el('admins-form').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-role-remove]');
  if (!btn || btn.disabled) return;
  ROLE_LISTS[btn.dataset.roleKind].rows().splice(Number(btn.dataset.roleRemove), 1);
  renderAdminRows();
});
el('admin-add-btn').addEventListener('click', () => addRoleRow('admin'));
el('manager-add-btn').addEventListener('click', () => addRoleRow('manager'));
['admin', 'manager'].forEach((kind) => {
  el(ROLE_LISTS[kind].input).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addRoleRow(kind);
    }
  });
});

el('admins-form').addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy(submitButton(e.currentTarget), async () => {
    setFormError('admins-form-error', '');
    // Addresses typed but not yet added with the Add buttons still count.
    if (!addRoleRow('admin') || !addRoleRow('manager')) return;
    if (adminYou && !adminRows.includes(adminYou) && !managerRows.includes(adminYou)) {
      const ok = await confirmDialog({
        title: 'Remove yourself as admin?',
        message: 'Your ViTrox account will no longer unlock the admin tools. You can still get in with the admin password.',
        confirmLabel: 'Remove me',
      });
      if (!ok) return;
    }
    const res = await request(`${API.admin}?action=admins`, { method: 'POST', admin: true, body: { admins: adminRows, managers: managerRows } });
    if (!res.ok) {
      setFormError('admins-form-error', res.error);
      return;
    }
    closeModal('admins-modal');
    showToast('Admins and Store Managers saved.', 'success');
    // Picks up this account's own role straight away.
    if (session && res.data.you) {
      const role = res.data.admins.includes(res.data.you) ? 'admin' : (res.data.managers || []).includes(res.data.you) ? 'manager' : null;
      if (role !== (session.user.role || null) || Boolean(role) !== Boolean(session.user.isAdmin)) {
        setSession({ token: session.token, user: { ...session.user, role, isAdmin: Boolean(role) } });
      }
    }
  });
});

el('manage-admins-btn').addEventListener('click', () => requireAdminThen(openAdminsModal));

// ---------- Design variations, on-screen QR, archive ----------

function renderVariationChips(item) {
  const all = Array.isArray(item.variations) ? item.variations : [];
  const shown = isAdminUnlocked() ? all : all.filter((v) => v.active);
  if (!item.hasVariations || shown.length === 0) return '';
  return (
    `<p class="detail-variations-title"><strong>Design variations</strong> <span class="muted-text">— all share the ${item.quantity} ${escapeHtml(item.unit || 'pcs')} above</span></p>` +
    `<ul class="variation-chips">` +
    shown
      .map(
        (v) =>
          `<li class="variation-chip${v.active ? '' : ' is-inactive'}"><span class="variation-code">${escapeHtml(v.code)}</span> ${escapeHtml(v.name)}` +
          `${v.active ? '' : ' <span class="muted-text">(inactive)</span>'}</li>`
      )
      .join('') +
    `</ul>`
  );
}

function hideDetailQr() {
  const box = el('detail-qr');
  box.hidden = true;
  box.innerHTML = '';
  box.dataset.itemId = '';
  el('detail-qr-btn').setAttribute('aria-expanded', 'false');
}

// Anyone can show an item's QR code on screen, e.g. to scan it with another phone.
el('detail-qr-btn').addEventListener('click', async () => {
  const box = el('detail-qr');
  if (!box.hidden) {
    hideDetailQr();
    return;
  }
  const item = items.find((i) => i.id === selectedItemId);
  if (!item) return;
  try {
    await loadQrLib();
  } catch (err) {
    showToast(err.message, 'error');
    return;
  }
  const url = itemLabelUrl(item);
  box.innerHTML =
    `<div class="detail-qr-code">${qrSvg(url)}</div>` +
    `<div class="detail-qr-text"><strong>${escapeHtml(item.name)}</strong>${item.code ? ` <span class="item-code">${escapeHtml(item.code)}</span>` : ''}` +
    `<p class="muted-text">Scan with a phone camera to open this item in the store.</p>` +
    `<button type="button" class="link-btn" id="detail-qr-copy">Copy link</button></div>`;
  box.dataset.itemId = item.id;
  box.hidden = false;
  el('detail-qr-btn').setAttribute('aria-expanded', 'true');
});

el('detail-qr').addEventListener('click', async (e) => {
  if (!e.target.closest('#detail-qr-copy')) return;
  const item = items.find((i) => i.id === selectedItemId);
  if (!item) return;
  try {
    await navigator.clipboard.writeText(itemLabelUrl(item));
    showToast('Link copied.', 'success');
  } catch {
    showToast(itemLabelUrl(item), '', 8000);
  }
});

el('detail-archive-btn').addEventListener('click', () => {
  requireAdminThen(async () => {
    const item = items.find((i) => i.id === selectedItemId);
    if (!item) return;
    const archiving = !item.archived;
    const ok = await confirmDialog(
      archiving
        ? {
            title: `Archive “${item.name}”?`,
            message:
              'It disappears from the store and can no longer be moved out or booked, but its history stays. You can restore it any time (Show archived, next to the item count).',
            confirmLabel: 'Archive item',
          }
        : { title: `Restore “${item.name}”?`, message: 'It comes back into the store for moving out and booking.', confirmLabel: 'Restore item', danger: false }
    );
    if (!ok) return;
    const res = await request(`${API.items}?id=${encodeURIComponent(item.id)}`, { method: 'PUT', admin: true, body: { archived: archiving } });
    if (!res.ok) {
      showToast(res.error, 'error', 8000);
      return;
    }
    showToast(archiving ? `“${item.name}” archived.` : `“${item.name}” restored.`, 'success');
    if (archiving) closeModal('detail-modal');
    await loadItems({ silent: true });
  });
});

el('archived-toggle').addEventListener('click', () => {
  showArchived = !showArchived;
  activeCategory = 'All';
  renderCategoryChips();
  renderGrid();
});

// ----- Variations editor in the item form -----

let formVariations = [];

function renderVariationRows() {
  el('form-variation-list').innerHTML = formVariations
    .map(
      (v, i) =>
        `<li class="variation-row">` +
        `<input type="text" maxlength="20" value="${escapeHtml(v.code)}" data-var-field="code" data-var-index="${i}" aria-label="Variation code" placeholder="ENG" />` +
        `<input type="text" maxlength="60" value="${escapeHtml(v.name)}" data-var-field="name" data-var-index="${i}" aria-label="Variation name" placeholder="Engineering Programme" />` +
        `<label class="variation-active" title="Active"><input type="checkbox" data-var-field="active" data-var-index="${i}"${v.active ? ' checked' : ''} /> <span class="sr-only">Active</span></label>` +
        `<button type="button" class="icon-btn danger-text" data-var-remove="${i}" aria-label="Remove this variation" title="Remove">${icon('trash')}</button>` +
        `</li>`
    )
    .join('');
}

function syncVariationsVisible() {
  const on = el('form-has-variations').checked;
  el('form-variations').hidden = !on;
  if (on && formVariations.length === 0) {
    formVariations.push({ id: null, code: '', name: '', active: true });
    renderVariationRows();
  }
}

el('form-has-variations').addEventListener('change', syncVariationsVisible);
el('form-variation-add').addEventListener('click', () => {
  formVariations.push({ id: null, code: '', name: '', active: true });
  renderVariationRows();
  const inputs = el('form-variation-list').querySelectorAll('[data-var-field="code"]');
  if (inputs.length) inputs[inputs.length - 1].focus();
});
el('form-variation-list').addEventListener('input', (e) => {
  const i = e.target.dataset.varIndex;
  if (i === undefined) return;
  const field = e.target.dataset.varField;
  formVariations[Number(i)][field] = field === 'active' ? e.target.checked : e.target.value;
});
el('form-variation-list').addEventListener('change', (e) => {
  if (e.target.dataset.varField === 'active') formVariations[Number(e.target.dataset.varIndex)].active = e.target.checked;
});
el('form-variation-list').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-var-remove]');
  if (!btn) return;
  formVariations.splice(Number(btn.dataset.varRemove), 1);
  renderVariationRows();
});

// ---------- QR labels ----------
//
// A label is a QR code holding a link to this page with ?item=<id> (one item)
// or ?loc=<storage location> (a shelf). Scanning it with a phone camera opens
// the store at that item, or lists what is kept on that shelf.

const LABEL_SIZES = {
  std: { perPage: 21, name: 'Standard' },
  lg: { perPage: 8, name: 'Large' },
};
const MAX_LABELS = 600;

let qrLibPromise = null;

// The QR library (store/vendor/qrcode.js) is only fetched when labels are made.
function loadQrLib() {
  if (window.qrcode) return Promise.resolve(window.qrcode);
  if (!qrLibPromise) {
    qrLibPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'vendor/qrcode.js';
      script.onload = () => (window.qrcode ? resolve(window.qrcode) : reject(new Error('QR library did not load')));
      script.onerror = () => {
        qrLibPromise = null;
        reject(new Error('Could not load the QR code maker — check your connection and try again.'));
      };
      document.head.appendChild(script);
    });
  }
  return qrLibPromise;
}

function pageBaseUrl() {
  return location.href.split(/[?#]/)[0];
}

function itemLabelUrl(item) {
  return `${pageBaseUrl()}?item=${encodeURIComponent(item.id)}`;
}

function locationLabelUrl(loc) {
  return `${pageBaseUrl()}?loc=${encodeURIComponent(loc)}`;
}

function qrSvg(text) {
  const qr = window.qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 1, margin: 2, scalable: true });
}

// Distinct storage locations (as typed on items), with how many items each has.
function storageLocations() {
  const byKey = new Map();
  activeItems().forEach((item) => {
    const loc = String(item.locationText || '').trim().replace(/\s+/g, ' ');
    if (!loc) return;
    const key = loc.toLowerCase();
    if (!byKey.has(key)) byKey.set(key, { loc, count: 0 });
    byKey.get(key).count++;
  });
  return [...byKey.values()].sort((a, b) => a.loc.localeCompare(b.loc));
}

// Everything that can be printed for the chosen kind: [{ key, title, subs, url, search }]
function labelChoices(kind) {
  if (kind === 'loc') {
    return storageLocations().map(({ loc, count }) => ({
      key: `loc:${loc.toLowerCase()}`,
      title: loc,
      subs: [`${plural(count, 'item', 'items')} kept here`],
      url: locationLabelUrl(loc),
      search: loc,
    }));
  }
  return activeItems()
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name))
    .map((item) => ({
      key: `item:${item.id}`,
      title: item.name,
      subs: [
        [item.code, item.category].filter(Boolean).join(' · '),
        activeVariations(item).length ? `${plural(activeVariations(item).length, 'design', 'designs')}` : '',
        item.locationText ? `Location: ${item.locationText}` : '',
      ].filter(Boolean),
      url: itemLabelUrl(item),
      search: `${item.name} ${item.code || ''} ${item.category} ${item.locationText || ''}`,
    }));
}

const labelPicks = new Set();

function labelKind() {
  const checked = document.querySelector('input[name="labels-kind"]:checked');
  return checked ? checked.value : 'item';
}

function labelHtml(choice) {
  return (
    `<div class="qr-label">` +
    `<div class="qr-code">${qrSvg(choice.url)}</div>` +
    `<div class="qr-text"><strong>${escapeHtml(choice.title)}</strong>` +
    choice.subs.map((s) => `<span class="qr-sub">${escapeHtml(s)}</span>`).join('') +
    `<span class="qr-brand">ViTrox College Store · scan to open</span></div>` +
    `</div>`
  );
}

function pickedChoices() {
  return labelChoices(labelKind()).filter((c) => labelPicks.has(c.key));
}

function labelCopies() {
  return Math.min(50, Math.max(1, Math.round(Number(el('labels-copies').value)) || 1));
}

function renderLabelList() {
  const q = el('labels-filter').value.trim().toLowerCase();
  const choices = labelChoices(labelKind());
  if (choices.length === 0) {
    el('labels-list').innerHTML = `<li class="muted-text">${
      labelKind() === 'loc' ? 'No storage locations yet. Add a location to items (Edit → Location) to print shelf labels.' : 'No items yet.'
    }</li>`;
  } else {
    el('labels-list').innerHTML = choices
      .map(
        (c) =>
          `<li${q && !c.search.toLowerCase().includes(q) ? ' hidden' : ''}><label class="checkbox-label">` +
          `<input type="checkbox" data-label-key="${escapeHtml(c.key)}"${labelPicks.has(c.key) ? ' checked' : ''} /> ` +
          `<span><strong>${escapeHtml(c.title)}</strong> <span class="muted-text">${escapeHtml(c.subs.join(' · '))}</span></span>` +
          `</label></li>`
      )
      .join('');
  }
  renderLabelSummary();
}

async function renderLabelSummary() {
  const picked = pickedChoices();
  const size = LABEL_SIZES[el('labels-size').value] || LABEL_SIZES.std;
  const total = picked.length * labelCopies();
  const sheets = Math.ceil(total / size.perPage);
  el('labels-summary').textContent = total
    ? `${plural(total, 'label', 'labels')} on ${plural(sheets, 'A4 sheet', 'A4 sheets')}.`
    : 'Tick at least one to print.';
  el('labels-print-btn').disabled = total === 0 || total > MAX_LABELS;
  if (total > MAX_LABELS) el('labels-summary').textContent += ` That is more than ${MAX_LABELS} at once — print in smaller batches.`;

  const preview = el('labels-preview');
  preview.className = `labels-preview size-${el('labels-size').value}`;
  if (!picked.length) {
    preview.innerHTML = '';
    return;
  }
  try {
    await loadQrLib();
  } catch (err) {
    preview.innerHTML = `<p class="error-text">${escapeHtml(err.message)}</p>`;
    return;
  }
  const first = pickedChoices()[0];
  preview.innerHTML = first ? labelHtml(first) : '';
}

// options: { itemIds } to start with just those items ticked.
function openLabelsModal(options = {}) {
  labelPicks.clear();
  document.querySelector('input[name="labels-kind"][value="item"]').checked = true;
  el('labels-filter').value = '';
  el('labels-copies').value = '1';
  setFormError('labels-form-error', '');
  const startWith = options.itemIds ? options.itemIds : activeItems().map((i) => i.id);
  startWith.forEach((id) => labelPicks.add(`item:${id}`));
  openModal('labels-modal');
  renderLabelList();
}

el('labels-list').addEventListener('change', (e) => {
  const key = e.target.dataset.labelKey;
  if (!key) return;
  if (e.target.checked) labelPicks.add(key);
  else labelPicks.delete(key);
  renderLabelSummary();
});

document.querySelectorAll('input[name="labels-kind"]').forEach((radio) =>
  radio.addEventListener('change', () => {
    // Switching kind starts with everything of that kind ticked.
    labelPicks.clear();
    labelChoices(labelKind()).forEach((c) => labelPicks.add(c.key));
    el('labels-filter').value = '';
    renderLabelList();
  })
);

el('labels-filter').addEventListener('input', renderLabelList);
el('labels-size').addEventListener('change', renderLabelSummary);
el('labels-copies').addEventListener('input', renderLabelSummary);
el('labels-copies').addEventListener('change', renderLabelSummary);

function setVisiblePicks(on) {
  el('labels-list')
    .querySelectorAll('li:not([hidden]) input[data-label-key]')
    .forEach((box) => (on ? labelPicks.add(box.dataset.labelKey) : labelPicks.delete(box.dataset.labelKey)));
  renderLabelList();
}
el('labels-all-btn').addEventListener('click', () => setVisiblePicks(true));
el('labels-none-btn').addEventListener('click', () => setVisiblePicks(false));

function finishPrinting() {
  document.body.classList.remove('printing-labels');
  el('print-area').innerHTML = '';
}
window.addEventListener('afterprint', finishPrinting);

el('labels-form').addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy(el('labels-print-btn'), async () => {
    setFormError('labels-form-error', '');
    const picked = pickedChoices();
    const copies = labelCopies();
    const sizeKey = LABEL_SIZES[el('labels-size').value] ? el('labels-size').value : 'std';
    const all = [];
    picked.forEach((c) => {
      for (let i = 0; i < copies; i++) all.push(c);
    });
    if (all.length === 0) {
      setFormError('labels-form-error', 'Tick at least one label to print.');
      return;
    }
    if (all.length > MAX_LABELS) {
      setFormError('labels-form-error', `That is ${all.length} labels — print ${MAX_LABELS} or fewer at a time.`);
      return;
    }
    try {
      await loadQrLib();
    } catch (err) {
      setFormError('labels-form-error', err.message);
      return;
    }
    // Same QR picture for every copy of a label: make each one once.
    const htmlByKey = new Map();
    const perPage = LABEL_SIZES[sizeKey].perPage;
    const pages = [];
    for (let i = 0; i < all.length; i += perPage) {
      const cells = all.slice(i, i + perPage).map((c) => {
        if (!htmlByKey.has(c.key)) htmlByKey.set(c.key, labelHtml(c));
        return htmlByKey.get(c.key);
      });
      pages.push(`<div class="label-page size-${sizeKey}">${cells.join('')}</div>`);
    }
    el('print-area').innerHTML = pages.join('');
    document.body.classList.add('printing-labels');
    window.print();
  });
});

el('labels-btn').addEventListener('click', () => requireAdminThen(() => openLabelsModal()));
el('detail-label-btn').addEventListener('click', () => requireAdminThen(() => openLabelsModal({ itemIds: [selectedItemId] })));

// ----- Arriving from a scanned label -----

let pendingLink = (() => {
  try {
    const params = new URLSearchParams(location.search);
    const item = params.get('item');
    const loc = params.get('loc');
    if (item) return { item };
    if (loc) return { loc };
  } catch {
    // An odd address — just show the store.
  }
  return null;
})();

function clearLinkFromAddress() {
  try {
    const url = new URL(location.href);
    url.searchParams.delete('item');
    url.searchParams.delete('loc');
    history.replaceState(history.state, '', url.pathname + url.search + url.hash);
  } catch {
    // Leaving it in the address bar is harmless.
  }
}

// Called once the live stock list has loaded (after sign-in, if that is required).
function followPendingLink() {
  if (!pendingLink || isGated()) return;
  const link = pendingLink;
  pendingLink = null;
  clearLinkFromAddress();
  if (link.item) {
    const item = items.find((i) => i.id === link.item);
    if (item) openDetail(item.id);
    else showToast('That label is for an item that is no longer in the store.', 'error');
    return;
  }
  showView('inventory');
  activeCategory = 'All';
  renderCategoryChips();
  el('search-input').value = link.loc;
  el('search-input').dispatchEvent(new Event('input'));
  showToast(`Showing what is kept at "${link.loc}". Clear the search to see everything.`, '', 5000);
}

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
    ['Item Code', 'Name', 'Category', 'Total Quantity', 'On Loan', 'Reserved', 'Available', 'Unit', 'Low Stock Threshold', 'Returnable', 'Location', 'Design Variations', 'Status'],
    ...items.map((i) => [
      i.code || '',
      i.name,
      i.category,
      i.quantity,
      i.quantityOnLoan || 0,
      liveBookingsFor(i.id).reduce((sum, b) => sum + bookingQty(b, i.id), 0),
      availableQty(i),
      i.unit,
      i.lowStockThreshold,
      i.returnable ? 'Yes' : 'No',
      i.locationText,
      i.hasVariations ? (i.variations || []).filter((v) => v.active).map((v) => `${v.code} ${v.name}`).join('; ') : '',
      i.archived ? 'Archived' : 'In use',
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
loadBookings();
checkSession();
showView('inventory');

// Google's script loads on its own schedule: start now if it is already here,
// otherwise it calls initGoogle itself. If it never arrives, say so.
initGoogle();
setTimeout(() => {
  if (googleReady || initGoogle()) return;
  googleFailed = true;
  if (!el('account-modal').hidden && !session) drawGoogleButton('modal');
  if (isGated()) drawGoogleButton('gate');
}, 8000);
