const express = require('express');
const axios = require('axios');
const fs = require('fs');
const yaml = require('js-yaml');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const botVersion = require('./package.json');
const color = require('ansi-colors');
const ping = require('ping');
const net = require('net');
const dgram = require('dgram');
const { Webhook, MessageBuilder } = require('discord-webhook-node');
const discordBot = require('./discord-bot');
const license = require('./license');
const rateLimit = require('express-rate-limit');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const session = require('express-session');
const MongoStore = require('connect-mongo');
const cookieParser = require('cookie-parser');
const multer = require('multer');

const Service = require('./models/serviceModel');
const History = require('./models/historyModel');
const StatusUpdate = require('./models/statusUpdateModel');
const DiscordMessage = require('./models/discordMessageModel');
const Settings = require('./models/settingsModel');
const settings = require('./settings');

// config starts as the raw config.yml (used for boot-time infrastructure reads)
// and is replaced with the merged effective config once the database is ready.
// It is a module-level `let` so every function below picks up dashboard edits
// the moment we reassign it after a save.
let config = settings.fileConfig;

const app = express();
const port = config.PageSettings.Port;
if (config.PageSettings.trustProxy && config.PageSettings.trustProxy > 0) app.set('trust proxy', config.PageSettings.trustProxy);

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

const refreshLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: 'Too many refresh requests, please wait before trying again.',
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(generalLimiter);

// ---------------------------------------------------------------------------
// Staff dashboard auth (Discord OAuth2)
// ---------------------------------------------------------------------------
let sessionTtl = 7 * 24 * 60 * 60 * 1000;
try { sessionTtl = parseDuration(config.SessionExpires || '7d'); } catch (e) { /* use default */ }

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use(session({
  secret: config.secretKey || 'plasma-status-secret',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: config.MongoURI,
    ttl: Math.round(sessionTtl / 1000),
    autoRemove: 'native'
  }),
  cookie: {
    secure: !!config.Secure,
    httpOnly: true,
    sameSite: 'lax',
    maxAge: sessionTtl
  }
}));

app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(new DiscordStrategy(
  {
    clientID: config.clientID,
    clientSecret: config.clientSecret,
    callbackURL: config.callbackURL,
    scope: ['identify']
  },
  (accessToken, refreshToken, profile, done) => done(null, profile)
));

// Masked diagnostic so you can confirm the RUNNING app's OAuth credentials
// (helps catch a stale config.yml baked into a Docker image or dist/ copy).
const maskId = (v) => (v ? `${String(v).slice(0, 6)}… (len ${String(v).length})` : '(EMPTY)');
console.log(color.yellow('[OAUTH] ') +
  `clientID=${maskId(config.clientID)}  clientSecret=${config.clientSecret ? `set (len ${config.clientSecret.length})` : '(EMPTY)'}  callbackURL=${config.callbackURL || '(EMPTY)'}`);

// Expose a staff check on every request. Staff = any Discord ID in OwnerID.
app.use((req, res, next) => {
  req.isStaff = function () {
    if (!req.user || !req.user.id) return false;
    return Array.isArray(config.OwnerID) && config.OwnerID.includes(req.user.id);
  };
  res.locals.isStaff = req.isStaff();
  res.locals.user = req.user || null;
  next();
});

// Issue a CSRF token only for authenticated sessions (so anonymous visitors to
// the public page never get a session row created just to hold a token).
app.use((req, res, next) => {
  if (req.session && req.isAuthenticated && req.isAuthenticated()) {
    if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(24).toString('hex');
    res.locals.csrfToken = req.session.csrfToken;
  } else {
    res.locals.csrfToken = '';
  }
  next();
});

// Double-submit CSRF check for state-changing dashboard routes. The token comes
// from the session and must be echoed back via a form field or the x-csrf-token
// header. Uses a constant-time compare.
function verifyCsrf(req, res, next) {
  const expected = req.session && req.session.csrfToken;
  const provided = (req.body && req.body._csrf) || req.get('x-csrf-token') || '';
  const ok = expected && provided &&
    expected.length === provided.length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
  if (ok) return next();
  return res.status(403).render('error', {
    config,
    message: 'Your session security token was missing or invalid. Reload the dashboard and try again.'
  });
}

const isLoggedIn = (req, res, next) => {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  res.cookie('redirectAfterLogin', req.originalUrl);
  res.redirect('/login');
};

const checkStaffAccess = (req, res, next) => {
  if (req.isStaff()) return next();
  res.status(403).render('error', {
    config,
    message: 'You do not have permission to access the staff dashboard.'
  });
};

// Logo / favicon uploads are kept in memory and stored in the database so they
// survive container rebuilds (writing into public/ would be wiped on rebuild).
// Only PNG (logo) and ICO (favicon) are accepted, and we store a fixed, safe
// content type — never the client-supplied one — so the assets can't be used to
// serve HTML/SVG from our origin.
const LOGO_MIMES = ['image/png', 'image/jpeg', 'image/webp'];
const ICO_MIMES = ['image/x-icon', 'image/vnd.microsoft.icon', 'image/ico', 'image/icon'];
const brandingUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 2 },
  fileFilter: (req, file, cb) => {
    const ok = (file.fieldname === 'logo' && LOGO_MIMES.includes(file.mimetype))
      || (file.fieldname === 'favicon' && ICO_MIMES.includes(file.mimetype));
    if (ok) return cb(null, true);
    cb(new Error('Logo must be a PNG, JPG or WEBP file and favicon must be an ICO file.'));
  }
});

// Runs the branding upload and turns multer/type errors into a friendly page
// instead of an unhandled 500.
function handleBrandingUpload(req, res, next) {
  brandingUpload.fields([{ name: 'logo', maxCount: 1 }, { name: 'favicon', maxCount: 1 }])(req, res, (err) => {
    if (err) {
      return res.status(400).render('error', { config, message: err.message || 'Upload failed.' });
    }
    next();
  });
}

let pageCache = {
  data: null,
  timestamp: 0
};
const CACHE_DURATION = 30 * 1000;

function getCachedResponse() {
  const now = Date.now();
  if (pageCache.data && (now - pageCache.timestamp) < CACHE_DURATION) {
    return pageCache.data;
  }
  return null;
}

function setCachedResponse(data) {
  pageCache.data = data;
  pageCache.timestamp = Date.now();
}

function parseDuration(input) {
  if (typeof input === 'number') {
    return input;
  }
  
  if (typeof input !== 'string') {
    throw new Error('Duration must be a string or number');
  }
  
  const units = {
    ms: 1,
    s: 1000,
    sec: 1000,
    second: 1000,
    seconds: 1000,
    m: 60000,
    min: 60000,
    minute: 60000,
    minutes: 60000,
    h: 3600000,
    hr: 3600000,
    hour: 3600000,
    hours: 3600000,
    d: 86400000,
    day: 86400000,
    days: 86400000,
    w: 604800000,
    week: 604800000,
    weeks: 604800000,
    y: 31536000000,
    year: 31536000000,
    years: 31536000000
  };
  
  const regex = /^(\d+(?:\.\d+)?)\s*([a-zA-Z]+)$/;
  const match = input.trim().match(regex);
  
  if (!match) {
    throw new Error(`Invalid duration format: ${input}`);
  }
  
  const value = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  
  if (!(unit in units)) {
    throw new Error(`Unknown time unit: ${unit}`);
  }
  
  return Math.round(value * units[unit]);
}

