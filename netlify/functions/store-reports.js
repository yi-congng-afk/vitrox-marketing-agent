const { requireAdmin } = require('./_shared/store-auth');
const { getItems, getReports, saveReports, genId } = require('./_shared/store-blobs');

exports.handler = async (event) => {
  const method = event.httpMethod;

  if (method === 'GET') {
    const status = event.queryStringParameters && event.queryStringParameters.status;
    let reports = await getReports();
    if (status) reports = reports.filter((r) => r.status === status);
    reports = reports.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reports }) };
  }

  if (method === 'POST') {
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
    }

    const { itemId, type, name, employeeNo, quantity, message } = body;

    if (!itemId || !['damage', 'restock'].includes(type)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'itemId and a valid type (damage/restock) are required' }) };
    }
    if (!name || !String(name).trim()) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Employee name is required' }) };
    }
    if (!employeeNo || !String(employeeNo).trim()) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Employee number is required' }) };
    }
    if (!message || !String(message).trim()) {
      return { statusCode: 400, body: JSON.stringify({ error: 'A description/message is required' }) };
    }

    const items = await getItems();
    const item = items.find((i) => i.id === itemId);
    if (!item) return { statusCode: 404, body: JSON.stringify({ error: 'Item not found' }) };

    const report = {
      id: genId('rpt'),
      itemId,
      itemName: item.name,
      type,
      name: String(name).trim(),
      employeeNo: String(employeeNo).trim(),
      quantity: quantity !== undefined && quantity !== null && quantity !== '' ? Math.round(Number(quantity)) : null,
      message: String(message).trim(),
      status: 'open',
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    };

    const reports = await getReports();
    reports.push(report);
    await saveReports(reports);

    return { statusCode: 201, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ report }) };
  }

  if (method === 'PATCH') {
    const adminError = requireAdmin(event);
    if (adminError) return adminError;

    const id = event.queryStringParameters && event.queryStringParameters.id;
    if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'Missing id query parameter' }) };

    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
    }

    const reports = await getReports();
    const index = reports.findIndex((r) => r.id === id);
    if (index === -1) return { statusCode: 404, body: JSON.stringify({ error: 'Report not found' }) };

    if (body.status === 'resolved') {
      reports[index].status = 'resolved';
      reports[index].resolvedAt = new Date().toISOString();
    } else if (body.status === 'open') {
      reports[index].status = 'open';
      reports[index].resolvedAt = null;
    }
    await saveReports(reports);

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ report: reports[index] }) };
  }

  return { statusCode: 405, body: 'Method Not Allowed' };
};
