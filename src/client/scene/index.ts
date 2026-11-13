/**
 * Scene public API (typed in ./types.ts). This module pulls in three.js, so the UI loads it with a dynamic
 * import (its own chunk): the intro, gate, name screen and lobby never wait for it.
 *
 * - Geometry follows src/shared/board.ts: track index 0..75 on a square "snake" path (layout.ts), seat s starts at s*19.
 * - Orbit camera per player: one-finger/mouse drag rotates around the table, pinch/wheel zooms (limits),
 *   double tap on empty space or resetCamera() returns behind the own seat. Damped, time-based (60/120 Hz alike).
 * - setTargets(): the bridge tells the scene which own marbles / destination squares are interactive this step;
 *   a tap picks them, a drag moves a target marble onto a highlighted destination (onDragStart/onDrop).
 * - playThrow(): thrown cards stay in the centre pile, one per seat.
 * - npcAnchor()/npcRead()/npcDone(): the pirate "أيمن" who reads the jokes.
 */
export { createScene } from './scene';
export { isWebGLAvailable } from './support';
export type * from './types';