class StatusDebouncer {
  constructor() {
    this.statusCounts = new Map();
  }

  // Read live from the merged config so dashboard changes apply without a restart.
  get debounceCount() {
    return config.Performance?.DebounceCount || 2;
  }

  get debounceWindow() {
    const base = config.Performance?.DebounceWindow || 30000;
    let updateInterval = 30000;
    try { updateInterval = parseDuration(config.PageSettings.updateInterval); } catch (e) { /* use default */ }
    return Math.max(base, updateInterval * 2.5);
  }

shouldUpdateStatus(serviceName, newStatus, currentStatus) {
  if (currentStatus === 'unknown' && newStatus !== 'unknown') {
    return true;
  }
  
  if (newStatus === 'maintenance') {
    return true;
  }
  
  if (newStatus === currentStatus) {
    this.resetDebounce(serviceName);
    return false;
  }

  const now = Date.now();
  const key = `${serviceName}-${newStatus}`;
  
  if (!this.statusCounts.has(key)) {
    this.statusCounts.set(key, { count: 1, firstSeen: now });
    return false;
  }

  const data = this.statusCounts.get(key);
  
  if (now - data.firstSeen > this.debounceWindow) {
    this.statusCounts.set(key, { count: 1, firstSeen: now });
    return false;
  }

  data.count++;
  
  if (data.count >= this.debounceCount) {
    this.resetDebounce(serviceName);
    return true;
  }

  return false;
}

  resetDebounce(serviceName) {
    for (const [key] of this.statusCounts) {
      if (key.startsWith(`${serviceName}-`)) {
        this.statusCounts.delete(key);
      }
    }
  }
}

const statusDebouncer = new StatusDebouncer();

const axiosInstance = axios.create({
  timeout: 10000,
  maxRedirects: 3,
  validateStatus: (status) => status >= 200 && status < 400,
  headers: {
    'User-Agent': 'PlasmaStatus/1.0 Health-Check'
  }
});

axiosInstance.interceptors.response.use(
  response => response,
  error => {
    if (error.code === 'ECONNABORTED') {
      error.isTimeout = true;
    }
    throw error;
  }
);

const backoffMap = new Map();

function getServiceConfigHash(serviceConfig) {
  const configString = `${serviceConfig.url}-${serviceConfig.type}-${serviceConfig.port || ''}-${serviceConfig.maintenance || false}`;
  return configString;
}

function shouldSkipCheck(serviceName, currentStatus, serviceConfig) {
  if (currentStatus !== 'offline') {
    backoffMap.delete(serviceName);
    return false;
  }

  const backoffData = backoffMap.get(serviceName);
  const now = Date.now();

  if (!backoffData) {
    backoffMap.set(serviceName, { 
      lastCheck: now, 
      backoffMultiplier: 1,
      configHash: getServiceConfigHash(serviceConfig)
    });
    return false;
  }

  const configHash = getServiceConfigHash(serviceConfig);
  if (backoffData.configHash !== configHash) {
    backoffMap.set(serviceName, { 
      lastCheck: now, 
      backoffMultiplier: 1,
      configHash: configHash
    });
    if (config.DebugMode) {
      console.log(`[BACKOFF] Service ${serviceName} configuration changed, resetting backoff`);
    }
    return false;
  }

  const maxBackoff = config.Performance?.MaxBackoffInterval || 300000;
  const backoffInterval = Math.min(backoffData.backoffMultiplier * 30000, maxBackoff);
  
  if (now - backoffData.lastCheck < backoffInterval) {
    return true;
  }

  backoffData.lastCheck = now;
  backoffData.backoffMultiplier = Math.min(backoffData.backoffMultiplier * 2, 10);
  return false;
}

function logError(message, error) {
  const timestamp = new Date().toISOString();
  const logMessage = `\n\n[${timestamp}] [ERROR] ${message}\n${error.stack}`;
  
  fs.appendFile("./logs.txt", logMessage, (err) => {
    if (err && config.DebugMode) {
      console.error('Failed to write to log file:', err);
    }
  });
  
  if (config.DebugMode) {
    console.error(`[${timestamp}] ${message}:`, error.message);
  }
}

const connectToMongoDB = async () => {
    try {
        if (config.MongoURI) await mongoose.set('strictQuery', false);

        if (config.MongoURI) {
            // Reuse an existing connection in serverless environments — connecting
            // again while already connected just wastes a cold-start round-trip.
            if (mongoose.connection.readyState === 1) {
              if (config.DebugMode) console.log('[MONGO] Reusing existing MongoDB connection');
              return;
            }
            await mongoose.connect(config.MongoURI, {
              maxPoolSize: 10,
              serverSelectionTimeoutMS: 5000,
              socketTimeoutMS: 45000,
              // Keep the connection alive between serverless invocations
              bufferCommands: false,
            });
            console.log('[MONGO] Connected to MongoDB successfully');
        } else {
            throw new Error('[ERROR] MongoDB Connection String is not specified in the config! (MongoURI)');
        }
    } catch (error) {
        console.error('\x1b[31m%s\x1b[0m', `[ERROR] Failed to connect to MongoDB: ${error.message}\n${error.stack}`);

        if (error.message.includes('authentication failed')) {
            await console.error('Authentication failed. Make sure to check if you entered the correct username and password in the connection URL.');
            await process.exit(1)
        } else if (error.message.includes('network error')) {
            await console.error('Network error. Make sure the MongoDB server is reachable and the connection URL is correct.');
            await process.exit(1)
        } else if (error.message.includes('permission denied')) {
            await console.error('Permission denied. Make sure the MongoDB cluster has the necessary permissions to read and write.');
            await process.exit(1)
        } else {
            await console.error('An unexpected error occurred. Check the MongoDB connection URL and credentials.');
            await process.exit(1)
        }
    }
};

connectToMongoDB();

let discordBotInitialized = false;

async function createDatabaseIndexes() {
  try {
    await Service.collection.createIndex({ name: 1 }, { unique: true });
    await Service.collection.createIndex({ currentStatus: 1 });
    await Service.collection.createIndex({ category: 1 });
    
    await StatusUpdate.collection.createIndex({ createdAt: -1 });
    
    if (config.DebugMode) {
      console.log('[DB] Database indexes created successfully');
    }
  } catch (error) {
    logError('Error creating database indexes', error);
  }
}

