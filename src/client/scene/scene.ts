import {
  ACESFilmicToneMapping, AmbientLight, BoxGeometry, BufferAttribute, BufferGeometry, CircleGeometry, Color, DirectionalLight,
  DoubleSide, ExtrudeGeometry, FogExp2, Float32BufferAttribute, HemisphereLight, InstancedMesh, Material, Mesh, MeshBasicMaterial,
  MeshPhysicalMaterial, MeshStandardMaterial, Object3D, PCFSoftShadowMap, PerspectiveCamera, Path, PlaneGeometry, Points,
  PointsMaterial, Raycaster, Scene, Shape, SphereGeometry, SpotLight, Texture, Vector2, Vector3, WebGLRenderer,
} from 'three';
import { C, CSS, SEAT_COLORS } from './colors';
import { Tweens, easeInOut, easeOut, linear } from './tween';
import {
  BOARD_Y, CARD_H, CARD_W, MARBLE_R, ZOOM_SCALE, allCells, deckPose, handAnchors, handPose, posToXZ, rot, screenPos, tablePose, zoomPose,
} from './layout';
import type { HandMode, Pose } from './layout';
import { BACK_INDEX, atlasUV, buildAtlas, faceIndex, outlineTexture } from './textures';
import { bokehTexture, buildEnvironment, feltMaps, softCircleTexture, swirlNormal, woodMaps } from './materials';
import type { PbrMaps } from './materials';
import { createAvatar } from './avatar';
import type { Avatar } from './avatar';
import { buildCafe } from './cafe';
import type { CardRef, Hints, MarblePos, MoveEvent, Quality, SceneApi, SceneEvents, SceneOptions, SceneView, SfxName } from './types';

const REST_Y = BOARD_Y + MARBLE_R;
const rad = (d: number) => (d * Math.PI) / 180;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const GFX_KEY = 'gfx';

export function isWebGLAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch { return false; }
}

function readGfx(): Quality | null {
  try { const v = localStorage.getItem(GFX_KEY); return v === 'low' || v === 'high' ? v : null; } catch { return null; }
}

interface CardObj { mesh: Mesh; outline: Mesh; id: string; face: CardRef | null; pose: Pose; sc: number; fx: number }

