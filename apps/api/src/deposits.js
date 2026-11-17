export function depositPercent(config) {
  const value = Number(config.BOOKING_DEPOSIT_PERCENT || 0);
  if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error('BOOKING_DEPOSIT_PERCENT must be between 0 and 100.');
  return value;
}

export function depositAmountCents(servicePrice, percent) {
  return percent > 0 ? Math.max(0, Math.round(Number(servicePrice) * 100 * percent / 100)) : 0;
}
