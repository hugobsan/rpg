// Diorama 3D do mapa (three), carregado sob demanda pelo MapPanel: mesa low-poly com os locais
// como miniaturas por tipo, rotas pontilhadas, o jogador e quem está com ele como peões.
// Renderiza só quando algo se mexe (câmera, hover, transição). Cores vêm dos tokens do tema.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Period } from "@/lib/clock";
import type { MapPlace, StageStance, WorldMap } from "@/lib/types";

export interface DioramaToken {
  name: string;
  stance?: StageStance;
}
export interface DioramaData {
  map: WorldMap;
  tokens: DioramaToken[]; // NPCs e figurantes junto do jogador
  player: string;
  period?: Period;
}
export interface DioramaHandle {
  update(data: DioramaData): void;
  select(id: string | null): void;
  focus(id?: string | null): void;
  dispose(): void;
}

const S = 1.4; // unidade do mapa → mundo
const hash = (s: string) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7);
const rng = (seed: number) => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
// relevo baixo e determinístico; achata perto dos locais para as miniaturas ficarem no chão
const noise = (x: number, z: number) =>
  Math.sin(x * 0.9 + 1.3) * Math.cos(z * 0.7 - 0.4) * 0.5 + Math.sin(x * 2.1 + z * 1.7) * 0.22 + Math.cos(x * 0.35 - z * 0.5) * 0.4;

/** Cores do tema: lê o token CSS e resolve qualquer sintaxe (hex, rgb, color-mix) por um pixel de canvas. */
export function palette(el: HTMLElement) {
  const cs = getComputedStyle(el);
  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
  const read = (name: string, fallback: string) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = fallback;
    ctx.fillStyle = cs.getPropertyValue(name).trim() || fallback;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
  };
  const p = {
    bg: read("--bg-sunken", "#09090d"),
    raise: read("--bg-raise", "#15151d"),
    panel: read("--bg-panel", "#1a1a24"),
    text: read("--text", "#e8e4da"),
    dim: read("--text-dim", "#9a95a8"),
    faint: read("--text-faint", "#6a6577"),
    accent: read("--accent", "#d4a24e"),
    accent2: read("--accent-2", "#d4a24e"),
    danger: read("--danger", "#e0524d"),
    ok: read("--ok", "#4de08a"),
    info: read("--info", "#60a5fa"),
    warn: read("--warn", "#fbbf24"),
    green: read("--mode-downtime", "#66bb6a"),
  };
  const mix = (a: THREE.Color, b: THREE.Color, t: number) => a.clone().lerp(b, t);
  return {
    ...p,
    ground: mix(mix(p.panel, p.dim, 0.1), p.green, 0.05),
    side: mix(p.raise, p.bg, 0.4),
    wall: mix(p.panel, p.text, 0.62),
    wallDark: mix(p.panel, p.dim, 0.45),
    rock: mix(p.panel, p.dim, 0.62),
    leaf: mix(p.green, p.panel, 0.3),
    trunk: mix(p.warn, p.panel, 0.62),
    hole: mix(p.bg, p.panel, 0.2),
  };
}
type Palette = ReturnType<typeof palette>;

