const { requireAdmin } = require('./_shared/store-auth');
const { getItems, saveItems, getLoans, saveLoans, genId } = require('./_shared/store-blobs');

exports.handler = async (event) => {
  const method = event.httpMethod;

  if (method === 'GET') {
    const params = event.queryStringParameters || {};
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

    const { itemId, quantity, name, employeeNo, purpose, expectedReturnDate } = body;

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
      name: String(name).trim(),
      employeeNo: String(employeeNo).trim(),
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
    if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'Missing id query parameter' }) };

    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
    }

    const { quantity, name, employeeNo, notes } = body;
    const qty = Math.round(Number(quantity));
    if (!qty || qty <= 0) return { statusCode: 400, body: JSON.stringify({ error: 'quantity must be a positive number' }) };
    if (!name || !String(name).trim()) return { statusCode: 400, body: JSON.stringify({ error: 'Name is required' }) };
    if (!employeeNo || !String(employeeNo).trim()) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Employee number is required' }) };
    }

    const loans = await getLoans();
    const index = loans.findIndex((l) => l.id === id);
    if (index === -1) return { statusCode: 404, body: JSON.stringify({ error: 'Loan not found' }) };

    const loan = loans[index];
    const outstanding = loan.quantity - loan.quantityReturned;
    if (qty > outstanding) {
      return { statusCode: 400, body: JSON.stringify({ error: `Only ${outstanding} still outstanding on this loan` }) };
    }

    loan.returns.push({
      quantity: qty,
      name: String(name).trim(),
      employeeNo: String(employeeNo).trim(),
      notes: notes ? String(notes).trim() : '',
      returnedAt: new Date().toISOString(),
    });
    loan.quantityReturned += qty;
    if (loan.quantityReturned >= loan.quantity) {
      loan.status = 'returned';
    }
    await saveLoans(loans);

    const items = await getItems();
    const item = items.find((i) => i.id === loan.itemId);
    if (item) {
      item.quantityOnLoan = Math.max(0, (item.quantityOnLoan || 0) - qty);
      item.updatedAt = new Date().toISOString();
      await saveItems(items);
    }

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ loan, item }) };
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
