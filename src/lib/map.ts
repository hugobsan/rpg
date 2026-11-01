import { q } from "./db";
import { getClock } from "./clock";
import type { ToolDef } from "./openrouter";
import type { ToolContext } from "./tools";
import type { MapPlace, SceneStage, StageActor, WorldMap } from "./types";

/**
 * Mapa do mundo (campaigns.state.map) e palco da cena (scenes.state.stage).
 * O mapa se monta sozinho: set_scene registra o local e a rota desde o anterior; o Topógrafo
 * (map_brief do Mestre) enriquece com update_map e monta o palco. As posições saem do código (dica relativa ou encaixe
 * determinístico), nunca do modelo. O "gerar novamente" volta os dois junto com o estado.
 */

// ---------- nomes e tipos ----------

const STOP = new Set("a o as os de da do das dos d em no na nos nas e um uma the of at in on".split(" "));
export const normName = (s: string) =>
  s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const words = (s: string) => normName(s).split(" ").filter((w) => w && !STOP.has(w));

// palavra do nome → tipo (vira ícone no mapa)
const KIND_WORDS: Record<string, string> = Object.fromEntries(
  Object.entries({
    cidade: "cidade capital metropole metropolis city urbe",
    vila: "vila aldeia vilarejo povoado village comunidade assentamento",
    bairro: "bairro distrito setor quarteirao district favela gueto mercado feira praca",
    predio: "predio edificio academia escola hospital biblioteca loja taverna estalagem pousada hotel bar restaurante arena estadio fabrica armazem laboratorio banco prefeitura palacio sede guilda clinica oficina tribunal prisao museu teatro cassino delegacia",
    casa: "casa residencia lar cabana apartamento mansao chale choupana barraco moradia",
    sala: "sala quarto corredor salao camara cela cozinha porao sotao gabinete escritorio enfermaria cabine",
    torre: "torre castelo fortaleza forte cidadela farol muralha",
    templo: "templo santuario igreja mosteiro catedral capela altar dojo pagode",
    floresta: "floresta bosque mata selva jardim parque pomar",
    campo: "campo planicie pradaria clareira fazenda deserto savana estepe vale prado plantacao",
    montanha: "montanha monte pico serra cordilheira colina morro vulcao penhasco desfiladeiro rochedo",
    agua: "agua rio lago mar oceano praia cachoeira porto baia lagoa pantano cais ilha riacho costa",
    caverna: "caverna gruta mina tunel esgoto catacumba subterraneo masmorra cripta toca",
    ruina: "ruina escombros destrocos cemiterio",
    estrada: "estrada caminho trilha rua avenida ponte passagem rodovia fronteira portao beco",
    base: "base quartel acampamento posto bunker estacao complexo hangar instalacao",
    nave: "nave navio barco trem veiculo dirigivel submarino espaconave cruzador fragata",
    portal: "portal fenda dimensao vortice",
    regiao: "regiao reino pais imperio provincia territorio continente planeta mundo terra",
  }).flatMap(([kind, ws]) => ws.split(" ").map((w) => [w, kind]))
);
const kindOfWord = (w: string) => KIND_WORDS[w] ?? (w.endsWith("s") ? KIND_WORDS[w.slice(0, -1)] : undefined);

/** Tipo pela primeira palavra conhecida ("Floresta da Morte" → floresta; "rio" → agua). */
export function guessKind(name: string): string | undefined {
  for (const w of words(name)) {
    const k = kindOfWord(w);
    if (k) return k;
  }
}

// ---------- busca e registro de locais ----------

export const getMap = (state?: Record<string, unknown> | null): WorldMap | null => {
  const m = state?.map as WorldMap | undefined;
  return m && Array.isArray(m.places) && Array.isArray(m.routes) ? m : null;
};

const byId = (m: WorldMap, id?: string) => (id ? m.places.find((p) => p.id === id) : undefined);

/** O local e os que o contêm, do mais específico ao mais geral (à prova de ciclo). */
function lineage(m: WorldMap, id?: string): string[] {
  const out: string[] = [];
  for (let p = byId(m, id); p && !out.includes(p.id); p = byId(m, p.parent)) out.push(p.id);
  return out;
}

