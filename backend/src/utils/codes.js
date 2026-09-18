// Excludes visually ambiguous characters (0/O, 1/I/L) so printed vouchers
// are easy to read and type back in correctly.
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomCode(prefix = 'MN', length = 6) {
  let out = prefix;
  for (let i = 0; i < length; i++) {
    out += CHARS[Math.floor(Math.random() * CHARS.length)];
  }
  return out;
}

module.exports = { randomCode };
