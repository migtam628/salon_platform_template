import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { validateRuntimeConfig, proxyHops } from './security.js';

// Offline, read-only checks. Never print environment variable values, URLs,
// credentials, or user IDs. This is not a live-provider acceptance test.
export function checkProductionEnv(env = process.env) {
  const config = { ...env, NODE_ENV: 'production' };
  const issues = [];
  const notices = [];
  try { validateRuntimeConfig(config); }
  catch (error) { issues.push(error.message); }
  try { proxyHops(config); }
  catch (error) { issues.push(error.message); }

  if (config.MONGODB_URI && !/^mongodb(\+srv)?:\/\//.test(config.MONGODB_URI)) {
    issues.push('MONGODB_URI must use a mongodb:// or mongodb+srv:// connection scheme.');
  }
  if (config.BOOKING_DEPOSIT_PERCENT && (
    !Number.isFinite(Number(config.BOOKING_DEPOSIT_PERCENT)) ||
    Number(config.BOOKING_DEPOSIT_PERCENT) < 0 || Number(config.BOOKING_DEPOSIT_PERCENT) > 100
  )) issues.push('BOOKING_DEPOSIT_PERCENT must be between 0 and 100.');
  if (Number(config.BOOKING_DEPOSIT_PERCENT || 0) > 0 && !config.STRIPE_SECRET_KEY) {
    issues.push('Appointment deposits require Stripe credentials and webhook signing.');
  }
  if (Boolean(config.RESEND_API_KEY) !== Boolean(config.SALON_EMAIL_FROM)) {
    issues.push('Email requires both RESEND_API_KEY and SALON_EMAIL_FROM, or neither.');
  }

  if (!config.STRIPE_SECRET_KEY) notices.push('Payments remain disabled until Stripe is configured and verified in test mode.');
  if (!config.RESEND_API_KEY) notices.push('Outbound email remains disabled until a verified sender is configured.');
  notices.push('External connectivity, transactions, checkout, webhooks and email delivery require separate staging tests.');
  return { ok: issues.length === 0, issues, notices };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = checkProductionEnv();
  console.log(`Production configuration preflight: ${result.ok ? 'PASS' : 'FAIL'}`);
  for (const issue of result.issues) console.error(`FAIL: ${issue}`);
  for (const notice of result.notices) console.log(`NOTE: ${notice}`);
  if (!result.ok) process.exitCode = 1;
}
