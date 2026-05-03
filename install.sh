#!/usr/bin/env bash
# Portal ERP — one-shot VPS install for Ubuntu 22.04 / Debian 12.
#
# Usage (run as root or with sudo):
#   curl -fsSL https://raw.githubusercontent.com/steven-patrick18/portal/main/install.sh | sudo bash
# Or, if you've already cloned:
#   sudo bash install.sh
#
# Optional env-var overrides (set before running):
#   APP_DIR=/var/www/portal      # where to install
#   APP_USER=portal              # unprivileged user that runs the app
#   REPO_URL=https://github.com/steven-patrick18/portal.git
#   SKIP_NGINX=1                 # don't install/configure nginx
#   SKIP_PM2=1                   # don't install pm2 (use systemd instead)
#
# Idempotent: re-running on the same machine is safe — it skips steps that
# are already done and never overwrites your .env or DB.

set -euo pipefail

APP_DIR="${APP_DIR:-/var/www/portal}"
APP_USER="${APP_USER:-portal}"
REPO_URL="${REPO_URL:-https://github.com/steven-patrick18/portal.git}"
SKIP_NGINX="${SKIP_NGINX:-0}"
SKIP_PM2="${SKIP_PM2:-0}"

# ── helpers ────────────────────────────────────────────────────────
say() { printf "\033[1;36m▸ %s\033[0m\n" "$*"; }
ok()  { printf "\033[1;32m✓ %s\033[0m\n" "$*"; }
warn(){ printf "\033[1;33m! %s\033[0m\n" "$*"; }
die() { printf "\033[1;31m✗ %s\033[0m\n" "$*" >&2; exit 1; }

[ "$EUID" -eq 0 ] || die "Must run as root (try: sudo bash $0)"

# ── 1. system packages ────────────────────────────────────────────
say "Installing system packages…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates git build-essential python3 sqlite3 ufw

if ! command -v node >/dev/null || [ "$(node -v | cut -dv -f2 | cut -d. -f1)" -lt 18 ]; then
  say "Installing Node.js 20…"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi
ok "node $(node -v) · npm $(npm -v)"

if [ "$SKIP_NGINX" != "1" ] && ! command -v nginx >/dev/null; then
  say "Installing nginx…"
  apt-get install -y -qq nginx
fi

# ── 2. unprivileged user ──────────────────────────────────────────
if ! id "$APP_USER" >/dev/null 2>&1; then
  say "Creating user '$APP_USER'…"
  adduser --disabled-password --gecos "" --home "/home/$APP_USER" "$APP_USER"
fi
ok "user '$APP_USER' ready"

# ── 3. clone or fast-forward the repo ─────────────────────────────
# /var/www is root-owned by default on Ubuntu, so a `sudo -u portal git clone`
# straight into it fails with EACCES. Pre-create the install dir as the app
# user so the clone has somewhere it owns to write into.
PARENT_DIR="$(dirname "$APP_DIR")"
mkdir -p "$PARENT_DIR"
if [ ! -d "$APP_DIR" ]; then
  install -d -o "$APP_USER" -g "$APP_USER" "$APP_DIR"
fi
if [ -d "$APP_DIR/.git" ]; then
  say "Repo already exists at $APP_DIR — fetching latest main…"
  sudo -u "$APP_USER" git -C "$APP_DIR" fetch --quiet origin main
  sudo -u "$APP_USER" git -C "$APP_DIR" checkout --quiet main
  sudo -u "$APP_USER" git -C "$APP_DIR" pull --ff-only --quiet origin main
else
  say "Cloning $REPO_URL into $APP_DIR…"
  # `git clone <url> <dir>` requires the dir to be empty and writable.
  # The install -d above set the owner; clone happens as the app user.
  sudo -u "$APP_USER" git clone --quiet "$REPO_URL" "$APP_DIR"
fi
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"
ok "repo at $APP_DIR (commit $(sudo -u "$APP_USER" git -C "$APP_DIR" rev-parse --short HEAD))"

# ── 4. directories the app writes to ──────────────────────────────
say "Ensuring writable dirs (data, logs, uploads, backups)…"
sudo -u "$APP_USER" mkdir -p \
  "$APP_DIR/data" \
  "$APP_DIR/logs" \
  "$APP_DIR/public/uploads/products" \
  "$APP_DIR/public/uploads/branding" \
  "$APP_DIR/backups"

# ── 5. .env (only create if missing — never overwrite) ────────────
if [ ! -f "$APP_DIR/.env" ]; then
  say "Creating .env from .env.example with a fresh SESSION_SECRET…"
  SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('base64'))")
  sudo -u "$APP_USER" cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  sudo -u "$APP_USER" sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=$SECRET|" "$APP_DIR/.env"
  sudo -u "$APP_USER" sed -i "s|^NODE_ENV=.*|NODE_ENV=production|" "$APP_DIR/.env"
  ok ".env created (edit COMPANY_* values when ready: nano $APP_DIR/.env)"
else
  ok ".env already exists — leaving it alone"
fi

# ── 6. npm install ────────────────────────────────────────────────
say "Installing dependencies (npm ci --omit=dev)…"
sudo -u "$APP_USER" bash -c "cd '$APP_DIR' && npm ci --omit=dev --silent"

# ── 7. initialize DB on first run ─────────────────────────────────
if [ ! -f "$APP_DIR/data/portal.db" ]; then
  say "First-time DB init (running app briefly to apply schema)…"
  sudo -u "$APP_USER" bash -c "cd '$APP_DIR' && timeout 6s node server.js >/dev/null 2>&1 || true"
fi
[ -f "$APP_DIR/data/portal.db" ] && ok "DB at $APP_DIR/data/portal.db" || warn "DB not created — try 'sudo -iu $APP_USER && cd $APP_DIR && npm start' manually"

