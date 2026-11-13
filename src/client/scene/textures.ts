import { CanvasTexture, SRGBColorSpace, LinearMipmapLinearFilter, LinearFilter } from 'three';
import { CSS } from './colors';
import type { CardRef, Rank, Suit } from './types';

// Atlas: 2048x2048, 10 cols x 6 rows of 204x341 cells; the card art uses the top 204x290 of each cell.
const AW = 2048, COLS = 10, CW = 204, CH = 341, ART_H = 290;
const SUITS: Suit[] = ['S', 'H', 'D', 'C'];
const RANKS: Rank[] = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const GLYPH: Record<Suit, string> = { S: '♠', H: '♥', D: '♦', C: '♣' };
export const BACK_INDEX = 54;

export function faceIndex(c: CardRef | null): number {
  if (!c) return BACK_INDEX;
  if (c.suit === null || c.rank === 'JOKER') return 52 + (c.id.charCodeAt(c.id.length - 1) & 1);
  return SUITS.indexOf(c.suit) * 13 + RANKS.indexOf(c.rank);
}

/** [u0, v0, u1, v1] for a face index (v0 = bottom). */
export function atlasUV(index: number): [number, number, number, number] {
  const cx = index % COLS, cy = Math.floor(index / COLS);
  const x0 = cx * CW + 1, x1 = (cx + 1) * CW - 1;
  const y0 = cy * CH + 1, y1 = cy * CH + ART_H - 1;
  return [x0 / AW, 1 - y1 / AW, x1 / AW, 1 - y0 / AW];
}

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const FONT = 'Cairo, "Segoe UI", Arial, sans-serif';
const SYM = '"Segoe UI Symbol", "DejaVu Sans", "Arial Unicode MS", Arial, sans-serif';

function drawFace(ctx: CanvasRenderingContext2D, idx: number) {
  const w = CW, h = ART_H;
  rr(ctx, 1, 1, w - 2, h - 2, 24);
  if (idx === BACK_INDEX) {
    ctx.fillStyle = CSS.felt700; ctx.fill();
    ctx.save(); ctx.clip();
    ctx.strokeStyle = CSS.brass500; ctx.globalAlpha = 0.7; ctx.lineWidth = 3;
    for (let i = -h; i < w + h; i += 34) {
      ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i + h, h); ctx.moveTo(i, h); ctx.lineTo(i + h, 0); ctx.stroke();
    }
    ctx.restore();
    rr(ctx, 12, 12, w - 24, h - 24, 16);
    ctx.strokeStyle = CSS.brass500; ctx.lineWidth = 5; ctx.stroke();
    return;
  }
  ctx.fillStyle = CSS.cream50; ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.2)'; ctx.lineWidth = 2; ctx.stroke();
  if (idx >= 52) {
    const col = idx === 52 ? CSS.ruby500 : CSS.ink900;
    ctx.fillStyle = col; ctx.textAlign = 'center';
    ctx.font = '120px ' + SYM; ctx.fillText('★', w / 2, h / 2 + 40);
    ctx.font = 'bold 30px ' + FONT; ctx.fillText('JOKER', w / 2, 52);
    return;
  }
  const suit = SUITS[Math.floor(idx / 13)] as Suit;
  const rank = RANKS[idx % 13] as Rank;
  const col = suit === 'H' || suit === 'D' ? CSS.ruby500 : CSS.ink900;
  ctx.fillStyle = col;
  const corner = (flip: boolean) => {
    ctx.save();
    if (flip) { ctx.translate(w, h); ctx.rotate(Math.PI); }
    ctx.textAlign = 'center';
    ctx.font = 'bold 58px ' + FONT; ctx.fillText(rank, 40, 66);
    ctx.font = '44px ' + SYM; ctx.fillText(GLYPH[suit], 40, 114);
    ctx.restore();
  };
  corner(false); corner(true);
  ctx.textAlign = 'center';
  ctx.font = '120px ' + SYM; ctx.fillText(GLYPH[suit], w / 2 + 8, h / 2 + 42);
}

export function buildAtlas(maxAniso: number, size = AW): CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');
  const sc = size / AW;
  for (let i = 0; i <= BACK_INDEX; i++) {
    ctx.save();
    ctx.scale(sc, sc);
    ctx.translate((i % COLS) * CW, Math.floor(i / COLS) * CH);
    drawFace(ctx, i);
    ctx.restore();
  }
  const t = new CanvasTexture(cv);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = Math.min(4, maxAniso);
  t.minFilter = LinearMipmapLinearFilter; t.magFilter = LinearFilter;
  return t;
}

// Procedural PBR maps live in materials.ts

/** Outline textures for selection/hint overlays. */
export function outlineTexture(shape: 'rect' | 'circle', dashed: boolean, color: string): CanvasTexture {
  const s = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');
  ctx.strokeStyle = color; ctx.lineWidth = shape === 'rect' ? 8 : 7; ctx.lineCap = 'round';
  if (dashed) ctx.setLineDash([14, 10]);
  if (shape === 'circle') { ctx.beginPath(); ctx.arc(s / 2, s / 2, s / 2 - 6, 0, Math.PI * 2); ctx.stroke(); }
  else { rr(ctx, 5, 5, s - 10, s - 10, 18); ctx.stroke(); }
  const t = new CanvasTexture(cv);
  t.colorSpace = SRGBColorSpace;
  return t;
}
