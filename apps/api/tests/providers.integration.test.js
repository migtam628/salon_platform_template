import test from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import { Client, Account } from 'node-appwrite';
import { createServer } from 'node:http';
import { createApp } from '../src/app.js';
import { MemoryStore } from '../src/store.js';

// Both tests are read-only and explicitly opt-in. Never print tokens, user emails,
// payment details, or the complete provider error objects in CI output.
test('real Stripe TEST-MODE credential can read account balance', { skip: !process.env.STRIPE_TEST_SECRET_KEY && 'Set STRIPE_TEST_SECRET_KEY to run provider smoke checks.' }, async () => {
  const key = process.env.STRIPE_TEST_SECRET_KEY;
  if (!key.startsWith('sk_test_')) throw new Error('Only Stripe test-mode keys are accepted by integration tests.');
  const stripe = new Stripe(key, { timeout: 10_000, maxNetworkRetries: 1 });
  try {
    const result = await stripe.balance.retrieve();
    assert.equal(result.object, 'balance');
  } catch {
    throw new Error('Stripe test-mode read-only connection failed. Inspect provider configuration privately.');
  }
});

test('real Appwrite customer JWT resolves to the expected signed-in account', {
  skip: !(process.env.APPWRITE_TEST_JWT && process.env.APPWRITE_ENDPOINT && process.env.APPWRITE_PROJECT_ID && process.env.APPWRITE_TEST_USER_ID)
    && 'Set APPWRITE_TEST_JWT, APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID and APPWRITE_TEST_USER_ID to run identity smoke checks.',
}, async () => {
  if (!process.env.APPWRITE_ENDPOINT.startsWith('https://')) throw new Error('Appwrite test endpoint must use HTTPS.');
  const client = new Client().setEndpoint(process.env.APPWRITE_ENDPOINT).setProject(process.env.APPWRITE_PROJECT_ID).setJWT(process.env.APPWRITE_TEST_JWT);
  try {
    const account = await new Account(client).get();
    assert.equal(account.$id, process.env.APPWRITE_TEST_USER_ID);
  } catch {
    throw new Error('Appwrite JWT identity check failed. Check the test user, JWT age, project, and endpoint privately.');
  }

  // Exercise the same JWT in the actual Express permission middleware, with
  // read-only routes and an intentionally empty admin allowlist.
  const { app } = createApp({ store: new MemoryStore(), config: {
    DEMO_MODE: 'false', WEB_ORIGIN: 'http://localhost:5173',
    APPWRITE_ENDPOINT: process.env.APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID: process.env.APPWRITE_PROJECT_ID,
    ADMIN_USER_IDS: '__untrusted_test_user__',
  } });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const authorized = { authorization: `Bearer ${process.env.APPWRITE_TEST_JWT}` };
    assert.equal((await fetch(`${url}/api/appointments`)).status, 401);
    assert.equal((await fetch(`${url}/api/appointments`, { headers: authorized })).status, 200);
    assert.equal((await fetch(`${url}/api/admin/integrations`, { headers: authorized })).status, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
