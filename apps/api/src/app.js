import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import Stripe from 'stripe';
import { Client, Account } from 'node-appwrite';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DEFAULT_TIME_ZONE, bookingError, dailyAvailability, localParts, occupiedSlots, scheduleFitError, zonedToUtc } from './booking.js';
import { queueBookingEmails } from './notifications.js';
import { depositAmountCents, depositPercent } from './deposits.js';

const appointmentSchema = z.object({
  serviceId: z.string().min(1), staffId: z.string().min(1), startAt: z.iso.datetime(),
  customerName: z.string().trim().min(2).max(100), customerEmail: z.email(), notes: z.string().max(500).optional().default(''),
});
const appointmentTimeSchema = z.object({ startAt: z.iso.datetime() });
const availabilityQuerySchema = z.object({ serviceId: z.string().min(1), staffId: z.string().min(1), date: z.iso.date() });
const messageSchema = z.object({ conversationId: z.string().min(2).max(100), text: z.string().trim().min(1).max(1500) });
const cartSchema = z.object({ items: z.array(z.object({ productId: z.string(), quantity: z.number().int().min(1).max(20) })).min(1).max(30) });
const imageSchema = z.string().trim().max(500).refine((value) => !value || value.startsWith('/images/') || /^https:\/\//.test(value), 'Image must use HTTPS or a local image path.');
const productSchema = z.object({
  name: z.string().trim().min(2).max(120), sku: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,40}$/),
  category: z.string().trim().min(2).max(60), price: z.number().min(0).max(100000),
  image: imageSchema, description: z.string().trim().max(600), featured: z.boolean(), active: z.boolean(),
  lowStockThreshold: z.number().int().min(0).max(100000),
});
const productCreateSchema = productSchema.extend({ inventory: z.number().int().min(0).max(1000000) });
const serviceSchema = z.object({
  name: z.string().trim().min(2).max(120), category: z.enum(['Hair', 'Nails', 'Beauty']),
  durationMinutes: z.number().int().min(15).max(480).refine((value) => value % 15 === 0, 'Duration must be a multiple of 15 minutes.'), price: z.number().min(0).max(100000),
  description: z.string().trim().max(600), active: z.boolean(),
});
const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const quarterTime = timeSchema.refine((value) => Number(value.slice(3)) % 15 === 0, 'Time must be on a 15-minute boundary.');
const breakSchema = z.object({ startTime: quarterTime, endTime: quarterTime }).refine((item) => item.startTime < item.endTime, 'Break end must be later than its start.');
const exceptionSchema = z.object({ date: z.iso.date(), closed: z.boolean(), startTime: quarterTime.optional(), endTime: quarterTime.optional(), breaks: z.array(breakSchema).max(8).optional() });
function validateBreaks(breaks, startTime, endTime, ctx, path) {
  for (const [index, pause] of breaks.entries()) {
    if (pause.startTime < startTime || pause.endTime > endTime || breaks.some((other, i) => i !== index && pause.startTime < other.endTime && other.startTime < pause.endTime)) {
      ctx.addIssue({ code: 'custom', message: 'Breaks must fit within hours and not overlap.', path: [...path, index] });
    }
  }
}
const staffSchema = z.object({
  name: z.string().trim().min(2).max(120), specialties: z.array(z.enum(['Hair', 'Nails', 'Beauty'])).min(1).max(3),
  workDays: z.array(z.number().int().min(0).max(6)).min(1).max(7), startTime: quarterTime, endTime: quarterTime, active: z.boolean(),
  breaks: z.array(breakSchema).max(8).optional().default([]),
  exceptions: z.array(exceptionSchema).max(100).optional().default([]),
}).superRefine((value, ctx) => {
  if (value.startTime >= value.endTime) ctx.addIssue({ code: 'custom', message: 'End time must be later than start time.', path: ['endTime'] });
  validateBreaks(value.breaks, value.startTime, value.endTime, ctx, ['breaks']);
  const seen = new Set();
  for (const [index, exception] of value.exceptions.entries()) {
    if (seen.has(exception.date)) ctx.addIssue({ code: 'custom', message: 'Only one override is allowed for each date.', path: ['exceptions', index, 'date'] });
    seen.add(exception.date);
    if (!exception.closed) {
      if (!exception.startTime || !exception.endTime || exception.startTime >= exception.endTime) ctx.addIssue({ code: 'custom', message: 'Open dates require valid start and end hours.', path: ['exceptions', index] });
      else validateBreaks(exception.breaks ?? value.breaks, exception.startTime, exception.endTime, ctx, ['exceptions', index, 'breaks']);
    }
  }
});

