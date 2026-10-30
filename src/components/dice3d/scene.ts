// Caixa de dados 3D (three + cannon-es), carregada sob demanda pelo DiceRoller.
// O valor vem do servidor: a física é simulada inteira antes de mostrar, a face que
// terminou em cima recebe o número pedido (troca de rótulos) e os quadros gravados
// são reproduzidos. Como a reprodução é exatamente a simulação, a face bate sempre.
import * as THREE from "three";
import * as CANNON from "cannon-es";

type Shape = 4 | 6 | 8 | 10 | 12 | 20;
/** Um dado físico: forma, rótulos (por face; no d4, por vértice) e o rótulo que deve ficar em cima. */
export interface DieSpec {
  shape: Shape;
  labels: string[];
  value: string;
}

const range = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i));

/** Rolagens → dados visíveis (até `max`). d100 vira dezena + unidade; lados fora do conjunto usam a forma mais próxima. */
export function diceSpecs(rolls: number[], sides: number, max = 10): { dice: DieSpec[]; shown: number } {
  const dice: DieSpec[] = [];
  let shown = 0;
  for (const v of rolls) {
    let add: DieSpec[];
    if (sides === 100) {
      const tens = (v % 100) - (v % 10);
      add = [
        { shape: 10, labels: range(10, (i) => String(i * 10).padStart(2, "0")), value: String(tens).padStart(2, "0") },
        { shape: 10, labels: range(10, (i) => String(i)), value: String(v % 10) },
      ];
    } else {
      const shape: Shape = sides === 4 ? 4 : (([6, 8, 10, 12, 20] as const).find((s) => s >= sides) ?? 20);
      add = [{ shape, labels: range(shape, (i) => String((i % sides) + 1)), value: String(v) }];
    }
    if (dice.length + add.length > max) break;
    dice.push(...add);
    shown++;
  }
  return { dice, shown };
}

// ---------- geometria ----------

const PHI = (1 + Math.sqrt(5)) / 2;
function rawVerts(shape: Shape): number[][] {
  const s = [-1, 1];
  switch (shape) {
    case 4:
      return [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]];
    case 6:
      return s.flatMap((x) => s.flatMap((y) => s.map((z) => [x, y, z])));
    case 8:
      return [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    case 10: {
      // trapezoedro pentagonal: altura do anel calculada para as pipas ficarem planas
      const c = Math.cos(Math.PI / 5);
      const e = (1 - c) / (1 + c);
      return [[0, 1, 0], [0, -1, 0], ...Array.from({ length: 10 }, (_, i) => {
        const a = (i * Math.PI) / 5;
        return [Math.cos(a), i % 2 ? -e : e, Math.sin(a)];
      })];
    }
    case 12:
      return [
        ...s.flatMap((x) => s.flatMap((y) => s.map((z) => [x, y, z]))),
        ...s.flatMap((a) => s.flatMap((b) => [[0, a / PHI, b * PHI], [a / PHI, b * PHI, 0], [a * PHI, 0, b / PHI]])),
      ];
    case 20:
      return s.flatMap((a) => s.flatMap((b) => [[0, a, b * PHI], [a, b * PHI, 0], [a * PHI, 0, b]]));
  }
}
const RADIUS: Record<Shape, number> = { 4: 1.5, 6: 1.15, 8: 1.25, 10: 1.25, 12: 1.25, 20: 1.3 };

/** Faces do fecho convexo (índices em ordem anti-horária vista de fora). Força bruta: poucos vértices. */
function hull(v: THREE.Vector3[]): number[][] {
  const faces: number[][] = [];
  const seen = new Set<string>();
  const eps = 1e-4;
  for (let i = 0; i < v.length; i++)
    for (let j = i + 1; j < v.length; j++)
      for (let k = j + 1; k < v.length; k++) {
        const n = new THREE.Vector3().subVectors(v[j], v[i]).cross(new THREE.Vector3().subVectors(v[k], v[i]));
        if (n.length() < 1e-9) continue;
        n.normalize();
        let d = n.dot(v[i]);
        if (d < 0) { n.negate(); d = -d; }
        if (v.some((p) => n.dot(p) > d + eps)) continue;
        const on = v.map((_, idx) => idx).filter((idx) => Math.abs(n.dot(v[idx]) - d) < eps);
        const key = on.join(",");
        if (seen.has(key)) continue;
        seen.add(key);
        const c = on.reduce((a, idx) => a.add(v[idx]), new THREE.Vector3()).divideScalar(on.length);
        const ref = new THREE.Vector3().subVectors(v[on[0]], c);
        const ang = (idx: number) => {
          const w = new THREE.Vector3().subVectors(v[idx], c);
          return Math.atan2(n.dot(new THREE.Vector3().crossVectors(ref, w)), ref.dot(w));
        };
        faces.push(on.sort((a, b) => ang(a) - ang(b)));
      }
  return faces;
}

