import { randomUUID } from 'node:crypto';

const labels = {
  requested: ['Appointment request received', 'We received your appointment request and will confirm it soon.'],
  confirmed: ['Your appointment is confirmed', 'Your salon appointment has been confirmed.'],
  rescheduled: ['Appointment time changed', 'Your appointment has been moved. The salon will confirm the new time.'],
  cancelled: ['Appointment cancelled', 'Your salon appointment has been cancelled.'],
  reminder: ['Your salon appointment is tomorrow', 'A reminder about your upcoming salon appointment.'],
};

function formatWhen(appointment) {
  return new Date(appointment.startAt).toLocaleString('en-US', { timeZone: appointment.timeZone || 'America/New_York', dateStyle: 'full', timeStyle: 'short' });
}

function makeJob(appointment, kind, sendAt) {
  const [subject, intro] = labels[kind];
  return {
    id: randomUUID(), appointmentId: appointment.id, kind, status: 'pending', attempts: 0,
    sendAt, startAt: appointment.startAt, email: appointment.customerEmail,
    subject, text: `${intro}\n\nService: ${appointment.serviceName}\nSpecialist: ${appointment.staffName}\nWhen: ${formatWhen(appointment)}\n\nThank you for choosing our salon.`,
    createdAt: new Date().toISOString(),
  };
}

export async function queueBookingEmails(store, appointment, kind) {
  const jobs = [makeJob(appointment, kind, new Date().toISOString())];
  if (appointment.status !== 'cancelled' && appointment.status !== 'completed') {
    const reminderAt = Date.parse(appointment.startAt) - 24 * 60 * 60 * 1000;
    if (reminderAt > Date.now()) jobs.push(makeJob(appointment, 'reminder', new Date(reminderAt).toISOString()));
  }
  await store.replaceAppointmentNotifications(appointment.id, jobs);
}

export async function processDueEmails(store, config, send = fetch) {
  if (!config.RESEND_API_KEY || !config.SALON_EMAIL_FROM) return { configured: false, processed: 0 };
  let processed = 0;
  for (let i = 0; i < 10; i++) {
    const job = await store.claimDueNotification(new Date().toISOString());
    if (!job) break;
    const appointment = await store.getAppointment(job.appointmentId);
    if (!appointment || (job.kind === 'reminder' && (!['requested', 'confirmed'].includes(appointment.status) || appointment.startAt !== job.startAt))) {
      await store.finishNotification(job.id, 'skipped');
      continue;
    }
    try {
      const response = await send('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': job.id },
        body: JSON.stringify({ from: config.SALON_EMAIL_FROM, to: [job.email], subject: job.subject, text: job.text }),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error(`Email provider HTTP ${response.status}`);
      const result = await response.json();
      await store.finishNotification(job.id, 'sent', result.id);
      processed++;
    } catch (error) {
      // Retry transient provider/network failures with a capped backoff; never log addresses or credentials.
      const attempts = (job.attempts || 0) + 1;
      await store.finishNotification(job.id, attempts >= 6 ? 'failed' : 'pending', '', `Attempt ${attempts}: ${error.message}`, new Date(Date.now() + Math.min(60, 2 ** attempts) * 60_000).toISOString());
    }
  }
  return { configured: true, processed };
}
