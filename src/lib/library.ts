import { q } from "./db";
import { getAgent } from "./agents";
import { chat } from "./openrouter";
import { startJob } from "./jobs";
import { costsByRankText } from "./ruleset";
import { DEFAULT_MASTERY_BONUS } from "./progression";
import type { Campaign, LibraryAbility, LibraryEntry, LibraryItem, LibraryKind, Ruleset, Sheet } from "./types";

/**
 * Biblioteca da campanha (tabela library): habilidades e itens do mundo/cânone.
 * Quem preenche: o Criador de habilidades e o Criador de itens (agentes `abilities` e `items`),
 * em lote no segundo plano (generateLibrary) ou uma técnica por vez quando o Mestre registra
 * uma que ainda não existe (ensureAbility). Fonte para o Mestre e o Criador de personagens.
 */

export async function listLibrary(
  campaignId: string,
  kind: LibraryKind,
  opts: { query?: string; limit?: number } = {}
): Promise<LibraryEntry[]> {
  // a busca olha o nome e o texto (descrição, efeito, quem usa); o nome que bate vem antes
  const rows = await q<LibraryEntry & { id: string }>(
    `SELECT id, kind, name, data, canon, source FROM library
      WHERE campaign_id = $1 AND kind = $2 AND ($3::text IS NULL OR name ILIKE '%' || $3 || '%' OR data::text ILIKE '%' || $3 || '%')
      ORDER BY ($3::text IS NOT NULL AND name ILIKE '%' || $3 || '%') DESC, name LIMIT $4`,
    [campaignId, kind, opts.query?.trim() || null, opts.limit ?? 500]
  );
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}

export async function findLibrary(campaignId: string, kind: LibraryKind, name: string): Promise<LibraryEntry | null> {
  const [r] = await q<LibraryEntry & { id: string }>(
    `SELECT id, kind, name, data, canon, source FROM library WHERE campaign_id = $1 AND kind = $2 AND lower(name) = lower($3)`,
    [campaignId, kind, name.trim()]
  );
  return r ? { ...r, id: Number(r.id) } : null;
}

/** Grava uma entrada; false se o nome já existe (índice único por nome). */
async function saveLibrary(campaignId: string, kind: LibraryKind, data: LibraryAbility | LibraryItem, canon: boolean, source: "agent" | "gm" = "agent"): Promise<boolean> {
  const rows = await q(
    `INSERT INTO library (campaign_id, kind, name, data, canon, source) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT DO NOTHING RETURNING id`,
    [campaignId, kind, data.name, JSON.stringify(data), canon, source]
  );
  return rows.length > 0;
}

/**
 * Copia para a biblioteca, sem IA, as habilidades que já estão nas fichas (jogador e NPCs), com
 * quem usa cada uma. As que já existem na biblioteca ficam como estão.
 */
export async function importSheetAbilities(campaign: Campaign): Promise<{ added: string[]; total: number }> {
  const chars = await q<{ name: string; canon: boolean; sheet: Sheet }>(
    `SELECT name, canon, sheet FROM characters WHERE campaign_id = $1 ORDER BY canon DESC, kind DESC, name`,
    [campaign.id]
  );
  const seen = new Map<string, { data: LibraryAbility; users: string[]; canon: boolean }>();
  for (const c of chars)
    for (const a of c.sheet?.abilities ?? []) {
      const data = normalizeAbility(campaign.ruleset, a);
      if (!data) continue;
      const e = seen.get(data.name.toLowerCase()) ?? { data, users: [], canon: false };
      e.users.push(c.name);
      e.canon ||= c.canon;
      seen.set(data.name.toLowerCase(), e);
    }
  const added: string[] = [];
  for (const { data, users, canon } of seen.values())
    if (await saveLibrary(campaign.id, "ability", { ...data, users: data.users || users.join(", ") }, canon, "gm")) added.push(data.name);
  return { added, total: seen.size };
}

export async function deleteLibrary(campaignId: string, id: number): Promise<boolean> {
  return (await q(`DELETE FROM library WHERE campaign_id = $1 AND id = $2 RETURNING id`, [campaignId, id])).length > 0;
}

/** Descrição de inventário de um item da biblioteca. */
export const itemText = (i: LibraryItem) => [i.description, i.effect, i.damage && `Dano ${i.damage}.`].filter(Boolean).join(" ");

