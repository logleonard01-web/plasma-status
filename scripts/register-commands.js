/**
 * scripts/register-commands.js
 *
 * Registers (or updates) the PlasmaStatus slash commands with Discord.
 * Run this ONCE after deploying to Vercel, or any time you change the
 * command definitions in discord-slash.js.
 *
 * Usage:
 *   node scripts/register-commands.js
 *
 * Required environment variables (or .env file):
 *   DISCORD_CLIENT_ID   – Your Discord Application / Client ID
 *   DISCORD_BOT_TOKEN   – Your Discord bot token
 *
 * Optional:
 *   DISCORD_GUILD_ID    – A specific server ID for instant registration
 *                         (guild commands update immediately; global commands
 *                         take up to 1 hour to propagate).
 *                         Leave unset to register globally.
 *
 * You can run this locally (not on Vercel) — it only needs network access
 * to Discord's API, not your deployed app.
 */

'use strict';

// Load a local .env file if present (dev convenience)
try {
  const fs   = require('fs');
  const path = require('path');
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8')
      .split('\n')
      .forEach(line => {
        const [k, ...v] = line.replace(/\r/, '').split('=');
        if (k && !k.startsWith('#') && !(k in process.env)) {
          process.env[k.trim()] = v.join('=').replace(/^["']|["']$/g, '').trim();
        }
      });
    console.log('[register] Loaded .env file');
  }
} catch {}

const https = require('https');
const { COMMANDS } = require('../discord-slash');

const APPLICATION_ID = process.env.DISCORD_CLIENT_ID;
const BOT_TOKEN      = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID       = process.env.DISCORD_GUILD_ID; // optional

if (!APPLICATION_ID || !BOT_TOKEN) {
  console.error(
    '\n❌  Missing required environment variables:\n' +
    (!APPLICATION_ID ? '   DISCORD_CLIENT_ID is not set\n' : '') +
    (!BOT_TOKEN      ? '   DISCORD_BOT_TOKEN is not set\n' : '') +
    '\nSet them in your .env file or shell, then re-run this script.\n'
  );
  process.exit(1);
}

const route = GUILD_ID
  ? `/api/v10/applications/${APPLICATION_ID}/guilds/${GUILD_ID}/commands`
  : `/api/v10/applications/${APPLICATION_ID}/commands`;

console.log(`\n📡  Registering ${COMMANDS.length} slash command(s) ${
  GUILD_ID ? `in guild ${GUILD_ID}` : 'globally'
}...`);

const body = JSON.stringify(COMMANDS);

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

const req = https.request(options, (res) => {
  let data = '';
  res.on('data', chunk => (data += chunk));
  res.on('end', () => {
    if (res.statusCode === 200 || res.statusCode === 201) {
      const commands = JSON.parse(data);
      console.log(`\n✅  ${commands.length} command(s) registered successfully:\n`);
      commands.forEach(c => console.log(`   /${c.name}  —  ${c.description}`));
      console.log('\n');
      if (!GUILD_ID) {
        console.log('ℹ️   Global commands can take up to 1 hour to appear in Discord.');
        console.log('    For instant registration, set DISCORD_GUILD_ID to your server ID.\n');
      }
    } else {
      console.error(`\n❌  Discord returned HTTP ${res.statusCode}:\n`);
      try {
        const err = JSON.parse(data);
        console.error(JSON.stringify(err, null, 2));
        if (err.message === '401: Unauthorized') {
          console.error('\nCheck that DISCORD_BOT_TOKEN is correct and the bot is in your server.');
        }
        if (err.code === 50001) {
          console.error('\nMissing Access — make sure the bot is in the target guild.');
        }
      } catch {
        console.error(data);
      }
      process.exit(1);
    }
  });
});

req.on('error', err => {
  console.error('\n❌  Request failed:', err.message);
  process.exit(1);
});

req.write(body);
req.end();
