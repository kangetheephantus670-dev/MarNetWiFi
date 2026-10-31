// Maps a plan's duration label to how long a session should last.
// Prefer a numeric duration_minutes value when available; fall back to the
// label parser so "5 hrs" and "5 hours" are normalized correctly.
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function durationMinutesFromLabel(value) {
  if (!value || typeof value !== 'string') return null;

  const s = value.trim().toLowerCase();
  const match = s.match(/(\d+)\s*(minute|min|minutes|mins|hr|hrs|hour|hours|h|day|days|d|week|weeks|w|month|months|mo)/);
  if (!match) return null;

  const amount = Number(match[1]);
  const unit = match[2];

  switch (unit) {
    case 'min':
    case 'minute':
    case 'minutes':
    case 'mins':
      return amount;
    case 'h':
    case 'hr':
    case 'hrs':
    case 'hour':
    case 'hours':
      return amount * 60;
    case 'd':
    case 'day':
    case 'days':
      return amount * 24 * 60;
    case 'w':
    case 'week':
    case 'weeks':
      return amount * 7 * 24 * 60;
    case 'mo':
    case 'month':
    case 'months':
      return amount * 30 * 24 * 60;
    default:
      return null;
  }
}

function durationToMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value * MINUTE;
  }

  if (typeof value === 'string') {
    const minutes = durationMinutesFromLabel(value);
    if (minutes != null) return minutes * MINUTE;
  }

  // Never silently turn an unknown duration into 1 hour.
  return 1 * HOUR;
}

module.exports = {
  durationToMs,
  durationMinutesFromLabel,
  MINUTE,
  HOUR,
  DAY,
};
