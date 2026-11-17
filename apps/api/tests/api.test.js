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

test('admin catalog changes are validated and update public visibility', async () => withServer(async (url) => {
  const admin = { 'content-type': 'application/json', 'x-demo-role': 'admin' };
  const input = { name: 'Scalp Serum', sku: 'AB-HC-099', category: 'Hair Care', price: 39, inventory: 7, lowStockThreshold: 4, image: '/images/product-oil.webp', description: 'Hydrate and soothe', featured: false, active: true };
  const blocked = await fetch(`${url}/api/admin/products`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  assert.equal(blocked.status, 403);
  const created = await fetch(`${url}/api/admin/products`, { method: 'POST', headers: admin, body: JSON.stringify(input) });
  assert.equal(created.status, 201);
  const product = await created.json();
  assert.ok(product.id);
  const duplicate = await fetch(`${url}/api/admin/products`, { method: 'POST', headers: admin, body: JSON.stringify({ ...input, name: 'Duplicate serum' }) });
  assert.equal(duplicate.status, 409);
  const hidden = await fetch(`${url}/api/admin/products/${product.id}`, { method: 'PATCH', headers: admin, body: JSON.stringify({ ...input, active: false, inventory: undefined }) });
  assert.equal(hidden.status, 200);
  const publicCatalog = await (await fetch(`${url}/api/products`)).json();
  const privateCatalog = await (await fetch(`${url}/api/admin/products`, { headers: admin })).json();
  assert.equal(publicCatalog.some((p) => p.id === product.id), false);
  assert.equal(privateCatalog.some((p) => p.id === product.id), true);
}));

test('inventory adjustments are audited and never allow negative stock', async () => withServer(async (url) => {
  const headers = { 'content-type': 'application/json', 'x-demo-role': 'admin' };
  const adjustment = (delta) => fetch(`${url}/api/admin/inventory/balm/adjust`, { method: 'POST', headers, body: JSON.stringify({ delta, reason: 'Physical stock count' }) });
  assert.equal((await adjustment(-4)).status, 200);
  const rejected = await adjustment(-10);
  assert.equal(rejected.status, 409);
  const inventory = await (await fetch(`${url}/api/admin/inventory`, { headers })).json();
  assert.equal(inventory.products.find((p) => p.id === 'balm').inventory, 1);
  assert.equal(inventory.movements.length, 1);
  assert.equal(inventory.movements[0].delta, -4);
}));

test('services, specialists, and integration status are admin-managed', async () => withServer(async (url) => {
  const headers = { 'content-type': 'application/json', 'x-demo-role': 'admin' };
  const service = await fetch(`${url}/api/admin/services`, { method: 'POST', headers, body: JSON.stringify({ name: 'Blowout', category: 'Hair', durationMinutes: 45, price: 60, description: 'Professional finish', active: true }) });
  assert.equal(service.status, 201);
  const badStaff = await fetch(`${url}/api/admin/staff`, { method: 'POST', headers, body: JSON.stringify({ name: 'New Stylist', specialties: ['Hair'], workDays: [1, 2], startTime: '18:00', endTime: '09:00', active: true }) });
  assert.equal(badStaff.status, 400);
  const staff = await fetch(`${url}/api/admin/staff`, { method: 'POST', headers, body: JSON.stringify({ name: 'New Stylist', specialties: ['Hair'], workDays: [1, 2], startTime: '09:00', endTime: '18:00', active: true }) });
  assert.equal(staff.status, 201);
  const integrations = await (await fetch(`${url}/api/admin/integrations`, { headers })).json();
  assert.equal(integrations.payments, false);
  assert.equal(integrations.demo, true);
}));

test('unpaid orders cannot be marked as fulfilled', async () => {
  const store = new MemoryStore();
  await store.createOrder({ id: 'pending', status: 'pending', fulfillmentStatus: 'unfulfilled' });
  await assert.rejects(store.updateOrderFulfillment('pending', 'fulfilled'), { status: 409 });
});
