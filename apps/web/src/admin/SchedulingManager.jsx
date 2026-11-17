import { useEffect, useState } from 'react';
import { CalendarOff, Clock3, Plus, Save, Trash2 } from 'lucide-react';

const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const nextDate = () => { const value = new Date(); value.setDate(value.getDate() + 1); return value.toISOString().slice(0, 10); };
const blankException = () => ({ date: nextDate(), closed: true, startTime: '09:00', endTime: '17:00' });

export default function SchedulingManager({ staff, onSave, notify }) {
  const [selected, setSelected] = useState(staff[0]?.id || '');
  const person = staff.find((p) => p.id === selected);
  const [breaks, setBreaks] = useState([]);
  const [exception, setException] = useState(blankException);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setBreaks(person?.breaks || []); }, [person?.id, person?.breaks]);
  useEffect(() => { if (!person && staff.length) setSelected(staff[0].id); }, [person, staff]);

  async function update(changes, message) {
    if (!person) return;
    setSaving(true);
    try { const { id, ...base } = person; await onSave({ ...base, ...changes }, id); notify(message); }
    catch (error) { notify(error.message); }
    finally { setSaving(false); }
  }
  function addException(event) {
    event.preventDefault();
    const updated = (person.exceptions || []).filter((item) => item.date !== exception.date);
    updated.push(exception.closed ? { date: exception.date, closed: true } : { date: exception.date, closed: false, startTime: exception.startTime, endTime: exception.endTime });
    update({ exceptions: updated.sort((a, b) => a.date.localeCompare(b.date)) }, 'Schedule exception saved.');
  }
  return <>
    <div className="admin-page-title"><div><div className="admin-accent"/><h1>Scheduling & leave</h1><p>Set recurring breaks, holidays, personal leave, and special opening hours.</p></div></div>
    <div className="admin-schedule-grid">
      <section className="admin-block"><div className="admin-block-heading"><h2>Specialist</h2><Clock3 size={20}/></div><label className="admin-schedule-select">Choose a team member<select value={selected} onChange={(e) => setSelected(e.target.value)}>{staff.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        {person ? <><p className="admin-schedule-summary">Regular hours: {person.startTime}–{person.endTime} · {(person.workDays || []).map((d) => dayNames[d]).join(', ')}</p><h3>Recurring daily breaks</h3><p className="admin-helper">These breaks apply on all regular workdays. Open-date exceptions use them too.</p>{breaks.map((pause, index) => <div className="admin-schedule-break" key={index}><label>From<input type="time" step="900" value={pause.startTime} onChange={(e) => setBreaks((previous) => previous.map((item, i) => i === index ? { ...item, startTime: e.target.value } : item))}/></label><label>Until<input type="time" step="900" value={pause.endTime} onChange={(e) => setBreaks((previous) => previous.map((item, i) => i === index ? { ...item, endTime: e.target.value } : item))}/></label><button type="button" aria-label={`Remove break ${index + 1}`} onClick={() => setBreaks((previous) => previous.filter((_item, i) => i !== index))}><Trash2 size={17}/></button></div>)}<div className="admin-schedule-actions"><button type="button" className="admin-outline" onClick={() => setBreaks((previous) => previous.length >= 8 ? previous : [...previous, { startTime: '12:00', endTime: '12:30' }])}><Plus size={16}/> Add break</button><button type="button" className="admin-primary" disabled={saving} onClick={() => update({ breaks }, 'Recurring breaks saved.')}><Save size={16}/> Save breaks</button></div></> : <p>No active specialists.</p>}
      </section>
      <section className="admin-block"><div className="admin-block-heading"><h2>Special dates</h2><CalendarOff size={20}/></div><p className="admin-helper">Close a date for a holiday or time off, or open a date with different hours. Existing reservations must be moved before conflicting changes are accepted.</p><form className="admin-schedule-exception-form" onSubmit={addException}><label>Date<input type="date" required value={exception.date} onChange={(e) => setException((previous) => ({ ...previous, date: e.target.value }))}/></label><label>Availability<select value={exception.closed ? 'closed' : 'open'} onChange={(e) => setException((previous) => ({ ...previous, closed: e.target.value === 'closed' }))}><option value="closed">Closed / time off</option><option value="open">Special opening hours</option></select></label>{!exception.closed && <div className="admin-schedule-break"><label>Open<input type="time" required step="900" value={exception.startTime} onChange={(e) => setException((previous) => ({ ...previous, startTime: e.target.value }))}/></label><label>Close<input type="time" required step="900" value={exception.endTime} onChange={(e) => setException((previous) => ({ ...previous, endTime: e.target.value }))}/></label></div>}<button type="submit" className="admin-primary" disabled={saving || !person}><Plus size={16}/> Add or update date</button></form>
        <div className="admin-schedule-exceptions"><h3>Saved exceptions</h3>{(person?.exceptions || []).length ? [...person.exceptions].sort((a, b) => a.date.localeCompare(b.date)).map((item) => <div className="admin-schedule-exception" key={item.date}><div><strong>{new Date(`${item.date}T12:00:00Z`).toLocaleDateString('en-US', { dateStyle: 'medium', timeZone: 'UTC' })}</strong><p>{item.closed ? 'Closed / time off' : `${item.startTime}–${item.endTime}`}</p></div><button type="button" disabled={saving} aria-label={`Remove exception on ${item.date}`} onClick={() => update({ exceptions: person.exceptions.filter((a) => a.date !== item.date) }, 'Schedule exception removed.')}><Trash2 size={18}/></button></div>) : <p className="admin-muted">No special dates yet.</p>}</div>
      </section>
    </div>
  </>;
}
