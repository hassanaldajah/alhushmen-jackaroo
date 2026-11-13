/**
 * Scene public API (typed in ./types.ts). Round 2 changes (all additive, existing calls unchanged):
 * - Geometry follows src/shared/board.ts: track index 0..75, seat s starts at s*19. MarblePos shape is unchanged
 *   (UI bridge maps protocol {track, square} -> {zone:'track', index: square}).
 * - SceneApi.setViewSeat(seat, animated?)  spectators: which seat's side is at the bottom (default 0).
 * - SceneApi.setQuality('high'|'low') / .quality  persisted in localStorage 'gfx'; also SceneOptions.quality.
 * - SceneEvents.onQuality(q, reason)  reason 'auto' = scene lowered quality itself (UI shows the toast + Undo).
 * - SceneEvents.onHoverCard(id|null)  mouse hover over own card (scene already previews it).
 * - SceneApi.seatAnchor(seat)  canvas CSS px above an avatar's head (dealer joke bubble); null if off-screen.
 * - Card interaction: a tap/click on an own card enlarges it (peek) AND fires onPickCard; setSelection also enlarges.
 *   Second tap on the enlarged card fires onPickCard again (UI decides confirm). Tap on empty space clears the peek.
 *   Phone (pointer: coarse): avatar holds the fan up. Laptop: cards lie in front of the screen, hover lifts a card.
 * - Avatars/cafe/marble look are internal; draw calls target under 180 (high) / 80 (low).
 */
export { createScene, isWebGLAvailable } from './scene';
export type * from './types';
