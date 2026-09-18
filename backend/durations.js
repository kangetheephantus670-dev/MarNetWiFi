// Maps a plan's duration label to how long a session should last.
// Keep these labels in sync with the "duration" column in the plans
// table (and with what marnet-portal.html sends as activePlan.d).
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

module.exports = {
  '30 min': 30 * MINUTE,
  '1 hr': 1 * HOUR,
  '3 hrs': 3 * HOUR,
  '12 hrs': 12 * HOUR,
  '24 hrs': 24 * HOUR,
  '3 days': 3 * DAY,
  '1 week': 7 * DAY,
  '2 weeks': 14 * DAY,
  '1 month': 30 * DAY,
};
