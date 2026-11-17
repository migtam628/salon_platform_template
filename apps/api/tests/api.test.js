import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/app.js';
import { MemoryStore } from '../src/store.js';

async function withServer(fn) {
  const { app } = createApp({ store: new MemoryStore(), config: { DEMO_MODE: 'true', WEB_ORIGIN: 'http://localhost:5173' } });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((resolve) => server.close(resolve)); }
}

test('health and seed products respond', async () => withServer(async (url) => {
  const health = await (await fetch(`${url}/api/health`)).json();
  const products = await (await fetch(`${url}/api/products`)).json();
  assert.equal(health.demo, true);
  assert.equal(products.length, 3);
}));

test('appointment enforces uniqueness and validation', async () => withServer(async (url) => {
  const startAt = new Date(Date.now() + 86400000).toISOString();
  const body = { serviceId: 'manicure', staffId: 'sofia', startAt, customerName: 'Test Customer', customerEmail: 'test@example.com' };
  const request = () => fetch(`${url}/api/appointments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await request()).status, 201);
  assert.equal((await request()).status, 409);
  assert.equal((await fetch(`${url}/api/appointments`)).status, 200);
}));

test('checkout never falls back to fake payments without Stripe keys', async () => withServer(async (url) => {
  const response = await fetch(`${url}/api/checkout`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items: [{ productId: 'shampoo', quantity: 1 }] }) });
  assert.equal(response.status, 503);
}));

test('customer conversations stay private and admins can reply', async () => withServer(async (url) => {
  const message = { conversationId: 'demo-customer', text: 'Hello from the salon test' };
  const sent = await fetch(`${url}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(message) });
  assert.equal(sent.status, 201);
  const privateChat = await fetch(`${url}/api/chat/another-customer`);
  assert.equal(privateChat.status, 403);
  const noAdmin = await fetch(`${url}/api/admin/conversations`);
  assert.equal(noAdmin.status, 403);
  const adminHeaders = { 'x-demo-role': 'admin' };
  const conversations = await (await fetch(`${url}/api/admin/conversations`, { headers: adminHeaders })).json();
  assert.equal(conversations.length, 1);
  const reply = await fetch(`${url}/api/chat`, { method: 'POST', headers: { ...adminHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ ...message, text: 'Thanks for writing!' }) });
  assert.equal(reply.status, 201);
  const thread = await (await fetch(`${url}/api/chat/demo-customer`)).json();
  assert.deepEqual(thread.map((m) => m.senderRole), ['customer', 'admin']);
}));

test('admin can change appointment state and customer cannot', async () => withServer(async (url) => {
  const body = { serviceId: 'manicure', staffId: 'sofia', startAt: new Date(Date.now() + 86400000).toISOString(), customerName: 'Test Customer', customerEmail: 'test@example.com' };
  const booked = await (await fetch(`${url}/api/appointments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  const updatePath = `${url}/api/admin/appointments/${booked.id}`;
  const denied = await fetch(updatePath, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'confirmed' }) });
  assert.equal(denied.status, 403);
  const allowed = await fetch(updatePath, { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-demo-role': 'admin' }, body: JSON.stringify({ status: 'confirmed' }) });
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).status, 'confirmed');
}));
