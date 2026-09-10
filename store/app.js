const API = {
  items: '/.netlify/functions/store-items',
  txns: '/.netlify/functions/store-transactions',
  reports: '/.netlify/functions/store-reports',
};

const ADMIN_PW_KEY = 'vitroxStoreAdminPw';

let items = [];
let categories = [];
let activeCategory = 'All';
let searchTerm = '';
let selectedItemId = null;
let pendingAdminAction = null;

const el = (id) => document.getElementById(id);

function isAdminUnlocked() {
  return Boolean(sessionStorage.getItem(ADMIN_PW_KEY));
}

function adminHeaders() {
  const pw = sessionStorage.getItem(ADMIN_PW_KEY);
  return pw ? { 'x-admin-password': pw } : {};
}

function showToast(message, type = '') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`.trim();
  toast.textContent = message;
  el('toast-container').appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
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
  const res = await fetch(API.items);
  const data = await res.json();
  items = data.items || [];
  categories = data.categories || [];
  renderCategoryChips();
  renderGrid();
  renderLowStockBanner();
}

async function loadReportsBadge() {
  const res = await fetch(`${API.reports}?status=open`);
  const data = await res.json();
  const count = (data.reports || []).length;
  const badge = el('reports-badge');
  if (count > 0) {
    badge.hidden = false;
    badge.textContent = String(count);
  } else {
    badge.hidden = true;
  }
}

function lowStockItems() {
  return items.filter((i) => i.quantity <= i.lowStockThreshold);
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
    const low = item.quantity <= item.lowStockThreshold;
    qtyRow.innerHTML = `<span class="qty-pill ${low ? 'low' : 'ok'}">${item.quantity} ${item.unit || 'pcs'}</span>`;

    body.appendChild(tag);
    body.appendChild(name);
    body.appendChild(qtyRow);
    card.appendChild(body);
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
  el('detail-qty').textContent = item.quantity;
  el('detail-unit').textContent = item.unit || 'pcs';
  el('detail-notes').textContent = item.notes || '';
  el('detail-low-stock').hidden = item.quantity > item.lowStockThreshold;

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
  const res = await fetch(`${API.txns}?itemId=${encodeURIComponent(itemId)}`);
  const data = await res.json();
  const body = el('detail-history-body');
  body.innerHTML = '';
  (data.transactions || []).slice(0, 10).forEach((t) => {
    const row = document.createElement('tr');
    const date = new Date(t.timestamp).toLocaleString();
    row.innerHTML = `<td>${date}</td><td>${t.type === 'add' ? '+ Add On' : '− Move Out'}</td><td>${t.quantity}</td><td>${escapeHtml(t.name)} (${escapeHtml(t.employeeNo)})</td><td>${escapeHtml(t.remarks || '')}</td>`;
    body.appendChild(row);
  });
  if ((data.transactions || []).length === 0) {
    body.innerHTML = '<tr><td colspan="5" style="color:var(--text-muted)">No activity yet.</td></tr>';
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

el('detail-addon-btn').addEventListener('click', () => openTxnModal('add'));
el('detail-moveout-btn').addEventListener('click', () => openTxnModal('remove'));

function openTxnModal(type) {
  const item = items.find((i) => i.id === selectedItemId);
  if (!item) return;
  el('txn-form').dataset.type = type;
  el('txn-modal-title').textContent = type === 'add' ? 'Add On Stock' : 'Move Out Stock';
  el('txn-modal-item').textContent = `${item.name} — currently ${item.quantity} ${item.unit || 'pcs'}`;
  el('txn-name').value = '';
  el('txn-employee-no').value = '';
  el('txn-quantity').value = '';
  el('txn-remarks').value = '';
  el('txn-remarks-label').firstChild.textContent = type === 'remove' ? 'Purpose / reason (required) ' : 'Remarks (optional) ';
  el('txn-remarks').required = type === 'remove';
  el('txn-form-error').hidden = true;
  openModal('txn-modal');
}

el('txn-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const type = el('txn-form').dataset.type;
  const body = {
    itemId: selectedItemId,
    type,
    quantity: Number(el('txn-quantity').value),
    name: el('txn-name').value,
    employeeNo: el('txn-employee-no').value,
    remarks: el('txn-remarks').value,
  };

  const res = await fetch(API.txns, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();

  if (!res.ok) {
    el('txn-form-error').textContent = data.error || 'Something went wrong.';
    el('txn-form-error').hidden = false;
    return;
  }

  closeModal('txn-modal');
  showToast(type === 'add' ? 'Stock added.' : 'Stock moved out.', 'success');
  await loadItems();
  openDetail(selectedItemId);
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
            `<div class="low-stock-row"><div><strong>${escapeHtml(i.name)}</strong><span>${i.category}</span></div><span class="qty-pill low">${i.quantity} ${i.unit || 'pcs'}</span></div>`
        )
        .join('')}`
    : '<p style="color:var(--text-muted); font-size:0.85rem;">No low-stock items right now.</p>';

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
    ['Name', 'Category', 'Quantity', 'Unit', 'Low Stock Threshold', 'Location'],
    ...items.map((i) => [i.name, i.category, i.quantity, i.unit, i.lowStockThreshold, i.locationText]),
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
loadItems();
loadReportsBadge();
