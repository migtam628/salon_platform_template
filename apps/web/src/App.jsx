import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { api, currentUser } from './client';
import { demoProducts, demoServices, demoStaff } from './data';
import { CartDrawer, ChatWidget, Footer, Header } from './components';
import { Home, Shop, StoryPage } from './pages';
import BookingPage from './BookingPage';
import ClientAccount from './ClientAccount';

const AdminPortal = lazy(() => import('./admin/AdminPortal'));

function usePath() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => { const onPop = () => setPath(window.location.pathname); window.addEventListener('popstate', onPop); return () => window.removeEventListener('popstate', onPop); }, []);
  function navigate(target) { history.pushState({}, '', target); setPath(target.split('?')[0]); window.scrollTo({ top: 0, behavior: 'instant' }); }
  return [path, navigate];
}

export function App() {
  const [path, navigate] = usePath();
  const [products, setProducts] = useState(demoProducts), [services, setServices] = useState(demoServices), [staff, setStaff] = useState(demoStaff);
  const [category, setCategory] = useState('Hair');
  const [cart, setCart] = useState(() => { try { return JSON.parse(localStorage.getItem('salon-cart') || '[]'); } catch { return []; } });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [toast, setToast] = useState(''), [user, setUser] = useState(null), [appointments, setAppointments] = useState([]);
  useEffect(() => { localStorage.setItem('salon-cart', JSON.stringify(cart)); }, [cart]);
  useEffect(() => {
    Promise.allSettled([api('/products'), api('/services'), api('/staff')]).then(([p, s, st]) => { if (p.status === 'fulfilled') setProducts(p.value); if (s.status === 'fulfilled') setServices(s.value); if (st.status === 'fulfilled') setStaff(st.value); });
  }, [path]);
  useEffect(() => { currentUser().then(setUser); }, []);
  useEffect(() => { if (user) api('/appointments').then(setAppointments).catch(() => {}); }, [user]);
  useEffect(() => { if (!toast) return; const id = setTimeout(() => setToast(''), 5000); return () => clearTimeout(id); }, [toast]);
  function notify(message) { setToast(message); }
  function addToCart(item) { setCart((rows) => { const old = rows.find((row) => row.id === item.id); return old ? rows.map((row) => row.id === item.id ? { ...row, qty: row.qty + 1 } : row) : [...rows, { id: item.id, qty: 1 }]; }); setDrawerOpen(true); }
  function updateQuantity(id, amount) { setCart((rows) => rows.map((row) => row.id === id ? { ...row, qty: row.qty + amount } : row).filter((row) => row.qty > 0)); }
  function chooseCategory(value) { setCategory(value); navigate('/book'); }
  async function refreshUser() { setUser(await currentUser()); }
  async function onBooked() { try { setAppointments(await api('/appointments')); } catch { /* Confirmation remains valid. */ } }
  const cartCount = useMemo(() => cart.reduce((sum, item) => sum + item.qty, 0), [cart]);
  if (path === '/admin' || path.startsWith('/admin/')) return <Suspense fallback={<div className="site-shell" style={{ padding: 60 }}>Opening the salon dashboard…</div>}><AdminPortal path={path} navigate={navigate}/></Suspense>;
  return <div className="site-shell">
    <Header path={path} navigate={navigate} cartCount={cartCount} openCart={() => setDrawerOpen(true)}/>
    {path === '/' && <Home navigate={navigate} products={products} addToCart={addToCart} chooseCategory={chooseCategory}/>}
    {path === '/shop' && <Shop products={products} addToCart={addToCart}/>}
    {(path === '/book' || path === '/services') && <BookingPage services={services} staff={staff} activeCategory={category} setActiveCategory={setCategory} notify={notify} user={user} onBooked={onBooked}/>}
    {path === '/account' && <ClientAccount user={user} refreshUser={refreshUser} notify={notify} appointments={appointments} onAppointmentsChanged={onBooked}/>}
    {(path === '/about' || path === '/our-work') && <StoryPage path={path} navigate={navigate}/>}
    <Footer navigate={navigate}/>
    <ChatWidget user={user} notify={notify}/>
    <CartDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} cart={cart} products={products} updateQuantity={updateQuantity} notify={notify}/>
    {toast && <div className="toast" role="status">{toast}<button onClick={() => setToast('')} aria-label="Dismiss"><X size={15}/></button></div>}
  </div>;
}
