const { requireAdmin } = require('./_shared/store-auth');
const { getItems, saveItems, getLoans, saveLoans, getReminderLog, genId } = require('./_shared/store-blobs');
const { checkAccess, recordedBy } = require('./_shared/store-access');
const { runReminders, REMIND_EVERY_DAYS } = require('./_shared/reminders');
const { emailConfigured } = require('./_shared/mailer');
const { audit, describeChanges } = require('./_shared/audit');

const LOAN_FIELDS = [
  ['quantity', 'borrowed', 'number'],
  ['quantityReturned', 'returned', 'number'],
  ['name', 'name'],
  ['employeeNo', 'employee no.'],
  ['email', 'email'],
  ['purpose', 'purpose'],
  ['expectedReturnDate', 'due back'],
];

function json(statusCode, payload) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) };
}

exports.handler = async (event) => {
  const method = event.httpMethod;
  const params = event.queryStringParameters || {};

  const access = await checkAccess(event);
  if (access.response) return access.response;

  // Overdue reminder emails (admin only): GET ?view=reminders shows the last
  // run, POST ?action=remind runs it now (same rules as the daily run).
  if (params.view === 'reminders' || params.action === 'remind') {
    const adminError = await requireAdmin(event);
    if (adminError) return adminError;
    if (method === 'GET' && params.view === 'reminders') {
      const log = await getReminderLog();
      return json(200, { emailReady: emailConfigured(), everyDays: REMIND_EVERY_DAYS, lastRun: log.lastRun || null });
    }
    if (method === 'POST' && params.action === 'remind') {
      const lastRun = await runReminders({ trigger: 'admin' });
      await audit(
        event,
        'reminders.send',
        lastRun.emailReady
          ? `Sent overdue reminders now: ${lastRun.peopleEmailed || 0} people emailed, ${lastRun.overdue || 0} overdue loans`
          : 'Tried to send overdue reminders, but email is not set up'
      );
      return json(200, { emailReady: lastRun.emailReady, everyDays: REMIND_EVERY_DAYS, lastRun });
    }
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  if (method === 'GET') {
    let loans = await getLoans();
    if (params.itemId) loans = loans.filter((l) => l.itemId === params.itemId);
    if (params.status) loans = loans.filter((l) => l.status === params.status);
    loans = loans.slice().sort((a, b) => new Date(b.loanedAt) - new Date(a.loanedAt));
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ loans }) };
  }

  if (method === 'POST') {
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
    }

    const { itemId, quantity, purpose, expectedReturnDate } = body;
    const who = recordedBy(access.user, body);
    const { name, employeeNo } = who;

    if (!itemId) return { statusCode: 400, body: JSON.stringify({ error: 'itemId is required' }) };
    const qty = Math.round(Number(quantity));
    if (!qty || qty <= 0) return { statusCode: 400, body: JSON.stringify({ error: 'quantity must be a positive number' }) };
    if (!name || !String(name).trim()) return { statusCode: 400, body: JSON.stringify({ error: 'Employee name is required' }) };
    if (!employeeNo || !String(employeeNo).trim()) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Employee number is required' }) };
    }
    if (!purpose || !String(purpose).trim()) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Purpose (e.g. which event) is required' }) };
    }

    const items = await getItems();
    const item = items.find((i) => i.id === itemId);
    if (!item) return { statusCode: 404, body: JSON.stringify({ error: 'Item not found' }) };
    if (!item.returnable) {
      return { statusCode: 400, body: JSON.stringify({ error: `"${item.name}" is not marked as returnable/loanable equipment` }) };
    }

    const available = item.quantity - (item.quantityOnLoan || 0);
    if (qty > available) {
      return { statusCode: 400, body: JSON.stringify({ error: `Cannot loan out ${qty} — only ${available} available` }) };
    }

    item.quantityOnLoan = (item.quantityOnLoan || 0) + qty;
    item.updatedAt = new Date().toISOString();
    await saveItems(items);

    const loan = {
      id: genId('loan'),
      itemId,
      itemName: item.name,
      quantity: qty,
      quantityReturned: 0,
      ...who,
      purpose: String(purpose).trim(),
      expectedReturnDate: expectedReturnDate || null,
      loanedAt: new Date().toISOString(),
      status: 'open',
      returns: [],
    };

    const loans = await getLoans();
    loans.push(loan);
    await saveLoans(loans);

    return { statusCode: 201, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ item, loan }) };
  }

  if (method === 'PATCH') {
    const id = event.queryStringParameters && event.queryStringParameters.id;

    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
    }

    // Either one loan (?id=...&quantity) or several at once (body.returns), so a
    // person bringing back everything from an event enters their details once.
    const { notes } = body;
    const who = recordedBy(access.user, body);
    const { name, employeeNo } = who;
    const rawLines = id ? [{ loanId: id, quantity: body.quantity }] : body.returns;
    if (!Array.isArray(rawLines) || rawLines.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Select at least one loan to return' }) };
    }
    if (!name || !String(name).trim()) return { statusCode: 400, body: JSON.stringify({ error: 'Name is required' }) };
    if (!employeeNo || !String(employeeNo).trim()) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Employee number is required' }) };
    }

    const wanted = new Map();
    for (const line of rawLines) {
      const qty = Math.round(Number(line && line.quantity));
      if (!line || !line.loanId || !qty || qty <= 0) {
        return { statusCode: 400, body: JSON.stringify({ error: 'quantity must be a positive number' }) };
      }
      wanted.set(line.loanId, (wanted.get(line.loanId) || 0) + qty);
    }

    const [loans, items] = await Promise.all([getLoans(), getItems()]);
    const problems = [];
    for (const [loanId, qty] of wanted) {
      const loan = loans.find((l) => l.id === loanId);
      if (!loan) {
        problems.push('A selected loan record no longer exists');
        continue;
      }
      const outstanding = loan.quantity - loan.quantityReturned;
      if (qty > outstanding) {
        problems.push(`"${loan.itemName}": only ${outstanding} still outstanding on this loan`);
      }
    }
    if (problems.length > 0) return { statusCode: 400, body: JSON.stringify({ error: problems.join('; ') }) };

    const returnedAt = new Date().toISOString();
    const updatedLoans = [];

    for (const [loanId, qty] of wanted) {
      const loan = loans.find((l) => l.id === loanId);
      if (!Array.isArray(loan.returns)) loan.returns = [];
      loan.returns.push({
        quantity: qty,
        ...who,
        notes: notes ? String(notes).trim() : '',
        returnedAt,
      });
      loan.quantityReturned += qty;
      if (loan.quantityReturned >= loan.quantity) {
        loan.status = 'returned';
      }
      updatedLoans.push(loan);

      const item = items.find((i) => i.id === loan.itemId);
      if (item) {
        item.quantityOnLoan = Math.max(0, (item.quantityOnLoan || 0) - qty);
        item.updatedAt = returnedAt;
      }
    }

    await Promise.all([saveLoans(loans), saveItems(items)]);

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ loans: updatedLoans }) };
  }

  // Admin correction of a loan record: who, what for, when due, how many out
  // and how many back. The item's "on loan" count follows the change.
  if (method === 'PUT') {
    const adminError = await requireAdmin(event);
    if (adminError) return adminError;
    if (!params.id) return json(400, { error: 'Missing id query parameter' });

    let body;
    try {
      body = JSON.parse(event.body || '{}') || {};
    } catch {
      return json(400, { error: 'Invalid request body' });
    }

    const [loans, items] = await Promise.all([getLoans(), getItems()]);
    const loan = loans.find((l) => l.id === params.id);
    if (!loan) return json(404, { error: 'Loan not found' });

    const text = (key, fallback) => (body[key] !== undefined ? String(body[key] || '').trim() : fallback);
    const name = text('name', loan.name);
    const employeeNo = text('employeeNo', loan.employeeNo);
    const purpose = text('purpose', loan.purpose);
    const email = text('email', loan.email || '').toLowerCase();
    const due = body.expectedReturnDate !== undefined ? String(body.expectedReturnDate || '').trim() : loan.expectedReturnDate || '';
    const quantity = body.quantity !== undefined ? Math.round(Number(body.quantity)) : loan.quantity;
    const returned = body.quantityReturned !== undefined ? Math.round(Number(body.quantityReturned)) : loan.quantityReturned;

    if (!name) return json(400, { error: 'Name is required' });
    if (!employeeNo) return json(400, { error: 'Employee number is required' });
    if (!purpose) return json(400, { error: 'Purpose / event is required' });
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(400, { error: 'That email address does not look right' });
    if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) return json(400, { error: 'Due date must be a valid date' });
    if (!Number.isFinite(quantity) || quantity < 1) return json(400, { error: 'Quantity must be at least 1' });
    if (!Number.isFinite(returned) || returned < 0) return json(400, { error: 'Returned can not be below 0' });
    if (returned > quantity) return json(400, { error: `Returned (${returned}) can not be more than the quantity borrowed (${quantity})` });

    const item = items.find((i) => i.id === loan.itemId);
    const extraOut = quantity - returned - (loan.quantity - loan.quantityReturned);
    if (item && extraOut > 0) {
      const available = item.quantity - (item.quantityOnLoan || 0);
      if (extraOut > available) {
        return json(400, { error: `Only ${available} more "${item.name}" available, so this loan can not have ${extraOut} more out` });
      }
    }

    const now = new Date().toISOString();
    const before = { ...loan };
    if (returned !== loan.quantityReturned) {
      if (!Array.isArray(loan.returns)) loan.returns = [];
      const by = access.user ? { name: access.user.name, employeeNo: access.user.employeeNo || '', email: access.user.email } : { name: 'Admin', employeeNo: '' };
      loan.returns.push({ quantity: returned - loan.quantityReturned, ...by, notes: 'Corrected by admin', returnedAt: now, adjustment: true });
    }
    Object.assign(loan, {
      name,
      employeeNo,
      purpose,
      expectedReturnDate: due || null,
      quantity,
      quantityReturned: returned,
      status: returned >= quantity ? 'returned' : 'open',
      editedAt: now,
    });
    if (email) loan.email = email;
    else delete loan.email;

    if (item && extraOut !== 0) {
      item.quantityOnLoan = Math.max(0, (item.quantityOnLoan || 0) + extraOut);
      item.updatedAt = now;
    }
    await Promise.all([saveLoans(loans), item && extraOut !== 0 ? saveItems(items) : null]);
    const changes = describeChanges(before, loan, LOAN_FIELDS);
    if (changes) await audit(event, 'loan.edit', `Edited loan of "${loan.itemName}" (${before.name}, ${before.purpose}): ${changes}`);
    return json(200, { loan, item: item || null });
  }

  if (method === 'DELETE') {
    const adminError = await requireAdmin(event);
    if (adminError) return adminError;

    const id = event.queryStringParameters && event.queryStringParameters.id;
    if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'Missing id query parameter' }) };

    const loans = await getLoans();
    const index = loans.findIndex((l) => l.id === id);
    if (index === -1) return { statusCode: 404, body: JSON.stringify({ error: 'Loan not found' }) };

    // Deleting a record (a mistake, a test, or old history): whatever was still
    // out on it stops counting as on loan. Stock totals are not touched.
    const loan = loans[index];
    const outstanding = Math.max(0, loan.quantity - loan.quantityReturned);
    const items = await getItems();
    const item = items.find((i) => i.id === loan.itemId);
    if (item && outstanding > 0) {
      item.quantityOnLoan = Math.max(0, (item.quantityOnLoan || 0) - outstanding);
      item.updatedAt = new Date().toISOString();
      await saveItems(items);
    }

    const [removed] = loans.splice(index, 1);
    await saveLoans(loans);
    await audit(
      event,
      'loan.delete',
      `Deleted loan record: "${removed.itemName}" ×${removed.quantity} borrowed by ${removed.name} for ${removed.purpose}` +
        ` (${removed.quantityReturned} returned${outstanding ? `, ${outstanding} no longer counted as on loan` : ''})`
    );

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ loan: removed, item }) };
  }

  return { statusCode: 405, body: 'Method Not Allowed' };
};
