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

let items = [];
let categories = [];
let activeCategory = 'All';
let searchTerm = '';
let selectedItemId = null;
let pendingAdminAction = null;

const el = (id) => document.getElementById(id);

// Local calendar date (not UTC), so "today" and overdue checks match the wall clock.
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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

// Cart lines: [{ itemId, quantity }]. Kept in this browser until checkout.
let cart = (() => {
  const stored = readStored(CART_KEY, []);
  return Array.isArray(stored) ? stored.filter((l) => l && l.itemId && l.quantity > 0) : [];
})();

function isAdminUnlocked() {
  return Boolean(sessionStorage.getItem(ADMIN_PW_KEY));
}

function adminHeaders() {
  const pw = sessionStorage.getItem(ADMIN_PW_KEY);
  return pw ? { 'x-admin-password': pw } : {};
}

function showToast(message, type = '', duration = 3500) {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`.trim();
  toast.textContent = message;
  el('toast-container').appendChild(toast);
  setTimeout(() => toast.remove(), duration);
}

function openModal(id) {
  document.querySelectorAll('.modal-overlay').forEach((overlay) => {
    overlay.hidden = overlay.id !== id;
  });
}
function closeModal(id) {
  el(id).hidden = true;
}

document.querySelectorAll('[data-close]').forEach((btn) => {
  btn.addEventListener('click', (e) => {
    const overlay = e.target.closest('.modal-overlay');
    if (overlay) overlay.hidden = true;
  });
});
document.querySelectorAll('.modal-overlay').forEach((overlay) => {
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.hidden = true;
  });
});

async function adminFetch(url, options, { onUnauthorized } = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { ...(options.headers || {}), ...adminHeaders() },
  });
  if (res.status === 401 || res.status === 403) {
    sessionStorage.removeItem(ADMIN_PW_KEY);
    updateAdminUI();
    if (onUnauthorized) onUnauthorized();
    else showToast('Admin session expired or incorrect password — please unlock admin again.', 'error');
    return null;
  }
  return res;
}

function requireAdminThen(action) {
  if (isAdminUnlocked()) {
    action();
    return;
  }
  pendingAdminAction = action;
  el('admin-password-input').value = '';
  el('admin-form-error').hidden = true;
  openModal('admin-modal');
}

el('admin-btn').addEventListener('click', () => {
  if (isAdminUnlocked()) {
    sessionStorage.removeItem(ADMIN_PW_KEY);
    updateAdminUI();
    showToast('Admin mode locked.');
  } else {
    pendingAdminAction = null;
    el('admin-password-input').value = '';
    el('admin-form-error').hidden = true;
    openModal('admin-modal');
  }
});

el('admin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pw = el('admin-password-input').value;
  sessionStorage.setItem(ADMIN_PW_KEY, pw);

  // DELETE with a nonexistent id: requireAdmin() rejects a bad password before the
  // id is even looked up, so this verifies the password without mutating any data.
  const probe = await fetch(`${API.items}?id=__admin_probe__`, {
    method: 'DELETE',
    headers: { ...adminHeaders() },
  }).catch(() => null);

  if (!probe || probe.status === 401 || probe.status === 403) {
    sessionStorage.removeItem(ADMIN_PW_KEY);
    el('admin-form-error').textContent = 'Incorrect admin password.';
    el('admin-form-error').hidden = false;
    return;
  }

  closeModal('admin-modal');
  updateAdminUI();
  showToast('Admin mode unlocked.', 'success');
  if (pendingAdminAction) {
    const action = pendingAdminAction;
    pendingAdminAction = null;
    action();
  }
});

function updateAdminUI() {
  const unlocked = isAdminUnlocked();
  el('admin-btn').textContent = unlocked ? '🔓 Admin (unlocked)' : '🔒 Admin';
  document.querySelectorAll('.admin-only').forEach((btn) => {
    btn.hidden = !unlocked;
  });
}

function readImageAsCompressedDataUrl(file, maxDim = 900, quality = 0.72) {
  return new Promise((resolve, reject) => {
    if (!file) return resolve(null);
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const img = new Image();
      img.onerror = reject;
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
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function loadItems() {
  let res, data;
  try {
    res = await fetch(API.items);
    data = await res.json();
  } catch {
    showToast('Could not reach the store server. Check your connection and reload.', 'error');
    return;
  }
  if (!res.ok) {
    showToast(`Failed to load items: ${data.error || res.status}`, 'error');
    return;
  }
  items = data.items || [];
  categories = data.categories || [];

  // Drop cart lines whose item has since been deleted from the catalog.
  const stillExists = cart.filter((line) => items.some((i) => i.id === line.itemId));
  if (stillExists.length !== cart.length) {
    cart = stillExists;
    saveCart();
  }

  renderCategoryChips();
  renderGrid();
  renderLowStockBanner();
}

function setBadge(id, count) {
  const badge = el(id);
  badge.hidden = count <= 0;
  badge.textContent = String(count);
}

async function loadReportsBadge() {
  let data, loanData;
  try {
    const [reportsRes, loansRes] = await Promise.all([fetch(`${API.reports}?status=open`), fetch(`${API.loans}?status=open`)]);
    data = await reportsRes.json();
    loanData = await loansRes.json();
  } catch {
    return;
  }
  const openLoans = loanData.loans || [];
  const today = todayStr();
  const overdueCount = openLoans.filter((l) => l.expectedReturnDate && l.expectedReturnDate < today).length;
  setBadge('reports-badge', (data.reports || []).length + overdueCount);
  setBadge('loans-badge', openLoans.length);
}

function availableQty(item) {
  return item.returnable ? item.quantity - (item.quantityOnLoan || 0) : item.quantity;
}

function lowStockItems() {
  return items.filter((i) => availableQty(i) <= i.lowStockThreshold);
}

function renderLowStockBanner() {
  const low = lowStockItems();
  const banner = el('low-stock-banner');
  if (low.length === 0) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  banner.innerHTML = '';
  const text = document.createElement('span');
  text.textContent = `⚠ ${low.length} item${low.length > 1 ? 's are' : ' is'} running low: ${low.map((i) => i.name).join(', ')}`;
  const btn = document.createElement('button');
  btn.textContent = 'View';
  btn.addEventListener('click', () => openReportsPanel());
  banner.appendChild(text);
  banner.appendChild(btn);
}

function renderCategoryChips() {
  const row = el('category-filters');
  row.innerHTML = '';
  ['All', ...categories].forEach((cat) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `chip${cat === activeCategory ? ' active' : ''}`;
    chip.textContent = cat;
    chip.addEventListener('click', () => {
      activeCategory = cat;
      renderCategoryChips();
      renderGrid();
    });
    row.appendChild(chip);
  });
}

function filteredItems() {
  return items.filter((item) => {
    const matchesCategory = activeCategory === 'All' || item.category === activeCategory;
    const matchesSearch = !searchTerm || item.name.toLowerCase().includes(searchTerm.toLowerCase());
    return matchesCategory && matchesSearch;
  });
}

function renderGrid() {
  const grid = el('item-grid');
  const list = filteredItems();
  grid.innerHTML = '';
  el('empty-state').hidden = list.length > 0;

  list.forEach((item) => {
    const card = document.createElement('div');
    card.className = 'item-card';
    card.addEventListener('click', () => openDetail(item.id));

    if (item.itemImage) {
      const img = document.createElement('img');
      img.className = 'item-card-image';
      img.src = item.itemImage;
      img.alt = item.name;
      card.appendChild(img);
    } else {
      const placeholder = document.createElement('div');
      placeholder.className = 'item-card-image placeholder';
      placeholder.textContent = '📦';
      card.appendChild(placeholder);
    }

    const body = document.createElement('div');
    body.className = 'item-card-body';

    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = item.category;

    const name = document.createElement('div');
    name.className = 'item-card-name';
    name.textContent = item.name;

    const qtyRow = document.createElement('div');
    qtyRow.className = 'item-card-qty';
    const available = availableQty(item);
    const low = available <= item.lowStockThreshold;
    const onLoanTag = item.returnable && item.quantityOnLoan > 0 ? `<span class="on-loan-tag">${item.quantityOnLoan} on loan</span>` : '';
    const inCart = cartQty(item.id);
    const inCartTag = inCart > 0 ? `<span class="in-cart-tag">🛒 ${inCart} in cart</span>` : '';
    qtyRow.innerHTML = `<span class="qty-pill ${low ? 'low' : 'ok'}">${available} ${escapeHtml(item.unit || 'pcs')} avail.</span>${onLoanTag}${inCartTag}`;

    body.appendChild(tag);
    body.appendChild(name);
    body.appendChild(qtyRow);
    card.appendChild(body);

    // Quick add-to-cart on the card itself; clicks here must not open the detail view.
    const cartRow = document.createElement('div');
    cartRow.className = 'card-cart-row';
    cartRow.addEventListener('click', (e) => e.stopPropagation());
    if (available > 0) {
      const qtyInput = document.createElement('input');
      qtyInput.type = 'number';
      qtyInput.min = '1';
      qtyInput.max = String(available);
      qtyInput.step = '1';
      qtyInput.value = '1';
      qtyInput.setAttribute('aria-label', `Quantity of ${item.name} to add to cart`);

      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'primary-btn';
      addBtn.textContent = '🛒 Add';
      addBtn.addEventListener('click', () => addToCart(item.id, qtyInput.value));

      cartRow.appendChild(qtyInput);
      cartRow.appendChild(addBtn);
    } else {
      const none = document.createElement('span');
      none.className = 'muted';
      none.textContent = item.returnable && item.quantityOnLoan > 0 ? 'All out on loan' : 'Out of stock';
      cartRow.appendChild(none);
    }
    card.appendChild(cartRow);

    grid.appendChild(card);
  });
}

el('search-input').addEventListener('input', (e) => {
  searchTerm = e.target.value;
  renderGrid();
});

async function openDetail(itemId) {
  selectedItemId = itemId;
  const item = items.find((i) => i.id === itemId);
  if (!item) return;

  el('detail-category').textContent = item.category;
  el('detail-name').textContent = item.name;
  el('detail-location-text').textContent = item.locationText || 'Not specified';
  el('detail-unit').textContent = item.unit || 'pcs';
  el('detail-unit-2').textContent = item.unit || 'pcs';
  el('detail-notes').textContent = item.notes || '';

  const available = availableQty(item);
  el('detail-qty').textContent = available;
  el('detail-low-stock').hidden = available > item.lowStockThreshold;

  const onLoanRow = el('detail-on-loan-row');
  if (item.returnable && item.quantityOnLoan > 0) {
    onLoanRow.hidden = false;
    el('detail-on-loan').textContent = item.quantityOnLoan;
  } else {
    onLoanRow.hidden = true;
  }

  el('detail-return-btn').hidden = !item.returnable;
  el('detail-loanable-note').hidden = !item.returnable;

  const cartRoom = available - cartQty(item.id);
  el('detail-cart-qty').value = 1;
  el('detail-cart-qty').max = String(Math.max(cartRoom, 1));
  el('detail-cart-qty').disabled = cartRoom <= 0;
  el('detail-cart-btn').disabled = cartRoom <= 0;
  el('detail-cart-btn').textContent = cartQty(item.id) > 0 ? `🛒 Add to Cart (${cartQty(item.id)} in cart)` : '🛒 Add to Cart';

  const itemImg = el('detail-item-image');
  itemImg.src = item.itemImage || '';
  itemImg.style.display = item.itemImage ? 'block' : 'none';

  const locImg = el('detail-location-image');
  locImg.src = item.locationImage || '';
  locImg.style.display = item.locationImage ? 'block' : 'none';

  updateAdminUI();
  openModal('detail-modal');
  loadHistory(itemId);
}

async function loadHistory(itemId) {
  const [txnRes, loanRes] = await Promise.all([
    fetch(`${API.txns}?itemId=${encodeURIComponent(itemId)}`),
    fetch(`${API.loans}?itemId=${encodeURIComponent(itemId)}`),
  ]);
  const txnData = await txnRes.json();
  const loanData = await loanRes.json();

  const events = [];
  (txnData.transactions || []).forEach((t) => events.push({ timestamp: t.timestamp, kind: 'txn', data: t }));
  (loanData.loans || []).forEach((l) => {
    events.push({ timestamp: l.loanedAt, kind: 'loan-out', data: l });
    (l.returns || []).forEach((r) => events.push({ timestamp: r.returnedAt, kind: 'loan-return', data: { ...r, loan: l } }));
  });
  events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  const body = el('detail-history-body');
  body.innerHTML = '';

  events.slice(0, 15).forEach((event) => {
    const row = document.createElement('tr');
    const date = new Date(event.timestamp).toLocaleString();
    const actionsCell = document.createElement('td');

    if (event.kind === 'txn') {
      const t = event.data;
      row.innerHTML = `<td>${date}</td><td>${t.type === 'add' ? '+ Add On' : '− Move Out'}</td><td>${t.quantity}</td><td>${escapeHtml(t.name)} (${escapeHtml(t.employeeNo)})</td><td>${escapeHtml(t.remarks || '')}</td>`;
      if (isAdminUnlocked()) {
        const editBtn = document.createElement('button');
        editBtn.className = 'ghost-btn';
        editBtn.textContent = '✎';
        editBtn.title = 'Edit this record';
        editBtn.type = 'button';
        editBtn.addEventListener('click', () => openEditTxnModal(t));

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'ghost-btn';
        deleteBtn.textContent = '🗑';
        deleteBtn.title = 'Delete this record';
        deleteBtn.type = 'button';
        deleteBtn.addEventListener('click', () => deleteTxn(t));

        actionsCell.appendChild(editBtn);
        actionsCell.appendChild(deleteBtn);
      }
    } else if (event.kind === 'loan-out') {
      const l = event.data;
      const dueText = l.expectedReturnDate ? `, due ${l.expectedReturnDate}` : '';
      row.innerHTML = `<td>${date}</td><td>− Move Out</td><td>${l.quantity}</td><td>${escapeHtml(l.name)} (${escapeHtml(l.employeeNo)})</td><td>${escapeHtml(l.purpose)}${dueText}</td>`;
    } else {
      const r = event.data;
      row.innerHTML = `<td>${date}</td><td>📥 Return</td><td>${r.quantity}</td><td>${escapeHtml(r.name)} (${escapeHtml(r.employeeNo)})</td><td>${escapeHtml(r.notes || '')} (against loan to ${escapeHtml(r.loan.name)})</td>`;
    }

    row.appendChild(actionsCell);
    body.appendChild(row);
  });

  if (events.length === 0) {
    body.innerHTML = '<tr><td colspan="6" style="color:var(--text-muted)">No activity yet.</td></tr>';
  }
}

let editingTxnId = null;

function openEditTxnModal(t) {
  editingTxnId = t.id;
  el('edit-txn-type').value = t.type;
  el('edit-txn-quantity').value = t.quantity;
  el('edit-txn-name').value = t.name;
  el('edit-txn-employee-no').value = t.employeeNo;
  el('edit-txn-remarks').value = t.remarks || '';
  el('edit-txn-form-error').hidden = true;
  openModal('edit-txn-modal');
}

el('edit-txn-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    type: el('edit-txn-type').value,
    quantity: Number(el('edit-txn-quantity').value),
    name: el('edit-txn-name').value,
    employeeNo: el('edit-txn-employee-no').value,
    remarks: el('edit-txn-remarks').value,
  };

  const res = await adminFetch(`${API.txns}?id=${encodeURIComponent(editingTxnId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res) return;
  const data = await res.json();

  if (!res.ok) {
    el('edit-txn-form-error').textContent = data.error || 'Something went wrong.';
    el('edit-txn-form-error').hidden = false;
    return;
  }

  closeModal('edit-txn-modal');
  showToast('Activity record updated.', 'success');
  await loadItems();
  openDetail(selectedItemId);
});

