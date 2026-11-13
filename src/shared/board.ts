/**
 * Board geometry shared by engine, server and 3D scene.
 *
 * - Main track: TRACK_LEN squares, numbered 0..TRACK_LEN-1 in the direction of forward movement.
 * - Seat s has its start square at startSquare(s) = s * SEGMENT. Turn order is 0,1,2,3 (same direction).
 * - A marble's "progress" is its distance from its owner's start square going forward (0..TRACK_LEN-1).
 *   After progress TRACK_LEN-1 (the square just before its own start) the next step enters home slot 0.
 * - Home lane: HOME_SLOTS slots per seat (0 = entry side, 3 = deepest).
 * - Teams: seats 0 and 2 = team A, seats 1 and 3 = team B (partners sit opposite).
 */

export type Seat = 0 | 1 | 2 | 3;

export const SEATS: readonly Seat[] = [0, 1, 2, 3];
export const SEGMENT = 19;
export const TRACK_LEN = SEGMENT * 4; // 76
export const HOME_SLOTS = 4;
export const MARBLES_PER_SEAT = 4;

export function startSquare(seat: Seat): number {
  return seat * SEGMENT;
}

/** The track square just before the home lane of this seat (last square before entering home). */
export function homeEntrySquare(seat: Seat): number {
  return (startSquare(seat) + TRACK_LEN - 1) % TRACK_LEN;
}

export function partnerOf(seat: Seat): Seat {
  return ((seat + 2) % 4) as Seat;
}

export function nextSeat(seat: Seat): Seat {
  return ((seat + 1) % 4) as Seat;
}

export function teamOf(seat: Seat): 'A' | 'B' {
  return seat % 2 === 0 ? 'A' : 'B';
}

export function marbleOwner(id: number): Seat {
  return Math.floor(id / MARBLES_PER_SEAT) as Seat;
}

/** Progress of an absolute square for a marble owned by `seat`. */
export function progressOf(seat: Seat, square: number): number {
  return (square - startSquare(seat) + TRACK_LEN) % TRACK_LEN;
}

export function isSeat(n: unknown): n is Seat {
  return n === 0 || n === 1 || n === 2 || n === 3;
}
