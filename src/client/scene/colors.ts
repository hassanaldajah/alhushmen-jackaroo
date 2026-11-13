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

/** Marble color per seat (team A seats 0,2 gold tones / team B seats 1,3 pearl-silver tones, as in tokens.css). */
export const SEAT_COLORS: readonly number[] = [0xd9a441, 0xb9c0ca, 0xf2c25a, 0xe2e6ec];