async function deleteTxn(t) {
  if (!confirm('Delete this activity record? This will also adjust the item’s current quantity to compensate.')) return;

  const res = await adminFetch(`${API.txns}?id=${encodeURIComponent(t.id)}`, { method: 'DELETE' });
  if (!res) return;
  const data = await res.json();

  if (!res.ok) {
    showToast(data.error || 'Failed to delete record.', 'error');
    return;
  }

  showToast('Activity record deleted.', 'success');
  await loadItems();
  openDetail(selectedItemId);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---------- Add On (admin only) ----------

el('detail-addon-btn').addEventListener('click', () => requireAdminThen(openAddOnModal));

function openAddOnModal() {
  const item = items.find((i) => i.id === selectedItemId);
  if (!item) return;
  el('txn-modal-item').textContent = `${item.name} — currently ${item.quantity} ${item.unit || 'pcs'}`;
  el('txn-name').value = '';
  el('txn-employee-no').value = '';
  el('txn-quantity').value = '';
  el('txn-remarks').value = '';
  el('txn-form-error').hidden = true;
  openModal('txn-modal');
}

el('txn-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    itemId: selectedItemId,
    type: 'add',
    quantity: Number(el('txn-quantity').value),
    name: el('txn-name').value,
    employeeNo: el('txn-employee-no').value,
    remarks: el('txn-remarks').value,
  };

  const res = await adminFetch(API.txns, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res) return;
  const data = await res.json();

  if (!res.ok) {
    el('txn-form-error').textContent = data.error || 'Something went wrong.';
    el('txn-form-error').hidden = false;
    return;
  }

  closeModal('txn-modal');
  showToast('Stock added.', 'success');
  await loadItems();
  openDetail(selectedItemId);
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
  saveCart();
  renderGrid();
  showToast(`Added ${quantity} × ${item.name} to cart.`, 'success');
  return true;
}

