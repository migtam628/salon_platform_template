import { MongoClient } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { products as seedProducts, services as seedServices, staff as seedStaff } from './seed.js';
import { overlaps, occupiedSlots } from './booking.js';

const clone = (value) => structuredClone(value);
const conflict = (message) => Object.assign(new Error(message), { status: 409 });
const nowIso = () => new Date().toISOString();

function assertPaymentMatches(order, payment) {
  const validSession = order.checkoutSessionId ? order.checkoutSessionId === payment.sessionId : payment.clientReferenceId === order.id;
  if (!validSession || !payment.sessionId || order.totalCents !== payment.amountTotal || order.currency !== payment.currency || !payment.paymentIntent) {
    throw new Error('Stripe payment does not match the stored Checkout Session and order total.');
  }
}

function assertRefundMatches(order, refund) {
  if (!order.refundRequestedAt || !refund.id || refund.payment_intent !== order.paymentIntent || refund.amount !== order.totalCents || (refund.metadata?.orderId && refund.metadata.orderId !== order.id)) {
    throw new Error('Stripe refund does not match an authorized full-order refund request.');
  }
  if (order.refund?.id && order.refund.id !== refund.id) throw new Error('A different refund is already linked to this order.');
}

export class MemoryStore {
  constructor() {
    this.products = clone(seedProducts);
    this.services = clone(seedServices);
    this.staff = clone(seedStaff);
    this.appointments = [];
    this.messages = [];
    this.orders = [];
    this.inventoryMovements = [];
    this.notifications = [];
    this.processedEvents = new Set();
  }
  async ping() { return true; }
  async listProducts(includeInactive = false) { return clone(includeInactive ? this.products : this.products.filter((p) => p.active !== false)); }
  async listServices(includeInactive = false) { return clone(includeInactive ? this.services : this.services.filter((s) => s.active !== false)); }
  async listStaff(includeInactive = false) { return clone(includeInactive ? this.staff : this.staff.filter((s) => s.active !== false)); }
  async saveCatalogItem(kind, value, id) {
    const list = this[kind];
    const index = id ? list.findIndex((item) => item.id === id) : -1;
    if (id && index < 0) return null;
    if (kind === 'products' && list.some((item) => item.sku === value.sku && item.id !== id)) throw Object.assign(new Error('This SKU is already in use.'), { status: 409 });
    const item = { ...(index >= 0 ? list[index] : {}), ...value, id: id || value.id };
    if (index >= 0) list[index] = item; else list.push(item);
    return clone(item);
  }
  async listInventoryMovements() { return clone(this.inventoryMovements.slice(-30).reverse()); }
  async adjustInventory(id, delta, reason, actorId) {
    const product = this.products.find((p) => p.id === id);
    if (!product) return null;
    if (product.inventory + delta < (product.reserved || 0)) throw conflict('Stock cannot fall below units reserved for checkout.');
    product.inventory += delta;
    this.inventoryMovements.push({ id: randomUUID(), productId: id, productName: product.name, delta, reason, actorId, createdAt: new Date().toISOString() });
    return clone(product);
  }
  async listAppointments(userId) { return clone(userId ? this.appointments.filter((a) => a.userId === userId) : this.appointments); }
  async listStaffAppointments(staffId, from, to) { return clone(this.appointments.filter((a) => a.staffId === staffId && a.startAt >= from && a.startAt < to)); }
  async getAppointment(id) { return clone(this.appointments.find((a) => a.id === id) || null); }
  async beginDepositCheckout(id) {
    const item = this.appointments.find((a) => a.id === id);
    if (!item || !['requested', 'confirmed'].includes(item.status) || item.depositStatus !== 'unpaid') return { state: 'unavailable' };
    const now = Date.now();
    if (item.depositCheckoutUrl && Date.parse(item.depositCheckoutExpiresAt) > now + 60_000) return { state: 'reuse', url: item.depositCheckoutUrl };
    if (Date.parse(item.depositCheckoutLockUntil || 0) > now) return { state: 'locked' };
    const token = item.depositCheckoutSessionId ? randomUUID() : item.depositCheckoutToken || randomUUID();
    Object.assign(item, { depositCheckoutToken: token, depositCheckoutLockUntil: new Date(now + 120_000).toISOString() });
    return { state: 'acquired', token };
  }
  async finishDepositCheckout(id, token, session) {
    const item = this.appointments.find((a) => a.id === id && a.depositCheckoutToken === token && a.depositStatus === 'unpaid');
    if (!item) return false;
    Object.assign(item, { depositCheckoutSessionId: session.id, depositCheckoutUrl: session.url, depositCheckoutExpiresAt: new Date(session.expires_at * 1000).toISOString() });
    delete item.depositCheckoutLockUntil;
    return true;
  }
  async releaseDepositCheckout(id, token) {
    const item = this.appointments.find((a) => a.id === id && a.depositCheckoutToken === token);
    if (item) delete item.depositCheckoutLockUntil;
  }
  async markAppointmentDepositPaid(id, paymentIntent, amountCents) {
    const item = this.appointments.find((a) => a.id === id);
    if (!item || item.depositRequiredCents !== amountCents) throw new Error('Appointment deposit payment does not match the recorded amount.');
    if (item.depositStatus !== 'paid') Object.assign(item, { depositStatus: 'paid', depositPaymentIntent: paymentIntent, depositPaidAt: new Date().toISOString() });
    return clone(item);
  }
  async updateAppointment(id, status) {
    const item = this.appointments.find((a) => a.id === id);
    if (!item) return null;
    if (this.appointments.some((a) => a.id !== id && overlaps(a, { ...item, status }))) throw Object.assign(new Error('This appointment would overlap another booking.'), { status: 409 });
    item.status = status; item.updatedAt = new Date().toISOString(); return clone(item);
  }
  async createAppointment(appointment) {
    if (this.appointments.some((a) => overlaps(a, appointment))) throw Object.assign(new Error('This time slot was just taken.'), { status: 409 });
    this.appointments.push(appointment); return clone(appointment);
  }
  async rescheduleAppointment(id, startAt, slots, bookingDate) {
    const appointment = this.appointments.find((a) => a.id === id && ['requested', 'confirmed'].includes(a.status));
    if (!appointment) return null;
    const proposed = { ...appointment, startAt, bookingDate, occupiedSlots: slots, status: 'requested' };
    if (this.appointments.some((a) => a.id !== id && overlaps(a, proposed))) throw Object.assign(new Error('This time slot was just taken.'), { status: 409 });
    Object.assign(appointment, proposed, { updatedAt: new Date().toISOString() });
    return clone(appointment);
  }
  async cancelAppointment(id) {
    const appointment = this.appointments.find((a) => a.id === id && ['requested', 'confirmed'].includes(a.status));
    if (!appointment) return null;
    appointment.status = 'cancelled'; appointment.updatedAt = new Date().toISOString(); return clone(appointment);
  }
  async replaceAppointmentNotifications(appointmentId, jobs) {
    this.notifications = this.notifications.map((job) => job.appointmentId === appointmentId && job.status === 'pending' ? { ...job, status: 'superseded' } : job);
    this.notifications.push(...clone(jobs));
  }
  async claimDueNotification(now) {
    const job = this.notifications.find((item) => item.status === 'pending' && item.sendAt <= now);
    if (!job) return null;
    job.status = 'sending'; job.claimedAt = now;
    return clone(job);
  }
  async finishNotification(id, status, providerId = '', error = '', sendAt) {
    const job = this.notifications.find((item) => item.id === id);
    if (job) Object.assign(job, { status, providerId, error, ...(sendAt ? { sendAt, attempts: job.attempts + 1 } : {}) });
  }
  async notificationStats() {
    return this.notifications.reduce((stats, item) => { stats[item.status] = (stats[item.status] || 0) + 1; return stats; }, {});
  }
  async listMessages(conversationId) { return clone(this.messages.filter((m) => m.conversationId === conversationId).slice(-100)); }
  async listConversations() { const ids = [...new Set(this.messages.map((m) => m.conversationId))]; return ids.map((id) => { const messages = this.messages.filter((m) => m.conversationId === id); return { id, lastMessage: messages.at(-1), count: messages.length }; }); }
  async saveMessage(message) { this.messages.push(message); return clone(message); }
  async createOrder(order) {
    for (const item of order.items || []) {
      const product = this.products.find((row) => row.id === item.productId && row.active !== false);
      if (!product || product.inventory - (product.reserved || 0) < item.quantity) throw conflict('Product unavailable or insufficient unreserved stock.');
    }
    for (const item of order.items || []) {
      const product = this.products.find((p) => p.id === item.productId);
      product.reserved = (product.reserved || 0) + item.quantity;
    }
    this.orders.push({ ...order, stockState: 'reserved' });
    return clone(this.orders.at(-1));
  }
  async getOrder(id) { return clone(this.orders.find((o) => o.id === id) || null); }
  async listOrders(userId) { return clone(this.orders.filter((o) => !userId || o.userId === userId).slice().reverse()); }
  async setOrderCheckoutSession(id, session) {
    const order = this.orders.find((o) => o.id === id && o.status === 'pending' && o.stockState === 'reserved');
    if (!order) throw conflict('Order reservation is no longer available.');
    order.checkoutSessionId = session.id;
    order.checkoutExpiresAt = new Date(session.expires_at * 1000).toISOString();
  }
  async releaseOrderReservation(id, expectedSessionId) {
    const order = this.orders.find((o) => o.id === id);
    if (!order || order.status !== 'pending' || order.stockState !== 'reserved') return false;
    if (expectedSessionId && order.checkoutSessionId !== expectedSessionId) throw new Error('Checkout Session does not match order reservation.');
    for (const item of order.items) this.products.find((p) => p.id === item.productId).reserved -= item.quantity;
    Object.assign(order, { status: 'expired', stockState: 'released', updatedAt: nowIso() });
    return true;
  }
  async releaseExpiredOrders(at = nowIso()) {
    const expired = this.orders.filter((o) => o.status === 'pending' && o.stockState === 'reserved' && o.reservationExpiresAt <= at);
    for (const order of expired) await this.releaseOrderReservation(order.id);
    return expired.length;
  }
  async updateOrderFulfillment(id, fulfillmentStatus) {
    const order = this.orders.find((o) => o.id === id);
    if (!order) return null;
    if (order.status !== 'paid') throw Object.assign(new Error('An unpaid order cannot be fulfilled.'), { status: 409 });
    order.fulfillmentStatus = fulfillmentStatus;
    order.updatedAt = new Date().toISOString();
    return clone(order);
  }
  async markOrderPaid(orderId, paymentIntent, email, payment) {
    const order = this.orders.find((o) => o.id === orderId);
    if (!order) throw new Error('Paid Stripe order was not found.');
    assertPaymentMatches(order, { ...payment, paymentIntent });
    if (['paid', 'refunded'].includes(order.status)) {
      if (order.paymentIntent !== paymentIntent) throw new Error('Order was paid with a different payment intent.');
      return clone(order);
    }
    if (order.stockState !== 'reserved') {
      Object.assign(order, { status: 'paid_stock_review', checkoutSessionId: payment.sessionId, paymentIntent, customerEmail: email || order.customerEmail, updatedAt: nowIso() });
      return clone(order);
    }
    for (const item of order.items) {
      const product = this.products.find((p) => p.id === item.productId);
      if (!product || (product.reserved || 0) < item.quantity || product.inventory < item.quantity) throw new Error('Reserved inventory is inconsistent.');
    }
    for (const item of order.items) {
      const product = this.products.find((p) => p.id === item.productId);
      product.inventory -= item.quantity;
      product.reserved -= item.quantity;
      this.inventoryMovements.push({ id: randomUUID(), productId: item.productId, productName: item.name, delta: -item.quantity, reason: `Stripe order ${order.id}`, actorId: 'stripe', createdAt: nowIso() });
    }
    Object.assign(order, { status: 'paid', stockState: 'consumed', checkoutSessionId: payment.sessionId, paymentIntent, customerEmail: email || order.customerEmail, paidAt: nowIso(), updatedAt: nowIso() });
    return clone(order);
  }
  async beginOrderRefund(id, restock, actorId) {
    const order = this.orders.find((o) => o.id === id);
    if (!order) return null;
    if (!['paid', 'paid_stock_review'].includes(order.status) || !order.paymentIntent || order.refund?.status === 'succeeded') throw conflict('Only settled, non-refunded orders can be refunded.');
    if (['failed', 'canceled'].includes(order.refund?.status)) throw conflict('This refund needs reconciliation in Stripe before retrying.');
    if (order.status === 'paid_stock_review' && restock) throw conflict('An order without settled stock cannot be restocked by a refund.');
    if (order.refundRequestedAt && order.refundRestock !== restock) throw conflict('The existing refund request has a different restock decision.');
    if (!order.refundRequestedAt) Object.assign(order, { refundRequestedAt: nowIso(), refundRestock: restock, refundRequestedBy: actorId });
    return clone(order);
  }
  async applyOrderRefund(id, refund) {
    const order = this.orders.find((o) => o.id === id);
    if (!order) throw new Error('Refund order was not found.');
    assertRefundMatches(order, refund);
    if (order.refund?.status === 'succeeded') return clone(order);
    if (refund.status === 'succeeded' && order.refundRestock && !order.refundRestockedAt) {
      for (const item of order.items || []) {
        const product = this.products.find((p) => p.id === item.productId);
        if (!product) throw new Error('Cannot restock a deleted product.');
        product.inventory += item.quantity;
        this.inventoryMovements.push({ id: randomUUID(), productId: item.productId, productName: item.name, delta: item.quantity, reason: `Refund return ${order.id}`, actorId: order.refundRequestedBy, createdAt: nowIso() });
      }
      order.refundRestockedAt = nowIso();
    }
    order.refund = { id: refund.id, status: refund.status, updatedAt: nowIso() };
    if (refund.status === 'succeeded') order.status = 'refunded';
    order.updatedAt = nowIso();
    return clone(order);
  }
  async hasEvent(id) { return this.processedEvents.has(id); }
  async recordEvent(id) { this.processedEvents.add(id); }
  async dashboard() { return { appointments: this.appointments.length, orders: this.orders.length, products: this.products.filter((p) => p.active !== false).length, lowStock: this.products.filter((p) => p.active !== false && p.inventory <= (p.lowStockThreshold ?? 6)).length, messages: this.messages.length, recentAppointments: clone(this.appointments.slice(-6).reverse()), recentOrders: clone(this.orders.slice(-6).reverse()) }; }
}

