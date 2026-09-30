const API = {
  items: '/.netlify/functions/store-items',
  txns: '/.netlify/functions/store-transactions',
  reports: '/.netlify/functions/store-reports',
  loans: '/.netlify/functions/store-loans',
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
  renderCategoryChips();
  renderGrid();
  renderLowStockBanner();
}

async function loadReportsBadge() {
  const [reportsRes, loansRes] = await Promise.all([fetch(`${API.reports}?status=open`), fetch(`${API.loans}?status=open`)]);
  const data = await reportsRes.json();
  const loanData = await loansRes.json();
  const today = new Date().toISOString().slice(0, 10);
  const overdueCount = (loanData.loans || []).filter((l) => l.expectedReturnDate && l.expectedReturnDate < today).length;
  const count = (data.reports || []).length + overdueCount;
  const badge = el('reports-badge');
  if (count > 0) {
    badge.hidden = false;
    badge.textContent = String(count);
  } else {
    badge.hidden = true;
  }
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
    qtyRow.innerHTML = `<span class="qty-pill ${low ? 'low' : 'ok'}">${available} ${item.unit || 'pcs'} avail.</span>${onLoanTag}`;

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

  el('detail-moveout-btn').hidden = Boolean(item.returnable);
  el('detail-loanout-btn').hidden = !item.returnable;
  el('detail-return-btn').hidden = !item.returnable;

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

el('detail-addon-btn').addEventListener('click', () => requireAdminThen(() => openTxnModal('add')));
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

  const res =
    type === 'add'
      ? await adminFetch(API.txns, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      : await fetch(API.txns, {
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
  showToast(type === 'add' ? 'Stock added.' : 'Stock moved out.', 'success');
  await loadItems();
  openDetail(selectedItemId);
});

el('detail-loanout-btn').addEventListener('click', () => {
  const item = items.find((i) => i.id === selectedItemId);
  if (!item) return;
  el('loan-out-item').textContent = `${item.name} — ${availableQty(item)} ${item.unit || 'pcs'} available`;
  el('loan-out-name').value = '';
  el('loan-out-employee-no').value = '';
  el('loan-out-quantity').value = '';
  el('loan-out-purpose').value = '';
  el('loan-out-expected-return').value = '';
  el('loan-out-form-error').hidden = true;
  openModal('loan-out-modal');
});

el('loan-out-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    itemId: selectedItemId,
    quantity: Number(el('loan-out-quantity').value),
    name: el('loan-out-name').value,
    employeeNo: el('loan-out-employee-no').value,
    purpose: el('loan-out-purpose').value,
    expectedReturnDate: el('loan-out-expected-return').value || null,
  };

  const res = await fetch(API.loans, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();

  if (!res.ok) {
    el('loan-out-form-error').textContent = data.error || 'Something went wrong.';
    el('loan-out-form-error').hidden = false;
    return;
  }

  closeModal('loan-out-modal');
  showToast('Stock moved out.', 'success');
  await loadItems();
  openDetail(selectedItemId);
});

let openLoansForReturn = [];

el('detail-return-btn').addEventListener('click', async () => {
  const item = items.find((i) => i.id === selectedItemId);
  if (!item || !item.returnable) return;

  const res = await fetch(`${API.loans}?itemId=${encodeURIComponent(item.id)}&status=open`);
  const data = await res.json();
  openLoansForReturn = data.loans || [];

  const select = el('return-loan-select');
  if (openLoansForReturn.length === 0) {
    select.innerHTML = '<option value="">No open loans for this item</option>';
  } else {
    select.innerHTML = openLoansForReturn
      .map((l) => {
        const outstanding = l.quantity - l.quantityReturned;
        const due = l.expectedReturnDate ? `, due ${l.expectedReturnDate}` : '';
        return `<option value="${l.id}">${escapeHtml(l.name)} (${escapeHtml(l.employeeNo)}) — ${outstanding} outstanding — ${escapeHtml(l.purpose)}${due}</option>`;
      })
      .join('');
  }

  el('return-quantity').value = '';
  el('return-name').value = '';
  el('return-employee-no').value = '';
  el('return-notes').value = '';
  el('return-form-error').hidden = true;
  openModal('return-modal');
});

el('return-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const loanId = el('return-loan-select').value;
  if (!loanId) {
    el('return-form-error').textContent = 'No open loan selected.';
    el('return-form-error').hidden = false;
    return;
  }

  const body = {
    quantity: Number(el('return-quantity').value),
    name: el('return-name').value,
    employeeNo: el('return-employee-no').value,
    notes: el('return-notes').value,
  };

  const res = await fetch(`${API.loans}?id=${encodeURIComponent(loanId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();

  if (!res.ok) {
    el('return-form-error').textContent = data.error || 'Something went wrong.';
    el('return-form-error').hidden = false;
    return;
  }

  closeModal('return-modal');
  showToast('Return recorded.', 'success');
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
            `<div class="low-stock-row"><div><strong>${escapeHtml(i.name)}</strong><span>${i.category}</span></div><span class="qty-pill low">${availableQty(i)} ${i.unit || 'pcs'}</span></div>`
        )
        .join('')}`
    : '<p style="color:var(--text-muted); font-size:0.85rem;">No low-stock items right now.</p>';

  const loanRes = await fetch(`${API.loans}?status=open`);
  const loanData = await loanRes.json();
  const today = new Date().toISOString().slice(0, 10);
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
loadItems();
loadReportsBadge();
