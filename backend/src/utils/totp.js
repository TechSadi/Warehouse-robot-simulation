const crypto = require('crypto');

/**
 * RFC 6238 TOTP (and the RFC 4226 HOTP underneath it), implemented on
 * node:crypto.
 *
 * No dependency: this is an HMAC, a truncation and a base32 codec, and a
 * second-factor implementation is exactly the kind of thing worth being
 * able to read in full. Every choice below is the interoperable one, so
 * any standard authenticator app works against it:
 *
 *   SHA-1, 6 digits, 30-second step - what Google Authenticator, 1Password,
 *   Authy and the `otpauth://` URI default to. SHA-1 here is not a
 *   collision-resistance claim; HMAC-SHA-1's security does not rest on
 *   that, and deviating would silently break most authenticator apps.
 *
 * The two details that actually matter for security:
 *
 *  - **Comparison is constant time.** A code is only 6 digits; a timing
 *    oracle on the comparison would meaningfully help an attacker.
 *  - **A window, not a point.** Clocks drift, and a user typing a code as
 *    it rolls over would otherwise be told they are wrong. One step either
 *    side is the usual compromise; wider multiplies the guess space.
 *
 * Replay is *not* handled here - `verify` says only whether a code is
 * currently valid for a secret. The caller records the step it accepted so
 * the same code cannot be used twice (see services/authService.js).
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const DIGITS = 6;
const STEP_SECONDS = 30;

/** RFC 4648 base32, unpadded - the encoding authenticator apps expect for
 * the shared secret. */
function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(input) {
  const cleaned = String(input).toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error('secret is not valid base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** A fresh shared secret. 20 bytes is the RFC 4226 recommendation and what
 * authenticator apps are sized for. */
function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

/** The code for one counter value - HOTP. */
function hotp(secret, counter) {
  const key = base32Decode(secret);
  const buffer = Buffer.alloc(8);
  // Counters are well under 2^53, so writing the high half from a float
  // division is exact - but write both halves explicitly rather than
  // relying on a 64-bit write, which Node only offers for BigInt.
  buffer.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buffer.writeUInt32BE(counter >>> 0, 4);

  const digest = crypto.createHmac('sha1', key).update(buffer).digest();
  // Dynamic truncation (RFC 4226 §5.3): the low nibble of the last byte
  // picks where to read the 31-bit value from.
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];

  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

/** The current time step. Exposed so the caller can record which step it
 * accepted and refuse the same one twice. */
function currentStep(now = Date.now()) {
  return Math.floor(now / 1000 / STEP_SECONDS);
}

function generate(secret, now = Date.now()) {
  return hotp(secret, currentStep(now));
}

/**
 * Checks a user-supplied code against a secret.
 *
 * @returns {{valid: boolean, step?: number}} the accepted step, so the
 *   caller can reject a replay of the same code within its own window.
 */
function verify(secret, code, { window = 1, now = Date.now() } = {}) {
  if (typeof code !== 'string') return { valid: false };
  const candidate = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(candidate)) return { valid: false };

  const step = currentStep(now);
  for (let drift = -window; drift <= window; drift++) {
    if (timingSafeEqualString(hotp(secret, step + drift), candidate)) {
      return { valid: true, step: step + drift };
    }
  }
  return { valid: false };
}

function timingSafeEqualString(a, b) {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * The `otpauth://` URI an authenticator app scans. The label carries the
 * account so a user with several can tell them apart; the issuer is
 * repeated as a parameter because the label prefix alone is ignored by
 * some apps.
 */
function otpauthUri({ secret, account, issuer }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * Recovery codes - the answer to "my phone is gone".
 *
 * Returned once in plaintext and stored only as bcrypt digests by the
 * caller. Grouped into two blocks of five characters because these get
 * written down and typed back by hand, and an unbroken run of ten is
 * measurably worse at both.
 */
function generateRecoveryCodes(count = 10) {
  return Array.from({ length: count }, () => {
    const raw = base32Encode(crypto.randomBytes(7)).slice(0, 10);
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

module.exports = {
  DIGITS,
  STEP_SECONDS,
  base32Encode,
  base32Decode,
  generateSecret,
  generate,
  currentStep,
  verify,
  otpauthUri,
  generateRecoveryCodes,
};