el('detail-cart-btn').addEventListener('click', () => {
  if (addToCart(selectedItemId, el('detail-cart-qty').value)) openDetail(selectedItemId);
});

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

    const row = document.createElement('div');
    row.className = 'cart-line';

    let thumb;
    if (item.itemImage) {
      thumb = document.createElement('img');
      thumb.src = item.itemImage;
      thumb.alt = '';
    } else {
      thumb = document.createElement('div');
      thumb.textContent = '📦';
    }
    thumb.className = 'cart-line-thumb';

    const info = document.createElement('div');
    info.className = 'line-info';
    const title = document.createElement('strong');
    title.textContent = item.name;
    info.appendChild(title);
    const meta = document.createElement('div');
    meta.className = 'line-meta';
    meta.textContent = `${available} ${unit} available`;
    if (item.returnable) {
      const tag = document.createElement('span');
      tag.className = 'on-loan-tag';
      tag.textContent = '↩ Loan — must return';
      meta.appendChild(tag);
    }
    info.appendChild(meta);
    if (line.quantity > available) {
      const warning = document.createElement('div');
      warning.className = 'line-warning';
      warning.textContent =
        available > 0 ? `Only ${available} left — lower the quantity.` : 'No longer available — remove this line.';
      info.appendChild(warning);
    }

    const qtyInput = document.createElement('input');
    qtyInput.type = 'number';
    qtyInput.min = '1';
    qtyInput.max = String(Math.max(available, 1));
    qtyInput.step = '1';
    qtyInput.value = String(line.quantity);
    qtyInput.setAttribute('aria-label', `Quantity of ${item.name}`);
    qtyInput.addEventListener('change', () => {
      let next = Math.round(Number(qtyInput.value));
      if (!next || next < 1) next = 1;
      if (available > 0 && next > available) next = available;
      line.quantity = next;
      saveCart();
      renderCart();
      renderGrid();
    });

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'ghost-btn';
    removeBtn.textContent = '✕';
    removeBtn.title = `Remove ${item.name} from cart`;
    removeBtn.addEventListener('click', () => {
      cart = cart.filter((l) => l !== line);
      saveCart();
      renderCart();
      renderGrid();
    });

    row.appendChild(thumb);
    row.appendChild(info);
    row.appendChild(qtyInput);
    row.appendChild(removeBtn);
    container.appendChild(row);
  });

  const loanable = cartLoanableItems();
  const hasLoanable = loanable.length > 0;
  el('checkout-return-label').hidden = !hasLoanable;
  el('checkout-return-date').required = hasLoanable;
  el('checkout-loan-note').hidden = !hasLoanable;
  el('checkout-loan-note').textContent = hasLoanable
    ? `↩ ${loanable.map((i) => i.name).join(', ')} will be recorded as on loan under your name until returned (Loan Records → Return).`
    : '';
}