/**
 * Acha o local por nome, tolerando variações: igual sem acento/artigo, ou mesma palavra
 * principal com uma lista de palavras contida na outra ("a Academia" = "Academia Ninja de
 * Konoha", mas "Konoha" ≠ "Academia de Konoha"). Empate: o local atual, depois o mais visitado.
 * Com parentId, ignora locais que estão dentro de outro lugar.
 */
export function findPlace(map: WorldMap, name: string, parentId?: string): MapPlace | undefined {
  const w = words(name);
  if (!w.length) return undefined;
  const pool = map.places.filter((p) => !parentId || !p.parent || p.parent === parentId);
  const names = (p: MapPlace) => [p.name, ...(p.aliases ?? [])].map(words);
  const key = w.join(" ");
  const exact = pool.find((p) => names(p).some((n) => n.join(" ") === key));
  if (exact) return exact;
  const within = (a: string[], b: string[]) => a.every((x) => b.includes(x));
  const hits = pool.filter((p) => names(p).some((n) => n[0] === w[0] && (within(n, w) || within(w, n))));
  return hits.find((p) => p.id === map.current) ?? hits.sort((a, b) => b.visits - a.visits)[0];
}

function addPlace(m: WorldMap, name: string, parentId?: string, now?: number, container = false): MapPlace {
  const p: MapPlace = {
    id: `l${m.places.reduce((n, x) => Math.max(n, Number(x.id.slice(1)) || 0), 0) + 1}`,
    name: name.trim().slice(0, 80),
    kind: guessKind(name) ?? (container ? "regiao" : "lugar"),
    visits: 0,
  };
  if (parentId) p.parent = parentId;
  if (now !== undefined) p.discoveredAt = now;
  m.places.push(p);
  return p;
}

/** Variação de nome vira apelido (a versão mais completa fica como nome, salvo alias); adota o pai se não tinha. */
function remember(m: WorldMap, p: MapPlace, name: string, parentId?: string, alias = false) {
  if (parentId && !p.parent && !lineage(m, parentId).includes(p.id)) p.parent = parentId;
  name = name.trim().slice(0, 80);
  const known = [p.name, ...(p.aliases ?? [])].map(normName);
  if (!name || known.includes(normName(name))) return;
  const longer = !alias && words(name).length > words(p.name).length;
  p.aliases = [...(p.aliases ?? []), longer ? p.name : name].slice(-6);
  if (longer) p.name = name;
}

/**
 * Chegada a um local (texto livre do set_scene). "Sala 3, Academia, Konoha" vira uma cadeia
 * de pais; liga uma rota desde o local anterior (menos entre um lugar e o que o contém).
 */
export function enterPlace(map: WorldMap, location: string, now?: number): { map: WorldMap; moved: boolean } {
  const parts = location.split(",").map((s) => s.trim()).filter((s) => /\p{L}/u.test(s)).reverse();
  if (!parts.length) return { map, moved: false };
  const m = structuredClone(map);
  let at: MapPlace | undefined;
  for (const [i, part] of parts.entries()) {
    const found = findPlace(m, part, at?.id);
    if (found) remember(m, found, part, at?.id);
    at = found ?? addPlace(m, part, at?.id, now, i < parts.length - 1);
  }
  if (!at) return { map, moved: false };
  const prev = m.current;
  if (at.id === prev) return { map: m, moved: false };
  at.visits++;
  // estar numa casa de Konoha é ter estado em Konoha
  for (const id of lineage(m, at.id).slice(1)) byId(m, id)!.visits ||= 1;
  const nested = prev && (lineage(m, prev).includes(at.id) || lineage(m, at.id).includes(prev));
  if (prev && !nested && !m.routes.some((r) => (r.from === prev && r.to === at.id) || (r.from === at.id && r.to === prev)))
    m.routes.push({ from: prev, to: at.id });
  m.current = at.id;
  return { map: m, moved: true };
}