// Services are managed from the staff dashboard and stored in the database.
// config.yml services are only used to seed the database the very first time
// (when no services exist yet). After that the dashboard is the source of truth.
async function seedServicesIfEmpty() {
    try {
        const count = await Service.countDocuments();
        if (count > 0) {
            if (config.DebugMode) console.log('[INIT] Services already present, skipping seed');
            return;
        }

        const seedList = (Array.isArray(config.services) && config.services.length)
            ? config.services
            : settings.DEFAULT_SERVICES;
        for (const serviceConfig of seedList) {
            await Service.create({
                name: serviceConfig.name,
                category: serviceConfig.category || "Uncategorized",
                url: serviceConfig.url,
                type: serviceConfig.type,
                port: serviceConfig.port || null,
                currentStatus: 'unknown',
                webhookURL: serviceConfig.webhookURL || null,
                maintenance: serviceConfig.maintenance || false,
                tooltip: serviceConfig.tooltip || null,
                lastResponseTime: 0,
                history: []
            });
            if (config.DebugMode) console.log(`[INIT] Seeded service: ${serviceConfig.name}`);
        }

        if (config.DebugMode) console.log('[INIT] Services seeded from config.yml');
    } catch (error) {
        console.error('[ERROR] Failed to seed services:', error);
    }
}

app.use((req, res, next) => {
  const send = res.send;
  res.send = function (body) {
      if (typeof body === 'string' && body.includes('</body>')) {
          const consoleScript = `
              <script>
                  (function() {
                      const message = \`
%c
PlasmaStatus is made by Plasma Services.
Version: ${botVersion.version}
Website - https://plasma.services/
\`,
                          style = \`
font-family: monospace;
color: #5e99ff;
background-color: #1e1e1e;
padding: 10px;
border: 1px solid #00aaff;
\`;
      
                      console.log(message, style);
                  })();
              </script>
              `;
          body = body.replace('</body>', consoleScript + '</body>');
      }
      send.call(this, body);
  };
  next();
});

async function sendDiscordNotification(webhookURL, title, description, color) {
  try {
    const hook = new Webhook(webhookURL);

    hook.setUsername(config.PageSettings.Name);
    hook.setAvatar(`${config.PageSettings.baseURL}/logo.png`);

    const embed = new MessageBuilder()
      .setTitle(title)
      .setDescription(description)
      .setColor(color)
      .setTimestamp();

    await hook.send(embed);
  } catch (error) {
    logError(`Failed to send Discord notification`, error);
  }
}

function formatDuration(seconds) {
  if (seconds < 60) {
    return `${Math.floor(seconds)} seconds`;
  } else if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    return `${minutes} minute${minutes > 1 ? 's' : ''}`;
  } else if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600);
    return `${hours} hour${hours > 1 ? 's' : ''}`;
  } else {
    const days = Math.floor(seconds / 86400);
    return `${days} day${days > 1 ? 's' : ''}`;
  }
}

async function logStatusChange(serviceName, status, responseTime) {
  const timestamp = new Date();
  
  try {
    const service = await Service.findOne({ name: serviceName });
    if (!service) {
      console.error(`Service ${serviceName} not found`);
      return;
    }

    const lastHistoryEntry = service.history.length > 0 ? service.history[service.history.length - 1] : null;

    if (lastHistoryEntry && lastHistoryEntry.status === 'offline' && status === 'online') {
      const lastTimestamp = new Date(lastHistoryEntry.timestamp);
      const duration = (timestamp - lastTimestamp) / 1000;
      lastHistoryEntry.duration = duration;
    }

    const newHistoryEntry = {
      status,
      timestamp,
      responseTime
    };

    service.history.push(newHistoryEntry);
    service.currentStatus = status;
    service.lastResponseTime = responseTime;
    
    await service.save();

    if (!lastHistoryEntry || lastHistoryEntry.status !== status) {
      console.log(`[STATUS] ${serviceName}: ${lastHistoryEntry?.status || 'unknown'} → ${status}`);
    }

    if (service.webhookURL) {
      if (lastHistoryEntry && lastHistoryEntry.status !== status) {
        let description;
        const title = config.WebhookMessages[status === 'online' ? 'Online' : 'Offline'].Title;

        if (status === 'online' && lastHistoryEntry) {
          const formattedDuration = lastHistoryEntry.duration ? formatDuration(lastHistoryEntry.duration) : 'N/A';
          description = config.WebhookMessages.Online.Description
            .replace('{{serviceName}}', serviceName)
            .replace('{{lastOfflineTimestamp}}', Math.floor(new Date(lastHistoryEntry.timestamp).getTime() / 1000))
            .replace('{{currentTimestamp}}', Math.floor(timestamp.getTime() / 1000))
            .replace('{{formattedDuration}}', formattedDuration);
        } else if (status === 'offline') {
          description = config.WebhookMessages.Offline.Description
            .replace('{{serviceName}}', serviceName)
            .replace('{{currentTimestamp}}', Math.floor(timestamp.getTime() / 1000));
        }

        const webhookColor = status === 'online' ? config.StatusColors.Online : config.StatusColors.Offline;
        if(service.webhookURL) await sendDiscordNotification(service.webhookURL, title, description, webhookColor);
      }
    }
  } catch (error) {
    logError(`Error logging status change for ${serviceName}`, error);
  }
}

async function calculateOverallStatus() {
  try {
    const [totalServices, onlineServices] = await Promise.all([
      Service.countDocuments(),
      Service.countDocuments({ currentStatus: 'online' })
    ]);
    
    if (onlineServices === 0) return 'offline';
    if (onlineServices < totalServices) return 'partial';
    return 'online';
  } catch (error) {
    logError('Error calculating overall status', error);
    return 'unknown';
  }
}

async function checkWebsite(url) {
  const response = await axiosInstance.get(url);
  return response.status >= 200 && response.status < 400;
}

async function checkMinecraft(url) {
  const response = await axiosInstance.get(`https://api.mcstatus.io/v2/status/java/${url}`);
  return response.data.online === true;
}

async function checkTcpPort(host, port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timeout = 5000;
    let resolved = false;

    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
      }
    };

    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeout);

    socket.on('connect', () => {
      clearTimeout(timer);
      cleanup();
      resolve(true);
    });

    socket.on('error', () => {
      clearTimeout(timer);
      cleanup();
      resolve(false);
    });

    socket.on('timeout', () => {
      clearTimeout(timer);
      cleanup();
      resolve(false);
    });

    socket.setTimeout(timeout);
    socket.connect(port, host);
  });
}

async function checkUdpPort(host, port) {
  return new Promise((resolve) => {
    const client = dgram.createSocket('udp4');
    const message = Buffer.from('ping');
    const timeout = 3000;
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        client.close();
        resolve(false);
      }
    }, timeout);

    client.send(message, 0, message.length, port, host, (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        client.close();
        resolve(!err);
      }
    });

    client.on('error', () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        client.close();
        resolve(false);
      }
    });
  });
}

