/**
 * Mapa 3D de um local (Cartógrafo): descrição declarativa em JSON, nunca código.
 * normalizeSpec valida e limita o que o modelo devolve (contagens, faixas, cores); expandSpec
 * abre peças e repetições em primitivas absolutas para o 3D e o 2D; groundHeight dá o relevo.
 * Puro, sem banco: roda no servidor, no navegador e no check (scripts/cartographer-check.ts).
 *
 * Coordenadas em metros: centro do terreno em (0,0), x para o leste, z para o SUL, y para cima.
 * O y de itens e POIs é ACIMA DO TERRENO naquele ponto (o relevo é somado aqui). `at` de uma
 * primitiva é o centro da base. Rotação em graus, ordem YXZ (o giro de uma peça soma no y).
 */

export const SHAPES = ["box", "cylinder", "cone", "sphere", "dome", "pyramid", "torus", "extrude"] as const;
export type Shape = (typeof SHAPES)[number];
/** Cores do tema da mesa que o spec pode usar no lugar de hex (resolvidas no render). */
export const THEME_COLORS = ["accent", "accent2", "danger", "ok", "info", "warn"] as const;

type V2 = [number, number];
type V3 = [number, number, number];

export interface Prim {
  shape: Shape;
  at: V3;
  size: V3; // extrude: escala do contorno em x/z e a altura em y
  rot: V3;
  color: string;
  colors?: string[]; // variação: cada instância sorteia uma
  glow: number;
  opacity: number;
  rough: number;
  metal: number;
  points?: V2[]; // extrude: contorno da base, relativo a `at`
}
type Look = Omit<Prim, "at" | "rot">;
export interface MapItem {
  part?: string[]; // peças de spec.parts (uma por instância, sorteada); sem elas, `look` é a primitiva
  look?: Look;
  at: V3;
  rot: V3;
  scale: number;
  row?: { from: V2; to: V2; n: number };
  scatter?: { at: V2; size?: V2; radius?: number; n: number; seed: number };
}
export interface MapArea { at: V2; size: V2; round: boolean; color: string; water: boolean; glow: number }
export interface MapPath { points: V2[]; width: number; height: number; color: string; water: boolean } // height > 0: muro
export interface MapHill { at: V2; radius: number; height: number } // height < 0: vale
export interface MapPoi { name: string; note: string; at: V3 }
export interface MapSpec {
  title: string;
  size: number; // lado do terreno quadrado
  ground: { color: string; relief: number; hills: MapHill[]; heights?: number[][] }; // heights: linhas de norte a sul
  sky: { color: string; fog: number; light: string; indoor: boolean }; // indoor: sem dia/noite
  areas: MapArea[];
  paths: MapPath[];
  parts: Record<string, Prim[]>;
  items: MapItem[];
  pois: MapPoi[];
}

/** Mapa 3D de um local, como a tela e o Mestre o veem (sem o spec, que vem por /maps?map=id). */
export interface LocalMapInfo {
  id: number;
  placeId: string; // id do local em campaigns.state.map, já resolvido
  name: string;
  updatedAt: string;
  pois: string[];
}

export const LIMITS = {
  size: [16, 240],
  grid: 32, // heightmap até 32 x 32
  hills: 24,
  parts: 16,
  partPrims: 16,
  items: 260,
  repeat: 120, // n de uma fileira ou espalhamento
  prims: 3000, // depois de expandir
  extrudes: 80, // contornos extrudados depois de expandir (malha própria cada)
  outline: 24, // pontos de um contorno
  areas: 24,
  paths: 20,
  pathPoints: 32,
  pois: 16,
  rawChars: 120_000,
} as const;

// ---------- validação ----------

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const list = (v: unknown, max: number) => (Array.isArray(v) ? v.slice(0, max) : []);
const num = (v: unknown, lo: number, hi: number, d: number) => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
const r2 = (n: number) => Math.round(n * 100) / 100;
const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const isColor = (v: unknown): v is string =>
  typeof v === "string" && (HEX.test(v.trim()) || (THEME_COLORS as readonly string[]).includes(v.trim().toLowerCase()));
const color = (v: unknown, d: string) => (isColor(v) ? v.trim().toLowerCase() : d);

