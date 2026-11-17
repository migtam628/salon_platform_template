import 'dotenv/config';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { Client, Account } from 'node-appwrite';
import { MemoryStore, MongoStore } from './store.js';
import { createApp } from './app.js';
import { processDueEmails } from './notifications.js';

const config = process.env;
if (config.NODE_ENV === 'production' && (config.DEMO_MODE === 'true' || !config.MONGODB_URI || !config.APPWRITE_ENDPOINT || !config.APPWRITE_PROJECT_ID)) {
  throw new Error('Production requires MongoDB and Appwrite authentication, and DEMO_MODE must be disabled.');
}
const store = config.MONGODB_URI ? await MongoStore.connect(config.MONGODB_URI, config.MONGODB_DB || 'salon_platform') : new MemoryStore();
const { app } = createApp({ store, config, onMessage: (message) => io.to(`conversation:${message.conversationId}`).emit('chat:message', message) });
const server = createServer(app);
const io = new Server(server, { cors: { origin: config.WEB_ORIGIN?.split(',') || 'http://localhost:5173' } });

io.use(async (socket, next) => {
  if (config.DEMO_MODE === 'true') {
    socket.data.user = { id: 'demo-customer', role: socket.handshake.auth?.demoRole === 'admin' ? 'admin' : 'customer' };
    return next();
  }
  try {
    const client = new Client().setEndpoint(config.APPWRITE_ENDPOINT).setProject(config.APPWRITE_PROJECT_ID).setJWT(socket.handshake.auth?.jwt || '');
    const user = await new Account(client).get();
    socket.data.user = { id: user.$id, role: (config.ADMIN_USER_IDS || '').split(',').includes(user.$id) ? 'admin' : 'customer' };
    next();
  } catch { next(new Error('Unauthorized WebSocket connection')); }
});
io.on('connection', (socket) => {
  socket.on('chat:join', (conversationId, acknowledge) => {
    if (typeof conversationId !== 'string' || conversationId.length > 100 || (socket.data.user.role !== 'admin' && conversationId !== socket.data.user.id)) return acknowledge?.({ ok: false });
    socket.join(`conversation:${conversationId}`);
    acknowledge?.({ ok: true });
  });
  socket.on('chat:typing', (conversationId) => {
    if (typeof conversationId === 'string' && (socket.data.user.role === 'admin' || conversationId === socket.data.user.id)) socket.to(`conversation:${conversationId}`).emit('chat:typing', { conversationId, role: socket.data.user.role });
  });
});

server.listen(Number(config.PORT || 4000), () => console.log(`Salon API listening on port ${config.PORT || 4000}`));
if (config.RESEND_API_KEY && config.SALON_EMAIL_FROM) {
  let inProgress = false;
  const poll = async () => {
    if (inProgress) return;
    inProgress = true;
    try { await processDueEmails(store, config); }
    catch (error) { console.error('Notification worker failed:', error.message); }
    finally { inProgress = false; }
  };
  const timer = setInterval(poll, 30_000);
  timer.unref();
  poll();
}
