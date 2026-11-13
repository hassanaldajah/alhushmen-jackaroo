import {
  ACESFilmicToneMapping, AdditiveBlending, AmbientLight, BoxGeometry, BufferAttribute, BufferGeometry, CircleGeometry, Color,
  DirectionalLight, DoubleSide, ExtrudeGeometry, FogExp2, Float32BufferAttribute, HemisphereLight, InstancedMesh, Material, Mesh,
  MeshBasicMaterial, MeshPhysicalMaterial, MeshStandardMaterial, Object3D, PCFSoftShadowMap, PerspectiveCamera, Path, Plane,
  PlaneGeometry, Points, PointsMaterial, Raycaster, RingGeometry, Scene, Shape, ShapeGeometry, SphereGeometry, SpotLight, Texture,
  Euler, Vector2, Vector3, WebGLRenderer,
} from 'three';
import { C, CSS, SEAT_COLORS } from './colors';
import { Tweens, easeInOut, easeOut, linear } from './tween';
import {
  BASE_DX, BASE_Z, BOARD_HALF, BOARD_Y, CARD_H, CARD_W, CELL, FRAME_HALF, MARBLE_R, NPC_POS, PER, TABLE_CARD_SCALE, TRACK, ZOOM_SCALE,
  allCells, cardJitter, choosePick, deckPose, framePoints, handAnchors, handPose, localHome, posToXZ, rot, samePos, screenPos, tablePose, trackXZ, zoomPose,
} from './layout';
import type { HandMode, Pose } from './layout';
import { BACK_INDEX, atlasUV, buildAtlas, faceIndex, outlineTexture } from './textures';
import { bokehTexture, buildEnvironment, feltMaps, softCircleTexture, starTexture, swirlNormal, woodMaps } from './materials';
import type { PbrMaps } from './materials';
import { createAvatar } from './avatar';
import type { Avatar } from './avatar';
import { createNpc } from './npc';
import { buildCafe } from './cafe';
import type { CardRef, Hints, MarblePos, MoveEvent, Quality, SceneApi, SceneEvents, SceneOptions, SceneView, SfxName, Targets } from './types';

const REST_Y = BOARD_Y + MARBLE_R;
const rad = (d: number) => (d * Math.PI) / 180;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const GFX_KEY = 'gfx';

/**
 * Marble glow: emissive = own instance colour * (base + rim * fresnel). Keeps the glass look, but the colour
 * never sinks into the brown board or a shadow. Works with instanced colours (vColor).
 */
function glow(m: Material, base: number, rim: number): void {
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
#if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
      {
        float fr = pow( 1.0 - clamp( abs( dot( normalize( normal ), normalize( vViewPosition ) ) ), 0.0, 1.0 ), 2.0 );
        totalEmissiveRadiance += vColor.rgb * ( ${base.toFixed(3)} + ${rim.toFixed(3)} * fr );
      }
#endif`);
  };
  m.customProgramCacheKey = () => `glow-${base}-${rim}`;
}
// Orbit limits (camera distance multiplier and elevation).
const ZOOM_MIN = 0.5, ZOOM_MAX = 1.6, PITCH_MIN = rad(24), PITCH_MAX = rad(84);
const DAMP_S = 0.085; // camera damping time constant (frame-rate independent)
const SLOP = 9;       // px before a press becomes a drag

function readGfx(): Quality | null {
  try { const v = localStorage.getItem(GFX_KEY); return v === 'low' || v === 'high' ? v : null; } catch { return null; }
}

interface CardObj { mesh: Mesh; outline: Mesh; id: string; face: CardRef | null; pose: Pose; sc: number; fx: number }

