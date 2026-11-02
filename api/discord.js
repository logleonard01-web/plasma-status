/**
 * api/discord.js — Discord Interactions endpoint
 *
 * Discord sends HTTP POST requests to this URL whenever a slash command is
 * used. This works entirely on Vercel's free tier — no persistent bot process,
 * no cron jobs, no WebSocket connection.
 *
 * Set this URL as the "Interactions Endpoint URL" in the Discord Developer
 * Portal under your application's General Information tab:
 *   https://your-vercel-app.vercel.app/api/discord
 *
 * Required environment variable: DISCORD_PUBLIC_KEY
 */

'use strict';

const nacl     = require('tweetnacl');
const mongoose = require('mongoose');
const { applyEnv }     = require('../env-config');
const settingsLoader   = require('../settings');
const slash = require('../discord-slash');

// ---------------------------------------------------------------------------
// Lazy DB connection (reused across warm invocations)
// ---------------------------------------------------------------------------
let dbReady = false;
async function ensureDb() {
  if (dbReady && mongoose.connection.readyState === 1) return;
  const cfg = settingsLoader.getConfig ? settingsLoader.getConfig() : settingsLoader.fileConfig;
  const uri = cfg.MongoURI;
  if (!uri || uri.includes('mongo:27017')) {
    throw new Error('MONGODB_URI is not configured. Set it in Vercel environment variables.');
  }
  await mongoose.connect(uri, {
    maxPoolSize: 5,
    serverSelectionTimeoutMS: 5000,
  });
  dbReady = true;
}

