import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import Stripe from 'stripe';
import { createApp } from '../src/app.js';
import { MemoryStore } from '../src/store.js';

async function fixture(fn, overrides = {}) {
  const store = new MemoryStore();
  const stripe = new Stripe('sk_test_placeholder');
  const sessions = [];
  const refunds = [];
  stripe.checkout.sessions.create = async (params, options) => {
    const row = { id: `cs_retail_${sessions.length + 1}`, url: 'https://checkout.stripe.com/pay/mock', expires_at: params.expires_at, params, options };
    sessions.push(row);
    return row;
  };
  stripe.refunds.create = async (params, options) => {
    const row = { id: `re_${refunds.length + 1}`, status: 'pending', payment_intent: params.payment_intent,
      amount: (await store.listOrders()).find((order) => order.id === params.metadata.orderId).totalCents, metadata: params.metadata };
    refunds.push({ params, options, row });
    return row;
  };
  const secret = 'whsec_signed_retail_tests';
  const { app } = createApp({ store, stripeClient: stripe, config: { DEMO_MODE: 'true', WEB_ORIGIN: 'http://localhost:5173', STRIPE_WEBHOOK_SECRET: secret, ...overrides } });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const json = (path, method = 'GET', body, admin = false) => fetch(`${url}/api${path}`, {
    method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(admin ? { 'x-demo-role': 'admin' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const webhook = (id, type, object, valid = true) => {
    const payload = JSON.stringify({ id, type, data: { object } });
    return fetch(`${url}/api/stripe/webhook`, { method: 'POST', headers: { 'content-type': 'application/json',
      'stripe-signature': valid ? stripe.webhooks.generateTestHeaderString({ payload, secret }) : 'invalid' }, body: payload });
  };
  const checkout = async (items) => json('/checkout', 'POST', { items });
  const pay = (order, session, eventId = 'evt_paid') => webhook(eventId, 'checkout.session.completed', {
    id: session.id, payment_status: 'paid', payment_intent: `pi_${order.id}`, currency: 'usd', amount_total: order.totalCents,
    metadata: { orderId: order.id }, customer_details: { email: 'buyer@example.com' },
  });
  try { await fn({ store, sessions, refunds, json, webhook, checkout, pay }); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test('retail cart deduplicates product IDs and reserves stock without overselling', async () => fixture(async ({ checkout, store, sessions, json }) => {
  assert.equal((await checkout([{ productId: 'balm', quantity: 2 }, { productId: 'balm', quantity: 2 }])).status, 400);
  assert.equal((await checkout([{ productId: 'balm', quantity: 4 }])).status, 201);
  assert.equal((await checkout([{ productId: 'balm', quantity: 2 }])).status, 409);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].params.mode, 'payment');
  assert.equal(sessions[0].params.client_reference_id, (await store.listOrders())[0].id);
  const balm = (await store.listProducts()).find((p) => p.id === 'balm');
  assert.equal(balm.inventory, 5);
  assert.equal(balm.reserved, 4);
  assert.equal((await json('/admin/inventory/balm/adjust', 'POST', { delta: -2, reason: 'Physical recount' }, true)).status, 409);
}));

test('signed Stripe payment consumes reserved inventory exactly once and exposes linked history', async () => fixture(async ({ store, sessions, json, checkout, pay, webhook }) => {
  assert.equal((await checkout([{ productId: 'shampoo', quantity: 2 }, { productId: 'oil', quantity: 1 }])).status, 201);
  const order = (await store.listOrders())[0];
  assert.equal(order.userId, 'demo-customer');
  assert.equal(order.totalCents, 11600);
  assert.equal((await json('/admin/orders', 'GET')).status, 403);
  assert.equal((await webhook('evt_bad_sig', 'checkout.session.completed', { metadata: { orderId: order.id } }, false)).status, 400);
  const wrongAmount = await webhook('evt_wrong_total', 'checkout.session.completed', { id: sessions[0].id, metadata: { orderId: order.id }, payment_status: 'paid', payment_intent: `pi_${order.id}`, currency: 'usd', amount_total: 1 });
  assert.equal(wrongAmount.status, 500);
  assert.equal((await store.getOrder(order.id)).status, 'pending');
  assert.equal((await pay(order, sessions[0])).status, 200);
  assert.equal((await pay(order, sessions[0])).status, 200);
  assert.equal((await store.getOrder(order.id)).status, 'paid');
  assert.equal((await store.listProducts()).find((p) => p.id === 'shampoo').inventory, 22);
  assert.equal((await store.listProducts()).find((p) => p.id === 'oil').inventory, 17);
  assert.equal((await store.listInventoryMovements()).length, 2);
  const history = await (await json('/orders')).json();
  assert.equal(history.length, 1);
  assert.equal(history[0].customerEmail, 'buyer@example.com');
  assert.equal((await json(`/admin/orders/${order.id}/fulfillment`, 'PATCH', { fulfillmentStatus: 'processing' }, true)).status, 200);
}));

test('Stripe expiry and cleanup return holds; late payment never silently consumes unreserved stock', async () => fixture(async ({ store, checkout, webhook, sessions, pay, json }) => {
  await checkout([{ productId: 'balm', quantity: 5 }]);
  const original = (await store.listOrders())[0];
  assert.equal((await checkout([{ productId: 'balm', quantity: 1 }])).status, 409);
  assert.equal((await webhook('evt_expired', 'checkout.session.expired', { id: sessions[0].id, metadata: { orderId: original.id } })).status, 200);
  assert.equal((await store.getOrder(original.id)).status, 'expired');
  assert.equal((await store.listProducts()).find((p) => p.id === 'balm').reserved, 0);
  assert.equal((await pay(original, sessions[0], 'evt_delayed_payment')).status, 200);
  assert.equal((await store.getOrder(original.id)).status, 'paid_stock_review');
  assert.equal((await store.listProducts()).find((p) => p.id === 'balm').inventory, 5);
  assert.equal((await json(`/admin/orders/${original.id}/fulfillment`, 'PATCH', { fulfillmentStatus: 'fulfilled' }, true)).status, 409);
  await checkout([{ productId: 'balm', quantity: 1 }]);
  const pending = (await store.listOrders())[0];
  assert.equal(await store.releaseExpiredOrders(new Date(Date.now() + 60 * 60_000).toISOString()), 1);
  assert.equal((await store.getOrder(pending.id)).status, 'expired');
}));

test('refunds require admin, persist a stable idempotency key, and restock only after successful Stripe status', async () => fixture(async ({ store, checkout, sessions, pay, json, webhook, refunds }) => {
  await checkout([{ productId: 'balm', quantity: 2 }]);
  const order = (await store.listOrders())[0];
  await pay(order, sessions[0]);
  assert.equal((await store.listProducts()).find((p) => p.id === 'balm').inventory, 3);
  const endpoint = `/admin/orders/${order.id}/refund`;
  assert.equal((await json(endpoint, 'POST', { restock: true })).status, 403);
  const requested = await json(endpoint, 'POST', { restock: true }, true);
  assert.equal(requested.status, 200);
  assert.equal((await requested.json()).refund.status, 'pending');
  assert.equal((await store.listProducts()).find((p) => p.id === 'balm').inventory, 3);
  assert.equal(refunds[0].options.idempotencyKey, `salon-full-refund-${order.id}`);
  assert.equal((await json(endpoint, 'POST', { restock: false }, true)).status, 409);
  const succeeded = { ...refunds[0].row, status: 'succeeded' };
  assert.equal((await webhook('evt_refund_success', 'refund.updated', succeeded)).status, 200);
  assert.equal((await webhook('evt_refund_success_duplicate', 'refund.updated', succeeded)).status, 200);
  assert.equal((await store.getOrder(order.id)).status, 'refunded');
  assert.equal((await store.listProducts()).find((p) => p.id === 'balm').inventory, 5);
  assert.equal((await store.listInventoryMovements()).length, 2);
  assert.equal((await json(endpoint, 'POST', { restock: true }, true)).status, 409);
}));

test('a refund without a physical return preserves inventory, and only owned orders appear in account', async () => fixture(async ({ store, checkout, sessions, pay, json, webhook, refunds }) => {
  await checkout([{ productId: 'oil', quantity: 1 }]);
  const order = (await store.listOrders())[0];
  await pay(order, sessions[0]);
  await store.createOrder({ id: 'other-user', userId: 'another-account', items: [], status: 'pending' });
  const history = await (await json('/orders')).json();
  assert.equal(history.length, 1);
  await json(`/admin/orders/${order.id}/refund`, 'POST', { restock: false }, true);
  await webhook('evt_refund_no_stock', 'refund.updated', { ...refunds[0].row, status: 'succeeded' });
  assert.equal((await store.listProducts()).find((p) => p.id === 'oil').inventory, 17);
}));

test('a signed paid session can recover a recorded order if the server restarted before session ID persisted', async () => {
  const store = new MemoryStore();
  const order = await store.createOrder({ id: 'recoverable', items: [{ productId: 'balm', name: 'Cuticle Balm', quantity: 1 }],
    currency: 'usd', totalCents: 2600, status: 'pending', fulfillmentStatus: 'unfulfilled' });
  await assert.rejects(store.markOrderPaid(order.id, 'pi_recovery', null,
    { sessionId: 'cs_recovery', clientReferenceId: 'wrong-order', amountTotal: 2600, currency: 'usd' }));
  const paid = await store.markOrderPaid(order.id, 'pi_recovery', 'buyer@example.com',
    { sessionId: 'cs_recovery', clientReferenceId: order.id, amountTotal: 2600, currency: 'usd' });
  assert.equal(paid.status, 'paid');
  assert.equal(paid.checkoutSessionId, 'cs_recovery');
  assert.equal((await store.listProducts()).find((p) => p.id === 'balm').inventory, 4);
});

test('stock-review payments support compensating full refunds but never unearned restocks', async () => fixture(async ({ store, checkout, sessions, pay, json, webhook, refunds }) => {
  await checkout([{ productId: 'balm', quantity: 1 }]);
  const order = (await store.listOrders())[0];
  await webhook('evt_expire_review', 'checkout.session.expired', { id: sessions[0].id, metadata: { orderId: order.id } });
  await pay(order, sessions[0], 'evt_pay_review');
  const endpoint = `/admin/orders/${order.id}/refund`;
  assert.equal((await json(endpoint, 'POST', { restock: true }, true)).status, 409);
  assert.equal((await json(endpoint, 'POST', { restock: false }, true)).status, 200);
  assert.equal((await webhook('evt_refund_review', 'refund.updated', { ...refunds[0].row, status: 'succeeded' })).status, 200);
  assert.equal((await store.getOrder(order.id)).status, 'refunded');
  assert.equal((await store.listProducts()).find((p) => p.id === 'balm').inventory, 5);
}));
