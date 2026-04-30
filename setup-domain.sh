#!/usr/bin/env bash
# Portal ERP — point a domain at this VPS and turn on HTTPS.
#
# Usage:
#   sudo bash setup-domain.sh portal.example.com
#   sudo bash setup-domain.sh portal.example.com you@example.com
#
# Or set via env vars:
#   sudo DOMAIN=portal.example.com EMAIL=you@example.com bash setup-domain.sh
#
# What it does:
#   1. Validates the domain points at this VPS (DNS A record sanity check).
#   2. Updates /etc/nginx/sites-available/portal with server_name = your domain.
#   3. Tests + reloads nginx.
#   4. Installs certbot (if missing) and gets a Let's Encrypt cert via the
#      nginx plugin (auto-edits the config to add 443 + HTTP→HTTPS redirect).
#   5. Verifies HTTPS works and prints the final URL.
#
# Re-running on an already-configured domain just re-runs certbot, which
# is a no-op when the cert is still valid (and renews if near expiry).

set -euo pipefail

DOMAIN="${1:-${DOMAIN:-}}"
EMAIL="${2:-${EMAIL:-}}"
NGINX_SITE="${NGINX_SITE:-/etc/nginx/sites-available/portal}"

# ── helpers ────────────────────────────────────────────────────────
say() { printf "\033[1;36m▸ %s\033[0m\n" "$*"; }
ok()  { printf "\033[1;32m✓ %s\033[0m\n" "$*"; }
warn(){ printf "\033[1;33m! %s\033[0m\n" "$*"; }
die() { printf "\033[1;31m✗ %s\033[0m\n" "$*" >&2; exit 1; }

[ "$EUID" -eq 0 ] || die "Must run as root (try: sudo bash $0 <domain>)"

# ── 1. collect inputs ─────────────────────────────────────────────
if [ -z "$DOMAIN" ]; then
  read -rp "Domain (e.g. portal.example.com): " DOMAIN
fi
[ -n "$DOMAIN" ] || die "No domain given"

# Basic shape check — nothing fancy, just catch obvious typos
if ! [[ "$DOMAIN" =~ ^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$ ]] || ! [[ "$DOMAIN" == *.* ]]; then
  die "'$DOMAIN' doesn't look like a valid domain (need letters, digits, dots, dashes)"
fi

if [ -z "$EMAIL" ]; then
  read -rp "Email for Let's Encrypt expiry alerts: " EMAIL
fi
[ -n "$EMAIL" ] || die "No email given (Let's Encrypt requires one)"

# ── 2. nginx prereqs ───────────────────────────────────────────────
command -v nginx >/dev/null || die "nginx is not installed. Run install.sh first."
[ -f "$NGINX_SITE" ] || die "Portal nginx site not found at $NGINX_SITE — run install.sh first"

# ── 3. DNS sanity check ───────────────────────────────────────────
say "Checking DNS for $DOMAIN…"
DNS_OK=0
DNS_IPS=$(getent ahosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u || true)
if [ -z "$DNS_IPS" ]; then
  warn "No DNS A/AAAA record found for $DOMAIN."
  warn "Add an A record pointing to this server's public IP, then re-run."
  read -rp "Continue anyway? Certbot will fail if DNS isn't resolvable. [y/N] " yn
  [ "${yn:-N}" = "y" ] || [ "${yn:-N}" = "Y" ] || exit 1
else
  PUBLIC_IP=$(curl -fsSL https://api.ipify.org 2>/dev/null || curl -fsSL https://ifconfig.me 2>/dev/null || true)
  if [ -n "$PUBLIC_IP" ]; then
    if echo "$DNS_IPS" | grep -qF "$PUBLIC_IP"; then
      ok "DNS $DOMAIN → $PUBLIC_IP (matches this VPS)"
      DNS_OK=1
    else
      warn "DNS resolves to: $(echo "$DNS_IPS" | tr '\n' ' ')"
      warn "This VPS is at:  $PUBLIC_IP"
      warn "Mismatch — certbot's HTTP-01 challenge will probably fail."
      read -rp "Continue anyway? [y/N] " yn
      [ "${yn:-N}" = "y" ] || [ "${yn:-N}" = "Y" ] || exit 1
    fi
  else
    warn "Couldn't determine this VPS's public IP — proceeding without verification"
  fi
fi

# ── 4. update nginx server_name ───────────────────────────────────
say "Updating nginx server_name to $DOMAIN…"
# Replace the placeholder OR an existing server_name line. We only touch
# server_name lines that are NOT inside a comment or already correct.
if grep -q "server_name $DOMAIN;" "$NGINX_SITE"; then
  ok "nginx already configured for $DOMAIN"
else
  # Backup once
  cp -f "$NGINX_SITE" "$NGINX_SITE.bak.$(date +%s)"
  # Update both the listen-80 block and (if it exists) the listen-443 block
  sed -i -E "s/server_name[[:space:]]+[^;]+;/server_name $DOMAIN;/g" "$NGINX_SITE"
  ok "server_name set to $DOMAIN (backup at $NGINX_SITE.bak.*)"
fi

say "Testing nginx config…"
nginx -t || die "nginx config test failed — check $NGINX_SITE"
systemctl reload nginx
ok "nginx reloaded"

# ── 5. certbot ────────────────────────────────────────────────────
if ! command -v certbot >/dev/null; then
  say "Installing certbot…"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq certbot python3-certbot-nginx
fi

# Already have a cert that covers this domain?
if [ -d "/etc/letsencrypt/live/$DOMAIN" ]; then
  say "Cert already exists for $DOMAIN — running renew check…"
  certbot renew --quiet --no-random-sleep-on-renew
  ok "Cert is up-to-date"
else
  say "Requesting Let's Encrypt cert for $DOMAIN…"
  # --redirect: auto-add HTTP→HTTPS rewrite block
  # --non-interactive --agree-tos --email: skip prompts (we already have everything)
  certbot --nginx \
    -d "$DOMAIN" \
    --non-interactive --agree-tos \
    --email "$EMAIL" \
    --redirect
  ok "HTTPS active for https://$DOMAIN"
fi

# ── 6. open the firewall (if ufw is in charge) ────────────────────
if command -v ufw >/dev/null && ufw status | grep -q active; then
  if ! ufw status | grep -q "Nginx Full"; then
    say "Opening Nginx Full in ufw…"
    ufw allow 'Nginx Full' >/dev/null
  fi
fi

# ── 7. final live check ───────────────────────────────────────────
say "Verifying https://$DOMAIN responds…"
HTTP_CODE=$(curl -fsSL -o /dev/null -w '%{http_code}' --max-time 10 "https://$DOMAIN/login" 2>/dev/null || true)
if [ "$HTTP_CODE" = "200" ]; then
  ok "https://$DOMAIN/login → 200"
else
  warn "https://$DOMAIN responded with $HTTP_CODE — give DNS a few minutes and try in a browser"
fi

# ── done ───────────────────────────────────────────────────────────
echo
ok "Domain setup complete."
echo
echo "  → Public URL:  https://$DOMAIN"
echo "  → Auto-renew:  systemd timer 'certbot.timer' runs twice daily"
echo "  → Test renew:  sudo certbot renew --dry-run"
echo "  → Logs:        /var/log/letsencrypt/letsencrypt.log"
echo
[ "$DNS_OK" -eq 0 ] && warn "DNS verification was skipped — confirm in your browser that the site loads."