/** Junta `from` em `into` (dois nomes do mesmo lugar): rotas, filhos, dicas, visitas e o local atual. */
function mergePlace(m: WorldMap, from: MapPlace, into: MapPlace) {
  const swap = (id?: string) => (id === from.id ? into.id : id);
  for (const r of m.routes) (r.from = swap(r.from)!), (r.to = swap(r.to)!);
  m.routes = m.routes.filter(
    (r, i) => r.from !== r.to && m.routes.findIndex((o) => [o.from, o.to].sort().join() === [r.from, r.to].sort().join()) === i
  );
  for (const p of m.places) {
    p.parent = swap(p.parent);
    if (p.near) p.near.of = swap(p.near.of)!;
    if (p.parent === p.id) delete p.parent;
  }
  m.current = swap(m.current);
  into.visits += from.visits;
  into.description ||= from.description;
  if (from.discoveredAt !== undefined) into.discoveredAt = Math.min(into.discoveredAt ?? Infinity, from.discoveredAt);
  for (const n of [from.name, ...(from.aliases ?? [])]) remember(m, into, n, undefined, true);
  m.places = m.places.filter((p) => p !== from);
}

function removePlace(m: WorldMap, p: MapPlace) {
  for (const o of m.places) {
    if (o.parent === p.id) o.parent = p.parent;
    if (o.near?.of === p.id) delete o.near;
  }
  m.routes = m.routes.filter((r) => r.from !== p.id && r.to !== p.id);
  if (m.current === p.id) m.current = p.parent;
  m.places = m.places.filter((o) => o !== p);
}

// ---------- posições ----------

const DIR: Record<string, [number, number]> = {
  N: [0, 1], NE: [1, 1], L: [1, 0], E: [1, 0], SE: [1, -1], S: [0, -1],
  SO: [-1, -1], SW: [-1, -1], O: [-1, 0], W: [-1, 0], NO: [-1, 1], NW: [-1, 1],
};
export const DISTANCES: Record<string, number> = { colado: 1, perto: 2.5, medio: 4.5, longe: 7.5, muito_longe: 12 };
export const MIN_GAP = 0.8; // distância mínima entre dois locais
const CHILD_RING = 1.1; // raio em volta do pai para o que está dentro dele
const NEAR_RING = 3; // raio em volta do vizinho de rota, sem dica

