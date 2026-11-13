import type { MarblePos } from './types';
import { SEGMENT, TRACK_LEN } from '../../shared/board';

/*
 * Board geometry. Indices follow src/shared/board.ts exactly (76 squares, seat s starts at s*19, the square
 * before the start is the home entry); only the drawing coordinates live here.
 *
 * The track is a square "snake": a plus-shaped path with one arm per seat. Each arm has two straight side
 * runs (7 squares) joined by a tip run along the player's edge; at the inner corners the path turns
 * diagonally into the next arm. Per seat: 2 (tip, right of the entry) + 7 (right side, inward)
 * + 7 (next arm's left side, outward) + 2 (next tip) + 1 (next home entry) = 19 = SEGMENT.
 * Units below are cells (CELL world units). Seat at screen position 0 sits at +z; forward is counter-clockwise
 * seen from above (bottom edge runs toward +x).
 */
export const PER = SEGMENT;        // 19 squares per seat segment
export const TRACK = TRACK_LEN;    // 76
export const ARM_W = 3;            // arm half-width (cells): side runs at x = +-3
export const ARM_L = 10;           // arm length (cells): tip run at z = 10
export const CELL = 0.45;          // spacing between neighbouring squares
export const BASE_Z = 11.45;       // base row (cells) in front of each player, beyond the tip
export const BASE_DX = 1.18;       // spacing (cells) of the 4 base cups
export const BOARD_HALF = 12.5 * CELL;      // felt half-size
export const FRAME_HALF = BOARD_HALF + 0.42; // wooden frame half-size
export const BOARD_Y = 0.12;
export const MARBLE_R = 0.19;
export const TABLE_HALF = 10;      // square cafe table half-size
export const TABLE_R = TABLE_HALF; // kept for older imports
export const SEAT_D = 11.0;        // avatar torso distance from table centre
/** Pirate NPC position (world, viewer-independent: every client draws its own seat at the bottom). */
export const NPC_POS: [number, number] = [4.3, -11.9];
export const DALLAH_POS: [number, number] = [-3.4, -8.4];

const mod = (a: number, n: number) => ((a % n) + n) % n;

/** Rotate local (x,z) by k quarter turns counter-clockwise seen from above. */
export function rot(x: number, z: number, k: number): [number, number] {
  let a = x, b = z;
  for (let i = 0; i < mod(k, 4); i++) { const t = a; a = b; b = -t; }
  return [a, b];
}

/** Cell (in cells) of square j (0..18) of a seat segment, in the frame of arm (seat + shift). */
export function segCell(j: number): [number, number, number] {
  if (j <= ARM_W - 2) return [1 + j, ARM_L, 0];                               // tip, right of the entry (start = j 0)
  if (j <= ARM_W - 2 + (ARM_L - ARM_W)) return [ARM_W, ARM_L - (j - (ARM_W - 1)), 0]; // right side, inward
  const j2 = j - (ARM_W - 1) - (ARM_L - ARM_W);                               // 0.. in the next arm
  if (j2 < ARM_L - ARM_W) return [-ARM_W, ARM_W + 1 + j2, 1];                 // next arm, left side outward
  const j3 = j2 - (ARM_L - ARM_W);
  if (j3 < ARM_W - 1) return [-(ARM_W - 1) + j3, ARM_L, 1];                   // next tip, left of its entry
  return [0, ARM_L, 1];                                                       // next arm's home entry
}

/** Home lane runs straight inward from the home entry (tip middle): slot 0 nearest the track. */
export const localHome = (slot: number): [number, number] => [0, (ARM_L - 1 - slot) * CELL];
/** Base: a tidy row of 4 cups on the player's edge, directly in front of the seat. */
export const localBase = (slot: number): [number, number] => [(slot - 1.5) * BASE_DX * CELL, BASE_Z * CELL];

export const screenPos = (seat: number, viewSeat: number) => mod(seat - viewSeat, 4);

/** World x,z of a track square with viewSeat at the bottom. */
export function trackXZ(index: number, viewSeat: number): [number, number] {
  const rel = mod(index - viewSeat * PER, TRACK);
  const a = Math.floor(rel / PER), j = rel % PER;
  const [x, z, shift] = segCell(j);
  return rot(x * CELL, z * CELL, a + shift);
}

