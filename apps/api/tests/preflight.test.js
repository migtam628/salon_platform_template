import test from 'node:test';
import assert from 'node:assert/strict';
import { checkProductionEnv } from '../src/preflight.js';

const valid = {
  DEMO_MODE: 'false',
  MONGODB_URI: 'mongodb://localhost:27017/?replicaSet=rs0',
  APPWRITE_ENDPOINT: 'https://identity.example/v1',
  APPWRITE_PROJECT_ID: 'project-id',
  ADMIN_USER_IDS: 'trusted-admin',
  WEB_ORIGIN: 'https://salon.example',
  PUBLIC_WEB_URL: 'https://salon.example',
  TRUST_PROXY_HOPS: '1',
};

test('production preflight accepts safe offline configuration without payment providers', () => {
  const result = checkProductionEnv(valid);
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
  assert.ok(result.notices.some((notice) => notice.includes('Payments remain disabled')));
});

test('production preflight rejects preview mode and incomplete credential pairs', () => {
  const result = checkProductionEnv({ ...valid, DEMO_MODE: 'true', STRIPE_SECRET_KEY: 'sk_test_fake', RESEND_API_KEY: 're_fake' });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.includes('Production requires')));
  assert.ok(result.issues.some((issue) => issue.includes('Email requires both')));
  const stripeResult = checkProductionEnv({ ...valid, STRIPE_SECRET_KEY: 'sk_test_fake' });
  assert.equal(stripeResult.ok, false);
  assert.ok(stripeResult.issues.some((issue) => issue.includes('Stripe secret')));
});

test('production preflight enforces deposit and proxy policy without exposing credentials', () => {
  const result = checkProductionEnv({ ...valid, TRUST_PROXY_HOPS: '99', BOOKING_DEPOSIT_PERCENT: '25' });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.includes('TRUST_PROXY_HOPS')));
  assert.ok(result.issues.some((issue) => issue.includes('Appointment deposits require')));
  assert.ok(!JSON.stringify(result).includes(valid.MONGODB_URI));
});

test('production preflight accepts paired Stripe and email settings', () => {
  const result = checkProductionEnv({ ...valid, STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: 'whsec_fake', RESEND_API_KEY: 're_fake', SALON_EMAIL_FROM: 'ops@salon.example', BOOKING_DEPOSIT_PERCENT: '25' });
  assert.equal(result.ok, true);
});
