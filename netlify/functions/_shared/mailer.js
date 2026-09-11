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

async function sendAlertEmail(subject, text) {
  const transporter = getTransporter();
  if (!transporter) {
    console.log('SMTP not configured (SMTP_HOST/SMTP_USER/SMTP_PASS missing) — skipping email:', subject);
    return;
  }

  const to = process.env.ALERT_EMAIL_TO || 'yi-cong.ng@vitrox.com';
  try {
    await transporter.sendMail({
      from: process.env.SMTP_USER,
      to,
      subject,
      text,
    });
  } catch (err) {
    console.error('Failed to send alert email:', err.message);
  }
}

module.exports = { sendAlertEmail };