/** World x,z of a marble position, with viewSeat at the bottom. */
export function posToXZ(p: MarblePos, viewSeat: number): [number, number] {
  if (p.zone === 'track') return trackXZ(p.index, viewSeat);
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

export function samePos(a: MarblePos | null | undefined, b: MarblePos | null | undefined): boolean {
  if (!a || !b || a.zone !== b.zone) return false;
  if (a.zone === 'track') return a.index === (b as { index: number }).index;
  const bb = b as { seat: number; slot: number };
  return a.seat === bb.seat && a.slot === bb.slot;
}

export interface Pose { x: number; y: number; z: number; rx: number; ry: number; rz: number }

export const CARD_W = 0.9;
export const CARD_H = 0.9 / 0.706;
export const TABLE_CARD_SCALE = 0.85;
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
    const sp = Math.min(0.66, 3.8 / Math.max(1, n));
    p = { x: m * sp, y: 2.3 + i * 0.004 - 0.02 * m * m, z: 7.5 + 0.03 * m * m, rx: -mode.el - 0.05, ry: 0, rz: -m * 0.1 };
  } else if (own) {
    const sp = Math.min(0.72, 3.8 / Math.max(1, n));
    p = { x: m * sp, y: 0.75 + i * 0.004, z: 7.0 + 0.03 * m * m, rx: -mode.el - 0.1, ry: 0, rz: -m * 0.05 };
  } else {
    const sp = Math.min(0.4, 3.0 / Math.max(1, n));
    p = { x: m * sp, y: 2.2 + i * 0.004 - 0.015 * m * m, z: 7.6 + 0.03 * m * m, rx: -1.1, ry: 0, rz: -m * 0.09 };
  }
  return rotPose(p, k);
}

/** Enlarged view of a selected / previewed own card. */
export function zoomPose(k: number, mode: HandMode, x: number): Pose {
  return rotPose({ x: x * 0.4, y: mode.phone ? 3.3 : 2.2, z: mode.phone ? 5.6 : 5.9, rx: -mode.el - 0.12, ry: 0, rz: 0 }, k);
}
export const ZOOM_SCALE = 2.2;

/** Hand targets for the avatar arms in the seat-local frame (z toward the table centre is negative). */
export function handAnchors(own: boolean, mode: HandMode, n: number): { l: [number, number, number]; r: [number, number, number] } {
  if (own && !mode.phone) return { l: [-1.8, 0.25, 8.5], r: [1.8, 0.25, 8.5] };
  const w = own ? Math.min(2.0, 0.45 * Math.max(2, n)) : Math.min(1.4, 0.3 * Math.max(2, n));
  const y = own ? 1.9 : 1.8, z = own ? 8.0 : 8.1;
  return { l: [-w, y, z], r: [w, y, z] };
}

/**
 * Thrown card of the seat at screen position k: the centre pile keeps one card per player, each placed on
 * that player's side of the centre (a neat cross), so all four stay visible.
 */
export function tablePose(k: number, jitter: number): Pose {
  return rotPose({ x: 0.04, y: BOARD_Y + 0.012 + k * 0.004, z: 0.74, rx: FLAT, ry: 0, rz: jitter }, k);
}

/** Small stable tilt per card id (no jump between re-layouts). */
export function cardJitter(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return (((h >>> 0) % 1000) / 1000 - 0.5) * 0.2;
}

export function deckPose(k: number): Pose {
  return rotPose({ x: 3.3, y: 0.2, z: 7.4, rx: FLAT, ry: 0, rz: 0.12 }, k);
}

/** Points the default camera keeps in view: every square, base cup, the far props and the pirate. */
export function framePoints(): [number, number, number][] {
  const pts: [number, number, number][] = [];
  const r = MARBLE_R * 1.6;
  for (let k = 0; k < 4; k++) {
    for (const [x, z] of [[-(1.5 * BASE_DX * CELL + r), BASE_Z * CELL + r], [1.5 * BASE_DX * CELL + r, BASE_Z * CELL + r],
      [-(ARM_W * CELL + r), ARM_L * CELL + r], [ARM_W * CELL + r, ARM_L * CELL + r]] as const) {
      const [a, b] = rot(x, z, k); pts.push([a, BOARD_Y, b]);
    }
  }
  pts.push([DALLAH_POS[0], 2.6, DALLAH_POS[1]]);
  pts.push([NPC_POS[0], 4.6, NPC_POS[1]]); // top of the pirate's hat
  return pts;
}
