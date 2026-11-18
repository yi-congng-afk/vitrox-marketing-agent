const { runReminders } = require('./_shared/reminders');

// Runs every morning on Netlify's scheduler (see netlify.toml). Scheduled
// functions cannot be opened by URL on the live site; admins can run the same
// job from the Alerts panel ("Send reminders now"), which goes via store-loans.
exports.handler = async () => {
  const result = await runReminders({ trigger: 'schedule' });
  console.log('Overdue reminders:', JSON.stringify(result));
  return { statusCode: 200, body: JSON.stringify(result) };
};
