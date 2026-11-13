import type { MarblePos } from './types';
import { SEGMENT, TRACK_LEN } from '../../shared/board';

// Geometry follows src/shared/board.ts: 4 segments of SEGMENT squares = TRACK_LEN (76).
export const R = 4.4;              // track half-size
export const PER = SEGMENT;        // 19 cells per seat quarter
export const TRACK = TRACK_LEN;    // 76
export const CELL = (2 * R) / PER; // spacing between squares along a side
export const BOARD_Y = 0.12;
export const MARBLE_R = 0.19;
export const TABLE_R = 11.4;       // round café table radius
export const SEAT_D = 10.9;        // avatar torso distance from table centre

const mod = (a: number, n: number) => ((a % n) + n) % n;

/** Rotate local (x,z) by k quarter turns counter-clockwise seen from above. */
export function rot(x: number, z: number, k: number): [number, number] {
  let a = x, b = z;
  for (let i = 0; i < mod(k, 4); i++) { const t = a; a = b; b = -t; }
  return [a, b];
}

function perim(i: number): [number, number] {
  const u = (mod(i, TRACK) / TRACK) * 4;
  const side = Math.floor(u), f = u - side;
  switch (side) {
    case 0: return [-R + 2 * R * f, R];
    case 1: return [R, R - 2 * R * f];
    case 2: return [R - 2 * R * f, -R];
    default: return [-R, -R + 2 * R * f];
  }
}

/** Home lane runs straight inward from the home-entry square (one cell left of the start square). */
export const localHome = (slot: number): [number, number] => [-CELL, R - 0.75 - slot * 0.55];
export const localBase = (slot: number): [number, number] => [-2.9 + (slot % 2) * 0.72, 2.0 + (slot >> 1) * 0.72];

export const screenPos = (seat: number, viewSeat: number) => mod(seat - viewSeat, 4);

/** World x,z of a marble position, with viewSeat at the bottom. Seat s start square = s*PER, centred on its side. */
export function posToXZ(p: MarblePos, viewSeat: number): [number, number] {
  if (p.zone === 'track') return perim(p.index - viewSeat * PER + PER / 2);
  const k = screenPos(p.seat, viewSeat);
  const [x, z] = p.zone === 'home' ? localHome(p.slot) : localBase(p.slot);
  return rot(x, z, k);
}

export function allCells(): MarblePos[] {
  const out: MarblePos[] = [];
  for (let i = 0; i < TRACK; i++) out.push({ zone: 'track', index: i });
  for (let s = 0; s < 4; s++) for (let j = 0; j < 4; j++) out.push({ zone: 'home', seat: s, slot: j });
  return out;
}

export interface Pose { x: number; y: number; z: number; rx: number; ry: number; rz: number }

export const CARD_W = 0.9;
export const CARD_H = 0.9 / 0.706;
const FLAT = -Math.PI / 2;

/** Device-dependent presentation: phone = avatar holds the fan up; laptop = cards laid in front of the screen. */
export interface HandMode { phone: boolean; el: number }

function rotPose(p: Pose, k: number): Pose {
  const [x, z] = rot(p.x, p.z, k);
  return { ...p, x, z, ry: p.ry + (k * Math.PI) / 2 };
}

/** Hand slot for screen position k (0 = bottom). */
export function handPose(k: number, i: number, n: number, own: boolean, mode: HandMode): Pose {
  const m = i - (n - 1) / 2;
  let p: Pose;
  if (own && mode.phone) {
    const sp = Math.min(0.62, 3.8 / Math.max(1, n));
    p = { x: m * sp, y: 2.4 + i * 0.004 - 0.02 * m * m, z: 7.4 + 0.03 * m * m, rx: -mode.el - 0.05, ry: 0, rz: -m * 0.1 };
  } else if (own) {
    const sp = Math.min(0.7, 3.8 / Math.max(1, n));
    p = { x: m * sp, y: 0.75 + i * 0.004, z: 6.8 + 0.03 * m * m, rx: -mode.el - 0.1, ry: 0, rz: -m * 0.05 };
  } else {
    const sp = Math.min(0.4, 3.0 / Math.max(1, n));
    p = { x: m * sp, y: 2.2 + i * 0.004 - 0.015 * m * m, z: 7.5 + 0.03 * m * m, rx: -1.1, ry: 0, rz: -m * 0.09 };
  }
  return rotPose(p, k);
}

/** Enlarged view of a selected / previewed own card. */
export function zoomPose(k: number, mode: HandMode, x: number): Pose {
  return rotPose({ x: x * 0.4, y: mode.phone ? 3.4 : 2.2, z: mode.phone ? 5.2 : 5.6, rx: -mode.el - 0.12, ry: 0, rz: 0 }, k);
}
export const ZOOM_SCALE = 2.3;

/** Hand targets for the avatar arms in the seat-local frame (z toward the table centre is negative). */
export function handAnchors(own: boolean, mode: HandMode, n: number): { l: [number, number, number]; r: [number, number, number] } {
  if (own && !mode.phone) return { l: [-1.8, 0.25, 8.4], r: [1.8, 0.25, 8.4] };
  const w = own ? Math.min(2.0, 0.45 * Math.max(2, n)) : Math.min(1.4, 0.3 * Math.max(2, n));
  const y = own ? 2.0 : 1.8, z = own ? 7.9 : 8.0;
  return { l: [-w, y, z], r: [w, y, z] };
}

export function tablePose(k: number, jitter: number): Pose {
  return rotPose({ x: 0, y: 0.15, z: 1.0, rx: FLAT, ry: 0, rz: jitter }, k);
}

export function deckPose(k: number): Pose {
  return rotPose({ x: 3.3, y: 0.2, z: 5.9, rx: FLAT, ry: 0, rz: 0 }, k);
}
