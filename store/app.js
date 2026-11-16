'use strict';

const API = {
  items: '/.netlify/functions/store-items',
  txns: '/.netlify/functions/store-transactions',
  reports: '/.netlify/functions/store-reports',
  loans: '/.netlify/functions/store-loans',
  checkout: '/.netlify/functions/store-checkout',
};

const ADMIN_PW_KEY = 'vitroxStoreAdminPw';
const CART_KEY = 'vitroxStoreCart';
const USER_KEY = 'vitroxStoreUser';
const ITEMS_CACHE_KEY = 'vitroxStoreItemsCache';

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
  const user = rememberedUser();
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
}

// ---------- Talking to the server ----------

// Never throws. Returns { ok, status, data, error, unauthorized }.
async function request(url, { method = 'GET', body, admin = false } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (admin) Object.assign(headers, adminHeaders());

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
  } catch {
    return {
      ok: false,
      status: 0,
      data: {},
      error: 'Could not reach the store server — check your connection and try again.',
    };
  }

  let data = {};
  try {
    data = (await res.json()) || {};
  } catch {
    data = {};
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
const SUB_MODALS = new Set(['txn-modal', 'edit-txn-modal', 'report-modal', 'item-form-modal', 'return-modal', 'admin-modal']);
// Forms where a stray click outside should not throw away what was typed.
const KEEP_ON_BACKDROP = new Set(['item-form-modal', 'txn-modal', 'edit-txn-modal', 'report-modal', 'return-modal']);
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
    const probe = await request(`${API.items}?id=__admin_probe__`, { method: 'DELETE', admin: true });
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
    if (!itemsLoaded) showLoadError(res.error);
    else if (!silent) showToast(`Could not refresh the stock list. ${res.error}`, 'error');
    return false;
  }

  lastLoadedAt = Date.now();
  setRefreshing(false);
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
  el('category-filters').innerHTML = ['All', ...categories]
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
      return `<tr>${date}<td><span class="type-label">Move Out</span></td><td>${l.quantity}</td><td>${person(l)}</td><td>${escapeHtml(l.purpose)}${due}</td><td class="row-actions"></td></tr>`;
    }
    const r = event.data;
    const remarks = [r.notes, `against loan to ${r.loan.name}`].filter(Boolean).join(' · ');
    return `<tr>${date}<td><span class="type-label ret">Return</span></td><td>${r.quantity}</td><td>${person(r)}</td><td>${escapeHtml(remarks)}</td><td class="row-actions"></td></tr>`;
  });

  if (historyTotal > historyEvents.length) {
    rows.push(
      `<tr><td colspan="6" class="muted-cell">Showing the latest ${historyEvents.length} of ${historyTotal} — export the Activity log for the full history.</td></tr>`
    );
  }
  body.innerHTML = rows.join('');
}

el('detail-history-body').addEventListener('click', (e) => {
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
      name: el('txn-name').value,
      employeeNo: el('txn-employee-no').value,
      remarks: el('txn-remarks').value,
    };
    const res = await request(API.txns, { method: 'POST', admin: true, body });
    if (!res.ok) {
      setFormError('txn-form-error', res.error);
      return;
    }
    rememberUser(body.name, body.employeeNo);
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
  const user = rememberedUser();
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
      name: el('checkout-name').value,
      employeeNo: el('checkout-employee-no').value,
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

    rememberUser(body.name, body.employeeNo);
    const summary = cart.map((line) => {
      const item = items.find((i) => i.id === line.itemId) || {};
      return { name: item.name || 'Item', quantity: line.quantity, unit: item.unit || 'pcs', returnable: Boolean(item.returnable) };
    });
    cart = [];
    saveCart();
    el('checkout-purpose').value = '';
    el('checkout-return-date').value = '';
    showCheckoutSuccess(summary, body, (res.data.loans || []).length);
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
      name: el('return-name').value,
      employeeNo: el('return-employee-no').value,
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

    rememberUser(body.name, body.employeeNo);
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
    : '<tr><th>Item</th><th>Qty</th><th>Borrowed by</th><th>Purpose / event</th><th>Moved out</th><th>Due back</th><th>Status</th></tr>';

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
      row.appendChild(actionCell);
    } else {
      row.innerHTML = `<td><strong>${escapeHtml(loan.itemName)}</strong></td><td>${loan.quantity}</td><td>${borrower}</td><td>${escapeHtml(loan.purpose)}</td>${movedOut}<td class="nowrap">${due}</td><td>${loanStatusHtml(loan)}</td>`;
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
    ['Item', 'Quantity', 'Returned', 'Not Returned', 'Borrowed By', 'Employee No', 'Purpose', 'Moved Out', 'Due Back', 'Status', 'Last Returned On', 'Last Returned By'],
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
      name: el('report-name').value,
      employeeNo: el('report-employee-no').value,
      quantity: el('report-quantity').value || null,
      message: el('report-message').value,
    };
    const res = await request(API.reports, { method: 'POST', body });
    if (!res.ok) {
      setFormError('report-form-error', res.error);
      return;
    }
    rememberUser(body.name, body.employeeNo);
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