/** Valida e limita o JSON do Cartógrafo. null = nada desenhável (ou não é um mapa). */
export function normalizeSpec(raw: unknown): MapSpec | null {
  if (!isObj(raw)) return null;
  const size = r2(num(raw.size, LIMITS.size[0], LIMITS.size[1], 60));
  const H = size * 0.6; // alcance de x/z (um pouco além da borda, para o que encosta nela)
  const xz = (v: unknown, lim = H, d: V2 = [0, 0]): V2 => {
    const a = Array.isArray(v) ? v : [];
    return [r2(num(a[0], -lim, lim, d[0])), r2(num(a[1], -lim, lim, d[1]))];
  };
  const xyz = (v: unknown, local = false): V3 => {
    const a = Array.isArray(v) ? v : [];
    const lim = local ? size : H; // dentro de uma peça vale o tamanho todo
    return [r2(num(a[0], -lim, lim, 0)), r2(num(a[1], -size * 0.3, size, 0)), r2(num(a[2], -lim, lim, 0))];
  };
  const rot = (v: unknown): V3 =>
    Array.isArray(v) ? [r2(num(v[0], -360, 360, 0)), r2(num(v[1], -360, 360, 0)), r2(num(v[2], -360, 360, 0))] : [0, r2(num(v, -360, 360, 0)), 0];
  const look = (o: Record<string, unknown>): Look | null => {
    const shape = SHAPES.find((s) => s === o.shape);
    if (!shape) return null;
    const cs = Array.isArray(o.color) ? o.color.filter(isColor).slice(0, 6).map((c) => c.trim().toLowerCase()) : [];
    const l: Look = {
      shape,
      size: [1, 1, 1],
      color: cs[0] ?? color(o.color, "#9a948a"),
      glow: r2(num(o.glow, 0, 1, 0)),
      opacity: r2(num(o.opacity, 0.15, 1, 1)),
      rough: r2(num(o.rough, 0, 1, 0.85)),
      metal: r2(num(o.metal, 0, 1, 0.05)),
    };
    if (cs.length > 1) l.colors = cs;
    const s = Array.isArray(o.size) ? o.size : [o.size, o.size, o.size];
    if (shape === "extrude") {
      l.points = list(o.points, LIMITS.outline).map((p) => xz(p, size));
      if (l.points.length < 3) return null;
      l.size = [1, r2(num(o.height ?? s[1], 0.05, size, 3)), 1]; // o contorno já está em metros
    } else {
      const dim = (i: number) => r2(num(s[i] ?? s[0], 0.05, size, 1));
      l.size = [dim(0), dim(1), dim(2)];
    }
    return l;
  };
  const prim = (o: unknown, local = false): Prim | null => {
    if (!isObj(o)) return null;
    const l = look(o);
    return l && { ...l, at: xyz(o.at, local), rot: rot(o.rot) };
  };

  const parts: Record<string, Prim[]> = {};
  if (isObj(raw.parts))
    for (const [k, v] of Object.entries(raw.parts).slice(0, LIMITS.parts)) {
      const name = text(k, 32);
      const ps = list(v, LIMITS.partPrims).map((p) => prim(p, true)).filter((p): p is Prim => !!p);
      if (name && ps.length) parts[name] = ps;
    }

  const items: MapItem[] = [];
  for (const o of list(raw.items, LIMITS.items)) {
    if (!isObj(o)) continue;
    const part = ([] as unknown[]).concat(o.part ?? []).filter((p): p is string => typeof p === "string" && !!parts[p]).slice(0, 6);
    const l = part.length ? undefined : look(o);
    if (!part.length && !l) continue;
    const it: MapItem = { at: xyz(o.at), rot: rot(o.rot), scale: r2(num(o.scale, 0.1, 10, 1)) };
    if (part.length) it.part = part;
    else it.look = l!;
    const n = (v: unknown) => Math.round(num(v, 1, LIMITS.repeat, 1));
    if (isObj(o.row)) it.row = { from: xz(o.row.from), to: xz(o.row.to), n: n(o.row.n) };
    else if (isObj(o.scatter)) {
      const s = o.scatter;
      const radius = s.radius !== undefined ? r2(num(s.radius, 0.5, size, 10)) : undefined;
      const box = radius ? undefined : (xz(s.size, size, [10, 10]).map((d) => Math.abs(d) || 1) as V2);
      const area = radius ? Math.PI * radius * radius : box![0] * box![1];
      // densidade = instâncias por 100 m²
      const count = s.n !== undefined ? n(s.n) : n(Math.round((num(s.density, 0, 100, 1) * area) / 100));
      it.scatter = { at: xz(s.at), n: count, seed: Math.round(num(s.seed, 0, 1e6, 1)) };
      if (radius) it.scatter.radius = radius;
      else it.scatter.size = box;
    }
    items.push(it);
  }

  const areas: MapArea[] = list(raw.areas, LIMITS.areas)
    .filter(isObj)
    .map((a) => ({
      at: xz(a.at),
      size: xz(a.size, size, [10, 10]).map((d) => Math.abs(d) || 1) as V2,
      round: a.round === true,
      color: color(a.color, a.water ? "#3f7fb5" : "#8a8170"),
      water: a.water === true,
      glow: r2(num(a.glow, 0, 1, 0)),
    }));
  const paths: MapPath[] = list(raw.paths, LIMITS.paths)
    .filter(isObj)
    .map((p) => ({
      points: list(p.points, LIMITS.pathPoints).map((x) => xz(x)),
      width: r2(num(p.width, 0.2, size / 4, 3)),
      height: r2(num(p.height, 0, size / 3, 0)),
      color: color(p.color, p.water ? "#3f7fb5" : "#a89878"),
      water: p.water === true,
    }))
    .filter((p) => p.points.length >= 2);
  const pois: MapPoi[] = list(raw.pois, LIMITS.pois)
    .filter(isObj)
    .map((p) => ({ name: text(p.name, 48), note: text(p.note ?? p.description, 220), at: xyz(p.at) }))
    .filter((p) => p.name);

  if (!items.length && !areas.length && !paths.length) return null;
  const g = isObj(raw.ground) ? raw.ground : {};
  const sky = isObj(raw.sky) ? raw.sky : {};
  const hills = list(g.hills, LIMITS.hills)
    .filter(isObj)
    .map((h) => ({ at: xz(h.at), radius: r2(num(h.radius, 1, size, 10)), height: r2(num(h.height, -size * 0.3, size * 0.5, 3)) }));
  // heightmap: linhas de norte (z = -size/2) a sul, colunas de oeste a leste; todas com o tamanho da 1ª
  const rows = list(g.heights, LIMITS.grid).filter(Array.isArray) as unknown[][];
  const cols = Math.min(rows[0]?.length ?? 0, LIMITS.grid);
  const heights =
    rows.length >= 2 && cols >= 2 ? rows.map((r) => Array.from({ length: cols }, (_, i) => r2(num(r[i], -size * 0.3, size * 0.5, 0)))) : undefined;
  const ground: MapSpec["ground"] = { color: color(g.color, "#6f7a5c"), relief: r2(num(g.relief, 0, 1, 0.2)), hills };
  if (heights) ground.heights = heights;
  return {
    title: text(raw.title, 80) || "Mapa",
    size,
    ground,
    sky: { color: color(sky.color, "#9fb8d0"), fog: r2(num(sky.fog, 0, 1, 0.2)), light: color(sky.light, "#fff4e0"), indoor: sky.indoor === true },
    areas,
    paths,
    parts,
    items,
    pois,
  };
}

