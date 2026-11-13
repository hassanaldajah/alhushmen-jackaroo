// Original procedural stylized avatars (chibi table companions). No external models, no existing characters.
import {
  BoxGeometry, Color, CylinderGeometry, Group, Material, Mesh, MeshStandardMaterial, Quaternion, SphereGeometry, TorusGeometry, Vector3,
} from 'three';
import { SEAT_COLORS } from './colors';
import { SEAT_D } from './layout';

const SKIN = [0xe3b48a, 0xc68a5e, 0xf0c8a0, 0x9a6a46];
const HEAD = [0xf2eadb, 0x7a1f1c, 0x2a1a12, 0x1f6b57]; // cap / fez / hair / headscarf
const UP = new Vector3(0, 1, 0);
const L1 = 2.5, L2 = 2.5; // bone lengths (arms are long on purpose: the table is wide)
const SHOULDER_Y = 1.5, SHOULDER_X = 1.05;

export interface Avatar {
  /** Seat-local root: origin at table centre, seated at +z, faces -z. Rotate Y by k*PI/2 to place at screen position k. */
  root: Group;
  /** Arm targets in the seat-local frame of layout.ts (seat at +z). */
  setHands(l: [number, number, number], r: [number, number, number]): void;
  /** Head world-ish local position (seat frame) for anchoring UI such as speech bubbles. */
  readonly head: Vector3;
  castShadows(v: boolean): void;
  dispose(): void;
}

