// Café set dressing: round walnut table, props, backdrop, steam. Original procedural geometry only.
import {
  BoxGeometry, BufferGeometry, CircleGeometry, Color, CylinderGeometry, Group, InstancedMesh, LatheGeometry, Material, Mesh,
  MeshBasicMaterial, MeshPhysicalMaterial, MeshStandardMaterial, Object3D, PlaneGeometry, SphereGeometry, Sprite, SpriteMaterial,
  TorusGeometry, Vector2, Texture,
} from 'three';
import { C } from './colors';
import { TABLE_R } from './layout';

const lathe = (pts: [number, number][], seg = 40) => new LatheGeometry(pts.map(([x, y]) => new Vector2(x, y)), seg);

export interface Cafe {
  group: Group;
  /** Surfaces that should receive the quality-dependent wood / felt-free materials. */
  tableMat: MeshPhysicalMaterial;
  floorMat: MeshStandardMaterial;
  highOnly: Object3D[];
  steam: { sprites: Sprite[]; tick(t: number): void };
  setShadows(v: boolean): void;
  dispose(): void;
}

export function buildCafe(woodMap: Texture, woodBump: Texture, bokeh: Texture, soft: Texture): Cafe {
  const group = new Group();
  const disposables: { dispose(): void }[] = [];
  const D = <T extends { dispose(): void }>(o: T): T => { disposables.push(o); return o; };
  const casters: Mesh[] = [];
  const highOnly: Object3D[] = [];
  const add = (g: BufferGeometry, m: Material, x: number, y: number, z: number, cast = true) => {
    const me = new Mesh(D(g), m); me.position.set(x, y, z); me.layers.set(1); // layer 1: never picked
    me.layers.enable(0);
    if (cast) { me.castShadow = true; casters.push(me); }
    group.add(me); return me;
  };

  const tableMat = D(new MeshPhysicalMaterial({ map: woodMap, bumpMap: woodBump, bumpScale: 1.2, roughness: 0.55, clearcoat: 0.25, clearcoatRoughness: 0.4 }));
  const floorMat = D(new MeshStandardMaterial({ color: C.wood800, roughness: 0.9 }));
  const brass = D(new MeshStandardMaterial({ color: C.brass500, metalness: 1, roughness: 0.28 }));
  const ceramic = D(new MeshPhysicalMaterial({ color: 0xf3eee4, roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.05 }));
  const coffee = D(new MeshStandardMaterial({ color: 0x3a2314, roughness: 0.15 }));

  // table: bevelled top (lathe profile), pedestal, floor
  const top = add(lathe([[0, 0], [TABLE_R - 0.12, 0], [TABLE_R, -0.12], [TABLE_R, -0.5], [TABLE_R - 0.15, -0.62], [0, -0.62]], 72), tableMat, 0, 0, 0);
  top.castShadow = false; top.receiveShadow = true;
  add(new CylinderGeometry(0.9, 1.1, 8.5, 16), tableMat, 0, -4.9, 0, false);
  add(new CylinderGeometry(3.2, 3.6, 0.5, 24), tableMat, 0, -9.25, 0, false);
  const floor = add(new PlaneGeometry(160, 160), floorMat, 0, -9.5, 0, false);
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true;

  // backdrop: out-of-focus café behind the far side (camera always looks toward -z)
  const bd = new Mesh(D(new PlaneGeometry(240, 120)), D(new MeshBasicMaterial({ map: bokeh, fog: false })));
  bd.position.set(0, 20, -70); bd.layers.set(1); bd.layers.enable(0);
  group.add(bd);

  // espresso cups x2 (+ saucer, coffee surface, steam)
  const cup = (x: number, z: number) => {
    add(lathe([[0, 0], [0.62, 0], [0.7, 0.04], [0.7, 0.07], [0.3, 0.1], [0, 0.1]], 40), ceramic, x, 0.0, z);
    add(lathe([[0.001, 0.08], [0.2, 0.09], [0.28, 0.16], [0.46, 0.68], [0.5, 0.7], [0.46, 0.7], [0.4, 0.66], [0.22, 0.2], [0.001, 0.16]], 40), ceramic, x, 0.0, z);
    const handle = add(new TorusGeometry(0.17, 0.045, 8, 14, Math.PI * 1.2), ceramic, x + 0.5, 0.4, z); handle.rotation.set(0, 0, -0.5);
    const surf = add(new CircleGeometry(0.43, 24), coffee, x, 0.6, z, false); surf.rotation.x = -Math.PI / 2;
  };
  cup(7.2, 7.4); cup(-7.2, -7.4);

  // dallah (Arabic coffee pot): lathe body, spout, lid knob
  const dx = -7.6, dz = 7.4;
  add(lathe([[0, 0], [0.55, 0], [0.8, 0.5], [0.55, 1.5], [0.28, 2.0], [0.34, 2.15], [0.34, 2.3], [0, 2.3]], 32), brass, dx, 0, dz);
  const spout = add(new CylinderGeometry(0.05, 0.14, 1.5, 10), brass, dx + 0.85, 1.3, dz); spout.rotation.z = -0.9;
  add(new SphereGeometry(0.12, 10, 8), brass, dx, 2.42, dz);
  const dh = add(new TorusGeometry(0.5, 0.06, 8, 14, Math.PI), brass, dx - 0.55, 1.2, dz); dh.rotation.z = Math.PI / 2 + 0.2;

  // date bowl with 14 instanced dates
  const bx = 7.6, bz = -7.4;
  add(lathe([[0, 0], [0.5, 0], [0.9, 0.5], [0.95, 0.55], [0.85, 0.55], [0.45, 0.1], [0, 0.08]], 36), brass, bx, 0, bz);
  const dateM = D(new MeshStandardMaterial({ color: 0x4a2a12, roughness: 0.5 }));
  const dates = new InstancedMesh(D(new SphereGeometry(0.2, 10, 8)), dateM, 14);
  const o = new Object3D();
  for (let i = 0; i < 14; i++) {
    const a = i * 2.4, r = 0.1 + (i % 5) * 0.12, h = 0.35 + (i % 3) * 0.08 + (r < 0.3 ? 0.1 : 0);
    o.position.set(bx + Math.cos(a) * r, h, bz + Math.sin(a) * r); o.scale.set(1, 0.7, 1.3); o.rotation.y = a; o.updateMatrix(); dates.setMatrixAt(i, o.matrix);
  }
  dates.castShadow = true; group.add(dates); disposables.push(dates);

  // tea glass (transmission) next to the cup
  const glass = D(new MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.03, transmission: 0.9, thickness: 0.2, ior: 1.45, transparent: true }));
  const tg = add(lathe([[0.001, 0.02], [0.3, 0.02], [0.34, 0.9], [0.37, 1.0], [0.34, 1.0], [0.3, 0.9], [0.001, 0.12]], 24), glass, 6.2, 0, 8.6, false);
  tg.castShadow = false;
  const tea = add(new CircleGeometry(0.31, 20), D(new MeshStandardMaterial({ color: 0x9a4a12, roughness: 0.1 })), 6.2, 0.8, 8.6, false); tea.rotation.x = -Math.PI / 2;

  // napkin holder + sugar (high only)
  const nh = new Group();
  const nm = new Mesh(D(new BoxGeometry(0.9, 0.7, 0.3)), brass); nm.position.y = 0.35; nm.castShadow = true;
  const sg = new Mesh(D(new CylinderGeometry(0.3, 0.3, 0.45, 14)), ceramic); sg.position.set(0.8, 0.22, 0.1); sg.castShadow = true;
  nh.add(nm, sg); nh.position.set(-6.2, 0, -8.6); nh.traverse((x) => x.layers.set(1)); nh.traverse((x) => x.layers.enable(0));
  group.add(nh); highOnly.push(nh);

  // steam: two soft sprites per cup
  const sprites: Sprite[] = [];
  for (const [cx, cz] of [[7.2, 7.4], [-7.2, -7.4]] as const) for (let i = 0; i < 2; i++) {
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

  void Color;
  return {
    group, tableMat, floorMat, highOnly, steam,
    setShadows(v) { for (const m of casters) m.castShadow = v; dates.castShadow = v; },
    dispose() { for (const d of disposables) d.dispose(); },
  };
}
