const {
  getItems,
  saveItems,
  getTransactions,
  saveTransactions,
  getLoans,
  saveLoans,
  genId,
} = require('./_shared/store-blobs');
const { sendAlertEmail } = require('./_shared/mailer');
const { checkAccess, recordedBy } = require('./_shared/store-access');
const { requireAdmin } = require('./_shared/store-auth');
const { audit } = require('./_shared/audit');

function json(statusCode, payload) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) };
}

// One request moves out a whole cart: consumable lines become move-out
// transactions, loanable lines become open loans. Everything is validated
// before anything is written, so a cart is either fully recorded or not at all.
// Admin: delete a whole move-out (every record from one checkout, or a single
// record from before carts existed) — for mistakes and tests. Consumables go
// back into stock; loaned items stop counting as out on loan.
async function deleteMoveOut(id, event) {
  const [items, transactions, loans] = await Promise.all([getItems(), getTransactions(), getLoans()]);
  const inGroup = (r) => r.checkoutId === id || r.id === id;
  const txns = transactions.filter((t) => t.type === 'remove' && inGroup(t));
  const groupLoans = loans.filter(inGroup);
  if (txns.length === 0 && groupLoans.length === 0) return json(404, { error: 'That move-out no longer exists' });

  const now = new Date().toISOString();
  for (const t of txns) {
    const item = items.find((i) => i.id === t.itemId);
    if (item) {
      item.quantity += t.quantity;
      item.updatedAt = now;
    }
  }
  for (const l of groupLoans) {
    const item = items.find((i) => i.id === l.itemId);
    const outstanding = Math.max(0, l.quantity - l.quantityReturned);
    if (item && outstanding) {
      item.quantityOnLoan = Math.max(0, (item.quantityOnLoan || 0) - outstanding);
      item.updatedAt = now;
    }
  }
  await Promise.all([
    saveItems(items),
    txns.length ? saveTransactions(transactions.filter((t) => !txns.includes(t))) : null,
    groupLoans.length ? saveLoans(loans.filter((l) => !groupLoans.includes(l))) : null,
  ]);
  const first = txns[0] || groupLoans[0];
  const lines = [...txns.map((t) => `"${t.itemName}" ×${t.quantity}`), ...groupLoans.map((l) => `"${l.itemName}" ×${l.quantity} (loan)`)];
  await audit(
    event,
    'moveout.delete',
    `Deleted move-out by ${first.name} for ${first.remarks || first.purpose || '(no purpose)'}: ${lines.join(', ')}` +
      (txns.length ? ' — consumables put back into stock' : '')
  );
  return json(200, { deleted: { transactions: txns.length, loans: groupLoans.length } });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'DELETE') {
    const access = await checkAccess(event);
    if (access.response) return access.response;
    const adminError = await requireAdmin(event);
    if (adminError) return adminError;
    const id = event.queryStringParameters && event.queryStringParameters.id;
    if (!id) return json(400, { error: 'Missing id query parameter' });
    return deleteMoveOut(id, event);
  }
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const access = await checkAccess(event);
  if (access.response) return access.response;

  let body;
  try {
    body = JSON.parse(event.body || '{}') || {};
  } catch {
    return json(400, { error: 'Invalid request body' });
  }

  // Signed-in staff are recorded under their ViTrox account; otherwise as typed.
  const who = recordedBy(access.user, body);
  const { name, employeeNo } = who;
  const purpose = String(body.purpose || '').trim();
  const expectedReturnDate = body.expectedReturnDate ? String(body.expectedReturnDate).trim() : '';

  if (!name) return json(400, { error: 'Employee name is required' });
  if (!employeeNo) return json(400, { error: 'Employee number is required' });
  if (!purpose) return json(400, { error: 'Purpose / event is required' });
  if (expectedReturnDate && !/^\d{4}-\d{2}-\d{2}$/.test(expectedReturnDate)) {
    return json(400, { error: 'Expected return date must be a valid date' });
  }
  if (!Array.isArray(body.lines) || body.lines.length === 0) {
    return json(400, { error: 'Your cart is empty' });
  }

  // Merge duplicate lines for the same item so the stock check sees the total.
  const wanted = new Map();
  for (const line of body.lines) {
    const qty = Math.round(Number(line && line.quantity));
    if (!line || !line.itemId || !qty || qty <= 0) {
      return json(400, { error: 'Every cart line needs an item and a quantity of at least 1' });
    }
    wanted.set(line.itemId, (wanted.get(line.itemId) || 0) + qty);
  }

  const [items, transactions, loans] = await Promise.all([getItems(), getTransactions(), getLoans()]);

  const problems = [];
  let hasLoanable = false;
  for (const [itemId, qty] of wanted) {
    const item = items.find((i) => i.id === itemId);
    if (!item) {
      problems.push('An item in your cart no longer exists — remove it and try again');
      continue;
    }
    const available = item.returnable ? item.quantity - (item.quantityOnLoan || 0) : item.quantity;
    if (qty > available) {
      problems.push(`"${item.name}": you asked for ${qty} but only ${available} available`);
    }
    if (item.returnable) hasLoanable = true;
  }
  if (hasLoanable && !expectedReturnDate) {
    problems.push('An expected return date is required because your cart has loanable items');
  }
  if (problems.length > 0) return json(400, { error: problems.join('; ') });

  const now = new Date().toISOString();
  const checkoutId = genId('chk');
  const newTransactions = [];
  const newLoans = [];
  const crossedLowStock = [];

  for (const [itemId, qty] of wanted) {
    const item = items.find((i) => i.id === itemId);

    if (item.returnable) {
      item.quantityOnLoan = (item.quantityOnLoan || 0) + qty;
      newLoans.push({
        id: genId('loan'),
        checkoutId,
        itemId,
        itemName: item.name,
        quantity: qty,
        quantityReturned: 0,
        ...who,
        purpose,
        expectedReturnDate,
        loanedAt: now,
        status: 'open',
        returns: [],
      });
    } else {
      const quantityBefore = item.quantity;
      item.quantity = quantityBefore - qty;
      newTransactions.push({
        id: genId('txn'),
        checkoutId,
        itemId,
        itemName: item.name,
        type: 'remove',
        quantity: qty,
        quantityBefore,
        quantityAfter: item.quantity,
        ...who,
        remarks: purpose,
        timestamp: now,
      });
      if (quantityBefore > item.lowStockThreshold && item.quantity <= item.lowStockThreshold) {
        crossedLowStock.push(item);
      }
    }
    item.updatedAt = now;
  }

  await Promise.all([
    saveItems(items),
    newTransactions.length > 0 ? saveTransactions(transactions.concat(newTransactions)) : null,
    newLoans.length > 0 ? saveLoans(loans.concat(newLoans)) : null,
  ]);

  if (crossedLowStock.length > 0) {
    await sendAlertEmail(
      `[ViTrox Store] Low stock: ${crossedLowStock.map((i) => i.name).join(', ')}`,
      `These items are now at or below their low-stock threshold:\n\n` +
        crossedLowStock
          .map((i) => `- ${i.name}: ${i.quantity} ${i.unit || 'pcs'} left (threshold ${i.lowStockThreshold})`)
          .join('\n') +
        `\n\nMoved out by ${name} (${employeeNo})\nPurpose: ${purpose}\nWhen: ${now}`
    );
  }

  return json(201, { checkoutId, transactions: newTransactions, loans: newLoans });
};
