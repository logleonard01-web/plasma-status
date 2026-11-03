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
 *   /freedns server status   – FreeDNS scraper server status
 *   /freedns server changes  – most recent domain additions/removals
 *   /freedns domains list    – paginated domain list
 *   /freedns domains search  – search domains by keyword
 *   /freedns domains count   – total domain count
 *   /freedns check           – all filter results for one domain
 *   /freedns filter list     – progress overview for all 38 filters
 *   /freedns filter info     – domains unblocked on a specific filter
 *   /freedns filter skip     – skip list for a specific filter
 *   /freedns filter blocked  – how many domains are blocked on a filter
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
  // -------------------------------------------------------------------------
  // /freedns — FreeDNS domain & filter explorer
  // -------------------------------------------------------------------------
  {
    name: 'freedns',
    description: 'Explore FreeDNS domains and filter check results.',
    options: [
      // ── server group ──────────────────────────────────────────────────────
      {
        type: 2, // SUB_COMMAND_GROUP
        name: 'server',
        description: 'FreeDNS scraper server info.',
        options: [
          {
            type: 1, // SUB_COMMAND
            name: 'status',
            description: 'Full server status — domain count, last scrape, VPN state, uptime, etc.',
          },
          {
            type: 1, // SUB_COMMAND
            name: 'changes',
            description: 'Domains added and removed in the most recent scrape.',
          },
        ],
      },
      // ── domains group ─────────────────────────────────────────────────────
      {
        type: 2, // SUB_COMMAND_GROUP
        name: 'domains',
        description: 'Browse and search FreeDNS domains.',
        options: [
          {
            type: 1, // SUB_COMMAND
            name: 'list',
            description: 'Show a page of FreeDNS domains.',
            options: [
              {
                type: 4, // INTEGER
                name: 'page',
                description: 'Page number (each page shows 20 domains, default 1).',
                required: false,
                min_value: 1,
              },
            ],
          },
          {
            type: 1, // SUB_COMMAND
            name: 'search',
            description: 'Search FreeDNS domains for a keyword.',
            options: [
              {
                type: 3, // STRING
                name: 'query',
                description: 'Text to search for (e.g. "chat", "free", "us").',
                required: true,
              },
            ],
          },
          {
            type: 1, // SUB_COMMAND
            name: 'count',
            description: 'How many FreeDNS domains are currently tracked.',
          },
        ],
      },
      // ── check subcommand ──────────────────────────────────────────────────
      {
        type: 1, // SUB_COMMAND
        name: 'check',
        description: 'Show every filter\'s result for one specific domain.',
        options: [
          {
            type: 3, // STRING
            name: 'domain',
            description: 'The domain to look up (e.g. mooo.com).',
            required: true,
          },
        ],
      },
      // ── filter group ──────────────────────────────────────────────────────
      {
        type: 2, // SUB_COMMAND_GROUP
        name: 'filter',
        description: 'Inspect content-filter check results.',
        options: [
          {
            type: 1, // SUB_COMMAND
            name: 'list',
            description: 'Progress overview for all 38 content filters.',
          },
          {
            type: 1, // SUB_COMMAND
            name: 'info',
            description: 'Domains that passed (unblocked) a specific filter.',
            options: [
              {
                type: 3, // STRING
                name: 'name',
                description: 'Filter name (e.g. securly, goguardian, lightspeed).',
                required: true,
                choices: [
                  { name: 'lightspeed',    value: 'lightspeed'    },
                  { name: 'fortiguard',    value: 'fortiguard'    },
                  { name: 'palo',          value: 'palo'          },
                  { name: 'securly',       value: 'securly'       },
                  { name: 'umbrella',      value: 'umbrella'      },
                  { name: 'linewize',      value: 'linewize'      },
                  { name: 'goguardian',    value: 'goguardian'    },
                  { name: 'dnsfilter',     value: 'dnsfilter'     },
                  { name: 'iboss',         value: 'iboss'         },
                  { name: 'nextdns',       value: 'nextdns'       },
                  { name: 'adguard',       value: 'adguard'       },
                  { name: 'cleanbrowsing', value: 'cleanbrowsing' },
                  { name: 'cisco',         value: 'cisco'         },
                  { name: 'forcepoint',    value: 'forcepoint'    },
                  { name: 'sophos',        value: 'sophos'        },
                  { name: 'barracuda',     value: 'barracuda'     },
                  { name: 'blocksi',       value: 'blocksi'       },
                  { name: 'qustodio',      value: 'qustodio'      },
                  { name: 'watchguard',    value: 'watchguard'    },
                  { name: 'safesurfer',    value: 'safesurfer'    },
                  { name: 'controld',      value: 'controld'      },
                  { name: 'smoothwall',    value: 'smoothwall'    },
                  { name: 'fortinet',      value: 'fortinet'      },
                  { name: 'hapara',        value: 'hapara'        },
                  { name: 'paloalto',      value: 'paloalto'      },
                ],
              },
            ],
          },
          {
            type: 1, // SUB_COMMAND
            name: 'skip',
            description: 'Domains permanently skipped (blocked) on a specific filter.',
            options: [
              {
                type: 3, // STRING
                name: 'name',
                description: 'Filter name (e.g. securly, goguardian, lightspeed).',
                required: true,
                choices: [
                  { name: 'lightspeed',    value: 'lightspeed'    },
                  { name: 'fortiguard',    value: 'fortiguard'    },
                  { name: 'palo',          value: 'palo'          },
                  { name: 'securly',       value: 'securly'       },
                  { name: 'umbrella',      value: 'umbrella'      },
                  { name: 'linewize',      value: 'linewize'      },
                  { name: 'goguardian',    value: 'goguardian'    },
                  { name: 'dnsfilter',     value: 'dnsfilter'     },
                  { name: 'iboss',         value: 'iboss'         },
                  { name: 'nextdns',       value: 'nextdns'       },
                  { name: 'adguard',       value: 'adguard'       },
                  { name: 'cleanbrowsing', value: 'cleanbrowsing' },
                  { name: 'cisco',         value: 'cisco'         },
                  { name: 'forcepoint',    value: 'forcepoint'    },
                  { name: 'sophos',        value: 'sophos'        },
                  { name: 'barracuda',     value: 'barracuda'     },
                  { name: 'blocksi',       value: 'blocksi'       },
                  { name: 'qustodio',      value: 'qustodio'      },
                  { name: 'watchguard',    value: 'watchguard'    },
                  { name: 'safesurfer',    value: 'safesurfer'    },
                  { name: 'controld',      value: 'controld'      },
                  { name: 'smoothwall',    value: 'smoothwall'    },
                  { name: 'fortinet',      value: 'fortinet'      },
                  { name: 'hapara',        value: 'hapara'        },
                  { name: 'paloalto',      value: 'paloalto'      },
                ],
              },
            ],
          },
          {
            type: 1, // SUB_COMMAND
            name: 'blocked',
            description: 'How many domains are on a filter\'s block/skip list.',
            options: [
              {
                type: 3, // STRING
                name: 'name',
                description: 'Filter name (e.g. securly, goguardian, lightspeed).',
                required: true,
              },
            ],
          },
        ],
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
// FreeDNS API helpers & response builders
// ---------------------------------------------------------------------------

const FREEDNS_BASE = process.env.FREEDNS_API_URL || 'http://163.123.238.146:5206';

async function freednsGet(path) {
  const axios = require('axios');
  const { data } = await axios.get(`${FREEDNS_BASE}${path}`, { timeout: 8000 });
  return data;
}

/** /freedns server status */
async function buildFreeDnsServerStatus() {
  const s = await freednsGet('/api/status');
  const uptime = s.uptimeSeconds != null
    ? (() => {
        const h = Math.floor(s.uptimeSeconds / 3600);
        const m = Math.floor((s.uptimeSeconds % 3600) / 60);
        return h ? `${h}h ${m}m` : `${m}m`;
      })()
    : 'N/A';

  const fields = [
    { name: '📦 Domain count',  value: String(s.count ?? 'N/A'),    inline: true },
    { name: '🔄 Scraping now',  value: s.scraping ? 'Yes' : 'No',   inline: true },
    { name: '🌐 VPN',           value: s.vpn      ? 'Active' : 'Off', inline: true },
    { name: '🟢 Ready',         value: s.ready    ? 'Yes' : 'No',   inline: true },
    { name: '⏱️ Uptime',        value: uptime,                       inline: true },
    { name: '🔍 Filter check',  value: s.filterCheck ? 'Running' : 'Idle', inline: true },
  ];

  if (s.lastCheck)   fields.push({ name: '🕐 Last check',   value: `<t:${Math.floor(new Date(s.lastCheck).getTime()/1000)}:R>`,   inline: true });
  if (s.lastSuccess) fields.push({ name: '✅ Last success', value: `<t:${Math.floor(new Date(s.lastSuccess).getTime()/1000)}:R>`, inline: true });
  if (s.nextScrape)  fields.push({ name: '⏭️ Next scrape',  value: `<t:${Math.floor(new Date(s.nextScrape).getTime()/1000)}:R>`,  inline: true });
  if (s.lastError)   fields.push({ name: '❌ Last error',   value: `\`${String(s.lastError).slice(0, 200)}\``,                    inline: false });

  return reply({
    embeds: [{
      title: '🌐 FreeDNS Scraper — Server Status',
      color: s.ready ? COLOR.online : COLOR.partial,
      fields,
      footer: { text: 'FreeDNS API • /freedns server status' },
      timestamp: new Date().toISOString(),
    }],
  });
}

/** /freedns server changes */
async function buildFreeDnsChanges() {
  const c = await freednsGet('/api/changes');
  const at = c.at ? `<t:${Math.floor(new Date(c.at).getTime()/1000)}:F>` : 'N/A';
  const added   = (c.added   || []).slice(0, 20);
  const removed = (c.removed || []).slice(0, 20);

  const fields = [];
  if (added.length)   fields.push({ name: `✅ Added (${c.added?.length ?? 0})`,   value: added.join(', ')   || '—', inline: false });
  if (removed.length) fields.push({ name: `❌ Removed (${c.removed?.length ?? 0})`, value: removed.join(', ') || '—', inline: false });

  return reply({
    embeds: [{
      title: '📋 FreeDNS — Recent Changes',
      description: `Scrape at ${at}`,
      color: COLOR.info,
      fields: fields.length ? fields : [{ name: 'No changes', value: 'No domains were added or removed in the last scrape.', inline: false }],
      footer: { text: 'FreeDNS API • /freedns server changes' },
    }],
  });
}

/** /freedns domains list [page] */
async function buildFreeDnsDomainList(page = 1) {
  const raw  = await freednsGet('/domains.txt');
  const all  = raw.split(',').map(d => d.trim()).filter(Boolean);
  const PAGE = 20;
  const total = all.length;
  const totalPages = Math.ceil(total / PAGE);
  const p    = Math.max(1, Math.min(page, totalPages));
  const slice = all.slice((p - 1) * PAGE, p * PAGE);

  return reply({
    embeds: [{
      title: `🌐 FreeDNS Domains — Page ${p}/${totalPages}`,
      description: slice.map((d, i) => `\`${(p-1)*PAGE + i + 1}.\` ${d}`).join('\n'),
      color: COLOR.info,
      footer: { text: `${total} total domains • /freedns domains list page:${p}` },
    }],
  });
}

/** /freedns domains search <query> */
async function buildFreeDnsSearch(query) {
  const raw = await freednsGet('/domains.txt');
  const all = raw.split(',').map(d => d.trim()).filter(Boolean);
  const q   = query.toLowerCase();
  const matches = all.filter(d => d.includes(q)).slice(0, 25);

  if (!matches.length) {
    return reply(`🔍 No FreeDNS domains match **${query}**.`, true);
  }

  return reply({
    embeds: [{
      title: `🔍 FreeDNS Search: "${query}"`,
      description: matches.map((d, i) => `\`${i+1}.\` ${d}`).join('\n'),
      color: COLOR.info,
      footer: { text: `Showing ${matches.length} result${matches.length !== 1 ? 's' : ''} (max 25) • /freedns domains search` },
    }],
  });
}

/** /freedns domains count */
async function buildFreeDnsCount() {
  const s = await freednsGet('/api/status');
  return reply({
    embeds: [{
      title: '📦 FreeDNS Domain Count',
      description: `**${(s.count ?? 0).toLocaleString()}** domains currently tracked.`,
      color: COLOR.info,
      footer: { text: 'FreeDNS API • /freedns domains count' },
      timestamp: new Date().toISOString(),
    }],
  });
}

/** /freedns check <domain> */
async function buildFreeDnsCheck(domain) {
  let data;
  try {
    data = await freednsGet(`/api/results/${encodeURIComponent(domain)}`);
  } catch (err) {
    if (err?.response?.status === 404) {
      return reply(`❌ No results for **${domain}** yet — it may not be a tracked FreeDNS domain or hasn't been checked yet.`, true);
    }
    throw err;
  }

  const results = data.results || {};
  const entries = Object.entries(results);
  if (!entries.length) {
    return reply(`ℹ️ **${domain}** is tracked but hasn't been checked on any filter yet.`, true);
  }

  const passed  = entries.filter(([, v]) => !v.blocked);
  const blocked = entries.filter(([, v]) =>  v.blocked);

  const passedStr  = passed.length  ? passed.map(([f, v])  => `🟢 **${f}**${v.category ? ` — ${v.category}` : ''}`).join('\n') : '—';
  const blockedStr = blocked.length ? blocked.map(([f, v]) => `🔴 **${f}**${v.category ? ` — ${v.category}` : ''}`).join('\n') : '—';

  return reply({
    embeds: [{
      title: `🔍 Filter results: ${domain}`,
      color: blocked.length === 0 ? COLOR.online : (passed.length === 0 ? COLOR.offline : COLOR.partial),
      fields: [
        { name: `✅ Passed (${passed.length})`,  value: passedStr.slice(0, 1024),  inline: false },
        { name: `❌ Blocked (${blocked.length})`, value: blockedStr.slice(0, 1024), inline: false },
      ],
      footer: { text: `${entries.length} filters checked • /freedns check` },
      timestamp: new Date().toISOString(),
    }],
  });
}

/** /freedns filter list */
async function buildFreeDnsFilterList() {
  const data = await freednsGet('/api/filters');
  const filters = data.filters || {};
  const entries = Object.entries(filters).slice(0, 25);

  const rows = entries.map(([name, f]) => {
    const phase   = f.phase ? ` (${f.phase})` : '';
    const running = f.running ? '🔄' : (f.enabled ? '✅' : '⏸️');
    const checked = f.checkedThisRun != null ? ` — ${f.checkedThisRun} checked` : '';
    return `${running} **${name}**${phase}${checked}`;
  });

  return reply({
    embeds: [{
      title: '🔍 FreeDNS — Filter Status Overview',
      description: rows.join('\n') || '_No filter data yet_',
      color: COLOR.info,
      footer: { text: `${entries.length} filters shown • /freedns filter list` },
      timestamp: new Date().toISOString(),
    }],
  });
}

/** /freedns filter info <name> */
async function buildFreeDnsFilterInfo(name) {
  let raw;
  try {
    raw = await freednsGet(`/api/filters/${encodeURIComponent(name)}`);
  } catch (err) {
    if (err?.response?.status === 404) return reply(`❌ Filter **${name}** not found or has no data yet.`, true);
    throw err;
  }
  const domains = raw.split(',').map(d => d.trim()).filter(Boolean);
  const preview = domains.slice(0, 30).join(', ');
  return reply({
    embeds: [{
      title: `✅ Unblocked on ${name}`,
      description: preview || '_No unblocked domains yet_',
      color: COLOR.online,
      footer: { text: `${domains.length} unblocked domains • /freedns filter info` },
    }],
  });
}

/** /freedns filter skip <name> */
async function buildFreeDnsFilterSkip(name) {
  let raw;
  try {
    raw = await freednsGet(`/api/filters/${encodeURIComponent(name)}/skip`);
  } catch (err) {
    if (err?.response?.status === 404) return reply(`❌ Filter **${name}** not found or has no skip list yet.`, true);
    throw err;
  }
  const domains = raw.split(',').map(d => d.trim()).filter(Boolean);
  const preview = domains.slice(0, 30).join(', ');
  return reply({
    embeds: [{
      title: `🚫 Skip list (blocked) on ${name}`,
      description: preview || '_Skip list is empty_',
      color: COLOR.offline,
      footer: { text: `${domains.length} blocked domains • /freedns filter skip` },
    }],
  });
}

/** /freedns filter blocked <name> — count only */
async function buildFreeDnsFilterBlocked(name) {
  let raw;
  try {
    raw = await freednsGet(`/api/filters/${encodeURIComponent(name)}/skip`);
  } catch (err) {
    if (err?.response?.status === 404) return reply(`❌ Filter **${name}** not found or has no data yet.`, true);
    throw err;
  }
  const count = raw.split(',').map(d => d.trim()).filter(Boolean).length;
  return reply({
    embeds: [{
      title: `🚫 ${name} — Blocked Domain Count`,
      description: `**${count.toLocaleString()}** domains are permanently blocked on **${name}**.`,
      color: count === 0 ? COLOR.online : COLOR.offline,
      footer: { text: 'FreeDNS API • /freedns filter blocked' },
    }],
  });
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
  // FreeDNS builders
  buildFreeDnsServerStatus,
  buildFreeDnsChanges,
  buildFreeDnsDomainList,
  buildFreeDnsSearch,
  buildFreeDnsCount,
  buildFreeDnsCheck,
  buildFreeDnsFilterList,
  buildFreeDnsFilterInfo,
  buildFreeDnsFilterSkip,
  buildFreeDnsFilterBlocked,
};
