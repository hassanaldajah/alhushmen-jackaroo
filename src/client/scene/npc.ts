// "أيمن": a friendly, stylised pirate who stands behind the table and reads the jokes.
// Same low-poly language as avatar.ts (primitives only, a handful of meshes, one tiny canvas texture).
import {
  BoxGeometry, CanvasTexture, Color, ConeGeometry, CylinderGeometry, DoubleSide, Group, Material, Mesh, MeshBasicMaterial,
  MeshStandardMaterial, PlaneGeometry, SphereGeometry, SRGBColorSpace, TorusGeometry, Vector3,
} from 'three';

export const NPC_NAME = 'أيمن';
export const NPC_BADGE_LINE = 'معدل التراكم 2.7';

export interface Npc {
  root: Group;
  /** Local head-top point (for the joke bubble anchor). */
  readonly head: Vector3;
  /** Local centre of the chest badge. */
  readonly badge: Vector3;
  /** Idle motion; t in seconds. Returns true while something visibly moved. */
  tick(t: number): boolean;
  /** Paper-out pose amount 0..1 (0 = idle, 1 = paper held up to read). */
  setRead(f: number): void;
  setDetail(high: boolean): void;
  castShadows(v: boolean): void;
  dispose(): void;
}

function badgeTexture(): CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 128;
  const t = new CanvasTexture(cv);
  t.colorSpace = SRGBColorSpace;
  const draw = () => {
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, 256, 128);
    const r = 22;
    ctx.beginPath(); ctx.moveTo(r, 4); ctx.arcTo(252, 4, 252, 124, r); ctx.arcTo(252, 124, 4, 124, r); ctx.arcTo(4, 124, 4, 4, r); ctx.arcTo(4, 4, 252, 4, r); ctx.closePath();
    ctx.fillStyle = '#FAF3E3'; ctx.fill();
    ctx.lineWidth = 8; ctx.strokeStyle = '#C9A24B'; ctx.stroke();
    ctx.fillStyle = '#1A1410'; ctx.textAlign = 'center'; ctx.direction = 'rtl';
    ctx.font = '600 50px "Reem Kufi", "Cairo", Tahoma, sans-serif';
    ctx.fillText(NPC_NAME, 128, 62);
    ctx.font = '600 25px "Reem Kufi", "Cairo", Tahoma, sans-serif';
    ctx.fillStyle = '#6B4A2B';
    ctx.fillText(NPC_BADGE_LINE, 128, 104);
    t.needsUpdate = true;
  };
  draw();
  // Redraw once the logo font is ready (it is preloaded; this only matters on a cold cache).
  try { void document.fonts?.load('600 40px "Reem Kufi"').then(draw, () => {}); } catch { /* no font API */ }
  return t;
}

