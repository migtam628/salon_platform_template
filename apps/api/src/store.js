import { MongoClient } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { products as seedProducts, services as seedServices, staff as seedStaff } from './seed.js';
import { overlaps, occupiedSlots } from './booking.js';

const clone = (value) => structuredClone(value);

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
    if (product.inventory + delta < 0) throw Object.assign(new Error('Stock cannot become negative.'), { status: 409 });
    product.inventory += delta;
    this.inventoryMovements.push({ id: randomUUID(), productId: id, productName: product.name, delta, reason, actorId, createdAt: new Date().toISOString() });
    return clone(product);
  }
  async listAppointments(userId) { return clone(userId ? this.appointments.filter((a) => a.userId === userId) : this.appointments); }
  async listStaffAppointments(staffId, from, to) { return clone(this.appointments.filter((a) => a.staffId === staffId && a.startAt >= from && a.startAt < to)); }
  async getAppointment(id) { return clone(this.appointments.find((a) => a.id === id) || null); }
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
  async createOrder(order) { this.orders.push(order); return clone(order); }
  async listOrders() { return clone(this.orders.slice().reverse()); }
  async updateOrderFulfillment(id, fulfillmentStatus) {
    const order = this.orders.find((o) => o.id === id);
    if (!order) return null;
    if (order.status !== 'paid') throw Object.assign(new Error('An unpaid order cannot be fulfilled.'), { status: 409 });
    order.fulfillmentStatus = fulfillmentStatus;
    order.updatedAt = new Date().toISOString();
    return clone(order);
  }
  async markOrderPaid(orderId, paymentIntent, email) { const order = this.orders.find((o) => o.id === orderId); if (order) { order.status = 'paid'; order.paymentIntent = paymentIntent; order.customerEmail = email || order.customerEmail || null; } return order; }
  async hasEvent(id) { return this.processedEvents.has(id); }
  async recordEvent(id) { this.processedEvents.add(id); }
  async dashboard() { return { appointments: this.appointments.length, orders: this.orders.length, products: this.products.filter((p) => p.active !== false).length, lowStock: this.products.filter((p) => p.active !== false && p.inventory <= (p.lowStockThreshold ?? 6)).length, messages: this.messages.length, recentAppointments: clone(this.appointments.slice(-6).reverse()), recentOrders: clone(this.orders.slice(-6).reverse()) }; }
}

export class MongoStore {
  constructor(client, db) { this.client = client; this.db = db; }
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
    const filter = { id, ...(delta < 0 ? { inventory: { $gte: -delta } } : {}) };
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
  async createOrder(order) { await this.db.collection('orders').insertOne(order); return order; }
  async listOrders() { return this.db.collection('orders').find({}, { projection: { _id: 0 } }).sort({ createdAt: -1 }).limit(100).toArray(); }
  async updateOrderFulfillment(id, fulfillmentStatus) {
    const order = await this.db.collection('orders').findOneAndUpdate({ id, status: 'paid' }, { $set: { fulfillmentStatus, updatedAt: new Date().toISOString() } }, { returnDocument: 'after', projection: { _id: 0 } });
    if (!order && await this.db.collection('orders').findOne({ id })) throw Object.assign(new Error('An unpaid order cannot be fulfilled.'), { status: 409 });
    return order;
  }
  async markOrderPaid(orderId, paymentIntent, email) { await this.db.collection('orders').updateOne({ id: orderId }, { $set: { status: 'paid', paymentIntent, customerEmail: email || null } }); }
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