function openCart() {
  const savedUser = readStored(USER_KEY, {}) || {};
  if (!el('checkout-name').value) el('checkout-name').value = savedUser.name || '';
  if (!el('checkout-employee-no').value) el('checkout-employee-no').value = savedUser.employeeNo || '';
  el('checkout-return-date').min = todayStr();
  el('checkout-form-error').hidden = true;
  renderCart();
  openModal('cart-modal');
}

el('cart-btn').addEventListener('click', openCart);

el('cart-clear-btn').addEventListener('click', () => {
  if (!confirm('Remove everything from the cart?')) return;
  cart = [];
  saveCart();
  renderCart();
  renderGrid();
});

el('checkout-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (cart.length === 0) return;

  const errorEl = el('checkout-form-error');
  const submitBtn = el('checkout-submit-btn');
  const hasLoanable = cartLoanableItems().length > 0;
  const body = {
    name: el('checkout-name').value,
    employeeNo: el('checkout-employee-no').value,
    purpose: el('checkout-purpose').value,
    expectedReturnDate: hasLoanable ? el('checkout-return-date').value || null : null,
    lines: cart.map((line) => ({ itemId: line.itemId, quantity: line.quantity })),
  };

  errorEl.hidden = true;
  submitBtn.disabled = true;
  let res, data;
  try {
    res = await fetch(API.checkout, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    data = await res.json();
  } catch {
    submitBtn.disabled = false;
    errorEl.textContent = 'Could not reach the store server — nothing was recorded. Please try again.';
    errorEl.hidden = false;
    return;
  }
  submitBtn.disabled = false;

  if (!res.ok) {
    errorEl.textContent = data.error || 'Something went wrong.';
    errorEl.hidden = false;
    // Stock may have changed since the cart was filled — refresh so the lines show it.
    await loadItems();
    renderCart();
    return;
  }

  writeStored(USER_KEY, { name: body.name.trim(), employeeNo: body.employeeNo.trim() });
  const lineCount = cart.length;
  const loanCount = (data.loans || []).length;
  cart = [];
  saveCart();
  el('checkout-purpose').value = '';
  el('checkout-return-date').value = '';
  closeModal('cart-modal');
  showToast(
    loanCount > 0
      ? `Checked out ${lineCount} item${lineCount > 1 ? 's' : ''}. ${loanCount} loanable item${loanCount > 1 ? 's are' : ' is'} now on loan under your name — please return by ${body.expectedReturnDate}.`
      : `Checked out ${lineCount} item${lineCount > 1 ? 's' : ''}.`,
    'success',
    loanCount > 0 ? 7000 : 3500
  );
  await loadItems();
  loadReportsBadge();
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

  loans.forEach((loan) => {
    const outstanding = loanOutstanding(loan);
    const row = document.createElement('label');
    row.className = 'return-line';

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = checkAll || loans.length === 1;
    check.dataset.loanId = loan.id;

    const info = document.createElement('div');
    info.className = 'line-info';
    const title = document.createElement('strong');
    title.textContent = `${loan.itemName} — ${outstanding} not returned`;
    const meta = document.createElement('div');
    meta.className = 'line-meta';
    const due = loan.expectedReturnDate ? ` · due ${loan.expectedReturnDate}` : '';
    meta.textContent = `Borrowed by ${loan.name} (${loan.employeeNo}) · ${loan.purpose}${due}`;
    info.appendChild(title);
    info.appendChild(meta);

    const qtyInput = document.createElement('input');
    qtyInput.type = 'number';
    qtyInput.min = '1';
    qtyInput.max = String(outstanding);
    qtyInput.step = '1';
    qtyInput.value = String(outstanding);
    qtyInput.setAttribute('aria-label', `Quantity of ${loan.itemName} being returned`);

    row.appendChild(check);
    row.appendChild(info);
    row.appendChild(qtyInput);
    container.appendChild(row);
  });

  const savedUser = readStored(USER_KEY, {}) || {};
  el('return-name').value = savedUser.name || '';
  el('return-employee-no').value = savedUser.employeeNo || '';
  el('return-notes').value = '';
  el('return-form-error').hidden = true;
  openModal('return-modal');
}

el('detail-return-btn').addEventListener('click', async () => {
  const item = items.find((i) => i.id === selectedItemId);
  if (!item || !item.returnable) return;

  let data;
  try {
    const res = await fetch(`${API.loans}?itemId=${encodeURIComponent(item.id)}&status=open`);
    data = await res.json();
  } catch {
    showToast('Could not load the loans for this item.', 'error');
    return;
  }
  const openLoans = data.loans || [];
  if (openLoans.length === 0) {
    showToast(`Nothing to return — no "${item.name}" is out on loan right now.`);
    return;
  }
  openReturnModal(openLoans, { origin: 'detail', checkAll: false });
});

el('return-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = el('return-form-error');
  const showError = (message) => {
    errorEl.textContent = message;
    errorEl.hidden = false;
  };

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
    showError('Tick at least one item that is being returned.');
    return;
  }
  if (returns.some((r) => !r.quantity || r.quantity <= 0)) {
    showError('Every ticked item needs a return quantity of at least 1.');
    return;
  }

  const body = {
    returns,
    name: el('return-name').value,
    employeeNo: el('return-employee-no').value,
    notes: el('return-notes').value,
  };

  const submitBtn = el('return-submit-btn');
  errorEl.hidden = true;
  submitBtn.disabled = true;
  let res, data;
  try {
    res = await fetch(API.loans, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    data = await res.json();
  } catch {
    submitBtn.disabled = false;
    showError('Could not reach the store server — nothing was recorded. Please try again.');
    return;
  }
  submitBtn.disabled = false;

  if (!res.ok) {
    showError(data.error || 'Something went wrong.');
    return;
  }

  closeModal('return-modal');
  showToast(`Return recorded for ${returns.length} item${returns.length > 1 ? 's' : ''}.`, 'success');
  await loadItems();
  loadReportsBadge();
  if (returnOrigin === 'loans') openLoansPanel();
  else openDetail(selectedItemId);
});