// ---------------------------------------------------------------------------
// Ed25519 signature verification (Discord requires this)
// ---------------------------------------------------------------------------
function verifySignature(publicKey, signature, timestamp, rawBody) {
  try {
    return nacl.sign.detached.verify(
      Buffer.from(timestamp + rawBody),
      Buffer.from(signature, 'hex'),
      Buffer.from(publicKey, 'hex')
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Raw body capture middleware (nacl needs the exact bytes Discord sent)
// ---------------------------------------------------------------------------
function rawBodyBuffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end',  () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function handleStatus(interaction, cfg) {
  const Service      = mongoose.model('Service');
  const StatusUpdate = mongoose.model('StatusUpdate');
  const serviceArg   = interaction.data.options?.find(o => o.name === 'service')?.value;

  if (serviceArg) {
    // Single service lookup
    const svc = await Service.findOne({
      name: { $regex: new RegExp(serviceArg, 'i') },
    }).lean();
    if (!svc) return slash.reply(`❌ No service found matching **${serviceArg}**.`, true);
    return slash.reply(slash.buildStatusOneEmbed(svc, cfg.PageSettings?.Name));
  }

  // All services
  const [services, lastUpdate] = await Promise.all([
    Service.find().lean(),
    StatusUpdate.findOne().sort({ createdAt: -1 }).lean(),
  ]);
  return slash.reply(
    slash.buildStatusAllEmbed(services, cfg.PageSettings?.Name, lastUpdate?.lastUpdated)
  );
}

async function handleUptime(interaction, cfg) {
  const Service = mongoose.model('Service');
  const days    = interaction.data.options?.find(o => o.name === 'days')?.value ?? 30;
  const services = await Service.find().lean();
  return slash.reply(slash.buildUptimeEmbed(services, days, cfg.PageSettings?.Name));
}

async function handleCheck(interaction, cfg, applicationId) {
  // Deferred — the actual check can take several seconds
  // We fire-and-forget the async work after returning the defer ACK.
  // The follow-up is sent to Discord via their REST webhook.
  const token = interaction.token;

  setImmediate(async () => {
    try {
      // Lazy-import the main app's updateStatuses to avoid circular deps
      // The function is attached to global by api/index.js when it starts.
      const { triggerStatusUpdate } = require('../index');
      const t0 = Date.now();
      await triggerStatusUpdate();
      const dt = Date.now() - t0;

      const Service = mongoose.model('Service');
      const services = await Service.find().lean();
      await slash.followUp(applicationId, token,
        slash.buildCheckEmbed(services, cfg.PageSettings?.Name, dt));
    } catch (err) {
      await slash.followUp(applicationId, token,
        { content: `❌ Check failed: ${err.message}` }).catch(() => {});
    }
  });

  return slash.defer();
}

async function handleEmbedSetup(interaction, cfg, isStaff) {
  if (!isStaff) return slash.reply('🔒 This command is restricted to staff.', true);

  const botToken = cfg.DiscordBot?.Token;
  if (!botToken) return slash.reply('❌ `DISCORD_BOT_TOKEN` is not configured.', true);

  const channelId = interaction.data.options?.[0]?.options?.find(o => o.name === 'channel')?.value;
  if (!channelId) return slash.reply('❌ Please specify a channel.', true);

  const Settings = mongoose.model('Settings');
  const Service  = mongoose.model('Service');
  const StatusUpdate = mongoose.model('StatusUpdate');

  const [services, lastUpdate] = await Promise.all([
    Service.find().lean(),
    StatusUpdate.findOne().sort({ createdAt: -1 }).lean(),
  ]);

  // Post the initial embed to the channel
  let created;
  try {
    created = await slash.createEmbedMessage(
      botToken, channelId, services,
      cfg.PageSettings?.Name, lastUpdate?.lastUpdated
    );
  } catch (err) {
    const msg = err?.response?.data?.message || err.message;
    return slash.reply(`❌ Could not post embed: ${msg}\nMake sure the bot has **Send Messages** and **Embed Links** permissions in that channel.`, true);
  }

  // Persist channelId + messageId so every future status check edits this message
  await Settings.findOneAndUpdate(
    {},
    {
      $set: {
        'AutoEmbed.channelId': channelId,
        'AutoEmbed.messageId': created.id,
        'AutoEmbed.guildId':   interaction.guild_id || '',
        'AutoEmbed.enabledAt': new Date(),
      },
    },
    { upsert: true }
  );

  return slash.reply({
    embeds: [{
      title: '✅ Auto-embed enabled',
      description: `A live status embed has been posted in <#${channelId}>.\n\nIt will update automatically every time a status check runs (page load or \`/check\`).`,
      color: slash.COLOR.online,
      fields: [
        { name: 'Channel', value: `<#${channelId}>`, inline: true },
        { name: 'Message ID', value: created.id, inline: true },
      ],
      footer: { text: 'Run /embed remove to stop and delete the embed.' },
      timestamp: new Date().toISOString(),
    }],
  });
}

async function handleEmbedRemove(interaction, cfg, isStaff) {
  if (!isStaff) return slash.reply('🔒 This command is restricted to staff.', true);

  const botToken = cfg.DiscordBot?.Token;
  const Settings = mongoose.model('Settings');
  const settings = await Settings.findOne().lean();

  const { channelId, messageId } = settings?.AutoEmbed || {};
  if (!channelId || !messageId) {
    return slash.reply('ℹ️ No auto-embed is currently active.', true);
  }

  // Delete the Discord message (best-effort)
  if (botToken) {
    await slash.deleteEmbedMessage(botToken, channelId, messageId);
  }

  // Clear from DB
  await Settings.findOneAndUpdate({}, {
    $set: {
      'AutoEmbed.channelId': '',
      'AutoEmbed.messageId': '',
      'AutoEmbed.guildId':   '',
    },
    $unset: { 'AutoEmbed.enabledAt': '' },
  });

  return slash.reply({
    embeds: [{
      title: '🗑️ Auto-embed removed',
      description: `The live status embed in <#${channelId}> has been deleted and auto-updates are disabled.`,
      color: slash.COLOR.neutral,
      footer: { text: 'Run /embed setup to re-enable.' },
    }],
  });
}

async function handleIncidentCreate(interaction, cfg, isStaff) {
  if (!isStaff) return slash.reply('🔒 This command is restricted to staff.', true);

  const StatusUpdate = mongoose.model('StatusUpdate');
  const message  = interaction.data.options[0].options?.find(o => o.name === 'message')?.value;
  const type     = interaction.data.options[0].options?.find(o => o.name === 'type')?.value || 'investigating';

  await StatusUpdate.create({ message, type, lastUpdated: new Date() });

  return slash.reply({
    embeds: [{
      title: '📢 Incident created',
      description: message,
      color: slash.COLOR.partial,
      fields: [{ name: 'Type', value: type, inline: true }],
      footer: { text: cfg.PageSettings?.Name || 'PlasmaStatus' },
      timestamp: new Date().toISOString(),
    }],
  });
}

async function handleIncidentResolve(interaction, cfg, isStaff) {
  if (!isStaff) return slash.reply('🔒 This command is restricted to staff.', true);

  const StatusUpdate = mongoose.model('StatusUpdate');
  const latest = await StatusUpdate.findOne().sort({ createdAt: -1 });
  if (!latest) return slash.reply('No active incidents found.', true);

  latest.message = latest.message + ' *(Resolved)*';
  latest.type    = 'resolved';
  await latest.save();

  return slash.reply({
    embeds: [{
      title: '✅ Incident resolved',
      description: latest.message,
      color: slash.COLOR.online,
      footer: { text: cfg.PageSettings?.Name || 'PlasmaStatus' },
      timestamp: new Date().toISOString(),
    }],
  });
}

async function handleIncidentList(interaction, cfg) {
  const StatusUpdate = mongoose.model('StatusUpdate');
  const cutoff   = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const incidents = await StatusUpdate.find({ createdAt: { $gte: cutoff } })
    .sort({ createdAt: -1 })
    .limit(10)
    .lean();
  return slash.reply(slash.buildIncidentListEmbed(incidents, cfg.PageSettings?.Name));
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const publicKey = process.env.DISCORD_PUBLIC_KEY;
  if (!publicKey) {
    return res.status(500).json({ error: 'DISCORD_PUBLIC_KEY environment variable is not set.' });
  }

  // Collect raw body for signature verification
  const rawBody  = (await rawBodyBuffer(req)).toString();
  const signature = req.headers['x-signature-ed25519'];
  const timestamp = req.headers['x-signature-timestamp'];

  if (!verifySignature(publicKey, signature, timestamp, rawBody)) {
    return res.status(401).json({ error: 'Invalid request signature' });
  }

  const interaction = JSON.parse(rawBody);

  // PING — Discord sends this to verify the endpoint
  if (interaction.type === 1) {
    return res.json({ type: 1 });
  }

  // APPLICATION_COMMAND (type 2)
  if (interaction.type === 2) {
    try {
      await ensureDb();
      // Seed settings if this is the first ever request
      await settingsLoader.seedIfNeeded();
      const cfg = settingsLoader.getConfig();

      const ownerIds = Array.isArray(cfg.OwnerID) ? cfg.OwnerID : [cfg.OwnerID];
      const isStaff  = ownerIds.includes(interaction.member?.user?.id || interaction.user?.id);
      const applicationId = interaction.application_id;

      let response;
      const cmd = interaction.data.name;

      switch (cmd) {
        case 'status':
          response = await handleStatus(interaction, cfg);
          break;
        case 'uptime':
          response = await handleUptime(interaction, cfg);
          break;
        case 'check':
          response = await handleCheck(interaction, cfg, applicationId);
          break;
        case 'embed': {
          const sub = interaction.data.options?.[0]?.name;
          if (sub === 'setup')  response = await handleEmbedSetup(interaction, cfg, isStaff);
          else                  response = await handleEmbedRemove(interaction, cfg, isStaff);
          break;
        }
        case 'incident': {
          const sub = interaction.data.options?.[0]?.name;
          if (sub === 'create')  response = await handleIncidentCreate(interaction, cfg, isStaff);
          else if (sub === 'resolve') response = await handleIncidentResolve(interaction, cfg, isStaff);
          else                   response = await handleIncidentList(interaction, cfg);
          break;
        }
        default:
          response = slash.reply('❓ Unknown command.', true);
      }

      return res.json(response);
    } catch (err) {
      console.error('[Discord Interactions] Error:', err);
      return res.json(slash.reply(`❌ Error: ${err.message}`, true));
    }
  }

  return res.status(400).json({ error: 'Unhandled interaction type' });
};