async function checkServiceStatusWithResponseTime(service) {
  if (service.maintenance) {
    return { status: 'maintenance', responseTime: 0 };
  }

  const startTime = process.hrtime.bigint();
  let responseTime = 0;

  try {
    let result;
    
    switch (service.type) {
      case 'website':
        result = await checkWebsite(service.url);
        break;
      case 'minecraft':
        result = await checkMinecraft(service.url);
        break;
      case 'tcp':
        result = await checkTcpPort(service.url, service.port);
        break;
      case 'udp':
        result = await checkUdpPort(service.url, service.port);
        break;
      case 'ip':
        result = await checkIpStatus(service.url);
        break;
      default:
        throw new Error(`Unknown service type: ${service.type}`);
    }

    responseTime = Number(process.hrtime.bigint() - startTime) / 1000000;
    return { 
      status: result === true || result === 'online' ? 'online' : 'offline', 
      responseTime: Math.round(responseTime) 
    };
    
  } catch (error) {
    responseTime = Number(process.hrtime.bigint() - startTime) / 1000000;
    
    if (!error.isTimeout && error.code !== 'ECONNREFUSED' && error.code !== 'ENOTFOUND') {
      logError(`Service check error for ${service.name}`, error);
    }
    
    return { status: 'offline', responseTime: Math.round(responseTime) };
  }
}

async function checkIpStatus(ip) {
  try {
    const res = await ping.promise.probe(ip);
    if (res.alive) {
      return 'online';
    } else {
      throw new Error('Ping failed');
    }
  } catch (error) {
    if (config.DebugMode) {
      logError(`Error checking IP ${ip}, trying external`, error);
    }
    return await checkIpStatusExternal(ip);
  }
}

// Fallback for hosts without ICMP permissions (e.g. Pterodactyl): treat the IP as online if a common TCP port accepts connections
async function checkIpStatusExternal(ip) {
  for (const port of [443, 80, 22]) {
    if (await checkTcpPort(ip, port)) return 'online';
  }
  return 'offline';
}

async function updateStatuses() {
  try {
    const services = await Service.find().lean();
    const concurrencyLimit = config.Performance?.ConcurrencyLimit || 10;

    for (let i = 0; i < services.length; i += concurrencyLimit) {
      const batch = services.slice(i, i + concurrencyLimit);

      const promises = batch.map(async (service) => {
        try {
          if (shouldSkipCheck(service.name, service.currentStatus, service)) {
            return;
          }

          const { status: newStatus, responseTime } = await checkServiceStatusWithResponseTime(service);
          
          if (statusDebouncer.shouldUpdateStatus(service.name, newStatus, service.currentStatus)) {
            await Service.updateOne(
              { name: service.name },
              { currentStatus: newStatus, lastResponseTime: responseTime }
            );
            await logStatusChange(service.name, newStatus, responseTime);
          } else if (newStatus === service.currentStatus) {
            await updateServiceResponseTime(service.name, responseTime);
          }
        } catch (error) {
          logError(`Error checking service ${service.name}`, error);
        }
      });

      await Promise.allSettled(promises);
    }

    const timestamp = new Date();
    await StatusUpdate.create({
      lastUpdated: timestamp,
      overallStatus: await calculateOverallStatus(),
      onlineServices: await Service.countDocuments({ currentStatus: 'online' }),
      totalServices: await Service.countDocuments()
    });

    // ── Auto-embed: edit the persistent Discord message if one is set up ────
    await refreshAutoEmbed(timestamp).catch(err =>
      logError('Auto-embed refresh error', err)
    );
  } catch (error) {
    logError('Error updating statuses', error);
  }
}

/**
 * Edit the persistent Discord status embed (set up via /embed setup).
 * Safe to call unconditionally — no-ops if no embed is configured.
 */
async function refreshAutoEmbed(lastUpdated) {
  try {
    const Settings = require('./models/settingsModel');
    const settings = await Settings.findOne().lean();
    const { channelId, messageId } = settings?.AutoEmbed || {};
    if (!channelId || !messageId) return; // no embed configured

    const botToken = config.DiscordBot?.Token;
    if (!botToken) return;

    const slash = require('./discord-slash');
    const services = await Service.find().lean();
    await slash.editEmbedMessage(
      botToken, channelId, messageId, services,
      config.PageSettings?.Name, lastUpdated
    );
  } catch (err) {
    // Never throw — a broken embed must not interrupt status updates
    logError('refreshAutoEmbed error', err);
  }
}

async function updateDiscordStatus() {
  if (!config.DiscordBot || !config.DiscordBot.Enabled || !discordBotInitialized) {
    return;
  }

  try {
    const services = await Service.find().lean();
    const lastStatusUpdate = await StatusUpdate.findOne().sort({ createdAt: -1 });
    const lastUpdated = lastStatusUpdate ? lastStatusUpdate.lastUpdated : new Date();

    const historyByService = await Promise.all(services.map(async (service) => {
      const historyByDay = aggregateHistory(service.history);
      const last90Days = getLast90UniqueDays(historyByDay);
      
      const totalEntries = service.history.length;
      const onlineEntries = service.history.filter(entry => entry.status === 'online').length;
      const uptimePercentage = totalEntries ? (onlineEntries / totalEntries) * 100 : 0;
      
      const dayAgo = Date.now() - (24 * 60 * 60 * 1000);
      const recentHistory = service.history.filter(entry => {
        const entryTime = new Date(entry.timestamp).getTime();
        return entryTime > dayAgo && entry.responseTime;
      });
      
      let avgResponseTime = 0;
      if (recentHistory.length > 0) {
        const totalResponseTime = recentHistory.reduce((sum, entry) => sum + (entry.responseTime || 0), 0);
        avgResponseTime = Math.round(totalResponseTime / recentHistory.length);
      } else {
        avgResponseTime = service.lastResponseTime || 0;
      }

      return {
        name: service.name,
        category: service.category || "Uncategorized",
        status: service.currentStatus,
        history: last90Days,
        tooltip: service.tooltip,
        uptimePercentage: uptimePercentage.toFixed(2),
        responseTime: avgResponseTime
      };
    }));

    let overallStatus = 'All services are online';
    let statusClass = 'online';
    const onlineServices = historyByService.filter(service => service.status === 'online').length;

    if (onlineServices === 0) {
      overallStatus = 'All services are offline';
      statusClass = 'offline';
    } else if (onlineServices < services.length) {
      overallStatus = 'Partial services are offline';
      statusClass = 'partial';
    }

    await discordBot.updateStatusEmbeds(historyByService, overallStatus, statusClass, lastUpdated);
  } catch (error) {
    logError('Error updating Discord status', error);
  }
}

async function updateServiceResponseTime(serviceName, responseTime) {
  try {
    await Service.updateOne(
      { name: serviceName },
      { 
        lastResponseTime: responseTime,
        $set: { "history.$[elem].responseTime": responseTime }
      },
      { arrayFilters: [{ "elem.responseTime": { $exists: false } }] }
    );
  } catch (error) {
    logError(`Error updating response time for ${serviceName}`, error);
  }
}

async function periodicallySaveStatus() {
  try {
    const services = await Service.find().lean();
    const timestamp = new Date();
    const updates = [];

    for (const service of services) {
      if (service.history && service.history.length > 0) {
        updates.push({
          updateOne: {
            filter: { name: service.name },
            update: {
              $push: {
                history: {
                  status: service.currentStatus,
                  timestamp,
                  responseTime: service.lastResponseTime
                }
              }
            }
          }
        });

        if(config.DebugMode) console.log(`Status for ${service.name} saved at ${timestamp}`);
      }
    }

    if (updates.length > 0) {
      await Service.bulkWrite(updates);
    }
  } catch (error) {
    logError('Error in periodicallySaveStatus', error);
  }
}

