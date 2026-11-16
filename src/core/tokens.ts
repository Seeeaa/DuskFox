import crypto from 'node:crypto';

/** Generate a URL safe bearer token with 192 bits of entropy. */
export function createToken(bytes = 24): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Constant time comparison that never short-circuits on length. */
export function tokenEquals(a: string, b: string): boolean {
  const left = Buffer.from(a ?? '', 'utf8');
  const right = Buffer.from(b ?? '', 'utf8');
  if (left.length !== right.length) {
    // Still touch both buffers so the timing difference does not leak length.
    crypto.timingSafeEqual(left, left);
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

/** Short, stable, human readable identifier for config entries. */
export function createId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(4).toString('hex')}`;
}
