import { useEffect, useState } from 'react';
import { ArrowRight, ChevronDown, Instagram, Menu, MessageCircle, Minus, Plus, ShoppingBag, Trash2, UserRound, X } from 'lucide-react';
import { io } from 'socket.io-client';
import { api, account, authConfigured, demoMode } from './client';
import { price } from './data';

export function ProductCard({ item, onAdd }) {
  return <article className="product-card"><div className="product-photo"><img src={item.image} alt={item.name} loading="lazy"/><button className="quick-add" onClick={() => onAdd(item)} aria-label={`Add ${item.name} to bag`}><Plus size={18}/></button></div><div className="product-caption"><strong>{item.name}</strong><span>{price(item.price)}</span></div><p>{item.description}</p></article>;
}

export function Header({ path, navigate, cartCount, openCart }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const links = [{ label: 'Services', target: '/services' }, { label: 'Our Work', target: '/our-work' }, { label: 'Shop', target: '/shop' }, { label: 'About', target: '/about' }];
  function go(target) { navigate(target); setMobileOpen(false); }
  return <header className="site-header"><button className="brand" onClick={() => go('/')}>ATELIER BEAUTY</button><nav className={mobileOpen ? 'open' : ''}>{links.map((link) => <button className={path === link.target ? 'active' : ''} key={link.target} onClick={() => go(link.target)}>{link.label}{link.label === 'Services' && <ChevronDown className="nav-chevron" size={14}/>}</button>)}</nav><div className="nav-tools"><button className="icon-button account-icon" aria-label="My account" onClick={() => go('/account')}><UserRound size={24} strokeWidth={1.5}/></button><button className="icon-button bag-icon" aria-label={`Shopping bag with ${cartCount} items`} onClick={openCart}><ShoppingBag size={23} strokeWidth={1.5}/>{cartCount > 0 && <span className="cart-count">{cartCount}</span>}</button><span className="nav-divider"/><button className="btn btn-green header-cta" onClick={() => go('/book')}>Book now</button><button className="icon-button mobile-menu" onClick={() => setMobileOpen(!mobileOpen)} aria-label="Toggle navigation">{mobileOpen ? <X/> : <Menu/>}</button></div></header>;
}

export function Footer({ navigate }) {
  return <footer className="site-footer"><div><h2>ATELIER BEAUTY</h2><p>Beauty in every detail.</p></div><div><strong>Explore</strong><button onClick={() => navigate('/services')}>Services</button><button onClick={() => navigate('/shop')}>The Shop</button><button onClick={() => navigate('/account')}>My Account</button></div><div><strong>Visit</strong><p>Salon location and hours<br/>will be added soon.</p></div><div><strong>Stay close</strong><p>Follow along for inspiration and salon updates.</p><Instagram size={20}/></div><div className="footer-bottom">© {new Date().getFullYear()} Atelier Beauty · Concept branding and sample products</div></footer>;
}