const has = (p: MapPlace) => Number.isFinite(p.x) && Number.isFinite(p.y);
const seedAngle = (s: string) => (([...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 360) * Math.PI) / 180;
const round = (n: number) => Math.round(n * 100) / 100;

/**
 * Preenche x/y de quem não tem; quem já tem não se mexe (mapa estável). Ordem: dica do
 * Mestre (direção + distância de outro local), em volta do pai, em volta da região do
 * vizinho de rota; em cada anel, o primeiro ponto livre a partir de um ângulo fixo pelo nome.
 * ponytail: encaixe guloso sem relaxamento de forças; basta para dezenas de locais.
 */
export function layoutMap(map: WorldMap): WorldMap {
  const m = structuredClone(map);
  const placed = (id?: string) => {
    const p = byId(m, id);
    return p && has(p) ? p : undefined;
  };
  const clear = (x: number, y: number, self: MapPlace) =>
    m.places.every((o) => o === self || !has(o) || Math.hypot(o.x! - x, o.y! - y) >= MIN_GAP);
  const free = (self: MapPlace, cx: number, cy: number, r: number): [number, number] => {
    const a0 = seedAngle(self.name);
    for (const k of [1, 1.5, 2.2, 3.2, 4.6])
      for (let i = 0; i < 12; i++) {
        const a = a0 + (i * Math.PI) / 6;
        const x = cx + Math.cos(a) * r * k, y = cy + Math.sin(a) * r * k;
        if (clear(x, y, self)) return [x, y];
      }
    return [cx + r * 6, cy];
  };
  const place = (p: MapPlace) => {
    const ref = placed(p.near?.of);
    const par = placed(p.parent);
    let pos: [number, number];
    if (ref && p.near) {
      const d = DISTANCES[p.near.dist ?? ""] ?? DISTANCES.perto;
      const [dx, dy] = DIR[(p.near.dir ?? "").toUpperCase()] ?? [0, 0];
      const len = Math.hypot(dx, dy);
      if (!len) pos = free(p, ref.x!, ref.y!, d);
      else {
        const x = ref.x! + (dx / len) * d, y = ref.y! + (dy / len) * d;
        pos = clear(x, y, p) ? [x, y] : free(p, x, y, MIN_GAP);
      }
    } else if (par) pos = free(p, par.x!, par.y!, CHILD_RING);
    else {
      const nb =
        m.routes.map((r) => (r.from === p.id ? placed(r.to) : r.to === p.id ? placed(r.from) : undefined)).find(Boolean) ??
        [...m.places].reverse().find(has);
      // em volta da região do vizinho, para não cair no meio dos lugares de dentro dela
      const root = byId(m, lineage(m, nb?.id).at(-1));
      const c = root && has(root) ? root : nb;
      pos = c ? free(p, c.x!, c.y!, NEAR_RING) : [0, 0];
    }
    p.x = round(pos[0]);
    p.y = round(pos[1]);
  };
  let pending = m.places.filter((p) => !has(p));
  while (pending.length) {
    const next =
      pending.find((p) => (p.near ? placed(p.near.of) : !p.parent || placed(p.parent))) ?? pending[0];
    place(next);
    pending = pending.filter((p) => p !== next);
  }
  return m;
}

/** Tira a posição do local e do que está dentro dele: o layout recoloca pela dica nova. */
function unplace(m: WorldMap, p: MapPlace) {
  for (const o of m.places)
    if (lineage(m, o.id).includes(p.id)) {
      delete o.x;
      delete o.y;
    }
}

// ---------- leitura e gravação ----------

/** Lista de locais (em ordem) → mapa. Campanhas antigas montam o inicial com as cenas. */
export function mapFromLocations(locations: string[]): WorldMap {
  let m: WorldMap = { places: [], routes: [] };
  for (const l of locations) m = enterPlace(m, l).map;
  return layoutMap(m);
}

/** O mapa salvo ou, em campanha antiga, montado das cenas (sem gravar: grava na próxima mudança). */
export async function loadMap(campaignId: string, state: Record<string, unknown>): Promise<WorldMap> {
  const saved = getMap(state);
  if (saved) return saved;
  const rows = await q<{ location: string }>(`SELECT location FROM scenes WHERE campaign_id = $1 ORDER BY seq`, [campaignId]);
  // a cena de abertura nasce com o ponto de partida da linha do tempo, que não é um lugar
  const start = String(state.startingPoint ?? "").slice(0, 120);
  return mapFromLocations(rows.map((r) => r.location).filter((l) => l && l !== start));
}

async function saveMap(ctx: ToolContext, map: WorldMap): Promise<WorldMap> {
  const m = layoutMap(map);
  await q(`UPDATE campaigns SET state = state || jsonb_build_object('map', $1::jsonb) WHERE id = $2`, [
    JSON.stringify(m),
    ctx.campaign.id,
  ]);
  ctx.campaign.state = { ...ctx.campaign.state, map: m };
  ctx.emit({ type: "state" });
  return m;
}

/**
 * set_scene, antes de mexer na cena: registra o local no mapa (e a rota desde o anterior).
 * Na 1ª vez grava também o mapa montado das cenas, que ainda têm o local antigo.
 * Mudou de lugar dentro da mesma cena: o palco antigo sai.
 */
export async function recordScenePlace(ctx: ToolContext, args: Record<string, unknown>): Promise<void> {
  const location = String(args.location || ctx.scene.location || "").trim();
  if (!location) return;
  const before = await loadMap(ctx.campaign.id, ctx.campaign.state);
  const { map, moved } = enterPlace(before, location, getClock(ctx.campaign.state)?.minutes);
  if (getMap(ctx.campaign.state) && JSON.stringify(map) === JSON.stringify(before)) return;
  await saveMap(ctx, map);
  if (moved && !args.newScene && getStage(ctx.scene.state)) {
    await q(`UPDATE scenes SET state = state - 'stage' WHERE id = $1`, [ctx.scene.id]);
    const { stage: _, ...rest } = ctx.scene.state;
    ctx.scene.state = rest;
  }
}

// ---------- palco da cena ----------

const DISTANCE_KEYS = ["corpo_a_corpo", "perto", "medio", "longe"] as const;
const STANCE_KEYS = ["aliado", "hostil", "neutro"] as const;

export function getStage(state?: Record<string, unknown> | null): SceneStage | null {
  const s = state?.stage as SceneStage | undefined;
  return s && Array.isArray(s.actors) && Array.isArray(s.zones) ? s : null;
}

/** set_stage: zonas substituem as anteriores; atores mudam por nome (remove tira); clear começa do zero. */
export function applyStage(stage: SceneStage | null, args: Record<string, unknown>): SceneStage | null {
  const s: SceneStage = args.clear || !stage ? { zones: [], actors: [] } : structuredClone(stage);
  const list = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]).filter((x) => x && typeof x === "object") : []);
  const text = (v: unknown, max: number) => (v === undefined ? undefined : String(v).trim().slice(0, max) || undefined);
  if (Array.isArray(args.zones))
    s.zones = list(args.zones)
      .filter((z) => text(z.name, 40))
      .slice(0, 8)
      .map((z) => ({ name: text(z.name, 40)!, note: text(z.note, 80) }));
  for (const a of list(args.actors)) {
    const name = text(a.name, 40);
    if (!name) continue;
    const i = s.actors.findIndex((x) => normName(x.name) === normName(name));
    if (a.remove) {
      if (i >= 0) s.actors.splice(i, 1);
      continue;
    }
    const prev: Partial<StageActor> = i >= 0 ? s.actors[i] : {};
    const next: StageActor = {
      name,
      zone: a.zone !== undefined ? text(a.zone, 40) : prev.zone,
      distance: DISTANCE_KEYS.find((k) => k === a.distance) ?? prev.distance ?? "medio",
      stance: STANCE_KEYS.find((k) => k === a.stance) ?? prev.stance ?? "neutro",
      cover: a.cover === "parcial" || a.cover === "total" ? a.cover : a.cover === "nenhuma" ? undefined : prev.cover,
      elevated: typeof a.elevated === "boolean" ? a.elevated || undefined : prev.elevated,
      note: a.note !== undefined ? text(a.note, 80) : prev.note,
    };
    if (i >= 0) s.actors[i] = next;
    else if (s.actors.length < 24) s.actors.push(next);
  }
  return s.zones.length || s.actors.length ? s : null;
}

