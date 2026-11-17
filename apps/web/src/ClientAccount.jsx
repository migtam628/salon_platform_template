import { useEffect, useState } from 'react';
import { ArrowRight, CalendarDays, UserRound } from 'lucide-react';
import { api, account, demoMode, signIn, signUp } from './client';
import { tomorrow } from './data';

export default function ClientAccount({ user, refreshUser, notify, appointments, onAppointmentsChanged }) {
  const [mode, setMode] = useState('signin'), [name, setName] = useState(''), [email, setEmail] = useState(''), [password, setPassword] = useState(''), [busy, setBusy] = useState(false);
  const [changingId, setChangingId] = useState(''), [date, setDate] = useState(tomorrow()), [options, setOptions] = useState(null), [slot, setSlot] = useState(''), [slotError, setSlotError] = useState(''), [slotBusy, setSlotBusy] = useState(false);
  async function submit(event) {
    event.preventDefault(); setBusy(true);
    try { if (mode === 'signup') { await signUp(name, email, password); await signIn(email, password); } else await signIn(email, password); await refreshUser(); notify('Welcome to your account.'); }
    catch (error) { notify(error.message); } finally { setBusy(false); }
  }
  useEffect(() => {
    if (!changingId || !date) return;
    let alive = true; setOptions(null); setSlot(''); setSlotError(''); setSlotBusy(true);
    api(`/appointments/${changingId}/availability?date=${encodeURIComponent(date)}`).then((data) => { if (alive) setOptions(data); }).catch((error) => { if (alive) setSlotError(error.message); }).finally(() => { if (alive) setSlotBusy(false); });
    return () => { alive = false; };
  }, [changingId, date]);
  async function reschedule(event) {
    event.preventDefault(); if (!slot) return;
    setBusy(true);
    try { await api(`/appointments/${changingId}`, { method: 'PATCH', body: JSON.stringify({ startAt: slot }) }); await onAppointmentsChanged(); setChangingId(''); notify('Reschedule request received. The salon will confirm the new time.'); }
    catch (error) { notify(error.message); setSlot(''); } finally { setBusy(false); }
  }
  async function cancel(appointment) {
    if (!window.confirm(`Cancel your ${appointment.serviceName} appointment?`)) return;
    setBusy(true);
    try { await api(`/appointments/${appointment.id}/cancel`, { method: 'POST' }); await onAppointmentsChanged(); setChangingId(''); notify('Your appointment has been cancelled.'); }
    catch (error) { notify(error.message); } finally { setBusy(false); }
  }
  if (!user) return <main className="interior-page account-login content-narrow"><span className="eyebrow">WELCOME BACK</span><h1>Your beauty, <em>your space.</em></h1><p>Sign in to manage appointments, orders and conversations with the salon.</p><form onSubmit={submit}>{mode === 'signup' && <label>Name<input value={name} onChange={(e) => setName(e.target.value)} required/></label>}<label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required/></label><label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required/></label><button className="btn btn-green" type="submit" disabled={busy}>{busy ? 'Please wait…' : mode === 'signup' ? 'Create account' : 'Sign in'} <ArrowRight size={18}/></button></form><button className="text-link" onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')}>{mode === 'signin' ? 'New here? Create an account' : 'Already have an account? Sign in'}</button></main>;

  return <main className="interior-page content-wide"><div className="page-heading"><span className="eyebrow">YOUR PERSONAL SPACE</span><h1>Hello, <em>{user.name?.split(' ')[0] || 'there'}.</em></h1><p>Everything you need for your next beautiful visit.</p></div>{demoMode && <div className="demo-ribbon">Preview mode — sample customer profile. Connect Appwrite for real customer sign-in.</div>}<div className="account-grid"><section><div className="section-head"><h2>My appointments</h2><CalendarDays size={22}/></div>{appointments.length ? appointments.map((appointment) => <div className="account-appointment" key={appointment.id}><div className="account-row"><div><strong>{appointment.serviceName}</strong><p>{new Date(appointment.startAt).toLocaleString('en-US', { timeZone: appointment.timeZone || 'America/New_York', dateStyle: 'medium', timeStyle: 'short' })} · {appointment.staffName}</p></div><span className="state-pill">{appointment.status}</span></div>{['requested', 'confirmed'].includes(appointment.status) && new Date(appointment.startAt).getTime() > Date.now() && <div className="account-appointment-actions"><button disabled={busy} onClick={() => { setDate(tomorrow()); setChangingId(changingId === appointment.id ? '' : appointment.id); }}>Change time</button><button disabled={busy} onClick={() => cancel(appointment)}>Cancel appointment</button></div>}{changingId === appointment.id && <form className="account-reschedule" onSubmit={reschedule}><h3>Choose another time</h3><label>New date<input type="date" required min={tomorrow()} value={date} onChange={(e) => setDate(e.target.value)}/></label>{slotBusy ? <p>Checking available times…</p> : slotError ? <p className="booking-slot-empty error">{slotError}</p> : options?.slots?.length ? <div className="time-grid">{options.slots.map((option) => <button type="button" key={option.startAt} className={slot === option.startAt ? 'active' : ''} onClick={() => setSlot(option.startAt)}>{option.label}</button>)}</div> : <p>No available times for this date.</p>}<div className="account-reschedule-actions"><button type="button" className="outline-button" onClick={() => setChangingId('')}>Keep current time</button><button className="btn btn-green" type="submit" disabled={!slot || busy}>Request new time</button></div><p className="small-note">Rescheduling a confirmed appointment sends the new time back for approval.</p></form>}</div>) : <p className="empty-state">No appointments yet. Your future visits will appear here.</p>}</section><section><div className="section-head"><h2>My details</h2><UserRound size={22}/></div><div className="detail-row"><small>Name</small><strong>{user.name}</strong></div><div className="detail-row"><small>Email</small><strong>{demoMode ? 'Preview account' : user.email}</strong></div><div className="detail-row"><small>Orders</small><strong>Purchase history appears once Stripe checkout is connected.</strong></div>{!demoMode && <button className="text-link" onClick={async () => { await account.deleteSession({ sessionId: 'current' }); await refreshUser(); }}>Sign out</button>}</section></div></main>;
}