/** Uma linha por entrada para o Mestre (search_library). */
export function libraryLine(r: Ruleset, e: LibraryEntry): string {
  const d = e.data as LibraryAbility & LibraryItem;
  const cost = d.cost
    ? `custo ${d.cost.amount} ${d.cost.resource}`
    : d.rank && r.abilityCosts?.byRank[d.rank] !== undefined && e.kind === "ability"
      ? `custo ${r.abilityCosts.byRank[d.rank]} ${r.abilityCosts.resource}`
      : "";
  const bits = [d.type ?? d.category, d.rank && `rank ${d.rank}`, cost, d.damage && `dano ${d.damage}`, !e.canon && "original"].filter(Boolean);
  return [`${e.name} [${bits.join(", ")}]`, d.effect || d.description, d.requirements && `requisitos: ${d.requirements}`, d.users && `usuários: ${d.users}`]
    .filter(Boolean)
    .join(" — ");
}

// ---------- validação da saída do Criador ----------

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
const str = (v: unknown, max = 600) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const compact = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/** key da lista que bate com v pela key ou pelo nome (sem acento nem caixa). */
export function pickKey(list: { key: string; label: string }[], v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const f = fold(v);
  return list.find((x) => fold(x.key) === f || fold(x.label) === f)?.key;
}
const pickRank = (r: Ruleset, v: unknown) => (typeof v === "string" ? r.abilityRanks.find((k) => fold(k) === fold(v)) : undefined);
/** mesma notação que rollDice aceita: "2d6", "d8-1", "3d10+2" */
const dice = (v: unknown) => {
  const d = typeof v === "string" ? v.toLowerCase().replace(/\s+/g, "") : "";
  return /^\d*d\d+([+-]\d+)?$/.test(d) ? d : undefined;
};

/** Habilidade válida para o ruleset (tipo existe; rank, recurso do custo e dano inválidos caem fora) ou null. */
export function normalizeAbility(r: Ruleset, raw: unknown): LibraryAbility | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  const name = str(a.name, 80);
  const type = pickKey(r.abilityTypes, a.type);
  if (!name || !type) return null;
  const c = (a.cost && typeof a.cost === "object" ? a.cost : {}) as Record<string, unknown>;
  const resource = pickKey(r.resources, c.resource);
  const amount = Number(c.amount);
  const milestones = (Array.isArray(a.milestones) ? a.milestones : [])
    .map((m) => ({ threshold: Math.round(Math.min(100, Math.max(0, Number(m?.threshold)))), description: str(m?.description, 300) }))
    .filter((m): m is { threshold: number; description: string } => Number.isFinite(m.threshold) && !!m.description)
    .sort((x, y) => x.threshold - y.threshold)
    .filter((m, i, all) => i === 0 || all[i - 1].threshold !== m.threshold);
  return compact({
    name,
    type,
    rank: pickRank(r, a.rank),
    description: str(a.description),
    effect: str(a.effect),
    cost: resource && c.amount !== null && c.amount !== "" && Number.isFinite(amount) && amount >= 0 ? { resource, amount: Math.round(amount) } : undefined,
    damage: dice(a.damage),
    requirements: str(a.requirements, 300),
    users: str(a.users, 300),
    milestones: milestones.length ? milestones : undefined,
  });
}

export function normalizeItem(r: Ruleset, raw: unknown): LibraryItem | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  const name = str(a.name, 80);
  if (!name) return null;
  return compact({
    name,
    category: str(a.category, 40),
    rank: pickRank(r, a.rank),
    description: str(a.description),
    effect: str(a.effect),
    damage: dice(a.damage),
  });
}

/** O que o Mestre passou em add_ability, quando o Criador não deu conta: tipo e rank válidos ou o padrão. */
export function fallbackAbility(r: Ruleset, name: string, args: Record<string, unknown>): LibraryAbility {
  const type = pickKey(r.abilityTypes, args.abilityType) ?? r.abilityTypes[0]?.key ?? "geral";
  const description = str(args.brief) ?? str(args.description);
  return normalizeAbility(r, { ...args, name, type, description }) ?? compact({ name, type, description });
}

