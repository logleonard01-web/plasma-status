const mongoose = require('mongoose');
const { Schema } = mongoose;
const Mixed = Schema.Types.Mixed;

// A single settings document holds everything that used to live in config.yml
// and is now editable from the staff dashboard. Secrets and infrastructure
// (MongoURI, LicenseKey, Port, baseURL, bot Token, OAuth credentials, ...)
// deliberately stay in config.yml and are never stored here.
const settingsSchema = new Schema({
  PageSettings: {
    Name: { type: String, default: 'PlasmaStatus' },
    Description: { type: String, default: '' },
    Theme: { type: String, default: 'professional' },
    ThemeColor: { type: String, default: '#5e99ff' },
    updateInterval: { type: String, default: '1m' }
  },
  Announcement: {
    Enabled: { type: Boolean, default: false },
    Message: { type: String, default: '' },
    Type: { type: String, default: 'info' },
    Dismissible: { type: Boolean, default: true }
  },
  // Bot Token stays in config.yml; only the runtime targets live here.
  DiscordBot: {
    Enabled: { type: Boolean, default: false },
    GuildID: { type: String, default: '' },
    ChannelID: { type: String, default: '' },
    UpdateInterval: { type: String, default: '1m' }
  },
  StatusColors: {
    Online: { type: String, default: '#4CAF50' },
    Offline: { type: String, default: '#F44336' },
    PartialOffline: { type: String, default: '#E67E22' },
    Maintenance: { type: String, default: '#E67E22' }
  },
  Performance: {
    ConcurrencyLimit: { type: Number, default: 10 },
    DebounceCount: { type: Number, default: 2 },
    DebounceWindow: { type: Number, default: 30000 },
    MaxBackoffInterval: { type: Number, default: 300000 }
  },
  // Free-form templating blocks, kept as-is from the config.
  WebhookMessages: { type: Mixed },
  DiscordEmbed: { type: Mixed },
  // Auto-updating Discord embed — set by /embed setup, cleared by /embed remove
  AutoEmbed: {
    channelId:  { type: String, default: '' },
    messageId:  { type: String, default: '' },
    guildId:    { type: String, default: '' },
    enabledAt:  { type: Date },
  },
  // Uploaded branding, stored in the DB so it survives container rebuilds.
  logo: { data: Buffer, contentType: String },
  favicon: { data: Buffer, contentType: String },
  updatedAt: { type: Date, default: Date.now }
}, { minimize: false });

module.exports = mongoose.model('Settings', settingsSchema);
