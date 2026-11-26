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
  freeNow,
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
    const outstanding = Math.max(0, l.quantity - l.quantityReturned - (l.quantityMissing || 0));
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

// Consumables taken for an event but not used (e.g. leftover goodies bags) go
// back into stock: POST ?action=unused { bookingId, lines: [{ itemId, variationId?, quantity }] }.
// Never more than was taken for that event, minus what already came back.
async function returnUnused(event, access) {
  let body;
  try {
    body = JSON.parse(event.body || '{}') || {};
  } catch {
    return json(400, { error: 'Invalid request body' });
  }
  const who = recordedBy(access.user, body);
  if (!who.name) return json(400, { error: 'Employee name is required' });
  if (!who.employeeNo) return json(400, { error: 'Employee number is required' });
  if (!body.bookingId) return json(400, { error: 'Missing bookingId' });
  if (!Array.isArray(body.lines) || !body.lines.length) return json(400, { error: 'Enter how many came back unused' });
  const key = (l) => `${l.itemId}|${l.variationId || ''}`;
  const wanted = new Map();
  for (const line of body.lines) {
    const qty = Math.round(Number(line && line.quantity));
    if (!line || !line.itemId || !Number.isFinite(qty) || qty < 0) return json(400, { error: 'Quantities must be 0 or more' });
    if (qty > 0) wanted.set(key(line), { itemId: line.itemId, variationId: line.variationId || null, quantity: (wanted.get(key(line)) || { quantity: 0 }).quantity + qty });
  }
  if (!wanted.size) return json(400, { error: 'Enter how many came back unused' });

  const now = new Date().toISOString();
  // Only consumables come back this way; loanable items are returned as loans.
  const loanable = new Set((await getItems()).filter((i) => i.returnable).map((i) => i.id));
  let marked;
  try {
    marked = await updateBookings((bookings) => {
      const b = bookings.find((x) => x.id === body.bookingId);
      if (!b) return { response: json(404, { error: 'That event no longer exists' }) };
      if (b.status !== 'collected') return { response: json(400, { error: 'Only items from a collected event can come back unused' }) };
      const taken = (b.collectedLines || []).filter((l) => !l.returnable && !loanable.has(l.itemId));
      const already = b.unusedReturned || [];
      const problems = [];
      const lines = [];
      for (const w of wanted.values()) {
        const t = taken.find((l) => key(l) === key(w));
        const back = already.filter((l) => key(l) === key(w)).reduce((s, l) => s + l.quantity, 0);
        const room = t ? t.quantity - back : 0;
        if (!t) problems.push('An item in the list was not taken for this event');
        else if (w.quantity > room) problems.push(`"${t.itemName}": only ${room} more can come back (${t.quantity} taken, ${back} already returned)`);
        else lines.push({ ...w, itemName: t.itemName, variationName: t.variationName || null });
      }
      if (problems.length) return { response: json(400, { error: problems.join('; ') }) };
      const next = {
        ...b,
        unusedReturned: already.concat(lines.map((l) => ({ ...l, at: now, by: who.name }))),
        history: (b.history || []).concat([
          { at: now, action: 'unused returned', by: who.name, email: who.email || '', detail: lines.map((l) => `${l.itemName}${l.variationName ? ` (${l.variationName})` : ''} × ${l.quantity}`).join(', ') },
        ]),
      };
      return { save: bookings.map((x) => (x.id === b.id ? next : x)), booking: next, lines };
    });
    if (marked.response) return marked.response;

    const txns = [];
    await updateItems((items) => {
      txns.length = 0;
      for (const l of marked.lines) {
        const item = items.find((i) => i.id === l.itemId);
        if (!item) continue;
        const before = item.quantity;
        item.quantity += l.quantity;
        item.updatedAt = now;
        txns.push({
          id: genId('txn'),
          itemId: item.id,
          itemName: item.name,
          ...(l.variationId ? { variationId: l.variationId, variationName: l.variationName } : {}),
          type: 'add',
          quantity: l.quantity,
          quantityBefore: before,
          quantityAfter: item.quantity,
          ...who,
          remarks: `Unused, returned from "${marked.booking.event}"`,
          bookingId: marked.booking.id,
          unusedReturn: true,
          timestamp: now,
        });
      }
      return { save: items };
    });
    await updateTransactions((list) => ({ save: list.concat(txns) }));
  } catch (err) {
    if (err && err.code === 'busy') return json(503, { error: err.message, code: 'busy' });
    throw err;
  }
  return json(200, { booking: marked.booking });
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

  if ((event.queryStringParameters || {}).action === 'unused') return returnUnused(event, access);

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
        const available = freeNow(item);
        if (qty > available) {
          problems.push(`"${item.name}": you asked for ${qty} but only ${available} available${item.quantityDamaged ? ` (${item.quantityDamaged} held as damaged)` : ''}`);
        }
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
          collectedLines: lines.map((l) => ({ itemId: l.item.id, itemName: l.item.name, ...designFields(l.variation), quantity: l.quantity, returnable: Boolean(l.item.returnable) })),
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
