const {
  getItems,
  saveItems,
  getTransactions,
  saveTransactions,
  getLoans,
  saveLoans,
  updateItems,
  updateTransactions,
  updateLoans,
  updateBookings,
  genId,
} = require('./_shared/store-blobs');
const { sendAlertEmail } = require('./_shared/mailer');
const { checkAccess, recordedBy } = require('./_shared/store-access');
const { requireManager } = require('./_shared/store-auth');
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
    const adminError = await requireManager(event);
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

  // One line per item + design. Designs of an item share its stock, so the
  // stock check uses each item's total.
  const wantedLines = new Map();
  for (const line of body.lines) {
    const qty = Math.round(Number(line && line.quantity));
    if (!line || !line.itemId || !qty || qty <= 0) {
      return json(400, { error: 'Every cart line needs an item and a quantity of at least 1' });
    }
    const key = `${line.itemId}|${line.variationId || ''}`;
    const prev = wantedLines.get(key);
    wantedLines.set(key, { itemId: line.itemId, variationId: line.variationId || null, quantity: (prev ? prev.quantity : 0) + qty });
  }

  const now = new Date().toISOString();
  const checkoutId = genId('chk');
  let lines;
  let crossedLowStock = [];

  // Stock first, with safe saving: if someone else takes items at the same
  // moment, this re-reads the stock and checks again, so the last items can
  // only go once.
  let stock;
  try {
    stock = await updateItems((items) => {
      const problems = [];
      let hasLoanable = false;
      const resolved = [];
      for (const want of wantedLines.values()) {
        const item = items.find((i) => i.id === want.itemId);
        if (!item) {
          problems.push('An item in your cart no longer exists — remove it and try again');
          continue;
        }
        if (item.archived) {
          problems.push(`"${item.name}" has been archived and can no longer be moved out`);
          continue;
        }
        const designs = item.hasVariations ? (item.variations || []).filter((v) => v.active) : [];
        const variation = designs.length ? designs.find((v) => v.id === want.variationId) || null : null;
        if (want.variationId && !variation && designs.length) {
          problems.push(`"${item.name}": that design is no longer available — choose another`);
          continue;
        }
        resolved.push({ item, want, variation });
        if (item.returnable) hasLoanable = true;
      }
      const totals = new Map();
      resolved.forEach(({ item, want }) => totals.set(item.id, (totals.get(item.id) || 0) + want.quantity));
      for (const [itemId, qty] of totals) {
        const item = items.find((i) => i.id === itemId);
        const available = item.returnable ? item.quantity - (item.quantityOnLoan || 0) : item.quantity;
        if (qty > available) problems.push(`"${item.name}": you asked for ${qty} but only ${available} available`);
      }
      if (hasLoanable && !expectedReturnDate) problems.push('An expected return date is required because your cart has loanable items');
      if (problems.length) return { response: json(400, { error: problems.join('; ') }) };

      const crossed = [];
      const out = [];
      for (const { item, want, variation } of resolved) {
        const before = item.quantity;
        if (item.returnable) item.quantityOnLoan = (item.quantityOnLoan || 0) + want.quantity;
        else item.quantity -= want.quantity;
        item.updatedAt = now;
        out.push({ item: { ...item }, quantity: want.quantity, variation, quantityBefore: before });
        if (!item.returnable && before > item.lowStockThreshold && item.quantity <= item.lowStockThreshold && !crossed.includes(item)) crossed.push(item);
      }
      return { save: items, lines: out, crossed };
    });
  } catch (err) {
    if (err && err.code === 'busy') return json(503, { error: err.message, code: 'busy' });
    throw err;
  }
  if (stock.response) return stock.response;
  lines = stock.lines;
  crossedLowStock = stock.crossed;

  const designFields = (v) => (v ? { variationId: v.id, variationName: v.name, variationCode: v.code } : {});
  const newTransactions = [];
  const newLoans = [];
  for (const line of lines) {
    if (line.item.returnable) {
      newLoans.push({
        id: genId('loan'),
        checkoutId,
        itemId: line.item.id,
        itemName: line.item.name,
        ...designFields(line.variation),
        quantity: line.quantity,
        quantityReturned: 0,
        ...who,
        purpose,
        expectedReturnDate,
        loanedAt: now,
        status: 'open',
        returns: [],
        ...(body.bookingId ? { bookingId: String(body.bookingId) } : {}),
      });
    } else {
      newTransactions.push({
        id: genId('txn'),
        checkoutId,
        itemId: line.item.id,
        itemName: line.item.name,
        ...designFields(line.variation),
        type: 'remove',
        quantity: line.quantity,
        quantityBefore: line.quantityBefore,
        quantityAfter: line.quantityBefore - line.quantity,
        ...who,
        remarks: purpose,
        timestamp: now,
        ...(body.bookingId ? { bookingId: String(body.bookingId) } : {}),
      });
    }
  }

  // The records are added to the lists with safe saving too, so two checkouts
  // at the same moment never lose each other's records.
  await Promise.all([
    newTransactions.length ? updateTransactions((list) => ({ save: list.concat(newTransactions) })) : null,
    newLoans.length ? updateLoans((list) => ({ save: list.concat(newLoans) })) : null,
  ]);

  // Moving out a booked event's items: the booking is now collected, so it
  // stops holding those items (the loans / move-outs take over from here).
  let booking = null;
  if (body.bookingId) {
    try {
      const done = await updateBookings((bookings) => {
        const found = bookings.find((b) => b.id === body.bookingId && b.status === 'booked');
        if (!found) return { booking: null };
        const collected = lines.map((l) => `${l.item.name}${l.variation ? ` (${l.variation.name})` : ''} × ${l.quantity}`).join(', ');
        const next = {
          ...found,
          status: 'collected',
          collectedAt: now,
          checkoutId,
          collectedBy: who.email || who.name,
          collectedLines: lines.map((l) => ({ itemId: l.item.id, itemName: l.item.name, ...designFields(l.variation), quantity: l.quantity })),
          history: (found.history || []).concat([{ at: now, action: 'collected', by: who.name, email: who.email || '', detail: collected }]),
        };
        return { save: bookings.map((b) => (b.id === found.id ? next : b)), booking: next };
      });
      booking = done.booking;
    } catch {
      // The move-out itself is recorded; the booking can be cancelled by hand.
    }
  }

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

  return json(201, { checkoutId, transactions: newTransactions, loans: newLoans, booking });
};
