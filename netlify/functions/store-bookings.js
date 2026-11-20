const { getItems, getLoans, getBookings, saveBookings, genId } = require('./_shared/store-blobs');
const { checkAccess, recordedBy, isAdmin } = require('./_shared/store-access');
const { audit } = require('./_shared/audit');
const { MAX_DAYS, MAX_AHEAD_DAYS, malaysiaToday, validDate, daysBetween, findClashes } = require('./_shared/bookings');

const MAX_EVENT = 120;
const MAX_NOTES = 500;
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

const describe = (b) => `"${b.event}" (${b.startDate}${b.endDate !== b.startDate ? ` to ${b.endDate}` : ''}) by ${b.name}`;

// GET                 — every booking (optionally ?itemId=)
// POST                — book items { event, startDate, endDate, lines, notes, name, employeeNo, acceptClashes }
//                       409 { code: 'clash', clashes } unless acceptClashes is true
// PATCH ?id=          — { status: 'cancelled' } by the person who booked it, or an admin
// DELETE ?id=         — admin: remove a booking record entirely
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

  if (method === 'POST') {
    const body = parseBody(event);
    if (!body) return json(400, { error: 'Invalid request body' });

    const who = recordedBy(access.user, body);
    const eventName = String(body.event || '').trim().replace(/\s+/g, ' ');
    const notes = String(body.notes || '').trim().slice(0, MAX_NOTES);
    const start = String(body.startDate || '').trim();
    const end = String(body.endDate || start).trim();
    const today = malaysiaToday();

    if (!who.name) return json(400, { error: 'Employee name is required' });
    if (!who.employeeNo) return json(400, { error: 'Employee number is required' });
    if (!eventName) return json(400, { error: 'Enter the event the items are for' });
    if (eventName.length > MAX_EVENT) return json(400, { error: `Event name is too long (${MAX_EVENT} characters at most)` });
    if (!validDate(start)) return json(400, { error: 'Pick the date the items are needed from' });
    if (!validDate(end)) return json(400, { error: 'Pick the date the items will be back (or the last day of the event)' });
    if (start < today) return json(400, { error: 'The start date has already passed' });
    if (end < start) return json(400, { error: 'The end date is before the start date' });
    if (daysBetween(start, end) > MAX_DAYS) return json(400, { error: `A booking can cover ${MAX_DAYS} days at most` });
    if (daysBetween(today, start) > MAX_AHEAD_DAYS) return json(400, { error: 'That is too far ahead — book within the next two years' });
    if (!Array.isArray(body.lines) || body.lines.length === 0) return json(400, { error: 'Add the items to book first' });
    if (body.lines.length > MAX_LINES) return json(400, { error: `${MAX_LINES} different items at most per booking` });

    const wanted = new Map();
    for (const line of body.lines) {
      const qty = Math.round(Number(line && line.quantity));
      if (!line || !line.itemId || !qty || qty <= 0) return json(400, { error: 'Every line needs an item and a quantity of at least 1' });
      wanted.set(line.itemId, (wanted.get(line.itemId) || 0) + qty);
    }

    const [items, loans, bookings] = await Promise.all([getItems(), getLoans(), getBookings()]);
    const lines = [];
    const problems = [];
    for (const [itemId, quantity] of wanted) {
      const item = items.find((i) => i.id === itemId);
      if (!item) {
        problems.push('An item in your list no longer exists — remove it and try again');
        continue;
      }
      if (quantity > item.quantity) problems.push(`"${item.name}": the store only has ${item.quantity} in total`);
      lines.push({ itemId, itemName: item.name, quantity, returnable: Boolean(item.returnable) });
    }
    if (problems.length) return json(400, { error: problems.join('; ') });

    const clashes = findClashes(lines, { start, end, items, bookings, loans, today });
    if (clashes.length && body.acceptClashes !== true) {
      return json(409, { code: 'clash', error: 'Some items are already booked or out on loan for those dates', clashes });
    }

    const booking = {
      id: genId('bkg'),
      event: eventName,
      startDate: start,
      endDate: end,
      lines,
      notes,
      ...who,
      status: 'booked',
      createdAt: new Date().toISOString(),
      clashesAccepted: clashes.length ? clashes.map((c) => ({ itemName: c.itemName, wanted: c.wanted, available: c.available })) : undefined,
    };
    // Re-read just before saving so a booking made a moment ago is not lost.
    const latest = await getBookings();
    latest.push(booking);
    await saveBookings(latest);
    return json(201, { booking, clashes });
  }

  if (method === 'PATCH' || method === 'DELETE') {
    if (!params.id) return json(400, { error: 'Missing id query parameter' });
    const bookings = await getBookings();
    const booking = bookings.find((b) => b.id === params.id);
    if (!booking) return json(404, { error: 'That booking no longer exists' });

    const admin = await isAdmin(event);
    if (method === 'DELETE') {
      if (!admin) return json(401, { error: 'Admin access required', code: 'admin_required' });
      await saveBookings(bookings.filter((b) => b !== booking));
      await audit(event, 'booking.delete', `Deleted ${booking.status} booking ${describe(booking)}`);
      return json(200, { booking });
    }

    const body = parseBody(event);
    if (!body || body.status !== 'cancelled') return json(400, { error: 'Only cancelling a booking is supported' });
    const own = Boolean(access.user && booking.email && access.user.email === booking.email);
    if (!own && !admin) {
      return json(403, { error: 'Only the person who made this booking (signed in) or an admin can cancel it' });
    }
    if (booking.status !== 'booked') return json(400, { error: `This booking is already ${booking.status}` });
    booking.status = 'cancelled';
    booking.cancelledAt = new Date().toISOString();
    booking.cancelledBy = access.user ? access.user.email : 'admin';
    await saveBookings(bookings);
    if (!own) await audit(event, 'booking.cancel', `Cancelled booking ${describe(booking)}`);
    return json(200, { booking });
  }

  return { statusCode: 405, body: 'Method Not Allowed' };
};