// Timer handles so the status-update and Discord-update intervals can be
// rescheduled when their interval settings change in the dashboard.
let statusUpdateTimer = null;
let discordUpdateTimer = null;

function rescheduleStatusUpdates() {
  let interval = 60000;
  try { interval = parseDuration(config.PageSettings.updateInterval); } catch (e) { /* use default */ }
  if (statusUpdateTimer) clearInterval(statusUpdateTimer);
  statusUpdateTimer = setInterval(updateStatuses, interval);
}

function rescheduleDiscordUpdates() {
  let interval = 60000;
  try {
    interval = config.DiscordBot && config.DiscordBot.UpdateInterval
      ? parseDuration(config.DiscordBot.UpdateInterval)
      : parseDuration(config.PageSettings.updateInterval);
  } catch (e) { /* use default */ }
  if (discordUpdateTimer) clearInterval(discordUpdateTimer);
  if (config.DiscordBot && config.DiscordBot.Enabled && discordBotInitialized) {
    discordUpdateTimer = setInterval(updateDiscordStatus, interval);
  }
}

async function startServices() {
  console.log("[STARTUP] Starting PlasmaStatus services...");

  // Ensure MongoDB is connected before any model queries.
  // connectToMongoDB() was called at module load (fire-and-forget), but on
  // Vercel with bufferCommands:false the connection may not be ready yet.
  await connectToMongoDB();

  // Load dashboard-managed settings before anything reads them.
  await settings.seedIfNeeded();
  config = settings.getConfig();

  await createDatabaseIndexes();
  await seedServicesIfEmpty();
  console.log("[INIT] Services initialized");

  await updateStatuses();
  console.log("[STATUS] Initial status update completed");

  if (config.DiscordBot && config.DiscordBot.Enabled) {
    try {
      console.log("[DISCORD] Initializing Discord bot...");
      discordBotInitialized = await discordBot.initializeBot();

      if (discordBotInitialized) {
        console.log(`[DISCORD] Bot initialized successfully`);

        await updateDiscordStatus();
        console.log(`[DISCORD] Status embed updated successfully`);

        rescheduleDiscordUpdates();
        console.log(`[DISCORD] Scheduled regular Discord status updates`);
      } else {
        console.log(`[DISCORD] Failed to initialize Discord bot`);
      }
    } catch (error) {
      logError('Error during Discord initialization', error);
    }
  }

  if (process.env.VERCEL) {
    // On Vercel, service checks are triggered on-demand (page loads and
    // Discord slash commands) rather than on a timer.  The Discord bot's
    // WebSocket connection cannot run inside a serverless function either,
    // so we skip the setInterval calls entirely in this environment.
    console.log('[STATUS] Vercel environment detected — using on-demand checking (no setInterval).');
  } else {
    rescheduleStatusUpdates();
    setInterval(periodicallySaveStatus, 6 * 60 * 1000);
    console.log(`[STATUS] Setting up regular status updates...`);
  }
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Serve the dashboard-uploaded logo/favicon from the DB, falling back to the
// bundled defaults in public/. Registered before express.static so these win.
async function serveBrandingAsset(field, defaultFile, res) {
  try {
    const doc = await Settings.findOne().select(field);
    const asset = doc && doc[field];
    if (asset && asset.data) {
      res.set('Content-Type', asset.contentType || 'application/octet-stream');
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Cache-Control', 'no-cache');
      return res.send(asset.data);
    }
  } catch (e) {
    logError(`Error serving ${field}`, e);
  }
  res.sendFile(path.join(__dirname, 'public', defaultFile));
}

app.get('/logo.png', (req, res) => serveBrandingAsset('logo', 'logo.png', res));
app.get('/favicon.ico', (req, res) => serveBrandingAsset('favicon', 'favicon.ico', res));

app.use(express.static('public'));

function aggregateHistory(serviceHistory) {
  if (!serviceHistory || !Array.isArray(serviceHistory)) {
    return {};
  }

  const historyByDay = {};

  serviceHistory.forEach(entry => {
    const date = new Date(entry.timestamp).toISOString().split('T')[0]; 
    
    if (!historyByDay[date]) {
      historyByDay[date] = { 
        total: 0, 
        online: 0, 
        offline: 0, 
        maintenance: 0,
        responseTimes: [],
        offlineDurations: [],
        status: 'online',
        uptimePercentage: 100
      };
    }
    
    historyByDay[date].total++;
    
    if (entry.status === 'offline') {
      historyByDay[date].offline++;
      if (entry.duration) {
        historyByDay[date].offlineDurations.push(entry.duration);
      }
    } else if (entry.status === 'maintenance') {
      historyByDay[date].maintenance++;
    } else {
      historyByDay[date].online++;
    }
    
    if (entry.responseTime) {
      historyByDay[date].responseTimes.push(entry.responseTime);
    }
    
    if (historyByDay[date].total > 0) {
      const onlineRatio = historyByDay[date].online / historyByDay[date].total;
      historyByDay[date].uptimePercentage = (onlineRatio * 100).toFixed(2);
    }
    
const maintenanceRatio = historyByDay[date].maintenance / historyByDay[date].total;
const uptimePercentage = parseFloat(historyByDay[date].uptimePercentage);

if (maintenanceRatio >= 0.5) {
  historyByDay[date].status = 'maintenance';
} else if (uptimePercentage >= 99.5) {
  historyByDay[date].status = 'online';
} else if (uptimePercentage >= 80) {
  historyByDay[date].status = 'partial';
} else {
  historyByDay[date].status = 'offline';
}
    
    if (historyByDay[date].responseTimes.length > 0) {
      const totalResponseTime = historyByDay[date].responseTimes.reduce((sum, time) => sum + time, 0);
historyByDay[date].avgResponseTime = Math.round(totalResponseTime / historyByDay[date].responseTimes.length);
   }
 });

 return historyByDay;
}

function getLast90UniqueDays(historyByDay) {
 const uniqueDays = Object.keys(historyByDay)
   .sort((a, b) => new Date(a) - new Date(b))
   .slice(-90);

 const result = uniqueDays.map(date => ({
   date,
   status: historyByDay[date].status,
   durations: historyByDay[date].offlineDurations || [],
   uptimePercentage: historyByDay[date].uptimePercentage || '100',
   avgResponseTime: historyByDay[date].avgResponseTime
 }));

 while (result.length < 90) {
   result.unshift({ 
     date: 'N/A', 
     status: 'placeholder', 
     durations: [],
     uptimePercentage: '100',
     avgResponseTime: null
   });
 }

 return result;
}

// ---------------------------------------------------------------------------
// Staff authentication routes
// ---------------------------------------------------------------------------
app.get('/login', passport.authenticate('discord'));

app.get('/auth/discord/callback', (req, res, next) => {
  passport.authenticate('discord', (err, user) => {
    if (err) {
      // Surface the real reason instead of silently bouncing to /login.
      // passport-oauth2 TokenError puts Discord's reason in .code / .message.
      const detail = [err.code, err.message].filter(Boolean).join(': ') || 'Unknown OAuth error';
      logError('Discord OAuth token exchange failed', err);
      console.error('\x1b[31m[OAUTH] Discord login failed:\x1b[0m', detail);
      return res.status(500).render('error', {
        config,
        message: `Discord login failed (${detail}). This almost always means the Client Secret is wrong or the redirect URL in the Discord Developer Portal does not exactly match your callbackURL.`
      });
    }
    if (!user) return res.redirect('/login');
    req.logIn(user, (loginErr) => {
      if (loginErr) {
        logError('Discord login session error', loginErr);
        return res.redirect('/login');
      }
      // Only honour a local path, never an absolute/`//` URL (open-redirect guard).
      const raw = req.cookies['redirectAfterLogin'];
      const redirectUrl = (typeof raw === 'string' && /^\/(?!\/)/.test(raw)) ? raw : '/dashboard';
      res.clearCookie('redirectAfterLogin');
      res.redirect(redirectUrl);
    });
  })(req, res, next);
});

app.get('/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    res.redirect('/');
  });
});

