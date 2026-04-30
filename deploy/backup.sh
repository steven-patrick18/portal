#!/usr/bin/env bash
# Backup the Portal ERP SQLite database + the uploads directory.
#
# Usage:
#   bash deploy/backup.sh                          # writes to ./backups/
#   BACKUP_DIR=/mnt/backups bash deploy/backup.sh  # writes to /mnt/backups
#
# Crontab entry (runs daily at 02:30, keeps last 14 days):
#   30 2 * * * cd /var/www/portal && bash deploy/backup.sh >> logs/backup.log 2>&1
#
# Requires: sqlite3 CLI (apt install sqlite3)

set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
DB_FILE="${DB_PATH:-$APP_DIR/data/portal.db}"
KEEP_DAYS="${KEEP_DAYS:-14}"

mkdir -p "$BACKUP_DIR"
TS=$(date +%Y%m%d-%H%M%S)
OUT="$BACKUP_DIR/portal-$TS.db"

# .backup is safe to run while the app is live (uses SQLite's online backup API).
sqlite3 "$DB_FILE" ".backup '$OUT'"
gzip -f "$OUT"

# Tar up uploaded logos / product images alongside the DB
if [ -d "$APP_DIR/public/uploads" ]; then
  tar -czf "$BACKUP_DIR/uploads-$TS.tar.gz" -C "$APP_DIR/public" uploads
fi

# Prune old backups
find "$BACKUP_DIR" -name 'portal-*.db.gz'   -mtime +"$KEEP_DAYS" -delete 2>/dev/null || true
find "$BACKUP_DIR" -name 'uploads-*.tar.gz' -mtime +"$KEEP_DAYS" -delete 2>/dev/null || true

echo "$(date -Iseconds) backup ok -> $OUT.gz"
