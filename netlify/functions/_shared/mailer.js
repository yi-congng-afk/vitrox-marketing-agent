const nodemailer = require('nodemailer');

let cachedTransporter;

function getTransporter() {
  if (cachedTransporter !== undefined) return cachedTransporter;

  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    cachedTransporter = null;
    return cachedTransporter;
  }

  cachedTransporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 587,
    secure: Number(SMTP_PORT) === 465,
    requireTLS: Number(SMTP_PORT) !== 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  return cachedTransporter;
}

function emailConfigured() {
  return Boolean(getTransporter());
}

function adminEmail() {
  return process.env.ALERT_EMAIL_TO || 'yi-cong.ng@vitrox.com';
}

// Never throws: a store action must not fail because an email could not go out.
// Returns { sent: true } or { sent: false, reason }.
async function sendEmail({ to, subject, text }) {
  const transporter = getTransporter();
  if (!transporter) {
    console.log('SMTP not configured (SMTP_HOST/SMTP_USER/SMTP_PASS missing) — skipping email:', subject);
    return { sent: false, reason: 'not_configured' };
  }
  try {
    await transporter.sendMail({ from: process.env.SMTP_USER, to, subject, text });
    return { sent: true };
  } catch (err) {
    console.error('Failed to send email:', subject, err.message);
    return { sent: false, reason: 'failed', message: err.message };
  }
}

// Store alerts (low stock, damage reports, overdue summaries) go to the admin.
function sendAlertEmail(subject, text) {
  return sendEmail({ to: adminEmail(), subject, text });
}

module.exports = { sendEmail, sendAlertEmail, emailConfigured, adminEmail };
