/**
 * api/register.js
 *
 * One-time slash command registration endpoint.
 * Hit GET /api/register?secret=<REGISTER_SECRET> to register all slash commands.
 *
 * Required env vars:
 *   DISCORD_CLIENT_ID   – Your Discord Application / Client ID
 *   DISCORD_BOT_TOKEN   – Your Discord bot token
 *   REGISTER_SECRET     – Any random string you set; protects the endpoint
 *
 * Optional:
 *   DISCORD_GUILD_ID    – If set, registers to that guild (instant). Otherwise registers globally (up to 1hr).
 */

'use strict';

const https = require('https');
const { COMMANDS } = require('../discord-slash');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const secret = process.env.REGISTER_SECRET;
  if (!secret) return res.status(500).json({ error: 'REGISTER_SECRET env var not set.' });
  if (req.query.secret !== secret) return res.status(403).json({ error: 'Invalid secret.' });

  const APPLICATION_ID = process.env.DISCORD_CLIENT_ID;
  const BOT_TOKEN      = process.env.DISCORD_BOT_TOKEN;
  const GUILD_ID       = process.env.DISCORD_GUILD_ID;

  if (!APPLICATION_ID || !BOT_TOKEN) {
    return res.status(500).json({ error: 'DISCORD_CLIENT_ID or DISCORD_BOT_TOKEN not set.' });
  }

  const route = GUILD_ID
    ? `/api/v10/applications/${APPLICATION_ID}/guilds/${GUILD_ID}/commands`
    : `/api/v10/applications/${APPLICATION_ID}/commands`;

  const body = JSON.stringify(COMMANDS);

  const result = await new Promise((resolve, reject) => {
    const options = {
      hostname: 'discord.com',
      path: route,
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Authorization: `Bot ${BOT_TOKEN}`,
      },
    };
    const req2 = https.request(options, r => {
      let data = '';
      r.on('data', c => (data += c));
      r.on('end', () => resolve({ status: r.statusCode, body: data }));
    });
    req2.on('error', reject);
    req2.write(body);
    req2.end();
  });

  if (result.status === 200 || result.status === 201) {
    const commands = JSON.parse(result.body);
    return res.json({
      ok: true,
      registered: commands.map(c => `/${c.name}`),
      note: GUILD_ID ? 'Guild commands registered — instant.' : 'Global commands registered — appear in all servers within ~1 hour.',
    });
  }

  return res.status(result.status).json({ ok: false, discord: JSON.parse(result.body) });
};