// ---------- Loan records: what is still out, and who has borrowed what ----------

let allLoans = [];
let loansTab = 'open';
let loansSearch = '';
const selectedLoanIds = new Set();

async function openLoansPanel() {
  try {
    const res = await fetch(API.loans);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || String(res.status));
    allLoans = data.loans || [];
  } catch {
    showToast('Could not load loan records. Please try again.', 'error');
    return;
  }
  selectedLoanIds.clear();
  setBadge('loans-badge', allLoans.filter((l) => l.status === 'open').length);
  renderLoansPanel();
  openModal('loans-modal');
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
    const detail = last ? ` ${new Date(last.returnedAt).toLocaleDateString()} by ${escapeHtml(last.name)}` : '';
    return `<span class="qty-pill ok">Returned</span>${detail}`;
  }
  const overdue = isOverdue(loan) ? ' <span class="qty-pill low">Overdue</span>' : '';
  return `<span class="on-loan-tag" style="margin-left:0">${loanOutstanding(loan)} not returned</span>${overdue}`;
}

function updateReturnSelectedButton() {
  const count = selectedLoanIds.size;
  el('loans-return-selected-btn').textContent = count > 0 ? `📥 Return Selected (${count})` : '📥 Return Selected';
}

function renderLoansPanel() {
  const openTab = loansTab === 'open';
  el('loans-tab-open').classList.toggle('active', openTab);
  el('loans-tab-all').classList.toggle('active', !openTab);
  el('loans-return-selected-btn').hidden = !openTab;

  el('loans-head').innerHTML = openTab
    ? '<tr><th></th><th>Item</th><th>Not returned</th><th>Borrowed by</th><th>Purpose / event</th><th>Moved out</th><th>Due back</th><th></th></tr>'
    : '<tr><th>Item</th><th>Qty</th><th>Borrowed by</th><th>Purpose / event</th><th>Moved out</th><th>Due back</th><th>Status</th></tr>';

  const list = filteredLoans();
  const body = el('loans-body');
  body.innerHTML = '';

  const empty = el('loans-empty');
  empty.hidden = list.length > 0;
  if (loansSearch.trim()) empty.textContent = 'No loan records match your search.';
  else empty.textContent = openTab ? 'Everything has been returned — nothing is out on loan.' : 'No loan records yet.';

  list.forEach((loan) => {
    const row = document.createElement('tr');
    const outstanding = loanOutstanding(loan);
    const borrower = `${escapeHtml(loan.name)} (${escapeHtml(loan.employeeNo)})`;
    const movedOut = new Date(loan.loanedAt).toLocaleDateString();
    const due = loan.expectedReturnDate ? escapeHtml(loan.expectedReturnDate) : '—';

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
      });
      checkCell.appendChild(check);
      row.appendChild(checkCell);

      const partial = loan.quantityReturned > 0 ? ` of ${loan.quantity}` : '';
      const overdue = isOverdue(loan) ? ' <span class="qty-pill low">Overdue</span>' : '';
      row.insertAdjacentHTML(
        'beforeend',
        `<td>${escapeHtml(loan.itemName)}</td><td>${outstanding}${partial}</td><td>${borrower}</td><td>${escapeHtml(loan.purpose)}</td><td>${movedOut}</td><td>${due}${overdue}</td>`
      );

      const actionCell = document.createElement('td');
      const returnBtn = document.createElement('button');
      returnBtn.type = 'button';
      returnBtn.className = 'ghost-btn';
      returnBtn.textContent = '📥 Return';
      returnBtn.addEventListener('click', () => openReturnModal([loan], { origin: 'loans', checkAll: true }));
      actionCell.appendChild(returnBtn);
      row.appendChild(actionCell);
    } else {
      row.innerHTML = `<td>${escapeHtml(loan.itemName)}</td><td>${loan.quantity}</td><td>${borrower}</td><td>${escapeHtml(loan.purpose)}</td><td>${movedOut}</td><td>${due}</td><td>${loanStatusHtml(loan)}</td>`;
    }

    body.appendChild(row);
  });

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
        new Date(loan.loanedAt).toLocaleString(),
        loan.expectedReturnDate || '',
        loan.status === 'returned' ? 'Returned' : isOverdue(loan) ? 'Overdue' : 'Not returned',
        last ? new Date(last.returnedAt).toLocaleString() : '',
        last ? `${last.name} (${last.employeeNo})` : '',
      ];
    }),
  ];
  downloadCsv(`vitrox-store-loan-records-${todayStr()}.csv`, rows);
});

