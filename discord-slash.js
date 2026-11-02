/**
 * discord-slash.js
 *
 * Slash command definitions (for registration) and response builders (for
 * the interactions endpoint). This file has no long-running state — it is
 * loaded by the Vercel serverless function on every invocation.
 *
 * Commands:
 *   /status              – overall status or a specific service
 *   /uptime [service]    – uptime percentages
 *   /check               – trigger a fresh service check right now
 *   /incident create     – post a new incident  (staff only)
 *   /incident resolve    – resolve the current incident (staff only)
 *   /incident list       – list recent incidents
 *   /embed setup         – post a live auto-updating status embed (staff only)
 *   /embed remove        – remove the auto-updating embed (staff only)
 */

'use strict';

// ---------------------------------------------------------------------------
// Command definitions (sent to Discord's API once via register-commands.js)
// ---------------------------------------------------------------------------
const COMMANDS = [
  {
    name: 'status',
    description: 'Show the current status of all services (or one specific service).',
    options: [
      {
        type: 3, // STRING
        name: 'service',
        description: 'Name of a specific service to inspect (leave blank for all).',
        required: false,
      },
    ],
  },
  {
    name: 'uptime',
    description: 'Show uptime percentages for all monitored services.',
    options: [
      {
        type: 4, // INTEGER
        name: 'days',
        description: 'How many days of history to use (1–90, default 30).',
        required: false,
        min_value: 1,
        max_value: 90,
      },
    ],
  },
  {
    name: 'check',
    description: 'Trigger an immediate live check of all services.',
  },
  {
    name: 'embed',
    description: 'Manage the live auto-updating status embed.',
    options: [
      {
        type: 1, // SUB_COMMAND
        name: 'setup',
        description: 'Post a live status embed that updates automatically. (Staff only)',
        options: [
          {
            type: 7, // CHANNEL
            name: 'channel',
            description: 'Channel to post the status embed in.',
            required: true,
            channel_types: [0], // GUILD_TEXT
          },
        ],
      },
      {
        type: 1, // SUB_COMMAND
        name: 'remove',
        description: 'Stop the auto-updating embed and delete the message. (Staff only)',
      },
    ],
  },
  {
    name: 'incident',
    description: 'Manage service incidents.',
    options: [
      {
        type: 1, // SUB_COMMAND
        name: 'create',
        description: 'Post a new incident update.',
        options: [
          {
            type: 3, // STRING
            name: 'message',
            description: 'What happened? (Shown on the status page and in Discord.)',
            required: true,
          },
          {
            type: 3, // STRING
            name: 'type',
            description: 'Severity level (defaults to "investigating").',
            required: false,
            choices: [
              { name: '🔍 Investigating', value: 'investigating' },
              { name: '⚠️ Identified', value: 'identified' },
              { name: '🔧 Monitoring', value: 'monitoring' },
              { name: '✅ Resolved', value: 'resolved' },
            ],
          },
        ],
      },
      {
        type: 1, // SUB_COMMAND
        name: 'resolve',
        description: 'Mark the current incident as resolved.',
      },
      {
        type: 1, // SUB_COMMAND
        name: 'list',
        description: 'Show recent incidents.',
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Discord colour constants
// ---------------------------------------------------------------------------
const COLOR = {
  online:      0x4caf50,
  offline:     0xf44336,
  partial:     0xe67e22,
  maintenance: 0x9b59b6,
  info:        0x5e99ff,
  neutral:     0x2b2d31,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function statusEmoji(status) {
  switch (status) {
    case 'online':      return '🟢';
    case 'offline':     return '🔴';
    case 'maintenance': return '🔧';
    default:            return '🟠';
  }
}

function statusLabel(status) {
  if (!status) return 'Unknown';
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function overallColor(services) {
  if (!services.length) return COLOR.neutral;
  const online = services.filter(s => s.currentStatus === 'online').length;
  if (online === services.length) return COLOR.online;
  if (online === 0)               return COLOR.offline;
  return COLOR.partial;
}

function relativeTimestamp(date) {
  return `<t:${Math.floor(new Date(date).getTime() / 1000)}:R>`;
}

// ---------------------------------------------------------------------------
// Response builders
// ---------------------------------------------------------------------------

/**
 * Build the /status embed for all services.
 */
function buildStatusAllEmbed(services, siteName, lastUpdated) {
  const byCategory = services.reduce((acc, svc) => {
    const cat = svc.category || 'Uncategorised';
    (acc[cat] = acc[cat] || []).push(svc);
    return acc;
  }, {});

  const online  = services.filter(s => s.currentStatus === 'online').length;
  const total   = services.length;
  const offline = services.filter(s => s.currentStatus === 'offline').length;

  let overallText = '✅ All systems operational';
  if (offline === total)   overallText = '🔴 Major outage — all services offline';
  else if (offline > 0)    overallText = `⚠️ Partial outage — ${offline} service${offline > 1 ? 's' : ''} offline`;

  const fields = Object.entries(byCategory).map(([cat, svcs]) => ({
    name: `__${cat}__`,
    value: svcs
      .map(s => `${statusEmoji(s.currentStatus)} **${s.name}** — ${statusLabel(s.currentStatus)}`)
      .join('\n'),
    inline: false,
  }));

  fields.push({
    name: '📊 Summary',
    value: `**${online}/${total}** services online`,
    inline: true,
  });

  if (lastUpdated) {
    fields.push({
      name: '🕐 Last checked',
      value: relativeTimestamp(lastUpdated),
      inline: true,
    });
  }

  return {
    embeds: [{
      title: `${siteName || 'PlasmaStatus'} — System Status`,
      description: overallText,
      color: overallColor(services),
      fields,
      footer: { text: 'PlasmaStatus • /status' },
      timestamp: new Date().toISOString(),
    }],
  };
}

/**
 * Build the /status embed for a single service.
 */
function buildStatusOneEmbed(service, siteName) {
  const history = (service.history || []).slice(-10).reverse();
  const historyStr = history.length
    ? history.map(h => `${statusEmoji(h.status)} ${relativeTimestamp(h.timestamp)}`).join('\n')
    : '_No history yet_';

  const totalEntries = service.history ? service.history.length : 0;
  const onlineEntries = service.history
    ? service.history.filter(h => h.status === 'online').length
    : 0;
  const uptimePct = totalEntries ? ((onlineEntries / totalEntries) * 100).toFixed(1) : 'N/A';

  const fields = [
    { name: 'Status',    value: `${statusEmoji(service.currentStatus)} ${statusLabel(service.currentStatus)}`, inline: true },
    { name: 'Type',      value: service.type || 'website',                   inline: true },
    { name: 'Uptime',    value: `${uptimePct}%`,                             inline: true },
    { name: 'Category',  value: service.category || 'Uncategorised',        inline: true },
  ];

  if (service.lastResponseTime) {
    fields.push({ name: 'Response time', value: `${service.lastResponseTime}ms`, inline: true });
  }

  fields.push({ name: 'Recent checks', value: historyStr, inline: false });

  const colorKey = service.currentStatus === 'online' ? 'online'
    : service.currentStatus === 'offline'     ? 'offline'
    : 'maintenance';

  return {
    embeds: [{
      title: `${statusEmoji(service.currentStatus)} ${service.name}`,
      color: COLOR[colorKey],
      fields,
      footer: { text: `${siteName || 'PlasmaStatus'} • /status ${service.name}` },
      timestamp: new Date().toISOString(),
    }],
  };
}

/**
 * Build the /uptime embed.
 */
function buildUptimeEmbed(services, days, siteName) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  const rows = services.map(svc => {
    const relevant = (svc.history || []).filter(h => new Date(h.timestamp).getTime() > cutoff);
    const total    = relevant.length;
    const online   = relevant.filter(h => h.status === 'online').length;
    const pct      = total ? ((online / total) * 100).toFixed(1) : 'N/A';
    const bar      = buildUptimeBar(pct);
    return `${statusEmoji(svc.currentStatus)} **${svc.name}** ${bar} ${pct === 'N/A' ? '—' : `${pct}%`}`;
  });

  return {
    embeds: [{
      title: `📈 Uptime — last ${days} day${days === 1 ? '' : 's'}`,
      description: rows.join('\n') || '_No services configured_',
      color: COLOR.info,
      footer: { text: `${siteName || 'PlasmaStatus'} • /uptime` },
      timestamp: new Date().toISOString(),
    }],
  };
}

function buildUptimeBar(pct) {
  if (pct === 'N/A') return '░░░░░░░░░░';
  const filled = Math.round(parseFloat(pct) / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

/**
 * Build the /check deferred followup embed.
 */
function buildCheckEmbed(services, siteName, durationMs) {
  const online = services.filter(s => s.currentStatus === 'online').length;
  const total  = services.length;
  return {
    embeds: [{
      title: '🔄 Live check complete',
      description: `Checked **${total}** services in **${(durationMs / 1000).toFixed(1)}s** — **${online}/${total}** online.`,
      color: overallColor(services),
      footer: { text: `${siteName || 'PlasmaStatus'} • /check` },
      timestamp: new Date().toISOString(),
    }],
  };
}

/**
 * Build the /incident list embed.
 */
function buildIncidentListEmbed(incidents, siteName) {
  if (!incidents.length) {
    return {
      embeds: [{
        title: '📋 Recent incidents',
        description: '✅ No incidents in the last 30 days.',
        color: COLOR.online,
        footer: { text: siteName || 'PlasmaStatus' },
      }],
    };
  }

  const items = incidents.slice(0, 10).map(inc => {
    const ts = relativeTimestamp(inc.createdAt || inc.timestamp);
    return `**${inc.type ? `[${inc.type.toUpperCase()}]` : ''}** ${inc.message} — ${ts}`;
  });

  return {
    embeds: [{
      title: '📋 Recent incidents',
      description: items.join('\n\n'),
      color: COLOR.info,
      footer: { text: `${siteName || 'PlasmaStatus'} • /incident list` },
    }],
  };
}

// ---------------------------------------------------------------------------
// Auto-embed builder & REST editor
// ---------------------------------------------------------------------------

/**
 * Build the persistent auto-updating status embed payload.
 * Slightly richer than /status — shows a footer note that it updates live.
 */
function buildAutoStatusEmbed(services, siteName, lastUpdated) {
  const base = buildStatusAllEmbed(services, siteName, lastUpdated);
  const embed = base.embeds[0];
  embed.footer = { text: `${siteName || 'PlasmaStatus'} • Auto-updating status` };
  // Overwrite timestamp so it reflects the actual check time
  embed.timestamp = lastUpdated ? new Date(lastUpdated).toISOString() : new Date().toISOString();
  return { embeds: [embed] };
}

/**
 * Create a new status message in a channel via Discord REST.
 * Returns { id, channel_id } from the created message.
 */
async function createEmbedMessage(botToken, channelId, services, siteName, lastUpdated) {
  const axios = require('axios');
  const payload = buildAutoStatusEmbed(services, siteName, lastUpdated);
  const { data } = await axios.post(
    `https://discord.com/api/v10/channels/${channelId}/messages`,
    payload,
    { headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' } }
  );
  return data;
}

/**
 * Edit the existing persistent status message in place.
 * Called every time updateStatuses() completes.
 * Silently swallows errors so a stale message ID never breaks the app.
 */
async function editEmbedMessage(botToken, channelId, messageId, services, siteName, lastUpdated) {
  try {
    const axios = require('axios');
    const payload = buildAutoStatusEmbed(services, siteName, lastUpdated);
    await axios.patch(
      `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`,
      payload,
      { headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    // Log but never throw — a failed embed edit must not crash the status check
    console.warn('[AutoEmbed] Failed to edit message:', err?.response?.data || err.message);
  }
}

/**
 * Delete the existing persistent status message.
 * Called when /embed remove is used.
 */
async function deleteEmbedMessage(botToken, channelId, messageId) {
  try {
    const axios = require('axios');
    await axios.delete(
      `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`,
      { headers: { Authorization: `Bot ${botToken}` } }
    );
  } catch (err) {
    console.warn('[AutoEmbed] Failed to delete message:', err?.response?.data || err.message);
  }
}

// ---------------------------------------------------------------------------
// Interaction response helpers
// ---------------------------------------------------------------------------

/** Immediate message response */
function reply(content_or_data, ephemeral = false) {
  const isString = typeof content_or_data === 'string';
  const data = isString
    ? { content: content_or_data }
    : content_or_data;
  if (ephemeral) data.flags = 64;
  return { type: 4, data };
}

/** Deferred response — Vercel will follow up via REST */
function defer(ephemeral = false) {
  return { type: 5, data: ephemeral ? { flags: 64 } : {} };
}

/** Edit a deferred reply via Discord REST */
async function followUp(applicationId, interactionToken, data) {
  const axios = require('axios');
  const url = `https://discord.com/api/v10/webhooks/${applicationId}/${interactionToken}/messages/@original`;
  await axios.patch(url, data, {
    headers: { 'Content-Type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  COMMANDS,
  COLOR,
  statusEmoji,
  buildStatusAllEmbed,
  buildStatusOneEmbed,
  buildUptimeEmbed,
  buildCheckEmbed,
  buildIncidentListEmbed,
  buildAutoStatusEmbed,
  createEmbedMessage,
  editEmbedMessage,
  deleteEmbedMessage,
  reply,
  defer,
  followUp,
};