interface DieGeo {
  verts: THREE.Vector3[];
  faces: number[][];
  normals: THREE.Vector3[];
  geometry: THREE.BufferGeometry;
  edges: THREE.EdgesGeometry;
}
const geoCache = new Map<Shape, DieGeo>();
function dieGeo(shape: Shape): DieGeo {
  const hit = geoCache.get(shape);
  if (hit) return hit;
  let verts = rawVerts(shape).map(([x, y, z]) => new THREE.Vector3(x, y, z));
  const maxLen = Math.max(...verts.map((p) => p.length()));
  verts = verts.map((p) => p.multiplyScalar(RADIUS[shape] / maxLen));
  const faces = hull(verts);
  const pos: number[] = [], nor: number[] = [], uv: number[] = [];
  const geometry = new THREE.BufferGeometry();
  const normals: THREE.Vector3[] = [];
  faces.forEach((f, fi) => {
    const p = f.map((i) => verts[i]);
    const n = new THREE.Vector3().subVectors(p[1], p[0]).cross(new THREE.Vector3().subVectors(p[2], p[0])).normalize();
    normals.push(n);
    const c = p.reduce((a, q) => a.clone().add(q), new THREE.Vector3()).divideScalar(p.length);
    const dist = p.map((q) => q.distanceTo(c));
    const maxR = Math.max(...dist);
    // "cima" do número: meio da 1ª aresta no d6/d12; senão o vértice mais distante (ponta da pipa no d10)
    const up = shape === 6 || shape === 12
      ? p[0].clone().add(p[1]).multiplyScalar(0.5)
      : p[dist.findIndex((d) => d >= maxR - 1e-6)];
    const vAx = up.clone().sub(c).projectOnPlane(n).normalize();
    const uAx = vAx.clone().cross(n);
    const s = 0.5 / maxR;
    const start = pos.length / 3;
    for (let i = 1; i < p.length - 1; i++)
      for (const q of [p[0], p[i], p[i + 1]]) {
        pos.push(q.x, q.y, q.z);
        nor.push(n.x, n.y, n.z);
        const w = q.clone().sub(c);
        uv.push(0.5 + w.dot(uAx) * s, 0.5 + w.dot(vAx) * s);
      }
    geometry.addGroup(start, pos.length / 3 - start, fi);
  });
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  const out = { verts, faces, normals, geometry, edges: new THREE.EdgesGeometry(geometry) };
  geoCache.set(shape, out);
  return out;
}

// ---------- texturas (dado escuro, número dourado) ----------

/** Cores da caixa e dos dados; o DiceRoller passa as do tema (CSS resolvido para rgb). */
export interface DiceLook { die: string; ink: string; trim: string; floor: string; wall: string }
const LOOK: DiceLook = { die: "#211c16", ink: "#e0b45e", trim: "#d4a24e", floor: "#15151d", wall: "#2a2433" };
const FONT: Record<Shape, number> = { 4: 0.24, 6: 0.46, 8: 0.34, 10: 0.3, 12: 0.34, 20: 0.28 };
const matCache = new Map<string, THREE.MeshStandardMaterial>();

function faceMaterial(shape: Shape, texts: string[], look: DiceLook): THREE.MeshStandardMaterial {
  const key = `${shape}:${texts.join("|")}:${look.die}:${look.ink}`;
  const hit = matCache.get(key);
  if (hit) return hit;
  const W = 256;
  const cv = document.createElement("canvas");
  cv.width = cv.height = W;
  const g = cv.getContext("2d")!;
  g.fillStyle = look.die;
  g.fillRect(0, 0, W, W);
  g.fillStyle = look.ink;
  g.textAlign = "center";
  g.textBaseline = "middle";
  const fs = FONT[shape] * W;
  g.font = `700 ${fs}px Georgia, "Times New Roman", serif`;
  const draw = (t: string, x: number, y: number, rot: number) => {
    g.save();
    g.translate(x, y);
    g.rotate(rot);
    g.fillText(t, 0, 0, fs * 1.25);
    if (t === "6" || t === "9") g.fillRect(-fs * 0.22, fs * 0.42, fs * 0.44, fs * 0.07); // sublinhado: 6 ≠ 9
    g.restore();
  };
  if (shape === 4) {
    // d4: um número em cada canto, de pé para o canto (o resultado é o do vértice de cima)
    texts.forEach((t, k) => {
      const a = Math.PI / 2 + (k * 2 * Math.PI) / 3;
      const dx = Math.cos(a), dy = -Math.sin(a);
      draw(t, W / 2 + dx * W * 0.27, W / 2 + dy * W * 0.27, Math.atan2(dx, -dy));
    });
  } else draw(texts[0], W / 2, W / 2, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const m = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.42, metalness: 0.2 });
  matCache.set(key, m);
  return m;
}

