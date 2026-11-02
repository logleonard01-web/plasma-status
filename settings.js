/*
 * Effective-config loader.
 *
 * config.yml only holds secrets and server/infrastructure settings. Everything
 * a staff member can edit (page, announcement, services, colours, performance,
 * Discord bot and embed) lives in the database (models/settingsModel.js) and is
 * managed from the dashboard. The built-in defaults below are used to seed the
 * database the first time the app runs, and as a safety net before it is seeded.
 *
 * getConfig() returns the three layered together — defaults, then config.yml,
 * then the database values on top — shaped exactly like the old raw config, so
 * the rest of the app keeps reading config.* unchanged.
 */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const SettingsModel = require('./models/settingsModel');
const { applyEnv } = require('./env-config');

// Load config.yml if it exists; fall back to an empty object on Vercel or
// other environments where the file is not present (env vars supply everything).
let rawFileConfig = {};
const configPath = path.join(__dirname, 'config.yml');
try {
  rawFileConfig = yaml.load(fs.readFileSync(configPath, 'utf8')) || {};
} catch (err) {
  if (err.code !== 'ENOENT') throw err; // only swallow "file not found"
  console.warn('[CONFIG] config.yml not found — using environment variables only.');
}

// Merge environment variables on top so Vercel env vars always win.
const fileConfig = applyEnv(rawFileConfig);

// Default content for every dashboard-managed group. This is the single source
// of truth for defaults now that config.yml no longer carries them.
const DEFAULTS = {
  PageSettings: {
    Name: 'PlasmaStatus',
    Description: 'PlasmaStatus provides real-time updates on the status of our services, including uptime, maintenance, and historical data. Stay informed about the operational status of our services.',
    Theme: 'professional',
    ThemeColor: '#5e99ff',
    updateInterval: '1m'
  },
  Announcement: {
    Enabled: false,
    Message: '',
    Type: 'info',
    Dismissible: true
  },
  DiscordBot: {
    Enabled: false,
    GuildID: '',
    ChannelID: '',
    UpdateInterval: '1m'
  },
  StatusColors: {
    Online: '#4CAF50',
    Offline: '#F44336',
    PartialOffline: '#E67E22',
    Maintenance: '#E67E22'
  },
  Performance: {
    ConcurrencyLimit: 10,
    DebounceCount: 2,
    DebounceWindow: 30000,
    MaxBackoffInterval: 300000
  },
  WebhookMessages: {
    Online: {
      Title: 'Status Update',
      Description: '- Service: ``{{serviceName}}``\n- Status: ``Online``\n\n**Downtime Details:**\n- Went offline: <t:{{lastOfflineTimestamp}}:F>\n- Back online: <t:{{currentTimestamp}}:F>\n- Downtime duration: ``{{formattedDuration}}``'
    },
    Offline: {
      Title: 'Status Update',
      Description: '- Service: ``{{serviceName}}``\n- Status: ``Offline``\n\n**Details:**\n- Went offline: <t:{{currentTimestamp}}:F>'
    }
  },
  DiscordEmbed: {
    Title: '{{siteName}} - System Status',
    Description: '> **{{overallStatus}}**\n> Last updated: <t:{{timestamp}}:R>\n\n{{servicesText}}\n',
    Colors: { online: '#10b981', offline: '#ef4444', partial: '#f59e0b', maintenance: '#8b5cf6' },
    Emojis: { online: '🟢', offline: '🔴', partial: '🟠', maintenance: '🔧' },
    ServiceFormat: '> {{emoji}} **{{name}}** - {{status}} `({{uptime}}%)`',
    CategoryFormat: '## {{categoryName}}\n{{services}}',
    Fields: [
      { Name: '📊 Overview', Value: '> **{{onlineCount}}/{{totalCount}}** services online\n> **{{avgUptime}}%** average uptime', Inline: true },
      { Name: '⚡ Performance', Value: '> **{{avgResponseTime}}ms** avg response\n> Updated <t:{{timestamp}}:R>', Inline: true }
    ],
    ShowUptime: true,
    ShowResponseTime: false,
    ShowThumbnail: true,
    ShowFooter: true,
    ShowFields: true,
    FooterText: '{{siteName}} • Updated every {{updateInterval}}'
  }
};

// Sample services used to seed an empty database so a fresh install is not blank.
const DEFAULT_SERVICES = [
  { name: 'Main Website', url: 'https://google.com', type: 'website', category: 'Web Services', webhookURL: '', maintenance: false },
  { name: 'Documentation Portal', url: 'https://cloudflare.com', type: 'website', category: 'Web Services', webhookURL: '', maintenance: false },
  { name: 'Customer Dashboard', url: 'https://github.com', type: 'website', category: 'Web Services', webhookURL: '', maintenance: false },
  { name: 'Authentication API', url: '8.8.8.8', type: 'ip', category: 'API Services', webhookURL: '', maintenance: false },
  { name: 'Payment Gateway', url: '1.1.1.1', type: 'ip', category: 'API Services', webhookURL: '', maintenance: false },
  { name: 'Analytics API', url: '9.9.9.9', type: 'ip', category: 'API Services', webhookURL: '', maintenance: false }
];

let cache = null; // plain object copy of the Settings document, or null

// Create the settings document the first time the app runs, from the defaults.
async function seedIfNeeded() {
  // Image blobs (logo/favicon) are excluded from the cache — they are served
  // directly from their own routes, not through the merged config.
  const existing = await SettingsModel.findOne().select('-logo -favicon');
  if (existing) {
    cache = existing.toObject();
    return cache;
  }

  const doc = await SettingsModel.create({
    PageSettings: DEFAULTS.PageSettings,
    Announcement: DEFAULTS.Announcement,
    DiscordBot: DEFAULTS.DiscordBot,
    StatusColors: DEFAULTS.StatusColors,
    Performance: DEFAULTS.Performance,
    WebhookMessages: DEFAULTS.WebhookMessages,
    DiscordEmbed: DEFAULTS.DiscordEmbed
  });

  cache = doc.toObject();
  return cache;
}

// Re-read the settings document into the cache. Call after any dashboard save.
async function refresh() {
  const doc = await SettingsModel.findOne().select('-logo -favicon');
  cache = doc ? doc.toObject() : null;
  return getConfig();
}

// Defaults, with config.yml infra values and then the database values layered on
// top. Editable groups always resolve to a complete object even before seeding.
function getConfig() {
  const merged = structuredClone(fileConfig);
  const file = fileConfig || {};

  const layer = (group) => ({ ...DEFAULTS[group], ...(file[group] || {}), ...((cache && cache[group]) || {}) });

  merged.PageSettings = layer('PageSettings');
  merged.Announcement = layer('Announcement');
  merged.DiscordBot = layer('DiscordBot');
  merged.StatusColors = layer('StatusColors');
  merged.Performance = layer('Performance');
  merged.WebhookMessages = (cache && cache.WebhookMessages) || file.WebhookMessages || DEFAULTS.WebhookMessages;
  merged.DiscordEmbed = (cache && cache.DiscordEmbed) || file.DiscordEmbed || DEFAULTS.DiscordEmbed;

  return merged;
}

module.exports = { fileConfig, DEFAULTS, DEFAULT_SERVICES, seedIfNeeded, refresh, getConfig, raw: () => cache };
