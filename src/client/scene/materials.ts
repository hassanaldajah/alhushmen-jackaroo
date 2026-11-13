// Original procedural PBR inputs (no downloads). Listed as "original" in docs/assets.md.
import {
  BackSide, BoxGeometry, CanvasTexture, Color, LinearFilter, LinearMipmapLinearFilter, Mesh, MeshBasicMaterial,
  NoColorSpace, PMREMGenerator, RepeatWrapping, Scene, SRGBColorSpace, Texture, WebGLRenderer,
} from 'three';
import { CSS } from './colors';

function cv2d(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');
  return [cv, ctx];
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function tiled(cv: HTMLCanvasElement, srgb: boolean, repeat: number): CanvasTexture {
  const t = new CanvasTexture(cv);
  t.wrapS = t.wrapT = RepeatWrapping; t.repeat.set(repeat, repeat);
  t.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
  t.anisotropy = 4;
  t.minFilter = LinearMipmapLinearFilter; t.magFilter = LinearFilter;
  return t;
}

export interface PbrMaps { map: CanvasTexture; bump: CanvasTexture }

/** Dark walnut: long wavy grain, albedo + bump from the same strokes. */
export function woodMaps(size: number): PbrMaps {
  const draw = (ctx: CanvasRenderingContext2D, bump: boolean) => {
    const r = rng(7);
    ctx.fillStyle = bump ? '#808080' : CSS.wood700; ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < size * 1.4; i++) {
      const y = r() * size, len = size * (0.3 + r() * 0.7), x0 = r() * size, amp = 1 + r() * 4, ph = r() * 6.28;
      const tone = r();
      ctx.globalAlpha = 0.05 + r() * 0.16;
      ctx.strokeStyle = bump ? (tone > 0.5 ? '#ffffff' : '#000000') : (tone > 0.55 ? CSS.wood500 : tone > 0.2 ? CSS.wood900 : '#5a3b20');
      ctx.lineWidth = 0.6 + r() * 1.8;
      ctx.beginPath();
      for (let s = 0; s <= 8; s++) { const x = x0 + (len * s) / 8; const yy = y + Math.sin(ph + s * 0.9) * amp; if (s) ctx.lineTo(x, yy); else ctx.moveTo(x, yy); }
      ctx.stroke();
      // wrap copy so the texture tiles horizontally
      if (x0 + len > size) { ctx.save(); ctx.translate(-size, 0); ctx.beginPath(); for (let s = 0; s <= 8; s++) { const x = x0 + (len * s) / 8; const yy = y + Math.sin(ph + s * 0.9) * amp; if (s) ctx.lineTo(x, yy); else ctx.moveTo(x, yy); } ctx.stroke(); ctx.restore(); }
    }
    ctx.globalAlpha = 1;
  };
  const [c1, x1] = cv2d(size, size); draw(x1, false);
  const [c2, x2] = cv2d(size, size); draw(x2, true);
  return { map: tiled(c1, true, 3), bump: tiled(c2, false, 3) };
}

/** Board cloth: fine coffee-brown leather/baize fibre noise (gold + brown palette, no green). */
export function feltMaps(size: number): PbrMaps {
  const r = rng(11);
  const [c1, x1] = cv2d(size, size);
  const [c2, x2] = cv2d(size, size);
  x1.fillStyle = CSS.felt600; x1.fillRect(0, 0, size, size);
  x2.fillStyle = '#808080'; x2.fillRect(0, 0, size, size);
  const tones = [CSS.felt500, CSS.felt700, '#24170d', '#6a4a2a'];
  for (let i = 0; i < size * size * 0.035; i++) {
    const x = r() * size, y = r() * size, l = 1 + r() * 3, a = r() > 0.5;
    x1.globalAlpha = 0.25 + r() * 0.3; x1.fillStyle = tones[i % 4] as string;
    x1.fillRect(x, y, a ? l : 1, a ? 1 : l);
    x2.globalAlpha = 0.3; x2.fillStyle = r() > 0.5 ? '#fff' : '#000';
    x2.fillRect(x, y, a ? l : 1, a ? 1 : l);
  }
  return { map: tiled(c1, true, 4), bump: tiled(c2, false, 4) };
}

/** 128x128 tangent-space swirl normal map shared by all marbles. */
export function swirlNormal(): CanvasTexture {
  const n = 128;
  const [cv, ctx] = cv2d(n, n);
  const h = new Float32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const u = x / n * Math.PI * 2, v = y / n * Math.PI * 2;
    h[y * n + x] = Math.sin(u * 2 + Math.sin(v * 3) * 1.6) * 0.5 + Math.sin(v * 2 + Math.cos(u * 2) * 1.4) * 0.5;
  }
  const img = ctx.createImageData(n, n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const dx = (h[y * n + ((x + 1) % n)] as number) - (h[y * n + ((x + n - 1) % n)] as number);
    const dy = (h[((y + 1) % n) * n + x] as number) - (h[((y + n - 1) % n) * n + x] as number);
    const nx = -dx * 0.35, ny = -dy * 0.35, l = Math.hypot(nx, ny, 1);
    const i = (y * n + x) * 4;
    img.data[i] = ((nx / l) * 0.5 + 0.5) * 255; img.data[i + 1] = ((ny / l) * 0.5 + 0.5) * 255; img.data[i + 2] = ((1 / l) * 0.5 + 0.5) * 255; img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new CanvasTexture(cv);
  t.wrapS = t.wrapT = RepeatWrapping; t.colorSpace = NoColorSpace;
  return t;
}