const materialsFor = (spec: DieSpec, labels: string[], look: DiceLook) => {
  const { faces } = dieGeo(spec.shape);
  return faces.map((f, fi) => faceMaterial(spec.shape, spec.shape === 4 ? f.map((vi) => labels[vi]) : [labels[fi]], look));
};

// ---------- física ----------

interface Init { p: THREE.Vector3; q: THREE.Quaternion; v: THREE.Vector3; w: THREE.Vector3 }
const STEP = 1 / 120;

/** Simula até todos dormirem (máx. ~8 s); devolve os quadros a 60 fps e a orientação final. */
function simulate(specs: DieSpec[], init: Init[], half: { x: number; z: number }) {
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -60, 0) });
  world.allowSleep = true;
  const diceMat = new CANNON.Material(), floorMat = new CANNON.Material(), wallMat = new CANNON.Material();
  // mesa e paredes que devolvem bem: o dado quica e rola várias faces antes de parar
  world.addContactMaterial(new CANNON.ContactMaterial(diceMat, floorMat, { friction: 0.3, restitution: 0.65 }));
  world.addContactMaterial(new CANNON.ContactMaterial(diceMat, wallMat, { friction: 0.05, restitution: 0.85 }));
  world.addContactMaterial(new CANNON.ContactMaterial(diceMat, diceMat, { friction: 0.2, restitution: 0.45 }));
  const plane = (mat: CANNON.Material, pos: [number, number, number], euler: [number, number, number]) => {
    const b = new CANNON.Body({ mass: 0, material: mat, shape: new CANNON.Plane() });
    b.position.set(...pos);
    b.quaternion.setFromEuler(...euler);
    world.addBody(b);
  };
  plane(floorMat, [0, 0, 0], [-Math.PI / 2, 0, 0]);
  plane(wallMat, [0, 8, 0], [Math.PI / 2, 0, 0]); // tampa baixa: o dado não sobe até sair do quadro
  plane(wallMat, [-half.x, 0, 0], [0, Math.PI / 2, 0]);
  plane(wallMat, [half.x, 0, 0], [0, -Math.PI / 2, 0]);
  plane(wallMat, [0, 0, -half.z], [0, 0, 0]);
  plane(wallMat, [0, 0, half.z], [0, Math.PI, 0]);
  const bodies = specs.map((s, i) => {
    const g = dieGeo(s.shape);
    const b = new CANNON.Body({
      mass: 1,
      material: diceMat,
      shape: new CANNON.ConvexPolyhedron({ vertices: g.verts.map((p) => new CANNON.Vec3(p.x, p.y, p.z)), faces: g.faces }),
      sleepSpeedLimit: 0.5, // com pouco amortecimento o d20 fica tremendo e não dormia antes de 8 s
      sleepTimeLimit: 0.35,
      angularDamping: 0.1,
      linearDamping: 0.1,
    });
    const it = init[i];
    b.position.set(it.p.x, it.p.y, it.p.z);
    b.quaternion.set(it.q.x, it.q.y, it.q.z, it.q.w);
    b.velocity.set(it.v.x, it.v.y, it.v.z);
    b.angularVelocity.set(it.w.x, it.w.y, it.w.z);
    world.addBody(b);
    return b;
  });
  const frames: Float32Array[] = [];
  for (let n = 0; n < 8 * 120; n++) {
    world.step(STEP);
    if (n % 2) frames.push(Float32Array.from(bodies.flatMap((b) => [
      b.position.x, b.position.y, b.position.z, b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w,
    ])));
    if (bodies.every((b) => b.sleepState === CANNON.Body.SLEEPING)) break;
  }
  return { frames, final: bodies.map((b) => new THREE.Quaternion(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w)) };
}

/** Índice do rótulo que ficou em cima (vértice no d4, face nos demais) e se o dado está deitado numa face. */
function topOf(shape: Shape, q: THREE.Quaternion) {
  const g = dieGeo(shape);
  const ny = g.normals.map((n) => n.clone().applyQuaternion(q).y);
  const flat = Math.min(...ny) < -0.985;
  const ys = shape === 4 ? g.verts.map((p) => p.clone().applyQuaternion(q).y) : ny;
  return { top: ys.indexOf(Math.max(...ys)), flat };
}

