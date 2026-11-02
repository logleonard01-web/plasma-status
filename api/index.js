/**
 * api/index.js — Vercel serverless entry point
 *
 * This file is the single handler that Vercel routes ALL requests through.
 * It imports the Express app from the project root and ensures the one-time
 * startup sequence (license check, DB seed, initial status poll) has run
 * before the first request is forwarded.
 *
 * setInterval monitors run once per Vercel function invocation. On Vercel's
 * serverless runtime functions are short-lived, so reliable periodic checks
 * are driven by the Vercel Cron Job defined in vercel.json that hits
 * /api/cron/update on a schedule instead.
 */

'use strict';

const { app, runStartup } = require('../index');

let started = false;

module.exports = async (req, res) => {
  if (!started) {
    try {
      await runStartup();
      started = true;
    } catch (err) {
      console.error('[PlasmaStatus] Startup failed:', err);
      return res.status(503).send(
        `Startup failed: ${err.message}\n\nCheck Vercel logs for details.`
      );
    }
  }
  return app(req, res);
};