export function stageText(s: SceneStage): string {
  const zones = s.zones.map((z) => (z.note ? `${z.name} (${z.note})` : z.name)).join("; ");
  const actors = s.actors
    .map(
      (a) =>
        `${a.name}: ${[a.stance, a.distance.replace(/_/g, " "), a.zone, a.cover && `cobertura ${a.cover}`, a.elevated && "elevado", a.note]
          .filter(Boolean)
          .join(", ")}`
    )
    .join(" | ");
  return [zones && `Zonas: ${zones}`, actors && `Posições (distância até o jogador): ${actors}`].filter(Boolean).join("\n");
}

// ---------- contexto do Mestre ----------

const DIR8 = ["N", "NE", "L", "SE", "S", "SO", "O", "NO"];
/** "NE, perto" de `a` até `b`, pelas posições do mapa. */
export function relation(a: MapPlace, b: MapPlace): string {
  if (b.parent === a.id) return "dentro daqui";
  if (!has(a) || !has(b)) return "";
  const dx = b.x! - a.x!, dy = b.y! - a.y!;
  const d = Math.hypot(dx, dy);
  const dir = DIR8[Math.round(((Math.atan2(dx, dy) * 180) / Math.PI + 360) / 45) % 8];
  return `${dir}, ${d < 1.6 ? "colado" : d < 3.6 ? "perto" : d < 6 ? "médio" : d < 10 ? "longe" : "muito longe"}`;
}

/** Onde o jogador está e as rotas daqui; com others, também os N locais conhecidos mais perto (o Topógrafo usa). */
export function placeLines(map: WorldMap, others = 0): string[] {
  const lines: string[] = [];
  const here = byId(map, map.current);
  if (here) {
    const parent = byId(map, here.parent);
    lines.push(
      `Aqui: ${here.name} (${here.kind}${parent ? `, em ${parent.name}` : ""})${here.description ? `: ${here.description}` : ""}`
    );
    const linked = new Set([here.id, here.parent]);
    const routes = map.routes
      .filter((r) => r.from === here.id || r.to === here.id)
      .map((r) => {
        const o = byId(map, r.from === here.id ? r.to : r.from);
        if (!o) return "";
        linked.add(o.id);
        return `${o.name} (${[relation(here, o), r.travel, r.label].filter(Boolean).join(", ")})`;
      })
      .filter(Boolean);
    if (routes.length) lines.push(`Rotas daqui: ${routes.join("; ")}`);
    const dist = (p: MapPlace) => (has(p) && has(here) ? Math.hypot(p.x! - here.x!, p.y! - here.y!) : 99);
    const near = map.places
      .filter((p) => !linked.has(p.id))
      .sort((a, b) => dist(a) - dist(b))
      .slice(0, others)
      .map((p) => `${p.name} (${[p.kind, relation(here, p)].filter(Boolean).join(", ")})`);
    if (near.length) lines.push(`Outros locais conhecidos: ${near.join("; ")}`);
  }
  return lines;
}