el('detail-report-btn').addEventListener('click', () => {
  const item = items.find((i) => i.id === selectedItemId);
  if (!item) return;
  el('report-modal-item').textContent = item.name;
  el('report-type').value = 'damage';
  el('report-name').value = '';
  el('report-employee-no').value = '';
  el('report-quantity').value = '';
  el('report-message').value = '';
  el('report-form-error').hidden = true;
  openModal('report-modal');
});

el('report-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    itemId: selectedItemId,
    type: el('report-type').value,
    name: el('report-name').value,
    employeeNo: el('report-employee-no').value,
    quantity: el('report-quantity').value || null,
    message: el('report-message').value,
  };

  const res = await fetch(API.reports, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();

  if (!res.ok) {
    el('report-form-error').textContent = data.error || 'Something went wrong.';
    el('report-form-error').hidden = false;
    return;
  }

  closeModal('report-modal');
  showToast('Report submitted to admin.', 'success');
  loadReportsBadge();
});

el('reports-btn').addEventListener('click', openReportsPanel);

async function openReportsPanel() {
  const low = lowStockItems();
  const lowPanel = el('low-stock-list-panel');
  lowPanel.innerHTML = low.length
    ? `<h3>Low Stock</h3>${low
        .map(
          (i) =>
            `<div class="low-stock-row"><div><strong>${escapeHtml(i.name)}</strong><span>${i.category}</span></div><span class="qty-pill low">${availableQty(i)} ${i.unit || 'pcs'}</span></div>`
        )
        .join('')}`
    : '<p style="color:var(--text-muted); font-size:0.85rem;">No low-stock items right now.</p>';

  const loanRes = await fetch(`${API.loans}?status=open`);
  const loanData = await loanRes.json();
  const today = todayStr();
  const overdue = (loanData.loans || []).filter((l) => l.expectedReturnDate && l.expectedReturnDate < today);
  const overduePanel = el('overdue-loans-panel');
  overduePanel.innerHTML = overdue.length
    ? `<h3>Overdue Loans</h3>${overdue
        .map((l) => {
          const outstanding = l.quantity - l.quantityReturned;
          const daysOverdue = Math.round((new Date(today) - new Date(l.expectedReturnDate)) / 86400000);
          return `<div class="low-stock-row"><div><strong>${escapeHtml(l.itemName)} × ${outstanding}</strong><span>With ${escapeHtml(l.name)} (${escapeHtml(l.employeeNo)}) for ${escapeHtml(l.purpose)}</span></div><span class="qty-pill low">${daysOverdue}d overdue</span></div>`;
        })
        .join('')}`
    : '';

  const res = await fetch(`${API.reports}?status=open`);
  const data = await res.json();
  const reports = data.reports || [];
  const list = el('reports-list');
  list.innerHTML = reports.length
    ? ''
    : '<p style="color:var(--text-muted); font-size:0.85rem;">No open reports.</p>';

  reports.forEach((r) => {
    const row = document.createElement('div');
    row.className = 'report-row';
    row.innerHTML = `<div class="report-row-info"><strong>${r.type === 'damage' ? '🚩 Damage' : '📦 Restock'} — ${escapeHtml(r.itemName)}</strong><span>${escapeHtml(r.message)} — by ${escapeHtml(r.name)} (${escapeHtml(r.employeeNo)}), ${new Date(r.createdAt).toLocaleString()}</span></div>`;
    if (isAdminUnlocked()) {
      const resolveBtn = document.createElement('button');
      resolveBtn.className = 'ghost-btn';
      resolveBtn.textContent = 'Resolve';
      resolveBtn.addEventListener('click', () => resolveReport(r.id));
      row.appendChild(resolveBtn);
    }
    list.appendChild(row);
  });

  openModal('reports-panel-modal');
}

