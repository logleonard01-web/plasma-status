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
  // /freedns — AIO interactive panel (buttons + selects + modal)
  {
    name: 'freedns',
    description: 'FreeDNS domain & filter tracker — interactive all-in-one panel.',
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
// FreeDNS AIO — all-in-one interactive panel (buttons + selects + modals)
// ---------------------------------------------------------------------------

const FREEDNS_BASE = process.env.FREEDNS_API_URL || 'http://163.123.238.146:5206';

// All 38 known filters split into two groups of ≤25 for Discord select menus
const FILTERS_A = [
  'lightspeed','fortiguard','palo','securly','umbrella','linewize','router',
  'blocksi','blocksiai','goguardian','dnsfilter','iboss','gaggle',
  'contentkeeper','aristotle','senso','lanschool','deledao','nextdns',
  'redstar','unifi','barracuda','sophos','qustodio','cleanbrowsing',
];
const FILTERS_B = [
  'controld','cira','safesurfer','watchguard','adguard','forcepoint',
  'forcepointai','fortinet','paloalto','cisco','smoothwall','ruckus','hapara',
];

async function freednsGet(path) {
  const axios = require('axios');
  const { data } = await axios.get(`${FREEDNS_BASE}${path}`, { timeout: 8000 });
  return data;
}

// ── component helpers ────────────────────────────────────────────────────────

/** Single-line action row of up to 5 buttons */
function btnRow(...buttons) {
  return { type: 1, components: buttons };
}

/** Button */
function btn(label, custom_id, style = 2, emoji) {
  const b = { type: 2, style, label, custom_id };
  if (emoji) b.emoji = typeof emoji === 'string' ? { name: emoji } : emoji;
  return b;
}

/** Danger (red) button */
function btnDanger(label, custom_id) { return btn(label, custom_id, 4); }

/** Link button */
function btnLink(label, url) { return { type: 2, style: 5, label, url }; }

/** String select menu */
function selectMenu(custom_id, placeholder, options) {
  return {
    type: 1,
    components: [{
      type: 3, custom_id, placeholder,
      options: options.map(o => typeof o === 'string'
        ? { label: o, value: o }
        : o),
    }],
  };
}

// ── home panel ───────────────────────────────────────────────────────────────

async function buildFreeDnsHome() {
  const s = await freednsGet('/api/status');
  const uptime = s.uptimeSeconds != null
    ? (() => { const h = Math.floor(s.uptimeSeconds / 3600); const m = Math.floor((s.uptimeSeconds % 3600) / 60); return h ? `${h}h ${m}m` : `${m}m`; })()
    : 'N/A';

  const embed = {
    title: '🌐 FreeDNS Tracker',
    color: s.ready ? COLOR.online : COLOR.partial,
    fields: [
      { name: '📦 Domains tracked', value: String(s.count ?? '…'),              inline: true },
      { name: '🟢 Ready',           value: s.ready    ? 'Yes' : 'No',           inline: true },
      { name: '🔄 Scraping',        value: s.scraping ? 'Yes' : 'Idle',         inline: true },
      { name: '🔍 Filter check',    value: s.filterCheck ? 'Running' : 'Idle',  inline: true },
      { name: '🌐 VPN',             value: s.vpn      ? 'Active' : 'Off',       inline: true },
      { name: '⏱️ Uptime',          value: uptime,                              inline: true },
    ],
    footer: { text: 'Use the buttons below to explore • FreeDNS AIO' },
    timestamp: new Date().toISOString(),
  };
  if (s.lastCheck) embed.fields.push({ name: '🕐 Last check', value: `<t:${Math.floor(new Date(s.lastCheck).getTime()/1000)}:R>`, inline: true });
  if (s.nextScrape) embed.fields.push({ name: '⏭️ Next scrape', value: `<t:${Math.floor(new Date(s.nextScrape).getTime()/1000)}:R>`, inline: true });

  return {
    embeds: [embed],
    components: [
      btnRow(
        btn('📡 Server Status', 'fn:status'),
        btn('📋 Changes',       'fn:changes'),
        btn('🌐 Domains',       'fn:domains:1'),
        btn('🔍 Check Domain',  'fn:check_modal'),
        btn('🔎 Filters',       'fn:filters'),
      ),
    ],
  };
}

// ── server status panel ──────────────────────────────────────────────────────

async function buildFreeDnsStatus() {
  const s = await freednsGet('/api/status');
  const uptime = s.uptimeSeconds != null
    ? (() => { const h = Math.floor(s.uptimeSeconds / 3600); const m = Math.floor((s.uptimeSeconds % 3600) / 60); return h ? `${h}h ${m}m` : `${m}m`; })()
    : 'N/A';

  const fields = [
    { name: '📦 Domains',      value: String(s.count ?? 'N/A'),              inline: true },
    { name: '🟢 Ready',        value: s.ready    ? 'Yes' : 'No',             inline: true },
    { name: '🔄 Scraping',     value: s.scraping ? 'Yes' : 'Idle',           inline: true },
    { name: '🔍 Filter check', value: s.filterCheck ? 'Running' : 'Idle',    inline: true },
    { name: '🌐 VPN',          value: s.vpn      ? 'Active' : 'Off',         inline: true },
    { name: '⏱️ Uptime',       value: uptime,                                inline: true },
  ];
  if (s.lastCheck)   fields.push({ name: '🕐 Last check',   value: `<t:${Math.floor(new Date(s.lastCheck).getTime()/1000)}:R>`,   inline: true });
  if (s.lastSuccess) fields.push({ name: '✅ Last success', value: `<t:${Math.floor(new Date(s.lastSuccess).getTime()/1000)}:R>`, inline: true });
  if (s.nextScrape)  fields.push({ name: '⏭️ Next scrape',  value: `<t:${Math.floor(new Date(s.nextScrape).getTime()/1000)}:R>`,  inline: true });
  if (s.lastError)   fields.push({ name: '❌ Last error',   value: `\`${String(s.lastError).slice(0, 200)}\``,                    inline: false });

  return {
    embeds: [{ title: '📡 FreeDNS — Server Status', color: s.ready ? COLOR.online : COLOR.partial, fields, timestamp: new Date().toISOString() }],
    components: [btnRow(btn('🏠 Home', 'fn:home'), btn('📋 Changes', 'fn:changes'), btn('🌐 Domains', 'fn:domains:1'))],
  };
}

// ── changes panel ────────────────────────────────────────────────────────────

async function buildFreeDnsChanges() {
  const c = await freednsGet('/api/changes');
  const at = c.at ? `<t:${Math.floor(new Date(c.at).getTime()/1000)}:F>` : 'N/A';
  const added   = (c.added   || []).slice(0, 20);
  const removed = (c.removed || []).slice(0, 20);
  const fields = [];
  if (added.length)   fields.push({ name: `✅ Added (${c.added?.length ?? 0})`,   value: added.join(', ')   || '—', inline: false });
  if (removed.length) fields.push({ name: `❌ Removed (${c.removed?.length ?? 0})`, value: removed.join(', ') || '—', inline: false });

  return {
    embeds: [{
      title: '📋 FreeDNS — Recent Changes',
      description: `Last scrape: ${at}`,
      color: COLOR.info,
      fields: fields.length ? fields : [{ name: 'No changes', value: 'Nothing added or removed in the last scrape.', inline: false }],
    }],
    components: [btnRow(btn('🏠 Home', 'fn:home'), btn('📡 Status', 'fn:status'))],
  };
}

// ── domains panel ────────────────────────────────────────────────────────────

async function buildFreeDnsDomains(page = 1) {
  const raw = await freednsGet('/domains.txt');
  const all  = raw.split(',').map(d => d.trim()).filter(Boolean);
  const PAGE = 20;
  const total = all.length;
  const totalPages = Math.ceil(total / PAGE) || 1;
  const p = Math.max(1, Math.min(page, totalPages));
  const slice = all.slice((p - 1) * PAGE, p * PAGE);

  const navBtns = [btn('🏠 Home', 'fn:home')];
  if (p > 1)           navBtns.push(btn('◀ Prev', `fn:domains:${p - 1}`));
  if (p < totalPages)  navBtns.push(btn('▶ Next', `fn:domains:${p + 1}`));
  navBtns.push(btn('🔎 Filters', 'fn:filters'));

  return {
    embeds: [{
      title: `🌐 FreeDNS Domains — Page ${p} of ${totalPages}`,
      description: slice.map((d, i) => `\`${(p-1)*PAGE + i + 1}.\` ${d}`).join('\n'),
      color: COLOR.info,
      footer: { text: `${total.toLocaleString()} total domains` },
    }],
    components: [btnRow(...navBtns)],
  };
}

// ── filter overview panel ─────────────────────────────────────────────────────

async function buildFreeDnsFilters() {
  const data    = await freednsGet('/api/filters');
  const filters = data.filters || {};
  const rows = Object.entries(filters).map(([name, f]) => {
    const icon = f.running ? '🔄' : (f.enabled ? '✅' : '⏸️');
    const phase = f.phase ? ` *(${f.phase})*` : '';
    const cnt   = f.checkedThisRun != null ? ` — ${f.checkedThisRun} checked` : '';
    return `${icon} **${name}**${phase}${cnt}`;
  });

  const makeOpts = (names, prefix) => names.map(n => ({
    label: n,
    value: `${prefix}:${n}`,
    description: `View ${prefix === 'u' ? 'unblocked' : 'skip'} list`,
  }));

  return {
    embeds: [{
      title: '🔎 FreeDNS — Filter Overview',
      description: rows.join('\n') || '_No filter data yet_',
      color: COLOR.info,
      footer: { text: 'Select a filter below to inspect its results' },
      timestamp: new Date().toISOString(),
    }],
    components: [
      btnRow(btn('🏠 Home', 'fn:home'), btn('📡 Status', 'fn:status'), btn('🌐 Domains', 'fn:domains:1')),
      selectMenu('fn:filter_a', '🟢 Unblocked list — filters 1–25…', makeOpts(FILTERS_A, 'u')),
      selectMenu('fn:filter_b', '🟢 Unblocked list — filters 26–38…', makeOpts(FILTERS_B, 'u')),
      selectMenu('fn:filter_skip_a', '🔴 Skip/blocked list — filters 1–25…', makeOpts(FILTERS_A, 's')),
      selectMenu('fn:filter_skip_b', '🔴 Skip/blocked list — filters 26–38…', makeOpts(FILTERS_B, 's')),
    ],
  };
}

// ── filter detail panel ───────────────────────────────────────────────────────

async function buildFreeDnsFilterDetail(filterName, mode /* 'u' | 's' */) {
  const path = mode === 's'
    ? `/api/filters/${encodeURIComponent(filterName)}/skip`
    : `/api/filters/${encodeURIComponent(filterName)}`;
  let raw;
  try {
    raw = await freednsGet(path);
  } catch (err) {
    if (err?.response?.status === 404) {
      return {
        embeds: [{ title: `❌ ${filterName}`, description: 'No data yet — filter hasn\'t been checked or doesn\'t exist.', color: COLOR.offline }],
        components: [btnRow(btn('🏠 Home', 'fn:home'), btn('🔎 Filters', 'fn:filters'))],
      };
    }
    throw err;
  }
  const domains = raw.split(',').map(d => d.trim()).filter(Boolean);
  const preview = domains.slice(0, 40).join(', ');
  const isSkip  = mode === 's';
  const title   = isSkip
    ? `🔴 ${filterName} — Skip/Blocked List`
    : `🟢 ${filterName} — Unblocked Domains`;

  return {
    embeds: [{
      title,
      description: preview || '_Empty list_',
      color: isSkip ? COLOR.offline : COLOR.online,
      footer: { text: `${domains.length.toLocaleString()} domains${domains.length > 40 ? ' (showing first 40)' : ''}` },
    }],
    components: [
      btnRow(
        btn('🏠 Home', 'fn:home'),
        btn('🔎 Filters', 'fn:filters'),
        btn(isSkip ? '🟢 View Unblocked' : '🔴 View Skip List', `fn:filter_detail:${isSkip ? 'u' : 's'}:${filterName}`),
      ),
    ],
  };
}

// ── check domain panel ────────────────────────────────────────────────────────

async function buildFreeDnsCheckResult(domain) {
  let data;
  try {
    data = await freednsGet(`/api/results/${encodeURIComponent(domain)}`);
  } catch (err) {
    if (err?.response?.status === 404) {
      return { embeds: [{ title: `❌ ${domain}`, description: 'No results yet — not tracked or not checked.', color: COLOR.offline }], components: [btnRow(btn('🏠 Home', 'fn:home'))] };
    }
    throw err;
  }

  const results = data.results || {};
  const entries = Object.entries(results);
  if (!entries.length) {
    return { embeds: [{ title: `ℹ️ ${domain}`, description: 'Tracked but no filter results yet.', color: COLOR.info }], components: [btnRow(btn('🏠 Home', 'fn:home'))] };
  }

  const passed  = entries.filter(([, v]) => !v.blocked);
  const blocked = entries.filter(([, v]) =>  v.blocked);
  const passStr = passed.length
    ? passed.map(([f, v]) => `🟢 **${f}**${v.category ? ` — ${v.category}` : ''}`).join('\n').slice(0, 1024)
    : '—';
  const blkStr  = blocked.length
    ? blocked.map(([f, v]) => `🔴 **${f}**${v.category ? ` — ${v.category}` : ''}`).join('\n').slice(0, 1024)
    : '—';

  return {
    embeds: [{
      title: `🔍 Filter check: ${domain}`,
      color: blocked.length === 0 ? COLOR.online : (passed.length === 0 ? COLOR.offline : COLOR.partial),
      fields: [
        { name: `✅ Passed (${passed.length})`,  value: passStr, inline: false },
        { name: `❌ Blocked (${blocked.length})`, value: blkStr,  inline: false },
      ],
      footer: { text: `${entries.length} filters checked` },
      timestamp: new Date().toISOString(),
    }],
    components: [btnRow(btn('🏠 Home', 'fn:home'), btn('🔎 Filters', 'fn:filters'))],
  };
}

// ── modal definition (returned as type-9 response) ────────────────────────────

function buildCheckDomainModal() {
  return {
    type: 9, // MODAL
    data: {
      title: 'Check a Domain',
      custom_id: 'fn:check_submit',
      components: [{
        type: 1,
        components: [{
          type: 4, // TEXT_INPUT
          custom_id: 'domain',
          label: 'Domain name',
          style: 1,
          placeholder: 'e.g. mooo.com',
          required: true,
          min_length: 1,
          max_length: 253,
        }],
      }],
    },
  };
}

// ── AIO dispatcher (call this from api/discord.js) ────────────────────────────

/**
 * Route a /freedns slash command → home panel
 */
async function handleFreeDnsAIO() {
  const data = await buildFreeDnsHome();
  return { type: 4, data };
}

/**
 * Route a MESSAGE_COMPONENT interaction whose custom_id starts with 'fn:'
 * Returns a type-7 (UPDATE_MESSAGE) response or type-9 (MODAL).
 */
async function handleFreeDnsComponent(interaction) {
  const id = interaction.data.custom_id;
  const values = interaction.data.values; // for selects

  // Modal trigger
  if (id === 'fn:check_modal') return buildCheckDomainModal();

  // Button navigation
  let data;
  if      (id === 'fn:home')     data = await buildFreeDnsHome();
  else if (id === 'fn:status')   data = await buildFreeDnsStatus();
  else if (id === 'fn:changes')  data = await buildFreeDnsChanges();
  else if (id === 'fn:filters')  data = await buildFreeDnsFilters();
  else if (id.startsWith('fn:domains:')) {
    const page = parseInt(id.split(':')[2], 10) || 1;
    data = await buildFreeDnsDomains(page);
  } else if (id.startsWith('fn:filter_detail:')) {
    // fn:filter_detail:<mode>:<name>
    const parts = id.split(':');
    data = await buildFreeDnsFilterDetail(parts.slice(3).join(':'), parts[2]);
  } else if (['fn:filter_a','fn:filter_b','fn:filter_skip_a','fn:filter_skip_b'].includes(id)) {
    // select menu — values[0] is like 'u:lightspeed' or 's:lightspeed'
    const [mode, ...nameParts] = (values?.[0] || '').split(':');
    data = await buildFreeDnsFilterDetail(nameParts.join(':'), mode);
  } else {
    data = { embeds: [{ description: '❓ Unknown action.', color: COLOR.offline }], components: [] };
  }

  return { type: 7, data }; // UPDATE_MESSAGE
}

/**
 * Route a MODAL_SUBMIT with custom_id 'fn:check_submit'
 * Returns a type-4 (new ephemeral message).
 */
async function handleFreeDnsModalSubmit(interaction) {
  const domain = interaction.data.components?.[0]?.components?.[0]?.value?.trim();
  if (!domain) return { type: 4, data: { content: '❓ Please enter a domain name.', flags: 64 } };
  const data = await buildFreeDnsCheckResult(domain);
  return { type: 4, data: { ...data, flags: 64 } }; // ephemeral
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
  // FreeDNS AIO
  handleFreeDnsAIO,
  handleFreeDnsComponent,
  handleFreeDnsModalSubmit,
};
