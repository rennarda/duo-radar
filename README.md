# Duo Radar

A self-hosted UK iPhone Duo pickup monitor. A checker on your home computer checks all eight colour and storage variants against Apple's UK store pickup response once a minute. The Cloudflare site shows current availability and sends browser push alerts when a watched store becomes newly available. Each alert opens Apple's UK iPhone Duo buying page with the matching product selected; choose pickup during Apple's checkout. Availability is not a reservation.

The six stores are preselected:

| Place | Apple Store |
| --- | --- |
| Birmingham | Birmingham, New Street |
| Solihull | Touchwood Centre |
| Leicester | Highcross |
| Manchester | Manchester Arndale; Trafford Centre |
| Sheffield | Meadowhall |

## Run

Requires Node.js 20+ and a server with outbound HTTPS access to `www.apple.com` and browser push endpoints.

```bash
npm install
export ADMIN_TOKEN="$(openssl rand -hex 32)"
npm start
```

Open `http://localhost:3000`, enter the token, and enable browser notifications. Keep the token in a password manager. State, subscriptions, and VAPID keys are saved in `data/state.json`; back it up and keep it private. For a remote installation, serve the app over HTTPS. On iPhone, install the page to the Home Screen before enabling push alerts.

## Free hosting: Cloudflare Workers

The `cloudflare/` Worker hosts the dashboard and browser push subscriptions in Cloudflare D1. Apple returns HTTP 541 to this Worker's outbound stock requests, so `scripts/home-checker.js` checks Apple from a home computer and sends results to the Worker. Keep that computer on and connected. The home checker makes one Apple request per minute; the Worker itself does not query Apple.

### Deploy from GitHub

The repository includes a manually triggered [GitHub Actions workflow](.github/workflows/deploy-cloudflare.yml). Keep the Cloudflare API token in GitHub Actions secrets, never in this repository or chat.

1. The D1 database named `duo-radar` is already created and its ID is configured in `wrangler.jsonc`.
2. In this repository's **Settings → Secrets and variables → Actions**, add `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. Scope the API token to your account with Workers Scripts Edit and D1 Edit permissions.
3. On GitHub, open **Actions → Deploy Duo Radar to Cloudflare → Run workflow**. It applies the schema and deploys the Worker to a `*.workers.dev` HTTPS address.
4. In the Cloudflare Worker settings, add the runtime secret `ADMIN_TOKEN` with a unique value of at least 24 characters. The Worker generates browser push keys on first use and keeps them in D1.
5. Open the Worker URL, enter `ADMIN_TOKEN`, and enable push notifications. The six requested stores are already selected. On iPhone, add the page to the Home Screen first.
6. Start the home checker as described below. The dashboard should show a recent successful check.

### Deploy from a local terminal

If you prefer to deploy without GitHub Actions, sign in with `npx wrangler login` and:

1. Run `npm ci`, then `npx wrangler d1 create duo-radar`.
2. Confirm the returned database ID matches `wrangler.jsonc`.
3. Run `npx wrangler d1 execute duo-radar --remote --file cloudflare/schema.sql`.
4. Run `npm run cf:deploy` to create the Worker and its `*.workers.dev` HTTPS address.
5. Set `ADMIN_TOKEN` with `npx wrangler secret put ADMIN_TOKEN`, entering a unique value of at least 24 characters at the prompt. The Worker generates browser push keys on first use and keeps them in D1.
6. Open the Worker URL, enter `ADMIN_TOKEN`, and enable push notifications. The six requested stores are already selected. On iPhone, add the page to the Home Screen first. Start the home checker as described below.

### Run the one-minute home checker

On a computer that can stay awake, install Node.js 20 or newer, download this repository, and run:

```bash
npm run home -- --once
```

Enter the same dashboard password used on the Cloudflare site. The checker saves it to your user profile in `.duo-radar/admin-token` for future starts; it is never committed to GitHub. Run `npm run home` to keep checking while the terminal stays open, or install the Mac background job below. To replace the saved password, run `npm run home -- --reset-token`.

On a Mac, after the first successful one-off check, run `npm run home:install-mac` to start the checker automatically at login and restart it if it stops. Keep the repository folder in the same place. The background log is `~/.duo-radar/checker.log`; run `npm run home:remove-mac` to stop automatic checks. The Mac still needs to stay awake and connected; closing a MacBook lid normally suspends it.

To verify the full path from the Mac checker through the website and browser push, run `npm run home -- --test-stock`. It fetches a real Apple response, changes one unavailable configuration to a simulated available one, and sends it through the normal report endpoint. The notification and dashboard row say **TEST ONLY** and link back to the dashboard, never to Apple's checkout. The simulated row is separate from live availability and expires after five minutes.

The dashboard reports the last check time and any Apple error. It shows **Checker offline** if no report arrives for three minutes. Check `/health` for the site's basic availability. The Worker stores no secret or subscription in the GitHub repository.

## Alternative hosting: Railway

Railway can run the Node checker continuously, issue a public HTTPS domain, and attach a persistent volume for push subscriptions. Create a Railway service from this source (via GitHub or the Railway CLI), then:

1. Add a volume to the service and mount it at `/data`.
2. Set `DATA_DIR=/data`, `HOST=0.0.0.0`, `ADMIN_TOKEN` to a fresh random 32-byte hex value, and `VAPID_SUBJECT=mailto:your-address@example.com` with your real contact address. Railway supplies `PORT`.
3. In service settings, leave Serverless disabled so the minute-by-minute checker keeps running. Generate a public Railway domain under **Networking → Public Networking**. Set the health check path to `/health`.
4. Open the HTTPS domain, unlock the dashboard with `ADMIN_TOKEN`, and enable push alerts. Keep the service at one replica because it uses a single state file and polling loop.

The Railway volume holds `state.json`, including push subscriptions and VAPID keys. Do not remove it during redeploys. You can start on Railway Free: after its trial, it includes $1 of usage credit each month and supports a 0.5 GB volume. Check Railway's usage dashboard to confirm this continuously running service stays within that credit. A limited trial may restrict outbound access to Apple; verify the dashboard's first stock check succeeds. Railway Hobby has a $5 monthly minimum usage with $5 of included usage credits.

The checker lives in the Node process. Keep `npm start` running under a process manager or systemd. `POLL_SECONDS` can change the interval but is clamped to at least 30 seconds. Apple's pickup endpoint is unofficial and may change or rate-limit requests; the dashboard reports errors and never treats an error as stock availability.

If your server requires an HTTP proxy for outbound traffic and uses Node.js 24, start it with `NODE_USE_ENV_PROXY=1` while preserving `HTTPS_PROXY` and `HTTP_PROXY`.

Environment variables: `PORT` (default `3000`), `HOST` (default `127.0.0.1`), `ADMIN_TOKEN` (required, 24+ characters), `POLL_SECONDS` (default `60`), `DATA_DIR` (default `./data`). Run `npm test` for the stock parsing checks.