async function resolveReport(id) {
  requireAdminThen(async () => {
    const res = await adminFetch(`${API.reports}?id=${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'resolved' }),
    });
    if (!res) return;
    if (!res.ok) {
      showToast('Failed to resolve report.', 'error');
      return;
    }
    showToast('Report resolved.', 'success');
    loadReportsBadge();
    openReportsPanel();
  });
}

el('detail-edit-btn').addEventListener('click', () => {
  requireAdminThen(() => openItemForm(selectedItemId));
});

el('detail-delete-btn').addEventListener('click', () => {
  requireAdminThen(async () => {
    const item = items.find((i) => i.id === selectedItemId);
    if (!item || !confirm(`Delete "${item.name}" from the catalog? This cannot be undone.`)) return;
    const res = await adminFetch(`${API.items}?id=${encodeURIComponent(item.id)}`, { method: 'DELETE' });
    if (!res) return;
    if (!res.ok) {
      showToast('Failed to delete item.', 'error');
      return;
    }
    closeModal('detail-modal');
    showToast('Item deleted.', 'success');
    loadItems();
  });
});

el('add-item-btn').addEventListener('click', () => {
  requireAdminThen(() => openItemForm(null));
});

let formImageDataUrl = null;
let formLocationImageDataUrl = null;

function openItemForm(itemId) {
  const item = itemId ? items.find((i) => i.id === itemId) : null;
  el('item-form').dataset.id = itemId || '';
  el('item-form-title').textContent = item ? `Edit ${item.name}` : 'Add New Item';

  const categorySelect = el('form-category');
  categorySelect.innerHTML = categories.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');

  el('form-name').value = item ? item.name : '';
  categorySelect.value = item ? item.category : categories[0];
  el('form-unit').value = item ? item.unit : 'pcs';
  el('form-quantity').value = item ? item.quantity : 0;
  el('form-threshold').value = item ? item.lowStockThreshold : 5;
  el('form-location-text').value = item ? item.locationText : '';
  el('form-notes').value = item ? item.notes : '';
  el('form-returnable').checked = item ? Boolean(item.returnable) : false;

  formImageDataUrl = item ? item.itemImage : null;
  formLocationImageDataUrl = item ? item.locationImage : null;
  el('form-item-image').value = '';
  el('form-location-image').value = '';

  const itemPreview = el('form-item-image-preview');
  itemPreview.src = formImageDataUrl || '';
  itemPreview.hidden = !formImageDataUrl;

  const locPreview = el('form-location-image-preview');
  locPreview.src = formLocationImageDataUrl || '';
  locPreview.hidden = !formLocationImageDataUrl;

  el('item-form-error').hidden = true;
  openModal('item-form-modal');
}

el('form-item-image').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  formImageDataUrl = await readImageAsCompressedDataUrl(file);
  const preview = el('form-item-image-preview');
  preview.src = formImageDataUrl || '';
  preview.hidden = !formImageDataUrl;
});

el('form-location-image').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  formLocationImageDataUrl = await readImageAsCompressedDataUrl(file);
  const preview = el('form-location-image-preview');
  preview.src = formLocationImageDataUrl || '';
  preview.hidden = !formLocationImageDataUrl;
});

el('item-form').addEventListener('submit', async (e) => {
  e.preventDefault();
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
    itemImage: formImageDataUrl,
    locationImage: formLocationImageDataUrl,
  };

  const url = id ? `${API.items}?id=${encodeURIComponent(id)}` : API.items;
  const res = await adminFetch(url, {
    method: id ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res) return;
  const data = await res.json();

  if (!res.ok) {
    el('item-form-error').textContent = data.error || 'Something went wrong.';
    el('item-form-error').hidden = false;
    return;
  }

  closeModal('item-form-modal');
  closeModal('detail-modal');
  showToast(id ? 'Item updated.' : 'Item added.', 'success');
  loadItems();
});

el('remove-item-btn').addEventListener('click', () => {
  requireAdminThen(() => {
    const select = el('remove-picker-select');
    select.innerHTML = items
      .map((i) => `<option value="${i.id}">${escapeHtml(i.name)} (${i.category})</option>`)
      .join('');
    openModal('remove-picker-modal');
  });
});

el('remove-picker-confirm').addEventListener('click', () => {
  const id = el('remove-picker-select').value;
  const item = items.find((i) => i.id === id);
  if (!item) return;
  if (!confirm(`Delete "${item.name}" from the catalog? This cannot be undone.`)) return;

  requireAdminThen(async () => {
    const res = await adminFetch(`${API.items}?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res) return;
    if (!res.ok) {
      showToast('Failed to delete item.', 'error');
      return;
    }
    closeModal('remove-picker-modal');
    showToast('Item deleted.', 'success');
    loadItems();
  });
});

function toCsvValue(value) {
  const str = String(value ?? '');
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function downloadCsv(filename, rows) {
  const csv = rows.map((row) => row.map(toCsvValue).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

el('export-items-btn').addEventListener('click', () => {
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
  downloadCsv(`vitrox-store-inventory-${new Date().toISOString().slice(0, 10)}.csv`, rows);
});

el('export-txns-btn').addEventListener('click', async () => {
  const res = await fetch(API.txns);
  const data = await res.json();
  const rows = [
    ['Date', 'Item', 'Type', 'Quantity', 'Before', 'After', 'Name', 'Employee No', 'Remarks'],
    ...(data.transactions || []).map((t) => [
      new Date(t.timestamp).toLocaleString(),
      t.itemName,
      t.type,
      t.quantity,
      t.quantityBefore,
      t.quantityAfter,
      t.name,
      t.employeeNo,
      t.remarks,
    ]),
  ];
  downloadCsv(`vitrox-store-transaction-log-${new Date().toISOString().slice(0, 10)}.csv`, rows);
});

updateAdminUI();
setBadge('cart-badge', cart.length);
loadItems();
loadReportsBadge();