export function createAvatar(seat: number): Avatar {
  const root = new Group();
  const av = new Group(); av.position.set(0, 0, SEAT_D); root.add(av);
  const geos: { dispose(): void }[] = [];
  const mats: Material[] = [];
  const G = <T extends { dispose(): void }>(g: T): T => { geos.push(g); return g; };
  const M = (color: number, rough = 0.75) => { const m = new MeshStandardMaterial({ color, roughness: rough }); mats.push(m); return m; };

  const shirt = M(new Color(SEAT_COLORS[seat] ?? 0xffffff).multiplyScalar(0.8).getHex());
  const skin = M(SKIN[seat % 4] as number, 0.8);
  const headM = M(HEAD[seat % 4] as number, 0.85);
  const dark = M(0x1a1410, 0.5);
  const chairM = M(0x2b1d12, 0.7);
  const trim = new MeshStandardMaterial({ color: 0xc9a24b, metalness: 1, roughness: 0.3 }); mats.push(trim);

  const meshes: Mesh[] = [];
  const mk = (g: { dispose(): void }, m: Material, x: number, y: number, z: number, parent: Group = av) => {
    const me = new Mesh(G(g) as never, m); me.position.set(x, y, z); parent.add(me); meshes.push(me); return me;
  };

  // chair + torso + neck + head
  mk(new CylinderGeometry(1.5, 1.5, 0.35, 20), chairM, 0, -3.5, 0.2);
  mk(new BoxGeometry(2.9, 3.2, 0.3), chairM, 0, -1.9, 1.6);
  mk(new CylinderGeometry(1.0, 0.85, 4.6, 16), shirt, 0, -0.8, 0);
  mk(new SphereGeometry(1.0, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), shirt, 0, 1.5, 0).scale.set(1, 0.5, 0.8);
  mk(new CylinderGeometry(0.28, 0.32, 0.4, 10), skin, 0, 1.9, 0);
  const head = mk(new SphereGeometry(0.86, 20, 14), skin, 0, 2.85, 0);
  // face on the -z side
  mk(new SphereGeometry(0.095, 8, 6), dark, -0.3, 2.95, -0.8);
  mk(new SphereGeometry(0.095, 8, 6), dark, 0.3, 2.95, -0.8);
  mk(new BoxGeometry(0.34, 0.06, 0.06), dark, -0.3, 3.18, -0.78).rotation.z = 0.12;
  mk(new BoxGeometry(0.34, 0.06, 0.06), dark, 0.3, 3.18, -0.78).rotation.z = -0.12;
  const smile = mk(new TorusGeometry(0.2, 0.035, 6, 12, Math.PI), dark, 0, 2.62, -0.8); smile.rotation.z = Math.PI;
  // headwear variants (original silhouettes)
  switch (seat % 4) {
    case 0: // soft cap with brass band
      mk(new SphereGeometry(0.92, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2.3), headM, 0, 2.95, 0.04);
      mk(new TorusGeometry(0.89, 0.05, 6, 24), trim, 0, 3.0, 0).rotation.x = Math.PI / 2;
      break;
    case 1: // fez
      mk(new CylinderGeometry(0.56, 0.7, 0.8, 16), headM, 0, 3.65, 0.02);
      mk(new BoxGeometry(0.08, 0.35, 0.08), trim, 0.5, 3.45, 0.1);
      break;
    case 2: // hair with bun
      mk(new SphereGeometry(0.93, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2.1), headM, 0, 2.93, 0.12);
      mk(new SphereGeometry(0.32, 10, 8), headM, 0, 3.75, 0.25);
      break;
    default: // headscarf: back and top, face stays open
      mk(new SphereGeometry(0.95, 18, 12, Math.PI * 0.25, Math.PI * 1.5, 0, Math.PI * 0.72), headM, 0, 2.85, 0.05);
      mk(new CylinderGeometry(0.9, 1.1, 0.5, 14), headM, 0, 1.75, 0.1);
      break;
  }

  // arms: shoulder -> elbow -> hand, solved by 2-bone IK
  const arms = [-1, 1].map((side) => {
    const upper = mk(new CylinderGeometry(0.3, 0.26, 1, 8), shirt, 0, 0, 0, root);
    const fore = mk(new CylinderGeometry(0.26, 0.22, 1, 8), skin, 0, 0, 0, root);
    const hand = mk(new SphereGeometry(0.32, 10, 8), skin, 0, 0, 0, root);
    const shoulder = mk(new SphereGeometry(0.42, 10, 8), shirt, side * SHOULDER_X, SHOULDER_Y, SEAT_D, root);
    return { side, upper, fore, hand, shoulder };
  });

  const a = new Vector3(), b = new Vector3(), d = new Vector3(), mid = new Vector3(), pole = new Vector3(), q = new Quaternion();
  const bone = (m: Mesh, from: Vector3, to: Vector3) => {
    d.subVectors(to, from); const len = Math.max(0.001, d.length());
    m.position.copy(from).addScaledVector(d, 0.5);
    m.quaternion.copy(q.setFromUnitVectors(UP, d.multiplyScalar(1 / len)));
    m.scale.set(1, len, 1);
  };
  const solve = (side: number, target: [number, number, number], arm: (typeof arms)[number]) => {
    a.set(side * SHOULDER_X, SHOULDER_Y, SEAT_D);
    b.set(target[0], target[1], target[2]);
    d.subVectors(b, a);
    let dist = d.length();
    const max = (L1 + L2) * 0.995;
    if (dist > max) { b.copy(a).addScaledVector(d, max / dist); d.subVectors(b, a); dist = max; }
    d.multiplyScalar(1 / Math.max(0.001, dist));
    const h = Math.sqrt(Math.max(0, L1 * L1 - (dist / 2) * (dist / 2)));
    mid.copy(a).addScaledVector(d, dist / 2);
    pole.set(side * 0.5, -1, 0.3);
    pole.addScaledVector(d, -pole.dot(d)).normalize();
    const elbow = mid.addScaledVector(pole, h).clone();
    bone(arm.upper, a, elbow); bone(arm.fore, elbow, b);
    arm.hand.position.copy(b);
  };

  return {
    root,
    head: new Vector3(0, head.position.y + 0.9, SEAT_D),
    setHands(l, r) { solve(-1, l, arms[0] as (typeof arms)[number]); solve(1, r, arms[1] as (typeof arms)[number]); },
    castShadows(v) { for (const m of meshes) m.castShadow = v; },
    dispose() { for (const g of geos) g.dispose(); for (const m of mats) m.dispose(); },
  };
}
