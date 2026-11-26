const { getItems, getLoans, getBookings, updateBookings, genId } = require('./_shared/store-blobs');
const { checkAccess, recordedBy, isManager } = require('./_shared/store-access');
const { audit } = require('./_shared/audit');
const { sendEmail, sendAlertEmail } = require('./_shared/mailer');

const SITE_URL = 'https://vitrox-college-store.netlify.app/';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DAY_FMT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const fmtDay = (ymd) => DAY_FMT.format(new Date(`${ymd}T00:00:00Z`));
const dates = (b) => (b.endDate && b.endDate !== b.startDate ? `${fmtDay(b.startDate)} – ${fmtDay(b.endDate)}` : fmtDay(b.startDate));
const itemList = (b) => ((b.lines || []).length ? b.lines.map((l) => `- ${l.itemName}${l.variationName ? ` (${l.variationName})` : ''} × ${l.quantity}`).join('\n') : '(no items yet)');

// Emails never hold up or break the booking itself.
async function tellBooker(b, subject, text) {
  const to = String(b.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(to)) return;
  try {
    await sendEmail({ to, subject, text });
  } catch {
    // ignore
  }
}
const { MAX_DAYS, MAX_AHEAD_DAYS, malaysiaToday, validDate, daysBetween, findClashes } = require('./_shared/bookings');

// Event bookings. An event has its details (name, category, dates, venue,
// organiser…) and the items reserved for it. Its start date is when the items
// are collected and its end date is when they are due back.
//
// GET                 — every event (optionally ?itemId=)
// POST                — create an event { event, category, startDate, endDate, venue, organiser,
//                       department, contact, description, notes, lines:[{ itemId, variationId?, quantity }],
//                       acceptClashes }  (name/employeeNo too when not signed in)
// PUT ?id=            — change an event that has not been collected yet (same fields)
// PATCH ?id=          — { status: 'cancelled' }
// DELETE ?id=         — admin / Store Manager: remove the record entirely
// Not enough stock → 409 { code: 'clash', clashes, canOverride }; only an
// admin or Store Manager may override with acceptClashes (logged).

const LIMITS = { event: 120, category: 40, venue: 120, organiser: 80, department: 80, contact: 120, description: 1000, notes: 500 };
const MAX_LINES = 50;

function json(statusCode, payload) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) };
}

function parseBody(event) {
  try {
    const body = JSON.parse(event.body || '{}');
    return body && typeof body === 'object' ? body : null;
  } catch {
    return null;
  }
}

const tidy = (value, max) => String(value === undefined || value === null ? '' : value).trim().replace(/[ \t]+/g, ' ').slice(0, max + 1);
const describe = (b) => `"${b.event}" (${b.startDate}${b.endDate !== b.startDate ? ` to ${b.endDate}` : ''}) by ${b.name}`;