/** Bloco curto do contexto do Mestre: local, rotas daqui e o palco. Mudar mapa ou palco é com o Topógrafo (map_brief). */
export function mapPromptBlock(map: WorldMap, stage: SceneStage | null, mode: string): string {
  const lines = placeLines(map);
  if (stage) lines.push(`Palco da cena:\n${stageText(stage)}`);
  else if (mode === "battle")
    lines.push("BATALHA SEM PALCO: mande map_brief neste turno com as zonas do lugar e onde cada combatente está.");
  return lines.length
    ? `\n--- MAPA E PALCO (o jogador vê; mantenha a coerência espacial; mudanças por map_brief) ---\n${lines.join("\n")}`
    : "";
}

// ---------- ferramentas do Topógrafo (e do Mestre fora do jogo) ----------

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });

export const MAP_TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "update_map",
      description:
        "Enriquece o mapa do mundo (3D para o jogador). Os locais visitados já entram pelo set_scene; use para detalhar um local (tipo, descrição, parent, outros nomes, posição e rota a partir de outro) ou registrar um conhecido e não visitado. Um local por chamada.",
      parameters: obj(
        {
          place: { type: "string", description: "nome do local (cria se não existir)" },
          kind: {
            type: "string",
            description:
              "tipo, de preferência um destes (vira o ícone): cidade, vila, bairro, predio, casa, sala, torre, templo, floresta, campo, montanha, agua, caverna, ruina, estrada, base, nave, portal, regiao",
          },
          description: { type: "string", description: "uma frase" },
          parent: { type: "string", description: "local que contém este (o prédio de uma sala, a cidade de um prédio)" },
          aka: {
            type: "array",
            items: { type: "string" },
            description: "outros nomes do mesmo lugar; se algum já estiver no mapa como outro local, os dois viram um só",
          },
          from: { type: "string", description: "local de referência para direction/distance e para a rota" },
          direction: { type: "string", enum: ["N", "NE", "L", "SE", "S", "SO", "O", "NO"], description: "para que lado de from fica place" },
          distance: { type: "string", enum: ["colado", "perto", "medio", "longe", "muito_longe"] },
          route: { type: "string", description: "liga from e place por uma rota com este rótulo (ex.: 'estrada do norte', 'túnel secreto')" },
          travel: { type: "string", description: "tempo de viagem entre from e place (ex.: '20 min a pé', '2 dias de barco'); também liga a rota" },
          remove: { type: "boolean", description: "tira do mapa um local registrado por engano" },
        },
        ["place"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "set_stage",
      description:
        "Palco da cena (o jogador vê no mapa): zonas do lugar e onde cada personagem está em relação ao jogador. ESSENCIAL EM BATALHA: monte no começo e atualize a cada movimento relevante, para alcance e posição ficarem coerentes entre turnos. Fora de batalha, só quando a disposição importar (emboscada, perseguição). Muda só os atores informados; o jogador é o centro (inclua-o só para zona ou cobertura); clear=true quando acabar.",
      parameters: obj({
        zones: {
          type: "array",
          description: "substitui as zonas: 2 a 6 áreas do lugar (ex.: 'ponte', 'margem norte', 'telhado')",
          items: obj({ name: { type: "string" }, note: { type: "string", description: "terreno: cobertura, elevação, perigo" } }, ["name"]),
        },
        actors: {
          type: "array",
          items: obj(
            {
              name: { type: "string", description: "nome do personagem ou do inimigo (ex.: 'Bandido 1')" },
              zone: { type: "string" },
              distance: { type: "string", enum: [...DISTANCE_KEYS], description: "até o jogador" },
              stance: { type: "string", enum: [...STANCE_KEYS] },
              cover: { type: "string", enum: ["nenhuma", "parcial", "total"] },
              elevated: { type: "boolean" },
              note: { type: "string", description: "estado curto: caído, escondido, atordoado" },
              remove: { type: "boolean", description: "saiu do palco (fugiu, morreu, foi embora)" },
            },
            ["name"]
          ),
        },
        clear: { type: "boolean", description: "começa do zero (sem o resto, limpa o palco)" },
      }),
    },
  },
];

