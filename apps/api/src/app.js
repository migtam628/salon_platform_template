import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import Stripe from 'stripe';
import { Client, Account } from 'node-appwrite';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const appointmentSchema = z.object({
  serviceId: z.string().min(1), staffId: z.string().min(1), startAt: z.iso.datetime(),
  customerName: z.string().trim().min(2).max(100), customerEmail: z.email(), notes: z.string().max(500).optional().default(''),
});
const messageSchema = z.object({ conversationId: z.string().min(2).max(100), text: z.string().trim().min(1).max(1500) });
const cartSchema = z.object({ items: z.array(z.object({ productId: z.string(), quantity: z.number().int().min(1).max(20) })).min(1).max(30) });

export function createApp({ store, config = process.env, onMessage = () => {} }) {
  const app = express();
  const demo = config.DEMO_MODE === 'true';
  const stripe = config.STRIPE_SECRET_KEY ? new Stripe(config.STRIPE_SECRET_KEY) : null;
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: config.WEB_ORIGIN?.split(',') || 'http://localhost:5173' }));

  // Stripe signs the raw bytes; JSON parsing must not happen before signature validation.
  app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    if (!stripe || !config.STRIPE_WEBHOOK_SECRET) return res.status(503).json({ error: 'Stripe is not configured.' });
    let event;
    try { event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], config.STRIPE_WEBHOOK_SECRET); }
    catch { return res.status(400).json({ error: 'Invalid webhook signature.' }); }
    try {
      if (await store.hasEvent(event.id)) return res.json({ received: true, duplicate: true });
      if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
        const session = event.data.object;
        if (session.payment_status === 'paid' && session.metadata?.orderId) await store.markOrderPaid(session.metadata.orderId, session.payment_intent || '');
      }
      await store.recordEvent(event.id);
      res.json({ received: true });
    } catch (error) { console.error('Webhook persistence error:', error); res.status(500).json({ error: 'Webhook processing failed.' }); }
  });

  app.use(express.json({ limit: '32kb' }));
  app.get('/api/health', (_req, res) => res.json({ ok: true, demo, paymentsConfigured: Boolean(stripe && config.STRIPE_WEBHOOK_SECRET) }));
  app.get('/api/products', async (_req, res, next) => { try { res.json(await store.listProducts()); } catch (e) { next(e); } });
  app.get('/api/services', async (_req, res, next) => { try { res.json(await store.listServices()); } catch (e) { next(e); } });
  app.get('/api/staff', async (_req, res, next) => { try { res.json(await store.listStaff()); } catch (e) { next(e); } });

  async function authenticate(req, res, next) {
    if (demo) { req.user = { id: 'demo-customer', email: 'guest@demo.invalid', role: req.headers['x-demo-role'] === 'admin' ? 'admin' : 'customer' }; return next(); }
    const jwt = req.headers.authorization?.replace(/^Bearer /i, '');
    if (!jwt || !config.APPWRITE_ENDPOINT || !config.APPWRITE_PROJECT_ID) return res.status(401).json({ error: 'Sign in is required.' });
    try {
      const client = new Client().setEndpoint(config.APPWRITE_ENDPOINT).setProject(config.APPWRITE_PROJECT_ID).setJWT(jwt);
      const user = await new Account(client).get();
      // Admin role must be assigned by a trusted server-side account configuration, never by a client header.
      req.user = { id: user.$id, email: user.email, role: (config.ADMIN_USER_IDS || '').split(',').includes(user.$id) ? 'admin' : 'customer' };
      next();
    } catch { res.status(401).json({ error: 'Invalid or expired session.' }); }
  }
  function adminOnly(req, res, next) { if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Administrator access required.' }); next(); }
  app.get('/api/appointments', authenticate, async (req, res, next) => { try { res.json(await store.listAppointments(req.user.role === 'admin' ? undefined : req.user.id)); } catch (e) { next(e); } });
  app.post('/api/appointments', authenticate, async (req, res, next) => {
    try {
      const input = appointmentSchema.parse(req.body);
      const [services, staff] = await Promise.all([store.listServices(), store.listStaff()]);
      const service = services.find((s) => s.id === input.serviceId);
      const stylist = staff.find((s) => s.id === input.staffId);
      if (!service || !stylist || !stylist.specialties.includes(service.category)) return res.status(400).json({ error: 'Choose a valid service and specialist.' });
      if (new Date(input.startAt).getTime() <= Date.now()) return res.status(400).json({ error: 'Appointment time must be in the future.' });
      const saved = await store.createAppointment({ ...input, id: randomUUID(), userId: req.user.id, serviceName: service.name, staffName: stylist.name, durationMinutes: service.durationMinutes, price: service.price, status: 'requested', createdAt: new Date().toISOString() });
      res.status(201).json(saved);
    } catch (e) { next(e); }
  });
  app.get('/api/chat/:conversationId', authenticate, async (req, res, next) => {
    try {
      if (req.user.role !== 'admin' && req.params.conversationId !== req.user.id) return res.status(403).json({ error: 'Conversation is private.' });
      res.json(await store.listMessages(req.params.conversationId));
    } catch (e) { next(e); }
  });
  app.post('/api/chat', authenticate, async (req, res, next) => {
    try {
      const input = messageSchema.parse(req.body);
      if (req.user.role !== 'admin' && input.conversationId !== req.user.id) return res.status(403).json({ error: 'Conversation is private.' });
      const saved = await store.saveMessage({ id: randomUUID(), ...input, senderId: req.user.id, senderRole: req.user.role, createdAt: new Date().toISOString() });
      onMessage(saved); res.status(201).json(saved);
    } catch (e) { next(e); }
  });
  app.get('/api/admin/overview', authenticate, adminOnly, async (_req, res, next) => { try { res.json(await store.dashboard()); } catch (e) { next(e); } });
  app.get('/api/admin/conversations', authenticate, adminOnly, async (_req, res, next) => { try { res.json(await store.listConversations()); } catch (e) { next(e); } });
  app.patch('/api/admin/appointments/:id', authenticate, adminOnly, async (req, res, next) => {
    try {
      const input = z.object({ status: z.enum(['requested', 'confirmed', 'completed', 'cancelled']) }).parse(req.body);
      const result = await store.updateAppointment(req.params.id, input.status);
      if (!result) return res.status(404).json({ error: 'Appointment not found.' });
      res.json(result);
    } catch (e) { next(e); }
  });
  app.post('/api/checkout', async (req, res, next) => {
    try {
      if (!stripe || !config.STRIPE_WEBHOOK_SECRET) return res.status(503).json({ error: 'Stripe checkout is not configured yet.' });
      const { items } = cartSchema.parse(req.body);
      const catalog = await store.listProducts();
      const lineItems = items.map(({ productId, quantity }) => {
        const item = catalog.find((p) => p.id === productId);
        if (!item || item.inventory < quantity) throw Object.assign(new Error('Product unavailable or insufficient stock.'), { status: 400 });
        return { price_data: { currency: 'usd', product_data: { name: item.name }, unit_amount: Math.round(item.price * 100) }, quantity };
      });
      const order = await store.createOrder({ id: randomUUID(), items, status: 'pending', createdAt: new Date().toISOString() });
      const base = config.PUBLIC_WEB_URL || 'http://localhost:5173';
      const session = await stripe.checkout.sessions.create({ mode: 'payment', line_items: lineItems, success_url: `${base}/shop?checkout=success`, cancel_url: `${base}/shop?checkout=cancelled`, metadata: { orderId: order.id } });
      res.status(201).json({ url: session.url });
    } catch (e) { next(e); }
  });

  app.use((error, _req, res, _next) => {
    if (error instanceof z.ZodError) return res.status(400).json({ error: 'Please review the submitted information.', details: error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) });
    if (!error.status || error.status >= 500) console.error(error);
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Internal server error.' });
  });
  return { app, authenticate, demo };
}