export class MongoStore {
  constructor(client, db) { this.client = client; this.db = db; }
  async ping() { await this.db.command({ ping: 1 }); return true; }
  async close() { await this.client.close(); }
  static async connect(uri, name) {
    const client = new MongoClient(uri);
    await client.connect();
    const db = client.db(name);
    // Upgrade Phase 1/2 appointments before enforcing atomic, duration-aware multikey uniqueness.
    for await (const existing of db.collection('appointments').find({ occupiedSlots: { $exists: false } }, { projection: { _id: 1, startAt: 1, durationMinutes: 1 } })) {
      const slots = occupiedSlots(existing.startAt, existing.durationMinutes || 60);
      if (!slots.length) throw new Error('An existing appointment has an unsupported start or duration; resolve it before migrating booking indexes.');
      await db.collection('appointments').updateOne({ _id: existing._id }, { $set: { occupiedSlots: slots } });
    }
    await Promise.all([
      db.collection('appointments').createIndex({ staffId: 1, startAt: 1 }, { unique: true, partialFilterExpression: { status: { $in: ['requested', 'confirmed'] } } }),
      db.collection('appointments').createIndex({ staffId: 1, occupiedSlots: 1 }, { name: 'unique_booked_quarters', unique: true, partialFilterExpression: { status: { $in: ['requested', 'confirmed'] } } }),
      db.collection('messages').createIndex({ conversationId: 1, createdAt: -1 }),
      db.collection('orders').createIndex({ id: 1 }, { unique: true }),
      db.collection('orders').createIndex({ userId: 1, createdAt: -1 }),
      db.collection('orders').createIndex({ status: 1, reservationExpiresAt: 1 }),
      db.collection('stripe_events').createIndex({ id: 1 }, { unique: true }),
      db.collection('products').createIndex({ sku: 1 }, { unique: true, partialFilterExpression: { sku: { $type: 'string' } } }),
      db.collection('inventory_movements').createIndex({ createdAt: -1 }),
      db.collection('notifications').createIndex({ status: 1, sendAt: 1 }),
      db.collection('notifications').createIndex({ id: 1 }, { unique: true })
    ]);
    await Promise.all([
      seedCollection(db, 'products', seedProducts),
      seedCollection(db, 'services', seedServices),
      seedCollection(db, 'staff', seedStaff)
    ]);
    return new MongoStore(client, db);
  }
  async listProducts(includeInactive = false) { return this.db.collection('products').find(includeInactive ? {} : { active: { $ne: false } }, { projection: { _id: 0 } }).toArray(); }
  async listServices(includeInactive = false) { return this.db.collection('services').find(includeInactive ? {} : { active: { $ne: false } }, { projection: { _id: 0 } }).toArray(); }
  async listStaff(includeInactive = false) { return this.db.collection('staff').find(includeInactive ? {} : { active: { $ne: false } }, { projection: { _id: 0 } }).toArray(); }
  async saveCatalogItem(kind, value, id) {
    if (!['products', 'services', 'staff'].includes(kind)) throw new Error('Unsupported catalog.');
    const collection = this.db.collection(kind);
    if (id) return collection.findOneAndUpdate({ id }, { $set: value }, { returnDocument: 'after', projection: { _id: 0 } });
    try { await collection.insertOne(value); return value; }
    catch (e) { if (e.code === 11000) throw Object.assign(new Error('This SKU is already in use.'), { status: 409 }); throw e; }
  }
  async listInventoryMovements() { return this.db.collection('inventory_movements').find({}, { projection: { _id: 0 } }).sort({ createdAt: -1 }).limit(30).toArray(); }
  async adjustInventory(id, delta, reason, actorId) {
    const filter = { id, ...(delta < 0 ? { $expr: { $gte: [{ $add: ['$inventory', delta] }, { $ifNull: ['$reserved', 0] }] } } : {}) };
    const product = await this.db.collection('products').findOneAndUpdate(filter, { $inc: { inventory: delta } }, { returnDocument: 'after', projection: { _id: 0 } });
    if (!product) {
      if (await this.db.collection('products').findOne({ id })) throw Object.assign(new Error('Stock cannot become negative.'), { status: 409 });
      return null;
    }
    await this.db.collection('inventory_movements').insertOne({ id: randomUUID(), productId: id, productName: product.name, delta, reason, actorId, createdAt: new Date().toISOString() });
    return product;
  }
  async listAppointments(userId) { return this.db.collection('appointments').find(userId ? { userId } : {}, { projection: { _id: 0 } }).sort({ startAt: 1 }).toArray(); }
  async listStaffAppointments(staffId, from, to) { return this.db.collection('appointments').find({ staffId, startAt: { $gte: from, $lt: to } }, { projection: { _id: 0 } }).toArray(); }
  async getAppointment(id) { return this.db.collection('appointments').findOne({ id }, { projection: { _id: 0 } }); }
  async beginDepositCheckout(id) {
    const collection = this.db.collection('appointments');
    const item = await this.getAppointment(id);
    if (!item || !['requested', 'confirmed'].includes(item.status) || item.depositStatus !== 'unpaid') return { state: 'unavailable' };
    const now = Date.now();
    if (item.depositCheckoutUrl && Date.parse(item.depositCheckoutExpiresAt) > now + 60_000) return { state: 'reuse', url: item.depositCheckoutUrl };
    if (Date.parse(item.depositCheckoutLockUntil || 0) > now) return { state: 'locked' };
    const token = item.depositCheckoutSessionId ? randomUUID() : item.depositCheckoutToken || randomUUID();
    const sessionFilter = item.depositCheckoutSessionId ? { depositCheckoutSessionId: item.depositCheckoutSessionId } : { depositCheckoutSessionId: { $exists: false } };
    const updated = await collection.findOneAndUpdate({ id, status: { $in: ['requested', 'confirmed'] }, depositStatus: 'unpaid', ...sessionFilter,
      $or: [{ depositCheckoutLockUntil: { $exists: false } }, { depositCheckoutLockUntil: { $lt: new Date(now).toISOString() } }] },
    { $set: { depositCheckoutToken: token, depositCheckoutLockUntil: new Date(now + 120_000).toISOString() } }, { returnDocument: 'after' });
    if (updated) return { state: 'acquired', token };
    const latest = await this.getAppointment(id);
    if (latest?.depositCheckoutUrl && Date.parse(latest.depositCheckoutExpiresAt) > now + 60_000) return { state: 'reuse', url: latest.depositCheckoutUrl };
    return { state: 'locked' };
  }
  async finishDepositCheckout(id, token, session) {
    const result = await this.db.collection('appointments').updateOne({ id, depositCheckoutToken: token, depositStatus: 'unpaid' }, {
      $set: { depositCheckoutSessionId: session.id, depositCheckoutUrl: session.url, depositCheckoutExpiresAt: new Date(session.expires_at * 1000).toISOString() },
      $unset: { depositCheckoutLockUntil: '' },
    });
    return result.matchedCount > 0;
  }
  async releaseDepositCheckout(id, token) { await this.db.collection('appointments').updateOne({ id, depositCheckoutToken: token }, { $unset: { depositCheckoutLockUntil: '' } }); }
  async markAppointmentDepositPaid(id, paymentIntent, amountCents) {
    const item = await this.getAppointment(id);
    if (!item || item.depositRequiredCents !== amountCents) throw new Error('Appointment deposit payment does not match the recorded amount.');
    await this.db.collection('appointments').updateOne({ id, depositStatus: 'unpaid' }, { $set: { depositStatus: 'paid', depositPaymentIntent: paymentIntent, depositPaidAt: new Date().toISOString() } });
    return this.getAppointment(id);
  }
  async updateAppointment(id, status) {
    try { return await this.db.collection('appointments').findOneAndUpdate({ id }, { $set: { status, updatedAt: new Date().toISOString() } }, { returnDocument: 'after', projection: { _id: 0 } }); }
    catch (error) { if (error.code === 11000) throw Object.assign(new Error('This appointment would overlap another booking.'), { status: 409 }); throw error; }
  }
  async createAppointment(appointment) {
    try { await this.db.collection('appointments').insertOne(appointment); return appointment; }
    catch (error) { if (error.code === 11000) throw Object.assign(new Error('This time slot was just taken.'), { status: 409 }); throw error; }
  }
  async rescheduleAppointment(id, startAt, slots, bookingDate) {
    try { return await this.db.collection('appointments').findOneAndUpdate({ id, status: { $in: ['requested', 'confirmed'] } }, { $set: { startAt, bookingDate, occupiedSlots: slots, status: 'requested', updatedAt: new Date().toISOString() } }, { returnDocument: 'after', projection: { _id: 0 } }); }
    catch (error) { if (error.code === 11000) throw Object.assign(new Error('This time slot was just taken.'), { status: 409 }); throw error; }
  }
  async cancelAppointment(id) { return this.db.collection('appointments').findOneAndUpdate({ id, status: { $in: ['requested', 'confirmed'] } }, { $set: { status: 'cancelled', updatedAt: new Date().toISOString() } }, { returnDocument: 'after', projection: { _id: 0 } }); }
  async replaceAppointmentNotifications(appointmentId, jobs) {
    await this.db.collection('notifications').updateMany({ appointmentId, status: 'pending' }, { $set: { status: 'superseded' } });
    if (jobs.length) await this.db.collection('notifications').insertMany(jobs);
  }
  async claimDueNotification(now) {
    return this.db.collection('notifications').findOneAndUpdate({ $or: [
      { status: 'pending', sendAt: { $lte: now } },
      { status: 'sending', claimedAt: { $lte: new Date(Date.parse(now) - 5 * 60_000).toISOString() } },
    ] }, { $set: { status: 'sending', claimedAt: now } }, { sort: { sendAt: 1 }, returnDocument: 'after', projection: { _id: 0 } });
  }
  async finishNotification(id, status, providerId = '', error = '', sendAt) {
    await this.db.collection('notifications').updateOne({ id }, { $set: { status, providerId, error, ...(sendAt ? { sendAt } : {}) }, ...(sendAt ? { $inc: { attempts: 1 } } : {}) });
  }
  async notificationStats() {
    const rows = await this.db.collection('notifications').aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]).toArray();
    return Object.fromEntries(rows.map((row) => [row._id, row.count]));
  }
  async listMessages(conversationId) { return (await this.db.collection('messages').find({ conversationId }, { projection: { _id: 0 } }).sort({ createdAt: -1 }).limit(100).toArray()).reverse(); }
  async listConversations() { return this.db.collection('messages').aggregate([{ $sort: { createdAt: -1 } }, { $group: { _id: '$conversationId', lastMessage: { $first: '$$ROOT' }, count: { $sum: 1 } } }, { $project: { _id: 0, id: '$_id', lastMessage: { id: '$lastMessage.id', text: '$lastMessage.text', createdAt: '$lastMessage.createdAt', senderRole: '$lastMessage.senderRole' }, count: 1 } }, { $sort: { 'lastMessage.createdAt': -1 } }]).toArray(); }
  async saveMessage(message) { await this.db.collection('messages').insertOne(message); return message; }
  async transaction(work) {
    const session = this.client.startSession();
    try { return await session.withTransaction(() => work(session)); }
    finally { await session.endSession(); }
  }
  async createOrder(order) {
    return this.transaction(async (session) => {
      for (const item of order.items) {
        const product = await this.db.collection('products').findOneAndUpdate({ id: item.productId, active: { $ne: false },
          $expr: { $gte: [{ $subtract: ['$inventory', { $ifNull: ['$reserved', 0] }] }, item.quantity] } },
        { $inc: { reserved: item.quantity } }, { session, returnDocument: 'after' });
        if (!product) throw conflict('Product unavailable or insufficient unreserved stock.');
      }
      await this.db.collection('orders').insertOne({ ...order, stockState: 'reserved' }, { session });
      return { ...order, stockState: 'reserved' };
    });
  }
  async getOrder(id) { return this.db.collection('orders').findOne({ id }, { projection: { _id: 0 } }); }
  async listOrders(userId) { return this.db.collection('orders').find(userId ? { userId } : {}, { projection: { _id: 0 } }).sort({ createdAt: -1 }).limit(100).toArray(); }
  async setOrderCheckoutSession(id, checkout) {
    const result = await this.db.collection('orders').updateOne({ id, status: 'pending', stockState: 'reserved' },
      { $set: { checkoutSessionId: checkout.id, checkoutExpiresAt: new Date(checkout.expires_at * 1000).toISOString() } });
    if (!result.matchedCount) throw conflict('Order reservation is no longer available.');
  }
  async releaseOrderReservation(id, expectedSessionId) {
    return this.transaction(async (session) => {
      const order = await this.db.collection('orders').findOne({ id }, { session });
      if (!order || order.status !== 'pending' || order.stockState !== 'reserved') return false;
      if (expectedSessionId && order.checkoutSessionId !== expectedSessionId) throw new Error('Checkout Session does not match order reservation.');
      for (const item of order.items) {
        const product = await this.db.collection('products').updateOne({ id: item.productId, reserved: { $gte: item.quantity } }, { $inc: { reserved: -item.quantity } }, { session });
        if (!product.matchedCount) throw new Error('Reserved stock could not be safely released.');
      }
      await this.db.collection('orders').updateOne({ id }, { $set: { status: 'expired', stockState: 'released', updatedAt: nowIso() } }, { session });
      return true;
    });
  }
  async releaseExpiredOrders(at = nowIso()) {
    const rows = await this.db.collection('orders').find({ status: 'pending', stockState: 'reserved', reservationExpiresAt: { $lte: at } }, { projection: { id: 1 } }).limit(100).toArray();
    let count = 0;
    for (const row of rows) if (await this.releaseOrderReservation(row.id)) count++;
    return count;
  }
  async updateOrderFulfillment(id, fulfillmentStatus) {
    const order = await this.db.collection('orders').findOneAndUpdate({ id, status: 'paid' }, { $set: { fulfillmentStatus, updatedAt: new Date().toISOString() } }, { returnDocument: 'after', projection: { _id: 0 } });
    if (!order && await this.db.collection('orders').findOne({ id })) throw Object.assign(new Error('An unpaid order cannot be fulfilled.'), { status: 409 });
    return order;
  }
  async markOrderPaid(orderId, paymentIntent, email, payment) {
    return this.transaction(async (session) => {
      const orders = this.db.collection('orders');
      const order = await orders.findOne({ id: orderId }, { session });
      if (!order) throw new Error('Paid Stripe order was not found.');
      assertPaymentMatches(order, { ...payment, paymentIntent });
      if (['paid', 'refunded'].includes(order.status)) {
        if (order.paymentIntent !== paymentIntent) throw new Error('Order was paid with a different payment intent.');
        return order;
      }
      if (order.stockState !== 'reserved') {
        await orders.updateOne({ id: orderId }, { $set: { status: 'paid_stock_review', checkoutSessionId: payment.sessionId, paymentIntent, customerEmail: email || order.customerEmail, updatedAt: nowIso() } }, { session });
        return { ...order, status: 'paid_stock_review' };
      }
      for (const item of order.items) {
        const result = await this.db.collection('products').updateOne({ id: item.productId, reserved: { $gte: item.quantity }, inventory: { $gte: item.quantity } },
          { $inc: { reserved: -item.quantity, inventory: -item.quantity } }, { session });
        if (!result.matchedCount) throw new Error('Reserved inventory is inconsistent.');
        await this.db.collection('inventory_movements').insertOne({ id: randomUUID(), productId: item.productId, productName: item.name,
          delta: -item.quantity, reason: `Stripe order ${order.id}`, actorId: 'stripe', createdAt: nowIso() }, { session });
      }
      await orders.updateOne({ id: orderId }, { $set: { status: 'paid', stockState: 'consumed', checkoutSessionId: payment.sessionId, paymentIntent, customerEmail: email || order.customerEmail, paidAt: nowIso(), updatedAt: nowIso() } }, { session });
      return { ...order, status: 'paid' };
    });
  }
  async beginOrderRefund(id, restock, actorId) {
    return this.transaction(async (session) => {
      const orders = this.db.collection('orders');
      const order = await orders.findOne({ id }, { session });
      if (!order) return null;
      if (!['paid', 'paid_stock_review'].includes(order.status) || !order.paymentIntent || order.refund?.status === 'succeeded') throw conflict('Only settled, non-refunded orders can be refunded.');
      if (['failed', 'canceled'].includes(order.refund?.status)) throw conflict('This refund needs reconciliation in Stripe before retrying.');
      if (order.status === 'paid_stock_review' && restock) throw conflict('An order without settled stock cannot be restocked by a refund.');
      if (order.refundRequestedAt && order.refundRestock !== restock) throw conflict('The existing refund request has a different restock decision.');
      if (!order.refundRequestedAt) {
        const fields = { refundRequestedAt: nowIso(), refundRestock: restock, refundRequestedBy: actorId };
        await orders.updateOne({ id }, { $set: fields }, { session });
        return { ...order, ...fields };
      }
      return order;
    });
  }
  async applyOrderRefund(id, refund) {
    return this.transaction(async (session) => {
      const orders = this.db.collection('orders');
      const order = await orders.findOne({ id }, { session });
      if (!order) throw new Error('Refund order was not found.');
      assertRefundMatches(order, refund);
      if (order.refund?.status === 'succeeded') return order;
      const fields = { refund: { id: refund.id, status: refund.status, updatedAt: nowIso() }, updatedAt: nowIso() };
      if (refund.status === 'succeeded') {
        fields.status = 'refunded';
        if (order.refundRestock && !order.refundRestockedAt) {
          for (const item of order.items) {
            const result = await this.db.collection('products').updateOne({ id: item.productId }, { $inc: { inventory: item.quantity } }, { session });
            if (!result.matchedCount) throw new Error('Cannot restock a deleted product.');
            await this.db.collection('inventory_movements').insertOne({ id: randomUUID(), productId: item.productId, productName: item.name,
              delta: item.quantity, reason: `Refund return ${order.id}`, actorId: order.refundRequestedBy, createdAt: nowIso() }, { session });
          }
          fields.refundRestockedAt = nowIso();
        }
      }
      await orders.updateOne({ id }, { $set: fields }, { session });
      return { ...order, ...fields };
    });
  }
  async hasEvent(id) { return Boolean(await this.db.collection('stripe_events').findOne({ id })); }
  async recordEvent(id) { await this.db.collection('stripe_events').updateOne({ id }, { $setOnInsert: { id, processedAt: new Date().toISOString() } }, { upsert: true }); }
  async dashboard() {
    const [appointments, orders, products, messages, recentAppointments, recentOrders] = await Promise.all([
      this.db.collection('appointments').countDocuments(), this.db.collection('orders').countDocuments(), this.db.collection('products').countDocuments({ active: { $ne: false } }), this.db.collection('messages').countDocuments(),
      this.db.collection('appointments').find({}, { projection: { _id: 0 } }).sort({ createdAt: -1 }).limit(6).toArray(),
      this.db.collection('orders').find({}, { projection: { _id: 0 } }).sort({ createdAt: -1 }).limit(6).toArray()
    ]);
    const lowStock = await this.db.collection('products').countDocuments({ active: { $ne: false }, $expr: { $lte: ['$inventory', { $ifNull: ['$lowStockThreshold', 6] }] } });
    return { appointments, orders, products, lowStock, messages, recentAppointments, recentOrders };
  }
}

async function seedCollection(db, name, values) {
  const count = await db.collection(name).countDocuments();
  if (count === 0) await db.collection(name).insertMany(clone(values));
}