/** Executa update_map / set_stage. */
export async function executeMapTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  if (name === "set_stage") {
    const stage = applyStage(getStage(ctx.scene.state), args);
    if (stage) {
      await q(`UPDATE scenes SET state = state || jsonb_build_object('stage', $1::jsonb) WHERE id = $2`, [
        JSON.stringify(stage),
        ctx.scene.id,
      ]);
      ctx.scene.state = { ...ctx.scene.state, stage };
    } else {
      await q(`UPDATE scenes SET state = state - 'stage' WHERE id = $1`, [ctx.scene.id]);
      const { stage: _, ...rest } = ctx.scene.state;
      ctx.scene.state = rest;
    }
    ctx.emit({ type: "scene", scene: ctx.scene });
    const count = (k: string) => stage?.actors.filter((a) => a.stance === k).length ?? 0;
    const parts = [count("hostil") && `${count("hostil")} hostil(is)`, count("aliado") && `${count("aliado")} aliado(s)`].filter(Boolean);
    ctx.emit({ type: "tool", name, summary: stage ? `⚔ Palco${parts.length ? `: ${parts.join(" · ")}` : ""}` : "⚔ Palco limpo" });
    return stage ? `Palco atualizado.\n${stageText(stage)}` : "Palco limpo.";
  }

  const m = structuredClone(await loadMap(ctx.campaign.id, ctx.campaign.state));
  const name_ = String(args.place ?? "").trim();
  if (!name_) return "Informe place.";
  const now = getClock(ctx.campaign.state)?.minutes;
  const p = findPlace(m, name_) ?? addPlace(m, name_, undefined, now);
  if (args.remove) {
    removePlace(m, p);
    await saveMap(ctx, m);
    ctx.emit({ type: "tool", name, summary: `🗺 ${p.name} saiu do mapa` });
    return `"${p.name}" saiu do mapa.`;
  }
  remember(m, p, name_);
  for (const alt of Array.isArray(args.aka) ? args.aka.map(String) : []) {
    const other = findPlace(m, alt);
    if (other && other !== p) mergePlace(m, other, p);
    remember(m, p, alt, undefined, true);
  }
  let move = false;
  if (args.parent) {
    const par = findPlace(m, String(args.parent)) ?? addPlace(m, String(args.parent), undefined, now, true);
    if (par.id !== p.parent && !lineage(m, par.id).includes(p.id)) {
      p.parent = par.id;
      move = !p.near;
    }
  }
  if (args.kind) p.kind = guessKind(String(args.kind)) ?? (normName(String(args.kind)) || p.kind);
  if (args.description) p.description = String(args.description).trim().slice(0, 200);
  if (args.from) {
    const from = findPlace(m, String(args.from)) ?? addPlace(m, String(args.from), undefined, now);
    if (from.id !== p.id) {
      if (args.direction || args.distance) {
        p.near = { of: from.id, dir: args.direction ? String(args.direction) : undefined, dist: args.distance ? String(args.distance) : undefined };
        move = true;
      }
      if (args.route || args.travel) {
        let r = m.routes.find((x) => (x.from === from.id && x.to === p.id) || (x.from === p.id && x.to === from.id));
        if (!r) m.routes.push((r = { from: from.id, to: p.id }));
        if (args.route) r.label = String(args.route).slice(0, 60);
        if (args.travel) r.travel = String(args.travel).slice(0, 40);
      }
    }
  }
  if (move) unplace(m, p);
  const saved = await saveMap(ctx, m);
  const here = byId(saved, saved.current);
  const at = byId(saved, p.id)!;
  const par = byId(saved, at.parent);
  ctx.emit({ type: "tool", name, summary: `🗺 ${at.name}` });
  return `Mapa: ${at.name} (${at.kind}${par ? `, em ${par.name}` : ""})${here && here !== at ? ` — a partir daqui: ${relation(here, at) || "?"}` : ""}.`;
}
