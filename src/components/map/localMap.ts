// Mapa 3D de um local (three), carregado sob demanda pela aba Mapa: o spec do Cartógrafo vira uma
// maquete sobre a mesa. Primitivas de mesma forma e material viram um InstancedMesh só. Renderiza
// só quando algo se mexe (a água, se houver, ondula a ~15 fps enquanto o mapa está visível).
// Fundo, borda, luz da noite e destaques vêm do tema (palette do diorama); a luz segue a hora do jogo.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Period } from "@/lib/clock";
import { expandSpec, groundHeight, type MapSpec, type Prim } from "@/lib/mapSpec";
import { palette } from "./diorama";

export interface LocalToken {
  name: string;
  poi: number; // índice em spec.pois
  kind: "player" | "aliado" | "hostil" | "neutro";
}
export interface LocalMapData {
  spec: MapSpec;
  tokens: LocalToken[];
  period?: Period;
}
export interface LocalMapHandle {
  update(d: LocalMapData): void;
  select(i: number | null): void;
  focus(i?: number | null): void;
  dispose(): void;
}

const DEG = Math.PI / 180;
// direção do sol (ou da lua) e quanto puxa para o quente/frio do tema, por período do dia
const SUN: Record<string, { dir: [number, number, number]; warm: number; cold: number; power: number }> = {
  manhã: { dir: [0.8, 0.75, 0.45], warm: 0.12, cold: 0, power: 1.6 },
  tarde: { dir: [-0.9, 0.55, 0.35], warm: 0.32, cold: 0, power: 1.5 },
  noite: { dir: [-0.3, 1, -0.5], warm: 0, cold: 0.6, power: 0.5 },
  madrugada: { dir: [0.4, 0.9, -0.6], warm: 0, cold: 0.7, power: 0.35 },
  dia: { dir: [-0.45, 0.9, 0.55], warm: 0.05, cold: 0, power: 1.8 },
};

