import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/app.js';
import { MemoryStore } from '../src/store.js';
import { allowedOrigins, proxyHops, validateRuntimeConfig } from '../src/security.js';

async function withApi(run, config = {}, store = new MemoryStore()) {
  const { app } = createApp({ store, config: { DEMO_MODE: 'true', WEB_ORIGIN: 'http://localhost:5173', ...config } });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test('production configuration fails closed without secure identity and URL settings', () => {
  const valid = { NODE_ENV: 'production', DEMO_MODE: 'false', MONGODB_URI: 'mongodb://replica.example:27017',
    APPWRITE_ENDPOINT: 'https://auth.example/v1', APPWRITE_PROJECT_ID: 'salon', ADMIN_USER_IDS: 'trusted-admin',
    WEB_ORIGIN: 'https://salon.example', PUBLIC_WEB_URL: 'https://salon.example' };
  assert.deepEqual(validateRuntimeConfig(valid), ['https://salon.example']);
  for (const setting of ['MONGODB_URI', 'APPWRITE_ENDPOINT', 'APPWRITE_PROJECT_ID', 'ADMIN_USER_IDS', 'PUBLIC_WEB_URL']) {
    assert.throws(() => validateRuntimeConfig({ ...valid, [setting]: '' }), /Production/);
  }
  assert.throws(() => validateRuntimeConfig({ ...valid, DEMO_MODE: 'true' }), /Production/);
  assert.throws(() => validateRuntimeConfig({ ...valid, WEB_ORIGIN: '*' }), /WEB_ORIGIN/);
  assert.throws(() => validateRuntimeConfig({ ...valid, WEB_ORIGIN: 'http://salon.example' }), /HTTPS/);
  assert.throws(() => validateRuntimeConfig({ ...valid, PUBLIC_WEB_URL: 'http://salon.example' }), /HTTPS/);
  assert.throws(() => validateRuntimeConfig({ ...valid, STRIPE_SECRET_KEY: 'sk_test_example' }), /Stripe secret/);
  assert.throws(() => validateRuntimeConfig({ ...valid, STRIPE_SECRET_KEY: 'not-a-key', STRIPE_WEBHOOK_SECRET: 'whsec_example' }), /STRIPE_SECRET_KEY/);
  assert.deepEqual(allowedOrigins({ WEB_ORIGIN: ' https://a.example,https://b.example,https://a.example ' }), ['https://a.example', 'https://b.example']);
  assert.throws(() => allowedOrigins({ WEB_ORIGIN: 'https://a.example/path' }), /WEB_ORIGIN/);
  assert.equal(proxyHops({ TRUST_PROXY_HOPS: '1' }), 1);
  assert.throws(() => proxyHops({ TRUST_PROXY_HOPS: '20' }), /TRUST_PROXY_HOPS/);
});

test('readiness depends on backing store and reveals no sensitive exception', async () => {
  const store = new MemoryStore();
  await withApi(async (url) => {
    const response = await fetch(`${url}/api/ready`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('x-request-id'), /^[\da-f-]{36}$/);
    store.ping = async () => { throw new Error('Do not expose private MongoDB URI'); };
    const failed = await fetch(`${url}/api/ready`);
    assert.equal(failed.status, 503);
    assert.deepEqual(await failed.json(), { ok: false });
  }, {}, store);
});

test('per-customer chat throttling returns HTTP 429 and Retry-After without storing extra messages', async () => {
  const store = new MemoryStore();
  await withApi(async (url) => {
    const post = () => fetch(`${url}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: 'demo-customer', text: 'Hello salon' }) });
    assert.equal((await post()).status, 201);
    assert.equal((await post()).status, 201);
    const rejected = await post();
    assert.equal(rejected.status, 429);
    assert.ok(Number(rejected.headers.get('retry-after')) >= 1);
    assert.equal(rejected.headers.get('ratelimit-remaining'), '0');
    assert.equal((await store.listMessages('demo-customer')).length, 2);
  }, { CHAT_RATE_LIMIT_MAX: '2' }, store);
});

test('public API rate budget protects read endpoints but does not block health checks', async () => withApi(async (url) => {
  assert.equal((await fetch(`${url}/api/products`, { headers: { 'x-forwarded-for': '203.0.113.2' } })).status, 200);
  assert.equal((await fetch(`${url}/api/services`, { headers: { 'x-forwarded-for': '198.51.100.7' } })).status, 200);
  assert.equal((await fetch(`${url}/api/staff`)).status, 429);
  assert.equal((await fetch(`${url}/api/health`)).status, 200);
  assert.equal((await fetch(`${url}/api/ready`)).status, 200);
}, { PUBLIC_RATE_LIMIT_MAX: '2' }));

test('CORS allows only configured sites and omits credentials wildcard', async () => withApi(async (url) => {
  const allowed = await fetch(`${url}/api/products`, { headers: { Origin: 'https://one.example' } });
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://one.example');
  const denied = await fetch(`${url}/api/products`, { headers: { Origin: 'https://bad.example' } });
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
}, { WEB_ORIGIN: 'https://one.example,https://two.example' }));

test('booking write throttling prevents a second reservation without modifying calendar state', async () => {
  const store = new MemoryStore();
  await withApi(async (url) => {
    let startAt;
    for (let day = 2; day < 20 && !startAt; day++) {
      const date = new Date(Date.now() + day * 86_400_000).toISOString().slice(0, 10);
      const response = await fetch(`${url}/api/availability?serviceId=manicure&staffId=sofia&date=${date}`);
      startAt = (await response.json()).slots?.[0]?.startAt;
    }
    assert.ok(startAt);
    const makeBooking = () => fetch(`${url}/api/appointments`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ serviceId: 'manicure', staffId: 'sofia', startAt, customerName: 'Test Client', customerEmail: 'client@example.com' }) });
    assert.equal((await makeBooking()).status, 201);
    assert.equal((await makeBooking()).status, 429);
    assert.equal((await store.listAppointments()).length, 1);
  }, { BOOKING_RATE_LIMIT_MAX: '1' }, store);
});

test('oversized Stripe webhook payload is rejected before attempting signature validation', async () => withApi(async (url) => {
  const response = await fetch(`${url}/api/stripe/webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(257 * 1024) });
  assert.equal(response.status, 413);
  assert.match((await response.json()).error, /too large/i);
}));
