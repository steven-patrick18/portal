// PM2 process manager config — run with `pm2 start ecosystem.config.js`
//
// Usage on the VPS:
//   pm2 start ecosystem.config.js
//   pm2 save
//   pm2 startup       # follow the printed instructions to enable boot-time start
//
// Other useful commands:
//   pm2 logs portal           tail logs
//   pm2 reload portal         zero-downtime reload after pulling new code
//   pm2 monit                 live dashboard
module.exports = {
  apps: [
    {
      name: 'portal',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',         // SQLite is single-writer; do NOT use cluster mode
      autorestart: true,
      watch: false,              // production: don't restart on file changes
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        PORT: 6672,
      },
      error_file: './logs/portal-err.log',
      out_file:   './logs/portal-out.log',
      time: true,
    },
  ],
};
