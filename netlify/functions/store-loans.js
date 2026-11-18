const { requireAdmin } = require('./_shared/store-auth');
const { getItems, saveItems, getLoans, saveLoans, getReminderLog, genId } = require('./_shared/store-blobs');
const { checkAccess, recordedBy } = require('./_shared/store-access');
const { runReminders, REMIND_EVERY_DAYS } = require('./_shared/reminders');
const { emailConfigured } = require('./_shared/mailer');

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
    const adminError = requireAdmin(event);
    if (adminError) return adminError;
    if (method === 'GET' && params.view === 'reminders') {
      const log = await getReminderLog();
      return json(200, { emailReady: emailConfigured(), everyDays: REMIND_EVERY_DAYS, lastRun: log.lastRun || null });
    }
    if (method === 'POST' && params.action === 'remind') {
      const lastRun = await runReminders({ trigger: 'admin' });
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

  if (method === 'DELETE') {
    const adminError = requireAdmin(event);
    if (adminError) return adminError;

    const id = event.queryStringParameters && event.queryStringParameters.id;
    if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'Missing id query parameter' }) };

    const loans = await getLoans();
    const index = loans.findIndex((l) => l.id === id);
    if (index === -1) return { statusCode: 404, body: JSON.stringify({ error: 'Loan not found' }) };

    const loan = loans[index];
    if (loan.quantityReturned > 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'This loan already has partial returns recorded and cannot be cancelled — return the rest instead' }),
      };
    }

    const items = await getItems();
    const item = items.find((i) => i.id === loan.itemId);
    if (item) {
      item.quantityOnLoan = Math.max(0, (item.quantityOnLoan || 0) - loan.quantity);
      item.updatedAt = new Date().toISOString();
      await saveItems(items);
    }

    const [removed] = loans.splice(index, 1);
    await saveLoans(loans);

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ loan: removed, item }) };
  }

  return { statusCode: 405, body: 'Method Not Allowed' };
};
