import 'dotenv/config';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { Client, Account } from 'node-appwrite';
import { MemoryStore, MongoStore } from './store.js';
import { createApp } from './app.js';
import { processDueEmails } from './notifications.js';
import { validateRuntimeConfig } from './security.js';

const config = process.env;
const origins = validateRuntimeConfig(config);
const store = config.MONGODB_URI ? await MongoStore.connect(config.MONGODB_URI, config.MONGODB_DB || 'salon_platform') : new MemoryStore();
const { app } = createApp({ store, config, onMessage: (message) => io.to(`conversation:${message.conversationId}`).emit('chat:message', message) });
const server = createServer(app);
const io = new Server(server, { cors: { origin: origins }, maxHttpBufferSize: 16 * 1024 });

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
  let typingWindow = { start: Date.now(), count: 0 };
  socket.on('chat:join', (conversationId, acknowledge) => {
    const reply = typeof acknowledge === 'function' ? acknowledge : () => {};
    if (typeof conversationId !== 'string' || conversationId.length < 2 || conversationId.length > 100 || (socket.data.user.role !== 'admin' && conversationId !== socket.data.user.id)) return reply({ ok: false });
    socket.join(`conversation:${conversationId}`);
    reply({ ok: true });
  });
  socket.on('chat:typing', (conversationId) => {
    const now = Date.now();
    if (now - typingWindow.start >= 10_000) typingWindow = { start: now, count: 0 };
    if (++typingWindow.count > 15) return;
    if (typeof conversationId === 'string' && conversationId.length >= 2 && conversationId.length <= 100 && (socket.data.user.role === 'admin' || conversationId === socket.data.user.id)) {
      socket.to(`conversation:${conversationId}`).emit('chat:typing', { conversationId, role: socket.data.user.role });
    }
  });
});

server.listen(Number(config.PORT || 4000), () => console.log(`Salon API listening on port ${config.PORT || 4000}`));
// Safety net for abandoned retail Checkout Sessions when expiry webhooks are delayed or unavailable.
const inventoryTimer = setInterval(() => store.releaseExpiredOrders().catch((error) => console.error('Retail stock reservation cleanup failed:', error.message)), 60_000);
inventoryTimer.unref();
store.releaseExpiredOrders().catch((error) => console.error('Initial retail reservation cleanup failed:', error.message));
let notificationTimer;
if (config.RESEND_API_KEY && config.SALON_EMAIL_FROM) {
  let inProgress = false;
  const poll = async () => {
    if (inProgress) return;
    inProgress = true;
    try { await processDueEmails(store, config); }
    catch (error) { console.error('Notification worker failed:', error.message); }
    finally { inProgress = false; }
  };
  notificationTimer = setInterval(poll, 30_000);
  notificationTimer.unref();
  poll();
}

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.info(JSON.stringify({ event: 'server.shutdown', signal }));
  clearInterval(inventoryTimer);
  if (notificationTimer) clearInterval(notificationTimer);
  const timeout = setTimeout(() => {
    console.error('Shutdown timed out.');
    process.exit(1);
  }, 15_000);
  timeout.unref();
  try {
    await new Promise((resolve) => io.close(resolve));
    await store.close?.();
  } catch (error) {
    console.error('Graceful shutdown failed:', error.message);
    process.exitCode = 1;
  } finally { clearTimeout(timeout); }
}
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