export function createApp({ store, config = process.env, onMessage = () => {}, stripeClient = null }) {
  const app = express();
  const demo = config.DEMO_MODE === 'true';
  const timeZone = config.SALON_TIME_ZONE || DEFAULT_TIME_ZONE;
  new Intl.DateTimeFormat('en-US', { timeZone }); // Fail fast for invalid IANA time zones.
  const leadMinutes = Math.max(0, Number(config.BOOKING_MIN_LEAD_MINUTES || 60));
  const stripe = stripeClient || (config.STRIPE_SECRET_KEY ? new Stripe(config.STRIPE_SECRET_KEY) : null);
  const bookingDepositPercent = depositPercent(config);
  if (bookingDepositPercent > 0 && !demo && (!stripe || !config.STRIPE_WEBHOOK_SECRET)) throw new Error('Appointment deposits require Stripe Checkout and a signed webhook.');
  async function notifyBooking(appointment, kind) {
    try { await queueBookingEmails(store, appointment, kind); }
    catch (error) { console.error(`Unable to queue appointment ${kind} notification:`, error.message); }
  }
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
        if (session.payment_status === 'paid' && session.metadata?.orderId) await store.markOrderPaid(session.metadata.orderId, session.payment_intent || '', session.customer_details?.email || session.customer_email);
        if (session.payment_status === 'paid' && session.metadata?.paymentKind === 'appointment_deposit') {
          if (session.currency !== 'usd' || !session.metadata?.appointmentId || !Number.isSafeInteger(session.amount_total)) throw new Error('Invalid appointment deposit payload.');
          const booking = await store.getAppointment(session.metadata.appointmentId);
          if (!booking || booking.depositCheckoutSessionId !== session.id) throw new Error('Appointment deposit Checkout Session did not match the pending payment.');
          await store.markAppointmentDepositPaid(session.metadata.appointmentId, session.payment_intent || '', session.amount_total);
        }
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

  async function slotData(serviceId, staffId, date, excludingId) {
    const [services, staff] = await Promise.all([store.listServices(), store.listStaff()]);
    const service = services.find((s) => s.id === serviceId);
    const stylist = staff.find((s) => s.id === staffId);
    if (!service || !stylist || !stylist.specialties.includes(service.category)) throw Object.assign(new Error('Choose an available service and specialist.'), { status: 400 });
    const start = zonedToUtc(date, '00:00', timeZone);
    const next = new Date(`${date}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    const end = zonedToUtc(next.toISOString().slice(0, 10), '00:00', timeZone);
    if (!start || !end) throw Object.assign(new Error('Invalid appointment date.'), { status: 400 });
    const booked = await store.listStaffAppointments(staffId, start.toISOString(), end.toISOString());
    return dailyAvailability({ service, stylist, date, appointments: booked, timeZone, leadMinutes, excludingId });
  }
  app.get('/api/availability', async (req, res, next) => {
    try {
      const { serviceId, staffId, date } = availabilityQuerySchema.parse(req.query);
      res.json(await slotData(serviceId, staffId, date));
    } catch (e) { next(e); }
  });

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
  app.get('/api/appointments/:id/availability', authenticate, async (req, res, next) => {
    try {
      const { date } = z.object({ date: z.iso.date() }).parse(req.query);
      const appointment = await store.getAppointment(req.params.id);
      if (!appointment) return res.status(404).json({ error: 'Appointment not found.' });
      if (appointment.userId !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'This appointment belongs to another customer.' });
      if (!['requested', 'confirmed'].includes(appointment.status)) return res.status(409).json({ error: 'This appointment can no longer be changed.' });
      res.json(await slotData(appointment.serviceId, appointment.staffId, date, appointment.id));
    } catch (e) { next(e); }
  });
  app.post('/api/appointments', authenticate, async (req, res, next) => {
    try {
      const input = appointmentSchema.parse(req.body);
      const [services, staff] = await Promise.all([store.listServices(), store.listStaff()]);
      const service = services.find((s) => s.id === input.serviceId);
      const stylist = staff.find((s) => s.id === input.staffId);
      if (!service || !stylist || !stylist.specialties.includes(service.category)) return res.status(400).json({ error: 'Choose a valid service and specialist.' });
      const invalid = bookingError(input.startAt, service, stylist, { timeZone, leadMinutes });
      if (invalid) return res.status(400).json({ error: invalid });
      if (!demo && req.user.role !== 'admin' && input.customerEmail.toLowerCase() !== req.user.email.toLowerCase()) return res.status(403).json({ error: 'Use your signed-in account email for bookings.' });
      const bookingDate = localParts(input.startAt, timeZone).date;
      const cents = depositAmountCents(service.price, bookingDepositPercent);
      const saved = await store.createAppointment({ ...input, id: randomUUID(), userId: req.user.id, serviceName: service.name, staffName: stylist.name, durationMinutes: service.durationMinutes, price: service.price, timeZone, bookingDate, occupiedSlots: occupiedSlots(input.startAt, service.durationMinutes), status: 'requested', depositRequiredCents: cents, depositStatus: cents > 0 ? 'unpaid' : 'not-required', createdAt: new Date().toISOString() });
      await notifyBooking(saved, 'requested');
      res.status(201).json(saved);
    } catch (e) { next(e); }
  });
  app.patch('/api/appointments/:id', authenticate, async (req, res, next) => {
    try {
      const { startAt } = appointmentTimeSchema.parse(req.body);
      const appointment = await store.getAppointment(req.params.id);
      if (!appointment) return res.status(404).json({ error: 'Appointment not found.' });
      if (appointment.userId !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'This appointment belongs to another customer.' });
      if (!['requested', 'confirmed'].includes(appointment.status)) return res.status(409).json({ error: 'This appointment can no longer be rescheduled.' });
      const [services, staff] = await Promise.all([store.listServices(), store.listStaff()]);
      const service = services.find((s) => s.id === appointment.serviceId);
      const stylist = staff.find((s) => s.id === appointment.staffId);
      const invalid = bookingError(startAt, service, stylist, { timeZone, leadMinutes });
      if (invalid) return res.status(400).json({ error: invalid });
      const date = localParts(startAt, timeZone).date;
      const availability = await slotData(appointment.serviceId, appointment.staffId, date, appointment.id);
      if (!availability.slots.some((slot) => slot.startAt === startAt)) return res.status(409).json({ error: 'The chosen time is no longer available.' });
      const saved = await store.rescheduleAppointment(appointment.id, startAt, occupiedSlots(startAt, appointment.durationMinutes), date);
      if (!saved) return res.status(409).json({ error: 'This appointment can no longer be changed.' });
      await notifyBooking(saved, 'rescheduled');
      res.json(saved);
    } catch (e) { next(e); }
  });
  app.post('/api/appointments/:id/cancel', authenticate, async (req, res, next) => {
    try {
      const appointment = await store.getAppointment(req.params.id);
      if (!appointment) return res.status(404).json({ error: 'Appointment not found.' });
      if (appointment.userId !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'This appointment belongs to another customer.' });
      if (new Date(appointment.startAt).getTime() <= Date.now()) return res.status(409).json({ error: 'Past appointments cannot be cancelled online.' });
      const saved = await store.cancelAppointment(appointment.id);
      if (!saved) return res.status(409).json({ error: 'This appointment can no longer be cancelled.' });
      await notifyBooking(saved, 'cancelled');
      res.json(saved);
    } catch (e) { next(e); }
  });
  app.post('/api/appointments/:id/deposit-checkout', authenticate, async (req, res, next) => {
    try {
      if (!bookingDepositPercent || !stripe || !config.STRIPE_WEBHOOK_SECRET) return res.status(503).json({ error: 'Appointment deposits are not enabled.' });
      const appointment = await store.getAppointment(req.params.id);
      if (!appointment) return res.status(404).json({ error: 'Appointment not found.' });
      if (appointment.userId !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'This appointment belongs to another customer.' });
      if (!['requested', 'confirmed'].includes(appointment.status) || new Date(appointment.startAt).getTime() < Date.now()) return res.status(409).json({ error: 'This appointment can no longer accept a deposit.' });
      if (appointment.depositStatus === 'paid') return res.status(409).json({ error: 'The appointment deposit has already been paid.' });
      if (!Number.isSafeInteger(appointment.depositRequiredCents) || appointment.depositRequiredCents < 50) return res.status(409).json({ error: 'This appointment has no eligible deposit.' });
      const attempt = await store.beginDepositCheckout(appointment.id);
      if (attempt.state === 'reuse') return res.json({ url: attempt.url, reused: true });
      if (attempt.state !== 'acquired') return res.status(409).json({ error: 'A payment session is already being prepared. Try again shortly.' });
      try {
        const base = config.PUBLIC_WEB_URL || 'http://localhost:5173';
        const session = await stripe.checkout.sessions.create({ mode: 'payment', customer_email: appointment.customerEmail,
          line_items: [{ price_data: { currency: 'usd', product_data: { name: `${appointment.serviceName} appointment deposit` }, unit_amount: appointment.depositRequiredCents }, quantity: 1 }],
          success_url: `${base}/account?deposit=success`, cancel_url: `${base}/account?deposit=cancelled`,
          metadata: { paymentKind: 'appointment_deposit', appointmentId: appointment.id },
        }, { idempotencyKey: `salon-appointment-${appointment.id}-${attempt.token}` });
        const recorded = await store.finishDepositCheckout(appointment.id, attempt.token, session);
        if (!recorded) return res.status(409).json({ error: 'The appointment changed while checkout was being prepared. Please try again.' });
        res.status(201).json({ url: session.url });
      } catch (error) { await store.releaseDepositCheckout(appointment.id, attempt.token); throw error; }
    } catch (error) { next(error); }
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
  const catalogDefinitions = { products: productSchema, services: serviceSchema, staff: staffSchema };
  for (const [kind, schema] of Object.entries(catalogDefinitions)) {
    app.get(`/api/admin/${kind}`, authenticate, adminOnly, async (_req, res, next) => { try { res.json(await store[`list${kind[0].toUpperCase()}${kind.slice(1)}`](true)); } catch (e) { next(e); } });
    app.post(`/api/admin/${kind}`, authenticate, adminOnly, async (req, res, next) => {
      try {
        const input = (kind === 'products' ? productCreateSchema : schema).parse(req.body);
        const saved = await store.saveCatalogItem(kind, { ...input, id: randomUUID() });
        res.status(201).json(saved);
      } catch (e) { next(e); }
    });
    app.patch(`/api/admin/${kind}/:id`, authenticate, adminOnly, async (req, res, next) => {
      try {
        const input = schema.parse(req.body);
        if (kind === 'staff') {
          const activeBookings = await store.listStaffAppointments(req.params.id, new Date().toISOString(), new Date(Date.now() + 91 * 86400000).toISOString());
          const blocked = activeBookings.find((booking) => ['requested', 'confirmed'].includes(booking.status) && (!input.active || scheduleFitError(booking.startAt, booking.durationMinutes || 60, input, timeZone)));
          if (blocked) return res.status(409).json({ error: `This schedule change conflicts with an upcoming appointment for ${blocked.customerName}. Move or cancel the appointment first.` });
        }
        const saved = await store.saveCatalogItem(kind, input, req.params.id);
        if (!saved) return res.status(404).json({ error: 'Record not found.' });
        res.json(saved);
      } catch (e) { next(e); }
    });
  }
  app.get('/api/admin/inventory', authenticate, adminOnly, async (_req, res, next) => {
    try { const [products, movements] = await Promise.all([store.listProducts(true), store.listInventoryMovements()]); res.json({ products, movements }); } catch (e) { next(e); }
  });
  app.post('/api/admin/inventory/:id/adjust', authenticate, adminOnly, async (req, res, next) => {
    try {
      const { delta, reason } = z.object({ delta: z.number().int().min(-100000).max(100000).refine((n) => n !== 0), reason: z.string().trim().min(3).max(200) }).parse(req.body);
      const saved = await store.adjustInventory(req.params.id, delta, reason, req.user.id);
      if (!saved) return res.status(404).json({ error: 'Product not found.' });
      res.json(saved);
    } catch (e) { next(e); }
  });
  app.get('/api/admin/orders', authenticate, adminOnly, async (_req, res, next) => { try { res.json(await store.listOrders()); } catch (e) { next(e); } });
  app.patch('/api/admin/orders/:id/fulfillment', authenticate, adminOnly, async (req, res, next) => {
    try {
      const { fulfillmentStatus } = z.object({ fulfillmentStatus: z.enum(['unfulfilled', 'processing', 'fulfilled']) }).parse(req.body);
      const saved = await store.updateOrderFulfillment(req.params.id, fulfillmentStatus);
      if (!saved) return res.status(404).json({ error: 'Order not found.' });
      res.json(saved);
    } catch (e) { next(e); }
  });
  app.get('/api/admin/integrations', authenticate, adminOnly, (_req, res) => res.json({
    payments: Boolean(stripe && config.STRIPE_WEBHOOK_SECRET),
    appointmentDeposits: Boolean(bookingDepositPercent > 0 && stripe && config.STRIPE_WEBHOOK_SECRET),
    notifications: Boolean(config.RESEND_API_KEY && config.SALON_EMAIL_FROM),
    database: Boolean(config.MONGODB_URI),
    authentication: Boolean(config.APPWRITE_ENDPOINT && config.APPWRITE_PROJECT_ID),
    demo,
  }));
  app.get('/api/admin/notifications', authenticate, adminOnly, async (_req, res, next) => {
    try { res.json({ configured: Boolean(config.RESEND_API_KEY && config.SALON_EMAIL_FROM), counts: await store.notificationStats() }); }
    catch (error) { next(error); }
  });
  app.patch('/api/admin/appointments/:id', authenticate, adminOnly, async (req, res, next) => {
    try {
      const input = z.object({ status: z.enum(['requested', 'confirmed', 'completed', 'cancelled']) }).parse(req.body);
      const previous = await store.getAppointment(req.params.id);
      if (previous?.status === input.status) return res.json(previous);
      const result = await store.updateAppointment(req.params.id, input.status);
      if (!result) return res.status(404).json({ error: 'Appointment not found.' });
      if (input.status === 'completed') {
        try { await store.replaceAppointmentNotifications(result.id, []); }
        catch (error) { console.error('Unable to close appointment reminders:', error.message); }
      }
      else await notifyBooking(result, input.status);
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
      const orderedProducts = items.map(({ productId, quantity }) => {
        const product = catalog.find((p) => p.id === productId);
        return { productId, sku: product.sku || '', name: product.name, unitPrice: product.price, quantity };
      });
      const order = await store.createOrder({ id: randomUUID(), items: orderedProducts, totalAmount: orderedProducts.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0), currency: 'usd', status: 'pending', fulfillmentStatus: 'unfulfilled', customerEmail: null, createdAt: new Date().toISOString() });
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
