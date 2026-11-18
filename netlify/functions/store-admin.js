const { requireAdmin } = require('./_shared/store-auth');
const { checkAccess } = require('./_shared/store-access');
const {
  getItems,
  getCategories,
  getTransactions,
  saveTransactions,
  getLoans,
  saveLoans,
  getReports,
  saveReports,
} = require('./_shared/store-blobs');

function json(statusCode, payload, extraHeaders) {
  return { statusCode, headers: { 'Content-Type': 'application/json', ...extraHeaders }, body: JSON.stringify(payload) };
}

// Admin-only housekeeping.
//   GET  ?action=backup   -> everything (except photo files) as one JSON download
//   POST ?action=cleanup  -> remove finished history older than a date; stock
//        { before: 'YYYY-MM-DD', activity, loans, reports, dryRun }  is never changed
exports.handler = async (event) => {
  const access = await checkAccess(event);
  if (access.response) return access.response;
  const adminError = requireAdmin(event);
  if (adminError) return adminError;

  const action = (event.queryStringParameters || {}).action;

  if (event.httpMethod === 'GET' && action === 'backup') {
    const [items, categories, transactions, loans, reports] = await Promise.all([
      getItems(),
      getCategories(),
      getTransactions(),
      getLoans(),
      getReports(),
    ]);
    return json(200, { exportedAt: new Date().toISOString(), version: 1, categories, items, transactions, loans, reports }, { 'Cache-Control': 'no-store' });
  }

  if (event.httpMethod === 'POST' && action === 'cleanup') {
    let body;
    try {
      body = JSON.parse(event.body || '{}') || {};
    } catch {
      return json(400, { error: 'Invalid request body' });
    }
    const before = String(body.before || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(before)) return json(400, { error: 'Pick the date to clear history before' });
    if (!body.activity && !body.loans && !body.reports) return json(400, { error: 'Tick at least one kind of history to clear' });
    // Dates are compared in Malaysia time (UTC+8): "before 1 Jan" means before 1 Jan 00:00 MYT.
    const cutoff = Date.parse(`${before}T00:00:00+08:00`);
    const older = (iso) => {
      const t = Date.parse(iso);
      return Number.isFinite(t) && t < cutoff;
    };

    const [transactions, loans, reports] = await Promise.all([getTransactions(), getLoans(), getReports()]);
    const dropTxns = body.activity ? transactions.filter((t) => older(t.timestamp)) : [];
    // Only loans that are fully returned — anything still out stays.
    const dropLoans = body.loans ? loans.filter((l) => l.status === 'returned' && older(l.loanedAt)) : [];
    // Only resolved reports — open ones stay.
    const dropReports = body.reports ? reports.filter((r) => r.status === 'resolved' && older(r.createdAt)) : [];
    const counts = { activity: dropTxns.length, loans: dropLoans.length, reports: dropReports.length };

    if (!body.dryRun) {
      await Promise.all([
        dropTxns.length ? saveTransactions(transactions.filter((t) => !dropTxns.includes(t))) : null,
        dropLoans.length ? saveLoans(loans.filter((l) => !dropLoans.includes(l))) : null,
        dropReports.length ? saveReports(reports.filter((r) => !dropReports.includes(r))) : null,
      ]);
    }
    return json(200, { dryRun: Boolean(body.dryRun), removed: counts });
  }

  return { statusCode: 405, body: 'Method Not Allowed' };
};
