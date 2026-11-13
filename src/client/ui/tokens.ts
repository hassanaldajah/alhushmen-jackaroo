/** Colour constants mirrored from tokens.css, shared with the 3D scene. */
export const tokens = {
  wood900: '#1E140D', wood800: '#2B1D12', wood700: '#3B2818', wood500: '#6B4A2B',
  felt700: '#3A2A0F', felt600: '#5B4216', felt500: '#8A6A26',
  brass300: '#E8CF8A', brass500: '#C9A24B', brass700: '#8F6F2A',
  cream50: '#FAF3E3', cream200: '#E6D9BC', ink900: '#1A1410',
  ruby500: '#B3322E', ok500: '#E8CF8A', warn500: '#E0A030',
  teamA: '#FFD54A', teamB: '#4DB2FF',
  marblesA: ['#FFD54A', '#FFE27A', '#F2C23A', '#FFF0B0'],
  marblesB: ['#4DB2FF', '#7CC8FF', '#2F9BF0', '#A8DCFF'],
} as const;

export function reducedMotion(): boolean {
  const o = document.documentElement.dataset.motion;
  if (o === 'reduce') return true;
  if (o === 'full') return false;
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}