// ---------- cena ----------

export function createDiceScene(
  host: HTMLElement,
  specs: DieSpec[],
  cb: { onThrow: () => void; onSettled: () => void },
  colors?: Partial<DiceLook>,
  force = 1, // "Força do arremesso" das Configurações (0,5× a 3×)
) {
  const look = { ...LOOK, ...colors };
  const w = host.clientWidth, h = host.clientHeight;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h);
  renderer.shadowMap.enabled = true;
  renderer.domElement.style.cssText = "display:block;width:100%;height:100%;touch-action:none;cursor:grab";
  host.appendChild(renderer.domElement);

  const fov = 38;
  const half = { z: 4.6, x: 4.6 * (w / h) };
  const camera = new THREE.PerspectiveCamera(fov, w / h, 0.1, 100);
  camera.position.set(0, (half.z / Math.tan(THREE.MathUtils.degToRad(fov / 2))) * 1.22, 0);
  camera.up.set(0, 0, -1);
  camera.lookAt(0, 0, 0);

  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xfff1dc, 0x1a1a24, 0.8));
  const sun = new THREE.DirectionalLight(0xffffff, 2.4);
  sun.position.set(-5, 14, 7);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  const sc = sun.shadow.camera;
  sc.left = sc.bottom = -Math.max(half.x, half.z) - 2;
  sc.right = sc.top = Math.max(half.x, half.z) + 2;
  scene.add(sun);
  const rim = new THREE.PointLight(look.trim, 30, 30);
  rim.position.set(half.x, 5, -half.z);
  scene.add(rim);

  // mesa (feltro escuro) e borda dourada marcando as paredes
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(half.x * 2, half.z * 2),
    new THREE.MeshStandardMaterial({ color: look.floor, roughness: 0.95 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  // paredes da caixa (madeira escura com friso dourado no topo)
  const wallMat = new THREE.MeshStandardMaterial({ color: look.wall, roughness: 0.7 });
  const trimMat = new THREE.LineBasicMaterial({ color: look.trim, transparent: true, opacity: 0.6 });
  const T = 0.35, H = 1.8;
  for (const [x, z, sx, sz] of [
    [-half.x - T / 2, 0, T, half.z * 2 + T * 2], [half.x + T / 2, 0, T, half.z * 2 + T * 2],
    [0, -half.z - T / 2, half.x * 2, T], [0, half.z + T / 2, half.x * 2, T],
  ]) {
    const g = new THREE.BoxGeometry(sx, H, sz);
    const wall = new THREE.Mesh(g, wallMat);
    wall.position.set(x, H / 2, z);
    wall.receiveShadow = true;
    wall.add(new THREE.LineSegments(new THREE.EdgesGeometry(g), trimMat));
    scene.add(wall);
  }

  const edgeMat = new THREE.LineBasicMaterial({ color: look.trim, transparent: true, opacity: 0.35 });
  const meshes = specs.map((s) => {
    const g = dieGeo(s.shape);
    const m = new THREE.Mesh(g.geometry, materialsFor(s, s.labels, look));
    m.castShadow = true;
    m.add(new THREE.LineSegments(g.edges, edgeMat));
    m.quaternion.random();
    scene.add(m);
    return m;
  });
  const spin = specs.map(() => new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize());

  // agrupa os dados em espiral em volta de (x, z), sempre dentro da caixa
  const gather = (x: number, z: number, y: number) =>
    meshes.forEach((m, i) => {
      const a = i * 2.4, r = 0.95 * Math.sqrt(i);
      m.position.set(
        THREE.MathUtils.clamp(x + Math.cos(a) * r, -half.x + 1.2, half.x - 1.2),
        y,
        THREE.MathUtils.clamp(z + Math.sin(a) * r, -half.z + 1.2, half.z - 1.2),
      );
    });
  gather(0, 0, 1.6);

  let state: "idle" | "holding" | "playing" | "done" = "idle";
  let frames: Float32Array[] = [];
  let playStart = 0;
  const samples: { t: number; x: number; z: number }[] = [];

  const ray = new THREE.Raycaster();
  const holdPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -2.6);
  const toWorld = (e: PointerEvent) => {
    const r = renderer.domElement.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
    return ray.ray.intersectPlane(holdPlane, new THREE.Vector3()) ?? new THREE.Vector3();
  };

  const launch = (vel: THREE.Vector3) => {
    vel.multiplyScalar(force).clampLength(0, 80); // mais rápido que isso o dado entra na parede
    const roll = new THREE.Vector3(0, 1, 0).cross(vel); // giro de quem rola para a frente
    const init: Init[] = meshes.map((m) => ({
      p: m.position.clone(),
      q: m.quaternion.clone(),
      v: vel.clone().add(new THREE.Vector3((Math.random() - 0.5) * 2, Math.random() * 2, (Math.random() - 0.5) * 2)),
      w: new THREE.Vector3(), // sorteado a cada tentativa
    }));
    // ponytail: até 6 tentativas para nenhum dado ficar inclinado/empilhado; depois usa a última
    let sim!: ReturnType<typeof simulate>;
    for (let attempt = 0; attempt < 6; attempt++) {
      init.forEach((it) => it.w.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5)
        .multiplyScalar(50 * force).add(roll).clampLength(0, 70)); // girando mais que isso ele quica até a tampa
      sim = simulate(specs, init, half);
      if (sim.final.every((q, i) => topOf(specs[i].shape, q).flat)) break;
    }
    // troca de rótulos: o que ficou em cima passa a ser o valor pedido
    specs.forEach((s, i) => {
      const labels = [...s.labels];
      const { top } = topOf(s.shape, sim.final[i]);
      const at = labels.indexOf(s.value);
      if (at >= 0) [labels[top], labels[at]] = [labels[at], labels[top]];
      else labels[top] = s.value;
      meshes[i].material = materialsFor(s, labels, look);
    });
    frames = sim.frames;
    state = "playing";
    playStart = performance.now();
    renderer.domElement.style.cursor = "default";
    cb.onThrow();
  };

  const onDown = (e: PointerEvent) => {
    if (state !== "idle") return;
    renderer.domElement.setPointerCapture(e.pointerId);
    renderer.domElement.style.cursor = "grabbing";
    state = "holding";
    const p = toWorld(e);
    samples.length = 0;
    samples.push({ t: performance.now(), x: p.x, z: p.z });
    gather(p.x, p.z, 2.6);
  };
  const onMove = (e: PointerEvent) => {
    if (state !== "holding") return;
    const p = toWorld(e);
    const t = performance.now();
    samples.push({ t, x: p.x, z: p.z });
    while (samples.length > 2 && t - samples[0].t > 120) samples.shift();
    gather(p.x, p.z, 2.6);
  };
  const onUp = () => {
    if (state !== "holding") return;
    const a = samples[0], b = samples[samples.length - 1];
    const dt = Math.max((b.t - a.t) / 1000, 0.016);
    const v = new THREE.Vector3((b.x - a.x) / dt, 0, (b.z - a.z) / dt);
    const speed = v.length();
    if (speed < 2) v.set(Math.random() - 0.5, 0, Math.random() - 0.5).normalize().multiplyScalar(20); // só um clique
    else v.multiplyScalar(THREE.MathUtils.clamp(speed, 12, 60) / speed); // arraste forte = arremesso forte
    v.y = 4;
    launch(v);
  };
  const el = renderer.domElement;
  el.addEventListener("pointerdown", onDown);
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointercancel", onUp);

  let raf = 0;
  const loop = (now: number) => {
    raf = requestAnimationFrame(loop);
    if (state === "idle" || state === "holding") {
      meshes.forEach((m, i) => m.rotateOnAxis(spin[i], state === "holding" ? 0.12 : 0.012));
    } else if (state === "playing") {
      const idx = Math.max(0, Math.min(Math.floor(((now - playStart) / 1000) * 60), frames.length - 1));
      const f = frames[idx];
      meshes.forEach((m, i) => {
        m.position.set(f[i * 7], f[i * 7 + 1], f[i * 7 + 2]);
        m.quaternion.set(f[i * 7 + 3], f[i * 7 + 4], f[i * 7 + 5], f[i * 7 + 6]);
      });
      if (idx === frames.length - 1) {
        state = "done";
        cb.onSettled();
      }
    }
    renderer.render(scene, camera);
  };
  raf = requestAnimationFrame(loop);

  return {
    /** Arremesso sem arrastar (botão/teclado): sai de baixo da caixa para cima. */
    throwRandom() {
      if (state !== "idle") return;
      gather((Math.random() - 0.5) * half.x, half.z - 1.5, 2.6);
      launch(new THREE.Vector3((Math.random() - 0.5) * 12, 4, -36));
    },
    dispose() {
      cancelAnimationFrame(raf);
      renderer.dispose();
      renderer.forceContextLoss();
      el.remove();
    },
  };
}