export function createDiorama(
  host: HTMLElement,
  data: DioramaData,
  opts: { full: boolean; onSelect: (id: string | null) => void }
): DioramaHandle {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(host.clientWidth, host.clientHeight);
  renderer.shadowMap.enabled = true;
  const el = renderer.domElement;
  el.style.cssText = "display:block;width:100%;height:100%;touch-action:none";
  host.appendChild(el);
  const layer = document.createElement("div");
  layer.className = "map3d-labels";
  host.appendChild(layer);

  const P: Palette = palette(host);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, host.clientWidth / Math.max(1, host.clientHeight), 0.1, 300);
  const hemi = new THREE.HemisphereLight(0xffffff, 0x000000, 1);
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.bias = -0.0005;
  scene.add(hemi, sun, sun.target);

  const controls = new OrbitControls(camera, el);
  controls.enableDamping = true;
  controls.dampingFactor = 0.09;
  controls.maxPolarAngle = 1.2;
  controls.minDistance = 3;
  controls.maxDistance = 100;
  controls.screenSpacePanning = false;
  // na lateral a roda rola a página; zoom fica na tela cheia
  controls.enableZoom = opts.full;

  // ---------- peças (geometrias unitárias com a base em y=0, reaproveitadas por escala) ----------
  const unit = {
    box: new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0),
    roof: new THREE.ConeGeometry(Math.SQRT1_2, 1, 4).rotateY(Math.PI / 4).translate(0, 0.5, 0),
    cone6: new THREE.ConeGeometry(0.5, 1, 6).translate(0, 0.5, 0),
    cone8: new THREE.ConeGeometry(0.5, 1, 8).translate(0, 0.5, 0),
    cyl6: new THREE.CylinderGeometry(0.5, 0.5, 1, 6).translate(0, 0.5, 0),
    cyl8: new THREE.CylinderGeometry(0.5, 0.5, 1, 8).translate(0, 0.5, 0),
    disc: new THREE.CylinderGeometry(0.5, 0.5, 1, 28).translate(0, 0.5, 0),
    ball: new THREE.SphereGeometry(0.5, 12, 8).translate(0, 0.5, 0),
    dome: new THREE.SphereGeometry(0.5, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2),
    torus: new THREE.TorusGeometry(0.42, 0.07, 8, 28),
    ring: new THREE.RingGeometry(0.86, 1, 48).rotateX(-Math.PI / 2),
  };
  const shared = new Set<THREE.BufferGeometry>(Object.values(unit));
  const mats = new Map<string, THREE.Material>();
  const mat = (c: THREE.Color, o: { ghost?: boolean; glow?: number; opacity?: number; basic?: boolean } = {}) => {
    const key = `${c.getHexString()}|${o.ghost ? 1 : 0}|${o.glow ?? 0}|${o.opacity ?? 1}|${o.basic ? 1 : 0}`;
    let m = mats.get(key);
    if (!m) {
      const opacity = (o.opacity ?? 1) * (o.ghost ? 0.38 : 1);
      m = o.basic
        ? new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity, depthWrite: false })
        : new THREE.MeshStandardMaterial({
            color: c,
            flatShading: true,
            roughness: 0.82,
            metalness: 0.05,
            emissive: c,
            emissiveIntensity: o.glow ?? 0,
            transparent: opacity < 1,
            opacity,
          });
      mats.set(key, m);
    }
    return m;
  };

  /** Miniatura por tipo, dentro de ~1 unidade de mundo. */
  function marker(p: MapPlace, ghost: boolean): THREE.Group {
    const g = new THREE.Group();
    const r = rng(hash(p.id + p.name));
    const add = (geo: keyof typeof unit, c: THREE.Color, w: number, h: number, d: number, x = 0, y = 0, z = 0, ry = 0, glow = 0) => {
      const m = new THREE.Mesh(unit[geo], mat(c, { ghost, glow }));
      m.scale.set(w, h, d);
      m.position.set(x, y, z);
      m.rotation.y = ry;
      m.castShadow = m.receiveShadow = !ghost;
      g.add(m);
      return m;
    };
    const house = (x: number, z: number, s: number) => {
      const ry = r() * Math.PI;
      add("box", P.wall, 0.26 * s, 0.2 * s, 0.24 * s, x, 0, z, ry);
      add("roof", P.accent, 0.36 * s, 0.18 * s, 0.34 * s, x, 0.2 * s, z, ry);
    };
    const tree = (x: number, z: number, s: number) => {
      add("cyl6", P.trunk, 0.06 * s, 0.12 * s, 0.06 * s, x, 0, z);
      add("cone6", P.leaf, (0.28 + r() * 0.1) * s, (0.42 + r() * 0.2) * s, (0.28 + r() * 0.1) * s, x, 0.1 * s, z, r() * 3);
    };
    const around = (n: number, rad: number, f: (x: number, z: number, i: number) => void) => {
      const a0 = r() * Math.PI * 2;
      for (let i = 0; i < n; i++) f(Math.cos(a0 + (i * 2 * Math.PI) / n) * rad, Math.sin(a0 + (i * 2 * Math.PI) / n) * rad, i);
    };
    switch (p.kind) {
      case "cidade":
        around(7, 0.34, (x, z) => {
          const h = 0.3 + r() * 0.5;
          add("box", P.wall, 0.18, h, 0.18, x, 0, z);
          add("box", P.accent, 0.2, 0.03, 0.2, x, h, z);
        });
        add("cyl8", P.wall, 0.24, 1.0, 0.24);
        add("cone8", P.accent, 0.3, 0.28, 0.3, 0, 1.0, 0);
        break;
      case "vila":
      case "regiao":
        around(4, 0.3, (x, z, i) => (i === 3 ? tree(x, z, 1) : house(x, z, 1)));
        add("cyl6", P.wallDark, 0.14, 0.32, 0.14);
        add("cone6", P.accent, 0.2, 0.14, 0.2, 0, 0.32, 0);
        break;
      case "bairro":
        for (let i = 0; i < 3; i++)
          for (let j = 0; j < 3; j++) {
            const h = 0.14 + r() * 0.3;
            add("box", r() < 0.25 ? P.accent : P.wall, 0.17, h, 0.17, (i - 1) * 0.24, 0, (j - 1) * 0.24);
          }
        break;
      case "predio":
        add("box", P.wall, 0.5, 0.62, 0.42);
        add("box", P.accent, 0.56, 0.05, 0.48, 0, 0.62, 0);
        add("box", P.accent, 0.3, 0.14, 0.26, 0, 0.67, 0);
        add("box", P.hole, 0.12, 0.18, 0.02, 0, 0, 0.21);
        break;
      case "casa":
        add("box", P.wall, 0.42, 0.3, 0.36);
        add("roof", P.accent, 0.58, 0.28, 0.5, 0, 0.3, 0);
        add("box", P.wallDark, 0.07, 0.2, 0.07, 0.12, 0.38, -0.06);
        add("box", P.hole, 0.1, 0.16, 0.02, 0, 0, 0.18);
        break;
      case "sala":
        add("box", P.wallDark, 0.62, 0.04, 0.62);
        add("box", P.wall, 0.62, 0.24, 0.04, 0, 0.04, -0.29);
        add("box", P.wall, 0.04, 0.24, 0.62, -0.29, 0.04, 0);
        add("box", P.wall, 0.04, 0.24, 0.62, 0.29, 0.04, 0);
        add("box", P.accent, 0.22, 0.1, 0.14, 0, 0.04, 0.02);
        break;
      case "torre":
        add("cyl8", P.wall, 0.34, 1.05, 0.34);
        add("cyl8", P.wallDark, 0.42, 0.08, 0.42, 0, 1.05, 0);
        add("cone8", P.accent, 0.46, 0.4, 0.46, 0, 1.13, 0);
        break;
      case "templo":
        add("box", P.rock, 0.68, 0.1, 0.68);
        [0.46, 0.34, 0.22].forEach((w, i) => {
          add("box", P.wall, w, 0.16, w, 0, 0.1 + i * 0.26, 0);
          add("roof", P.accent, w + 0.2, 0.1, w + 0.2, 0, 0.26 + i * 0.26, 0);
        });
        add("cyl6", P.accent, 0.03, 0.2, 0.03, 0, 0.88, 0);
        break;
      case "floresta":
        for (let i = 0; i < 7; i++) {
          const a = r() * Math.PI * 2, d = i ? 0.18 + r() * 0.26 : 0;
          tree(Math.cos(a) * d, Math.sin(a) * d, i ? 0.9 + r() * 0.3 : 1.25);
        }
        break;
      case "campo":
        add("disc", P.leaf.clone().lerp(P.wall, 0.25), 0.95, 0.02, 0.95);
        add("cyl6", P.trunk, 0.05, 0.3, 0.05, -0.18, 0, 0.05);
        add("cyl6", P.trunk, 0.05, 0.26, 0.05, 0.16, 0, -0.1);
        add("box", P.accent, 0.12, 0.12, 0.03, -0.18, 0.2, 0.08);
        tree(0.3, 0.28, 0.7);
        break;
      case "montanha":
        add("cone6", P.rock, 0.82, 0.95, 0.82, 0, 0, 0, r());
        add("cone6", P.text, 0.3, 0.3, 0.3, 0, 0.67, 0, r());
        add("cone6", P.rock, 0.5, 0.55, 0.5, 0.36, 0, 0.18, r());
        add("cone6", P.rock, 0.42, 0.42, 0.42, -0.3, 0, 0.24, r());
        break;
      case "agua":
        add("disc", P.info, 0.95, 0.03, 0.8).material = mat(P.info, { ghost, opacity: 0.85, glow: 0.12 });
        add("disc", P.rock, 1.02, 0.015, 0.87);
        tree(0.4, -0.32, 0.6);
        break;
      case "caverna":
        add("dome", P.rock, 0.82, 0.55, 0.72);
        add("cyl8", P.hole, 0.24, 0.26, 0.04, 0, 0, 0.33);
        tree(-0.36, 0.3, 0.6);
        break;
      case "ruina":
        around(4, 0.24, (x, z) => add("cyl8", P.rock, 0.1, 0.12 + r() * 0.42, 0.1, x, 0, z));
        add("box", P.rock, 0.3, 0.08, 0.12, 0.05, 0, 0.02, r() * 3);
        add("box", P.rock, 0.5, 0.04, 0.5);
        break;
      case "estrada":
        add("cyl6", P.trunk, 0.05, 0.56, 0.05);
        add("box", P.wall, 0.3, 0.08, 0.03, 0.06, 0.42, 0, 0.3);
        add("box", P.accent, 0.26, 0.07, 0.03, -0.05, 0.3, 0, -0.4);
        break;
      case "base":
        add("dome", P.wall, 0.62, 0.62, 0.62);
        add("box", P.wallDark, 0.56, 0.14, 0.24, 0, 0, 0.28);
        add("cyl6", P.dim, 0.02, 0.62, 0.02, 0.16, 0.2, -0.1);
        add("ball", P.accent, 0.08, 0.08, 0.08, 0.16, 0.8, -0.1, 0, 0.6);
        break;
      case "nave": {
        const ry = r() * Math.PI;
        add("ball", P.wall, 0.86, 0.22, 0.32, 0, 0.24, 0, ry);
        add("box", P.accent, 0.3, 0.04, 0.6, 0, 0.32, 0, ry);
        add("ball", P.info, 0.2, 0.12, 0.16, 0, 0.36, 0, ry, 0.5);
        add("cyl6", P.wallDark, 0.04, 0.24, 0.04);
        break;
      }
      case "portal": {
        add("box", P.rock, 0.62, 0.06, 0.24);
        add("torus", P.accent2, 1, 1, 1, 0, 0.5, 0, r() * 0.6, 0.9);
        break;
      }
      default:
        add("disc", P.wallDark, 0.3, 0.04, 0.3);
        add("cyl6", P.dim, 0.035, 0.8, 0.035);
        add("box", P.accent, 0.28, 0.17, 0.02, 0.15, 0.6, 0);
    }
    return g;
  }

  /** Peão: base, corpo e cabeça. */
  function pawn(c: THREE.Color, s: number, glow: number) {
    const g = new THREE.Group();
    const m = mat(c, { glow });
    for (const [geo, w, h, y] of [["cyl8", 0.3, 0.06, 0], ["cone8", 0.24, 0.36, 0.04], ["ball", 0.17, 0.17, 0.32]] as const) {
      const mesh = new THREE.Mesh(unit[geo], m);
      mesh.scale.set(w * s, h * s, w * s);
      mesh.position.y = y * s;
      mesh.castShadow = true;
      g.add(mesh);
    }
    return g;
  }

  // ---------- montagem (refeita a cada update; câmera e controles ficam) ----------
  let world = new THREE.Group();
  scene.add(world);
  let pos = new Map<string, THREE.Vector3>();
  let center = new THREE.Vector3();
  let radius = 5;
  let current: string | undefined;
  let selected: string | null = null;
  let hovered: string | null = null;
  const pickables: THREE.Object3D[] = [];
  let labels: { el: HTMLDivElement; at: THREE.Vector3; id: string; inner?: boolean }[] = [];
  let tip: HTMLDivElement | null = null;
  const selRing = new THREE.Mesh(unit.ring, mat(P.text, { basic: true, opacity: 0.75 }));
  selRing.visible = false;

  /** Libera o que foi criado só para esta montagem (geometrias e materiais fora dos caches). */
  const release = (root: THREE.Object3D) => {
    const cached = new Set<THREE.Material>(mats.values());
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry && !shared.has(m.geometry)) m.geometry.dispose();
      for (const x of ([] as THREE.Material[]).concat(m.material ?? [])) if (!cached.has(x)) x.dispose();
    });
  };

  function build(d: DioramaData) {
    release(world);
    scene.remove(world);
    world = new THREE.Group();
    scene.add(world);
    pickables.length = 0;
    layer.replaceChildren();
    labels = [];

    const places = d.map.places.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
    const byId = new Map(places.map((p) => [p.id, p]));
    const depth = (p: MapPlace) => {
      let n = 0;
      for (let q = byId.get(p.parent ?? ""); q && n < 4; q = byId.get(q.parent ?? "")) n++;
      return n;
    };
    pos = new Map(places.map((p) => [p.id, new THREE.Vector3(p.x! * S, 0, -p.y! * S)]));
    const box3 = new THREE.Box3().setFromPoints([...pos.values(), new THREE.Vector3()]);
    center = box3.getCenter(new THREE.Vector3()).setY(0);
    radius = Math.max(4.5, ...[...pos.values()].map((v) => v.distanceTo(center) + 2.2));
    current = d.map.current && byId.has(d.map.current) ? d.map.current : undefined;

    // região = o lugar e o que está dentro dele (raio até o filho mais longe)
    const region = new Map<string, number>();
    for (const p of places) {
      const kids = places.filter((k) => k.parent === p.id);
      if (kids.length) region.set(p.id, Math.max(...kids.map((k) => pos.get(k.id)!.distanceTo(pos.get(p.id)!))) + 0.75);
    }
    // mesa: tampo com relevo suave (plano perto dos locais e dentro das regiões) e borda
    const flat = (x: number, z: number) => {
      let m = Infinity;
      for (const [id, v] of pos) m = Math.min(m, Math.hypot(v.x - x, v.z - z) - (region.get(id) ?? 0));
      return THREE.MathUtils.smoothstep(m, 0.7, 2.2);
    };
    const top = new THREE.RingGeometry(0.001, radius, 72, 22);
    const vp = top.attributes.position;
    const colors: number[] = [];
    const lo = P.ground.clone().lerp(P.bg, 0.14), hi = P.ground.clone().lerp(P.dim, 0.1);
    for (let i = 0; i < vp.count; i++) {
      const x = vp.getX(i) + center.x, z = -vp.getY(i) + center.z;
      const edge = 1 - THREE.MathUtils.smoothstep(Math.hypot(vp.getX(i), vp.getY(i)), radius * 0.82, radius);
      const h = noise(x * 0.55, z * 0.55) * 0.28 * flat(x, z) * edge;
      vp.setZ(i, h);
      const c = lo.clone().lerp(hi, THREE.MathUtils.clamp(0.5 + h * 2.2, 0, 1));
      colors.push(c.r, c.g, c.b);
    }
    top.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    top.rotateX(-Math.PI / 2);
    top.computeVertexNormals();
    const topMesh = new THREE.Mesh(top, new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95 }));
    topMesh.position.copy(center);
    topMesh.receiveShadow = true;
    world.add(topMesh);
    const side = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius * 0.97, 0.5, 72, 1, true), mat(P.side));
    side.position.set(center.x, -0.25, center.z);
    world.add(side);
    const rim = new THREE.Mesh(new THREE.RingGeometry(radius - 0.05, radius + 0.02, 96).rotateX(-Math.PI / 2), mat(P.accent2, { basic: true, opacity: 0.5 }));
    rim.position.set(center.x, 0.005, center.z);
    world.add(rim);

    // regiões: mancha no chão sob o que está dentro de cada lugar
    for (const [id, r] of region) {
      const c = pos.get(id)!;
      const patch = new THREE.Mesh(unit.disc, mat(P.text, { basic: true, opacity: 0.035 }));
      patch.scale.set(r * 2, 0.001, r * 2);
      patch.position.set(c.x, 0.01, c.z);
      world.add(patch);
      const edge = new THREE.Mesh(new THREE.RingGeometry(r - 0.05, r, 64).rotateX(-Math.PI / 2), mat(P.accent, { basic: true, opacity: 0.3 }));
      edge.position.set(c.x, 0.012, c.z);
      world.add(edge);
    }

    // rotas: pedrinhas ao longo de uma curva leve
    const stone = new THREE.CylinderGeometry(0.045, 0.05, 0.03, 6);
    for (const r of d.map.routes) {
      const a = pos.get(r.from), b = pos.get(r.to);
      if (!a || !b) continue;
      const mid = a.clone().add(b).multiplyScalar(0.5);
      const n = new THREE.Vector3(-(b.z - a.z), 0, b.x - a.x).multiplyScalar(((hash(r.from + r.to) % 2 ? 1 : -1) * 0.12));
      const curve = new THREE.QuadraticBezierCurve3(a, mid.add(n), b);
      const len = curve.getLength();
      const count = Math.max(2, Math.floor(len / 0.2));
      const inst = new THREE.InstancedMesh(stone.clone(), mat(r.travel || r.label ? P.accent : P.dim, { opacity: 0.85 }), count);
      const m4 = new THREE.Matrix4();
      for (let i = 0; i < count; i++) {
        const t = 0.08 + (0.84 * i) / (count - 1);
        const q = curve.getPoint(t);
        m4.makeTranslation(q.x, 0.02, q.z);
        inst.setMatrixAt(i, m4);
      }
      inst.receiveShadow = true;
      world.add(inst);
    }
    stone.dispose();

    // locais
    for (const p of places) {
      const at = pos.get(p.id)!;
      const s = [1, 0.74, 0.6][Math.min(depth(p), 2)];
      const g = marker(p, !p.visits);
      g.scale.setScalar(s);
      g.position.copy(at);
      g.userData.placeId = p.id;
      world.add(g);
      pickables.push(g);
      const label = document.createElement("div");
      label.className = `map3d-label${p.id === current ? " is-current" : ""}${p.visits ? "" : " is-faint"}`;
      label.textContent = p.name;
      layer.appendChild(label);
      labels.push({ el: label, at: at.clone().setY(s * (p.kind === "torre" || p.kind === "cidade" || p.kind === "montanha" ? 1.25 : 0.85)), id: p.id, inner: !!p.parent });
    }
    const north = document.createElement("div");
    north.className = "map3d-north";
    north.textContent = "N";
    layer.appendChild(north);
    labels.push({ el: north, at: new THREE.Vector3(center.x, 0, center.z - radius - 0.3), id: "" });
    tip = document.createElement("div");
    tip.className = "map3d-label is-token off";
    layer.appendChild(tip);

    // onde o jogador está: anel no chão, o peão dele e quem está junto
    if (current) {
      const at = pos.get(current)!;
      const ring = new THREE.Mesh(unit.ring, mat(P.accent, { basic: true, opacity: 0.9 }));
      ring.scale.setScalar(0.72);
      ring.position.set(at.x, 0.03, at.z);
      const glow = new THREE.Mesh(unit.disc, mat(P.accent, { basic: true, opacity: 0.14 }));
      glow.scale.set(1.44, 0.001, 1.44);
      glow.position.set(at.x, 0.02, at.z);
      world.add(ring, glow);
      const front = new THREE.Vector3(at.x, 0, at.z + 0.62);
      const me = pawn(P.accent, 1, 0.35);
      me.position.copy(front);
      me.userData.token = d.player || "Você";
      world.add(me);
      pickables.push(me);
      const tokens = d.tokens.slice(0, 10);
      tokens.forEach((t, i) => {
        const a = Math.PI * (0.15 + (0.7 * (i + 0.5)) / tokens.length) + (i % 2) * 0.05;
        const c = t.stance === "hostil" ? P.danger : t.stance === "aliado" ? P.ok : P.dim;
        const pw = pawn(c, 0.72, t.stance === "hostil" ? 0.25 : 0.08);
        pw.position.set(front.x + Math.cos(a) * 0.42 * (i % 2 ? 1.5 : 1), 0, front.z + Math.sin(a) * 0.32 - 0.05);
        pw.userData.token = t.name;
        world.add(pw);
        pickables.push(pw);
      });
    }
    world.add(selRing);
    placeSelRing();

    // luz do período do dia
    const night = d.period === "noite" || d.period === "madrugada";
    hemi.color.copy(P.text).lerp(night ? P.info : P.warn, night ? 0.45 : 0.12);
    hemi.groundColor.copy(P.bg);
    hemi.intensity = night ? 0.55 : 0.85;
    sun.color.copy(new THREE.Color(1, 1, 1)).lerp(night ? P.info : P.warn, night ? 0.55 : d.period === "tarde" ? 0.28 : 0.12);
    sun.intensity = night ? 0.7 : 1.7;
    sun.position.set(center.x - radius * 0.6, radius * 1.6, center.z + radius * 0.9);
    sun.target.position.copy(center);
    const sc = sun.shadow.camera;
    sc.left = sc.bottom = -radius - 1;
    sc.right = sc.top = radius + 1;
    sc.near = 0.5;
    sc.far = radius * 5;
    sc.updateProjectionMatrix();
  }

  function placeSelRing() {
    const at = selected ? pos.get(selected) : undefined;
    selRing.visible = !!at && selected !== current;
    if (at) {
      selRing.scale.setScalar(0.66);
      selRing.position.set(at.x, 0.035, at.z);
    }
  }

  // ---------- render sob demanda ----------
  let raf = 0;
  let anim: { from: THREE.Vector3; to: THREE.Vector3; camFrom: THREE.Vector3; camTo: THREE.Vector3; t0: number } | null = null;
  const v = new THREE.Vector3();
  const updateLabels = () => {
    const w = el.clientWidth, h = el.clientHeight;
    // tela cheia: todos os nomes, mas os de dentro de uma região só de perto (senão empilham)
    const close = camera.position.distanceTo(controls.target) < 12;
    for (const l of labels) {
      v.copy(l.at).project(camera);
      const show =
        v.z < 1 && (!l.id || l.id === current || l.id === hovered || l.id === selected || (opts.full && (!l.inner || close)));
      l.el.classList.toggle("off", !show);
      l.el.classList.toggle("is-hover", !!l.id && (l.id === hovered || l.id === selected) && l.id !== current);
      if (show) l.el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, -100%)`;
    }
  };
  const frame = (now: number) => {
    let moving = false;
    if (anim) {
      const k = Math.min(1, (now - anim.t0) / 900);
      const e = k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2;
      controls.target.lerpVectors(anim.from, anim.to, e);
      camera.position.lerpVectors(anim.camFrom, anim.camTo, e);
      if (k >= 1) anim = null;
      moving = true;
    }
    moving = controls.update() || moving;
    renderer.render(scene, camera);
    updateLabels();
    raf = moving ? requestAnimationFrame(frame) : 0;
  };
  const kick = () => {
    if (!raf) raf = requestAnimationFrame(frame);
  };
  controls.addEventListener("change", kick);

  const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const viewDistance = () => (opts.full ? THREE.MathUtils.clamp(radius * 2.9, 9, 95) : THREE.MathUtils.clamp(radius * 0.8, 5, 7));
  /** Leva a câmera até o local (ou o centro), mantendo o ângulo atual; suave, a menos que o sistema peça menos movimento. */
  function focus(id?: string | null, animate = true) {
    const to = (id && pos.get(id)) || (opts.full ? center : pos.get(current ?? "")) || center;
    const off = camera.position.clone().sub(controls.target);
    if (off.lengthSq() < 1e-6) off.set(0, Math.sin(0.82), Math.cos(0.82));
    // tela cheia: "ver tudo" afasta até caber a mesa; escolher um lugar aproxima
    off.setLength(opts.full ? (id ? Math.min(off.length(), 11) : viewDistance()) : Math.min(off.length(), viewDistance()));
    if (!animate || reduced()) {
      controls.target.copy(to);
      camera.position.copy(to).add(off);
      anim = null;
    } else anim = { from: controls.target.clone(), to: to.clone(), camFrom: camera.position.clone(), camTo: to.clone().add(off), t0: performance.now() };
    kick();
  }

  // ---------- ponteiro: hover com nome, clique seleciona ----------
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const pick = (e: PointerEvent) => {
    const r = el.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    for (const hit of ray.intersectObjects(pickables, true)) {
      let o: THREE.Object3D | null = hit.object;
      while (o && !o.userData.placeId && !o.userData.token) o = o.parent;
      if (o) return { place: o.userData.placeId as string | undefined, token: o.userData.token as string | undefined, point: hit.point };
    }
    return null;
  };
  let down: { x: number; y: number } | null = null;
  let dragging = false;
  const onDown = (e: PointerEvent) => {
    down = { x: e.clientX, y: e.clientY };
    dragging = true;
  };
  const onUp = (e: PointerEvent) => {
    dragging = false;
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
    down = null;
    const h = pick(e);
    const id = h?.place ?? (h?.token ? current ?? null : null);
    opts.onSelect(id ?? null);
  };
  const onMove = (e: PointerEvent) => {
    if (dragging && e.buttons) return;
    const h = pick(e);
    const id = h?.place ?? null;
    el.style.cursor = h ? "pointer" : "grab";
    if (tip) {
      tip.classList.toggle("off", !h?.token);
      if (h?.token) {
        tip.textContent = h.token;
        const r = el.getBoundingClientRect();
        tip.style.transform = `translate(${e.clientX - r.left}px, ${e.clientY - r.top - 14}px) translate(-50%, -100%)`;
      }
    }
    if (id !== hovered) {
      hovered = id;
      kick();
    }
  };
  const onLeave = () => {
    hovered = null;
    tip?.classList.add("off");
    kick();
  };
  el.addEventListener("pointerdown", onDown);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerleave", onLeave);

  const ro = new ResizeObserver(() => {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    kick();
  });
  ro.observe(host);

  build(data);
  camera.position.set(0, Math.sin(0.82), Math.cos(0.82)).multiplyScalar(viewDistance());
  focus(opts.full ? null : current, false);

  return {
    update(d) {
      const prev = current;
      build(d);
      if (current !== prev) focus(current);
      else kick();
    },
    select(id) {
      selected = id;
      placeSelRing();
      if (id) focus(id);
      else kick();
    },
    focus(id) {
      focus(id ?? (opts.full ? null : current));
    },
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", onLeave);
      release(world);
      shared.forEach((g) => g.dispose());
      mats.forEach((m) => m.dispose());
      renderer.dispose();
      renderer.forceContextLoss();
      el.remove();
      layer.remove();
    },
  };
}