async function openReportsPanel() {
  renderLowStockPanel();
  el('overdue-loans-panel').innerHTML = '';
  el('reports-list').innerHTML = '<p class="muted-text">Loading…</p>';
  openModal('reports-panel-modal');

  const [loans, reports] = await Promise.all([request(`${API.loans}?status=open`), request(`${API.reports}?status=open`)]);

  const overdue = loans.ok ? (loans.data.loans || []).filter(isOverdue) : [];
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
  if (!reports.ok) {
    list.innerHTML = `<p class="muted-text">Could not load the reports. ${escapeHtml(reports.error)}</p>`;
    return;
  }
  const open = reports.data.reports || [];
  if (open.length === 0) {
    list.innerHTML = '<p class="muted-text">No open reports.</p>';
    return;
  }
  const admin = isAdminUnlocked();
  list.innerHTML = open
    .map((r) => {
      const kind = r.type === 'damage' ? `${icon('flag')} Damaged` : `${icon('package')} Restock request`;
      const qty = r.quantity ? ` · quantity affected: ${escapeHtml(r.quantity)}` : '';
      return (
        `<div class="report-row"><div class="report-row-info">` +
        `<strong>${kind} — ${escapeHtml(r.itemName)}</strong>` +
        `<span>${escapeHtml(r.message)}${qty}</span>` +
        `<span>By ${escapeHtml(r.name)} (${escapeHtml(r.employeeNo)}) · ${escapeHtml(fmtDateTime(r.createdAt))}</span></div>` +
        (admin ? `<button type="button" class="ghost-btn" data-resolve="${escapeHtml(r.id)}">${icon('check')} Resolve</button>` : '') +
        `</div>`
      );
    })
    .join('');
  if (!admin) list.insertAdjacentHTML('beforeend', '<p class="muted-text">Unlock Admin to mark reports as resolved.</p>');
}

el('reports-list').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-resolve]');
  if (btn) withBusy(btn, () => resolveReport(btn.dataset.resolve));
});

function resolveReport(id) {
  return new Promise((done) => {
    if (!isAdminUnlocked()) done();
    requireAdminThen(async () => {
      const res = await request(`${API.reports}?id=${encodeURIComponent(id)}`, {
        method: 'PATCH',
        admin: true,
        body: { status: 'resolved' },
      });
      if (!res.ok) showToast(res.error, 'error');
      else showToast('Report resolved.', 'success');
      done();
      if (res.ok) {
        loadReportsBadge();
        openReportsPanel();
      }
    });
  });
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
      ['Date', 'Item', 'Type', 'Quantity', 'Before', 'After', 'Name', 'Employee No', 'Remarks'],
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
      ]),
    ];
    downloadCsv(`vitrox-store-activity-log-${todayStr()}.csv`, rows);
  });
});

// ---------- Start ----------

updateAdminUI();
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
