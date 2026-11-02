/**
 * api/cron/update.js — Vercel Cron Job handler
 *
 * Vercel calls this endpoint on the schedule defined in vercel.json
 * (default: every 5 minutes). It triggers a full status check for all
 * services, replicating what the setInterval in index.js does on a
 * long-running server.
 *
 * The endpoint is protected by the CRON_SECRET environment variable.
 * Vercel automatically sets the Authorization header when it calls a
 * cron route, so outside callers without the secret will receive 401.
 *
 * To invoke manually (e.g. testing):
 *   curl -H "Authorization: Bearer <CRON_SECRET>" https://your-domain.vercel.app/api/cron/update
 */

'use strict';

const { triggerStatusUpdate } = require('../../index');

module.exports = async (req, res) => {
  // Verify the request comes from Vercel's cron scheduler or an authorised caller.
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || authHeader !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  try {
    console.log('[CRON] Running scheduled status update...');
    await triggerStatusUpdate();
    console.log('[CRON] Status update complete.');
    return res.status(200).json({ ok: true, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('[CRON] Status update failed:', err);
    return res.status(500).json({ error: 'Status update failed', message: err.message });
  }
};
