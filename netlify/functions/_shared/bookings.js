// Event bookings: items reserved for an event on future dates.
//
// A booking is { id, event, startDate, endDate (YYYY-MM-DD, Malaysia dates),
// lines: [{ itemId, itemName, quantity }], name, employeeNo, email?, notes,
// status: 'booked' | 'collected' | 'cancelled', createdAt, ... }.
//
// Bookings never block anything: they only warn when the same items are
// wanted by more than the store can cover.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 60;
const MAX_AHEAD_DAYS = 2 * 366;

function malaysiaToday(now = new Date()) {
  return new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function validDate(ymd) {
  if (!DATE_RE.test(ymd || '')) return false;
  const d = new Date(`${ymd}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === ymd;
}

function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

// Still to happen (or happening now) and not yet collected or cancelled.
function isLive(booking, today) {
  return booking.status === 'booked' && booking.endDate >= today;
}

function quantityOf(booking, itemId) {
  return (booking.lines || []).filter((l) => l.itemId === itemId).reduce((sum, l) => sum + (l.quantity || 0), 0);
}

// How many of an item could go to a booking on these dates, and what else
// wants them. Loanable items come back, so only bookings on overlapping dates
// compete, plus loans still out then. Consumables are used up, so every live
// booking competes for the current stock.
function availabilityFor(item, { start, end, excludeId, bookings, loans, today }) {
  const competing = bookings.filter(
    (b) =>
      b.id !== excludeId &&
      isLive(b, today) &&
      quantityOf(b, item.id) > 0 &&
      (!item.returnable || (b.startDate <= end && b.endDate >= start))
  );
  let out = 0;
  if (item.returnable) {
    for (const loan of loans) {
      if (loan.itemId !== item.id || loan.status !== 'open') continue;
      const due = loan.expectedReturnDate || '';
      // Expected back before the event starts (and not overdue): counts as back.
      if (due && due >= today && due < start) continue;
      out += Math.max(0, loan.quantity - loan.quantityReturned);
    }
  }
  const booked = competing.reduce((sum, b) => sum + quantityOf(b, item.id), 0);
  return {
    total: item.quantity,
    out,
    booked,
    available: item.quantity - out - booked,
    conflicts: competing.map((b) => ({
      id: b.id,
      event: b.event,
      startDate: b.startDate,
      endDate: b.endDate,
      name: b.name,
      quantity: quantityOf(b, item.id),
    })),
  };
}

// Lines that want more than is available: [{ itemId, itemName, wanted, available, out, conflicts }]
function findClashes(lines, { start, end, excludeId, items, bookings, loans, today }) {
  // Designs of one item share its stock, so add them up per item first.
  const wanted = new Map();
  for (const line of lines) wanted.set(line.itemId, (wanted.get(line.itemId) || 0) + (line.quantity || 0));
  const clashes = [];
  for (const [itemId, quantity] of wanted) {
    const item = items.find((i) => i.id === itemId);
    if (!item) continue;
    const a = availabilityFor(item, { start, end, excludeId, bookings, loans, today });
    if (quantity > a.available) {
      clashes.push({
        itemId: item.id,
        itemName: item.name,
        returnable: Boolean(item.returnable),
        wanted: quantity,
        available: Math.max(0, a.available),
        total: a.total,
        out: a.out,
        conflicts: a.conflicts,
      });
    }
  }
  return clashes;
}

module.exports = { DATE_RE, MAX_DAYS, MAX_AHEAD_DAYS, malaysiaToday, validDate, daysBetween, isLive, quantityOf, availabilityFor, findClashes };
