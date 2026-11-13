import { describe, expect, it } from 'vitest';
import { CELL, posToXZ, trackXZ, framePoints, cardJitter, tablePose, samePos } from '../../src/client/scene/layout';
import { TRACK_LEN, homeEntrySquare, startSquare, type Seat } from '../../src/shared/board';

const d = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);

describe('scene layout: square snake track follows board.ts', () => {
  for (const view of [0, 1, 2, 3]) {
    it(`76 distinct squares, neighbours one step apart (view ${view})`, () => {
      const pts = Array.from({ length: TRACK_LEN }, (_, i) => trackXZ(i, view));
      for (let i = 0; i < TRACK_LEN; i++) {
        for (let j = i + 1; j < TRACK_LEN; j++) expect(d(pts[i]!, pts[j]!)).toBeGreaterThan(CELL * 0.9);
        const step = d(pts[i]!, pts[(i + 1) % TRACK_LEN]!);
        expect(step).toBeGreaterThan(CELL * 0.99);
        expect(step).toBeLessThan(CELL * 1.5); // straight steps = 1 cell, inner corners = diagonal
      }
    });
  }

  it('has straight runs and distinct corners (not a ring, not a circle)', () => {
    const pts = Array.from({ length: TRACK_LEN }, (_, i) => trackXZ(i, 0));
    let turns = 0, run = 0, longest = 0;
    for (let i = 0; i < TRACK_LEN; i++) {
      const a = pts[i]!, b = pts[(i + 1) % TRACK_LEN]!, c = pts[(i + 2) % TRACK_LEN]!;
      const u = [b[0] - a[0], b[1] - a[1]], v = [c[0] - b[0], c[1] - b[1]];
      const cross = Math.abs(u[0]! * v[1]! - u[1]! * v[0]!);
      if (cross > 1e-6) { turns++; run = 0; } else { run++; longest = Math.max(longest, run); }
    }
    expect(turns).toBe(16); // per arm: two tip corners + into and out of the inner diagonal
    expect(longest).toBeGreaterThanOrEqual(5);
  });

  it('home lane branches inward from the home entry; start is next to it; bases sit in front of the seat', () => {
    for (let s = 0; s < 4; s++) {
      const seat = s as Seat;
      const entry = trackXZ(homeEntrySquare(seat), 0), start = trackXZ(startSquare(seat), 0);
      const h0 = posToXZ({ zone: 'home', seat: s, slot: 0 }, 0);
      expect(d(entry, h0)).toBeCloseTo(CELL, 5);
      expect(d(entry, start)).toBeCloseTo(CELL, 5);
      for (let k = 1; k < 4; k++) expect(d(posToXZ({ zone: 'home', seat: s, slot: k - 1 }, 0), posToXZ({ zone: 'home', seat: s, slot: k }, 0))).toBeCloseTo(CELL, 5);
      // the 4 base cups are a row beyond the tip, closer to the table edge than any square of that arm
      for (let k = 0; k < 4; k++) {
        const b = posToXZ({ zone: 'base', seat: s, slot: k }, s);
        expect(b[1]).toBeGreaterThan(trackXZ(startSquare(seat), s)[1] + CELL); // +z = in front of the viewer
        for (let i = 0; i < TRACK_LEN; i++) expect(d(b, trackXZ(i, s))).toBeGreaterThan(CELL * 0.9);
      }
    }
  });

  it('own start square is at the bottom edge for every viewer', () => {
    for (let v = 0; v < 4; v++) {
      const [x, z] = trackXZ(startSquare(v as Seat), v);
      expect(z).toBeGreaterThan(4);
      expect(Math.abs(x)).toBeLessThan(CELL * 1.5);
    }
  });

  it('pile cards: one spot per seat, stable tilt per card id', () => {
    const spots = [0, 1, 2, 3].map((k) => tablePose(k, 0));
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) expect(Math.hypot(spots[i]!.x - spots[j]!.x, spots[i]!.z - spots[j]!.z)).toBeGreaterThan(0.8);
    expect(cardJitter('7H')).toBe(cardJitter('7H'));
    expect(Math.abs(cardJitter('KS'))).toBeLessThanOrEqual(0.1);
    expect(framePoints().length).toBeGreaterThan(16);
    expect(samePos({ zone: 'track', index: 3 }, { zone: 'track', index: 3 })).toBe(true);
    expect(samePos({ zone: 'home', seat: 1, slot: 2 }, { zone: 'home', seat: 2, slot: 2 })).toBe(false);
  });
});