export function createNpc(): Npc {
  const root = new Group();
  const body = new Group(); root.add(body);
  const geos: { dispose(): void }[] = [];
  const mats: Material[] = [];
  const G = <T extends { dispose(): void }>(g: T): T => { geos.push(g); return g; };
  const M = (color: number, rough = 0.75, metal = 0) => { const m = new MeshStandardMaterial({ color, roughness: rough, metalness: metal }); mats.push(m); return m; };
  const meshes: Mesh[] = [];
  const mk = (g: { dispose(): void }, m: Material, x: number, y: number, z: number, parent: Group = body) => {
    const me = new Mesh(G(g) as never, m); me.position.set(x, y, z); parent.add(me); meshes.push(me); return me;
  };

  const coat = M(0x7a2a1c, 0.8), shirt = M(0xf3eee4, 0.85), skin = M(0xe8b88f, 0.8), dark = M(0x1a1410, 0.5);
  const blond = M(0xe6c25e, 0.7), hatM = M(0x2b1d12, 0.85), gold = M(0xc9a24b, 0.3, 1), boot = M(0x2a1a12, 0.6);

  // legs (mostly hidden by the table) + boots
  mk(new CylinderGeometry(0.42, 0.38, 7.2, 10), dark, -0.5, -5.6, 0);
  mk(new CylinderGeometry(0.42, 0.38, 7.2, 10), dark, 0.5, -5.6, 0);
  mk(new BoxGeometry(0.7, 0.6, 1.1), boot, -0.5, -9.2, 0.2);
  mk(new BoxGeometry(0.7, 0.6, 1.1), boot, 0.5, -9.2, 0.2);
  // coat (long), shirt front, belt with buckle
  mk(new CylinderGeometry(0.95, 1.15, 4.4, 16), coat, 0, -0.1, 0);
  mk(new BoxGeometry(0.7, 3.2, 0.2), shirt, 0, 0.3, 0.92);
  mk(new CylinderGeometry(1.08, 1.08, 0.32, 16), dark, 0, -0.9, 0);
  mk(new BoxGeometry(0.42, 0.34, 0.12), gold, 0, -0.9, 1.08);
  mk(new SphereGeometry(1.0, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), coat, 0, 2.1, 0).scale.set(1, 0.45, 0.85);
  // badge (canvas plate) on the chest, readable from the table
  const badgeTex = badgeTexture();
  const badgeMat = new MeshBasicMaterial({ map: badgeTex, transparent: true, side: DoubleSide }); mats.push(badgeMat);
  const badge = mk(new PlaneGeometry(1.3, 0.65), badgeMat, -0.42, 1.25, 1.06);
  badge.rotation.set(-0.12, 0.08, 0);

  // head
  const headG = new Group(); headG.position.set(0, 3.05, 0); body.add(headG);
  mk(new CylinderGeometry(0.3, 0.34, 0.4, 10), skin, 0, -0.75, 0, headG);
  mk(new SphereGeometry(0.88, 20, 14), skin, 0, 0, 0, headG);
  mk(new SphereGeometry(0.12, 8, 6), skin, 0, -0.05, 0.86, headG); // nose
  mk(new SphereGeometry(0.1, 8, 6), dark, 0.3, 0.14, 0.78, headG); // open eye
  const patch = mk(new CylinderGeometry(0.22, 0.22, 0.06, 14), dark, -0.3, 0.14, 0.8, headG); patch.rotation.x = Math.PI / 2;
  const strap = mk(new TorusGeometry(0.9, 0.03, 4, 28), dark, 0, 0.2, 0, headG); strap.rotation.set(Math.PI / 2 - 0.35, 0, 0.28);
  const smile = mk(new TorusGeometry(0.22, 0.035, 6, 12, Math.PI), dark, 0, -0.3, 0.8, headG); smile.rotation.z = Math.PI;
  // blond hair under the hat + blond beard tuft
  mk(new SphereGeometry(0.93, 18, 10, 0, Math.PI * 2, Math.PI * 0.34, Math.PI * 0.38), blond, 0, 0.05, -0.06, headG);
  const beard = mk(new ConeGeometry(0.34, 0.75, 10), blond, 0, -0.82, 0.55, headG); beard.rotation.x = Math.PI + 0.35;
  mk(new TorusGeometry(0.2, 0.06, 6, 12, Math.PI), blond, 0, -0.42, 0.78, headG).rotation.z = Math.PI; // moustache
  // tricorn: a three-sided brim (triangular cylinder), crown and gold trim
  const brim = mk(new CylinderGeometry(1.45, 1.45, 0.14, 3), hatM, 0, 0.72, 0.05, headG); brim.rotation.y = Math.PI / 6 + Math.PI; // a point faces forward
  mk(new CylinderGeometry(0.66, 0.82, 0.62, 14), hatM, 0, 1.08, 0, headG);
  const trim = mk(new CylinderGeometry(1.5, 1.5, 0.05, 3, 1, true), gold, 0, 0.8, 0.05, headG); trim.rotation.y = Math.PI / 6 + Math.PI;

  // arms: simple two-segment arms driven by setRead (right hand goes to the pocket, then holds the paper up)
  const armL = new Group(), armR = new Group();
  armL.position.set(-1.05, 1.75, 0); armR.position.set(1.05, 1.75, 0); body.add(armL, armR);
  const upperL = mk(new CylinderGeometry(0.3, 0.27, 2.0, 8), coat, 0, -1.0, 0, armL);
  const handL = mk(new SphereGeometry(0.3, 10, 8), skin, 0, -2.15, 0, armL);
  const upperR = mk(new CylinderGeometry(0.3, 0.27, 2.0, 8), coat, 0, -1.0, 0, armR);
  const handR = mk(new SphereGeometry(0.3, 10, 8), skin, 0, -2.15, 0, armR);
  void upperL; void upperR; void handL;
  armL.rotation.z = -0.18; armR.rotation.z = 0.18;
  // folded paper (in the right hand; hidden until he reads)
  const paperM = M(0xfaf3e3, 0.9);
  const paper = mk(new BoxGeometry(0.75, 0.95, 0.03), paperM, 0, -2.3, 0.35, armR);
  paper.visible = false;

  // parrot on the left shoulder (red + gold, no green), high quality only
  const parrot = new Group(); parrot.position.set(-1.0, 2.35, 0.1); body.add(parrot);
  const red = M(0xc0392b, 0.6);
  mk(new SphereGeometry(0.28, 10, 8), red, 0, 0.25, 0, parrot).scale.set(0.9, 1.25, 0.9);
  mk(new SphereGeometry(0.2, 10, 8), red, 0, 0.66, 0.06, parrot);
  const beak = mk(new ConeGeometry(0.07, 0.2, 6), gold, 0, 0.62, 0.27, parrot); beak.rotation.x = Math.PI / 2 + 0.4;
  mk(new BoxGeometry(0.08, 0.36, 0.3), M(0xd9a441, 0.6), -0.26, 0.24, -0.02, parrot).rotation.z = 0.25;
  mk(new BoxGeometry(0.08, 0.36, 0.3), M(0xd9a441, 0.6), 0.26, 0.24, -0.02, parrot).rotation.z = -0.25;
  mk(new SphereGeometry(0.04, 6, 4), dark, 0.09, 0.72, 0.18, parrot);
  mk(new SphereGeometry(0.04, 6, 4), dark, -0.09, 0.72, 0.18, parrot);

  let read = 0;
  const applyArms = () => {
    // 0..0.45: hand moves to the coat pocket; 0.45..1: paper comes up in front of the chest.
    const a = Math.min(1, read / 0.45), b = Math.max(0, (read - 0.45) / 0.55);
    armR.rotation.z = 0.18 - 0.1 * a + 0.05 * b;
    armR.rotation.x = -0.15 * a - 1.25 * b;
    paper.visible = read > 0.42;
    paper.scale.set(0.35 + 0.65 * b, 1, 1);
    handR.position.y = -2.15;
  };
  applyArms();

  return {
    root,
    head: new Vector3(0, 3.05 + 1.5, 0),
    badge: new Vector3(-0.42, 1.25, 1.06),
    tick(t) {
      body.scale.y = 1 + Math.sin(t * 1.6) * 0.012;
      headG.rotation.y = Math.sin(t * 0.35) * 0.32 + (read > 0.45 ? -0.15 : 0);
      headG.rotation.x = read > 0.45 ? 0.18 : Math.sin(t * 0.5) * 0.03;
      parrot.position.y = 2.35 + Math.abs(Math.sin(t * 2.2)) * 0.05;
      parrot.rotation.y = Math.sin(t * 0.9) * 0.5;
      return true;
    },
    setRead(f) { read = Math.max(0, Math.min(1, f)); applyArms(); },
    setDetail(high) { parrot.visible = high; },
    castShadows(v) { for (const m of meshes) m.castShadow = v; },
    dispose() { badgeTex.dispose(); for (const g of geos) g.dispose(); for (const m of mats) m.dispose(); void Color; },
  };
}
