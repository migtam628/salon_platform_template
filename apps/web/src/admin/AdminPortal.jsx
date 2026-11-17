import { useCallback, useEffect, useState } from 'react';
import { Bell, CalendarDays, ChevronDown, Home, Layers3, Menu, MessageCircle, Scissors, Settings2, ShoppingBag, Tag, UsersRound, X } from 'lucide-react';
import { api, demoMode } from '../client';
import { AppointmentsManager, Dashboard, InventoryManager, LiveChatManager, OrdersManager, ProductManager, ServiceManager, SettingsManager, TeamManager } from './screens';
import './admin.css';

const links = [
  { slug: 'overview', label: 'Overview', icon: Home },
  { slug: 'appointments', label: 'Appointments', icon: CalendarDays },
  { slug: 'products', label: 'Products', icon: Tag },
  { slug: 'inventory', label: 'Inventory', icon: Layers3 },
  { slug: 'services', label: 'Services', icon: Scissors },
  { slug: 'team', label: 'Team', icon: UsersRound },
  { slug: 'orders', label: 'Orders', icon: ShoppingBag },
  { slug: 'chat', label: 'Live chat', icon: MessageCircle },
  { slug: 'settings', label: 'Settings', icon: Settings2 },
];
const initial = { overview: null, products: [], services: [], staff: [], appointments: [], orders: [], conversations: [], inventory: { products: [], movements: [] }, integrations: null };

export default function AdminPortal({ path, navigate }) {
  const active = path.split('/')[2] || 'overview';
  const tab = links.some((link) => link.slug === active) ? active : 'overview';
  const [data, setData] = useState(initial), [busy, setBusy] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState(''), [menuOpen, setMenuOpen] = useState(false);
  const refresh = useCallback(async () => {
    const keys = ['overview', 'products', 'services', 'staff', 'appointments', 'orders', 'conversations', 'inventory', 'integrations'];
    const responses = await Promise.all(keys.map((key) => api(key === 'appointments' ? '/appointments' : `/admin/${key}`, {}, 'admin')));
    setData(Object.fromEntries(keys.map((key, index) => [key, responses[index]])));
    setError('');
  }, []);
  useEffect(() => { let live = true; setBusy(true); refresh().catch((e) => { if (live) setError(e.message); }).finally(() => { if (live) setBusy(false); }); return () => { live = false; }; }, [refresh]);
  useEffect(() => { if (!notice) return; const timeout = setTimeout(() => setNotice(''), 4500); return () => clearTimeout(timeout); }, [notice]);
  const go = (slug) => { navigate(slug === 'overview' ? '/admin' : `/admin/${slug}`); setMenuOpen(false); };
  const mutate = async (kind, payload, id) => {
    try {
      const row = await api(`/admin/${kind}${id ? `/${id}` : ''}`, { method: id ? 'PATCH' : 'POST', body: JSON.stringify(payload) }, 'admin');
      await refresh(); setNotice(`${kind === 'staff' ? 'Team member' : kind.slice(0, -1)} saved.`); return row;
    } catch (e) { setNotice(e.message); throw e; }
  };
  const adjustment = async (id, delta, reason) => {
    try { await api(`/admin/inventory/${id}/adjust`, { method: 'POST', body: JSON.stringify({ delta, reason }) }, 'admin'); await refresh(); setNotice('Inventory adjustment saved.'); }
    catch (e) { setNotice(e.message); throw e; }
  };
  const updateAppointment = async (id, status) => {
    try { await api(`/admin/appointments/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }, 'admin'); await refresh(); setNotice('Appointment status updated.'); }
    catch (e) { setNotice(e.message); }
  };
  const updateOrder = async (id, fulfillmentStatus) => {
    try { await api(`/admin/orders/${id}/fulfillment`, { method: 'PATCH', body: JSON.stringify({ fulfillmentStatus }) }, 'admin'); await refresh(); setNotice('Order status updated.'); }
    catch (e) { setNotice(e.message); }
  };
  const selected = links.find((link) => link.slug === tab);

  return <div className="salon-admin">
    <aside className={`admin-sidebar ${menuOpen ? 'open' : ''}`}>
      <button className="admin-wordmark" onClick={() => go('overview')} aria-label="Atelier Beauty admin home"><span className="admin-accent"/>ATELIER<br/>BEAUTY</button>
      <nav aria-label="Admin sections">{links.map(({ slug, label, icon: Icon }) => <button key={slug} className={`admin-nav-item ${tab === slug ? 'active' : ''}`} onClick={() => go(slug)}><Icon size={20} strokeWidth={1.6}/><span>{label}</span>{slug === 'chat' && data.conversations.length > 0 && <small>{data.conversations.length}</small>}</button>)}</nav>
      <div className="admin-sidebar-foot"><button onClick={() => navigate('/')}><Home size={17}/> View storefront</button><span>{demoMode ? 'Development preview' : 'Salon operations'}</span></div>
    </aside>
    {menuOpen && <button className="admin-mobile-scrim" onClick={() => setMenuOpen(false)} aria-label="Close menu"/>}
    <div className="admin-workspace">
      <header className="admin-topbar"><button className="admin-menu-toggle" aria-label="Open admin menu" onClick={() => setMenuOpen(!menuOpen)}>{menuOpen ? <X/> : <Menu/>}</button><span className="admin-location">SALON OPERATIONS <span>/</span> {selected.label}</span><div className="admin-top-actions"><Bell size={21} strokeWidth={1.6}/><span className="admin-top-divider"/><div className="admin-avatar">SA</div><span>Salon Admin</span><ChevronDown size={15}/></div></header>
      {demoMode && <div className="admin-demo-banner">Preview mode — changes are stored in memory until a database and real admin authentication are configured.</div>}
      <main className="admin-content">
        {busy ? <div className="admin-loading">Loading salon operations…</div> : error ? <div className="admin-access-error"><h1>Admin access required</h1><p>{error}</p><button className="admin-primary" onClick={() => navigate('/account')}>Go to sign in</button></div> : <>
          {tab === 'overview' && <Dashboard data={data} go={go}/>}
          {tab === 'appointments' && <AppointmentsManager rows={data.appointments} onStatus={updateAppointment}/>}
          {tab === 'products' && <ProductManager products={data.products} onSave={(row, id) => mutate('products', row, id)} go={go}/>}
          {tab === 'inventory' && <InventoryManager data={data.inventory} onAdjust={adjustment}/>}
          {tab === 'services' && <ServiceManager services={data.services} onSave={(row, id) => mutate('services', row, id)}/>}
          {tab === 'team' && <TeamManager staff={data.staff} onSave={(row, id) => mutate('staff', row, id)}/>}
          {tab === 'orders' && <OrdersManager orders={data.orders} onStatus={updateOrder}/>}
          {tab === 'chat' && <LiveChatManager conversations={data.conversations} refresh={refresh} notify={setNotice}/>}
          {tab === 'settings' && <SettingsManager integrations={data.integrations}/>}
        </>}
      </main>
    </div>
    {notice && <div className="admin-toast" role="status">{notice}<button onClick={() => setNotice('')} aria-label="Dismiss"><X size={14}/></button></div>}
  </div>;
}