/** Tira o JSON da resposta do modelo (com ou sem cerca de markdown, com texto em volta). */
export function parseSpecText(content: string): MapSpec | null {
  const s = content.slice(0, LIMITS.rawChars * 2);
  const i = s.indexOf("{"), j = s.lastIndexOf("}");
  if (i < 0 || j <= i || j - i > LIMITS.rawChars) return null;
  try {
    return normalizeSpec(JSON.parse(s.slice(i, j + 1)));
  } catch {
    return null;
  }
}

/** O spec sem os valores que o normalizeSpec preenche sozinho: metade do tamanho para mandar ao modelo numa edição. */
export function compactSpec(spec: MapSpec): Record<string, unknown> {
  const on = (v: number[]) => v.some(Boolean);
  const rot = (r: V3) => (r[0] || r[2] ? r : r[1]);
  const look = (l: Look) => ({
    shape: l.shape,
    ...(l.points ? { points: l.points, height: l.size[1] } : { size: l.size }),
    color: l.colors ?? l.color,
    ...(l.glow ? { glow: l.glow } : {}),
    ...(l.opacity !== 1 ? { opacity: l.opacity } : {}),
    ...(l.rough !== 0.85 ? { rough: l.rough } : {}),
    ...(l.metal !== 0.05 ? { metal: l.metal } : {}),
  });
  const prim = (p: Prim) => ({ ...look(p), ...(on(p.at) ? { at: p.at } : {}), ...(on(p.rot) ? { rot: rot(p.rot) } : {}) });
  return {
    title: spec.title,
    size: spec.size,
    ground: { ...spec.ground, ...(spec.ground.hills.length ? {} : { hills: undefined }) },
    sky: spec.sky,
    areas: spec.areas.map(({ round, water, glow, ...a }) => ({ ...a, ...(round ? { round } : {}), ...(water ? { water } : {}), ...(glow ? { glow } : {}) })),
    paths: spec.paths.map(({ height, water, ...p }) => ({ ...p, ...(height ? { height } : {}), ...(water ? { water } : {}) })),
    parts: Object.fromEntries(Object.entries(spec.parts).map(([k, ps]) => [k, ps.map(prim)])),
    items: spec.items.map((it) => ({
      ...(it.part ? { part: it.part.length === 1 ? it.part[0] : it.part } : look(it.look!)),
      ...(on(it.at) ? { at: it.at } : {}),
      ...(on(it.rot) ? { rot: rot(it.rot) } : {}),
      ...(it.scale !== 1 ? { scale: it.scale } : {}),
      ...(it.row ? { row: it.row } : {}),
      ...(it.scatter ? { scatter: it.scatter } : {}),
    })),
    pois: spec.pois,
  };
}