# ── 8. process manager: PM2 (default) or systemd ──────────────────
if [ "$SKIP_PM2" = "1" ]; then
  say "Installing systemd unit…"
  cp "$APP_DIR/deploy/systemd.service.example" /etc/systemd/system/portal.service
  sed -i "s|^User=.*|User=$APP_USER|"               /etc/systemd/system/portal.service
  sed -i "s|^WorkingDirectory=.*|WorkingDirectory=$APP_DIR|" /etc/systemd/system/portal.service
  sed -i "s|^EnvironmentFile=.*|EnvironmentFile=$APP_DIR/.env|" /etc/systemd/system/portal.service
  sed -i "s|^ReadWritePaths=.*|ReadWritePaths=$APP_DIR/data $APP_DIR/public/uploads $APP_DIR/logs $APP_DIR/backups|" /etc/systemd/system/portal.service
  systemctl daemon-reload
  systemctl enable --now portal
  ok "systemd service 'portal' enabled (logs: journalctl -u portal -f)"
else
  if ! command -v pm2 >/dev/null; then
    say "Installing PM2…"
    npm install -g pm2 --silent
  fi
  if ! sudo -u "$APP_USER" pm2 jlist 2>/dev/null | grep -q '"name":"portal"'; then
    say "Starting Portal under PM2…"
    sudo -u "$APP_USER" bash -c "cd '$APP_DIR' && pm2 start ecosystem.config.js"
    sudo -u "$APP_USER" pm2 save >/dev/null
    # Generate the boot-time hook (creates a systemd unit that runs PM2 as $APP_USER)
    pm2 startup systemd -u "$APP_USER" --hp "/home/$APP_USER" >/dev/null
  else
    sudo -u "$APP_USER" pm2 reload portal >/dev/null
  fi
  ok "PM2 managing 'portal' (logs: sudo -u $APP_USER pm2 logs portal)"
fi

# ── 9. Nginx site (optional) ──────────────────────────────────────
if [ "$SKIP_NGINX" != "1" ] && [ ! -f /etc/nginx/sites-available/portal ]; then
  say "Installing nginx site (edit server_name once your domain is ready)…"
  cp "$APP_DIR/deploy/nginx.conf.example" /etc/nginx/sites-available/portal
  ln -sf /etc/nginx/sites-available/portal /etc/nginx/sites-enabled/portal
  rm -f /etc/nginx/sites-enabled/default
  if nginx -t >/dev/null 2>&1; then
    systemctl reload nginx
    ok "nginx serving on :80 (proxying to 127.0.0.1:6672)"
    warn "Edit /etc/nginx/sites-available/portal to set your real server_name, then: nginx -t && systemctl reload nginx"
    warn "For HTTPS: apt install -y certbot python3-certbot-nginx && certbot --nginx -d your-domain.com"
  else
    warn "nginx config test failed — check 'nginx -t' output"
  fi
fi

# ── 10. firewall (only if ufw is the active firewall) ────────────
if command -v ufw >/dev/null && ufw status | grep -q inactive; then
  say "Configuring ufw (allow SSH + Nginx)…"
  ufw allow OpenSSH >/dev/null
  ufw allow 'Nginx Full' >/dev/null
  ufw --force enable >/dev/null
  ok "ufw enabled"
fi

# ── 11. daily backup cron ─────────────────────────────────────────
CRONLINE="30 2 * * * cd $APP_DIR && bash deploy/backup.sh >> logs/backup.log 2>&1"
if ! sudo -u "$APP_USER" crontab -l 2>/dev/null | grep -qF "$APP_DIR/deploy/backup.sh"; then
  say "Adding daily 02:30 backup cron for '$APP_USER'…"
  ( sudo -u "$APP_USER" crontab -l 2>/dev/null; echo "$CRONLINE" ) | sudo -u "$APP_USER" crontab -
  ok "cron installed (manual run: sudo -u $APP_USER bash $APP_DIR/deploy/backup.sh)"
fi

chmod +x "$APP_DIR/deploy/backup.sh" 2>/dev/null || true
chmod +x "$APP_DIR/install.sh" "$APP_DIR/update.sh" "$APP_DIR/setup-domain.sh" 2>/dev/null || true

# ── 12. domain + HTTPS (if DOMAIN env var was passed) ─────────────
if [ -n "${DOMAIN:-}" ] && [ "$SKIP_NGINX" != "1" ]; then
  say "DOMAIN=$DOMAIN was set — chaining into setup-domain.sh…"
  if [ -z "${EMAIL:-}" ]; then
    warn "EMAIL not set — Let's Encrypt registration needs one. Skipping HTTPS."
    warn "Run later: sudo bash $APP_DIR/setup-domain.sh $DOMAIN you@example.com"
  else
    DOMAIN="$DOMAIN" EMAIL="$EMAIL" bash "$APP_DIR/setup-domain.sh" || warn "setup-domain.sh failed — run it manually after fixing DNS"
  fi
fi

# ── done ───────────────────────────────────────────────────────────
echo
ok "Install complete."
echo
echo "  → App URL (local):  http://127.0.0.1:6672"
if [ "$SKIP_NGINX" != "1" ]; then
  if [ -n "${DOMAIN:-}" ]; then
    echo "  → Public URL:       https://$DOMAIN  (if certbot succeeded)"
  else
    echo "  → Public via nginx: http://your-domain/"
    echo "  → Add HTTPS:        sudo bash $APP_DIR/setup-domain.sh your-domain.com you@email.com"
  fi
fi
echo "  → Default login:    owner@portal.local / admin123  (change immediately)"
echo "  → Edit settings:    nano $APP_DIR/.env"
echo "  → Update later:     sudo -iu $APP_USER && cd $APP_DIR && bash update.sh"
echo
