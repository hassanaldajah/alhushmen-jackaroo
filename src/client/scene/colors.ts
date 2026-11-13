// Mirror of the design tokens (hex numbers for three.js). Gold + brown only: no green anywhere.
export const C = {
  wood900: 0x1e140d, wood800: 0x2b1d12, wood700: 0x3b2818, wood500: 0x6b4a2b,
  // Board cloth: deep coffee leather (was green felt).
  felt700: 0x2a1b10, felt600: 0x3d2817, felt500: 0x5a3d22,
  brass300: 0xe8cf8a, brass500: 0xc9a24b, brass700: 0x8f6f2a,
  cream50: 0xfaf3e3, cream200: 0xe6d9bc, ink900: 0x1a1410,
  ruby500: 0xb3322e, ok500: 0xe8cf8a,
} as const;

export const CSS = {
  cream50: '#FAF3E3', ink900: '#1A1410', ruby500: '#B3322E', felt700: '#2A1B10',
  felt600: '#3D2817', felt500: '#5A3D22', brass500: '#C9A24B', brass300: '#E8CF8A', brass700: '#8F6F2A',
  ok500: '#E8CF8A', wood700: '#3B2818', wood500: '#6B4A2B', wood900: '#1E140D',
} as const;

/**
 * Marble color per seat, chosen to stand out from the coffee-brown board (owner: "the opposite of the table"):
 * team A (seats 0,2) bright lemon gold, team B (seats 1,3) vivid sky blue. Both >= 4:1 contrast against the
 * board (tests/client/colors.test.ts). Same values as --team-a / --team-b in tokens.css. No green anywhere.
 */
export const TEAM_A = 0xffd54a, TEAM_B = 0x4db2ff;
export const SEAT_COLORS: readonly number[] = [TEAM_A, TEAM_B, 0xffe27a, 0x7cc8ff];