/** Returns null when WebGL is unavailable: the UI then shows the 2D fallback. */
export function createScene(canvas: HTMLCanvasElement, opts: SceneOptions = {}): SceneApi | null {
  const ev: SceneEvents = opts.events ?? {};
  let quality: Quality = opts.quality ?? readGfx() ?? 'high';
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas, antialias: quality === 'high', alpha: false, powerPreference: 'high-performance' });
  } catch { return null; }
  if (!renderer.getContext()) return null;

  const disposables: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(o: T): T => { disposables.push(o); return o; };

  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;

  const scene = new Scene();
  scene.background = new Color(C.wood900);
  scene.fog = new FogExp2(0x1e140d, 0.006);
  // near = 2: nothing comes closer at any zoom; better depth precision for the decals lying on the board
  const camera = new PerspectiveCamera(32, 1, 2, 400);
  renderer.setClearColor(C.wood900);

  // ---------- state ----------
  let viewSeat = 0, specSeat = 0, spectator = false, turn = 0, dealer = 0;
  let interactive = true, disposed = false, dealing = false, epoch = 0;
  let reducedOverride: boolean | null = opts.reducedMotion ?? null;
  const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  const coarse = typeof matchMedia === 'function' ? matchMedia('(pointer: coarse)') : null;
  const reduced = () => (reducedOverride ?? mq?.matches ?? false);
  // Phones get smaller procedural maps (faster first frame, less memory); desktops keep 1k maps.
  const small = !!coarse?.matches || Math.min(innerWidth, innerHeight) < 700;
  let insetTop = 0, insetBottom = 0;
  let degrade = 0;
  let sel: { cardId: string | null; marbleId: number | null } = { cardId: null, marbleId: null };
  let peekId: string | null = null, hoverId: string | null = null;
  /** Phone: while a card is selected the own hand shrinks to a thin strip in a screen box (canvas px) so the board stays free. */
  let strip: { bottom: number; left: number; right: number } | null = null;
  let hints: Hints | null = null;
  let targets: Targets | null = null;
  let lastView: SceneView | null = null;
  let mode: HandMode = { phone: false, el: rad(48) };

  // ---------- quality ----------
  const dprCap = () => (quality === 'low' ? 1.25 : degrade >= 3 ? 1.5 : 2);
  const shadowSize = () => (quality === 'low' || degrade >= 4 ? 1024 : small ? 1024 : 2048);
  const steamOn = () => quality === 'high' && degrade < 1;
  const mirrorOn = () => quality === 'high' && degrade < 2;
  // Idle animation (steam, pirate) only while the table is in front: not behind a modal sheet (inert) or a hidden tab.
  const continuous = () => quality === 'high' && !reduced() && document.visibilityState !== 'hidden' && !canvas.closest('[inert]');
  const texSize = (q: Quality) => (q === 'high' ? (small ? 512 : 1024) : 256);

  // ---------- render on demand ----------
  let raf = 0, lastActive = 0, lastRender = 0, prevT = 0, shadowDirty = true, lastFrame = 0;
  let winSum = 0, winN = 0;
  const tweens = new Tweens(() => request(true));
  function request(shadow = false) { if (shadow) shadowDirty = true; if (!raf && !disposed) raf = requestAnimationFrame(frame); }
  function frame(now: number) {
    raf = 0;
    if (disposed || document.visibilityState === 'hidden') return;
    const dt = Math.min(0.1, lastFrame ? (now - lastFrame) / 1000 : 1 / 60);
    lastFrame = now;
    const active = tweens.step(now);
    const camMoving = stepCamera(dt);
    if (camMoving && stripOn()) relayoutHand(viewSeat, 0); // the strip is screen-anchored: follow the camera
    const cont = continuous();
    const minGap = quality === 'low' ? 30 : !active && !camMoving && !dragging() && cont ? 32 : 0;
    if (minGap && now - lastRender < minGap) { raf = requestAnimationFrame(frame); return; }
    if (active) {
      lastActive = now;
      if (prevT && now - prevT < 100 && quality === 'high') {
        winSum += now - prevT; winN++;
        if (winN >= 45) { const mean = winSum / winN; winSum = 0; winN = 0; if (mean > 33.3) degradeStep(); }
      }
      prevT = now;
    } else { prevT = 0; winSum = 0; winN = 0; }
    lastRender = now;
    if (steamOn()) cafe.steam.tick(now / 1000);
    if (cont) npc.tick(now / 1000);
    renderer.shadowMap.needsUpdate = active || shadowDirty;
    shadowDirty = false;
    renderer.render(scene, camera);
    ev.onFrame?.();
    if (active || camMoving || dragging() || cont || now - lastActive < 250) raf = requestAnimationFrame(frame);
  }
  function degradeStep() {
    degrade++;
    if (degrade >= 5) { degrade = 0; applyQuality('low', 'auto'); return; }
    syncQuality();
    ev.onStatus?.('degraded');
  }

  // ---------- lights ----------
  const hemi = new HemisphereLight(0x6b4a2b, 0x1e140d, 1.3);
  const rim = new DirectionalLight(0xffb070, 1.8); rim.position.set(-14, 10, -16);
  const lamp = new SpotLight(0xffd9a0, 1500, 0, 0.78, 0.8, 2);
  lamp.position.set(0, 24, 2); lamp.target.position.set(0, 0, 0);
  lamp.castShadow = true;
  lamp.shadow.camera.near = 10; lamp.shadow.camera.far = 45;
  lamp.shadow.bias = -0.0004; lamp.shadow.normalBias = 0.02; lamp.shadow.radius = 4;
  scene.add(hemi, rim, lamp, lamp.target, new AmbientLight(0xffffff, 0.15));

  // ---------- quality-dependent textures ----------
  const swirl = track(swirlNormal());
  const soft = track(softCircleTexture());
  const bokeh = track(bokehTexture());
  const star = track(starTexture());
  let wood: PbrMaps = woodMaps(texSize(quality));
  let feltM: PbrMaps = feltMaps(texSize(quality));
  let atlas = buildAtlas(renderer.capabilities.getMaxAnisotropy(), quality === 'high' ? 2048 : 1024);
  let envTex: Texture = buildEnvironment(renderer, quality === 'high' ? (small ? 128 : 256) : 64);
  scene.environment = envTex; scene.environmentIntensity = quality === 'high' ? 0.5 : 0.4;

  // ---------- cafe set + square board ----------
  const cafe = buildCafe(wood.map, wood.bump, bokeh, soft);
  scene.add(cafe.group);
  cafe.group.traverse((o) => { if (o instanceof Mesh && o.castShadow === false) o.receiveShadow = true; });

  function frameGeo(outer: number, inner: number, depth: number) {
    const s = new Shape();
    const o = outer / 2, i = inner / 2;
    s.moveTo(-o, -o); s.lineTo(o, -o); s.lineTo(o, o); s.lineTo(-o, o); s.closePath();
    const h = new Path();
    h.moveTo(-i, -i); h.lineTo(-i, i); h.lineTo(i, i); h.lineTo(i, -i); h.closePath();
    s.holes.push(h);
    const g = new ExtrudeGeometry(s, { depth, bevelEnabled: false });
    g.rotateX(-Math.PI / 2);
    return track(g);
  }
  const feltMat = track(new MeshPhysicalMaterial({ map: feltM.map, bumpMap: feltM.bump, bumpScale: 0.7, roughness: 0.9, sheen: 0.5, sheenColor: new Color(C.brass700), sheenRoughness: 0.8 }));
  const woodMat = track(new MeshPhysicalMaterial({ map: wood.map, bumpMap: wood.bump, bumpScale: 1.2, roughness: 0.55, clearcoat: 0.25, clearcoatRoughness: 0.4 }));
  const brassMat = track(new MeshStandardMaterial({ color: C.brass500, metalness: 1, roughness: 0.28 }));
  const BW = FRAME_HALF * 2, FW = BOARD_HALF * 2;
  const base = new Mesh(track(new BoxGeometry(BW, BOARD_Y, BW)), woodMat);
  base.position.y = BOARD_Y / 2; base.receiveShadow = true;
  const felt = new Mesh(track(new PlaneGeometry(FW, FW)), feltMat);
  felt.rotation.x = -Math.PI / 2; felt.position.y = BOARD_Y + 0.001; felt.receiveShadow = true;
  const rimM = new Mesh(frameGeo(BW, FW + 0.1, 0.1), woodMat);
  rimM.position.y = BOARD_Y; rimM.castShadow = true; rimM.receiveShadow = true;
  const brass = new Mesh(frameGeo(FW + 0.1, FW, 0.105), brassMat);
  brass.position.y = BOARD_Y;
  scene.add(base, felt, rimM, brass);

  // Track inlay: a lighter leather ribbon that follows the snake path square by square (4-fold symmetric, built once).
  {
    const pos: number[] = [], idx: number[] = [];
    const w = CELL * 0.34, y = BOARD_Y + 0.0015;
    const pts = Array.from({ length: TRACK }, (_, i) => trackXZ(i, 0));
    const quad = (a: [number, number], b: [number, number]) => {
      const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1, nx = (-dz / l) * w, nz = (dx / l) * w;
      const v = pos.length / 3;
      pos.push(a[0] + nx, y, a[1] + nz, a[0] - nx, y, a[1] - nz, b[0] + nx, y, b[1] + nz, b[0] - nx, y, b[1] - nz);
      idx.push(v, v + 2, v + 1, v + 1, v + 2, v + 3);
    };
    const disc = (c: [number, number]) => {
      const v = pos.length / 3;
      pos.push(c[0], y, c[1]);
      for (let s = 0; s <= 12; s++) { const a = (s / 12) * Math.PI * 2; pos.push(c[0] + Math.cos(a) * w, y, c[1] + Math.sin(a) * w); }
      for (let s = 0; s < 12; s++) idx.push(v, v + 2 + s, v + 1 + s);
    };
    for (let i = 0; i < TRACK; i++) { quad(pts[i] as [number, number], pts[(i + 1) % TRACK] as [number, number]); disc(pts[i] as [number, number]); }
    const g = track(new BufferGeometry());
    g.setAttribute('position', new Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new Float32BufferAttribute(pos.map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
    g.setIndex(idx);
    const ribbon = new Mesh(g, track(new MeshStandardMaterial({ color: 0x7a5530, roughness: 0.8, side: DoubleSide, polygonOffset: true, polygonOffsetFactor: -0.5, polygonOffsetUnits: -1 })));
    ribbon.receiveShadow = true;
    scene.add(ribbon);
  }

  const dummy = new Object3D();
  const col = new Color();
  const flatGeo = (g: BufferGeometry) => { g.rotateX(-Math.PI / 2); return track(g); };
  // Holes: brass ring + dark core (track squares, home slots, base cups).
  const CELLS = allCells();
  const NHOLE = CELLS.length + 16;
  const holeRing = new InstancedMesh(flatGeo(new RingGeometry(0.135, 0.19, 22)), track(new MeshStandardMaterial({ roughness: 0.35, metalness: 0.75 })), NHOLE);
  const holeCore = new InstancedMesh(flatGeo(new CircleGeometry(0.136, 22)), track(new MeshStandardMaterial({ color: 0x140d08, roughness: 0.95 })), NHOLE);
  const startRings = new InstancedMesh(flatGeo(new RingGeometry(0.22, 0.29, 26)), track(new MeshStandardMaterial({ roughness: 0.35, metalness: 0.6 })), 4);
  const laneGeo = flatGeo(new PlaneGeometry(CELL * 0.62, CELL * 4.2));
  const lanes = new InstancedMesh(laneGeo, track(new MeshStandardMaterial({ roughness: 0.7, transparent: true, opacity: 0.55 })), 4);
  const trayShape = (() => {
    const wdt = 4 * BASE_DX * CELL + 0.22, hgt = CELL * 1.25, r = hgt / 2, s = new Shape();
    s.moveTo(-wdt / 2 + r, -hgt / 2); s.lineTo(wdt / 2 - r, -hgt / 2); s.absarc(wdt / 2 - r, 0, r, -Math.PI / 2, Math.PI / 2, false);
    s.lineTo(-wdt / 2 + r, hgt / 2); s.absarc(-wdt / 2 + r, 0, r, Math.PI / 2, Math.PI * 1.5, false);
    return s;
  })();
  const trays = new InstancedMesh(flatGeo(new ShapeGeometry(trayShape, 8)), track(new MeshStandardMaterial({ roughness: 0.4, metalness: 0.85 })), 4);
  const stars = new InstancedMesh(flatGeo(new PlaneGeometry(CELL * 6.2, CELL * 6.2)), track(new MeshBasicMaterial({ map: star, transparent: true, depthWrite: false })), 4);
  holeRing.receiveShadow = true; holeCore.receiveShadow = true; trays.receiveShadow = true;
  // Decals lie a hair above the cloth: pull them toward the camera in depth so they never flicker at a distance.
  [stars, lanes, trays, startRings, holeRing, holeCore].forEach((m, i) => {
    const mt = m.material as Material;
    mt.polygonOffset = true; mt.polygonOffsetFactor = -1 - i * 0.5; mt.polygonOffsetUnits = -2 - i * 2;
  });
  scene.add(stars, lanes, trays, startRings, holeRing, holeCore);

  function layoutBoard() {
    let n = 0;
    const put = (x: number, z: number, r: number, color: number) => {
      dummy.rotation.set(0, 0, 0); dummy.scale.set(r, 1, r);
      dummy.position.set(x, BOARD_Y + 0.004, z); dummy.updateMatrix(); holeRing.setMatrixAt(n, dummy.matrix); holeRing.setColorAt(n, col.setHex(color));
      dummy.position.set(x, BOARD_Y + 0.0035, z); dummy.updateMatrix(); holeCore.setMatrixAt(n, dummy.matrix);
      n++;
    };
    for (const c of CELLS) {
      const [x, z] = posToXZ(c, viewSeat);
      put(x, z, c.zone === 'home' ? 1.12 : 1, c.zone === 'home' ? SEAT_COLORS[c.seat] as number : C.brass700);
    }
    for (let s = 0; s < 4; s++) for (let j = 0; j < 4; j++) {
      const [x, z] = posToXZ({ zone: 'base', seat: s, slot: j }, viewSeat);
      put(x, z, 1.22, SEAT_COLORS[s] as number);
    }
    for (const m of [holeRing, holeCore]) m.instanceMatrix.needsUpdate = true;
    if (holeRing.instanceColor) holeRing.instanceColor.needsUpdate = true;
    for (let s = 0; s < 4; s++) {
      const k = screenPos(s, viewSeat);
      const [x, z] = posToXZ({ zone: 'track', index: s * PER }, viewSeat);
      dummy.position.set(x, BOARD_Y + 0.0025, z); dummy.scale.set(1, 1, 1); dummy.rotation.set(0, 0, 0); dummy.updateMatrix();
      startRings.setMatrixAt(s, dummy.matrix); startRings.setColorAt(s, col.setHex(SEAT_COLORS[s] as number));
      const [h0x, h0z] = localHome(0), [h3x, h3z] = localHome(3);
      const [lx, lz] = rot((h0x + h3x) / 2, (h0z + h3z) / 2 + CELL * 0.5, k);
      dummy.position.set(lx, BOARD_Y + 0.002, lz); dummy.rotation.set(0, (k * Math.PI) / 2, 0); dummy.updateMatrix();
      lanes.setMatrixAt(s, dummy.matrix); lanes.setColorAt(s, col.setHex(SEAT_COLORS[s] as number).multiplyScalar(0.75));
      const [tx, tz] = rot(0, BASE_Z * CELL, k);
      dummy.position.set(tx, BOARD_Y + 0.0018, tz); dummy.updateMatrix();
      trays.setMatrixAt(s, dummy.matrix); trays.setColorAt(s, col.setHex(C.brass500).lerp(new Color(SEAT_COLORS[s] as number), 0.15));
      const [sx, sz] = rot(8 * CELL, 8 * CELL, s);
      dummy.position.set(sx, BOARD_Y + 0.0012, sz); dummy.rotation.set(0, (s * Math.PI) / 2 + Math.PI / 4, 0); dummy.updateMatrix();
      stars.setMatrixAt(s, dummy.matrix);
    }
    for (const m of [startRings, lanes, trays, stars]) { m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; }
  }

  // ---------- marbles: clear glass shell + coloured swirl core (high), solid glossy glass (low) ----------
  const shellGeo = track(new SphereGeometry(MARBLE_R, 28, 18));
  const coreGeo = track(new SphereGeometry(MARBLE_R * 0.74, 20, 14));
  const solidMat = track(new MeshPhysicalMaterial({
    roughness: 0.05, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.03, ior: 1.5, envMapIntensity: 1.2,
    normalMap: swirl, normalScale: new Vector2(0.5, 0.5),
  }));
  const shellMat = track(new MeshPhysicalMaterial({
    roughness: 0.02, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.02, ior: 1.5, envMapIntensity: 1.7,
    transparent: true, opacity: 0.42, depthWrite: false, specularIntensity: 1,
  }));
  const coreMat = track(new MeshStandardMaterial({ roughness: 0.32, metalness: 0.05, normalMap: swirl, normalScale: new Vector2(1.1, 1.1), envMapIntensity: 0.9 }));
  // Self-lit in their own (instance) colour plus a soft rim, so marbles read clearly on the brown board even in shadow.
  glow(solidMat, 0.32, 0.7); glow(shellMat, 0.12, 0.8); glow(coreMat, 0.38, 0.35);
  const marbles = new InstancedMesh(shellGeo, solidMat, 16);
  const cores = new InstancedMesh(coreGeo, coreMat, 16);
  marbles.castShadow = true; cores.castShadow = false;
  marbles.renderOrder = 3; cores.renderOrder = 2;
  const mirrorMat = track(new MeshBasicMaterial({ transparent: true, opacity: 0.13, depthTest: false, depthWrite: false, side: DoubleSide }));
  const mirror = new InstancedMesh(shellGeo, mirrorMat, 16);
  mirror.renderOrder = 1; mirror.frustumCulled = false;
  const blobGeo = flatGeo(new CircleGeometry(MARBLE_R * 1.25, 16));
  const blobs = new InstancedMesh(blobGeo, track(new MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.85, map: soft, depthWrite: false })), 16);
  blobs.renderOrder = 1;
  // Light focused through the glass: a faint coloured spot beside each marble (high quality only).
  const caustics = new InstancedMesh(flatGeo(new CircleGeometry(MARBLE_R * 0.9, 14)), track(new MeshBasicMaterial({ map: soft, transparent: true, opacity: 0.45, depthWrite: false, blending: AdditiveBlending })), 16);
  caustics.renderOrder = 1;
  scene.add(marbles, cores, mirror, blobs, caustics);
  const mp: MarblePos[] = [];
  const mx = new Float32Array(16), my = new Float32Array(16), mz = new Float32Array(16), msy = new Float32Array(16).fill(1);
  for (let i = 0; i < 16; i++) {
    mp.push({ zone: 'base', seat: i >> 2, slot: i & 3 });
    const sc = SEAT_COLORS[i >> 2] as number;
    marbles.setColorAt(i, col.setHex(sc));
    cores.setColorAt(i, col.setHex(sc));
    mirror.setColorAt(i, col.setHex(sc).multiplyScalar(0.7));
    caustics.setColorAt(i, col.setHex(sc).multiplyScalar(0.9));
  }
  function writeMarble(i: number) {
    const sy = msy[i] as number, sx = 1 + (1 - sy) * 0.5;
    const x = mx[i] as number, y = my[i] as number, z = mz[i] as number;
    dummy.rotation.set(0, 0, 0);
    dummy.position.set(x, y - MARBLE_R * (1 - sy), z);
    dummy.scale.set(sx, sy, sx); dummy.updateMatrix();
    marbles.setMatrixAt(i, dummy.matrix);
    dummy.rotation.set(0.6, i * 1.7, 0.3); dummy.updateMatrix(); // each core shows a different swirl
    cores.setMatrixAt(i, dummy.matrix);
    dummy.rotation.set(0, 0, 0);
    const h = Math.max(0, y - REST_Y), s = 1 / (1 + h * 1.5);
    dummy.position.set(x, BOARD_Y + 0.006, z); dummy.scale.set(s, 1, s); dummy.updateMatrix();
    blobs.setMatrixAt(i, dummy.matrix);
    const len = Math.hypot(x, z) || 1;
    dummy.position.set(x + (x / len) * MARBLE_R * 0.75, BOARD_Y + 0.007, z + (z / len) * MARBLE_R * 0.75); dummy.scale.set(s, 1, s * 1.3);
    dummy.rotation.set(0, Math.atan2(x, z), 0); dummy.updateMatrix();
    caustics.setMatrixAt(i, dummy.matrix);
    dummy.rotation.set(0, 0, 0);
    // mirrored copy under the board plane
    dummy.position.set(x, 2 * (BOARD_Y + 0.002) - (y - MARBLE_R * (1 - sy)), z); dummy.scale.set(sx, -sy, sx); dummy.updateMatrix();
    mirror.setMatrixAt(i, dummy.matrix);
    for (const m of [marbles, cores, blobs, mirror, caustics]) m.instanceMatrix.needsUpdate = true;
  }
  function snapMarble(i: number) {
    const [x, z] = posToXZ(mp[i] as MarblePos, viewSeat);
    mx[i] = x; mz[i] = z; my[i] = REST_Y; msy[i] = 1; writeMarble(i);
  }
  function snapAllMarbles() { for (let i = 0; i < 16; i++) snapMarble(i); }
  for (const m of [marbles, cores, mirror, caustics]) if (m.instanceColor) m.instanceColor.needsUpdate = true;
  const ghostMat = track(new MeshPhysicalMaterial({ transparent: true, opacity: 0.5, roughness: 0.1, clearcoat: 1, depthWrite: false }));
  const ghost = new Mesh(shellGeo, ghostMat); ghost.visible = false; ghost.renderOrder = 4;
  scene.add(ghost);

  // ---------- avatars + pirate ----------
  const avatars: Avatar[] = [0, 1, 2, 3].map((s) => { const a = createAvatar(s); scene.add(a.root); return a; });
  for (const a of avatars) disposables.push(a);
  const npc = createNpc();
  npc.root.position.set(NPC_POS[0], 0, NPC_POS[1]);
  npc.root.rotation.y = Math.atan2(-NPC_POS[0], -NPC_POS[1]);
  scene.add(npc.root);
  disposables.push(npc);

  // ---------- overlays (selection / hints / targets) ----------
  const tex = {
    selCircle: track(outlineTexture('circle', false, CSS.brass300)),
    hintCircle: track(outlineTexture('circle', true, CSS.cream50)),
    selRect: track(outlineTexture('rect', false, CSS.brass300)),
    hintRect: track(outlineTexture('rect', true, CSS.cream50)),
  };
  const mat = (t: Texture) => track(new MeshBasicMaterial({ map: t, transparent: true, depthWrite: false }));
  const ringMats = { sel: mat(tex.selCircle), hint: mat(tex.hintCircle) };
  const outlineMats = { sel: mat(tex.selRect), hint: mat(tex.hintRect) };
  const ringGeo = flatGeo(new PlaneGeometry(0.66, 0.66));
  const rings: Mesh[] = [];
  let ringsUsed = 0;
  function ring(kind: 'sel' | 'hint', x: number, z: number, scale = 1) {
    let m = rings[ringsUsed];
    if (!m) { m = new Mesh(ringGeo, ringMats.sel); m.renderOrder = 5; scene.add(m); rings.push(m); }
    m.material = ringMats[kind]; m.position.set(x, BOARD_Y + 0.03, z); m.scale.setScalar(scale * (kind === 'sel' ? 1.12 : 1));
    m.visible = true;
    let g = glows[ringsUsed];
    if (!g) { g = new Mesh(ringGeo, glowMats.sel); g.renderOrder = 4; scene.add(g); glows.push(g); }
    g.material = glowMats[kind]; g.position.set(x, BOARD_Y + 0.025, z); g.scale.setScalar(scale * (kind === 'sel' ? 1.9 : 1.6));
    g.visible = true;
    ringsUsed++;
  }
  let snapCell: MarblePos | null = null;
  // Soft additive glow under every highlight ring: targets stay as visible as the brighter marbles.
  const glowMats = { sel: track(new MeshBasicMaterial({ map: soft, color: C.brass300, transparent: true, opacity: 0.85, depthWrite: false, blending: AdditiveBlending })),
    hint: track(new MeshBasicMaterial({ map: soft, color: C.cream50, transparent: true, opacity: 0.55, depthWrite: false, blending: AdditiveBlending })) };
  const glows: Mesh[] = [];
  function refreshOverlays() {
    ringsUsed = 0;
    const selM = targets?.selected ?? sel.marbleId;
    if (selM !== null && selM !== undefined) ring('sel', mx[selM] as number, mz[selM] as number);
    for (const id of targets?.marbles ?? hints?.marbleIds ?? []) if (id >= 0 && id < 16 && id !== selM) ring('hint', mx[id] as number, mz[id] as number);
    for (const c of targets?.cells ?? hints?.cells ?? []) {
      const [x, z] = posToXZ(c, viewSeat);
      const chosen = samePos(c, targets?.chosen) || samePos(c, snapCell);
      ring(chosen ? 'sel' : 'hint', x, z, chosen ? 1.15 : 1);
    }
    // A previewed landing square (single legal play) gets its ring too, even when it is not tappable.
    if (targets?.chosen && !(targets.cells ?? []).some((c) => samePos(c, targets!.chosen))) {
      const [x, z] = posToXZ(targets.chosen, viewSeat);
      ring('sel', x, z, 1.15);
    }
    for (let i = ringsUsed; i < rings.length; i++) (rings[i] as Mesh).visible = false;
    for (let i = ringsUsed; i < glows.length; i++) (glows[i] as Mesh).visible = false;
    const gOf = targets?.chosen ? targets.selected ?? null : null;
    if (gOf !== null && targets?.chosen) {
      const [gx, gz] = posToXZ(targets.chosen, viewSeat);
      ghost.position.set(gx, REST_Y, gz); ghostMat.color.setHex(SEAT_COLORS[gOf >> 2] as number); ghost.visible = true;
    } else ghost.visible = false;
    for (const list of hands) for (const c of list) {
      const s = c.id === sel.cardId, h = !s && !!hints?.cardIds?.includes(c.id);
      c.outline.visible = s || h;
      if (s || h) c.outline.material = outlineMats[s ? 'sel' : 'hint'];
    }
    relayoutHand(viewSeat, 150);
    request(true);
  }

  // ---------- cards ----------
  const cardMat = track(new MeshStandardMaterial({ map: atlas, alphaTest: 0.5, roughness: 0.6, side: DoubleSide }));
  const geoCache = new Map<number, BufferGeometry>();
  function geoFor(face: CardRef | null): BufferGeometry {
    const idx = faceIndex(face);
    let g = geoCache.get(idx);
    if (!g) {
      const p = new PlaneGeometry(CARD_W, CARD_H);
      const [u0, v0, u1, v1] = atlasUV(idx);
      p.setAttribute('uv', new Float32BufferAttribute([u0, v1, u1, v1, u0, v0, u1, v0], 2) as unknown as BufferAttribute);
      g = track(p); geoCache.set(idx, g);
    }
    return g;
  }
  const outlineGeo = track(new PlaneGeometry(CARD_W * 1.12, CARD_H * 1.08));
  const pool: CardObj[] = [];
  const hands: CardObj[][] = [[], [], [], []];
  const tableCards: (CardObj | null)[] = [null, null, null, null];

  function applyScale(c: CardObj) { c.mesh.scale.set(c.sc * c.fx, c.sc, c.sc); }
  function setPose(c: CardObj, p: Pose) {
    c.pose = p;
    c.mesh.position.set(p.x, p.y, p.z);
    c.mesh.rotation.set(p.rx, p.ry, p.rz, 'YXZ');
  }
  function makeCard(face: CardRef | null, id: string, pose: Pose): CardObj {
    let c = pool.pop();
    if (!c) {
      const mesh = new Mesh(geoFor(null), cardMat);
      mesh.rotation.order = 'YXZ';
      mesh.castShadow = true;
      const outline = new Mesh(outlineGeo, outlineMats.sel);
      outline.position.z = -0.006; outline.visible = false; outline.renderOrder = 4;
      mesh.add(outline);
      c = { mesh, outline, id, face, pose, sc: 1, fx: 1 };
    }
    c.id = id; c.face = face; c.mesh.geometry = geoFor(face);
    c.sc = 1; c.fx = 1; applyScale(c); c.mesh.visible = true; c.outline.visible = false;
    setPose(c, pose);
    scene.add(c.mesh);
    return c;
  }
  function releaseCard(c: CardObj) { scene.remove(c.mesh); c.outline.visible = false; pool.push(c); }
  function releaseAll() {
    for (let s = 0; s < 4; s++) { for (const c of hands[s] as CardObj[]) releaseCard(c); hands[s] = []; const t = tableCards[s]; if (t) releaseCard(t); tableCards[s] = null; }
  }
  function setFace(c: CardObj, face: CardRef | null) { c.face = face; c.mesh.geometry = geoFor(face); }
  const k = (seat: number) => screenPos(seat, viewSeat);
  const isOwn = (seat: number) => !spectator && seat === viewSeat;

  const stripOn = () => !!strip && mode.phone && !spectator && !!sel.cardId;
  const camEuler = new Euler(0, 0, 0, 'YXZ');
  /**
   * Own card in the bottom strip: placed on the camera ray through a screen point, facing the camera, sized in px.
   * Non-selected cards are small; the selected one is a bit taller and outlined, all on one bottom-aligned row.
   */
  function stripPose(i: number, n: number, selected: boolean): { p: Pose; sc: number } {
    const st = strip!;
    const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
    const small = clamp(h * 0.06, 38, 52), big = small * 1.3;
    const hp = selected ? big : small;
    const cw = small * (CARD_W / CARD_H);
    const avail = Math.max(cw, w - st.left - st.right);
    const sp = Math.min(cw * 1.08, (avail - cw) / Math.max(1, n - 1));
    const cx = st.left + avail / 2 + (i - (n - 1) / 2) * sp;
    const cy = h - st.bottom - hp / 2; // one bottom-aligned row: the selected card is just taller (and outlined)
    const dist = 3.2;
    v3.set((cx / w) * 2 - 1, 1 - (cy / h) * 2, 0.5).unproject(camera).sub(camera.position).normalize();
    const pos = camera.position.clone().addScaledVector(v3, dist);
    const worldH = (hp / h) * 2 * dist * Math.tan(rad(camera.fov / 2));
    camEuler.setFromQuaternion(camera.quaternion, 'YXZ');
    return { p: { x: pos.x, y: pos.y, z: pos.z, rx: camEuler.x, ry: camEuler.y, rz: camEuler.z + (selected ? 0 : (i - (n - 1) / 2) * -0.04) }, sc: worldH / CARD_H };
  }

  /** Pose + scale for a hand card; own selected/previewed card is lifted and enlarged, hovered card is lifted. */
  function slotPose(seat: number, i: number, n: number): { p: Pose; sc: number } {
    if (isOwn(seat) && stripOn()) return stripPose(i, n, (hands[seat] as CardObj[])[i]?.id === sel.cardId);
    const p = handPose(k(seat), i, n, isOwn(seat), mode);
    const c = (hands[seat] as CardObj[])[i];
    if (c && isOwn(seat)) {
      const zid = sel.cardId ?? peekId;
      if (c.id === zid) return { p: zoomPose(k(seat), mode, p.x), sc: ZOOM_SCALE };
      if (c.id === hoverId && !mode.phone) { const [ox, oz] = rot(0, -0.35, k(seat)); return { p: { ...p, y: p.y + 0.4, x: p.x + ox, z: p.z + oz }, sc: 1.25 }; }
    }
    return { p, sc: 1 };
  }
  function moveCard(c: CardObj, to: Pose, dur: number, o: { delay?: number; arc?: number; sfxName?: SfxName; sc?: number } = {}): Promise<void> {
    const toSc = o.sc ?? c.sc;
    if (reduced() || dur <= 0) { setPose(c, to); c.sc = toSc; applyScale(c); c.mesh.visible = true; request(true); return Promise.resolve(); }
    const from = { ...c.pose }, fromSc = c.sc;
    let fired = false;
    return tweens.add(dur, (t) => {
      c.mesh.visible = true;
      if (!fired) { fired = true; if (o.sfxName) sfx(o.sfxName); }
      const p: Pose = { x: lerp(from.x, to.x, t), y: lerp(from.y, to.y, t), z: lerp(from.z, to.z, t), rx: lerp(from.rx, to.rx, t), ry: lerp(from.ry, to.ry, t), rz: lerp(from.rz, to.rz, t) };
      setPose(c, p);
      c.sc = lerp(fromSc, toSc, t); applyScale(c);
      if (o.arc) c.mesh.position.y += o.arc * Math.sin(Math.PI * t);
    }, { delay: o.delay, ease: easeOut });
  }
  function flipTo(c: CardObj, face: CardRef | null, dur = 200): Promise<void> {
    if (reduced()) { setFace(c, face); request(true); return Promise.resolve(); }
    let swapped = false;
    return tweens.add(dur, (t) => {
      if (t < 0.5) c.fx = Math.max(0.001, 1 - 2 * t);
      else { if (!swapped) { swapped = true; setFace(c, face); sfx('flip'); } c.fx = Math.max(0.001, 2 * t - 1); }
      if (t >= 1) c.fx = 1;
      applyScale(c);
    }, { ease: linear });
  }
  function relayoutHand(seat: number, dur: number) {
    const list = hands[seat] as CardObj[];
    list.forEach((c, i) => { const s = slotPose(seat, i, list.length); void moveCard(c, s.p, dur, { sc: s.sc }); });
    updateArms(seat);
  }
  function updateArms(seat: number, rightOverride?: [number, number, number]) {
    const n = (hands[seat] as CardObj[]).length;
    const a = handAnchors(isOwn(seat), mode, n);
    (avatars[seat] as Avatar).setHands(a.l, rightOverride ?? a.r);
    request();
  }
  const pilePose = (seat: number, id: string): Pose => tablePose(k(seat), cardJitter(id));

  // ---------- deck + turn marker ----------
  const deckBox = new Mesh(track(new BoxGeometry(CARD_W, 0.12, CARD_H)), track(new MeshStandardMaterial({ color: C.cream200, roughness: 0.7 })));
  const deckTop = new Mesh(geoFor(null), cardMat); deckTop.rotation.x = -Math.PI / 2;
  const deckGroup = new Object3D(); deckGroup.add(deckBox, deckTop); deckBox.position.y = 0.06; deckTop.position.y = 0.125;
  deckBox.castShadow = true;
  scene.add(deckGroup);
  function placeSeats() {
    for (let s = 0; s < 4; s++) (avatars[s] as Avatar).root.rotation.y = (k(s) * Math.PI) / 2;
    const d = deckPose(k(dealer));
    deckGroup.position.set(d.x, 0, d.z); deckGroup.rotation.y = d.ry + d.rz;
  }
  const turnMark = new Mesh(track(new BoxGeometry(2.4, 0.05, 0.12)), track(new MeshBasicMaterial({ color: C.brass300 })));
  scene.add(turnMark);
  function placeTurn() {
    const kk = k(turn);
    const [x, z] = rot(0, FRAME_HALF + 0.32, kk);
    turnMark.position.set(x, 0.03, z); turnMark.rotation.y = (kk * Math.PI) / 2;
  }

  // ---------- burst ----------
  const NP = 12;
  const pGeo = track(new BufferGeometry());
  pGeo.setAttribute('position', new Float32BufferAttribute(new Float32Array(NP * 3), 3));
  const pc = new Float32Array(NP * 3);
  for (let i = 0; i < NP; i++) col.setHex(i % 2 ? C.cream50 : C.brass300).toArray(pc, i * 3);
  pGeo.setAttribute('color', new Float32BufferAttribute(pc, 3));
  const pMat = track(new PointsMaterial({ size: 0.16, vertexColors: true, transparent: true, depthWrite: false }));
  const points = new Points(pGeo, pMat); points.visible = false; points.frustumCulled = false;
  scene.add(points);
  const flashMat = track(new MeshBasicMaterial({ map: tex.selCircle, transparent: true, depthWrite: false }));
  const flash = new Mesh(ringGeo, flashMat); flash.visible = false; flash.renderOrder = 6;
  scene.add(flash);
  function burst(x: number, z: number): Promise<void> {
    if (reduced() || degrade >= 1 || quality === 'low') {
      flash.position.set(x, BOARD_Y + 0.05, z); flash.visible = true;
      return tweens.add(reduced() ? 150 : 200, (t) => { flash.scale.setScalar(0.8 + t * 1.2); flashMat.opacity = 1 - t; if (t >= 1) flash.visible = false; }, { ease: linear });
    }
    points.visible = true;
    const pos = pGeo.getAttribute('position') as BufferAttribute;
    return tweens.add(300, (t) => {
      for (let i = 0; i < NP; i++) {
        const a = (i / NP) * Math.PI * 2, r = 0.7 * t;
        pos.setXYZ(i, x + Math.cos(a) * r, REST_Y + 0.35 * Math.sin(Math.PI * t) + 0.1, z + Math.sin(a) * r);
      }
      pos.needsUpdate = true; pMat.opacity = 1 - t;
      if (t >= 1) points.visible = false;
    }, { ease: easeOut });
  }

  // ---------- orbit camera (per player: drag rotates around the table, pinch/wheel zooms, double tap resets) ----------
  const cam = { yaw: 0, pitch: rad(52), zoom: 1 };
  const goal = { yaw: 0, pitch: rad(52), zoom: 1 };
  let defPitch = rad(52), baseDist = 30, camMovedFlag = false;
  function poseCamera() {
    const d = baseDist * cam.zoom, hz = d * Math.cos(cam.pitch);
    camera.position.set(Math.sin(cam.yaw) * hz, d * Math.sin(cam.pitch), Math.cos(cam.yaw) * hz);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
  }
  /** Damped step toward the goal (time-based: same feel at 60 and 120 Hz). Returns true while moving. */
  function stepCamera(dt: number): boolean {
    const f = reduced() ? 1 : 1 - Math.exp(-dt / DAMP_S);
    let moving = false;
    for (const key of ['yaw', 'pitch', 'zoom'] as const) {
      const d = goal[key] - cam[key];
      if (Math.abs(d) > 1e-4) { cam[key] += d * f; moving = true; } else cam[key] = goal[key];
    }
    if (moving) poseCamera();
    const moved = Math.abs(Math.atan2(Math.sin(goal.yaw), Math.cos(goal.yaw))) > 0.04 || Math.abs(goal.pitch - defPitch) > 0.03 || Math.abs(goal.zoom - 1) > 0.03;
    if (moved !== camMovedFlag) { camMovedFlag = moved; ev.onCamera?.(moved); }
    return moving;
  }
  function fitDistance(el: number, tv: number, th: number): number {
    const su = Math.sin(el), cu = Math.cos(el);
    let D = 0;
    const pts = framePoints();
    // own hand (phone fan held up / laptop cards in front) must stay on screen too
    if (!spectator) for (const sx of [-1, 1]) pts.push(mode.phone ? [sx * 1.9, 3.1, 7.5] : [sx * 1.7, 1.3, 7.0]);
    for (const [x, y, z] of pts) {
      const pu = y * su + z * cu, pv = y * cu - z * su;
      D = Math.max(D, pu + Math.abs(x) / th, pu + Math.abs(pv) / tv);
    }
    return D;
  }
  function frameCamera() {
    const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
    const landscape = w > h;
    camera.fov = landscape ? 30 : 34;
    const el = rad(landscape ? 42 : w / h < 0.6 ? 55 : 50);
    const m: HandMode = { phone: !!coarse?.matches, el };
    if (m.phone !== mode.phone || Math.abs(m.el - mode.el) > 1e-6) {
      mode = m;
      if (lastView) for (let s = 0; s < 4; s++) { const list = hands[s] as CardObj[]; list.forEach((c, i) => { const sp = slotPose(s, i, list.length); setPose(c, sp.p); c.sc = sp.sc; applyScale(c); }); updateArms(s); }
    }
    if (Math.abs(el - defPitch) > 1e-6) {
      const delta = el - defPitch; defPitch = el;
      goal.pitch = clamp(goal.pitch + delta, PITCH_MIN, PITCH_MAX); cam.pitch = clamp(cam.pitch + delta, PITCH_MIN, PITCH_MAX);
    }
    const effH = Math.max(80, h - insetTop - insetBottom);
    const tv = Math.tan(rad(camera.fov / 2)) * (effH / h) * 0.97;
    const th = Math.tan(rad(camera.fov / 2)) * (w / h) * 0.95;
    baseDist = fitDistance(el, tv, th) * 1.01;
    camera.aspect = w / h;
    camera.setViewOffset(w, h, 0, (insetBottom - insetTop) / 2, w, h);
    camera.updateProjectionMatrix();
    poseCamera();
  }
  function setZoom(z: number, animated = true) {
    goal.zoom = clamp(z, ZOOM_MIN, ZOOM_MAX);
    if (!animated || reduced()) cam.zoom = goal.zoom;
    poseCamera(); request();
  }
  function resetCamera(animated = true) {
    // shortest way back to the seat view
    const turns = Math.round(goal.yaw / (Math.PI * 2));
    goal.yaw = turns * Math.PI * 2; goal.pitch = defPitch; goal.zoom = 1;
    if (!animated || reduced()) { cam.yaw = goal.yaw; cam.pitch = goal.pitch; cam.zoom = goal.zoom; }
    poseCamera(); request();
  }

  function resize() {
    const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, dprCap()));
    renderer.setSize(w, h, false);
    frameCamera(); request();
  }

  // ---------- quality application ----------
  function syncQuality() {
    const hi = quality === 'high';
    cafe.steam.sprites.forEach((s) => { s.visible = steamOn(); });
    cafe.highOnly.forEach((o) => { if (!(o as { isSprite?: boolean }).isSprite) o.visible = hi; });
    mirror.visible = mirrorOn();
    caustics.visible = hi && degrade < 2;
    // High: clear shell over a coloured swirl core. Low: one solid glossy sphere (fewer draw calls).
    marbles.material = hi ? shellMat : solidMat; cores.visible = hi;
    const size = shadowSize();
    if (lamp.shadow.mapSize.x !== size) { lamp.shadow.mapSize.set(size, size); lamp.shadow.map?.dispose(); lamp.shadow.map = null; }
    woodMat.clearcoat = hi ? 0.25 : 0; feltMat.sheen = hi ? 0.5 : 0;
    cafe.tableMat.clearcoat = hi ? 0.25 : 0;
    scene.environmentIntensity = hi ? 0.5 : 0.4;
    cafe.setShadows(hi); for (const a of avatars) a.castShadows(hi);
    npc.setDetail(hi); npc.castShadows(false);
    marbles.castShadow = true;
    resize();
  }
  function applyQuality(q: Quality, reason: 'auto' | 'user') {
    const changedTex = q !== quality;
    quality = q;
    if (reason === 'user') degrade = 0;
    try { localStorage.setItem(GFX_KEY, q); } catch { /* private mode */ }
    if (changedTex) {
      const sz = texSize(q);
      const nw = woodMaps(sz), nf = feltMaps(sz);
      const na = buildAtlas(renderer.capabilities.getMaxAnisotropy(), q === 'high' ? 2048 : 1024);
      const ne = buildEnvironment(renderer, q === 'high' ? (small ? 128 : 256) : 64);
      woodMat.map = nw.map; woodMat.bumpMap = nw.bump; cafe.tableMat.map = nw.map; cafe.tableMat.bumpMap = nw.bump;
      feltMat.map = nf.map; feltMat.bumpMap = nf.bump; cardMat.map = na;
      scene.environment = ne;
      for (const t of [wood.map, wood.bump, feltM.map, feltM.bump, atlas, envTex]) t.dispose();
      wood = nw; feltM = nf; atlas = na; envTex = ne;
      for (const m of [woodMat, feltMat, cardMat, cafe.tableMat]) m.needsUpdate = true;
    }
    syncQuality();
    ev.onQuality?.(q, reason);
    if (reason === 'auto') ev.onStatus?.('degraded');
  }

  // ---------- view sync ----------
  function setView(v: SceneView) {
    lastView = v;
    spectator = v.mySeat === null; viewSeat = v.mySeat ?? specSeat; turn = v.turn; dealer = v.dealer;
    for (let i = 0; i < 16; i++) if (v.marbles[i]) mp[i] = v.marbles[i] as MarblePos;
    layoutBoard(); snapAllMarbles(); placeSeats(); placeTurn();
  }
  function buildHands(v: SceneView, hidden: boolean) {
    releaseAll();
    for (let s = 0; s < 4; s++) {
      const own = isOwn(s);
      const n = own ? v.hand.length : (v.handCounts[s] ?? 0);
      const list: CardObj[] = [];
      for (let i = 0; i < n; i++) {
        const face = own && !hidden ? (v.hand[i] as CardRef) : null;
        const c = makeCard(face, own ? (v.hand[i] as CardRef).id : `back:${s}:${i}`, handPose(k(s), i, n, own, mode));
        list.push(c);
      }
      hands[s] = list;
      const t = v.table[s];
      if (t) { const c = makeCard(t, t.id, pilePose(s, t.id)); c.sc = TABLE_CARD_SCALE; applyScale(c); tableCards[s] = c; }
      updateArms(s);
    }
  }
  function applyView(v: SceneView) {
    tweens.finishAll(); epoch++; dealing = false;
    if (peekId && !v.hand.some((c) => c.id === peekId)) peekId = null;
    setView(v); buildHands(v, false);
    points.visible = false; flash.visible = false;
    refreshOverlays();
  }

  async function playDeal(v: SceneView): Promise<void> {
    tweens.finishAll(); const ep = ++epoch;
    peekId = null;
    setView(v); buildHands(v, true);
    refreshOverlays();
    const order: { seat: number; i: number }[] = [];
    const maxN = Math.max(...hands.map((l) => l.length));
    for (let r = 0; r < maxN; r++) for (let o = 1; o <= 4; o++) { const seat = (dealer + o) % 4; if (r < (hands[seat] as CardObj[]).length) order.push({ seat, i: r }); }
    if (reduced()) {
      for (let s = 0; s < 4; s++) if (isOwn(s)) (hands[s] as CardObj[]).forEach((c, i) => setFace(c, v.hand[i] as CardRef));
      request(true); return;
    }
    dealing = true;
    const stagger = Math.min(90, 1500 / Math.max(1, order.length));
    const dk = deckPose(k(dealer));
    const jobs: Promise<void>[] = [];
    order.forEach((o, j) => {
      const c = (hands[o.seat] as CardObj[])[o.i] as CardObj;
      const target = c.pose;
      setPose(c, dk); c.mesh.visible = false;
      const p = moveCard(c, target, 320, { delay: j * stagger, arc: 0.6, sfxName: 'deal' });
      jobs.push(p.then(() => {
        if (ep === epoch && isOwn(o.seat)) return flipTo(c, v.hand[o.i] as CardRef, 200);
      }));
    });
    // dealer's right hand flicks toward the deck (seat-local frame)
    const total = order.length * stagger + 320;
    const rest = handAnchors(isOwn(dealer), mode, (hands[dealer] as CardObj[]).length).r;
    jobs.push(tweens.add(total, (t) => {
      const f = t >= 1 ? 0 : Math.max(0, Math.sin(t * order.length * Math.PI));
      updateArms(dealer, [lerp(rest[0], 3.0, f), lerp(rest[1], 0.9, f), lerp(rest[2], 7.2, f)]);
    }, { ease: linear }));
    request(true);
    await Promise.all(jobs);
    if (ep === epoch) { dealing = false; refreshOverlays(); }
  }

  /** The card flies from the seat's hand to that seat's spot in the centre pile; the previous one is covered. */
  async function playThrow(seat: number, card: CardRef): Promise<void> {
    if (seat < 0 || seat > 3) return;
    const list = hands[seat] as CardObj[];
    let idx = list.findIndex((c) => c.id === card.id);
    if (idx < 0 && !isOwn(seat)) idx = list.length - 1;
    const c = idx >= 0 ? (list.splice(idx, 1)[0] as CardObj) : makeCard(null, card.id, handPose(k(seat), 0, 1, isOwn(seat), mode));
    const old = tableCards[seat];
    tableCards[seat] = c; c.id = card.id; c.outline.visible = false;
    if (peekId === card.id) peekId = null;
    if (sel.cardId === card.id) sel = { cardId: null, marbleId: null };
    const to = pilePose(seat, card.id);
    const jobs: Promise<void>[] = [];
    if (c.face?.id !== card.id) jobs.push(flipTo(c, card, 160));
    jobs.push(moveCard(c, { ...to, y: to.y + 0.004 }, 320, { arc: 0.5, sfxName: 'throw', sc: TABLE_CARD_SCALE }));
    relayoutHand(seat, 200);
    await Promise.all(jobs);
    if (old && old !== c) releaseCard(old);
    setPose(c, to);
    request(true);
  }

  async function playMove(m: MoveEvent): Promise<void> {
    const ep = epoch;
    const alive = () => ep === epoch && !disposed;
    if (m.card) await playThrow(m.seat, m.card);
    if (!alive()) return;
    const jobs: Promise<void>[] = [];
    if (m.path.length > 1) jobs.push(hopMarble(m.marbleId, m.path, alive));
    if (m.swapWith !== undefined) {
      const a = m.marbleId, b = m.swapWith;
      const pa = mp[a] as MarblePos, pb = mp[b] as MarblePos;
      jobs.length = 0;
      jobs.push(arcMarble(a, pb, 320, 0.8), arcMarble(b, pa, 320, 0.8));
    }
    if (!jobs.length) request(true);
    await Promise.all(jobs);
    if (!alive()) return;
    if (m.captured?.length) {
      const last = m.path[m.path.length - 1];
      const [bx, bz] = last ? posToXZ(last, viewSeat) : [0, 0];
      sfx('capture');
      const cj: Promise<void>[] = [burst(bx, bz)];
      for (const cp of m.captured) cj.push(arcMarble(cp.marbleId, cp.to, 300, 0.7, 120));
      await Promise.all(cj);
    }
    if (alive()) refreshOverlays();
  }

  function arcMarble(id: number, to: MarblePos, dur: number, arc: number, delay = 0): Promise<void> {
    const [tx, tz] = posToXZ(to, viewSeat);
    const fx = mx[id] as number, fz = mz[id] as number, fy = my[id] as number;
    mp[id] = to;
    if (reduced()) { mx[id] = tx; mz[id] = tz; my[id] = REST_Y; writeMarble(id); request(true); return Promise.resolve(); }
    return tweens.add(dur, (t) => {
      mx[id] = lerp(fx, tx, t); mz[id] = lerp(fz, tz, t); my[id] = lerp(fy, REST_Y, t) + arc * Math.sin(Math.PI * t); writeMarble(id);
    }, { ease: easeInOut, delay });
  }

  async function hopMarble(id: number, path: MarblePos[], alive: () => boolean): Promise<void> {
    const pts = path.map((p) => posToXZ(p, viewSeat));
    const n = pts.length - 1;
    mp[id] = path[path.length - 1] as MarblePos;
    const [ex, ez] = pts[n] as [number, number];
    if (reduced()) {
      mx[id] = ex; mz[id] = ez; my[id] = REST_Y; writeMarble(id);
      await burstFlashOnly(ex, ez); return;
    }
    const per = Math.min(90, 520 / n);
    let last = -1;
    await tweens.add(per * n, (t) => {
      const f = Math.min(n - 0.0001, t * n), s = Math.floor(f), l = easeInOut(f - s);
      if (t >= 1) { mx[id] = ex; mz[id] = ez; my[id] = REST_Y; writeMarble(id); return; }
      const a = pts[s] as [number, number], b = pts[s + 1] as [number, number];
      const dist = Math.hypot(b[0] - a[0], b[1] - a[1]);
      mx[id] = lerp(a[0], b[0], l); mz[id] = lerp(a[1], b[1], l);
      my[id] = REST_Y + (0.16 + Math.min(0.8, dist * 0.22)) * Math.sin(Math.PI * l);
      if (s !== last) { last = s; sfx('hop'); }
      writeMarble(id);
    }, { ease: linear });
    if (!alive()) return;
    await tweens.add(90, (t) => { msy[id] = 0.88 + 0.12 * t; writeMarble(id); }, { ease: easeOut });
  }
  function burstFlashOnly(x: number, z: number): Promise<void> {
    flash.position.set(x, BOARD_Y + 0.05, z); flash.visible = true;
    return tweens.add(100, (t) => { flash.scale.setScalar(1 + t * 0.4); flashMat.opacity = 1 - t * 0.6; if (t >= 1) flash.visible = false; }, { ease: linear });
  }
  const sfx = (n: SfxName) => ev.onSfx?.(n);

  // ---------- picking ----------
  const ray = new Raycaster();
  const v3 = new Vector3();
  const ndc = new Vector2();
  const boardPlane = new Plane(new Vector3(0, 1, 0), -BOARD_Y);
  const rectNow = () => canvas.getBoundingClientRect();
  const screenOf = (x: number, y: number, z: number, rect: DOMRect): [number, number, boolean] => {
    v3.set(x, y, z).project(camera);
    return [(v3.x * 0.5 + 0.5) * rect.width, (-v3.y * 0.5 + 0.5) * rect.height, v3.z < 1];
  };
  /** Nearest own hand card to a screen point (cards are small on phones, so use a generous slop instead of exact hits). */
  function nearestOwnCard(px: number, py: number, rect: DOMRect, slop: number): CardObj | null {
    if (spectator) return null;
    const own = hands[viewSeat] as CardObj[];
    const zid = sel.cardId ?? peekId;
    const zc = zid ? own.find((c) => c.id === zid) : undefined;
    if (zc) {
      ndc.set((px / rect.width) * 2 - 1, -(py / rect.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      if (ray.intersectObject(zc.mesh, false)[0]) return zc;
    }
    let best: CardObj | null = null, bd = slop;
    for (const c of own) {
      const [sx, sy] = screenOf(c.mesh.position.x, c.mesh.position.y, c.mesh.position.z, rect);
      const d = Math.hypot(sx - px, sy - py);
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }
  /** Nearest interactive thing on the board: a target marble or a destination square. */
  function nearestTarget(px: number, py: number, rect: DOMRect, slop: number): { marble?: number; cell?: MarblePos } | null {
    if (!targets) return null;
    let best: { marble?: number; cell?: MarblePos } | null = null, bd = slop;
    for (const id of targets.marbles ?? []) {
      const [sx, sy] = screenOf(mx[id] as number, my[id] as number, mz[id] as number, rect);
      const d = Math.hypot(sx - px, sy - py);
      if (d < bd) { bd = d; best = { marble: id }; }
    }
    for (const c of targets.cells ?? []) {
      const [x, z] = posToXZ(c, viewSeat);
      const [sx, sy] = screenOf(x, BOARD_Y, z, rect);
      const d = Math.hypot(sx - px, sy - py) - 2; // ties go to the destination
      if (d < bd) { bd = d; best = { cell: c }; }
    }
    return best;
  }
  let lastTap = { t: 0, x: 0, y: 0, empty: false };
  function pick(cx: number, cy: number) {
    const rect = rectNow();
    if (dealing) { tweens.finishAll(); dealing = false; return; }
    const px = cx - rect.left, py = cy - rect.top;
    const now = performance.now();
    const dbl = lastTap.empty && now - lastTap.t < 320 && Math.hypot(px - lastTap.x, py - lastTap.y) < 36;
    lastTap = { t: now, x: px, y: py, empty: false };
    if (interactive) {
      // Board targets (marbles / destinations) win over the own cards: the enlarged selected card used to sit on
      // top of the own base, so a tap on a base marble re-selected the card and the throw step was never reached.
      const t = nearestTarget(px, py, rect, 32);
      const card = nearestOwnCard(px, py, rect, 34);
      const near = card ? nearestOwnCard(px, py, rect, 14) === card : false;
      const what = choosePick(t, card ? { id: card.id, near } : null, sel.cardId);
      if (what === 'target' && t?.cell) { ev.onPickCell?.(t.cell); return; }
      if (what === 'target' && t?.marble !== undefined) { ev.onPickMarble?.(t.marble); return; }
      if (what === 'card' && card) { if (card.id !== sel.cardId) { peekId = card.id; relayoutHand(viewSeat, 160); } ev.onPickCard?.(card.id); return; }
    }
    // Empty space: a double tap brings the camera back behind the own seat.
    if (dbl) { resetCamera(true); lastTap.empty = false; return; }
    lastTap.empty = true;
    if (peekId) { peekId = null; relayoutHand(viewSeat, 160); }
    if (interactive) ev.onPickNothing?.();
  }

  // ---------- gestures: tap = pick, one-finger drag = orbit (or move a marble), two fingers = pinch zoom ----------
  type Press = { id: number; x: number; y: number; t: number; lx: number; ly: number; lt: number; vx: number };
  const presses = new Map<number, Press>();
  let gesture: 'none' | 'tap' | 'orbit' | 'marble' | 'pinch' = 'none';
  let dragMarble = -1, pinch0 = { d: 1, zoom: 1 };
  const dragging = () => gesture === 'orbit' || gesture === 'marble' || gesture === 'pinch';
  function boardPoint(cx: number, cy: number): Vector3 | null {
    const rect = rectNow();
    ndc.set(((cx - rect.left) / rect.width) * 2 - 1, -((cy - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    return ray.ray.intersectPlane(boardPlane, v3) ? v3.clone() : null;
  }
  function nearestCellXZ(x: number, z: number): MarblePos | null {
    let best: MarblePos | null = null, bd = CELL * 1.7;
    for (const c of targets?.cells ?? []) {
      const [cx, cz] = posToXZ(c, viewSeat);
      const d = Math.hypot(cx - x, cz - z);
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }
  const onDown = (e: PointerEvent) => {
    if (e.button > 0) return;
    try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const now = performance.now();
    presses.set(e.pointerId, { id: e.pointerId, x: e.clientX, y: e.clientY, t: now, lx: e.clientX, ly: e.clientY, lt: now, vx: 0 });
    if (presses.size === 2) {
      const [a, b] = [...presses.values()] as [Press, Press];
      pinch0 = { d: Math.max(20, Math.hypot(a.lx - b.lx, a.ly - b.ly)), zoom: goal.zoom };
      if (gesture === 'marble') endMarbleDrag(null);
      gesture = 'pinch';
      return;
    }
    if (presses.size > 2) return;
    gesture = 'tap';
    dragMarble = -1;
    if (interactive && targets?.marbles?.length && !dealing) {
      const rect = rectNow();
      const t = nearestTarget(e.clientX - rect.left, e.clientY - rect.top, rect, 30);
      if (t?.marble !== undefined) dragMarble = t.marble;
    }
  };
  function endMarbleDrag(cell: MarblePos | null) {
    const id = dragMarble;
    dragMarble = -1; gesture = 'none';
    if (id < 0) return;
    snapCell = null;
    void arcMarble(id, mp[id] as MarblePos, 160, 0.15);
    ev.onDrop?.(id, cell);
    refreshOverlays();
  }
  const onMove = (e: PointerEvent) => {
    const p = presses.get(e.pointerId);
    if (!p) { hover(e); return; }
    const now = performance.now();
    const dx = e.clientX - p.lx, dy = e.clientY - p.ly;
    if (now - p.lt > 0) p.vx = dx / Math.max(1, now - p.lt);
    p.lx = e.clientX; p.ly = e.clientY; p.lt = now;
    if (gesture === 'pinch') {
      const [a, b] = [...presses.values()] as [Press, Press];
      if (!a || !b) return;
      const d = Math.max(20, Math.hypot(a.lx - b.lx, a.ly - b.ly));
      goal.zoom = clamp(pinch0.zoom * (pinch0.d / d), ZOOM_MIN, ZOOM_MAX);
      if (reduced()) { cam.zoom = goal.zoom; poseCamera(); }
      request(); return;
    }
    if (gesture === 'tap' && Math.hypot(e.clientX - p.x, e.clientY - p.y) > SLOP) {
      if (dragMarble >= 0 && ev.onDragStart?.(dragMarble)) { gesture = 'marble'; tweens.finishAll(); }
      else { gesture = 'orbit'; dragMarble = -1; }
    }
    if (gesture === 'orbit') {
      const rect = rectNow();
      goal.yaw -= (dx / Math.max(200, rect.width)) * Math.PI * 1.15;
      goal.pitch = clamp(goal.pitch + (dy / Math.max(200, rect.height)) * Math.PI * 0.7, PITCH_MIN, PITCH_MAX);
      if (reduced()) { cam.yaw = goal.yaw; cam.pitch = goal.pitch; poseCamera(); }
      request(); return;
    }
    if (gesture === 'marble' && dragMarble >= 0) {
      const bp = boardPoint(e.clientX, e.clientY);
      if (bp) {
        mx[dragMarble] = bp.x; mz[dragMarble] = bp.z; my[dragMarble] = REST_Y + 0.42; writeMarble(dragMarble);
        const sc = nearestCellXZ(bp.x, bp.z);
        if (!samePos(sc, snapCell)) { snapCell = sc; refreshOverlays(); }
      }
      request(true);
    }
  };
  const onUp = (e: PointerEvent) => {
    const p = presses.get(e.pointerId);
    presses.delete(e.pointerId);
    if (!p) return;
    if (gesture === 'pinch') { if (presses.size === 0) gesture = 'none'; return; }
    if (gesture === 'marble') { endMarbleDrag(nearestCellXZ(mx[dragMarble] as number, mz[dragMarble] as number)); return; }
    if (gesture === 'orbit') {
      // a little glide after a flick (not with reduced motion)
      if (!reduced() && performance.now() - p.lt < 60) goal.yaw -= clamp(p.vx, -2.5, 2.5) * 0.12 * Math.PI;
      gesture = 'none'; request(); return;
    }
    if (gesture === 'tap' && performance.now() - p.t < 650) pick(e.clientX, e.clientY);
    gesture = 'none'; dragMarble = -1;
  };
  const onCancel = (e: PointerEvent) => {
    presses.delete(e.pointerId);
    if (gesture === 'marble') endMarbleDrag(null);
    if (!presses.size) gesture = 'none';
  };
  function hover(e: PointerEvent) {
    if (e.pointerType !== 'mouse' || !interactive || dealing) return;
    const rect = rectNow();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const c = spectator ? null : nearestOwnCard(px, py, rect, 24);
    const id = c?.id ?? null;
    const onTarget = !c && !!nearestTarget(px, py, rect, 26);
    canvas.style.cursor = id || onTarget ? 'pointer' : 'grab';
    if (id === hoverId) return;
    hoverId = id;
    relayoutHand(viewSeat, 120);
    ev.onHoverCard?.(id);
  }
  const onLeave = () => { if (hoverId) { hoverId = null; canvas.style.cursor = ''; relayoutHand(viewSeat, 120); ev.onHoverCard?.(null); } };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const f = Math.exp(clamp(e.deltaY, -120, 120) * (e.ctrlKey ? 0.01 : 0.0018));
    goal.zoom = clamp(goal.zoom * f, ZOOM_MIN, ZOOM_MAX);
    if (reduced()) { cam.zoom = goal.zoom; poseCamera(); }
    request();
  };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onCancel);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('wheel', onWheel, { passive: false });

  // ---------- pirate reading animation ----------
  let npcRead = 0, npcJob = 0;
  function npcTo(to: number, dur: number): Promise<void> {
    const job = ++npcJob, from = npcRead;
    if (reduced() || quality === 'low') { npcRead = to; npc.setRead(to); request(); return Promise.resolve(); }
    return tweens.add(dur, (t) => { if (job !== npcJob) return; npcRead = lerp(from, to, t); npc.setRead(npcRead); }, { ease: easeInOut });
  }

  // ---------- lifecycle ----------
  const onLost = (e: Event) => { e.preventDefault(); ev.onStatus?.('context-lost'); };
  const onRestored = () => { for (const t of [atlas, wood.map, wood.bump, feltM.map, feltM.bump, swirl, soft, bokeh, star]) t.needsUpdate = true; request(true); ev.onStatus?.('restored'); };
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => resize()) : null;
  ro?.observe(canvas);
  const onMq = () => request();
  mq?.addEventListener?.('change', onMq);
  const onVis = () => { if (document.visibilityState === 'visible') { lastFrame = 0; request(); } };
  document.addEventListener('visibilitychange', onVis);

  scene.updateMatrixWorld();
  setView({ mySeat: 0, dealer: 0, turn: 0, hand: [], handCounts: [0, 0, 0, 0], marbles: mp.slice(), table: [null, null, null, null] });
  syncQuality();
  ev.onStatus?.('ready');

  const SEAT_AR = ['المقعد 1', 'المقعد 2', 'المقعد 3', 'المقعد 4'];
  const project = (p: Vector3): { x: number; y: number } | null => {
    v3.copy(p).project(camera);
    const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
    const x = (v3.x * 0.5 + 0.5) * w, y = (-v3.y * 0.5 + 0.5) * h;
    return v3.z > 1 || x < 0 || y < 0 || x > w || y > h ? null : { x, y };
  };
  const tmp = new Vector3(), tmp2 = new Vector3();
  const api: SceneApi = {
    applyView, playDeal, playMove, playThrow,
    skipAnimations() { tweens.finishAll(); dealing = false; request(true); },
    setSelection(s) {
      const before = sel.cardId;
      sel = { cardId: s.cardId ?? null, marbleId: s.marbleId ?? null };
      peekId = sel.cardId;
      if (before !== sel.cardId && strip && mode.phone) relayoutHand(viewSeat, 220);
      refreshOverlays();
    },
    setHandStrip(b) {
      const was = stripOn();
      strip = b ? { bottom: Math.max(0, b.bottom), left: Math.max(0, b.left ?? 0), right: Math.max(0, b.right ?? 0) } : null;
      if (was || stripOn()) relayoutHand(viewSeat, 220);
    },
    setHints(h) { hints = h; refreshOverlays(); },
    setTargets(t) {
      targets = t && (t.marbles?.length || t.cells?.length || t.chosen || (t.selected ?? null) !== null) ? t : null;
      if (!targets) snapCell = null;
      refreshOverlays();
    },
    setInsets(i) { insetTop = i.top ?? 0; insetBottom = i.bottom ?? 0; frameCamera(); request(); },
    setViewSeat(seat, animated = true) {
      if (!spectator || !(seat >= 0 && seat <= 3) || seat === viewSeat) return;
      const raw = (((seat - viewSeat) % 4) + 4) % 4;
      const d = raw > 2 ? raw - 4 : raw;
      specSeat = seat;
      tweens.finishAll(); epoch++; dealing = false;
      if (lastView) { setView(lastView); buildHands(lastView, false); refreshOverlays(); }
      const y0 = (-d * Math.PI) / 2;
      goal.yaw = 0; cam.yaw = animated && !reduced() ? y0 : 0;
      poseCamera(); request();
    },
    setQuality(q) { if (q === 'high' || q === 'low') applyQuality(q, 'user'); },
    get quality() { return quality; },
    seatAnchor(seat) {
      const a = avatars[seat];
      if (!a) return null;
      a.root.updateMatrixWorld(true);
      return project(tmp.copy(a.head).applyMatrix4(a.root.matrixWorld));
    },
    marbleAnchor(id) {
      if (!(id >= 0 && id < 16)) return null;
      return project(tmp.set(mx[id] as number, my[id] as number, mz[id] as number));
    },
    cellAnchor(pos) {
      const [x, z] = posToXZ(pos, viewSeat);
      return project(tmp.set(x, BOARD_Y, z));
    },
    cardAnchor(id) {
      if (spectator) return null;
      const c = (hands[viewSeat] as CardObj[]).find((x) => x.id === id);
      if (!c || !c.mesh.visible) return null;
      c.mesh.updateMatrixWorld(true);
      const top = project(tmp.set(0, CARD_H / 2, 0).applyMatrix4(c.mesh.matrixWorld));
      const l = project(tmp2.set(-CARD_W / 2, CARD_H / 2, 0).applyMatrix4(c.mesh.matrixWorld));
      const r = project(tmp.set(CARD_W / 2, CARD_H / 2, 0).applyMatrix4(c.mesh.matrixWorld));
      if (!top) return null;
      return { ...top, w: l && r ? Math.hypot(r.x - l.x, r.y - l.y) : 40 };
    },
    npcAnchor() {
      npc.root.updateMatrixWorld(true);
      const head = project(tmp.copy(npc.head).applyMatrix4(npc.root.matrixWorld));
      const b = project(tmp.copy(npc.badge).applyMatrix4(npc.root.matrixWorld));
      const bl = project(tmp2.copy(npc.badge).add(new Vector3(-0.65, 0, 0)).applyMatrix4(npc.root.matrixWorld));
      const br = project(tmp2.copy(npc.badge).add(new Vector3(0.65, 0, 0)).applyMatrix4(npc.root.matrixWorld));
      return { head, badge: b ? { ...b, w: bl && br ? Math.hypot(br.x - bl.x, br.y - bl.y) : 0 } : null };
    },
    npcRead() { return npcTo(1, 900); },
    npcDone() { void npcTo(0, 500); },
    resetCamera,
    setZoom,
    setReducedMotion(v) { reducedOverride = v; request(); },
    setInteractive(v) { interactive = v; },
    describe() {
      const parts: string[] = [`الدور على ${SEAT_AR[turn]}.`];
      for (let s = 0; s < 4; s++) {
        let b = 0, t = 0, h = 0;
        for (let i = s * 4; i < s * 4 + 4; i++) { const p = mp[i] as MarblePos; if (p.zone === 'base') b++; else if (p.zone === 'track') t++; else h++; }
        parts.push(`${SEAT_AR[s]}: ${b} بالقاعدة، ${t} على الطريق، ${h} بالبيت.`);
      }
      return parts.join(' ');
    },
    resize,
    get stats() { return { drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles, degradeLevel: degrade }; },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      tweens.finishAll();
      ro?.disconnect(); mq?.removeEventListener?.('change', onMq);
      document.removeEventListener('visibilitychange', onVis);
      for (const [n, f] of [['pointerdown', onDown], ['pointerup', onUp], ['pointercancel', onCancel], ['pointermove', onMove], ['pointerleave', onLeave], ['wheel', onWheel]] as const) canvas.removeEventListener(n, f as EventListener);
      canvas.removeEventListener('webglcontextlost', onLost); canvas.removeEventListener('webglcontextrestored', onRestored);
      scene.traverse((o) => {
        const m = o as Mesh;
        const mats = m.material as Material | Material[] | undefined;
        if (mats) (Array.isArray(mats) ? mats : [mats]).forEach((x) => (x as Material & { map?: Texture | null }).map?.dispose());
      });
      for (const t of [wood.map, wood.bump, feltM.map, feltM.bump, atlas, envTex]) t.dispose();
      cafe.dispose();
      for (const d of disposables) d.dispose();
      for (const m of [holeRing, holeCore, startRings, lanes, trays, stars, marbles, cores, mirror, blobs, caustics]) m.dispose();
      lamp.shadow.map?.dispose();
      renderer.dispose(); renderer.forceContextLoss();
    },
  };
  void BACK_INDEX;
  return api;
}
