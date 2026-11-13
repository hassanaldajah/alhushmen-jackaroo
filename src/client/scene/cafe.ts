// Cafe set dressing: square walnut table, props, backdrop, steam. Original procedural geometry only.
import {
  BackSide, BoxGeometry, BufferGeometry, CircleGeometry, CylinderGeometry, ExtrudeGeometry, Group, InstancedMesh, LatheGeometry,
  Material, Mesh, MeshBasicMaterial, MeshPhysicalMaterial, MeshStandardMaterial, Object3D, PlaneGeometry, RepeatWrapping, Shape,
  SphereGeometry, Sprite, SpriteMaterial, TorusGeometry, Vector2, Texture,
} from 'three';
import { C } from './colors';
import { DALLAH_POS, TABLE_HALF } from './layout';

const lathe = (pts: [number, number][], seg = 40) => new LatheGeometry(pts.map(([x, y]) => new Vector2(x, y)), seg);

export interface Cafe {
  group: Group;
  /** Surfaces that should receive the quality-dependent wood maps. */
  tableMat: MeshPhysicalMaterial;
  floorMat: MeshStandardMaterial;
  highOnly: Object3D[];
  steam: { sprites: Sprite[]; tick(t: number): void };
  setShadows(v: boolean): void;
  dispose(): void;
}

function roundedRect(half: number, r: number): Shape {
  const s = new Shape();
  s.moveTo(-half + r, -half);
  s.lineTo(half - r, -half); s.quadraticCurveTo(half, -half, half, -half + r);
  s.lineTo(half, half - r); s.quadraticCurveTo(half, half, half - r, half);
  s.lineTo(-half + r, half); s.quadraticCurveTo(-half, half, -half, half - r);
  s.lineTo(-half, -half + r); s.quadraticCurveTo(-half, -half, -half + r, -half);
  return s;
}