/** Lista de entradas da resposta do Criador: {"items": [...]}, uma lista solta ou uma entrada só. */
export function parseCreatorJson(text: string): unknown[] {
  const t = text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/```(?:json)?/g, "");
  const start = t.search(/[[{]/);
  const end = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
  if (start < 0 || end < start) return [];
  const body = t.slice(start, end + 1);
  for (const s of [body, body.replace(/,(\s*[}\]])/g, "$1")]) {
    try {
      const v = JSON.parse(s);
      if (Array.isArray(v)) return v;
      if (Array.isArray(v?.items)) return v.items;
      return v && typeof v === "object" && "name" in v ? [v] : [];
    } catch {}
  }
  return [];
}

// ---------- Criador de habilidades / itens ----------

const CREATOR: Record<LibraryKind, string> = { ability: "abilities", item: "items" };
export const creatorName = (kind: LibraryKind) => (kind === "ability" ? "Criador de habilidades" : "Criador de itens");
const kindLabel = (r: Ruleset, kind: LibraryKind) => (kind === "ability" ? r.abilitiesLabel || "Habilidades" : "Itens").toLowerCase();

interface CreateRequest {
  count: number;
  focus?: string;
  canon: boolean;
  name?: string; // uma entrada com este nome exato (add_ability)
  existing: string[];
}

/** Pedido ao Criador: a mecânica do ruleset (o system prompt é agnóstico) + o que criar. */
export function creatorPrompt(r: Ruleset, kind: LibraryKind, req: CreateRequest): string {
  const label = kindLabel(r, kind);
  const lines: (string | false | undefined)[] = [
    `--- MECÂNICA DA CAMPANHA: ${r.name} ---`,
    r.description,
    `Baseada em obra existente (cânone): ${r.canonBased ? "sim" : "não"}`,
    r.loreNotes && `Cenário: ${r.loreNotes.slice(0, 3000)}`,
    `Níveis, do mais fraco ao mais forte: ${r.abilityRanks.join(" < ") || "(nenhum)"}`,
    `Recursos (key: nome): ${r.resources.map((x) => `${x.key}: ${x.label}`).join(", ")}`,
    `Atributos dos testes: ${r.attributes.map((x) => x.label).join(", ")}`,
  ];
  if (kind === "ability")
    lines.push(
      `Tipos de ${label} (key: nome): ${r.abilityTypes.map((t) => `${t.key}: ${t.label}${t.description ? ` (${t.description})` : ""}`).join("; ")}`,
      r.abilityCosts && `Custo padrão por nível (${r.abilityCosts.resource}): ${costsByRankText(r)}`,
      `Domínio: quem aprende tem 0-100% de domínio de cada técnica; bônus no teste por faixa: ${(r.masteryBonus ?? DEFAULT_MASTERY_BONUS)
        .map((b) => `${b.min}%: +${b.value}`)
        .join(", ")}`,
      r.progressionNotes && `Progressão: ${r.progressionNotes}`
    );
  lines.push(
    r.extraFields.length > 0 && `Campos da ficha: ${r.extraFields.map((f) => `${f.label}${f.description ? ` (${f.description})` : ""}`).join("; ")}`,
    r.diceNotes && `Rolagens: ${r.diceNotes}`,
    "\n--- PEDIDO ---",
    req.name
      ? `Crie uma entrada só, com o nome exato "${req.name}".${req.focus ? ` O Mestre descreve: ${req.focus}` : ""}`
      : `Crie ${req.count} ${label}${req.focus ? ` com este foco: ${req.focus}` : ""}.`,
    req.name
      ? req.canon
        ? "Se existe na obra, siga a obra e marque canon true; se é criação desta campanha, canon false."
        : "Mundo original: canon false."
      : req.canon
        ? "Cânone: só o que existe na obra, com canon true. Se não houver o bastante dentro do foco, traga menos."
        : "Originais desta campanha, coerentes com o mundo: canon false.",
    req.existing.length > 0 && `JÁ EXISTEM (não repita nem traga variação do mesmo nome): ${req.existing.slice(-400).join(", ")}`
  );
  return lines.filter(Boolean).join("\n");
}

type Made = { data: LibraryAbility | LibraryItem; canon: boolean };

async function create(campaign: Campaign, kind: LibraryKind, req: CreateRequest): Promise<Made[]> {
  const agent = await getAgent(CREATOR[kind]);
  const r = await chat({
    model: agent.model,
    temperature: agent.temperature,
    max_tokens: agent.max_tokens,
    webSearch: agent.web_search,
    messages: [
      { role: "system", content: agent.system_prompt },
      { role: "user", content: creatorPrompt(campaign.ruleset, kind, req) },
    ],
    agentId: agent.id,
    campaignId: campaign.id,
    purpose: req.name ? `biblioteca: ${req.name}` : `biblioteca: lote de ${req.count}`,
  });
  const norm = kind === "ability" ? normalizeAbility : normalizeItem;
  return parseCreatorJson(r.content).flatMap((raw) => {
    const data = norm(campaign.ruleset, raw);
    return data ? [{ data, canon: req.canon && (raw as { canon?: unknown }).canon === true }] : [];
  });
}

// o mesmo nome pedido duas vezes ao mesmo tempo (Mestre + Criador de personagens) chama o Criador uma vez só
const inflight = new Map<string, Promise<LibraryAbility | null>>();

/**
 * Habilidade pronta para a ficha: a da biblioteca ou, se não existir, criada agora pelo
 * Criador de habilidades a partir do brief (e guardada na biblioteca). null se não deu.
 */
export async function ensureAbility(campaign: Campaign, name: string, brief?: string): Promise<LibraryAbility | null> {
  const hit = await findLibrary(campaign.id, "ability", name);
  if (hit) return hit.data as LibraryAbility;
  const key = `${campaign.id}:${fold(name)}`;
  let p = inflight.get(key);
  if (!p) {
    p = (async () => {
      const [made] = await create(campaign, "ability", { count: 1, name, focus: brief, canon: campaign.ruleset.canonBased, existing: [] });
      if (!made) return null;
      const data = { ...made.data, name: name.trim() }; // o nome que o Mestre usa na história
      await saveLibrary(campaign.id, "ability", data, made.canon);
      return data as LibraryAbility;
    })()
      .catch((e) => {
        console.error(`[ensureAbility ${name}]`, e);
        return null;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

export const BATCH = 6;
export const MAX_GENERATE = 60;

/**
 * Lotes até `total` entradas novas: cada lote recebe os nomes que já existem para não repetir.
 * Para quando 2 lotes seguidos não trazem nada novo (vazio, repetido ou erro). Devolve quantas entraram.
 */
export async function fillLibrary(
  campaignId: string,
  kind: LibraryKind,
  total: number,
  make: (want: number, existing: string[]) => Promise<Made[]>,
  progress: (done: number, total: number) => Promise<void>
): Promise<number> {
  const existing = (await listLibrary(campaignId, kind, { limit: 5000 })).map((e) => e.name);
  const seen = new Set(existing.map(fold));
  let done = 0;
  let stale = 0;
  let lastError: unknown = null;
  await progress(0, total);
  while (done < total && stale < 2) {
    let added = 0;
    try {
      for (const e of await make(Math.min(BATCH, total - done), [...existing])) {
        if (done >= total || seen.has(fold(e.data.name))) continue;
        seen.add(fold(e.data.name));
        if (await saveLibrary(campaignId, kind, e.data, e.canon)) {
          existing.push(e.data.name);
          added++;
          done++;
        }
      }
    } catch (e) {
      lastError = e;
    }
    stale = added ? 0 : stale + 1;
    await progress(done, total);
  }
  if (!done && lastError) throw lastError;
  return done;
}

/** "Crie N com foco X" em segundo plano (tarefa 'library'); a tela acompanha pelo cabeçalho. */
export async function generateLibrary(campaign: Campaign, kind: LibraryKind, count: number, focus: string, canon: boolean) {
  const total = Math.min(Math.max(Math.round(count) || 1, 1), MAX_GENERATE);
  const f = focus.trim().slice(0, 300);
  const label = `${creatorName(kind)}: ${total} ${kindLabel(campaign.ruleset, kind)}${f ? ` (${f})` : ""}`;
  return {
    label,
    ...(await startJob(campaign.id, "library", `${kind}:${fold(f)}`, label, async (progress) => {
      await fillLibrary(campaign.id, kind, total, (want, existing) => create(campaign, kind, { count: want, focus: f, canon, existing }), progress);
    })),
  };
}