export function createLocalMap(
  host: HTMLElement,
  data: LocalMapData,
  opts: { full: boolean; onSelect: (i: number | null) => void }
): LocalMapHandle {
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

  const P = palette(host);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, host.clientWidth / Math.max(1, host.clientHeight), 0.1, 3000);
  const hemi = new THREE.HemisphereLight(0xffffff, 0x000000, 1);
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  scene.add(hemi, sun, sun.target);

  const controls = new OrbitControls(camera, el);
  controls.enableDamping = true;
  controls.dampingFactor = 0.09;
  controls.maxPolarAngle = 1.3;
  controls.screenSpacePanning = false;
  controls.enableZoom = opts.full; // na lateral a roda rola a página; zoom fica na tela cheia

  // geometrias unitárias com a base em y=0 (size = largura, altura, profundidade)
  const unit = {
    box: new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0),
    cylinder: new THREE.CylinderGeometry(0.5, 0.5, 1, 12).translate(0, 0.5, 0),
    cone: new THREE.ConeGeometry(0.5, 1, 12).translate(0, 0.5, 0),
    sphere: new THREE.SphereGeometry(0.5, 14, 10).translate(0, 0.5, 0),
    dome: new THREE.SphereGeometry(0.5, 14, 7, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 2, 1),
    pyramid: new THREE.ConeGeometry(Math.SQRT1_2, 1, 4).rotateY(Math.PI / 4).translate(0, 0.5, 0),
    torus: new THREE.TorusGeometry(0.4, 0.1, 8, 28).scale(1, 1, 5).translate(0, 0.5, 0),
    pin: new THREE.OctahedronGeometry(0.5).scale(0.7, 1, 0.7),
    ring: new THREE.RingGeometry(0.8, 1, 48).rotateX(-Math.PI / 2),
  };
  const shared = new Set<THREE.BufferGeometry>(Object.values(unit));
  const colorOf = (c: string) => {
    const themed = { accent: P.accent, accent2: P.accent2, danger: P.danger, ok: P.ok, info: P.info, warn: P.warn }[c];
    // um toque do fundo do tema assenta as cores do modelo na interface
    return themed ? themed.clone() : new THREE.Color(c).lerp(P.bg, 0.08);
  };

  let world = new THREE.Group();
  scene.add(world);
  let spec = data.spec;
  let night = false;
  let selected: number | null = null;
  let hovered: number | null = null;
  const pickables: THREE.Object3D[] = [];
  let labels: { el: HTMLButtonElement; at: THREE.Vector3; i: number; w: number }[] = [];
  const selRing = new THREE.Mesh(unit.ring, new THREE.MeshBasicMaterial({ color: P.accent, transparent: true, opacity: 0.9, depthWrite: false }));
  const waterTime = { value: 0 };
  let hasWater = false;

  const release = (root: THREE.Object3D) =>
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry && !shared.has(m.geometry)) m.geometry.dispose();
      if (o !== selRing) for (const x of ([] as THREE.Material[]).concat(m.material ?? [])) x.dispose();
    });

  const std = (c: THREE.Color, glow = 0, opacity = 1, extra: THREE.MeshStandardMaterialParameters = {}) =>
    new THREE.MeshStandardMaterial({
      color: c,
      flatShading: true,
      roughness: 0.85,
      metalness: 0.05,
      emissive: c,
      emissiveIntensity: glow * (night ? 1.6 : 0.9),
      transparent: opacity < 1,
      opacity,
      ...extra,
    });
  /** Água low-poly: ondula no vértice (tempo em waterTime); o sombreamento chapado faz as facetas brilharem. */
  const water = (c: THREE.Color) => {
    hasWater = true;
    const m = std(c, 0.1, 0.82, { roughness: 0.2, metalness: 0.25 });
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = waterTime;
      sh.vertexShader = `uniform float uTime;\n${sh.vertexShader}`.replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        vec4 wp = modelMatrix * vec4(position, 1.0);
        transformed.y += sin(wp.x * 0.55 + uTime * 1.6) * 0.09 + cos(wp.z * 0.47 + uTime * 1.15) * 0.07;`
      );
    };
    return m;
  };
  const ground = (x: number, z: number) => groundHeight(spec, x, z);
  /** Assenta a geometria (no plano xz, em metros, em volta de cx/cz) sobre o relevo, `lift` acima dele. */
  const drape = (g: THREE.BufferGeometry, cx: number, cz: number, lift: number, flatAt?: number) => {
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i) + cx, z = p.getZ(i) + cz;
      p.setXYZ(i, x, (flatAt ?? ground(x, z)) + lift, z);
    }
    g.computeVertexNormals();
    return g;
  };

  /** Fita no chão ao longo dos pontos (rua, trilha, rio), em curva suave. */
  function ribbon(points: [number, number][], width: number, lift: number) {
    const curve = new THREE.CatmullRomCurve3(points.map(([x, z]) => new THREE.Vector3(x, 0, z)), false, "centripetal");
    const n = THREE.MathUtils.clamp(Math.round(curve.getLength() / 1.2), 8, 260);
    const pos: number[] = [], idx: number[] = [];
    for (let i = 0; i <= n; i++) {
      const p = curve.getPoint(i / n), t = curve.getTangent(i / n);
      const nx = -t.z * (width / 2), nz = t.x * (width / 2);
      pos.push(p.x + nx, 0, p.z + nz, p.x - nx, 0, p.z - nz);
      if (i) idx.push(2 * i - 2, 2 * i - 1, 2 * i, 2 * i - 1, 2 * i + 1, 2 * i);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    return drape(g, 0, 0, lift);
  }

  function pawn(c: THREE.Color, h: number, glow: number) {
    const g = new THREE.Group();
    const m = std(c, glow);
    for (const [geo, w, hh, y] of [["cylinder", 0.34, 0.06, 0], ["cone", 0.26, 0.4, 0.04], ["sphere", 0.2, 0.2, 0.36]] as const) {
      const mesh = new THREE.Mesh(unit[geo], m);
      mesh.scale.set(w * h, hh * h, w * h);
      mesh.position.y = y * h;
      mesh.castShadow = true;
      g.add(mesh);
    }
    return g;
  }

  const poiPos = (i: number) => {
    const p = spec.pois[i];
    return p ? new THREE.Vector3(p.at[0], p.at[1] + ground(p.at[0], p.at[2]), p.at[2]) : null;
  };
  const markScale = () => THREE.MathUtils.clamp(spec.size / 50, 0.7, 4); // marcadores e peões

  function build(d: LocalMapData) {
    release(world);
    scene.remove(world);
    world = new THREE.Group();
    scene.add(world);
    pickables.length = 0;
    layer.replaceChildren();
    labels = [];
    spec = d.spec;
    hasWater = false;
    const per = spec.sky.indoor ? "dia" : d.period ?? "dia";
    night = per === "noite" || per === "madrugada";
    const size = spec.size;

    // terreno (relevo do spec) sobre a laje da mesa, com a borda no acento do tema
    const top = new THREE.PlaneGeometry(size, size, 64, 64).rotateX(-Math.PI / 2);
    drape(top, 0, 0, 0);
    const vp = top.attributes.position;
    const base = colorOf(spec.ground.color);
    const colors: number[] = [];
    for (let i = 0; i < vp.count; i++) {
      const h = vp.getY(i);
      const c = base.clone().lerp(h >= 0 ? P.text : P.bg, Math.min(0.28, Math.abs(h) / (size * 0.15) + 0.03));
      colors.push(c.r, c.g, c.b);
    }
    top.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    const terrain = new THREE.Mesh(top, new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95 }));
    terrain.receiveShadow = true;
    world.add(terrain);
    let low = 0;
    for (let i = 0; i < vp.count; i++) low = Math.min(low, vp.getY(i));
    const slabH = Math.max(0.6, size * 0.025) - low;
    const slab = new THREE.Mesh(new THREE.BoxGeometry(size * 0.999, slabH, size * 0.999), std(P.side));
    slab.position.y = low - slabH / 2 - 0.01;
    world.add(slab);
    const rim = new THREE.Mesh(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(size, slabH, size)),
      new THREE.LineBasicMaterial({ color: P.accent2, transparent: true, opacity: 0.55 })
    );
    rim.position.copy(slab.position);
    world.add(rim);

    // pisos: assentados no relevo; água fica plana, no nível da borda mais alta (enche a bacia)
    const level = (a: { at: [number, number]; size: [number, number] }) =>
      Math.max(...Array.from({ length: 9 }, (_, j) => {
        const t = (j * Math.PI) / 4, r = j === 8 ? 0 : 0.5;
        return ground(a.at[0] + Math.cos(t) * a.size[0] * r, a.at[1] + Math.sin(t) * a.size[1] * r);
      }));
    spec.areas.forEach((a, i) => {
      const [w, dd] = a.size;
      const geo = a.round
        ? new THREE.RingGeometry(0.001, 0.5, 40, 6).rotateX(-Math.PI / 2).scale(w, 1, dd)
        : new THREE.PlaneGeometry(w, dd, Math.min(48, Math.ceil(w / 1.5)), Math.min(48, Math.ceil(dd / 1.5))).rotateX(-Math.PI / 2);
      const c = colorOf(a.color);
      const lift = 0.05 + i * 0.006;
      const m = new THREE.Mesh(drape(geo, a.at[0], a.at[1], lift, a.water ? level(a) : undefined), a.water ? water(c) : std(c, a.glow));
      m.receiveShadow = true;
      world.add(m);
    });
    // caminhos: fita suave no chão; com altura, muro em segmentos retos
    spec.paths.forEach((p, i) => {
      const c = colorOf(p.color);
      if (!p.height) {
        const m = new THREE.Mesh(ribbon(p.points, p.width, 0.16 + i * 0.006), p.water ? water(c) : std(c));
        m.receiveShadow = true;
        world.add(m);
        return;
      }
      const segs = p.points.slice(1).map((b, j) => [p.points[j], b] as const);
      const inst = new THREE.InstancedMesh(unit.box, std(c), segs.length);
      segs.forEach(([a, b], j) => {
        const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz) + p.width; // sobra cobre a junta
        const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
        const y = Math.min(ground(a[0], a[1]), ground(b[0], b[1]), ground(mx, mz)) - 0.3;
        const m = new THREE.Matrix4().compose(
          new THREE.Vector3(mx, y, mz),
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(-dz, dx)),
          new THREE.Vector3(len, p.height + 0.3 + Math.max(0, ground(mx, mz) - y - 0.3), p.width)
        );
        inst.setMatrixAt(j, m);
      });
      inst.castShadow = inst.receiveShadow = true;
      world.add(inst);
    });

    // primitivas: uma malha instanciada por forma + material; contornos extrudados, uma malha cada
    const groups = new Map<string, { p: Prim; m: THREE.Matrix4[] }>();
    const q = new THREE.Quaternion(), e = new THREE.Euler(0, 0, 0, "YXZ");
    const matOf = (p: Prim) => std(colorOf(p.color), p.glow, p.opacity, { roughness: p.rough, metalness: p.metal });
    for (const p of expandSpec(spec)) {
      q.setFromEuler(e.set(p.rot[0] * DEG, p.rot[1] * DEG, p.rot[2] * DEG, "YXZ"));
      const m = new THREE.Matrix4().compose(new THREE.Vector3(...p.at), q, new THREE.Vector3(...p.size));
      if (p.shape === "extrude") {
        const shape = new THREE.Shape(p.points!.map(([x, z]) => new THREE.Vector2(x, -z)));
        const mesh = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false }).rotateX(-Math.PI / 2), matOf(p));
        mesh.applyMatrix4(m);
        mesh.castShadow = p.opacity >= 0.6;
        mesh.receiveShadow = true;
        world.add(mesh);
        continue;
      }
      const key = `${p.shape}|${p.color}|${p.glow}|${p.opacity}|${p.rough}|${p.metal}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { p, m: [] }));
      g.m.push(m);
    }
    for (const { p, m } of groups.values()) {
      const inst = new THREE.InstancedMesh(unit[p.shape as keyof typeof unit], matOf(p), m.length);
      m.forEach((x, i) => inst.setMatrixAt(i, x));
      inst.castShadow = p.opacity >= 0.6;
      inst.receiveShadow = true;
      world.add(inst);
    }

    // pontos de interesse: marcador flutuante + nome clicável
    const k = markScale();
    spec.pois.forEach((_, i) => {
      const at = poiPos(i)!;
      const pin = new THREE.Mesh(unit.pin, std(P.accent, 0.7));
      pin.scale.setScalar(1.3 * k);
      pin.position.set(at.x, at.y + 2.6 * k, at.z);
      pin.userData.poi = i;
      world.add(pin);
      pickables.push(pin);
      const b = document.createElement("button");
      b.type = "button";
      b.className = "map3d-label";
      b.style.pointerEvents = "auto";
      b.style.cursor = "pointer";
      b.textContent = spec.pois[i].name;
      b.addEventListener("click", () => opts.onSelect(i === selected ? null : i));
      layer.appendChild(b);
      labels.push({ el: b, at: at.clone().setY(at.y + 3.6 * k), i, w: 0 });
    });

    // peões: quem está em cada zona do palco que bate com um ponto
    const byPoi = new Map<number, LocalToken[]>();
    for (const t of d.tokens) byPoi.set(t.poi, [...(byPoi.get(t.poi) ?? []), t]);
    for (const [i, ts] of byPoi) {
      const at = poiPos(i);
      if (!at) continue;
      const n = Math.min(ts.length, 8);
      ts.slice(0, n).forEach((t, j) => {
        const a = (j / n) * Math.PI * 2 + 0.6, r = n > 1 ? 1.4 * k : 0;
        const c = t.kind === "player" ? P.accent : t.kind === "hostil" ? P.danger : t.kind === "aliado" ? P.ok : P.dim;
        const pw = pawn(c, 2.2 * k * (t.kind === "player" ? 1.15 : 1), t.kind === "player" ? 0.4 : t.kind === "hostil" ? 0.3 : 0.08);
        pw.position.set(at.x + Math.cos(a) * r, at.y, at.z + Math.sin(a) * r);
        pw.userData.poi = i;
        pw.userData.token = t.name;
        world.add(pw);
        pickables.push(pw);
      });
    }
    world.add(selRing);
    placeSelRing();

    // luz: a do spec, pela hora do jogo (fora de interiores), puxada para o quente/frio do tema
    const s = SUN[per] ?? SUN.dia;
    const sky = colorOf(spec.sky.color);
    hemi.color.copy(sky).lerp(P.text, 0.35).lerp(P.info, s.cold * 0.7);
    hemi.groundColor.copy(base).lerp(P.bg, 0.5);
    hemi.intensity = night ? 0.5 : spec.sky.indoor ? 1.05 : 0.9;
    sun.color.copy(new THREE.Color(spec.sky.light)).lerp(P.warn, s.warm).lerp(P.info, s.cold);
    sun.intensity = spec.sky.indoor ? 1.1 : s.power;
    sun.position.set(s.dir[0] * size, s.dir[1] * size, s.dir[2] * size);
    sun.target.position.set(0, 0, 0);
    const sc = sun.shadow.camera;
    sc.left = sc.bottom = -size * 0.8;
    sc.right = sc.top = size * 0.8;
    sc.near = 1;
    sc.far = size * 3.5;
    sc.updateProjectionMatrix();
    scene.fog = spec.sky.fog > 0 ? new THREE.FogExp2(sky.clone().lerp(P.bg, night ? 0.75 : 0.55), (spec.sky.fog * 0.45) / size) : null;
    // céu: o fundo do quadro puxa a cor do spec sobre o fundo do tema
    host.style.background = `radial-gradient(ellipse 95% 80% at 50% 25%, color-mix(in srgb, #${sky.getHexString(THREE.SRGBColorSpace)} ${night ? 14 : 34}%, var(--bg-panel)), var(--bg-sunken))`;
    controls.minDistance = Math.max(4, size * 0.08);
    controls.maxDistance = size * 2.6;
  }

  function placeSelRing() {
    const at = selected !== null ? poiPos(selected) : null;
    selRing.visible = !!at;
    if (at) {
      selRing.scale.setScalar(2.4 * markScale());
      selRing.position.set(at.x, at.y + 0.25, at.z);
    }
  }

  // ---------- render sob demanda ----------
  let raf = 0;
  let anim: { from: THREE.Vector3; to: THREE.Vector3; camFrom: THREE.Vector3; camTo: THREE.Vector3; t0: number } | null = null;
  const v = new THREE.Vector3();
  const updateLabels = () => {
    const w = el.clientWidth, h = el.clientHeight;
    // escolhido primeiro; nome que encostaria noutro já mostrado some (gire ou aproxime para ver)
    const placed: [number, number, number][] = [];
    const order = [...labels].sort((a, b) => Number(b.i === selected) - Number(a.i === selected) || Number(b.i === hovered) - Number(a.i === hovered));
    for (const l of order) {
      v.copy(l.at).project(camera);
      const x = ((v.x + 1) / 2) * w, y = ((1 - v.y) / 2) * h;
      l.w ||= l.el.offsetWidth;
      const free = placed.every(([px, py, pw]) => Math.abs(py - y) > 20 || Math.abs(px - x) > (pw + l.w) / 2 + 4);
      const show = v.z < 1 && x > -40 && x < w + 40 && y > 0 && y < h + 20 && (free || l.i === selected);
      l.el.classList.toggle("off", !show);
      l.el.tabIndex = show ? 0 : -1;
      l.el.classList.toggle("is-current", l.i === selected);
      l.el.classList.toggle("is-hover", l.i === hovered && l.i !== selected);
      if (show) {
        placed.push([x, y, l.w]);
        l.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
      }
    }
  };
  const frame = (now: number) => {
    let moving = false;
    if (anim) {
      const t = Math.min(1, (now - anim.t0) / 900);
      const ease = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
      controls.target.lerpVectors(anim.from, anim.to, ease);
      camera.position.lerpVectors(anim.camFrom, anim.camTo, ease);
      if (t >= 1) anim = null;
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
  // água: ~15 fps só com o mapa na tela, a aba visível e sem pedido de menos movimento
  let onScreen = true;
  const io = new IntersectionObserver(([en]) => (onScreen = en.isIntersecting));
  io.observe(host);
  const waves = setInterval(() => {
    if (!hasWater || !onScreen || document.hidden || reduced()) return;
    waterTime.value = performance.now() / 1000;
    kick();
  }, 66);

  /** Distância que enquadra o terreno inteiro no aspecto atual. */
  const fit = () => {
    const vf = camera.fov * DEG;
    const hf = 2 * Math.atan(Math.tan(vf / 2) * camera.aspect);
    return (spec.size * 0.62) / Math.tan(Math.min(vf, hf) / 2);
  };
  /** Leva a câmera até o ponto (ou o terreno todo), mantendo o ângulo; suave, a menos que o sistema peça menos movimento. */
  function focus(i?: number | null, animate = true) {
    const p = i !== null && i !== undefined ? poiPos(i) : null;
    const to = p ? new THREE.Vector3(p.x, p.y, p.z) : new THREE.Vector3();
    const off = camera.position.clone().sub(controls.target);
    if (off.lengthSq() < 1e-6) off.set(0, Math.sin(0.95), Math.cos(0.95));
    off.setLength(p ? Math.min(off.length(), spec.size * 0.65) : fit());
    if (!animate || reduced()) {
      controls.target.copy(to);
      camera.position.copy(to).add(off);
      anim = null;
    } else anim = { from: controls.target.clone(), to, camFrom: camera.position.clone(), camTo: to.clone().add(off), t0: performance.now() };
    kick();
  }

  // ---------- ponteiro ----------
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const pick = (ev: PointerEvent) => {
    const r = el.getBoundingClientRect();
    ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    for (const hit of ray.intersectObjects(pickables, true)) {
      let o: THREE.Object3D | null = hit.object;
      while (o && o.userData.poi === undefined) o = o.parent;
      if (o) return { poi: o.userData.poi as number, token: o.userData.token as string | undefined };
    }
    return null;
  };
  const tip = document.createElement("div");
  tip.className = "map3d-label is-token off";
  let down: { x: number; y: number } | null = null;
  const onDown = (ev: PointerEvent) => (down = { x: ev.clientX, y: ev.clientY });
  const onUp = (ev: PointerEvent) => {
    if (!down || Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > 5) return;
    down = null;
    opts.onSelect(pick(ev)?.poi ?? null);
  };
  const onMove = (ev: PointerEvent) => {
    if (ev.buttons) return;
    const h = pick(ev);
    el.style.cursor = h ? "pointer" : "grab";
    if (!tip.isConnected) layer.appendChild(tip);
    tip.classList.toggle("off", !h?.token);
    if (h?.token) {
      const r = el.getBoundingClientRect();
      tip.textContent = h.token;
      tip.style.transform = `translate(${ev.clientX - r.left}px, ${ev.clientY - r.top - 14}px) translate(-50%, -100%)`;
    }
    const id = h?.poi ?? null;
    if (id !== hovered) {
      hovered = id;
      kick();
    }
  };
  const onLeave = () => {
    hovered = null;
    tip.classList.add("off");
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
  camera.position.set(0, Math.sin(0.95), Math.cos(0.95)).multiplyScalar(fit());
  focus(null, false);

  return {
    update(d) {
      const resize = d.spec.size !== spec.size;
      build(d);
      if (resize) focus(null);
      else kick();
    },
    select(i) {
      selected = i;
      placeSelRing();
      if (i !== null) focus(i);
      else kick();
    },
    focus(i) {
      focus(i);
    },
    dispose() {
      cancelAnimationFrame(raf);
      clearInterval(waves);
      io.disconnect();
      ro.disconnect();
      controls.dispose();
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", onLeave);
      release(world);
      shared.forEach((g) => g.dispose());
      (selRing.material as THREE.Material).dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      el.remove();
      layer.remove();
    },
  };
}