/** Returns null when WebGL is unavailable: the UI then shows the 2D SVG fallback. */
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
  const camera = new PerspectiveCamera(32, 1, 0.5, 400);
  renderer.setClearColor(C.wood900);

  // ---------- state ----------
  let viewSeat = 0, specSeat = 0, spectator = false, turn = 0, dealer = 0;
  let interactive = true, disposed = false, dealing = false, epoch = 0;
  let reducedOverride: boolean | null = opts.reducedMotion ?? null;
  const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  const coarse = typeof matchMedia === 'function' ? matchMedia('(pointer: coarse)') : null;
  const reduced = () => (reducedOverride ?? mq?.matches ?? false);
  let insetTop = 0, insetBottom = 0, zoom = 1;
  let degrade = 0;
  let sel: { cardId: string | null; marbleId: number | null } = { cardId: null, marbleId: null };
  let peekId: string | null = null, hoverId: string | null = null;
  let hints: Hints | null = null;
  let lastView: SceneView | null = null;
  let mode: HandMode = { phone: false, el: rad(48) };

  // ---------- quality ----------
  const dprCap = () => (quality === 'low' ? 1.25 : degrade >= 3 ? 1.5 : 2);
  const shadowSize = () => (quality === 'low' || degrade >= 4 ? 1024 : 2048);
  const steamOn = () => quality === 'high' && degrade < 1;
  const mirrorOn = () => quality === 'high' && degrade < 2;
  const continuous = () => quality === 'high' && !reduced() && document.visibilityState !== 'hidden';

  // ---------- render on demand ----------
  let raf = 0, lastActive = 0, lastRender = 0, prevT = 0, shadowDirty = true;
  let winSum = 0, winN = 0;
  const tweens = new Tweens(() => request());
  function request() { shadowDirty = true; if (!raf && !disposed) raf = requestAnimationFrame(frame); }
  function frame(now: number) {
    raf = 0;
    if (disposed || document.visibilityState === 'hidden') return;
    const active = tweens.step(now);
    const cont = continuous();
    const minGap = quality === 'low' ? 30 : !active && cont ? 32 : 0;
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
    if (cont) { camDrift = Math.sin((now / 8000) * Math.PI * 2) * rad(0.4); poseCamera(); }
    else if (camDrift !== 0) { camDrift = 0; poseCamera(); }
    if (steamOn()) cafe.steam.tick(now / 1000);
    renderer.shadowMap.needsUpdate = active || shadowDirty;
    shadowDirty = false;
    renderer.render(scene, camera);
    if (active || cont || now - lastActive < 250) raf = requestAnimationFrame(frame);
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
  const lamp = new SpotLight(0xffd9a0, 1500, 0, 0.75, 0.8, 2);
  lamp.position.set(0, 24, 2); lamp.target.position.set(0, 0, 0);
  lamp.castShadow = true;
  lamp.shadow.camera.near = 10; lamp.shadow.camera.far = 45;
  lamp.shadow.bias = -0.0004; lamp.shadow.normalBias = 0.02; lamp.shadow.radius = 4;
  scene.add(hemi, rim, lamp, lamp.target, new AmbientLight(0xffffff, 0.15));

  // ---------- quality-dependent textures ----------
  const swirl = track(swirlNormal());
  const soft = track(softCircleTexture());
  const bokeh = track(bokehTexture());
  let wood: PbrMaps = woodMaps(quality === 'high' ? 1024 : 512);
  let feltM: PbrMaps = feltMaps(quality === 'high' ? 1024 : 512);
  let atlas = buildAtlas(renderer.capabilities.getMaxAnisotropy(), quality === 'high' ? 2048 : 1024);
  let envTex: Texture = buildEnvironment(renderer, quality === 'high' ? 256 : 64);
  scene.environment = envTex; scene.environmentIntensity = quality === 'high' ? 0.5 : 0.4;

  // ---------- café set + board ----------
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
  const feltMat = track(new MeshPhysicalMaterial({ map: feltM.map, bumpMap: feltM.bump, bumpScale: 0.8, roughness: 0.95, sheen: 0.6, sheenColor: new Color(C.felt500), sheenRoughness: 0.8 }));
  const woodMat = track(new MeshPhysicalMaterial({ map: wood.map, bumpMap: wood.bump, bumpScale: 1.2, roughness: 0.55, clearcoat: 0.25, clearcoatRoughness: 0.4 }));
  const brassMat = track(new MeshStandardMaterial({ color: C.brass500, metalness: 1, roughness: 0.28 }));
  const BW = 11.4, FW = 10.2;
  const base = new Mesh(track(new BoxGeometry(BW, BOARD_Y, BW)), woodMat);
  base.position.y = BOARD_Y / 2; base.receiveShadow = true;
  const felt = new Mesh(track(new PlaneGeometry(FW, FW)), feltMat);
  felt.rotation.x = -Math.PI / 2; felt.position.y = BOARD_Y + 0.001; felt.receiveShadow = true;
  const rimM = new Mesh(frameGeo(BW, FW + 0.1, 0.1), woodMat);
  rimM.position.y = BOARD_Y; rimM.castShadow = true; rimM.receiveShadow = true;
  const brass = new Mesh(frameGeo(FW + 0.1, FW, 0.105), brassMat);
  brass.position.y = BOARD_Y;
  scene.add(base, felt, rimM, brass);

  const discGeo = track(new CircleGeometry(1, 20));
  discGeo.rotateX(-Math.PI / 2);
  const CELLS = allCells();
  const NHOLE = CELLS.length + 16;
  const holes = new InstancedMesh(discGeo, track(new MeshStandardMaterial({ roughness: 0.9 })), NHOLE);
  const starts = new InstancedMesh(discGeo, track(new MeshStandardMaterial({ roughness: 0.4, metalness: 0.5 })), 4);
  holes.receiveShadow = true;
  scene.add(starts, holes);
  const dummy = new Object3D();
  const col = new Color();

  function layoutBoard() {
    let n = 0;
    const put = (x: number, z: number, r: number, color: number) => {
      dummy.position.set(x, BOARD_Y + 0.004, z); dummy.scale.set(r, 1, r); dummy.rotation.set(0, 0, 0); dummy.updateMatrix();
      holes.setMatrixAt(n, dummy.matrix); holes.setColorAt(n, col.setHex(color)); n++;
    };
    for (const c of CELLS) {
      const [x, z] = posToXZ(c, viewSeat);
      put(x, z, c.zone === 'home' ? 0.19 : 0.14, c.zone === 'home' ? SEAT_COLORS[c.seat] as number : C.felt700);
    }
    for (let s = 0; s < 4; s++) for (let j = 0; j < 4; j++) {
      const [x, z] = posToXZ({ zone: 'base', seat: s, slot: j }, viewSeat);
      put(x, z, 0.26, SEAT_COLORS[s] as number);
    }
    holes.instanceMatrix.needsUpdate = true;
    if (holes.instanceColor) holes.instanceColor.needsUpdate = true;
    for (let s = 0; s < 4; s++) {
      const [x, z] = posToXZ({ zone: 'track', index: s * 19 }, viewSeat);
      dummy.position.set(x, BOARD_Y + 0.002, z); dummy.scale.set(0.27, 1, 0.27); dummy.updateMatrix();
      starts.setMatrixAt(s, dummy.matrix); starts.setColorAt(s, col.setHex(SEAT_COLORS[s] as number));
    }
    starts.instanceMatrix.needsUpdate = true;
    if (starts.instanceColor) starts.instanceColor.needsUpdate = true;
  }

  // ---------- marbles (glass look, one InstancedMesh, 16) ----------
  const marbleGeo = track(new SphereGeometry(MARBLE_R, 28, 18));
  const marbleMat = track(new MeshPhysicalMaterial({
    roughness: 0.05, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.03, ior: 1.5, envMapIntensity: 1.2,
    normalMap: swirl, normalScale: new Vector2(0.5, 0.5),
  }));
  const marbles = new InstancedMesh(marbleGeo, marbleMat, 16);
  marbles.castShadow = true;
  const mirrorMat = track(new MeshBasicMaterial({ transparent: true, opacity: 0.13, depthTest: false, depthWrite: false, side: DoubleSide }));
  const mirror = new InstancedMesh(marbleGeo, mirrorMat, 16);
  mirror.renderOrder = 3; mirror.frustumCulled = false;
  const blobGeo = track(new CircleGeometry(MARBLE_R * 1.25, 16)); blobGeo.rotateX(-Math.PI / 2);
  const blobs = new InstancedMesh(blobGeo, track(new MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.9, map: soft, depthWrite: false })), 16);
  blobs.renderOrder = 2;
  scene.add(marbles, mirror, blobs);
  const mp: MarblePos[] = [];
  const mx = new Float32Array(16), my = new Float32Array(16), mz = new Float32Array(16), msy = new Float32Array(16).fill(1);
  for (let i = 0; i < 16; i++) {
    mp.push({ zone: 'base', seat: i >> 2, slot: i & 3 });
    marbles.setColorAt(i, col.setHex(SEAT_COLORS[i >> 2] as number));
    mirror.setColorAt(i, col.setHex(SEAT_COLORS[i >> 2] as number).multiplyScalar(0.7));
  }
  function writeMarble(i: number) {
    const sy = msy[i] as number, sx = 1 + (1 - sy) * 0.5;
    const x = mx[i] as number, y = my[i] as number, z = mz[i] as number;
    dummy.rotation.set(0, 0, 0);
    dummy.position.set(x, y - MARBLE_R * (1 - sy), z);
    dummy.scale.set(sx, sy, sx); dummy.updateMatrix();
    marbles.setMatrixAt(i, dummy.matrix);
    const h = Math.max(0, y - REST_Y), s = 1 / (1 + h * 1.5);
    dummy.position.set(x, BOARD_Y + 0.006, z); dummy.scale.set(s, 1, s); dummy.updateMatrix();
    blobs.setMatrixAt(i, dummy.matrix);
    // mirrored copy under the felt plane
    dummy.position.set(x, 2 * (BOARD_Y + 0.002) - (y - MARBLE_R * (1 - sy)), z); dummy.scale.set(sx, -sy, sx); dummy.updateMatrix();
    mirror.setMatrixAt(i, dummy.matrix);
    marbles.instanceMatrix.needsUpdate = true; blobs.instanceMatrix.needsUpdate = true; mirror.instanceMatrix.needsUpdate = true;
  }
  function snapMarble(i: number) {
    const [x, z] = posToXZ(mp[i] as MarblePos, viewSeat);
    mx[i] = x; mz[i] = z; my[i] = REST_Y; msy[i] = 1; writeMarble(i);
  }
  function snapAllMarbles() { for (let i = 0; i < 16; i++) snapMarble(i); }
  if (marbles.instanceColor) marbles.instanceColor.needsUpdate = true;
  if (mirror.instanceColor) mirror.instanceColor.needsUpdate = true;

  // ---------- avatars ----------
  const avatars: Avatar[] = [0, 1, 2, 3].map((s) => { const a = createAvatar(s); scene.add(a.root); return a; });
  for (const a of avatars) disposables.push(a);

  // ---------- overlays (selection / hints) ----------
  const tex = {
    selCircle: track(outlineTexture('circle', false, CSS.brass300)),
    hintCircle: track(outlineTexture('circle', true, CSS.ok500)),
    selRect: track(outlineTexture('rect', false, CSS.brass300)),
    hintRect: track(outlineTexture('rect', true, CSS.ok500)),
  };
  const mat = (t: Texture) => track(new MeshBasicMaterial({ map: t, transparent: true, depthWrite: false }));
  const ringMats = { sel: mat(tex.selCircle), hint: mat(tex.hintCircle) };
  const outlineMats = { sel: mat(tex.selRect), hint: mat(tex.hintRect) };
  const ringGeo = track(new PlaneGeometry(0.7, 0.7)); ringGeo.rotateX(-Math.PI / 2);
  const rings: Mesh[] = [];
  let ringsUsed = 0;
  function ring(kind: 'sel' | 'hint', x: number, z: number, y = BOARD_Y + 0.03) {
    let m = rings[ringsUsed];
    if (!m) { m = new Mesh(ringGeo, ringMats.sel); m.renderOrder = 5; scene.add(m); rings.push(m); }
    m.material = ringMats[kind]; m.position.set(x, y, z); m.scale.setScalar(kind === 'sel' ? 1.12 : 1);
    m.visible = true; ringsUsed++;
  }
  function refreshOverlays() {
    ringsUsed = 0;
    if (sel.marbleId !== null) ring('sel', mx[sel.marbleId] as number, mz[sel.marbleId] as number);
    for (const id of hints?.marbleIds ?? []) if (id >= 0 && id < 16) ring('hint', mx[id] as number, mz[id] as number);
    for (const c of hints?.cells ?? []) { const [x, z] = posToXZ(c, viewSeat); ring('hint', x, z); }
    for (let i = ringsUsed; i < rings.length; i++) (rings[i] as Mesh).visible = false;
    for (const list of hands) for (const c of list) {
      const s = c.id === sel.cardId, h = !s && !!hints?.cardIds?.includes(c.id);
      c.outline.visible = s || h;
      if (s || h) c.outline.material = outlineMats[s ? 'sel' : 'hint'];
    }
    relayoutHand(viewSeat, 150);
    request();
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
  const meshToCard = new Map<Mesh, CardObj>();

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
      const outline = new Mesh(outlineGeo, outlineMats.sel);
      outline.position.z = -0.006; outline.visible = false; outline.renderOrder = 4;
      mesh.add(outline);
      c = { mesh, outline, id, face, pose, sc: 1, fx: 1 };
      meshToCard.set(mesh, c);
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

  /** Pose + scale for a hand card; own selected/previewed card is lifted and enlarged, hovered card is lifted. */
  function slotPose(seat: number, i: number, n: number): { p: Pose; sc: number } {
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
    if (reduced() || dur <= 0) { setPose(c, to); c.sc = toSc; applyScale(c); c.mesh.visible = true; request(); return Promise.resolve(); }
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
    if (reduced()) { setFace(c, face); request(); return Promise.resolve(); }
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

  // ---------- deck + turn marker ----------
  const deckBox = new Mesh(track(new BoxGeometry(CARD_W, 0.12, CARD_H)), track(new MeshStandardMaterial({ color: C.cream200, roughness: 0.7 })));
  const deckTop = new Mesh(geoFor(null), cardMat); deckTop.rotation.x = -Math.PI / 2;
  const deckGroup = new Object3D(); deckGroup.add(deckBox, deckTop); deckBox.position.y = 0.06; deckTop.position.y = 0.125;
  scene.add(deckGroup);
  function placeSeats() {
    for (let s = 0; s < 4; s++) (avatars[s] as Avatar).root.rotation.y = (k(s) * Math.PI) / 2;
    const d = deckPose(k(dealer));
    deckGroup.position.set(d.x, 0, d.z); deckGroup.rotation.y = d.ry;
  }
  const turnMark = new Mesh(track(new BoxGeometry(2.2, 0.05, 0.1)), track(new MeshBasicMaterial({ color: C.brass300 })));
  scene.add(turnMark);
  function placeTurn() {
    const kk = k(turn);
    const [x, z] = rot(0, 6.0, kk);
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

  // ---------- camera ----------
  let camYaw = 0, camDrift = 0, camDist = 30, camEl = rad(48);
  function poseCamera() {
    const yaw = camYaw + camDrift;
    const hz = camDist * Math.cos(camEl);
    camera.position.set(Math.sin(yaw) * hz, camDist * Math.sin(camEl), Math.cos(yaw) * hz);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
  }
  function frameCamera() {
    const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
    const landscape = w > h;
    camera.fov = landscape ? 30 : 32;
    camEl = rad(landscape ? 40 : 48);
    const m: HandMode = { phone: !!coarse?.matches, el: camEl };
    if (m.phone !== mode.phone || Math.abs(m.el - mode.el) > 1e-6) { mode = m; if (lastView) { for (let s = 0; s < 4; s++) { const list = hands[s] as CardObj[]; list.forEach((c, i) => { const sp = slotPose(s, i, list.length); setPose(c, sp.p); c.sc = sp.sc; applyScale(c); }); updateArms(s); } } }
    const effH = Math.max(80, h - insetTop - insetBottom);
    const tv = Math.tan(rad(camera.fov / 2)), th = tv * (w / h);
    const Hx = landscape ? 8.2 : 6.3;
    const Hv = landscape ? 7.4 * Math.sin(camEl) + 1.8 : 9.5 * Math.sin(camEl) + 2.2;
    camDist = (Math.max(Hx / th, Hv / (tv * (effH / h))) * 1.04) / zoom;
    camera.aspect = w / h;
    camera.setViewOffset(w, h, 0, (insetBottom - insetTop) / 2, w, h);
    camera.updateProjectionMatrix();
    poseCamera();
  }
  let camZoomTarget = 1;
  function setZoom(z: number, animated = true) {
    const to = Math.min(2, Math.max(0.6, z)); camZoomTarget = to;
    if (!animated || reduced()) { zoom = to; frameCamera(); request(); return; }
    const from = zoom;
    void tweens.add(250, (t) => { zoom = lerp(from, camZoomTarget, t); frameCamera(); }, { ease: easeInOut });
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
    const size = shadowSize();
    if (lamp.shadow.mapSize.x !== size) { lamp.shadow.mapSize.set(size, size); lamp.shadow.map?.dispose(); lamp.shadow.map = null; }
    woodMat.clearcoat = hi ? 0.25 : 0; feltMat.sheen = hi ? 0.6 : 0;
    cafe.tableMat.clearcoat = hi ? 0.25 : 0;
    scene.environmentIntensity = hi ? 0.5 : 0.4;
    cafe.setShadows(hi); for (const a of avatars) a.castShadows(hi);
    marbles.castShadow = true;
    resize();
  }
  function applyQuality(q: Quality, reason: 'auto' | 'user') {
    const changedTex = q !== quality;
    quality = q;
    if (reason === 'user') degrade = 0;
    try { localStorage.setItem(GFX_KEY, q); } catch { /* private mode */ }
    if (changedTex) {
      const sz = q === 'high' ? 1024 : 512;
      const nw = woodMaps(sz), nf = feltMaps(sz);
      const na = buildAtlas(renderer.capabilities.getMaxAnisotropy(), q === 'high' ? 2048 : 1024);
      const ne = buildEnvironment(renderer, q === 'high' ? 256 : 64);
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
      if (t) tableCards[s] = makeCard(t, t.id, tablePose(k(s), 0));
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
      request(); return;
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
      updateArms(dealer, [lerp(rest[0], 3.0, f), lerp(rest[1], 0.9, f), lerp(rest[2], 6.2, f)]);
    }, { ease: linear }));
    request();
    await Promise.all(jobs);
    if (ep === epoch) { dealing = false; refreshOverlays(); }
  }

  async function playMove(m: MoveEvent): Promise<void> {
    const ep = epoch;
    const alive = () => ep === epoch && !disposed;
    const jobs: Promise<void>[] = [];
    if (m.card) {
      const card = m.card;
      const list = hands[m.seat] as CardObj[];
      let idx = list.findIndex((c) => c.id === card.id);
      if (idx < 0) idx = list.length - 1;
      const c = idx >= 0 ? (list.splice(idx, 1)[0] as CardObj) : makeCard(card, card.id, deckPose(k(m.seat)));
      const old = tableCards[m.seat]; if (old) releaseCard(old);
      tableCards[m.seat] = c; c.id = card.id;
      c.outline.visible = false;
      if (peekId === card.id) peekId = null;
      const jitter = rad((Math.random() * 2 - 1) * 6);
      if (c.face?.id !== card.id) jobs.push(flipTo(c, card, 160));
      jobs.push(moveCard(c, tablePose(k(m.seat), jitter), 300, { arc: 0.4, sfxName: 'throw', sc: 1 }));
      relayoutHand(m.seat, 200);
      if (!reduced()) await new Promise<void>((r) => { void tweens.add(180, () => {}, { ease: linear }).then(r); });
    }
    if (!alive()) return;
    if (m.path.length > 1) jobs.push(hopMarble(m.marbleId, m.path, alive));
    else if (m.swapWith === undefined) request();
    if (m.swapWith !== undefined) {
      const a = m.marbleId, b = m.swapWith;
      const pa = mp[a] as MarblePos, pb = mp[b] as MarblePos;
      jobs.push(arcMarble(a, pb, 300, 0.7), arcMarble(b, pa, 300, 0.7));
    }
    await Promise.all(jobs);
    if (!alive()) return;
    if (m.captured?.length) {
      const last = m.path[m.path.length - 1];
      const [bx, bz] = last ? posToXZ(last, viewSeat) : [0, 0];
      sfx('capture');
      jobs.length = 0;
      jobs.push(burst(bx, bz));
      for (const cp of m.captured) jobs.push(arcMarble(cp.marbleId, cp.to, 250, 0.5, 120));
      await Promise.all(jobs);
    }
    if (alive()) refreshOverlays();
  }

  function arcMarble(id: number, to: MarblePos, dur: number, arc: number, delay = 0): Promise<void> {
    const [tx, tz] = posToXZ(to, viewSeat);
    const fx = mx[id] as number, fz = mz[id] as number;
    mp[id] = to;
    if (reduced()) { mx[id] = tx; mz[id] = tz; my[id] = REST_Y; writeMarble(id); request(); return Promise.resolve(); }
    return tweens.add(dur, (t) => {
      mx[id] = lerp(fx, tx, t); mz[id] = lerp(fz, tz, t); my[id] = REST_Y + arc * Math.sin(Math.PI * t); writeMarble(id);
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
    const per = Math.min(60, 400 / n);
    let last = -1;
    await tweens.add(per * n, (t) => {
      const f = Math.min(n - 0.0001, t * n), s = Math.floor(f), l = easeInOut(f - s);
      if (t >= 1) { mx[id] = ex; mz[id] = ez; my[id] = REST_Y; writeMarble(id); return; }
      const a = pts[s] as [number, number], b = pts[s + 1] as [number, number];
      const dist = Math.hypot(b[0] - a[0], b[1] - a[1]);
      mx[id] = lerp(a[0], b[0], l); mz[id] = lerp(a[1], b[1], l);
      my[id] = REST_Y + (0.2 + Math.min(0.7, dist * 0.08)) * Math.sin(Math.PI * l);
      if (s !== last) { last = s; sfx('hop'); }
      writeMarble(id);
    }, { ease: linear });
    if (!alive()) return;
    await tweens.add(80, (t) => { msy[id] = 0.9 + 0.1 * t; writeMarble(id); }, { ease: easeOut });
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
      v3.copy(c.mesh.position).project(camera);
      const d = Math.hypot((v3.x * 0.5 + 0.5) * rect.width - px, (-v3.y * 0.5 + 0.5) * rect.height - py);
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }
  function pick(cx: number, cy: number) {
    const rect = canvas.getBoundingClientRect();
    if (dealing) { tweens.finishAll(); dealing = false; return; }
    if (!interactive) return;
    const px = cx - rect.left, py = cy - rect.top;
    const card = nearestOwnCard(px, py, rect, 34);
    if (card) { peekId = card.id; relayoutHand(viewSeat, 160); ev.onPickCard?.(card.id); return; }
    const near = (x: number, y: number, z: number) => {
      v3.set(x, y, z).project(camera);
      return Math.hypot((v3.x * 0.5 + 0.5) * rect.width - px, (-v3.y * 0.5 + 0.5) * rect.height - py);
    };
    let best = -1, bd = 26; // hit-slop: 26 css px radius (>= 48px target)
    for (let i = 0; i < 16; i++) { const d = near(mx[i] as number, my[i] as number, mz[i] as number); if (d < bd) { bd = d; best = i; } }
    if (best >= 0) { ev.onPickMarble?.(best); return; }
    let bc: MarblePos | null = null; bd = 24;
    for (const c of CELLS) { const [x, z] = posToXZ(c, viewSeat); const d = near(x, BOARD_Y, z); if (d < bd) { bd = d; bc = c; } }
    if (bc) { ev.onPickCell?.(bc); return; }
    if (peekId) { peekId = null; relayoutHand(viewSeat, 160); }
    ev.onPickNothing?.();
  }
  let down: { x: number; y: number; t: number } | null = null;
  const onDown = (e: PointerEvent) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; };
  const onUp = (e: PointerEvent) => {
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 10 && performance.now() - down.t < 600) pick(e.clientX, e.clientY);
    down = null;
  };
  const onMove = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse' || !interactive || spectator || dealing) return;
    const rect = canvas.getBoundingClientRect();
    const c = nearestOwnCard(e.clientX - rect.left, e.clientY - rect.top, rect, 24);
    const id = c?.id ?? null;
    if (id === hoverId) return;
    hoverId = id; canvas.style.cursor = id ? 'pointer' : '';
    relayoutHand(viewSeat, 120);
    ev.onHoverCard?.(id);
  };
  const onLeave = () => { if (hoverId) { hoverId = null; canvas.style.cursor = ''; relayoutHand(viewSeat, 120); ev.onHoverCard?.(null); } };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerleave', onLeave);

  // ---------- lifecycle ----------
  const onLost = (e: Event) => { e.preventDefault(); ev.onStatus?.('context-lost'); };
  const onRestored = () => { for (const t of [atlas, wood.map, wood.bump, feltM.map, feltM.bump, swirl, soft, bokeh]) t.needsUpdate = true; request(); ev.onStatus?.('restored'); };
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => resize()) : null;
  ro?.observe(canvas);
  const onMq = () => request();
  mq?.addEventListener?.('change', onMq);
  const onVis = () => { if (document.visibilityState === 'visible') request(); };
  document.addEventListener('visibilitychange', onVis);

  scene.updateMatrixWorld();
  setView({ mySeat: 0, dealer: 0, turn: 0, hand: [], handCounts: [0, 0, 0, 0], marbles: mp.slice(), table: [null, null, null, null] });
  syncQuality();
  ev.onStatus?.('ready');

  const SEAT_AR = ['المقعد 1', 'المقعد 2', 'المقعد 3', 'المقعد 4'];
  const api: SceneApi = {
    applyView, playDeal, playMove,
    skipAnimations() { tweens.finishAll(); dealing = false; request(); },
    setSelection(s) {
      sel = { cardId: s.cardId ?? null, marbleId: s.marbleId ?? null };
      peekId = sel.cardId;
      refreshOverlays();
    },
    setHints(h) { hints = h; refreshOverlays(); },
    setInsets(i) { insetTop = i.top ?? 0; insetBottom = i.bottom ?? 0; frameCamera(); request(); },
    setViewSeat(seat, animated = true) {
      if (!spectator || !(seat >= 0 && seat <= 3) || seat === viewSeat) return;
      const raw = (((seat - viewSeat) % 4) + 4) % 4;
      const d = raw > 2 ? raw - 4 : raw;
      specSeat = seat;
      tweens.finishAll(); epoch++; dealing = false;
      if (lastView) { setView(lastView); buildHands(lastView, false); refreshOverlays(); }
      if (!animated || reduced() || d === 0) { camYaw = 0; poseCamera(); request(); return; }
      const y0 = (-d * Math.PI) / 2;
      camYaw = y0;
      void tweens.add(380, (t) => { camYaw = y0 * (1 - t); poseCamera(); }, { ease: easeInOut });
    },
    setQuality(q) { if (q === 'high' || q === 'low') applyQuality(q, 'user'); },
    get quality() { return quality; },
    seatAnchor(seat) {
      const a = avatars[seat];
      if (!a) return null;
      a.root.updateMatrixWorld(true);
      v3.copy(a.head).applyMatrix4(a.root.matrixWorld).project(camera);
      const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
      const x = (v3.x * 0.5 + 0.5) * w, y = (-v3.y * 0.5 + 0.5) * h;
      return v3.z > 1 || x < 0 || y < 0 || x > w || y > h ? null : { x, y };
    },
    resetCamera(animated = true) { setZoom(1, animated); },
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
      for (const [n, f] of [['pointerdown', onDown], ['pointerup', onUp], ['pointermove', onMove], ['pointerleave', onLeave]] as const) canvas.removeEventListener(n, f as EventListener);
      canvas.removeEventListener('webglcontextlost', onLost); canvas.removeEventListener('webglcontextrestored', onRestored);
      scene.traverse((o) => {
        const m = o as Mesh;
        const mats = m.material as Material | Material[] | undefined;
        if (mats) (Array.isArray(mats) ? mats : [mats]).forEach((x) => (x as Material & { map?: Texture | null }).map?.dispose());
      });
      for (const t of [wood.map, wood.bump, feltM.map, feltM.bump, atlas, envTex]) t.dispose();
      cafe.dispose();
      for (const d of disposables) d.dispose();
      holes.dispose(); starts.dispose(); marbles.dispose(); mirror.dispose(); blobs.dispose();
      lamp.shadow.map?.dispose();
      renderer.dispose(); renderer.forceContextLoss();
    },
  };
  void BACK_INDEX;
  return api;
}
