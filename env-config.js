/**
 * env-config.js
 *
 * Builds a config.yml-compatible object entirely from environment variables.
 * Used by Vercel (and any other serverless / 12-factor environment) so that
 * secrets never need to be committed to the repo.
 *
 * Priority: environment variables > config.yml file values
 * Every key here corresponds to a Vercel environment variable documented in
 * .env.example and in the README deploy guide.
 */

'use strict';

/**
 * Parses OWNER_IDS from a comma-separated string like "123,456,789"
 * and falls back to the yml value (which may already be an array).
 */
function parseOwnerIds(envVal, ymlVal) {
  if (envVal) {
    return envVal
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (Array.isArray(ymlVal)) return ymlVal;
  if (typeof ymlVal === 'string' && ymlVal) return [ymlVal];
  return ['USER_ID'];
}

/**
 * Merges environment variables on top of a base config object (from config.yml).
 * Returns a new object — the original is not mutated.
 */
function applyEnv(base) {
  const cfg = JSON.parse(JSON.stringify(base || {}));

  // ── Top-level secrets ────────────────────────────────────────────────────
  if (process.env.LICENSE_KEY) cfg.LicenseKey = process.env.LICENSE_KEY;
  if (process.env.LICENSE_CONNECTION_TYPE)
    cfg.LicenseConnectionType = process.env.LICENSE_CONNECTION_TYPE;

  // Support both MONGODB_URI (Vercel convention) and MONGO_URI (legacy)
  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (mongoUri) cfg.MongoURI = mongoUri;

  if (process.env.DEBUG_MODE !== undefined)
    cfg.DebugMode = process.env.DEBUG_MODE === 'true';

  if (process.env.SECRET_KEY) cfg.secretKey = process.env.SECRET_KEY;

  if (process.env.SECURE !== undefined)
    cfg.Secure = process.env.SECURE === 'true';

  if (process.env.SESSION_EXPIRES) cfg.SessionExpires = process.env.SESSION_EXPIRES;

  // ── Discord OAuth2 ───────────────────────────────────────────────────────
  if (process.env.DISCORD_CLIENT_ID) cfg.clientID = process.env.DISCORD_CLIENT_ID;
  if (process.env.DISCORD_CLIENT_SECRET)
    cfg.clientSecret = process.env.DISCORD_CLIENT_SECRET;
  if (process.env.DISCORD_CALLBACK_URL)
    cfg.callbackURL = process.env.DISCORD_CALLBACK_URL;

  // OWNER_IDS accepts comma-separated Discord user IDs: "123456789,987654321"
  if (process.env.OWNER_IDS || process.env.OWNER_ID) {
    cfg.OwnerID = parseOwnerIds(
      process.env.OWNER_IDS || process.env.OWNER_ID,
      cfg.OwnerID
    );
  }

  // ── Page / web-server settings ───────────────────────────────────────────
  if (!cfg.PageSettings) cfg.PageSettings = {};

  if (process.env.BASE_URL)
    cfg.PageSettings.baseURL = process.env.BASE_URL.replace(/\/$/, '');

  // Vercel ignores PORT — the runtime picks the port — but keep it readable
  if (process.env.PORT)
    cfg.PageSettings.Port = parseInt(process.env.PORT, 10) || 3000;

  if (process.env.TRUST_PROXY !== undefined)
    cfg.PageSettings.trustProxy = parseInt(process.env.TRUST_PROXY, 10) || 0;

  // On Vercel HTTPS is always on; default Secure to true unless overridden
  if (process.env.VERCEL && cfg.Secure === undefined) cfg.Secure = true;

  // Derive callbackURL from BASE_URL when DISCORD_CALLBACK_URL is not set
  if (!cfg.callbackURL && cfg.PageSettings.baseURL) {
    cfg.callbackURL = `${cfg.PageSettings.baseURL}/auth/discord/callback`;
  }

  // ── Discord bot token ────────────────────────────────────────────────────
  if (!cfg.DiscordBot) cfg.DiscordBot = {};
  if (process.env.DISCORD_BOT_TOKEN)
    cfg.DiscordBot.Token = process.env.DISCORD_BOT_TOKEN;

  // ── Discord Interactions (slash commands) ───────────────────────────────
  // DISCORD_PUBLIC_KEY is read directly from process.env in api/discord.js;
  // it does not need to be merged into the config object, but we keep a note
  // here so the .env.example is the single source of truth.

  // ── Vercel-specific: expose VERCEL_URL as a fallback base URL ────────────
  if (process.env.VERCEL_URL && !cfg.PageSettings.baseURL) {
    cfg.PageSettings.baseURL = `https://${process.env.VERCEL_URL}`;
    if (!cfg.callbackURL) {
      cfg.callbackURL = `https://${process.env.VERCEL_URL}/auth/discord/callback`;
    }
  }

  return cfg;
}

module.exports = { applyEnv };
