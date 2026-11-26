const { requireManager } = require('./_shared/store-auth');
const { getItems, getReports, saveReports, genId, updateItems, updateReports } = require('./_shared/store-blobs');
const { sendAlertEmail } = require('./_shared/mailer');
const { checkAccess, recordedBy } = require('./_shared/store-access');
const { audit } = require('./_shared/audit');

const TYPE_LABEL = { damage: 'damage report', restock: 'restock request', missing: 'missing items report' };
const reportLabel = (r) => `${TYPE_LABEL[r.type] || 'report'} for "${r.itemName}" by ${r.name}`;

exports.handler = async (event) => {
  const method = event.httpMethod;

  const access = await checkAccess(event);
  if (access.response) return access.response;

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

    const { itemId, type, quantity, message } = body;
    const who = recordedBy(access.user, body);
    const { name, employeeNo } = who;

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
      ...who,
      quantity: quantity !== undefined && quantity !== null && quantity !== '' ? Math.round(Number(quantity)) : null,
      message: String(message).trim(),
      status: 'open',
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    };

    const reports = await getReports();
    reports.push(report);
    await saveReports(reports);

    await sendAlertEmail(
      `[VCLG Store Room] ${type === 'damage' ? 'Damage report' : 'Restock request'}: ${item.name}`,
      `${type === 'damage' ? 'Damage reported' : 'Restock requested'} for "${item.name}".\n\n` +
        `By: ${report.name} (${report.employeeNo})\n` +
        (report.quantity !== null ? `Quantity affected: ${report.quantity}\n` : '') +
        `Message: ${report.message}\nWhen: ${report.createdAt}`
    );

    return { statusCode: 201, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ report }) };
  }

  if (method === 'PATCH') {
    const adminError = await requireManager(event);
    if (adminError) return adminError;

    const id = event.queryStringParameters && event.queryStringParameters.id;
    if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'Missing id query parameter' }) };

    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
    }

    // outcome (when resolving):
    //   damaged items held out of use → 'repaired' (back in use) or 'written_off' (off the total)
    //   missing items → 'found' (back on the total) or 'written_off' (stays off)
    const OUTCOMES = { repaired: 'Repaired — back in use', written_off: 'Written off', found: 'Found — back in stock' };
    const outcome = body.outcome && OUTCOMES[body.outcome] ? body.outcome : null;
    const now = new Date().toISOString();
    const result = await updateReports((reports) => {
      const report = reports.find((r) => r.id === id);
      if (!report) return { response: { statusCode: 404, body: JSON.stringify({ error: 'Report not found' }) } };
      const wasStatus = report.status;
      if (body.status === 'resolved') {
        if (report.held && report.status === 'open' && !['repaired', 'written_off'].includes(outcome)) {
          return { response: { statusCode: 400, body: JSON.stringify({ error: 'Say whether the damaged items were repaired or written off' }) } };
        }
        if (report.type === 'missing' && report.status === 'open' && outcome === 'repaired') {
          return { response: { statusCode: 400, body: JSON.stringify({ error: 'Missing items can be marked found or written off' }) } };
        }
        report.status = 'resolved';
        report.resolvedAt = now;
        if (outcome) report.outcome = outcome;
      } else if (body.status === 'open') {
        // Reopening a report whose outcome already moved stock would double count it.
        if (report.outcome && (report.held || report.type === 'missing')) {
          return { response: { statusCode: 400, body: JSON.stringify({ error: 'This report already changed the stock — correct the item instead' }) } };
        }
        report.status = 'open';
        report.resolvedAt = null;
      }
      return { save: reports, report, changed: report.status !== wasStatus };
    });
    if (result.response) return result.response;
    const report = result.report;

    if (result.changed && report.status === 'resolved' && report.quantity && (report.held || report.type === 'missing')) {
      await updateItems((items) => {
        const item = items.find((i) => i.id === report.itemId);
        if (!item) return { save: items };
        if (report.held) {
          item.quantityDamaged = Math.max(0, (item.quantityDamaged || 0) - report.quantity);
          if (report.outcome === 'written_off') item.quantity = Math.max(item.quantityOnLoan || 0, item.quantity - report.quantity);
        } else if (report.type === 'missing' && report.outcome === 'found') {
          item.quantity += report.quantity;
        }
        item.updatedAt = now;
        return { save: items };
      });
    }
    if (result.changed) {
      const resolved = report.status === 'resolved';
      await audit(
        event,
        resolved ? 'report.resolve' : 'report.reopen',
        `${resolved ? 'Resolved' : 'Reopened'} ${reportLabel(report)}${resolved && report.outcome ? ` — ${OUTCOMES[report.outcome]}${report.quantity ? ` (${report.quantity})` : ''}` : ''}`
      );
    }

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ report }) };
  }


  if (method === 'DELETE') {
    const adminError = await requireManager(event);
    if (adminError) return adminError;

    const id = event.queryStringParameters && event.queryStringParameters.id;
    if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'Missing id query parameter' }) };

    const reports = await getReports();
    const index = reports.findIndex((r) => r.id === id);
    if (index === -1) return { statusCode: 404, body: JSON.stringify({ error: 'Report not found' }) };
    const [removed] = reports.splice(index, 1);
    await saveReports(reports);
    await audit(event, 'report.delete', `Deleted ${removed.status} ${reportLabel(removed)}: ${removed.message}`);
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ report: removed }) };
  }

  return { statusCode: 405, body: 'Method Not Allowed' };
};
