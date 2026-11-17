import { MongoClient } from 'mongodb';
import { products as seedProducts, services as seedServices, staff as seedStaff } from './seed.js';

const clone = (value) => structuredClone(value);

export class MemoryStore {
  constructor() {
    this.products = clone(seedProducts);
    this.services = clone(seedServices);
    this.staff = clone(seedStaff);
    this.appointments = [];
    this.messages = [];
    this.orders = [];
    this.processedEvents = new Set();
  }
  async listProducts() { return clone(this.products); }
  async listServices() { return clone(this.services); }
  async listStaff() { return clone(this.staff); }
  async listAppointments(userId) { return clone(userId ? this.appointments.filter((a) => a.userId === userId) : this.appointments); }
  async updateAppointment(id, status) { const item = this.appointments.find((a) => a.id === id); if (!item) return null; item.status = status; return clone(item); }
  async createAppointment(appointment) {
    if (this.appointments.some((a) => a.staffId === appointment.staffId && a.startAt === appointment.startAt && a.status !== 'cancelled')) throw Object.assign(new Error('This time slot was just taken.'), { status: 409 });
    this.appointments.push(appointment); return clone(appointment);
  }
  async listMessages(conversationId) { return clone(this.messages.filter((m) => m.conversationId === conversationId).slice(-100)); }
  async listConversations() { const ids = [...new Set(this.messages.map((m) => m.conversationId))]; return ids.map((id) => { const messages = this.messages.filter((m) => m.conversationId === id); return { id, lastMessage: messages.at(-1), count: messages.length }; }); }
  async saveMessage(message) { this.messages.push(message); return clone(message); }
  async createOrder(order) { this.orders.push(order); return clone(order); }
  async markOrderPaid(orderId, paymentIntent) { const order = this.orders.find((o) => o.id === orderId); if (order) { order.status = 'paid'; order.paymentIntent = paymentIntent; } return order; }
  async hasEvent(id) { return this.processedEvents.has(id); }
  async recordEvent(id) { this.processedEvents.add(id); }
  async dashboard() { return { appointments: this.appointments.length, orders: this.orders.length, products: this.products.length, messages: this.messages.length, recentAppointments: clone(this.appointments.slice(-6).reverse()), recentOrders: clone(this.orders.slice(-6).reverse()) }; }
}

export class MongoStore {
  constructor(client, db) { this.client = client; this.db = db; }
  static async connect(uri, name) {
    const client = new MongoClient(uri);
    await client.connect();
    const db = client.db(name);
    await Promise.all([
      db.collection('appointments').createIndex({ staffId: 1, startAt: 1 }, { unique: true, partialFilterExpression: { status: { $in: ['requested', 'confirmed'] } } }),
      db.collection('messages').createIndex({ conversationId: 1, createdAt: -1 }),
      db.collection('orders').createIndex({ id: 1 }, { unique: true }),
      db.collection('stripe_events').createIndex({ id: 1 }, { unique: true })
    ]);
    await Promise.all([
      seedCollection(db, 'products', seedProducts),
      seedCollection(db, 'services', seedServices),
      seedCollection(db, 'staff', seedStaff)
    ]);
    return new MongoStore(client, db);
  }
  async listProducts() { return this.db.collection('products').find({}, { projection: { _id: 0 } }).toArray(); }
  async listServices() { return this.db.collection('services').find({}, { projection: { _id: 0 } }).toArray(); }
  async listStaff() { return this.db.collection('staff').find({}, { projection: { _id: 0 } }).toArray(); }
  async listAppointments(userId) { return this.db.collection('appointments').find(userId ? { userId } : {}, { projection: { _id: 0 } }).sort({ startAt: 1 }).toArray(); }
  async updateAppointment(id, status) { const result = await this.db.collection('appointments').findOneAndUpdate({ id }, { $set: { status } }, { returnDocument: 'after', projection: { _id: 0 } }); return result || null; }
  async createAppointment(appointment) {
    try { await this.db.collection('appointments').insertOne(appointment); return appointment; }
    catch (error) { if (error.code === 11000) throw Object.assign(new Error('This time slot was just taken.'), { status: 409 }); throw error; }
  }
  async listMessages(conversationId) { return (await this.db.collection('messages').find({ conversationId }, { projection: { _id: 0 } }).sort({ createdAt: -1 }).limit(100).toArray()).reverse(); }
  async listConversations() { return this.db.collection('messages').aggregate([{ $sort: { createdAt: -1 } }, { $group: { _id: '$conversationId', lastMessage: { $first: '$$ROOT' }, count: { $sum: 1 } } }, { $project: { _id: 0, id: '$_id', lastMessage: { id: '$lastMessage.id', text: '$lastMessage.text', createdAt: '$lastMessage.createdAt', senderRole: '$lastMessage.senderRole' }, count: 1 } }, { $sort: { 'lastMessage.createdAt': -1 } }]).toArray(); }
  async saveMessage(message) { await this.db.collection('messages').insertOne(message); return message; }
  async createOrder(order) { await this.db.collection('orders').insertOne(order); return order; }
  async markOrderPaid(orderId, paymentIntent) { await this.db.collection('orders').updateOne({ id: orderId }, { $set: { status: 'paid', paymentIntent } }); }
  async hasEvent(id) { return Boolean(await this.db.collection('stripe_events').findOne({ id })); }
  async recordEvent(id) { await this.db.collection('stripe_events').updateOne({ id }, { $setOnInsert: { id, processedAt: new Date().toISOString() } }, { upsert: true }); }
  async dashboard() {
    const [appointments, orders, products, messages, recentAppointments, recentOrders] = await Promise.all([
      this.db.collection('appointments').countDocuments(), this.db.collection('orders').countDocuments(), this.db.collection('products').countDocuments(), this.db.collection('messages').countDocuments(),
      this.db.collection('appointments').find({}, { projection: { _id: 0 } }).sort({ createdAt: -1 }).limit(6).toArray(),
      this.db.collection('orders').find({}, { projection: { _id: 0 } }).sort({ createdAt: -1 }).limit(6).toArray()
    ]);
    return { appointments, orders, products, messages, recentAppointments, recentOrders };
  }
}

async function seedCollection(db, name, values) {
  const count = await db.collection(name).countDocuments();
  if (count === 0) await db.collection(name).insertMany(clone(values));
}
