/** Colour constants mirrored from tokens.css, shared with the 3D scene. */
export const tokens = {
  wood900: '#1E140D', wood800: '#2B1D12', wood700: '#3B2818', wood500: '#6B4A2B',
  felt700: '#3A2A0F', felt600: '#5B4216', felt500: '#8A6A26',
  brass300: '#E8CF8A', brass500: '#C9A24B', brass700: '#8F6F2A',
  cream50: '#FAF3E3', cream200: '#E6D9BC', ink900: '#1A1410',
  ruby500: '#B3322E', ok500: '#E8CF8A', warn500: '#E0A030',
  teamA: '#D9A441', teamB: '#C9CED6',
  marblesA: ['#D9A441', '#F2D27A', '#A9791C', '#FFE9A8'],
  marblesB: ['#C9CED6', '#E6E9EE', '#9AA1AB', '#F4F6F8'],
} as const;

export function reducedMotion(): boolean {
  const o = document.documentElement.dataset.motion;
  if (o === 'reduce') return true;
  if (o === 'full') return false;
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}