/** Out-of-focus café backdrop: warm gradient with 12 bokeh discs. */
export function bokehTexture(): CanvasTexture {
  const [cv, ctx] = cv2d(1024, 512);
  const g = ctx.createLinearGradient(0, 0, 0, 512);
  g.addColorStop(0, '#2a1a0e'); g.addColorStop(0.55, '#4a2f18'); g.addColorStop(1, '#1e140d');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 1024, 512);
  const r = rng(3);
  const cols = ['255,200,120', '255,170,80', '255,225,170', '230,150,70'];
  for (let i = 0; i < 12; i++) {
    const x = r() * 1024, y = 60 + r() * 330, rad = 30 + r() * 60;
    const rg = ctx.createRadialGradient(x, y, 0, x, y, rad);
    const c = cols[i % 4] as string;
    rg.addColorStop(0, `rgba(${c},0.55)`); rg.addColorStop(0.7, `rgba(${c},0.35)`); rg.addColorStop(1, `rgba(${c},0)`);
    ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(x, y, rad, 0, 6.2832); ctx.fill();
  }
  const t = new CanvasTexture(cv); t.colorSpace = SRGBColorSpace;
  return t;
}

/** Brass eight-point star inlay for the four empty board corners (transparent background). */
export function starTexture(): CanvasTexture {
  const n = 256;
  const [cv, ctx] = cv2d(n, n);
  const c = n / 2;
  const star = (r1: number, r2: number) => {
    ctx.beginPath();
    for (let i = 0; i < 16; i++) { const a = (i / 16) * Math.PI * 2 - Math.PI / 2, r = i % 2 ? r2 : r1; ctx.lineTo(c + Math.cos(a) * r, c + Math.sin(a) * r); }
    ctx.closePath();
  };
  ctx.lineJoin = 'round';
  star(118, 58); ctx.fillStyle = 'rgba(201,162,75,0.16)'; ctx.fill(); ctx.strokeStyle = 'rgba(232,207,138,0.55)'; ctx.lineWidth = 4; ctx.stroke();
  star(70, 34); ctx.strokeStyle = 'rgba(201,162,75,0.5)'; ctx.lineWidth = 3; ctx.stroke();
  ctx.beginPath(); ctx.arc(c, c, 14, 0, Math.PI * 2); ctx.fillStyle = 'rgba(232,207,138,0.6)'; ctx.fill();
  const t = new CanvasTexture(cv); t.colorSpace = SRGBColorSpace;
  return t;
}

/** 64x64 soft round alpha sprite (steam, contact blobs). */
export function softCircleTexture(): CanvasTexture {
  const [cv, ctx] = cv2d(64, 64);
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,0.9)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
  const t = new CanvasTexture(cv); t.colorSpace = SRGBColorSpace;
  return t;
}

/** Warm interior lit by hanging lamps, baked to PMREM (replaces a downloaded HDRI). size 256 = high, 64 = low. */
export function buildEnvironment(renderer: WebGLRenderer, size: number): Texture {
  const s = new Scene();
  const room = new Mesh(new BoxGeometry(40, 20, 40), new MeshBasicMaterial({ color: new Color('#6b4a2b').multiplyScalar(0.55), side: BackSide }));
  room.position.y = 6;
  s.add(room);
  const lamp = new MeshBasicMaterial({ color: new Color('#ffd9a0').multiplyScalar(14) });
  const win = new MeshBasicMaterial({ color: new Color('#ffe9c8').multiplyScalar(5) });
  const add = (w: number, h: number, d: number, x: number, y: number, z: number, m: MeshBasicMaterial) => {
    const b = new Mesh(new BoxGeometry(w, h, d), m); b.position.set(x, y, z); s.add(b);
  };
  add(5, 0.4, 5, 0, 15, 0, lamp);
  add(3, 3, 0.3, -9, 7, -19, lamp); add(3, 3, 0.3, 9, 7, -19, lamp);
  add(8, 5, 0.3, 0, 7, 19.5, win);
  add(0.3, 6, 8, -19.5, 6, 0, win);
  const pm = new PMREMGenerator(renderer);
  const rt = pm.fromScene(s, 0.04, 0.1, 100, { size });
  pm.dispose();
  s.traverse((o) => { const m = o as Mesh; if (m.geometry) m.geometry.dispose(); const mat = m.material as MeshBasicMaterial | undefined; mat?.dispose(); });
  return rt.texture;
}
