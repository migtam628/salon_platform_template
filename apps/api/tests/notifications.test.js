import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/store.js';
import { processDueEmails, queueBookingEmails } from '../src/notifications.js';

function appointment() {
  return { id: 'booking-1', customerEmail: 'guest@example.com', serviceName: 'Manicure', staffName: 'Sofia', timeZone: 'America/New_York', startAt: new Date(Date.now() + 72 * 60 * 60_000).toISOString(), status: 'requested' };
}

test('notification queue emits request and future reminder, delivers through configured provider', async () => {
  const store = new MemoryStore();
  const booking = appointment();
  store.appointments.push(booking);
  await queueBookingEmails(store, booking, 'requested');
  assert.equal((await store.notificationStats()).pending, 2);
  const sent = [];
  const config = { RESEND_API_KEY: 'test-key', SALON_EMAIL_FROM: 'Salon <bookings@example.com>' };
  const result = await processDueEmails(store, config, async (url, options) => {
    assert.equal(url, 'https://api.resend.com/emails');
    assert.equal(options.headers['Idempotency-Key'].length, 36);
    sent.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ id: 'test-delivery-id' }) };
  });
  assert.equal(result.processed, 1);
  assert.equal(sent[0].to[0], booking.customerEmail);
  assert.equal((await store.notificationStats()).sent, 1);
  assert.equal((await store.notificationStats()).pending, 1);
});

test('rescheduling supersedes stale reminders and cancellation skips future reminders', async () => {
  const store = new MemoryStore();
  const booking = appointment();
  store.appointments.push(booking);
  await queueBookingEmails(store, booking, 'requested');
  const originalReminder = store.notifications.find((item) => item.kind === 'reminder');
  booking.startAt = new Date(Date.now() + 5 * 24 * 60 * 60_000).toISOString();
  await queueBookingEmails(store, booking, 'rescheduled');
  assert.equal(store.notifications.find((job) => job.id === originalReminder.id).status, 'superseded');
  booking.status = 'cancelled';
  await queueBookingEmails(store, booking, 'cancelled');
  assert.equal(store.notifications.filter((item) => item.status === 'pending' && item.kind === 'reminder').length, 0);
  assert.equal(store.notifications.find((item) => item.kind === 'cancelled').status, 'pending');
});

test('notifications do not claim delivery without provider configuration', async () => {
  const store = new MemoryStore();
  const booking = appointment();
  await queueBookingEmails(store, booking, 'requested');
  assert.deepEqual(await processDueEmails(store, {}), { configured: false, processed: 0 });
  assert.equal((await store.notificationStats()).pending, 2);
});