// ---------------------------------------------------------------------------
// Staff dashboard
// ---------------------------------------------------------------------------
function toBool(value) {
  return value === true || value === 'true' || value === 'on' || value === '1';
}

app.get('/dashboard', isLoggedIn, checkStaffAccess, async (req, res) => {
  try {
    const services = await Service.find().sort({ category: 1, name: 1 }).lean();
    res.render('dashboard', {
      config,
      user: req.user,
      services,
      saved: req.query.saved === '1'
    });
  } catch (error) {
    logError('Error loading dashboard', error);
    res.status(500).send('An error occurred while loading the dashboard.');
  }
});

app.post('/dashboard/settings',
  isLoggedIn,
  checkStaffAccess,
  handleBrandingUpload, // parses multipart body (incl. _csrf) before the CSRF check
  verifyCsrf,
  async (req, res) => {
    try {
      const b = req.body || {};
      const doc = await Settings.findOne() || new Settings();

      // Page
      const page = b.page || {};
      doc.PageSettings.Name = page.Name ?? doc.PageSettings.Name;
      doc.PageSettings.Description = page.Description ?? doc.PageSettings.Description;
      const theme = String(page.Theme || '').toLowerCase();
      if (theme === 'simple' || theme === 'professional') doc.PageSettings.Theme = theme;
      // Only accept a valid hex colour (defends the <style> injection surface).
      if (page.ThemeColor && /^#[0-9a-fA-F]{6}$/.test(page.ThemeColor)) doc.PageSettings.ThemeColor = page.ThemeColor;
      if (page.updateInterval) doc.PageSettings.updateInterval = page.updateInterval;

      // Announcement
      const ann = b.announcement || {};
      const ANN_TYPES = ['info', 'warning', 'success', 'error'];
      doc.Announcement.Enabled = toBool(ann.Enabled);
      doc.Announcement.Message = ann.Message ?? doc.Announcement.Message;
      if (ANN_TYPES.includes(ann.Type)) doc.Announcement.Type = ann.Type;
      doc.Announcement.Dismissible = toBool(ann.Dismissible);

      // Discord bot (Token stays in config.yml)
      const bot = b.bot || {};
      doc.DiscordBot.Enabled = toBool(bot.Enabled);
      doc.DiscordBot.GuildID = bot.GuildID ?? doc.DiscordBot.GuildID;
      doc.DiscordBot.ChannelID = bot.ChannelID ?? doc.DiscordBot.ChannelID;
      if (bot.UpdateInterval) doc.DiscordBot.UpdateInterval = bot.UpdateInterval;

      // Status colours
      const colors = b.colors || {};
      for (const key of ['Online', 'Offline', 'PartialOffline', 'Maintenance']) {
        if (colors[key]) doc.StatusColors[key] = colors[key];
      }

      // Performance
      const perf = b.perf || {};
      for (const key of ['ConcurrencyLimit', 'DebounceCount', 'DebounceWindow', 'MaxBackoffInterval']) {
        const num = Number(perf[key]);
        if (!Number.isNaN(num) && perf[key] !== '' && perf[key] !== undefined) doc.Performance[key] = num;
      }

      // Webhook messages
      const webhook = b.webhook || {};
      const currentWebhook = doc.WebhookMessages || {};
      doc.WebhookMessages = {
        Online: {
          Title: webhook.Online?.Title ?? currentWebhook.Online?.Title ?? '',
          Description: webhook.Online?.Description ?? currentWebhook.Online?.Description ?? ''
        },
        Offline: {
          Title: webhook.Offline?.Title ?? currentWebhook.Offline?.Title ?? '',
          Description: webhook.Offline?.Description ?? currentWebhook.Offline?.Description ?? ''
        }
      };
      doc.markModified('WebhookMessages');

      // Discord embed
      const embed = b.embed || {};
      const currentEmbed = doc.DiscordEmbed || {};
      let fields = currentEmbed.Fields || [];
      if (b.embedFieldsJson !== undefined) {
        try {
          const parsed = JSON.parse(b.embedFieldsJson || '[]');
          if (Array.isArray(parsed)) fields = parsed;
        } catch (e) {
          // Keep the previous Fields if the JSON is invalid.
        }
      }
      doc.DiscordEmbed = {
        Title: embed.Title ?? currentEmbed.Title ?? '',
        Description: embed.Description ?? currentEmbed.Description ?? '',
        Colors: {
          online: embed.Colors?.online ?? currentEmbed.Colors?.online ?? '#10b981',
          offline: embed.Colors?.offline ?? currentEmbed.Colors?.offline ?? '#ef4444',
          partial: embed.Colors?.partial ?? currentEmbed.Colors?.partial ?? '#f59e0b',
          maintenance: embed.Colors?.maintenance ?? currentEmbed.Colors?.maintenance ?? '#8b5cf6'
        },
        Emojis: {
          online: embed.Emojis?.online ?? currentEmbed.Emojis?.online ?? '🟢',
          offline: embed.Emojis?.offline ?? currentEmbed.Emojis?.offline ?? '🔴',
          partial: embed.Emojis?.partial ?? currentEmbed.Emojis?.partial ?? '🟠',
          maintenance: embed.Emojis?.maintenance ?? currentEmbed.Emojis?.maintenance ?? '🔧'
        },
        ServiceFormat: embed.ServiceFormat ?? currentEmbed.ServiceFormat ?? '',
        CategoryFormat: embed.CategoryFormat ?? currentEmbed.CategoryFormat ?? '',
        FooterText: embed.FooterText ?? currentEmbed.FooterText ?? '',
        ShowUptime: toBool(embed.ShowUptime),
        ShowResponseTime: toBool(embed.ShowResponseTime),
        ShowThumbnail: toBool(embed.ShowThumbnail),
        ShowFooter: toBool(embed.ShowFooter),
        ShowFields: toBool(embed.ShowFields),
        Fields: fields
      };
      doc.markModified('DiscordEmbed');

      // Branding uploads -> stored in the DB (persist across rebuilds).
      if (req.files && req.files.logo && req.files.logo[0]) {
        const logoType = LOGO_MIMES.includes(req.files.logo[0].mimetype) ? req.files.logo[0].mimetype : 'image/png';
        doc.logo = { data: req.files.logo[0].buffer, contentType: logoType };
      }
      if (req.files && req.files.favicon && req.files.favicon[0]) {
        doc.favicon = { data: req.files.favicon[0].buffer, contentType: 'image/x-icon' };
      }

      doc.updatedAt = new Date();
      await doc.save();

      // Apply immediately.
      config = await settings.refresh();
      pageCache.timestamp = 0;
      rescheduleStatusUpdates();
      rescheduleDiscordUpdates();

      res.redirect('/dashboard?saved=1');
    } catch (error) {
      logError('Error saving dashboard settings', error);
      res.status(500).send('An error occurred while saving settings.');
    }
  }
);

// --- Service CRUD (JSON) ---
const VALID_TYPES = ['website', 'ip', 'minecraft', 'tcp', 'udp'];

function parseServiceBody(body) {
  const name = (body.name || '').trim();
  const url = (body.url || '').trim();
  const type = (body.type || '').trim();
  const category = (body.category || '').trim() || 'Uncategorized';
  const webhookURL = (body.webhookURL || '').trim() || null;
  const tooltip = (body.tooltip || '').trim() || null;
  const maintenance = toBool(body.maintenance);
  let port = null;
  if (type === 'tcp' || type === 'udp') {
    port = Number(body.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { error: 'TCP and UDP services need a valid port (1-65535).' };
    }
  }
  if (!name) return { error: 'Name is required.' };
  if (!url) return { error: 'URL / host is required.' };
  if (!VALID_TYPES.includes(type)) return { error: 'Invalid service type.' };
  return { data: { name, url, type, category, webhookURL, tooltip, maintenance, port } };
}

app.post('/dashboard/services', isLoggedIn, checkStaffAccess, verifyCsrf, async (req, res) => {
  const parsed = parseServiceBody(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  try {
    const existing = await Service.findOne({ name: parsed.data.name });
    if (existing) return res.status(409).json({ error: 'A service with that name already exists.' });

    await Service.create({
      ...parsed.data,
      currentStatus: 'unknown',
      lastResponseTime: 0,
      history: []
    });
    backoffMap.delete(parsed.data.name);
    statusDebouncer.resetDebounce(parsed.data.name);
    pageCache.timestamp = 0;
    res.json({ success: true });
  } catch (error) {
    logError('Error creating service', error);
    res.status(500).json({ error: 'Failed to create service.' });
  }
});

app.put('/dashboard/services/:id', isLoggedIn, checkStaffAccess, verifyCsrf, async (req, res) => {
  const parsed = parseServiceBody(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  try {
    const service = await Service.findById(req.params.id);
    if (!service) return res.status(404).json({ error: 'Service not found.' });

    const nameClash = await Service.findOne({ name: parsed.data.name, _id: { $ne: service._id } });
    if (nameClash) return res.status(409).json({ error: 'A service with that name already exists.' });

    const oldName = service.name;
    Object.assign(service, parsed.data);
    await service.save();

    backoffMap.delete(oldName);
    backoffMap.delete(parsed.data.name);
    statusDebouncer.resetDebounce(oldName);
    statusDebouncer.resetDebounce(parsed.data.name);
    pageCache.timestamp = 0;
    res.json({ success: true });
  } catch (error) {
    logError('Error updating service', error);
    res.status(500).json({ error: 'Failed to update service.' });
  }
});

app.delete('/dashboard/services/:id', isLoggedIn, checkStaffAccess, verifyCsrf, async (req, res) => {
  try {
    const service = await Service.findByIdAndDelete(req.params.id);
    if (!service) return res.status(404).json({ error: 'Service not found.' });
    backoffMap.delete(service.name);
    statusDebouncer.resetDebounce(service.name);
    pageCache.timestamp = 0;
    res.json({ success: true });
  } catch (error) {
    logError('Error deleting service', error);
    res.status(500).json({ error: 'Failed to delete service.' });
  }
});

// How stale (in ms) the status data can be before a page load triggers a
// fresh check on Vercel. Defaults to 5 minutes.
const VERCEL_STALE_THRESHOLD = parseInt(process.env.STALE_THRESHOLD_MS || '', 10) || 5 * 60 * 1000;

app.get('/', async (req, res) => {
  const cachedData = getCachedResponse();
  if (cachedData) {
    return res.render('index', cachedData);
  }

  // On Vercel, trigger an on-demand status check when data is stale.
  // On a traditional server the setInterval keeps data fresh, so this is
  // only needed in the serverless path.
  if (process.env.VERCEL) {
    try {
      const lastUpdate = await StatusUpdate.findOne().sort({ createdAt: -1 }).lean();
      const staleMs = lastUpdate ? Date.now() - new Date(lastUpdate.lastUpdated).getTime() : Infinity;
      if (staleMs > VERCEL_STALE_THRESHOLD) {
        console.log(`[STATUS] Data is ${Math.round(staleMs / 1000)}s old — running on-demand check`);
        await updateStatuses();
      }
    } catch (err) {
      console.warn('[STATUS] On-demand check failed (serving existing data):', err.message);
    }
  }

  try {
    const services = await Service.find().lean();
    const lastStatusUpdate = await StatusUpdate.findOne().sort({ createdAt: -1 });
    const lastUpdated = lastStatusUpdate ? lastStatusUpdate.lastUpdated : new Date();

    const historyByService = services.map(service => {
      const historyByDay = aggregateHistory(service.history || []);
      const last90Days = getLast90UniqueDays(historyByDay);
      
      const totalEntries = service.history ? service.history.length : 0;
      const onlineEntries = service.history ? service.history.filter(entry => entry.status === 'online').length : 0;
      const uptimePercentage = totalEntries ? (onlineEntries / totalEntries) * 100 : 0;
      
      const dayAgo = Date.now() - (24 * 60 * 60 * 1000);
      const recentHistory = service.history ? service.history.filter(entry => {
        const entryTime = new Date(entry.timestamp).getTime();
        return entryTime > dayAgo && entry.responseTime;
      }) : [];
      
      let avgResponseTime = 0;
      if (recentHistory.length > 0) {
        const totalResponseTime = recentHistory.reduce((sum, entry) => sum + (entry.responseTime || 0), 0);
        avgResponseTime = Math.round(totalResponseTime / recentHistory.length);
      } else {
        avgResponseTime = service.lastResponseTime || 0;
      }

      return {
        name: service.name,
        category: service.category || "Uncategorized",
        status: service.currentStatus,
        history: last90Days,
        tooltip: service.tooltip,
        uptimePercentage: uptimePercentage.toFixed(2),
        responseTime: avgResponseTime
      };
    });

    let overallStatus = 'All services are online';
    let statusColor = config.StatusColors.Online;
    let statusIcon = 'fas fa-check-circle';
    let statusClass = 'online';
    const onlineServices = historyByService.filter(service => service.status === 'online').length;

    if (onlineServices === 0) {
      overallStatus = 'All services are offline';
      statusColor = config.StatusColors.Offline;
      statusIcon = 'fas fa-times-circle';
      statusClass = 'offline';
    } else if (onlineServices < services.length) {
      overallStatus = 'Partial services are offline';
      statusColor = config.StatusColors.PartialOffline;
      statusIcon = 'fas fa-exclamation-circle';
      statusClass = 'partial';
    }

    function getRelativeTime(date) {
      const currentDate = new Date();
      const targetDate = new Date(date);
      const timeDifference = currentDate.getTime() - targetDate.getTime();

      const seconds = Math.floor(timeDifference / 1000);
      const minutes = Math.floor(seconds / 60);
      const hours = Math.floor(minutes / 60);
      const days = Math.floor(hours / 24);

      if (days > 0) {
          return days === 1 ? '1 day ago' : `${days} days ago`;
      } else if (hours > 0) {
          return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
      } else if (minutes > 0) {
          return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
      } else {
          return seconds <= 10 ? 'just now' : `${seconds} seconds ago`;
      }
    }

    function hexToRgb(hex) {
      hex = hex.replace(/^#/, '');
    
      let bigint = parseInt(hex, 16);
      let r = (bigint >> 16) & 255;
      let g = (bigint >> 8) & 255;
      let b = bigint & 255;
    
      return `${r}, ${g}, ${b}`;
    }

    const themeColorRgb = hexToRgb(config.PageSettings.ThemeColor);

    const servicesByCategory = historyByService.reduce((categories, service) => {
      categories[service.category] = categories[service.category] || [];
      categories[service.category].push(service);
      return categories;
    }, {});

    const renderData = { 
      services: historyByService, 
      themeColorRgb, 
      servicesByCategory, 
      lastUpdated, 
      getRelativeTime, 
      overallStatus, 
      statusColor, 
      statusIcon, 
      statusClass, 
      config 
    };

    setCachedResponse(renderData);

    res.render('index', renderData);
  } catch (error) {
    logError('Error rendering index page', error);
    res.status(500).send('Internal Server Error');
  }
});

app.get('/refresh', refreshLimiter, async (req, res) => {
 try {
   await updateStatuses();
   const lastStatusUpdate = await StatusUpdate.findOne().sort({ createdAt: -1 });
   const lastUpdated = lastStatusUpdate ? lastStatusUpdate.lastUpdated : new Date();

   res.json({ lastUpdated });
 } catch (error) {
   logError('Error refreshing status', error);
   res.status(500).json({ error: 'Failed to refresh status' });
 }
});

process.on('SIGTERM', async () => {
 console.log('Received SIGTERM, shutting down gracefully...');
 try {
   await mongoose.connection.close();
   process.exit(0);
 } catch (error) {
   console.error('Error during shutdown:', error);
   process.exit(1);
 }
});

process.on('SIGINT', async () => {
 console.log('Received SIGINT, shutting down gracefully...');
 try {
   await mongoose.connection.close();
   process.exit(0);
 } catch (error) {
   console.error('Error during shutdown:', error);
   process.exit(1);
 }
});

// ── Serverless / Vercel support ──────────────────────────────────────────────
// When VERCEL=1 (set automatically by the Vercel runtime) we export the Express
// app so @vercel/node can serve it. The startup logic (license check, initial
// status poll, setInterval monitors) is triggered lazily on the first request
// via api/index.js instead of here at module load time.
// In a traditional Node.js environment (npm start) we call app.listen() as usual.

let _startupPromise = null;

/**
 * runStartup() — idempotent.  Runs once and then every subsequent call returns
 * the same promise. This is safe to call from both the Vercel handler and the
 * traditional listen() callback.
 */
async function runStartup() {
  if (_startupPromise) return _startupPromise;
  _startupPromise = (async () => {
    if (!(await license.authenticate(config))) {
      if (process.env.VERCEL) {
        // On Vercel we cannot call process.exit() — it would kill the runtime.
        // Log loudly and continue so the app at least serves an error page.
        console.error('[PlasmaStatus] LICENSE VALIDATION FAILED. Requests will return 503 until a valid license is set.');
        return false;
      }
      process.exit(1);
    }

    console.log("――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――");
    console.log(`${color.green.bold.underline(`PlasmaStatus v${botVersion.version} is now Online!`)}`);
    console.log(`• Join our discord server for support, ${color.cyan(`plsrv.co/discord`)}`);
    console.log(`• By using this product you agree to our terms, ${color.yellow(`plasma.services`)}`);
    console.log("――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――");

    if (!process.env.VERCEL) {
      console.log(color.yellow("[DASHBOARD] ") + `Web Server has started and is accessible with port ${color.yellow(`${config.PageSettings.Port}`)}`);
    }

    try {
      const pingRes = await ping.promise.probe('8.8.8.8');
      if (pingRes.alive) {
        if (config.DebugMode) console.log(`Ping to 8.8.8.8 successful. Server has sufficient permissions.`);
      }
    } catch (error) {
      console.warn(
        color.yellow.bold('\n\n[WARNING] ') +
        'Since you are hosting the application on pterodactyl, or similar and it does not have access to pinging, \nDirect IP pinging won\'t work. ' +
        'IP services will instead be checked by connecting to common TCP ports (443, 80, 22). ' +
        '\nIt will still work, so don\'t worry. ' +
        color.gray('\nYou can safely ignore this message. (It only affects the IP type) ') +
        '\nHowever, we recommend hosting it on a VPS or another environment if you want to ping everything yourself.\n\n'
      );
    }

    await startServices();
    return true;
  })();
  return _startupPromise;
}

// Expose a function that Vercel's cron handler can call to trigger a status
// refresh without going through HTTP routing.
async function triggerStatusUpdate() {
  // Ensure startup has run at least once before polling
  await runStartup();
  await updateStatuses();
}

if (process.env.VERCEL) {
  // Serverless: export the app; api/index.js wraps it with startup logic.
  module.exports = { app, runStartup, triggerStatusUpdate };
} else {
  // Traditional server: boot normally.
  app.listen(port, async () => {
    try {
      await runStartup();
    } catch (error) {
      logError('Error during license validation or startup', error);
      process.exit(1);
    }
  });
}

const packageFile = require('./package.json');

async function handleAndUploadError(errorType, error) {
 console.log(error);

 const errorPrefix = `[${new Date().toLocaleString()}] [${errorType}] [v${packageFile.version}]`;
 const errorMsg = `\n\n${errorPrefix}\n${error.stack}`;
 fs.appendFile("./logs.txt", errorMsg, (e) => {
   if (e) console.log(e);
 });

 console.log(`${color.green.bold(`[v${packageFile.version}]`)} ${color.red(`If you require assistance, create a ticket in our Discord server (${color.cyan('plsrv.co/discord')}) and attach your logs.txt file.`)}`);
}

process.on('warn', async (error) => {
 handleAndUploadError('WARN', error);
});

process.on('error', async (error) => {
 handleAndUploadError('ERROR', error);
});

process.on('unhandledRejection', async (error) => {
 handleAndUploadError('unhandledRejection', error);
});

process.on('uncaughtException', async (error) => {
 handleAndUploadError('uncaughtException', error);
});