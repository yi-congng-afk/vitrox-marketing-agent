const { getLoans, getReminderLog, saveReminderLog } = require('./store-blobs');
const { sendEmail, sendAlertEmail, emailConfigured } = require('./mailer');

// A person with overdue items is reminded the day after the due date, then
// every few days until everything is back — often enough to act on, not spam.
const REMIND_EVERY_DAYS = 3;
const SITE_URL = 'https://vitrox-college-store.netlify.app/';
const DAY_MS = 86400000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Due dates are Malaysian calendar dates, so "today" is taken in UTC+8.
function malaysiaToday(now) {
  return new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);
}

function daysBetween(fromYmd, toYmd) {
  return Math.round((Date.parse(toYmd + 'T00:00:00Z') - Date.parse(fromYmd + 'T00:00:00Z')) / DAY_MS);
}

const DAY_FORMAT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
function fmtDate(ymd) {
  const t = Date.parse(ymd + 'T00:00:00Z');
  return Number.isNaN(t) ? ymd : DAY_FORMAT.format(new Date(t));
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function loanLine(loan, today) {
  const outstanding = loan.quantity - loan.quantityReturned;
  const late = daysBetween(loan.expectedReturnDate, today);
  return (
    `- ${loan.itemName} × ${outstanding} — for ${loan.purpose || 'no purpose given'}, ` +
    `due ${fmtDate(loan.expectedReturnDate)} (${plural(late, 'day', 'days')} overdue)`
  );
}

function personEmail(loans, today) {
  const first = loans[0];
  const count = loans.reduce((sum, l) => sum + (l.quantity - l.quantityReturned), 0);
  return {
    subject: `[ViTrox Store] Reminder: please return ${plural(count, 'item', 'items')} to the store room`,
    text:
      `Hi ${first.name || 'there'},\n\n` +
      `Our records show you still have these items from the ViTrox College store room, and they are past their return date:\n\n` +
      loans.map((l) => loanLine(l, today)).join('\n') +
      `\n\nPlease bring them back to the store room, then press "Return" in the store dashboard:\n${SITE_URL}\n\n` +
      `Already returned them? Please reply to this email so the record can be corrected.\n\n` +
      `Thank you,\nViTrox College Store Room\n\n` +
      `(You will get this reminder every ${REMIND_EVERY_DAYS} days until the items are returned.)`,
  };
}

function adminSummary(reminded, failed, noEmail, today) {
  const section = (title, loans) =>
    loans.length
      ? `${title}\n` + loans.map((l) => `${loanLine(l, today)} — with ${l.name} (${l.employeeNo}${l.email ? ', ' + l.email : ''})`).join('\n') + '\n\n'
      : '';
  const total = reminded.length + failed.length + noEmail.length;
  return {
    subject: `[ViTrox Store] Overdue loans: ${plural(total, 'record needs', 'records need')} returning`,
    text:
      section('Borrowers reminded by email today:', reminded) +
      section('Reminder email could NOT be sent — please follow up yourself:', failed) +
      section('No email on record (they were not signed in when borrowing) — please follow up yourself:', noEmail) +
      `Loan records: ${SITE_URL}`,
  };
}

// Sends the reminders that are due today. Safe to run more than once a day:
// each loan is only reminded again after REMIND_EVERY_DAYS.
async function runReminders({ now = new Date(), trigger = 'schedule' } = {}) {
  const today = malaysiaToday(now);
  const [loans, log] = await Promise.all([getLoans(), getReminderLog()]);
  const byLoan = { ...(log.byLoan || {}) };

  const overdue = loans.filter(
    (l) => l.status === 'open' && l.expectedReturnDate && l.expectedReturnDate < today && l.quantity - l.quantityReturned > 0
  );
  const due = overdue.filter((l) => !byLoan[l.id] || daysBetween(byLoan[l.id], today) >= REMIND_EVERY_DAYS);

  const result = {
    at: now.toISOString(),
    trigger,
    emailReady: emailConfigured(),
    overdue: overdue.length,
    due: due.length,
    peopleEmailed: 0,
    failed: 0,
    noEmail: 0,
    adminNotified: false,
  };

  if (result.emailReady && due.length > 0) {
    const byPerson = new Map();
    const noEmail = [];
    for (const loan of due) {
      const email = String(loan.email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(email)) {
        noEmail.push(loan);
        continue;
      }
      if (!byPerson.has(email)) byPerson.set(email, []);
      byPerson.get(email).push(loan);
    }

    const reminded = [];
    const failed = [];
    for (const [email, personLoans] of byPerson) {
      const sent = await sendEmail({ to: email, ...personEmail(personLoans, today) });
      if (sent.sent) {
        result.peopleEmailed++;
        personLoans.forEach((l) => {
          byLoan[l.id] = today;
          reminded.push(l);
        });
      } else {
        failed.push(...personLoans);
      }
    }
    result.failed = failed.length;
    result.noEmail = noEmail.length;

    const { subject, text } = adminSummary(reminded, failed, noEmail, today);
    const summary = await sendAlertEmail(subject, text);
    result.adminNotified = summary.sent;
    // Loans nobody could be emailed about count as handled once the admin has been told.
    if (summary.sent) [...failed, ...noEmail].forEach((l) => (byLoan[l.id] = today));
  }

  // Forget loans that are no longer outstanding, so the log stays small.
  const stillOpen = new Set(overdue.map((l) => l.id));
  Object.keys(byLoan).forEach((id) => {
    if (!stillOpen.has(id)) delete byLoan[id];
  });

  await saveReminderLog({ byLoan, lastRun: result });
  return result;
}

module.exports = { runReminders, malaysiaToday, REMIND_EVERY_DAYS };
