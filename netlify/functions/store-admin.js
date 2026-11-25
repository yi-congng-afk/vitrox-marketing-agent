const { requireAdmin, requireManager } = require('./_shared/store-auth');
const { checkAccess, loadRoles, saveRoles } = require('./_shared/store-access');
const { audit, malaysiaMonth } = require('./_shared/audit');
const {
  getAuditMonth,
  listAuditMonths,
  getItems,
  getCategories,
  getTransactions,
  saveTransactions,
  getLoans,
  saveLoans,
  getReports,
  saveReports,
  getBookings,
  saveBookings,
} = require('./_shared/store-blobs');

function json(statusCode, payload, extraHeaders) {
  return { statusCode, headers: { 'Content-Type': 'application/json', ...extraHeaders }, body: JSON.stringify(payload) };
}

// Admin-only housekeeping.
//   GET  ?action=backup   -> everything (except photo files) as one JSON download
//   POST ?action=cleanup  -> remove finished history older than a date; stock
//        { before: 'YYYY-MM-DD', activity, loans, reports, dryRun }  is never changed
//   GET  ?action=admins   -> { admins, managers, you }
//   POST ?action=admins   -> { admins: [emails], managers?: [emails] } replaces the lists
//   GET  ?action=log[&month=YYYY-MM] -> admin activity for one month, newest first
exports.handler = async (event) => {
  const access = await checkAccess(event);
  if (access.response) return access.response;
  // Store Managers may read the activity log; everything else here is admin only.
  const managerError = await requireManager(event);
  if (managerError) return managerError;

  const params = event.queryStringParameters || {};
  const action = params.action;
  if (!(event.httpMethod === 'GET' && action === 'log')) {
    const adminError = await requireAdmin(event);
    if (adminError) return adminError;
  }

  if (event.httpMethod === 'GET' && action === 'admins') {
    const roles = await loadRoles({ fresh: true });
    return json(200, { admins: roles.admins, managers: roles.managers, you: access.user ? access.user.email : null });
  }

  if (event.httpMethod === 'POST' && action === 'admins') {
    let body;
    try {
      body = JSON.parse(event.body || '{}') || {};
    } catch {
      return json(400, { error: 'Invalid request body' });
    }
    const before = await loadRoles({ fresh: true });
    const result = await saveRoles({ admins: body.admins, managers: body.managers !== undefined ? body.managers : before.managers });
    if (!result.ok) return json(400, { error: result.error });
    const diff = (label, was, now) => {
      const parts = [];
      const added = now.filter((e) => !was.includes(e));
      const removed = was.filter((e) => !now.includes(e));
      if (added.length) parts.push(`added ${added.join(', ')}`);
      if (removed.length) parts.push(`removed ${removed.join(', ')}`);
      return parts.length ? `${label}: ${parts.join('; ')}` : '';
    };
    const summary = [diff('Admins', before.admins, result.admins), diff('Store Managers', before.managers, result.managers)].filter(Boolean).join('. ');
    if (summary) await audit(event, 'admins', summary);
    return json(200, { admins: result.admins, managers: result.managers, you: access.user ? access.user.email : null });
  }

  if (event.httpMethod === 'GET' && action === 'log') {
    const month = /^\d{4}-\d{2}$/.test(params.month || '') ? params.month : malaysiaMonth();
    const [entries, months] = await Promise.all([getAuditMonth(month), listAuditMonths()]);
    if (!months.includes(month)) months.unshift(month);
    months.sort().reverse();
    return json(200, { month, months, entries: entries.slice().reverse() }, { 'Cache-Control': 'no-store' });
  }

  if (event.httpMethod === 'GET' && action === 'backup') {
    const [items, categories, transactions, loans, reports, bookings] = await Promise.all([
      getItems(),
      getCategories(),
      getTransactions(),
      getLoans(),
      getReports(),
      getBookings(),
    ]);
    await audit(
      event,
      'backup',
      `Downloaded a backup (${items.length} items, ${transactions.length} activity, ${loans.length} loans, ${reports.length} reports, ${bookings.length} bookings)`
    );
    return json(
      200,
      { exportedAt: new Date().toISOString(), version: 1, categories, items, transactions, loans, reports, bookings },
      { 'Cache-Control': 'no-store' }
    );
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
    if (!body.activity && !body.loans && !body.reports && !body.bookings) return json(400, { error: 'Tick at least one kind of history to clear' });
    // Dates are compared in Malaysia time (UTC+8): "before 1 Jan" means before 1 Jan 00:00 MYT.
    const cutoff = Date.parse(`${before}T00:00:00+08:00`);
    const older = (iso) => {
      const t = Date.parse(iso);
      return Number.isFinite(t) && t < cutoff;
    };

    const [transactions, loans, reports, bookings] = await Promise.all([getTransactions(), getLoans(), getReports(), getBookings()]);
    const dropTxns = body.activity ? transactions.filter((t) => older(t.timestamp)) : [];
    // Only loans that are fully returned — anything still out stays.
    const dropLoans = body.loans ? loans.filter((l) => l.status === 'returned' && older(l.loanedAt)) : [];
    // Only resolved reports — open ones stay.
    const dropReports = body.reports ? reports.filter((r) => r.status === 'resolved' && older(r.createdAt)) : [];
    // Only bookings whose event ended before the date (collected, cancelled or never collected).
    const dropBookings = body.bookings ? bookings.filter((b) => typeof b.endDate === 'string' && b.endDate < before) : [];
    const counts = { activity: dropTxns.length, loans: dropLoans.length, reports: dropReports.length, bookings: dropBookings.length };

    if (!body.dryRun) {
      await Promise.all([
        dropTxns.length ? saveTransactions(transactions.filter((t) => !dropTxns.includes(t))) : null,
        dropLoans.length ? saveLoans(loans.filter((l) => !dropLoans.includes(l))) : null,
        dropReports.length ? saveReports(reports.filter((r) => !dropReports.includes(r))) : null,
        dropBookings.length ? saveBookings(bookings.filter((b) => !dropBookings.includes(b))) : null,
      ]);
      if (counts.activity || counts.loans || counts.reports || counts.bookings) {
        await audit(
          event,
          'cleanup',
          `Cleared history from before ${before}: ${counts.activity} activity, ${counts.loans} returned loans, ${counts.reports} resolved reports, ${counts.bookings} past bookings`
        );
      }
    }
    return json(200, { dryRun: Boolean(body.dryRun), removed: counts });
  }

  return { statusCode: 405, body: 'Method Not Allowed' };
};