// Checks an event's details and items. Returns { fields, lines } or { error }.
function readEventInput(body, items, { existing, today }) {
  const fields = {};
  for (const key of Object.keys(LIMITS)) {
    const value = tidy(body[key] !== undefined ? body[key] : existing ? existing[key] : '', LIMITS[key]);
    if (value.length > LIMITS[key]) return { error: `${key[0].toUpperCase()}${key.slice(1)} is too long (${LIMITS[key]} characters at most)` };
    fields[key] = value;
  }
  if (!fields.event) return { error: 'Enter the event name' };
  if (!fields.category) return { error: 'Choose the event category' };
  if (!fields.venue) return { error: 'Enter the venue / location' };
  if (!fields.organiser) return { error: 'Enter the organiser' };

  const start = String(body.startDate !== undefined ? body.startDate : existing ? existing.startDate : '').trim();
  // A change that leaves out the end date keeps the one the event already has.
  const end = String(
    body.endDate !== undefined && body.endDate !== '' ? body.endDate : existing && body.startDate === undefined ? existing.endDate : start
  ).trim();
  if (!validDate(start)) return { error: 'Pick the event start date (the day the items are collected)' };
  if (!validDate(end)) return { error: 'Pick the event end date (the day the items are due back)' };
  if (start < today && !(existing && existing.startDate === start)) return { error: 'The start date has already passed' };
  if (end < start) return { error: 'The end date is before the start date' };
  if (daysBetween(start, end) > MAX_DAYS) return { error: `An event booking can cover ${MAX_DAYS} days at most` };
  if (daysBetween(today, start) > MAX_AHEAD_DAYS) return { error: 'That is too far ahead — book within the next two years' };
  fields.startDate = start;
  fields.endDate = end;

  const rawLines = body.lines !== undefined ? body.lines : existing ? existing.lines : [];
  if (!Array.isArray(rawLines)) return { error: 'Items must be a list' };
  if (rawLines.length > MAX_LINES) return { error: `${MAX_LINES} lines at most per event` };
  const merged = new Map();
  const problems = [];
  for (const raw of rawLines) {
    const qty = Math.round(Number(raw && raw.quantity));
    if (!raw || !raw.itemId || !qty || qty <= 0) return { error: 'Every item line needs an item and a quantity of at least 1' };
    const item = items.find((i) => i.id === raw.itemId);
    if (!item) {
      problems.push('An item in the list no longer exists — remove it and try again');
      continue;
    }
    const keptFromBefore = existing && (existing.lines || []).some((l) => l.itemId === item.id);
    if (item.archived && !keptFromBefore) {
      problems.push(`"${item.name}" has been archived and can no longer be booked`);
      continue;
    }
    const designs = item.hasVariations ? (item.variations || []).filter((v) => v.active) : [];
    let variation = null;
    if (designs.length) {
      variation = designs.find((v) => v.id === raw.variationId) || null;
      if (!variation) {
        problems.push(raw.variationId ? `"${item.name}": that design is no longer available — choose another` : `"${item.name}": choose a design`);
        continue;
      }
    }
    const key = `${item.id}|${variation ? variation.id : ''}`;
    const line = merged.get(key) || {
      itemId: item.id,
      itemName: item.name,
      itemCode: item.code || '',
      variationId: variation ? variation.id : null,
      variationName: variation ? variation.name : null,
      variationCode: variation ? variation.code : null,
      quantity: 0,
      returnable: Boolean(item.returnable),
    };
    line.quantity += qty;
    merged.set(key, line);
  }
  if (problems.length) return { error: problems.join('; ') };
  const lines = [...merged.values()];
  const totals = new Map();
  lines.forEach((l) => totals.set(l.itemId, (totals.get(l.itemId) || 0) + l.quantity));
  for (const [itemId, qty] of totals) {
    const item = items.find((i) => i.id === itemId);
    if (qty > item.quantity) problems.push(`"${item.name}": the store only has ${item.quantity} in total`);
  }
  if (problems.length) return { error: problems.join('; ') };
  return { fields, lines };
}

function clashResponse(clashes, canOverride) {
  return json(409, {
    code: 'clash',
    error: 'Not enough available for those dates — lower the quantity, remove the item or pick other dates',
    clashes,
    canOverride,
  });
}

function historyEntry(action, who, detail) {
  return { at: new Date().toISOString(), action, by: who.name || '', email: who.email || '', detail: detail || '' };
}

function lineText(l) {
  return `${l.itemName}${l.variationName ? ` (${l.variationName})` : ''} × ${l.quantity}`;
}

