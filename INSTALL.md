# Portal ERP — VPS install guide

Tested on Ubuntu 22.04 LTS / Debian 12. Should work on any Linux with Node.js 18+.
Stack: Node + Express + SQLite (single-writer). No external DB or Redis needed.

---

## TL;DR — one-liner install

On a fresh Ubuntu/Debian VPS, as root:

```bash
curl -fsSL https://raw.githubusercontent.com/steven-patrick18/portal/main/install.sh | sudo bash
```

This runs [install.sh](install.sh) which: installs Node 20 + nginx + sqlite, creates a `portal` user, clones the repo to `/var/www/portal`, generates a secure SESSION_SECRET, runs `npm ci`, initializes the DB, sets up PM2 with boot-time autostart, installs the nginx reverse-proxy site, configures ufw, and adds a daily backup cron. **Idempotent** — re-running on an existing install only updates what's needed and never touches your `.env` or DB.

Then edit `/var/www/portal/.env` to set your `COMPANY_*` defaults, point your DNS at the VPS, and run `certbot --nginx -d your-domain.com` for HTTPS.

To update later:

```bash
sudo -iu portal && cd /var/www/portal && bash update.sh
```

[update.sh](update.sh) backs up the DB first, refuses to proceed if you have uncommitted local edits, runs `git pull --ff-only`, runs `npm ci` only if `package.json` / `package-lock.json` changed, and zero-downtime reloads PM2. **Never** touches `data/`, `.env`, `public/uploads/`, or `backups/`.

---

## Manual install (if you'd rather do each step yourself)

---

## 1. Server prerequisites

```bash
# As root (or with sudo):
apt update && apt upgrade -y
apt install -y curl ca-certificates git build-essential sqlite3 nginx ufw

# Node.js 20.x (NodeSource):
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# Verify:
node --version    # v20.x
npm --version

# (Optional) PM2 process manager — skip if you'll use systemd instead:
npm install -g pm2
```

## 2. Create an unprivileged user

Don't run the app as root.

```bash
adduser --disabled-password --gecos "" portal
mkdir -p /var/www
chown portal:portal /var/www
```

## 3. Clone and install

```bash
sudo -iu portal
cd /var/www
git clone https://github.com/steven-patrick18/portal.git
cd portal
npm ci --omit=dev
```

If `better-sqlite3` fails to compile, you need `build-essential` and `python3` (already installed in step 1).

## 4. Configure environment

```bash
cp .env.example .env
# Generate a real session secret:
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
nano .env       # paste the secret into SESSION_SECRET, set NODE_ENV=production
```

Important `.env` values:

| Key | What to set |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | `6672` (Nginx will proxy 80/443 → here) |
| `SESSION_SECRET` | the 48-byte random string you just generated |
| `COMPANY_*` | your defaults (you can also set them later in **Settings → Company & Logo**) |
| `MSG91_*` | only if you have an MSG91 account; otherwise leave blank |

## 5. First-time setup

```bash
mkdir -p data logs public/uploads/products public/uploads/branding backups
npm start                # this initializes the DB schema + seeds the owner account on first run
```

You should see `Portal ERP running at http://localhost:6672`. Stop with Ctrl+C — the schema is now created.

Default login (change immediately):
- email: `owner@portal.local`
- password: `admin123`

## 6. Run as a service

Pick **one** of the two options below.

### Option A — PM2 (easier)

```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup     # follow the printed `sudo env PATH=...` command, then re-run `pm2 save`
pm2 status      # should show "portal" online
```

Logs:
```bash
pm2 logs portal             # live tail
pm2 reload portal           # zero-downtime restart after `git pull`
```

### Option B — systemd

```bash
exit                        # leave the portal user shell, back to your sudo user
sudo cp /var/www/portal/deploy/systemd.service.example /etc/systemd/system/portal.service
# Edit User= and WorkingDirectory= if your paths differ:
sudo nano /etc/systemd/system/portal.service
sudo systemctl daemon-reload
sudo systemctl enable --now portal
sudo systemctl status portal
sudo journalctl -u portal -f    # live logs
```

## 7. Nginx reverse proxy

```bash
sudo cp /var/www/portal/deploy/nginx.conf.example /etc/nginx/sites-available/portal
# Replace portal.example.com with your real domain:
sudo nano /etc/nginx/sites-available/portal
sudo ln -s /etc/nginx/sites-available/portal /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

Visit `http://your-domain/` — you should land on the login page.

## 8. HTTPS via Let's Encrypt

Point your domain's A record to the VPS IP first, then:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d portal.example.com
# Pick option 2 to redirect HTTP → HTTPS automatically.
```

Certbot edits the Nginx site for you and sets up auto-renewal.

## 9. Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'    # 80 + 443
sudo ufw enable
sudo ufw status
```

Port 6672 should NOT be open externally — only Nginx talks to it on 127.0.0.1.

## 10. Daily backups

```bash
sudo -iu portal
crontab -e
# Add this line:
30 2 * * * cd /var/www/portal && bash deploy/backup.sh >> logs/backup.log 2>&1
```

This dumps the SQLite DB + uploaded files to `backups/`, keeps the last 14 days, and is safe while the app is running (uses SQLite's online backup API).

For off-site backups: rsync the `backups/` dir to S3 / another VPS / your laptop.

---

## Updating to a new version

```bash
sudo -iu portal
cd /var/www/portal
bash update.sh
```

That's it. [update.sh](update.sh) does:
1. Refuses if you have uncommitted local changes (override with `--force`).
2. Backs up the DB and uploads (online backup — safe while app is running). Skip with `--skip-backup`.
3. `git pull --ff-only origin main`.
4. Runs `npm ci --omit=dev` ONLY if `package.json` / `package-lock.json` changed.
5. Zero-downtime reloads via `pm2 reload portal`, or restarts via `systemctl restart portal` if PM2 isn't installed.

Your `data/portal.db`, `.env`, `public/uploads/`, and `backups/` are never touched — they're in `.gitignore` so `git pull` can't disturb them either.

Schema migrations run on app startup and are idempotent (`ALTER TABLE … ADD COLUMN` only when the column doesn't already exist), so you don't run migrations manually.

If something goes wrong: the script prints a `git reset --hard <prev>` rollback line at the end of each successful run, and you have a fresh backup in `backups/`.

## Troubleshooting

**Can't log in / forgot owner password**

```bash
# As the portal user:
node -e "
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const db = new Database('./data/portal.db');
db.prepare(\"UPDATE users SET password_hash=? WHERE email='owner@portal.local'\").run(bcrypt.hashSync('newpass123', 10));
console.log('reset');
"
```

**Port 6672 already in use**

```bash
sudo ss -tlnp | grep 6672      # find the PID
sudo kill <PID>                # or systemctl stop the old service
```

**Logo / image uploads failing**

Make sure the `portal` user owns `public/uploads/`:

```bash
chown -R portal:portal public/uploads
```

**See live SQL queries**

`NODE_ENV=development` and watch `pm2 logs` — Express's morgan logs every request.

## Hardware sizing

A small 1-vCPU / 1 GB VPS is plenty for ~10 concurrent users. SQLite is the bottleneck only if you have heavy concurrent writes — for typical garment-manufacturing volumes (a few hundred orders / invoices a day) it's a non-issue.
