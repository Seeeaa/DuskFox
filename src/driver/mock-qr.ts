import crypto from 'node:crypto';

const MODULES = 29;
const PIXELS = 8;

/** Deterministic pseudo random generator so a code is stable for one payload. */
function seeded(seed: string): () => number {
  let state = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    state ^= seed.charCodeAt(index);
    state = Math.imul(state, 16777619);
  }
  return () => {
    state = Math.imul(state ^ (state >>> 15), 2246822507) >>> 0;
    return (state >>> 8) / 0x1000000;
  };
}

function finder(x: number, y: number): boolean {
  for (let row = 0; row < 7; row += 1) {
    for (let column = 0; column < 7; column += 1) {
      const edge = row === 0 || column === 0 || row === 6 || column === 6;
      const core = row > 1 && row < 5 && column > 1 && column < 5;
      if (edge || core) {
        // Return true only for the module we are currently testing.
        if (x - row === 0 && y - column === 0) return true;
      }
    }
  }
  return false;
}

function inFinder(moduleX: number, moduleY: number): boolean {
  const zones: Array<[number, number]> = [
    [0, 0],
    [MODULES - 8, 0],
    [0, MODULES - 8],
  ];
  return zones.some(([x, y]) => moduleX >= x && moduleX < x + 8 && moduleY >= y && moduleY < y + 8);
}

function finderAt(moduleX: number, moduleY: number): boolean {
  for (const [ox, oy] of [[0, 0], [MODULES - 7, 0], [0, MODULES - 7]] as const) {
    const x = moduleX - ox;
    const y = moduleY - oy;
    if (x >= 0 && x < 7 && y >= 0 && y < 7) return finder(x, y);
  }
  return false;
}

/**
 * Synthetic QR-like image for the mock driver.
 *
 * It is intentionally *not* a scannable code: the mock driver has no account to
 * log into, and pretending otherwise would mislead operators. The console labels
 * it as simulated whenever the driver is `mock`.
 */
export function syntheticQr(seed: string): { svg: string; dataUrl: string; token: string } {
  const token = crypto.createHash('sha256').update(seed).digest('hex').slice(0, 16).toUpperCase();
  const next = seeded(seed);
  const size = MODULES * PIXELS;
  const parts: string[] = [];
  for (let y = 0; y < MODULES; y += 1) {
    for (let x = 0; x < MODULES; x += 1) {
      let filled: boolean;
      if (inFinder(x, y)) filled = finderAt(x, y);
      else filled = next() > 0.52;
      if (filled) parts.push(`M${x * PIXELS} ${y * PIXELS}h${PIXELS}v${PIXELS}h-${PIXELS}z`);
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#ffffff"/><path d="${parts.join('')}" fill="#0d0d0d"/></svg>`;
  const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
  return { svg, dataUrl, token };
}
