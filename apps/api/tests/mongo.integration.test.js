import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MongoStore } from '../src/store.js';
import { occupiedSlots } from '../src/booking.js';

// Deliberately opt-in. Never point this test at a production database: it creates
// and drops a brand-new, uniquely named test database on the supplied server.
const uri = process.env.MONGODB_TEST_URI;

test('MongoDB replica-set integration: concurrency, payment settlement, refunds and bookings', { skip: !uri && 'Set MONGODB_TEST_URI to a disposable replica-set test server.' }, async (t) => {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing integration database mutation when NODE_ENV=production.');
  if (!/^mongodb:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?]|$)/.test(uri)) {
    throw new Error('MONGODB_TEST_URI must point to a local disposable replica set, never a remote or production database.');
  }
  const name = `salon_integration_${randomUUID().replaceAll('-', '')}`;
  let store;
  try {
    store = await MongoStore.connect(uri, name);
    await t.test('single remaining unit cannot be reserved by two concurrent buyers', async () => {
      const initial = (await store.listProducts()).find((item) => item.id === 'balm');
      assert.ok(initial);
      await store.adjustInventory('balm', -(initial.inventory - 1), 'Integration test stock floor', 'test-runner');
      const order = (id) => ({ id, items: [{ productId: 'balm', sku: initial.sku, name: initial.name, unitPrice: initial.price, quantity: 1 }],
        totalCents: Math.round(initial.price * 100), currency: 'usd', status: 'pending', fulfillmentStatus: 'unfulfilled',
        reservationExpiresAt: new Date(Date.now() + 50 * 60_000).toISOString(), createdAt: new Date().toISOString() });
      const results = await Promise.allSettled([store.createOrder(order('race-a')), store.createOrder(order('race-b'))]);
      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
      assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
      const product = (await store.listProducts()).find((item) => item.id === 'balm');
      assert.equal(product.inventory, 1);
      assert.equal(product.reserved, 1);
    });

    await t.test('wrong amount is refused; a valid payment and refund settle and restock exactly once', async () => {
      const order = (await store.listOrders()).find((item) => item.status === 'pending');
      assert.ok(order);
      const stripeSession = { id: 'cs_test_mongo_integration', expires_at: Math.floor(Date.now() / 1000) + 1800 };
      await store.setOrderCheckoutSession(order.id, stripeSession);
      const payment = { sessionId: stripeSession.id, clientReferenceId: order.id, amountTotal: order.totalCents, currency: 'usd' };
      await assert.rejects(store.markOrderPaid(order.id, 'pi_test_mongo', null, { ...payment, amountTotal: 1 }));
      assert.equal((await store.getOrder(order.id)).status, 'pending');
      await store.markOrderPaid(order.id, 'pi_test_mongo', 'test-buyer@example.invalid', payment);
      await store.markOrderPaid(order.id, 'pi_test_mongo', 'test-buyer@example.invalid', payment);
      assert.equal((await store.getOrder(order.id)).status, 'paid');
      assert.equal((await store.listProducts()).find((item) => item.id === 'balm').inventory, 0);
      assert.equal((await store.listInventoryMovements()).filter((movement) => movement.reason.startsWith('Stripe order')).length, 1);
      await store.beginOrderRefund(order.id, true, 'test-admin');
      const refund = { id: 're_test_mongo_integration', payment_intent: 'pi_test_mongo', amount: order.totalCents, metadata: { orderId: order.id }, status: 'succeeded' };
      await store.applyOrderRefund(order.id, refund);
      await store.applyOrderRefund(order.id, refund);
      assert.equal((await store.getOrder(order.id)).status, 'refunded');
      assert.equal((await store.listProducts()).find((item) => item.id === 'balm').inventory, 1);
      assert.equal((await store.listInventoryMovements()).filter((movement) => movement.reason.startsWith('Refund return')).length, 1);
    });

    await t.test('MongoDB unique booking-slot index rejects overlapping concurrent bookings', async () => {
      const startAt = '2028-05-16T15:00:00.000Z';
      const appointment = (id, start, durationMinutes) => ({ id, staffId: 'sofia', serviceId: 'manicure', userId: 'test-customer',
        startAt: start, durationMinutes, bookingDate: '2028-05-16', occupiedSlots: occupiedSlots(start, durationMinutes),
        customerName: 'Integration Guest', customerEmail: 'test-buyer@example.invalid', status: 'requested' });
      const results = await Promise.allSettled([
        store.createAppointment(appointment('booking-a', startAt, 45)),
        store.createAppointment(appointment('booking-b', '2028-05-16T15:15:00.000Z', 45)),
      ]);
      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
      assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
      const bookings = await store.listAppointments('test-customer');
      assert.equal(bookings.length, 1);
    });

    await t.test('abandoned Checkout reservation expires and returns held stock', async () => {
      const oil = (await store.listProducts()).find((item) => item.id === 'oil');
      await store.createOrder({ id: 'expiring-order', items: [{ productId: 'oil', name: oil.name, quantity: 2 }],
        totalCents: Math.round(oil.price * 200), currency: 'usd', status: 'pending',
        reservationExpiresAt: new Date(Date.now() - 60_000).toISOString() });
      assert.equal(await store.releaseExpiredOrders(), 1);
      assert.equal((await store.getOrder('expiring-order')).status, 'expired');
      assert.equal((await store.listProducts()).find((item) => item.id === 'oil').reserved, 0);
    });
  } finally {
    if (store) {
      // The only deletion is the unique database this test just created.
      try { await store.db.dropDatabase(); }
      finally { await store.close(); }
    }
  }
});
