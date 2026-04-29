// Suppress experimental warning for node:sqlite
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /SQLite/i.test(w.message)) return;
  console.warn(w.stack || w.message);
});

require('dotenv').config();
const app = require('./src/app');
const { initDb } = require('./src/db');

const PORT = process.env.PORT || 6672;

initDb();

app.listen(PORT, () => {
  console.log(`Portal ERP running at http://localhost:${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
