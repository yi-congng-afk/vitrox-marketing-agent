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

function json(statusCode, payload) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) };
}

// One request moves out a whole cart: consumable lines become move-out
// transactions, loanable lines become open loans. Everything is validated
// before anything is written, so a cart is either fully recorded or not at all.
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid request body' });
  }

  const name = String(body.name || '').trim();
  const employeeNo = String(body.employeeNo || '').trim();
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
        name,
        employeeNo,
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
        name,
        employeeNo,
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
