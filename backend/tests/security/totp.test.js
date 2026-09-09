/**
 * The TOTP implementation (src/utils/totp.js).
 *
 * Written on node:crypto rather than pulled in as a dependency, which
 * makes it exactly the kind of code that has to be pinned down by tests:
 * the failure mode of a subtly wrong HOTP is not an exception, it is a
 * second factor that quietly accepts codes it should not, or rejects every
 * code a real authenticator app produces.
 */
const crypto = require('crypto');
const totp = require('../../src/utils/totp');

describe('base32', () => {
  it('round-trips arbitrary bytes', () => {
    for (let length = 1; length <= 20; length++) {
      const bytes = crypto.randomBytes(length);
      expect(totp.base32Decode(totp.base32Encode(bytes)).equals(bytes)).toBe(true);
    }
  });

  it('produces only the RFC 4648 alphabet, unpadded', () => {
    // Authenticator apps expect exactly this: uppercase A-Z and 2-7, no
    // '=' padding.
    expect(totp.generateSecret()).toMatch(/^[A-Z2-7]+$/);
  });

  it('rejects a secret that is not base32', () => {
    expect(() => totp.base32Decode('not-base32!')).toThrow(/base32/);
  });
});

describe('RFC 6238 test vectors', () => {
  // The published SHA-1 vectors, truncated to 6 digits. Getting these
  // right is what makes any standard authenticator app work against this.
  const SECRET = totp.base32Encode(Buffer.from('12345678901234567890', 'ascii'));

  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ])('matches the published code at t=%i', (seconds, expected) => {
    expect(totp.generate(SECRET, seconds * 1000)).toBe(expected);
  });
});

describe('verify', () => {
  const secret = totp.generateSecret();

  it('accepts the current code', () => {
    expect(totp.verify(secret, totp.generate(secret)).valid).toBe(true);
  });

  it('absorbs a step of clock drift in either direction', () => {
    const step = totp.STEP_SECONDS * 1000;
    expect(totp.verify(secret, totp.generate(secret, Date.now() - step)).valid).toBe(true);
    expect(totp.verify(secret, totp.generate(secret, Date.now() + step)).valid).toBe(true);
  });

  it('refuses a code two steps out', () => {
    // A wider window is a linearly larger guess space for no real gain.
    const step = totp.STEP_SECONDS * 1000;
    expect(totp.verify(secret, totp.generate(secret, Date.now() + 2 * step)).valid).toBe(false);
  });

  it('reports which step it accepted, so a replay can be refused', () => {
    // The engine of the anti-replay rule: verify says *when*, and the
    // caller records it. See services/authService.js.
    const { valid, step } = totp.verify(secret, totp.generate(secret));
    expect(valid).toBe(true);
    expect(step).toBe(totp.currentStep());
  });

  it('refuses anything that is not six digits, without hashing it', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 56 78', null, undefined, 123456]) {
      // @ts-ignore - deliberately hostile input
      expect(totp.verify(secret, bad).valid).toBe(false);
    }
  });

  it('refuses a code from a different secret', () => {
    expect(totp.verify(secret, totp.generate(totp.generateSecret())).valid).toBe(false);
  });
});

describe('otpauth URI', () => {
  it('carries the parameters authenticator apps default to', () => {
    const uri = totp.otpauthUri({
      secret: 'ABCDEFGHIJKLMNOP',
      account: 'alice@example.com',
      issuer: 'warehouse-robot-simulation',
    });

    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toContain('algorithm=SHA1');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
    // The issuer is repeated as a parameter because some apps ignore the
    // label prefix.
    expect(uri).toContain('issuer=warehouse-robot-simulation');
    expect(uri).toContain(encodeURIComponent('warehouse-robot-simulation:alice@example.com'));
  });
});

describe('recovery codes', () => {
  it('generates the requested number, all distinct', () => {
    const codes = totp.generateRecoveryCodes(10);
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
  });

  it('formats them to be written down and typed back', () => {
    for (const code of totp.generateRecoveryCodes(5)) {
      expect(code).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
    }
  });
});
