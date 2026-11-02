/**
 * api/presence.js — Keep the Discord bot appearing "online"
 *
 * Vercel is serverless — no persistent gateway connection — so the bot
 * appears offline by default. This endpoint briefly logs in via the
 * Discord gateway, sets the bot's status to Online, then disconnects.
 *
 * To keep the bot appearing online, ping this endpoint every 5 minutes
 * using a free uptime monitor like UptimeRobot:
 *   https://uptimerobot.com  →  HTTP monitor → GET /api/presence?secret=...
 *
 * Required env vars:
 *   DISCORD_BOT_TOKEN  – Your Discord bot token
 *   REGISTER_SECRET    – Reuses the same secret as /api/register
 */

'use strict';

const { Client, GatewayIntentBits, ActivityType } = require('discord.js');

// How long to wait for the bot to connect before timing out (ms)
const CONNECT_TIMEOUT_MS = 8000;

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const secret = process.env.REGISTER_SECRET;
  if (!secret) return res.status(500).json({ error: 'REGISTER_SECRET env var not set.' });
  if (req.query.secret !== secret) return res.status(403).json({ error: 'Invalid secret.' });

  const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
  if (!BOT_TOKEN) return res.status(500).json({ error: 'DISCORD_BOT_TOKEN not set.' });

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  try {
    await Promise.race([
      new Promise((resolve, reject) => {
        client.once('ready', async () => {
          try {
            client.user.setPresence({
              status: 'online',
              activities: [{ name: 'status.plasmaplay.nyc', type: ActivityType.Watching }],
            });
            resolve();
          } catch (err) {
            reject(err);
          }
        });
        client.login(BOT_TOKEN).catch(reject);
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Gateway connect timeout')), CONNECT_TIMEOUT_MS)
      ),
    ]);

    // Brief pause so presence update propagates before we disconnect
    await new Promise(r => setTimeout(r, 1500));

    return res.json({ ok: true, status: 'online', tag: client.user?.tag ?? 'unknown' });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  } finally {
    client.destroy();
  }
};
