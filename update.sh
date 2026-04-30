#!/usr/bin/env bash
# Portal ERP — safe in-place update.
#
# What it does:
#   1. Backs up the SQLite DB + uploads (online backup, safe while running).
#   2. Refuses to proceed if you have uncommitted local changes (avoids
#      accidentally clobbering hand-edits).
#   3. git pull --ff-only origin main.
#   4. npm ci --omit=dev IF package.json or package-lock.json changed.
#   5. Reloads the app (PM2 zero-downtime, or systemd restart).
#
# What it does NOT touch:
#   • data/portal.db        ← your live database
#   • .env                  ← your secrets
#   • public/uploads/       ← uploaded logos, product images
#   • backups/              ← past backups
#
# Schema migrations run on app startup and are idempotent (ALTER TABLE only
# if the column doesn't already exist).
#
# Run as the unprivileged user that owns the install:
#   sudo -iu portal
#   cd /var/www/portal
#   bash update.sh
#
# Optional flags:
#   --skip-backup        skip the pre-update backup (NOT recommended)
#   --force              proceed even with uncommitted changes (DANGEROUS)

set -euo pipefail

SKIP_BACKUP=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --skip-backup) SKIP_BACKUP=1 ;;
    --force)       FORCE=1 ;;
    -h|--help)
      sed -n '2,/^$/p' "$0" | sed 's/^# \?//' | head -50
      exit 0
      ;;
    *) printf "unknown flag: %s\n" "$arg" >&2; exit 2 ;;
  esac
done

# ── helpers ────────────────────────────────────────────────────────
say() { printf "\033[1;36m▸ %s\033[0m\n" "$*"; }
ok()  { printf "\033[1;32m✓ %s\033[0m\n" "$*"; }
warn(){ printf "\033[1;33m! %s\033[0m\n" "$*"; }
die() { printf "\033[1;31m✗ %s\033[0m\n" "$*" >&2; exit 1; }

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$APP_DIR"

[ -f server.js ]  || die "Run this from the Portal install directory (no server.js found in $APP_DIR)"
[ -d .git ]       || die "Not a git repo — can't update via git pull"

# Refuse to clobber the user's hand-edits unless --force.
if [ "$FORCE" -ne 1 ] && ! git diff --quiet HEAD --; then
  warn "You have uncommitted local changes:"
  git status --short
  die "Commit or stash them first, OR re-run with --force (changes WILL be merged with the pull and may conflict)."
fi

# Note: data/, .env, uploads/, backups/, logs/ are all in .gitignore — they
# are never touched by git pull regardless of what's in those directories.

# ── 1. backup ──────────────────────────────────────────────────────
if [ "$SKIP_BACKUP" -ne 1 ]; then
  if [ -x deploy/backup.sh ]; then
    say "Backing up DB + uploads…"
    bash deploy/backup.sh
  else
    warn "deploy/backup.sh not found or not executable — skipping backup"
    [ "$FORCE" -eq 1 ] || die "Refusing to proceed without a backup. Use --skip-backup to override."
  fi
else
  warn "Skipping backup (--skip-backup)"
fi

# ── 2. capture current commit + lockfile hash before pull ─────────
PREV_COMMIT=$(git rev-parse HEAD)
LOCK_HASH_BEFORE=$( [ -f package-lock.json ] && sha1sum package-lock.json | awk '{print $1}' || echo "")
PKG_HASH_BEFORE=$(  [ -f package.json ]      && sha1sum package.json      | awk '{print $1}' || echo "")

# ── 3. git pull ────────────────────────────────────────────────────
say "Pulling latest from origin/main…"
git fetch --quiet origin main
if [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ]; then
  ok "Already at the latest commit ($(git rev-parse --short HEAD)) — nothing to do."
  exit 0
fi
git pull --ff-only --quiet origin main
NEW_COMMIT=$(git rev-parse HEAD)
ok "Updated $PREV_COMMIT → $NEW_COMMIT"

# ── 4. npm ci IF dependencies changed ─────────────────────────────
LOCK_HASH_AFTER=$( [ -f package-lock.json ] && sha1sum package-lock.json | awk '{print $1}' || echo "")
PKG_HASH_AFTER=$(  [ -f package.json ]      && sha1sum package.json      | awk '{print $1}' || echo "")
if [ "$LOCK_HASH_BEFORE" != "$LOCK_HASH_AFTER" ] || [ "$PKG_HASH_BEFORE" != "$PKG_HASH_AFTER" ]; then
  say "Dependencies changed — running npm ci --omit=dev…"
  npm ci --omit=dev --silent
  ok "Dependencies installed"
else
  ok "No dependency changes — skipping npm install"
fi

# ── 5. reload the app ─────────────────────────────────────────────
RELOADED=0
if command -v pm2 >/dev/null && pm2 jlist 2>/dev/null | grep -q '"name":"portal"'; then
  say "Reloading PM2 (zero-downtime)…"
  pm2 reload portal >/dev/null
  ok "PM2 reloaded"
  RELOADED=1
fi
if [ "$RELOADED" -eq 0 ] && systemctl list-unit-files 2>/dev/null | grep -q '^portal\.service'; then
  say "Restarting systemd portal.service…"
  if [ "$EUID" -ne 0 ]; then
    if sudo -n true 2>/dev/null; then sudo systemctl restart portal
    else warn "Run 'sudo systemctl restart portal' to apply the update (no passwordless sudo)"; fi
  else
    systemctl restart portal
  fi
  RELOADED=1
fi
[ "$RELOADED" -eq 0 ] && warn "Couldn't auto-reload — restart the app yourself (pm2 reload portal OR systemctl restart portal)"

# ── done ───────────────────────────────────────────────────────────
echo
ok "Update complete: $(git log --oneline -1)"
echo
echo "  → Live at:  http://127.0.0.1:6672 (or your nginx domain)"
echo "  → Logs:     pm2 logs portal   OR   journalctl -u portal -f"
echo "  → Rollback: git reset --hard $PREV_COMMIT && pm2 reload portal"
echo
