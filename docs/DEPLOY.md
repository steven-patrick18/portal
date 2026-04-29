# Ubuntu VPS Deployment

Tested on Ubuntu 22.04 / 24.04. Assumes a non-root `deploy` user with sudo.

## 1. Install dependencies

```bash
sudo apt update && sudo apt -y upgrade
sudo apt -y install curl git build-essential nginx ufw
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt -y install nodejs
sudo npm i -g pm2
```

## 2. Clone repo

```bash
sudo mkdir -p /var/www && sudo chown $USER /var/www
cd /var/www
git clone https://github.com/steven-patrick18/portal.git
cd portal
npm ci --omit=dev
cp .env.example .env
nano .env       # set SESSION_SECRET (32+ random chars), COMPANY_*, MSG91_*
mkdir -p data
```

Generate a strong session secret:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## 3. First run + start with pm2

```bash
node server.js   # ctrl+c after you see "Portal ERP running at http://localhost:6672"
pm2 start server.js --name portal
pm2 save
pm2 startup systemd  # follow the printed sudo command
```

## 4. nginx reverse proxy

`/etc/nginx/sites-available/portal`:

```nginx
server {
  listen 80;
  server_name your-domain.com;

  client_max_body_size 20M;

  location / {
    proxy_pass http://127.0.0.1:6672;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_cache_bypass $http_upgrade;
  }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/portal /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

## 5. HTTPS with Let's Encrypt

```bash
sudo apt -y install certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

## 6. Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

## 7. Backups (daily SQLite snapshot)

`/etc/cron.daily/portal-backup`:

```bash
#!/bin/bash
DEST=/var/backups/portal
mkdir -p $DEST
sqlite3 /var/www/portal/data/portal.db ".backup '$DEST/portal-$(date +%F).db'"
find $DEST -type f -name '*.db' -mtime +30 -delete
```

```bash
sudo chmod +x /etc/cron.daily/portal-backup
```

## 8. Updates

```bash
cd /var/www/portal
git pull
npm ci --omit=dev
pm2 restart portal
```

## Troubleshooting

- **Port already in use**: `sudo lsof -i :6672` then `pm2 delete portal && pm2 start server.js --name portal`.
- **SQLite locked**: shouldn't happen with WAL mode (default), but if you see it, restart pm2.
- **502 from nginx**: `pm2 logs portal` to see app errors.
- **DB schema changes**: restart the app, `initDb()` re-runs schema with `CREATE TABLE IF NOT EXISTS` — for breaking changes you must migrate manually.
