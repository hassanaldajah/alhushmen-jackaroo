/** Marbles must stand out from the coffee-brown board (owner) and match the UI team colours. No green. */
import { describe, expect, it } from 'vitest';
import { C, SEAT_COLORS, TEAM_A, TEAM_B } from '../../src/client/scene/colors';
import { tokens } from '../../src/client/ui/tokens';

const lin = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const lum = (hex: number) => 0.2126 * lin((hex >> 16) & 255) + 0.7152 * lin((hex >> 8) & 255) + 0.0722 * lin(hex & 255);
const ratio = (a: number, b: number) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number]; return (x + 0.05) / (y + 0.05); };
function hue(hex: number): number {
  const r = ((hex >> 16) & 255) / 255, g = ((hex >> 8) & 255) / 255, b = (hex & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (!d) return -1;
  const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

describe('marble colours', () => {
  const boards = [C.felt700, C.felt600, C.felt500, 0x5b4216]; // 3D board leather tones + the UI board token
  it('every seat colour has >= 3:1 (WCAG-style) contrast against every board tone', () => {
    for (const s of SEAT_COLORS) for (const b of boards) expect(ratio(s, b)).toBeGreaterThanOrEqual(3);
  });
  it('the two teams differ clearly in hue (gold vs blue), and nothing is green', () => {
    const d = Math.abs(hue(TEAM_A) - hue(TEAM_B));
    expect(Math.min(d, 360 - d)).toBeGreaterThan(120);
    for (const s of SEAT_COLORS) { const h = hue(s); expect(h < 75 || h > 165).toBe(true); }
  });
  it('the UI team tokens (tokens.ts, mirror of tokens.css) use the same colours as the 3D marbles', () => {
    const hex = (n: number) => '#' + n.toString(16).toUpperCase().padStart(6, '0');
    expect([tokens.teamA, tokens.teamB]).toEqual([hex(TEAM_A), hex(TEAM_B)]);
  });
});