export function buildCafe(woodMap: Texture, woodBump: Texture, bokeh: Texture, soft: Texture): Cafe {
  const group = new Group();
  const disposables: { dispose(): void }[] = [];
  const D = <T extends { dispose(): void }>(o: T): T => { disposables.push(o); return o; };
  const casters: Mesh[] = [];
  const highOnly: Object3D[] = [];
  const add = (g: BufferGeometry, m: Material, x: number, y: number, z: number, cast = true, parent: Object3D = group) => {
    const me = new Mesh(D(g), m); me.position.set(x, y, z); me.layers.set(1); // layer 1: never picked
    me.layers.enable(0);
    if (cast) { me.castShadow = true; casters.push(me); }
    parent.add(me); return me;
  };

  const tableMat = D(new MeshPhysicalMaterial({ map: woodMap, bumpMap: woodBump, bumpScale: 1.2, roughness: 0.55, clearcoat: 0.25, clearcoatRoughness: 0.4 }));
  const floorMat = D(new MeshStandardMaterial({ color: C.wood800, roughness: 0.9 }));
  const brass = D(new MeshStandardMaterial({ color: C.brass500, metalness: 1, roughness: 0.26 }));
  const ceramic = D(new MeshPhysicalMaterial({ color: 0xf3eee4, roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.05 }));
  const coffee = D(new MeshStandardMaterial({ color: 0x3a2314, roughness: 0.15 }));

  // square table: rounded corners, bevelled edge, four legs, floor
  const topGeo = new ExtrudeGeometry(roundedRect(TABLE_HALF - 0.12, 1.3), { depth: 0.5, bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.12, bevelSegments: 2, curveSegments: 6 });
  topGeo.rotateX(Math.PI / 2); topGeo.translate(0, -0.08, 0);
  const top = add(topGeo, tableMat, 0, 0, 0);
  top.castShadow = false; top.receiveShadow = true;
  for (const [lx, lz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
    add(new BoxGeometry(0.9, 8.9, 0.9), tableMat, lx * (TABLE_HALF - 1.4), -5.05, lz * (TABLE_HALF - 1.4), false);
  }
  const floor = add(new PlaneGeometry(200, 200), floorMat, 0, -9.5, 0, false);
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true;

  // backdrop: out-of-focus cafe all around (the camera can orbit), a cylinder seen from inside
  const bd = new Mesh(D(new CylinderGeometry(80, 80, 120, 32, 1, true)), D(new MeshBasicMaterial({ map: bokeh, fog: false, side: BackSide })));
  bd.position.set(0, 18, 0); bd.layers.set(1); bd.layers.enable(0);
  bokeh.wrapS = RepeatWrapping; bokeh.repeat.set(3, 1);
  group.add(bd);

  // espresso cups (+ saucer, coffee surface, steam)
  const cupAt: [number, number][] = [[5.3, 8.3], [-2.2, -9.0]];
  const cup = (x: number, z: number) => {
    add(lathe([[0, 0], [0.62, 0], [0.7, 0.04], [0.7, 0.07], [0.3, 0.1], [0, 0.1]], 32), ceramic, x, 0.0, z);
    add(lathe([[0.001, 0.08], [0.2, 0.09], [0.28, 0.16], [0.46, 0.68], [0.5, 0.7], [0.46, 0.7], [0.4, 0.66], [0.22, 0.2], [0.001, 0.16]], 32), ceramic, x, 0.0, z);
    const handle = add(new TorusGeometry(0.17, 0.045, 8, 14, Math.PI * 1.2), ceramic, x + 0.5, 0.4, z); handle.rotation.set(0, 0, -0.5);
    const surf = add(new CircleGeometry(0.43, 24), coffee, x, 0.6, z, false); surf.rotation.x = -Math.PI / 2;
  };
  for (const [x, z] of cupAt) cup(x, z);

  // dallah (Arabic coffee pot), scaled up so it reads on phones: lathe body, beak spout, lid finial, handle
  const dallah = new Group(); dallah.position.set(DALLAH_POS[0], 0, DALLAH_POS[1]); dallah.scale.setScalar(1.5); dallah.rotation.y = 0.6;
  group.add(dallah);
  add(lathe([[0, 0], [0.62, 0], [0.82, 0.12], [0.86, 0.55], [0.6, 1.25], [0.34, 1.75], [0.3, 1.95], [0.42, 2.05], [0.36, 2.2], [0.12, 2.32], [0, 2.32]], 36), brass, 0, 0, 0, true, dallah);
  const spout = add(new CylinderGeometry(0.05, 0.15, 1.45, 10), brass, 0.82, 1.25, 0, true, dallah); spout.rotation.z = -0.95;
  add(new CylinderGeometry(0.02, 0.06, 0.28, 8), brass, 1.42, 1.78, 0, true, dallah).rotation.z = -1.4;
  add(lathe([[0, 0], [0.1, 0], [0.13, 0.12], [0.05, 0.32], [0, 0.36]], 14), brass, 0, 2.3, 0, true, dallah);
  const dh = add(new TorusGeometry(0.52, 0.06, 8, 16, Math.PI), brass, -0.62, 1.15, 0, true, dallah); dh.rotation.z = Math.PI / 2 + 0.25;
  add(new CylinderGeometry(0.7, 0.75, 0.04, 28), D(new MeshStandardMaterial({ color: 0x8f6f2a, metalness: 1, roughness: 0.4 })), 0, 0.02, 0, false, dallah); // small tray

  // date bowl with 14 instanced dates (left side)
  const bx = -8.0, bz = -3.6;
  add(lathe([[0, 0], [0.5, 0], [0.9, 0.5], [0.95, 0.55], [0.85, 0.55], [0.45, 0.1], [0, 0.08]], 32), brass, bx, 0, bz);
  const dateM = D(new MeshStandardMaterial({ color: 0x4a2a12, roughness: 0.5 }));
  const dates = new InstancedMesh(D(new SphereGeometry(0.2, 10, 8)), dateM, 14);
  const o = new Object3D();
  for (let i = 0; i < 14; i++) {
    const a = i * 2.4, r = 0.1 + (i % 5) * 0.12, h = 0.35 + (i % 3) * 0.08 + (r < 0.3 ? 0.1 : 0);
    o.position.set(bx + Math.cos(a) * r, h, bz + Math.sin(a) * r); o.scale.set(1, 0.7, 1.3); o.rotation.y = a; o.updateMatrix(); dates.setMatrixAt(i, o.matrix);
  }
  dates.castShadow = true; group.add(dates); disposables.push(dates);

  // tea glass on the right side (clear-coated transparent glass: no transmission pass, which costs a full extra render on phones)
  const glass = D(new MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.04, transparent: true, opacity: 0.3, clearcoat: 1, clearcoatRoughness: 0.03, depthWrite: false }));
  const tg = add(lathe([[0.001, 0.02], [0.3, 0.02], [0.34, 0.9], [0.37, 1.0], [0.34, 1.0], [0.3, 0.9], [0.001, 0.12]], 24), glass, 8.2, 0, 3.6, false);
  tg.castShadow = false;
  const tea = add(new CircleGeometry(0.31, 20), D(new MeshStandardMaterial({ color: 0x9a4a12, roughness: 0.1 })), 8.2, 0.8, 3.6, false); tea.rotation.x = -Math.PI / 2;

  // napkin holder + sugar (high only)
  const nh = new Group();
  const nm = new Mesh(D(new BoxGeometry(0.9, 0.7, 0.3)), brass); nm.position.y = 0.35; nm.castShadow = true;
  const sg = new Mesh(D(new CylinderGeometry(0.3, 0.3, 0.45, 14)), ceramic); sg.position.set(0.8, 0.22, 0.1); sg.castShadow = true;
  nh.add(nm, sg); nh.position.set(8.0, 0, -4.2); nh.rotation.y = Math.PI / 2; nh.traverse((x) => x.layers.set(1)); nh.traverse((x) => x.layers.enable(0));
  group.add(nh); highOnly.push(nh);

  // steam: two soft sprites per cup
  const sprites: Sprite[] = [];
  for (const [cx, cz] of cupAt) for (let i = 0; i < 2; i++) {
    const s = new Sprite(D(new SpriteMaterial({ map: soft, transparent: true, opacity: 0, depthWrite: false, color: 0xfff1dc })));
    s.userData = { x: cx, z: cz, ph: i * 0.5 }; s.layers.set(1); s.layers.enable(0);
    group.add(s); sprites.push(s); highOnly.push(s);
  }
  const steam = {
    sprites,
    tick(t: number) {
      for (const s of sprites) {
        const u = d3(s, t);
        s.position.set(s.userData.x as number + Math.sin(u * 6) * 0.1, 0.8 + u * 1.8, s.userData.z as number);
        s.scale.setScalar(0.5 + u * 0.9);
        (s.material as SpriteMaterial).opacity = 0.35 * Math.sin(Math.PI * u);
      }
    },
  };
  function d3(s: Sprite, t: number) { return ((t / 3 + (s.userData.ph as number)) % 1 + 1) % 1; }

  return {
    group, tableMat, floorMat, highOnly, steam,
    setShadows(v) { for (const m of casters) m.castShadow = v; dates.castShadow = v; },
    dispose() { for (const d of disposables) d.dispose(); },
  };
}
