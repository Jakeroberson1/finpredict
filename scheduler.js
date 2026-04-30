require('dotenv').config();
const cron = require('node-cron');
const { scoreAll } = require('./scorer');
const db = require('./db');

// Daily at 6:30am ET — refresh quantitative scores from FMP (no Gemma)
cron.schedule('30 6 * * 1-5', async () => {
  console.log('[Scheduler] Daily quantitative refresh started');
  db.logRefresh('daily', 'started', 'Daily quantitative scoring run');
  try {
    await scoreAll(false);
    db.logRefresh('daily', 'success', 'Daily quantitative scoring complete');
  } catch (err) {
    db.logRefresh('daily', 'error', err.message);
    console.error('[Scheduler] Daily refresh failed:', err.message);
  }
}, { timezone: 'America/New_York' });

// Weekly Sunday at 8pm ET — full Gemma qualitative re-scoring
cron.schedule('0 20 * * 0', async () => {
  console.log('[Scheduler] Weekly Gemma qualitative refresh started');
  db.logRefresh('weekly', 'started', 'Weekly Gemma qualitative scoring run');
  try {
    await scoreAll(true);
    db.logRefresh('weekly', 'success', 'Weekly Gemma qualitative scoring complete');
  } catch (err) {
    db.logRefresh('weekly', 'error', err.message);
    console.error('[Scheduler] Weekly Gemma refresh failed:', err.message);
  }
}, { timezone: 'America/New_York' });

console.log('[Scheduler] Jobs registered:');
console.log('  - Daily quant refresh: Mon–Fri 6:30am ET');
console.log('  - Weekly Gemma refresh: Sunday 8pm ET');

module.exports = {};
