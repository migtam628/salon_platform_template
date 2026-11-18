import { randomUUID } from 'node:crypto';

export function allowedOrigins(config = process.env) {
  const origins = (config.WEB_ORIGIN || 'http://localhost:5173').split(',').map((origin) => origin.trim()).filter(Boolean);
  for (const origin of origins) {
    let parsed;
    try { parsed = new URL(origin); }
    catch { throw new Error('WEB_ORIGIN must contain valid absolute origins.'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin || parsed.username || parsed.password) {
      throw new Error('WEB_ORIGIN must contain origins without paths, credentials, or wildcards.');
    }
  }
  return [...new Set(origins)];
}

export function validateRuntimeConfig(config = process.env) {
  const origins = allowedOrigins(config);
  if (config.NODE_ENV !== 'production') return origins;
  if (config.DEMO_MODE === 'true' || !config.MONGODB_URI || !config.APPWRITE_ENDPOINT || !config.APPWRITE_PROJECT_ID) {
    throw new Error('Production requires MongoDB and Appwrite authentication, and DEMO_MODE must be disabled.');
  }
  if (!config.ADMIN_USER_IDS?.split(',').some((id) => id.trim())) throw new Error('Production requires at least one trusted ADMIN_USER_IDS entry.');
  if (!origins.length || origins.some((origin) => !origin.startsWith('https://'))) throw new Error('Production WEB_ORIGIN must contain HTTPS origins.');
  if (!config.PUBLIC_WEB_URL || !/^https:\/\//.test(config.PUBLIC_WEB_URL) || new URL(config.PUBLIC_WEB_URL).origin !== config.PUBLIC_WEB_URL) {
    throw new Error('Production PUBLIC_WEB_URL must be an HTTPS origin without a path.');
  }
  if (!config.APPWRITE_ENDPOINT.startsWith('https://')) throw new Error('Production APPWRITE_ENDPOINT must use HTTPS.');
  if (Boolean(config.STRIPE_SECRET_KEY) !== Boolean(config.STRIPE_WEBHOOK_SECRET)) throw new Error('Stripe secret and webhook signing secret must both be set, or both be disabled.');
  if (config.STRIPE_SECRET_KEY && !config.STRIPE_SECRET_KEY.startsWith('sk_')) throw new Error('STRIPE_SECRET_KEY must be a Stripe secret key.');
  if (config.STRIPE_WEBHOOK_SECRET && !config.STRIPE_WEBHOOK_SECRET.startsWith('whsec_')) throw new Error('STRIPE_WEBHOOK_SECRET must be a Stripe webhook signing secret.');
  return origins;
}

export function proxyHops(config = process.env) {
  const raw = config.TRUST_PROXY_HOPS || '0';
  if (!/^[0-2]$/.test(raw)) throw new Error('TRUST_PROXY_HOPS must be 0, 1, or 2.');
  return Number(raw);
}

export function requestId(req, res, next) {
  req.requestId = randomUUID(); // Never reuse an untrusted inbound header.
  res.setHeader('X-Request-ID', req.requestId);
  next();
}

// Per-process protection. For multiple replicas, enforce shared/global limits at the edge.
export function rateLimiter({ max, windowMs, label = 'request', key = (req) => req.user?.id || req.ip }) {
  if (!Number.isSafeInteger(max) || max <= 0 || !Number.isSafeInteger(windowMs) || windowMs <= 0) throw new Error('Invalid rate-limit settings.');
  const buckets = new Map();
  return (req, res, next) => {
    const now = Date.now();
    if (buckets.size >= 10_000) {
      for (const [bucketKey, bucket] of buckets) if (bucket.expiresAt <= now) buckets.delete(bucketKey);
      while (buckets.size >= 10_000) buckets.delete(buckets.keys().next().value);
    }
    const bucketKey = `${label}:${String(key(req) || 'unknown')}`;
    let bucket = buckets.get(bucketKey);
    if (!bucket || bucket.expiresAt <= now) {
      bucket = { count: 0, expiresAt: now + windowMs };
      buckets.set(bucketKey, bucket);
    }
    bucket.count++;
    res.setHeader('RateLimit-Limit', max);
    res.setHeader('RateLimit-Remaining', Math.max(0, max - bucket.count));
    res.setHeader('RateLimit-Reset', Math.ceil(bucket.expiresAt / 1000));
    if (bucket.count > max) {
      res.setHeader('Retry-After', Math.max(1, Math.ceil((bucket.expiresAt - now) / 1000)));
      return res.status(429).json({ error: `Too many ${label} requests. Please try again later.` });
    }
    next();
  };
}

export function accessLog(req, res, next) {
  const start = performance.now();
  res.on('finish', () => {
    console.info(JSON.stringify({ event: 'http.request', requestId: req.requestId, method: req.method,
      route: req.route?.path || 'unmatched', status: res.statusCode, durationMs: Math.round(performance.now() - start) }));
  });
  next();
}