export function CartDrawer({ open, onClose, cart, products, updateQuantity, notify }) {
  const [loading, setLoading] = useState(false);
  const lines = cart.map((row) => ({ ...row, product: products.find((p) => p.id === row.id) })).filter((row) => row.product);
  const subtotal = lines.reduce((sum, row) => sum + row.product.price * row.qty, 0);
  async function checkout() {
    setLoading(true);
    try { const { url } = await api('/checkout', { method: 'POST', body: JSON.stringify({ items: lines.map((row) => ({ productId: row.id, quantity: row.qty })) }) }); window.location.assign(url); }
    catch (error) { notify(error.message); } finally { setLoading(false); }
  }
  if (!open) return null;
  return <div className="drawer-layer"><button className="drawer-scrim" onClick={onClose} aria-label="Close bag"/><aside className="cart-drawer" role="dialog" aria-modal="true" aria-label="Shopping bag"><header><div><span className="eyebrow">THE SALON EDIT</span><h2>Your bag <span>({cart.reduce((s, x) => s + x.qty, 0)})</span></h2></div><button className="icon-button" onClick={onClose} aria-label="Close bag"><X/></button></header><div className="cart-lines">{lines.length ? lines.map(({ id, qty, product }) => <div className="cart-line" key={id}><img src={product.image} alt=""/><div><strong>{product.name}</strong><span>{price(product.price)}</span><div className="quantity-control"><button onClick={() => updateQuantity(id, -1)} aria-label="Decrease quantity"><Minus size={13}/></button><span>{qty}</span><button onClick={() => updateQuantity(id, 1)} aria-label="Increase quantity"><Plus size={13}/></button></div></div><button className="remove-line" onClick={() => updateQuantity(id, -qty)} aria-label={`Remove ${product.name}`}><Trash2 size={16}/></button></div>) : <div className="cart-empty"><ShoppingBag size={34} strokeWidth={1}/><p>Your bag is waiting for something lovely.</p></div>}</div><footer><div className="subtotal"><span>Subtotal</span><strong>{price(subtotal)}</strong></div><p>Shipping and taxes are calculated at checkout.</p><button className="btn btn-green" disabled={!lines.length || loading} onClick={checkout}>{loading ? 'Connecting to Stripe…' : 'Secure checkout'} <ArrowRight size={18}/></button></footer></aside></div>;
}

export function ChatWidget({ user, notify }) {
  const [open, setOpen] = useState(false), [messages, setMessages] = useState([]), [text, setText] = useState(''), [connection, setConnection] = useState('connecting');
  const conversationId = user?.$id;
  useEffect(() => {
    if (!open || !conversationId) return;
    let alive = true;
    api(`/chat/${conversationId}`).then((rows) => { if (alive) setMessages(rows); }).catch((e) => notify(e.message));
    let socket;
    (async () => {
      let jwt;
      if (authConfigured && !demoMode) try { jwt = (await account.createJWT()).jwt; } catch { return; }
      socket = io(import.meta.env.VITE_API_URL || window.location.origin, { path: '/socket.io', auth: { jwt, demoRole: 'customer' }, transports: ['websocket'] });
      socket.on('connect', () => { socket.emit('chat:join', conversationId, ({ ok }) => { if (alive) setConnection(ok ? 'online' : 'offline'); }); });
      socket.on('connect_error', () => { if (alive) setConnection('offline'); });
      socket.on('chat:message', (message) => { if (alive) setMessages((prev) => prev.some((m) => m.id === message.id) ? prev : [...prev, message]); });
    })();
    return () => { alive = false; socket?.disconnect(); };
  }, [open, conversationId]);
  async function send(event) {
    event.preventDefault(); if (!text.trim()) return;
    try { const saved = await api('/chat', { method: 'POST', body: JSON.stringify({ conversationId, text }) }); setMessages((prev) => prev.some((m) => m.id === saved.id) ? prev : [...prev, saved]); setText(''); }
    catch (error) { notify(error.message); }
  }
  return <div className="chat-widget">{open && <section className="chat-panel" role="dialog" aria-label="Salon live chat"><header><div><strong>Chat with our salon</strong><span><i className={`status-dot ${connection}`}/> {connection === 'online' ? 'Connected' : 'Connecting to the studio'}</span></div><button onClick={() => setOpen(false)} aria-label="Close chat"><X size={19}/></button></header><div className="chat-messages"><p className="chat-welcome">Hello! How can we make your day a little more beautiful?</p>{messages.map((message) => <p key={message.id} className={`chat-bubble ${message.senderRole === 'admin' ? 'staff' : 'mine'}`}>{message.text}</p>)}</div>{conversationId ? <form onSubmit={send}><input value={text} onChange={(event) => setText(event.target.value)} placeholder="Type a message…" aria-label="Your message" maxLength={1500}/><button type="submit" aria-label="Send message"><ArrowRight size={19}/></button></form> : <p className="chat-signin">Sign in to start a conversation with our team.</p>}</section>}<button className="chat-launcher" onClick={() => setOpen((old) => !old)} aria-label={open ? 'Close live chat' : 'Open live chat'}>{open ? <X size={22}/> : <MessageCircle size={23}/>}</button></div>;
}