// ---------- relevo ----------

const smooth = (x: number, a: number, b: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const noise = (x: number, z: number) =>
  Math.sin(x * 0.9 + 1.3) * Math.cos(z * 0.7 - 0.4) * 0.5 + Math.sin(x * 2.1 + z * 1.7) * 0.22 + Math.cos(x * 0.35 - z * 0.5) * 0.4;

/** Altura do terreno em (x, z): heightmap (bilinear) + colinas/vales + morros de borda (relief). */
export function groundHeight(spec: MapSpec, x: number, z: number): number {
  const { size, ground: g } = spec;
  const half = size / 2;
  let h = 0;
  const H = g.heights;
  if (H) {
    const R = H.length, C = H[0].length;
    const fx = Math.min(1, Math.max(0, (x + half) / size)) * (C - 1);
    const fz = Math.min(1, Math.max(0, (z + half) / size)) * (R - 1);
    const i = Math.min(Math.floor(fz), R - 2), j = Math.min(Math.floor(fx), C - 2);
    const u = fx - j, v = fz - i;
    h += (H[i][j] * (1 - u) + H[i][j + 1] * u) * (1 - v) + (H[i + 1][j] * (1 - u) + H[i + 1][j + 1] * u) * v;
  }
  for (const k of g.hills) {
    const d = Math.hypot(x - k.at[0], z - k.at[1]);
    if (d < k.radius) h += k.height * (0.5 + 0.5 * Math.cos((Math.PI * d) / k.radius));
  }
  if (g.relief) h += Math.max(0, noise((x * 9) / size, (z * 9) / size) + 0.6) * g.relief * size * 0.07 * smooth(Math.max(Math.abs(x), Math.abs(z)) / half, 0.6, 0.98);
  return h;
}

// ---------- expansão ----------

const rng = (seed: number) => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);

/** Primitivas absolutas (y já com o relevo), na ordem dos itens, até LIMITS.prims (e LIMITS.extrudes contornos). */
export function expandSpec(spec: MapSpec): Prim[] {
  const out: Prim[] = [];
  let extrudes = 0;
  const pickColor = rng(97);
  const place = (it: MapItem, x: number, z: number, ry: number, k: number, r: () => number) => {
    // peça gira só em torno de y; primitiva solta guarda a inclinação (x, z) dela
    const ps = it.part
      ? spec.parts[it.part[Math.floor(r() * it.part.length)]] ?? []
      : [{ ...it.look!, at: [0, 0, 0] as V3, rot: [it.rot[0], 0, it.rot[2]] as V3 }];
    const y0 = it.at[1] + groundHeight(spec, x, z);
    const a = (ry * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    for (const p of ps) {
      if (out.length >= LIMITS.prims) return;
      if (p.shape === "extrude" && ++extrudes > LIMITS.extrudes) continue;
      const [px, py, pz] = p.at.map((v) => v * k);
      const { colors, ...rest } = p;
      // giro em torno de y (sentido do three: x' = x cos + z sin, z' = -x sin + z cos)
      out.push({
        ...rest,
        color: colors ? colors[Math.floor(pickColor() * colors.length)] : p.color,
        at: [r2(x + px * c + pz * s), r2(y0 + py), r2(z - px * s + pz * c)],
        size: p.size.map((v) => r2(v * k)) as V3,
        rot: [p.rot[0], r2(p.rot[1] + ry), p.rot[2]],
      });
    }
  };
  spec.items.forEach((it, idx) => {
    if (out.length >= LIMITS.prims) return;
    const r = rng(idx * 7919 + 1 + (it.scatter?.seed ?? 0) * 104729);
    if (it.row) {
      const { from, to, n } = it.row;
      for (let i = 0; i < n; i++) {
        const t = n === 1 ? 0.5 : i / (n - 1);
        place(it, from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, it.rot[1], it.scale, r);
      }
    } else if (it.scatter) {
      const { at, size, radius, n } = it.scatter;
      for (let i = 0; i < n; i++) {
        let dx: number, dz: number;
        if (radius) {
          const a = r() * Math.PI * 2, d = Math.sqrt(r()) * radius;
          dx = Math.cos(a) * d;
          dz = Math.sin(a) * d;
        } else {
          dx = (r() - 0.5) * size![0];
          dz = (r() - 0.5) * size![1];
        }
        place(it, at[0] + dx, at[1] + dz, it.rot[1] + r() * 360, it.scale * (0.8 + r() * 0.4), r);
      }
    } else place(it, it.at[0], it.at[2], it.rot[1], it.scale, r);
  });
  return out;
}
