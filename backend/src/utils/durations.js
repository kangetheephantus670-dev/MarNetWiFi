// Maps a plan's duration label to how long a session should last.
// Accepts "5 hr", "5 hrs", "5 hours", "5h", "1 hr", etc.
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function durationToMs(value) {
  if (!value || typeof value !== 'string') {
    return 1 * HOUR;
  }

  const s = value.trim().toLowerCase();

  // handle common variants
  const match = s.match(/(\d+)\s*(minute|min|minutes|mins|hr|hrs|hour|hours|h|day|days|d|week|weeks|w|month|months|mo)/);
  if (!match) {
    return 1 * HOUR;
  }

  const amount = Number(match[1]);
  const unit = match[2];

  switch (unit) {
    case 'min':
    case 'minute':
    case 'minutes':
    case 'mins':
      return amount * MINUTE;
    case 'h':
    case 'hr':
    case 'hrs':
    case 'hour':
    case 'hours':
      return amount * HOUR;
    case 'd':
    case 'day':
    case 'days':
      return amount * DAY;
    case 'w':
    case 'week':
    case 'weeks':
      return amount * 7 * DAY;
    case 'mo':
    case 'month':
    case 'months':
      return amount * 30 * DAY;
    default:
      return 1 * HOUR;
  }
}

module.exports = {
  durationToMs,
  MINUTE,
  HOUR,
  DAY,
};
