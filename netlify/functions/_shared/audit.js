const { getAuditMonth, saveAuditMonth, genId } = require('./store-blobs');

// Admin activity log: who changed what, and when. Written after each admin
// change has been saved. One list per month (Malaysia time), so no single list
// grows without end. There is deliberately no way to delete entries from the
// store itself — that is what makes the log worth having.

const MAX_PER_MONTH = 5000;
const MAX_SUMMARY = 1000;

function malaysiaMonth(date = new Date()) {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 7);
}

// event: the request (requireAdmin has already noted who the admin is on it).
// Never throws: a change that went through is never reported as failed just
// because the log could not be written.
async function audit(event, action, summary) {
  try {
    const actor = (event && event.__admin) || null;
    const entry = {
      id: genId('log'),
      at: new Date().toISOString(),
      email: actor ? actor.email || '' : '',
      name: actor ? actor.name || '' : '',
      via: actor ? actor.via : 'unknown',
      action,
      summary: String(summary || '').slice(0, MAX_SUMMARY),
    };
    const month = malaysiaMonth();
    const entries = await getAuditMonth(month);
    entries.push(entry);
    await saveAuditMonth(month, entries.slice(-MAX_PER_MONTH));
  } catch {
    // Logging is best effort.
  }
}

function show(value) {
  if (value === true) return 'yes';
  if (value === false) return 'no';
  if (value === null || value === undefined || value === '') return '(blank)';
  const text = String(value).replace(/\s+/g, ' ');
  return text.length > 40 ? `"${text.slice(0, 40)}…"` : `"${text}"`;
}

// "total 10 → 12, location "Rack A" → "Rack B"" for the fields that changed.
function describeChanges(before, after, fields) {
  const changes = [];
  for (const [key, label, kind] of fields) {
    const a = before ? before[key] : undefined;
    const b = after ? after[key] : undefined;
    if ((a ?? '') === (b ?? '')) continue;
    if (kind === 'photo') changes.push(`${label} ${b ? (a ? 'replaced' : 'added') : 'removed'}`);
    else if (kind === 'number') changes.push(`${label} ${a ?? 0} → ${b ?? 0}`);
    else changes.push(`${label} ${show(a)} → ${show(b)}`);
  }
  return changes.join(', ');
}

module.exports = { audit, describeChanges, malaysiaMonth };
