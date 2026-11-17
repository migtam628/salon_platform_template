import { useEffect, useMemo, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, Clock3 } from 'lucide-react';
import { api } from '../client';

const statuses = ['requested', 'confirmed', 'completed', 'cancelled'];
const dayDate = (date) => new Date(`${date}T12:00:00Z`);
const dateKey = (date) => date.toISOString().slice(0, 10);
const addDays = (date, days) => { const value = dayDate(date); value.setUTCDate(value.getUTCDate() + days); return dateKey(value); };
const startWeek = (date) => { const day = dayDate(date); day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7)); return dateKey(day); };
const localDate = (value) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
const dateFor = (appointment) => appointment.bookingDate || localDate(appointment.startAt);
const formatTime = (value, timeZone = 'America/New_York') => new Date(value).toLocaleTimeString('en-US', { timeZone, hour: 'numeric', minute: '2-digit' });
const niceDay = (value) => dayDate(value).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', day: 'numeric' });

export default function BookingCalendar({ rows, staff, onStatus, refresh, notify }) {
  const [week, setWeek] = useState(() => startWeek(dateKey(new Date())));
  const [staffId, setStaffId] = useState('all');
  const [status, setStatus] = useState('active');
  const [selected, setSelected] = useState('');
  const [moveDate, setMoveDate] = useState('');
  const [availability, setAvailability] = useState(null);
  const [newSlot, setNewSlot] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const days = useMemo(() => Array.from({ length: 7 }, (_, index) => addDays(week, index)), [week]);
  const filtered = rows.filter((appointment) => (staffId === 'all' || appointment.staffId === staffId) && (status === 'all' || (status === 'active' ? appointment.status !== 'cancelled' : appointment.status === status)));
  const chosen = rows.find((appointment) => appointment.id === selected);
  useEffect(() => {
    if (!chosen || !moveDate) return;
    let live = true;
    setAvailability(null); setNewSlot(''); setError('');
    api(`/appointments/${chosen.id}/availability?date=${encodeURIComponent(moveDate)}`, {}, 'admin')
      .then((value) => { if (live) setAvailability(value); })
      .catch((err) => { if (live) setError(err.message); });
    return () => { live = false; };
  }, [selected, moveDate, chosen?.startAt]);
  async function moveAppointment(event) {
    event.preventDefault(); if (!chosen || !newSlot) return;
    setBusy(true); setError('');
    try {
      await api(`/appointments/${chosen.id}`, { method: 'PATCH', body: JSON.stringify({ startAt: newSlot }) }, 'admin');
      await refresh(); notify('Appointment moved. It now needs reconfirmation.'); setSelected('');
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  const showReschedule = (appointment) => { setSelected(appointment.id); setMoveDate(dateFor(appointment)); setAvailability(null); setNewSlot(''); setError(''); };
  return <>
    <div className="admin-page-title"><div><div className="admin-accent"/><h1>Appointment calendar</h1><p>A live weekly view of bookings, specialists and treatment durations.</p></div><span className="admin-calendar-badge"><CalendarDays size={18}/> Salon schedule</span></div>
    <div className="admin-calendar-toolbar">
      <div className="admin-calendar-period"><button type="button" aria-label="Previous week" onClick={() => setWeek(addDays(week, -7))}><ChevronLeft size={19}/></button><strong>{dayDate(days[0]).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' })} – {dayDate(days[6]).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' })}</strong><button type="button" aria-label="Next week" onClick={() => setWeek(addDays(week, 7))}><ChevronRight size={19}/></button><button type="button" onClick={() => setWeek(startWeek(dateKey(new Date())))}>Today</button></div>
      <div className="admin-calendar-filters"><label>Specialist<select value={staffId} onChange={(e) => setStaffId(e.target.value)}><option value="all">All specialists</option>{staff.map((person) => <option value={person.id} key={person.id}>{person.name}</option>)}</select></label><label>Status<select value={status} onChange={(e) => setStatus(e.target.value)}><option value="active">Active bookings</option><option value="all">All bookings</option>{statuses.map((value) => <option key={value}>{value}</option>)}</select></label></div>
    </div>
    <div className="admin-calendar-week">{days.map((day) => { const bookings = filtered.filter((a) => dateFor(a) === day).sort((a, b) => a.startAt.localeCompare(b.startAt)); return <section key={day} className={`admin-calendar-day ${day === localDate(new Date().toISOString()) ? 'today' : ''}`}><header><strong>{niceDay(day)}</strong><small>{bookings.length} {bookings.length === 1 ? 'visit' : 'visits'}</small></header><div className="admin-calendar-day-body">{bookings.map((a) => <button type="button" key={a.id} className={`admin-calendar-event ${a.status}`} onClick={() => showReschedule(a)}><time>{formatTime(a.startAt, a.timeZone)}</time><strong>{a.customerName}</strong><small>{a.serviceName}</small><span>{a.staffName} · {a.durationMinutes || 60} min</span></button>)}{!bookings.length && <div className="admin-calendar-none">No bookings</div>}</div></section>; })}</div>
    <section className="admin-block admin-calendar-detail"><div className="admin-block-heading"><h2>Appointment register</h2><span>{filtered.length} records</span></div><div className="admin-table-scroll"><table className="admin-table"><thead><tr><th>Customer</th><th>Service</th><th>Specialist</th><th>Schedule</th><th>Status</th><th/></tr></thead><tbody>{filtered.map((a) => <tr key={a.id}><td><strong>{a.customerName}</strong><small className="admin-table-note">{a.customerEmail}</small></td><td>{a.serviceName}</td><td>{a.staffName}</td><td>{dateFor(a)} · {formatTime(a.startAt, a.timeZone)}</td><td><select className="admin-row-select" aria-label={`Appointment status for ${a.customerName}`} value={a.status} onChange={(event) => onStatus(a.id, event.target.value)}>{statuses.map((value) => <option key={value}>{value}</option>)}</select></td><td><button type="button" className="admin-outline" disabled={!['requested', 'confirmed'].includes(a.status)} onClick={() => showReschedule(a)}>Move</button></td></tr>)}</tbody></table>{!filtered.length && <p className="admin-calendar-empty">No appointments match the selected filters.</p>}</div></section>
    {chosen && <div className="admin-calendar-overlay" role="presentation" onClick={() => setSelected('')}><section className="admin-calendar-dialog" role="dialog" aria-modal="true" aria-label="Reschedule appointment" onClick={(event) => event.stopPropagation()}><button type="button" className="admin-dialog-close" onClick={() => setSelected('')}>Close ×</button><span className="eyebrow">CHANGE APPOINTMENT</span><h2>{chosen.customerName}</h2><p>{chosen.serviceName} with {chosen.staffName}. Changing a booking requires the salon to reconfirm it.</p><form onSubmit={moveAppointment}><label>New date<input type="date" required min={dateKey(new Date())} value={moveDate} onChange={(event) => setMoveDate(event.target.value)}/></label><strong>Available start times</strong>{error ? <p role="alert" className="admin-calendar-error">{error}</p> : !availability ? <p>Checking the calendar…</p> : availability.slots.length ? <div className="admin-calendar-slots">{availability.slots.map((option) => <button key={option.startAt} type="button" className={option.startAt === newSlot ? 'active' : ''} onClick={() => setNewSlot(option.startAt)}>{option.label}</button>)}</div> : <p>No available times on this date.</p>}<button type="submit" className="admin-primary" disabled={!newSlot || busy}>{busy ? 'Moving…' : 'Save new time'}</button></form></section></div>}
  </>;
}
