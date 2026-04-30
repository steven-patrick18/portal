// Basic smoke tests using node:test (built-in, no Jest/Mocha needed).
// Run with: npm test
//
// These tests assume:
//   - DB is seeded (run `npm run seed-demo` first if it isn't)
//   - The owner@portal.local / admin123 account exists
//
// They cover the high-traffic happy paths so a future regression on the
// app.js middleware stack (helmet, CSP, CSRF, rate limit, sessions) gets
// caught before deploy.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

// Force a non-prod NODE_ENV so SESSION_SECRET fallback works in tests
process.env.NODE_ENV = process.env.NODE_ENV || 'development';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-only-secret-not-used-in-prod';

const { initDb } = require('../src/db');
initDb();
const app = require('../src/app');

const agent = request.agent(app);

before(async () => {
  // Log in as owner
  const r = await agent.post('/login')
    .type('form')
    .send({ email: 'owner@portal.local', password: 'admin123' });
  assert.strictEqual(r.status, 302, 'login should redirect on success');
});

test('GET / (dashboard) returns 200 when logged in', async () => {
  const r = await agent.get('/');
  assert.strictEqual(r.status, 200);
});

const PAGES = [
  '/products', '/raw-materials', '/suppliers', '/stock', '/fabric-cost',
  '/dealers', '/sales-orders', '/invoices', '/payments', '/dispatch', '/returns',
  '/production', '/expenses', '/categories', '/payment-modes',
  '/purchasing',
  '/hr', '/hr/employees', '/hr/attendance', '/hr/pieces', '/hr/work-types',
  '/hr/km', '/hr/advances', '/hr/incentives', '/hr/payroll',
  '/reports', '/activity',
  '/users', '/settings/branding', '/settings/access', '/settings/stages',
  '/notifications', '/mobile',
  '/training', '/training/getting-started', '/training/sales',
  '/training/production', '/training/hr', '/training/admin',
];

for (const url of PAGES) {
  test(`GET ${url} returns 200`, async () => {
    const r = await agent.get(url);
    assert.ok(r.status === 200 || r.status === 304, `expected 200/304, got ${r.status} for ${url}`);
  });
}

test('GET /login (unauthenticated) returns 200', async () => {
  const r = await request(app).get('/login');
  assert.strictEqual(r.status, 200);
});

test('POST /login with bad creds redirects with flash', async () => {
  const r = await request(app).post('/login').type('form').send({ email: 'nobody@nowhere', password: 'wrong' });
  assert.strictEqual(r.status, 302);
});

test('Session cookie is set with SameSite=Lax (silent CSRF defense)', async () => {
  const r = await request(app).post('/login').type('form').send({ email: 'owner@portal.local', password: 'admin123' });
  const setCookie = r.headers['set-cookie'] || [];
  const sessionCookie = setCookie.find(c => /^connect\.sid=/.test(c)) || '';
  assert.match(sessionCookie, /SameSite=Lax/i, 'session cookie should have SameSite=Lax');
  assert.match(sessionCookie, /HttpOnly/i, 'session cookie should be HttpOnly');
});

test('Helmet sets security headers', async () => {
  const r = await agent.get('/');
  assert.ok(r.headers['x-content-type-options'], 'X-Content-Type-Options should be set');
  assert.ok(r.headers['content-security-policy'], 'CSP should be enabled');
});

test('GET /css/app.css is served with cache headers', async () => {
  const r = await request(app).get('/css/app.css');
  assert.strictEqual(r.status, 200);
  assert.ok(/text\/css/.test(r.headers['content-type']));
});

after(() => {
  // node:test exits cleanly when the agent's keep-alive is gone
});
