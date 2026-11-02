# PlasmaStatus

A real-time service status page with a staff dashboard, Discord slash commands, service history, and announcement banners — **fully deployable on Vercel's free tier**.

**Original project by [Plasma Services](https://plasma.services)**  
**Discord:** [plsrv.co/discord](https://plsrv.co/discord)

---

## Deploy to Vercel (free tier)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Flogleonard01-web%2FPlasma-Status-Vercel&env=MONGODB_URI,DISCORD_CLIENT_ID,DISCORD_CLIENT_SECRET,DISCORD_PUBLIC_KEY,DISCORD_BOT_TOKEN,BASE_URL,DISCORD_CALLBACK_URL,OWNER_IDS,SECRET_KEY&envDescription=Required%20environment%20variables%20for%20PlasmaStatus&envLink=https%3A%2F%2Fgithub.com%2Flogleonard01-web%2FPlasma-Status-Vercel%2Fblob%2Fmain%2F.env.example&project-name=plasma-status&repository-name=plasma-status)

**No paid plan required.** Service monitoring uses Discord's Interactions API (webhook-based) and on-demand checking — no cron jobs, no persistent processes.

---

## How it works on Vercel (free tier)

| Feature | How it runs |
|---|---|
| Public status page | Serverless Express — checks for stale data on each load |
| Staff dashboard | Same handler — sessions stored in MongoDB |
| `/status` command | Discord sends a POST to `/api/discord` → Vercel handles it instantly |
| `/check` command | Triggers a live re-check of all services |
| Service monitoring | On-demand: triggered by page loads and Discord slash commands |
| Discord bot embed | Triggered by `/check` command (no WebSocket needed) |
| Database | MongoDB Atlas (free M0 cluster) |

### Why no cron jobs?

The original PlasmaStatus polls services on a timer. On Vercel's **free tier**, cron jobs run at most once per day — not useful for a status page.

Instead, this version uses **on-demand checking**:
- A page load checks if the last status update is older than 5 minutes. If it is, it runs a fresh check before rendering.
- Discord's `/check` slash command triggers an immediate live check at any time.
- Discord's `/status` command always shows the latest data from the database.

This means the page is always within 5 minutes of current (or fresher if someone recently ran `/check`), and you never need a cron job.

---

## Slash Commands

| Command | Description | Staff only |
|---|---|---|
| `/status` | Show the overall status of all services | No |
| `/status service:<name>` | Detailed status for one specific service | No |
| `/uptime` | Uptime percentages for all services | No |
| `/uptime days:<1-90>` | Uptime over a custom number of days | No |
| `/check` | Trigger an immediate live check of all services | No |
| `/embed setup channel:#channel` | Post a live auto-updating status embed | ✅ Yes |
| `/embed remove` | Stop and delete the auto-updating embed | ✅ Yes |
| `/incident create message:<text>` | Post a new incident | ✅ Yes |
| `/incident create message:<text> type:<level>` | Post a typed incident | ✅ Yes |
| `/incident resolve` | Mark the current incident as resolved | ✅ Yes |
| `/incident list` | List recent incidents | No |

Staff access is determined by the Discord user IDs in `OWNER_IDS`.

### Auto-updating embed

`/embed setup` posts a rich status embed to any channel you choose. It updates **automatically** every time a status check runs — no cron job needed. The embed edits in place, so it stays pinned at the same spot and never floods your channel.

**How it updates:**
- Every page load that finds stale data (>5 min old) runs a check → embed updates
- Every `/check` command → embed updates
- No other action required

**Setup steps:**
1. Make sure the bot has **Send Messages** and **Embed Links** permissions in the target channel
2. Run `/embed setup channel:#your-channel` — the embed appears instantly
3. That's it — it stays live automatically

Run `/embed remove` to delete the message and turn it off.

---

## Step-by-step Vercel deployment

### 1. MongoDB Atlas

1. Create a free account at [cloud.mongodb.com](https://cloud.mongodb.com).
2. Create a free **M0** cluster.
3. **Security → Database Access** → add a user with read/write access.
4. **Security → Network Access** → click **Add IP Address** → **Allow Access from Anywhere** (`0.0.0.0/0`). Vercel uses dynamic IPs, so this is required.
5. **Database → Connect → Drivers** → copy your connection string:
   ```
   mongodb+srv://<user>:<password>@cluster0.xxxxx.mongodb.net/plasmastatus?retryWrites=true&w=majority
   ```
   Save this as `MONGODB_URI`.

### 2. Discord Application

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications) → **New Application**.
2. **General Information** tab → copy **Application ID** (= `DISCORD_CLIENT_ID`) and **Public Key** (= `DISCORD_PUBLIC_KEY`).
3. **OAuth2 → General** → click **Reset Secret**, copy it (= `DISCORD_CLIENT_SECRET`).
4. **Bot** tab → click **Add Bot** → **Reset Token**, copy it (= `DISCORD_BOT_TOKEN`).
5. **OAuth2 → Redirects** → add (use a placeholder for now — update after deploy):
   ```
   https://your-project-name.vercel.app/auth/discord/callback
   ```
6. **General Information → Interactions Endpoint URL** — leave this blank for now; you'll fill it in after deploying.

To find your Discord User ID: **Settings → Advanced → Developer Mode**, then right-click your username → **Copy User ID** (= `OWNER_IDS`).

### 3. Deploy to Vercel

**Click the Deploy button** at the top of this README. Vercel will:
- Fork the repo to your GitHub
- Prompt you for the required environment variables (see the table below)
- Build and deploy automatically

Or **manual import**: go to [vercel.com/new](https://vercel.com/new), import your fork, fill in env vars, deploy.

### 4. Set environment variables

In **Vercel → Project → Settings → Environment Variables**:

| Variable | Where to get it |
|---|---|
| `MONGODB_URI` | MongoDB Atlas connection string (step 1) |
| `DISCORD_CLIENT_ID` | Discord Dev Portal → General Information → Application ID |
| `DISCORD_CLIENT_SECRET` | Discord Dev Portal → OAuth2 → Client Secret |
| `DISCORD_PUBLIC_KEY` | Discord Dev Portal → General Information → Public Key |
| `DISCORD_BOT_TOKEN` | Discord Dev Portal → Bot → Token |
| `BASE_URL` | `https://your-project-name.vercel.app` |
| `DISCORD_CALLBACK_URL` | `https://your-project-name.vercel.app/auth/discord/callback` |
| `OWNER_IDS` | Your Discord User ID |
| `SECRET_KEY` | Random 32-char string — `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |

After setting variables, go to **Deployments → Redeploy**.

### 5. Set the Interactions Endpoint URL

Once deployed, go back to the Discord Developer Portal → your app → **General Information** → paste into **Interactions Endpoint URL**:
```
https://your-project-name.vercel.app/api/discord
```
Click **Save Changes**. Discord will send a test ping — Vercel will respond with `{"type":1}` and Discord will confirm the endpoint.

### 6. Register slash commands

Run this once from your local machine (or anywhere with Node.js):

```bash
# Clone your repo and install dependencies
git clone https://github.com/plasmasite/Plasma-Status.git
cd Plasma-Status
npm install

# Set the required env vars (or create a .env file from .env.example)
export DISCORD_CLIENT_ID=your_client_id
export DISCORD_BOT_TOKEN=your_bot_token

# Optional: register to a specific server first (instant — no 1-hour wait)
export DISCORD_GUILD_ID=your_server_id

# Register commands
npm run register-commands
```

You should see:
```
✅  4 command(s) registered successfully:
   /status  —  Show the current status of all services...
   /uptime  —  Show uptime percentages...
   /check   —  Trigger an immediate live check...
   /incident  —  Manage service incidents.
```

> **Note:** Global commands (no `DISCORD_GUILD_ID`) take up to 1 hour to appear. For instant results during setup, register to a specific guild first, test there, then re-run without `DISCORD_GUILD_ID`.

### 7. Add the bot to your server

Generate an invite URL in the Discord Developer Portal → **OAuth2 → URL Generator**:
- Scopes: `bot`, `applications.commands`
- Bot permissions: `Send Messages`, `Embed Links`, `Read Message History`

Open the generated URL in a browser and invite the bot to your server.

### 8. First login to the dashboard

1. Visit your Vercel URL — the public status page should load.
2. Navigate to `/login` and authorise with Discord.
3. Only accounts whose ID is in `OWNER_IDS` get staff access.
4. Configure services, page settings, colours, and announcements from the dashboard.

---

## Environment variables reference

See [`.env.example`](./.env.example) for the full list with descriptions and generation instructions.

---

## Monitoring frequency

By default, a page load triggers a fresh check if the last check was more than **5 minutes ago**. You can adjust this with the `STALE_THRESHOLD_MS` environment variable:

```
STALE_THRESHOLD_MS=60000   # 1 minute (aggressive — slower page loads)
STALE_THRESHOLD_MS=300000  # 5 minutes (default)
STALE_THRESHOLD_MS=600000  # 10 minutes (relaxed)
```

The `/check` Discord command always triggers an immediate check regardless of this setting.

---

## Self-hosted / Docker deployment

The original Docker setup still works unchanged. Edit `config.yml` and run:

```bash
docker-compose up -d
# or
npm install && npm start
```

On a traditional server, `setInterval` runs at the configured update interval. Environment variables always override `config.yml` when both are set.

---

## Troubleshooting

**"Service starting up, please retry in a moment."**  
The function is cold-starting (license check + DB seed). Refresh in a few seconds. Check Vercel function logs for errors.

**Discord endpoint verification failed**  
- Make sure `DISCORD_PUBLIC_KEY` is set correctly (it's on the app's **General Information** page, not the bot token).
- The URL must be exactly `https://your-domain.vercel.app/api/discord` with no trailing slash.
- Redeploy after setting the env var — the function must be deployed with the key to verify signatures.

**Slash commands not showing up**  
- Run `npm run register-commands` again.
- For instant results, set `DISCORD_GUILD_ID` to your server ID.
- Check that the bot has been invited with the `applications.commands` scope.

**MongoDB connection error**  
- Atlas Network Access must allow `0.0.0.0/0` (Vercel uses dynamic IPs).
- Verify the connection string includes the database name (`/plasmastatus`).
- URL-encode special characters in the password (e.g. `@` → `%40`).

**Discord OAuth redirect mismatch**  
`DISCORD_CALLBACK_URL` must match the redirect URL in the Discord Developer Portal exactly, including `https://` and no trailing slash.

**Page loads are slow**  
The first load after a 5-minute gap triggers a full service check. Lower `STALE_THRESHOLD_MS` trades freshness for slower loads. Run `/check` in Discord to pre-warm the cache without a page load.
