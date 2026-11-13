// Mirror of docs/design.md section 1 tokens (hex numbers for three.js).
// TODO: replace with the shared tokens.ts exported from the ui layer once it exists.
export const C = {
  wood900: 0x1e140d, wood800: 0x2b1d12, wood700: 0x3b2818, wood500: 0x6b4a2b,
  felt700: 0x12452f, felt600: 0x1b5e3f, felt500: 0x2a7a55,
  brass300: 0xe8cf8a, brass500: 0xc9a24b, brass700: 0x8f6f2a,
  cream50: 0xfaf3e3, cream200: 0xe6d9bc, ink900: 0x1a1410,
  ruby500: 0xb3322e, ok500: 0x4caf7a,
} as const;

export const CSS = {
  cream50: '#FAF3E3', ink900: '#1A1410', ruby500: '#B3322E', felt700: '#12452F',
  felt600: '#1B5E3F', felt500: '#2A7A55', brass500: '#C9A24B', brass300: '#E8CF8A',
  ok500: '#4CAF7A', wood700: '#3B2818', wood500: '#6B4A2B', wood900: '#1E140D',
} as const;

/** Marble color per seat (design.md: team A seats 0,2 / team B seats 1,3). */
export const SEAT_COLORS: readonly number[] = [0xd9a441, 0x3fa7a0, 0xf2d27a, 0x7ad1ca];
