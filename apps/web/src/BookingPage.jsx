import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Check } from 'lucide-react';
import { api, demoMode } from './client';
import { categories, price, tomorrow } from './data';

function maxBookingDate() { const day = new Date(); day.setDate(day.getDate() + 90); return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`; }

export default function BookingPage({ services, staff, activeCategory, setActiveCategory, notify, user, onBooked }) {
  const [serviceId, setServiceId] = useState('');
  const [staffId, setStaffId] = useState('');
  const [date, setDate] = useState(tomorrow());
  const [selectedStartAt, setSelectedStartAt] = useState('');
  const [availability, setAvailability] = useState(null);
  const [availabilityLoading, setAvailabilityLoading] = useState(false);
  const [availabilityError, setAvailabilityError] = useState('');
  const [name, setName] = useState(user?.name || '');
  const [email, setEmail] = useState(user?.email?.endsWith('.invalid') ? '' : user?.email || '');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState(null);
  const service = useMemo(() => services.find((s) => s.id === serviceId), [services, serviceId]);
  const availableStaff = useMemo(() => staff.filter((person) => person.active !== false && person.specialties.includes(service?.category || activeCategory)), [staff, service?.category, activeCategory]);
  const availableServices = services.filter((item) => item.category === activeCategory);
  useEffect(() => { setServiceId(''); setStaffId(''); setSelectedStartAt(''); }, [activeCategory]);
  useEffect(() => { if (user?.name) setName(user.name); if (user?.email && !user.email.endsWith('.invalid')) setEmail(user.email); }, [user]);
  useEffect(() => {
    setSelectedStartAt(''); setAvailability(null); setAvailabilityError('');
    if (!serviceId || !staffId || !date) return;
    let alive = true; setAvailabilityLoading(true);
    const query = new URLSearchParams({ serviceId, staffId, date });
    api(`/availability?${query}`).then((result) => { if (alive) setAvailability(result); }).catch((error) => { if (alive) setAvailabilityError(error.message); }).finally(() => { if (alive) setAvailabilityLoading(false); });
    return () => { alive = false; };
  }, [serviceId, staffId, date]);
  async function book(event) {
    event.preventDefault();
    if (!service || !staffId || !selectedStartAt) return notify('Choose a service, specialist and available time.');
    setBusy(true);
    try {
      const result = await api('/appointments', { method: 'POST', body: JSON.stringify({ serviceId, staffId, startAt: selectedStartAt, customerName: name, customerEmail: email, notes }) });
      setSuccess(result); await onBooked();
    } catch (error) {
      notify(error.message);
      if (error.message.toLowerCase().includes('slot') || error.message.toLowerCase().includes('time')) setSelectedStartAt('');
    } finally { setBusy(false); }
  }
  if (success) return <section className="confirmation content-narrow"><div className="check-circle"><Check size={30}/></div><span className="eyebrow">REQUEST RECEIVED</span><h1>Your beautiful moment<br/>is on its way.</h1><p>Your request for <strong>{success.serviceName}</strong> has been received. The salon will confirm your appointment.</p><p>{new Date(success.startAt).toLocaleString('en-US', { timeZone: success.timeZone || 'America/New_York', dateStyle: 'full', timeStyle: 'short' })}</p><p className="confirmation-id">Request #{success.id.slice(0, 8).toUpperCase()}</p><button className="btn btn-green" onClick={() => { setSuccess(null); setServiceId(''); setStaffId(''); }}>Book another appointment <ArrowRight size={18}/></button></section>;

  return <main className="interior-page content-wide booking-page"><div className="page-heading"><span className="eyebrow">A LITTLE TIME FOR YOU</span><h1>Book your <em>visit.</em></h1><p>Choose a service and a time that works for you. We'll take care of the rest.</p></div><div className="booking-layout"><div className="booking-main"><div className="step-heading"><span>01</span><h2>Choose a treatment</h2></div><div className="category-tabs">{categories.map((category) => <button key={category} className={category === activeCategory ? 'active' : ''} onClick={() => setActiveCategory(category)}>{category}</button>)}</div><div className="service-list">{availableServices.map((item) => <button type="button" key={item.id} className={`service-row ${serviceId === item.id ? 'selected' : ''}`} onClick={() => { setServiceId(item.id); setStaffId(''); }}><span><strong>{item.name}</strong><small>{item.description}</small></span><span className="service-meta">{item.durationMinutes} min · {price(item.price)} <span className="radio-circle"/></span></button>)}</div><div className="step-heading second-step"><span>02</span><h2>Choose your appointment</h2></div><form className="booking-form" onSubmit={book}><div className="form-row"><label>Specialist<select value={staffId} onChange={(event) => setStaffId(event.target.value)} required disabled={!service}><option value="">Select a specialist</option>{availableStaff.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label><label>Preferred date<input type="date" value={date} min={tomorrow()} max={maxBookingDate()} onChange={(event) => setDate(event.target.value)} required/></label></div><div className="booking-slot-heading"><strong>Available times</strong>{availability?.timeZone && <span>Salon time: {availability.timeZone.replaceAll('_', ' ')}</span>}</div><div className="booking-availability" aria-live="polite">{!serviceId || !staffId ? <p className="booking-slot-empty">Select a treatment and specialist to see live availability.</p> : availabilityLoading ? <p className="booking-slot-empty">Checking availability…</p> : availabilityError ? <p className="booking-slot-empty error">{availabilityError}</p> : availability?.slots?.length ? <div className="time-grid">{availability.slots.map((slot) => <button type="button" key={slot.startAt} className={slot.startAt === selectedStartAt ? 'active' : ''} onClick={() => setSelectedStartAt(slot.startAt)} aria-pressed={slot.startAt === selectedStartAt}>{slot.label}</button>)}</div> : <p className="booking-slot-empty">No openings for this specialist on this date. Try another day or specialist.</p>}</div><div className="form-row"><label>Your name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Full name" required minLength={2}/></label><label>Email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" required readOnly={!demoMode && Boolean(user?.email)}/></label></div><label>Anything we should know? <span className="optional">(optional)</span><textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={3} placeholder="Tell us about your visit…" maxLength={500}/></label><button className="btn btn-green submit-booking" type="submit" disabled={busy || !selectedStartAt}>{busy ? 'Sending request…' : 'Request appointment'} <ArrowRight size={19}/></button><p className="small-note">Time slots are checked again when you book. Your appointment is a request until confirmed by the salon. Payments are not collected during booking.</p></form></div><aside className="booking-aside"><img src="/images/hero-beauty.webp" alt="Salon beauty portrait"/><h3>A moment just for you.</h3><p>Expert care and thoughtful details, from the first hello to the final finishing touch.</p></aside></div></main>;
}