exports.handler = async (event) => {
  const method = event.httpMethod;
  const params = event.queryStringParameters || {};

  const access = await checkAccess(event);
  if (access.response) return access.response;

  if (method === 'GET') {
    let bookings = await getBookings();
    if (params.itemId) bookings = bookings.filter((b) => (b.lines || []).some((l) => l.itemId === params.itemId));
    return json(200, { bookings, today: malaysiaToday() });
  }

  const body = method === 'DELETE' ? {} : parseBody(event);
  if (!body) return json(400, { error: 'Invalid request body' });
  const canManage = await isManager(event);
  const today = malaysiaToday();

  try {
    if (method === 'POST') {
      const who = recordedBy(access.user, body);
      if (!who.name) return json(400, { error: 'Employee name is required' });
      if (!who.employeeNo) return json(400, { error: 'Employee number is required' });
      const bodyWithOrganiser = { ...body, organiser: body.organiser !== undefined && String(body.organiser).trim() ? body.organiser : who.name };

      const [items, loans] = await Promise.all([getItems(), getLoans()]);
      const input = readEventInput(bodyWithOrganiser, items, { today });
      if (input.error) return json(400, { error: input.error });

      const outcome = await updateBookings((bookings) => {
        const clashes = findClashes(input.lines, { start: input.fields.startDate, end: input.fields.endDate, items, bookings, loans, today });
        if (clashes.length && !(canManage && body.acceptClashes === true)) return { response: clashResponse(clashes, canManage) };
        const booking = {
          id: genId('bkg'),
          ...input.fields,
          lines: input.lines,
          ...who,
          status: 'booked',
          createdAt: new Date().toISOString(),
          history: [historyEntry('created', who, input.lines.map(lineText).join(', '))],
        };
        if (clashes.length) booking.clashesAccepted = clashes.map((c) => ({ itemName: c.itemName, wanted: c.wanted, available: c.available }));
        return { save: bookings.concat([booking]), booking, clashes };
      });
      if (outcome.response) return outcome.response;
      const b = outcome.booking;
      if (outcome.clashes.length) {
        const short = outcome.clashes.map((c) => `"${c.itemName}" ${c.wanted} wanted, ${c.available} free`).join('; ');
        await audit(event, 'booking.override', `Booked ${describe(b)} over the available stock: ${short}`);
        await sendAlertEmail(`[VCLG Store Room] Booked over the available stock: "${b.event}"`, `${describe(b)} was booked by an admin / Store Manager although there was not enough:\n${short}\n\nPlease make sure the other events have agreed. ${SITE_URL}`);
      }
      await tellBooker(
        b,
        `[VCLG Store Room] Booking confirmed: "${b.event}" (${dates(b)})`,
        `Hi ${b.name},\n\nYour event "${b.event}" is booked for ${dates(b)}${b.venue ? ` at ${b.venue}` : ''}. ${(b.lines || []).length ? 'These items are reserved for it:' : 'No items are reserved yet — you can add them by editing the event.'}\n\n${itemList(b)}\n\n` +
          `Collect them on ${fmtDay(b.startDate)} with "Move out" on the event, and return them by ${fmtDay(b.endDate)}. You will get a reminder the day before.\n${SITE_URL}\n\nVCLG Store Room`
      );
      return json(201, { booking: b, clashes: outcome.clashes });
    }

    if (!params.id) return json(400, { error: 'Missing id query parameter' });

    if (method === 'PUT') {
      const [items, loans] = await Promise.all([getItems(), getLoans()]);
      const who = access.user ? { name: access.user.name, email: access.user.email } : { name: 'Admin', email: '' };
      const outcome = await updateBookings((bookings) => {
        const booking = bookings.find((b) => b.id === params.id);
        if (!booking) return { response: json(404, { error: 'That event no longer exists' }) };
        const own = Boolean(access.user && booking.email && access.user.email === booking.email);
        if (!own && !canManage) return { response: json(403, { error: 'Only the person who booked this event (signed in), an admin or a Store Manager can change it' }) };
        if (booking.status !== 'booked') return { response: json(400, { error: `This event is ${booking.status} and can no longer be changed` }) };
        const input = readEventInput(body, items, { existing: booking, today });
        if (input.error) return { response: json(400, { error: input.error }) };
        const clashes = findClashes(input.lines, { start: input.fields.startDate, end: input.fields.endDate, excludeId: booking.id, items, bookings, loans, today });
        if (clashes.length && !(canManage && body.acceptClashes === true)) return { response: clashResponse(clashes, canManage) };

        const changes = [];
        for (const key of [...Object.keys(LIMITS), 'startDate', 'endDate']) {
          if ((booking[key] || '') !== (input.fields[key] || '')) changes.push(key === 'event' ? 'name' : key.replace(/([A-Z])/g, ' $1').toLowerCase());
        }
        const before = (booking.lines || []).map(lineText).join(', ');
        const after = input.lines.map(lineText).join(', ');
        if (before !== after) changes.push(`items: ${after || '(none)'}`);
        const next = {
          ...booking,
          ...input.fields,
          lines: input.lines,
          editedAt: new Date().toISOString(),
          history: (booking.history || []).concat(changes.length ? [historyEntry('edited', who, changes.join('; '))] : []),
        };
        if (clashes.length) next.clashesAccepted = clashes.map((c) => ({ itemName: c.itemName, wanted: c.wanted, available: c.available }));
        else delete next.clashesAccepted;
        return { save: bookings.map((b) => (b.id === booking.id ? next : b)), booking: next, own, changes, clashes };
      });
      if (outcome.response) return outcome.response;
      if (!outcome.own && outcome.changes.length) await audit(event, 'booking.edit', `Edited event ${describe(outcome.booking)}: ${outcome.changes.join('; ')}`);
      if (outcome.clashes.length) {
        await audit(event, 'booking.override', `Changed ${describe(outcome.booking)} over the available stock: ${outcome.clashes.map((c) => `"${c.itemName}" ${c.wanted} wanted, ${c.available} free`).join('; ')}`);
      }
      return json(200, { booking: outcome.booking, clashes: outcome.clashes });
    }

    if (method === 'DELETE') {
      if (!canManage) return json(401, { error: 'Admin or Store Manager access required', code: 'admin_required' });
      const outcome = await updateBookings((bookings) => {
        const booking = bookings.find((b) => b.id === params.id);
        if (!booking) return { response: json(404, { error: 'That event no longer exists' }) };
        return { save: bookings.filter((b) => b.id !== params.id), booking };
      });
      if (outcome.response) return outcome.response;
      await audit(event, 'booking.delete', `Deleted ${outcome.booking.status} event booking ${describe(outcome.booking)}`);
      return json(200, { booking: outcome.booking });
    }

    if (method === 'PATCH') {
      if (body.status !== 'cancelled') return json(400, { error: 'Only cancelling a booking is supported' });
      const who = access.user ? { name: access.user.name, email: access.user.email } : { name: 'Admin', email: '' };
      const outcome = await updateBookings((bookings) => {
        const booking = bookings.find((b) => b.id === params.id);
        if (!booking) return { response: json(404, { error: 'That booking no longer exists' }) };
        const own = Boolean(access.user && booking.email && access.user.email === booking.email);
        if (!own && !canManage) {
          return { response: json(403, { error: 'Only the person who made this booking (signed in), an admin or a Store Manager can cancel it' }) };
        }
        if (booking.status !== 'booked') {
          return {
            response: json(400, {
              error:
                booking.status === 'collected'
                  ? 'The items for this event have already been collected — return them instead of cancelling'
                  : `This booking is already ${booking.status}`,
            }),
          };
        }
        const next = {
          ...booking,
          status: 'cancelled',
          cancelledAt: new Date().toISOString(),
          cancelledBy: access.user ? access.user.email : 'admin',
          history: (booking.history || []).concat([historyEntry('cancelled', who, body.reason ? tidy(body.reason, 200) : '')]),
        };
        return { save: bookings.map((b) => (b.id === booking.id ? next : b)), booking: next, own };
      });
      if (outcome.response) return outcome.response;
      if (!outcome.own) {
        await audit(event, 'booking.cancel', `Cancelled booking ${describe(outcome.booking)}`);
        await tellBooker(
          outcome.booking,
          `[VCLG Store Room] Your booking "${outcome.booking.event}" was cancelled`,
          `Hi ${outcome.booking.name},\n\nYour event booking "${outcome.booking.event}" (${dates(outcome.booking)}) was cancelled by ${access.user ? access.user.name : 'an admin'}${body.reason ? `: ${tidy(body.reason, 200)}` : '.'}\n\nThe items it reserved are free again:\n${itemList(outcome.booking)}\n\nQuestions? Reply to this email. ${SITE_URL}\n\nVCLG Store Room`
        );
      }
      return json(200, { booking: outcome.booking });
    }
  } catch (err) {
    if (err && err.code === 'busy') return json(503, { error: err.message, code: 'busy' });
    throw err;
  }

  return { statusCode: 405, body: 'Method Not Allowed' };
};
