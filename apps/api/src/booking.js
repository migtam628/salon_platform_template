export const SLOT_MINUTES = 15;
export const MAX_BOOKING_DAYS = 90;
export const DEFAULT_TIME_ZONE = 'America/New_York';
const activeStatuses = new Set(['requested', 'confirmed']);
const formatters = new Map();

function formatter(timeZone) {
  if (!formatters.has(timeZone)) formatters.set(timeZone, new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }));
  return formatters.get(timeZone);
}

export function localParts(instant, timeZone) {
  const pairs = formatter(timeZone).formatToParts(new Date(instant));
  const obj = Object.fromEntries(pairs.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
  return { date: `${obj.year}-${String(obj.month).padStart(2, '0')}-${String(obj.day).padStart(2, '0')}`,
    dayOfWeek: new Date(Date.UTC(obj.year, obj.month - 1, obj.day)).getUTCDay(),
    hour: obj.hour, minute: obj.minute, year: obj.year, month: obj.month, day: obj.day };
}

export function zonedToUtc(date, time, timeZone = DEFAULT_TIME_ZONE) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  if (hour > 23 || minute > 59 || new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) !== date) return null;
  const desired = Date.UTC(year, month - 1, day, hour, minute);
  let candidate = desired;
  for (let i = 0; i < 4; i++) {
    const parts = localParts(candidate, timeZone);
    const current = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    const difference = desired - current;
    candidate += difference;
    if (!difference) break;
  }
  const actual = localParts(candidate, timeZone);
  return actual.date === date && actual.hour === hour && actual.minute === minute ? new Date(candidate) : null;
}

export function occupiedSlots(startAt, durationMinutes) {
  const start = new Date(startAt).getTime();
  if (!Number.isFinite(start) || start % (SLOT_MINUTES * 60000) !== 0 || durationMinutes % SLOT_MINUTES !== 0) return [];
  return Array.from({ length: durationMinutes / SLOT_MINUTES }, (_, index) => new Date(start + index * SLOT_MINUTES * 60000).toISOString());
}

export function bookingError(startAt, service, stylist, options = {}) {
  const timeZone = options.timeZone || DEFAULT_TIME_ZONE;
  const leadMinutes = Number(options.leadMinutes ?? 60);
  const start = new Date(startAt).getTime();
  if (!Number.isFinite(start) || start < Date.now() + leadMinutes * 60000) return 'Choose an available future appointment time.';
  if (start > Date.now() + MAX_BOOKING_DAYS * 86400000) return 'Appointments can only be booked up to 90 days ahead.';
  if (!service || service.active === false || !stylist || stylist.active === false || !stylist.specialties.includes(service.category)) return 'Choose an active service and specialist.';
  if (!occupiedSlots(startAt, service.durationMinutes).length) return 'Appointments must start on a 15-minute boundary.';
  const parts = localParts(start, timeZone);
  if (!(stylist.workDays || [1, 2, 3, 4, 5]).includes(parts.dayOfWeek)) return 'The specialist does not work on this date.';
  const startMinutes = parts.hour * 60 + parts.minute;
  const [openHour, openMinute] = (stylist.startTime || '09:00').split(':').map(Number);
  const [closeHour, closeMinute] = (stylist.endTime || '17:00').split(':').map(Number);
  if (startMinutes < openHour * 60 + openMinute || startMinutes + service.durationMinutes > closeHour * 60 + closeMinute) return 'The requested treatment does not fit within the specialist’s hours.';
  return null;
}

export function overlaps(first, second) {
  if (first.staffId !== second.staffId || !activeStatuses.has(first.status) || !activeStatuses.has(second.status)) return false;
  const a = new Set(first.occupiedSlots?.length ? first.occupiedSlots : occupiedSlots(first.startAt, first.durationMinutes));
  return (second.occupiedSlots?.length ? second.occupiedSlots : occupiedSlots(second.startAt, second.durationMinutes)).some((slot) => a.has(slot));
}

export function dailyAvailability({ service, stylist, date, appointments = [], timeZone = DEFAULT_TIME_ZONE, leadMinutes = 60, excludingId }) {
  const validDate = zonedToUtc(date, '12:00', timeZone);
  if (!validDate) return { date, timeZone, durationMinutes: service.durationMinutes, slots: [] };
  const dayOfWeek = localParts(validDate, timeZone).dayOfWeek;
  if (!(stylist.workDays || [1, 2, 3, 4, 5]).includes(dayOfWeek) || stylist.active === false || service.active === false || !stylist.specialties.includes(service.category)) return { date, timeZone, durationMinutes: service.durationMinutes, slots: [] };
  const startMinutes = (stylist.startTime || '09:00').split(':').map(Number).reduce((h, m) => h * 60 + m);
  const endMinutes = (stylist.endTime || '17:00').split(':').map(Number).reduce((h, m) => h * 60 + m);
  const slots = [];
  for (let minute = startMinutes; minute + service.durationMinutes <= endMinutes; minute += SLOT_MINUTES) {
    const hhmm = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
    const utc = zonedToUtc(date, hhmm, timeZone);
    if (!utc || utc.getTime() < Date.now() + leadMinutes * 60000 || utc.getTime() > Date.now() + MAX_BOOKING_DAYS * 86400000) continue;
    const proposed = { staffId: stylist.id, startAt: utc.toISOString(), durationMinutes: service.durationMinutes, status: 'requested', occupiedSlots: occupiedSlots(utc.toISOString(), service.durationMinutes) };
    if (appointments.some((a) => a.id !== excludingId && overlaps(a, proposed))) continue;
    slots.push({ startAt: utc.toISOString(), label: new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit', hour12: true }).format(utc) });
  }
  return { date, timeZone, durationMinutes: service.durationMinutes, slots };
}
