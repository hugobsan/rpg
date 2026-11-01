import { q } from "./db";
import { getAgent } from "./agents";
import { chat } from "./openrouter";
import { startJob } from "./jobs";
import { abilityCost, consumptionOf } from "./ruleset";
import { slugKey } from "./table";
import { DEFAULT_MASTERY_BONUS } from "./progression";
import type { Ability, Campaign, LibraryAbility, LibraryEntry, LibraryItem, LibraryKind, Ruleset, Sheet, StoredAbility, StoredSheet } from "./types";

/**
 * Biblioteca do mundo (tabela library): habilidades e itens do tipo de campanha, compartilhados por
 * todas as campanhas daquele mundo. É a fonte única das habilidades: a ficha guarda só { ref, progress, costMult? }
 * (dehydrateSheet) e é hidratada na leitura (hydrateSheets).
 * Quem preenche: o Criador de habilidades e o Criador de itens (agentes `abilities` e `items`),
 * em lote no segundo plano (generateLibrary) ou uma técnica por vez quando o Mestre registra
 * uma que ainda não existe (ensureAbility / linkAbility).
 */

/** Mundo da campanha (escopo da biblioteca): Ruleset.world ou, sem ele, o slug do nome. */
export const worldOf = (campaign: { ruleset: Ruleset }) => campaign.ruleset.world || slugKey(campaign.ruleset.name);

const COLS = `id, world, kind, name, data, canon, source, deleted_at IS NOT NULL AS deleted`;
const entry = (r: LibraryEntry & { id: string | number }): LibraryEntry => ({ ...r, id: Number(r.id) });

// fold() no SQL sem a extensão unaccent: as letras acentuadas comuns viram a base
// ponytail: só o mapa abaixo; acento fora dele não casa. unaccent + índice se precisar de mais
const ACCENTS = "áàâãäåāéèêëēíìîïīóòôõöōúùûüūçñ";
const PLAIN = ACCENTS.normalize("NFD").replace(/\p{M}/gu, "");

export async function listLibrary(
  campaign: Campaign,
  kind: LibraryKind,
  opts: { query?: string; limit?: number } = {}
): Promise<LibraryEntry[]> {
  // a busca olha o nome e o texto (descrição, efeito, tradução, quem usa), sem acento; o nome que bate vem antes
  const rows = await q<LibraryEntry>(
    `SELECT ${COLS} FROM library
      WHERE world = $1 AND kind = $2 AND deleted_at IS NULL
        AND ($3::text IS NULL OR translate(lower(name), $5, $6) LIKE '%' || $3 || '%'
             OR translate(lower(data::text), $5, $6) LIKE '%' || $3 || '%')
      ORDER BY ($3::text IS NOT NULL AND translate(lower(name), $5, $6) LIKE '%' || $3 || '%') DESC, name LIMIT $4`,
    [worldOf(campaign), kind, opts.query?.trim() ? fold(opts.query) : null, opts.limit ?? 500, ACCENTS, PLAIN]
  );
  return rows.map(entry);
}

/**
 * Entrada do mundo pelo nome ou pela tradução (o Mestre pode escrever "Grande Bola de Fogo"), sem diferenciar
 * maiúsculas e acentos; o nome vence a tradução; ignora as excluídas.
 */
export async function findLibrary(campaign: Campaign, kind: LibraryKind, name: string): Promise<LibraryEntry | null> {
  const [r] = await q<LibraryEntry>(
    `SELECT ${COLS} FROM library
      WHERE world = $1 AND kind = $2 AND deleted_at IS NULL
        AND (translate(lower(name), $4, $5) = $3 OR translate(lower(data->>'translation'), $4, $5) = $3)
      ORDER BY translate(lower(name), $4, $5) = $3 DESC, id LIMIT 1`,
    [worldOf(campaign), kind, fold(name), ACCENTS, PLAIN]
  );
  return r ? entry(r) : null;
}

/** Leitura por id (hidratação da ficha): inclui as excluídas, marcadas com deleted. */
export async function getLibraryByIds(ids: number[]): Promise<LibraryEntry[]> {
  if (!ids.length) return [];
  return (await q<LibraryEntry>(`SELECT ${COLS} FROM library WHERE id = ANY($1::bigint[])`, [ids])).map(entry);
}

/** Grava uma entrada no mundo da campanha; null se o nome já existe (índice único por nome no mundo). */
async function saveLibrary(
  campaign: Campaign,
  kind: LibraryKind,
  data: LibraryAbility | LibraryItem,
  canon: boolean,
  source: "agent" | "gm" = "agent"
): Promise<LibraryEntry | null> {
  const [r] = await q<LibraryEntry>(
    `INSERT INTO library (world, campaign_id, kind, name, data, canon, source) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT DO NOTHING RETURNING ${COLS}`,
    [worldOf(campaign), campaign.id, kind, data.name, JSON.stringify(data), canon, source]
  );
  return r ? entry(r) : null;
}

// ---------- ficha: { ref, progress } gravado <-> habilidade completa em memória ----------

type AnyAbility = StoredAbility | Ability;

function hydrateAbility(a: AnyAbility, lib: Map<number, LibraryEntry>): Ability {
  if (typeof a.ref !== "number") return a as Ability; // formato antigo (cópia na ficha): fica como está
  const e = lib.get(a.ref);
  // id que não existe mais na tabela (não deveria: a exclusão é soft); mostra como fora da biblioteca
  if (!e) return compact({ name: `#${a.ref}`, type: "", ref: a.ref, progress: a.progress, costMult: a.costMult, removed: true as const });
  return compact({ ...(e.data as LibraryAbility), name: e.name, ref: e.id, progress: a.progress, costMult: a.costMult, removed: e.deleted ? (true as const) : undefined });
}

/** Habilidades das fichas completas pela biblioteca: uma consulta para o lote, mesma ordem de cada ficha. */
export async function hydrateSheets<T extends { sheet: Sheet | StoredSheet }>(rows: T[]): Promise<(Omit<T, "sheet"> & { sheet: Sheet })[]> {
  const list = (c: T) => (Array.isArray(c.sheet?.abilities) ? (c.sheet.abilities as AnyAbility[]) : null);
  const ids = [...new Set(rows.flatMap((c) => (list(c) ?? []).flatMap((a) => (typeof a.ref === "number" ? [a.ref] : []))))];
  const lib = new Map((await getLibraryByIds(ids)).map((e) => [e.id, e]));
  return rows.map((c) => {
    const abilities = list(c);
    return (abilities ? { ...c, sheet: { ...c.sheet, abilities: abilities.map((a) => hydrateAbility(a, lib)) } } : c) as Omit<T, "sheet"> & { sheet: Sheet };
  });
}

export async function hydrateSheet(sheet: Sheet | StoredSheet): Promise<Sheet> {
  return (await hydrateSheets([{ sheet }]))[0].sheet;
}

/** Ficha para gravar: cada habilidade com ref vira { ref, progress, costMult? }; sem ref (formato antigo) fica como está. */
export function dehydrateSheet(sheet: Sheet | StoredSheet): StoredSheet {
  return {
    ...sheet,
    abilities: ((sheet.abilities ?? []) as AnyAbility[]).map((a) => (typeof a.ref === "number" ? compact({ ref: a.ref, progress: a.progress, costMult: a.costMult === 1 ? undefined : a.costMult }) : a)),
  };
}

// ---------- ligar e editar ----------

/**
 * Entrada da biblioteca para ligar na ficha (a ref é entry.id): a do mundo pelo nome; senão a do Criador
 * de habilidades (ensureAbility, com prazo opcional); senão o que o Mestre passou (fallback, args de
 * add_ability) com incomplete: true. Sempre devolve uma entrada.
 * onCreator: avisado quando vai chamar o Criador (status na tela).
 */
export async function linkAbility(
  campaign: Campaign,
  name: string,
  opts: { brief?: string; fallback?: Record<string, unknown>; timeoutMs?: number; onCreator?: () => void } = {}
): Promise<{ entry: LibraryEntry; from: "library" | "creator" | "incomplete" }> {
  const hit = await findLibrary(campaign, "ability", name);
  if (hit) return { entry: hit, from: "library" };
  opts.onCreator?.();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const making = makeAbility(campaign, name, opts.brief);
  const made = await Promise.race([
    making,
    new Promise<null>((ok) => {
      if (opts.timeoutMs) timer = setTimeout(() => ok(null), opts.timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  if (made) {
    const stored = await storeMade(campaign, made);
    if (stored) return { entry: stored, from: "creator" };
  }
  const data = { ...fallbackAbility(campaign.ruleset, name, opts.fallback ?? {}), incomplete: true };
  const saved = (await saveLibrary(campaign, "ability", data, false, "gm")) ?? (await findLibrary(campaign, "ability", data.name));
  if (!saved) throw new Error(`Não foi possível registrar "${name}" na biblioteca.`);
  // o Criador respondeu depois do prazo: a resposta só completa a incompleta (que as fichas já apontam), nunca
  // mexe em outra entrada; se o nome oficial já é de outra entrada viva, a incompleta fica com o nome do Mestre
  if (!made)
    void making
      .then(async (late) => {
        if (!late) return;
        const patch: Record<string, unknown> = { ...late.data, incomplete: null };
        const taken = await findLibrary(campaign, "ability", late.data.name);
        if (taken && taken.id !== saved.id) {
          delete patch.name;
          console.warn(`[linkAbility ${name}] o Criador chamou de "${late.data.name}", que já é #${taken.id}; #${saved.id} fica com o nome do Mestre`);
        }
        const done = await editAbility(campaign, saved.id, patch);
        if (typeof done === "string") console.error(`[linkAbility ${name}] ${done}`);
      })
      .catch((e) => console.error(`[linkAbility ${name}]`, e));
  return { entry: saved, from: "incomplete" };
}

/**
 * Habilidade da tela de criação de campanha (kit inicial, extras), sem IA: a do mundo se já existe pelo
 * nome; senão grava a passada. null se não é válida para o ruleset.
 */
export async function ensureLibraryAbility(campaign: Campaign, ability: unknown, source: "agent" | "gm" = "gm", canon = false): Promise<LibraryEntry | null> {
  const data = normalizeAbility(campaign.ruleset, ability);
  if (!data) return null;
  return (
    (await findLibrary(campaign, "ability", data.name)) ??
    (await saveLibrary(campaign, "ability", data, canon, source)) ??
    (await findLibrary(campaign, "ability", data.name)) // gravada no meio do caminho por outra chamada
  );
}

/**
 * edit_ability: altera a entrada do mundo (por id ou nome). patch = campos de LibraryAbility; null apaga o campo.
 * Vale na hora para todas as fichas que apontam para ela. Editar tira o incomplete (salvo se o patch o mantiver).
 * Devolve a entrada nova ou a mensagem de erro.
 */
export async function editAbility(campaign: Campaign, target: string | number, patch: Record<string, unknown>): Promise<LibraryEntry | string> {
  const world = worldOf(campaign);
  const cur =
    typeof target === "number"
      ? (await getLibraryByIds([target])).find((e) => e.world === world && e.kind === "ability" && !e.deleted) ?? null
      : await findLibrary(campaign, "ability", target);
  if (!cur) return `"${target}" não está na biblioteca deste mundo.`;
  const merged: Record<string, unknown> = { ...(cur.data as LibraryAbility), incomplete: undefined, ...patch };
  for (const k of Object.keys(merged)) if (merged[k] === null) delete merged[k];
  const data = normalizeAbility(campaign.ruleset, merged);
  if (!data)
    return `Edição recusada: name e type são obrigatórios (type é uma destas keys: ${campaign.ruleset.abilityTypes.map((t) => t.key).join(", ")}).`;
  const taken = `Já existe "${data.name}" na biblioteca deste mundo; escolha outro nome ou edite aquela.`;
  const same = await findLibrary(campaign, "ability", data.name);
  if (same && same.id !== cur.id && fold(same.name) === fold(data.name)) return taken;
  try {
    const [r] = await q<LibraryEntry>(`UPDATE library SET name = $1, data = $2 WHERE id = $3 RETURNING ${COLS}`, [data.name, JSON.stringify(data), cur.id]);
    return entry(r);
  } catch (e) {
    if ((e as { code?: string }).code === "23505") return taken; // índice único: gravada agora por outra chamada
    throw e;
  }
}

/**
 * Copia para a biblioteca, sem IA, as habilidades que ainda estão nas fichas no formato antigo (sem ref),
 * com quem usa cada uma. As que já existem no mundo ficam como estão.
 */
export async function importSheetAbilities(campaign: Campaign): Promise<{ added: string[]; total: number }> {
  const chars = await q<{ name: string; canon: boolean; sheet: StoredSheet }>(
    `SELECT name, canon, sheet FROM characters WHERE campaign_id = $1 ORDER BY canon DESC, kind DESC, name`,
    [campaign.id]
  );
  const seen = new Map<string, { data: LibraryAbility; users: string[]; canon: boolean }>();
  for (const c of chars)
    for (const a of c.sheet?.abilities ?? []) {
      const data = normalizeAbility(campaign.ruleset, a); // { ref } sem nome dá null: já está na biblioteca
      if (!data) continue;
      const e = seen.get(fold(data.name)) ?? { data, users: [], canon: false };
      e.users.push(c.name);
      e.canon ||= c.canon;
      seen.set(fold(data.name), e);
    }
  const added: string[] = [];
  for (const { data, users, canon } of seen.values())
    if (!(await findLibrary(campaign, "ability", data.name)) && (await saveLibrary(campaign, "ability", { ...data, users: data.users || users.join(", ") }, canon, "gm")))
      added.push(data.name);
  return { added, total: seen.size };
}

/** Exclusão = soft delete: some da listagem e da busca; as fichas que apontam para ela continuam (removed). */
export async function deleteLibrary(campaign: Campaign, id: number): Promise<boolean> {
  return (await q(`UPDATE library SET deleted_at = now() WHERE world = $1 AND id = $2 AND deleted_at IS NULL RETURNING id`, [worldOf(campaign), id])).length > 0;
}

/** Descrição de inventário de um item da biblioteca. */
export const itemText = (i: LibraryItem) => [i.description, i.effect, i.damage && `Dano ${i.damage}.`].filter(Boolean).join(" ");

/** Uma linha por entrada para o Mestre (search_library). */
export function libraryLine(r: Ruleset, e: LibraryEntry): string {
  const d = e.data as LibraryAbility & LibraryItem;
  const c = e.kind === "ability" ? abilityCost(r, d) : null;
  const band = e.kind === "ability" ? consumptionOf(r, d) : undefined;
  const cost = c ? (c.amount ? `custo base ${c.amount} ${c.resource}${d.costUnit ? ` por ${d.costUnit}` : ""}${band ? ` (consumo ${band.label.toLowerCase()})` : ""}` : "sem custo") : "";
  const bits = [d.type ?? d.category, d.element, d.rank && `rank ${d.rank}`, cost, d.damage && `dano ${d.damage}`, !e.canon && "original", d.incomplete && "incompleta: complete com edit_ability"].filter(Boolean);
  const title = d.translation ? `${e.name} (${d.translation})` : e.name;
  return [`${title} [${bits.join(", ")}]`, d.effect || d.description, d.requirements && `requisitos: ${d.requirements}`, d.users && `usuários: ${d.users}`]
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

/**
 * Habilidade válida para o ruleset (tipo existe; rank, consumo e dano inválidos caem fora) ou null. Não guarda custo
 * (vem da faixa de consumo ou do rank): costFree, ou o cost.amount 0 do formato antigo, vira costFree true.
 */
export function normalizeAbility(r: Ruleset, raw: unknown): LibraryAbility | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  const name = str(a.name, 80);
  const type = pickKey(r.abilityTypes, a.type);
  if (!name || !type) return null;
  const oldCost = (a.cost && typeof a.cost === "object" ? a.cost : {}) as Record<string, unknown>;
  const milestones = (Array.isArray(a.milestones) ? a.milestones : [])
    .map((m) => ({ threshold: Math.round(Math.min(100, Math.max(0, Number(m?.threshold)))), description: str(m?.description, 300) }))
    .filter((m): m is { threshold: number; description: string } => Number.isFinite(m.threshold) && !!m.description)
    .sort((x, y) => x.threshold - y.threshold)
    .filter((m, i, all) => i === 0 || all[i - 1].threshold !== m.threshold);
  return compact({
    name,
    translation: str(a.translation, 160),
    type,
    element: r.abilityElements ? pickKey(r.abilityElements, a.element) : undefined,
    rank: pickRank(r, a.rank),
    costFree: a.costFree === true || (oldCost.amount !== null && oldCost.amount !== "" && Number(oldCost.amount) === 0) || undefined,
    consumption: pickKey(r.abilityCosts?.byConsumption ?? [], a.consumption),
    costUnit: str(a.costUnit, 30)?.toLowerCase(),
    description: str(a.description),
    effect: str(a.effect),
    damage: dice(a.damage),
    requirements: str(a.requirements, 300),
    users: str(a.users, 300),
    milestones: milestones.length ? milestones : undefined,
    incomplete: a.incomplete === true || undefined,
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
  name?: string; // uma entrada para este nome (add_ability); com padrão de nomes, o Criador pode corrigi-lo
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
      r.abilityNaming && `Padrão de nomes: ${r.abilityNaming}`,
      r.abilityElements &&
        `Elementos (campo element, key: nome; omita se a técnica não tem elemento): ${r.abilityElements.map((t) => `${t.key}: ${t.label}${t.description ? ` (${t.description})` : ""}`).join("; ")}`,
      // o valor do custo é regra do mundo e o ajuste é de quem usa: a técnica só diz se gasta, quanto (faixa) e por unidade
      `Campos além do formato: translation (tradução do nome para exibição, só quando o nome não está em português) e costFree (true só se não gasta recurso: técnicas físicas, armas, ofícios, passivas). NÃO inclua cost: o valor vem das regras do mundo.`,
      r.abilityCosts?.byConsumption &&
        `Faixas de consumo (campo consumption, key: nome = custo base em ${r.abilityCosts.resource}): ${r.abilityCosts.byConsumption.map((b) => `${b.key}: ${b.label} = ${b.cost}${b.description ? ` (${b.description})` : ""}`).join("; ")}. Escolha pela energia que a técnica gasta, independente do nível: o nível mede a dificuldade de aprender e controlar (uma técnica difícil pode ser econômica, uma fácil pode ser cara). Sem consumption, vale o custo do nível.`,
      r.abilityCosts &&
        `costUnit (opcional, texto curto no singular): quando o gasto é por unidade, o custo da faixa vale por unidade (ex.: Naruto: Kage Bunshin por "clone", um dōjutsu por "rodada" ativo; Harry Potter: Patrono por "rodada"; invocação por "invocação"). Técnica de efeito único: omita.`,
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
      ? (kind === "ability" && r.abilityNaming
          ? `Crie uma entrada só, para a técnica que o Mestre chamou de "${req.name}", com o nome no padrão de nomes (pode ser diferente deste).`
          : `Crie uma entrada só, com o nome exato "${req.name}".`) + (req.focus ? ` O Mestre descreve: ${req.focus}` : "")
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
const inflight = new Map<string, Promise<Made | null>>();

/**
 * Técnica feita pelo Criador de habilidades, sem gravar. Com padrão de nomes vale o nome do Criador (o oficial);
 * sem, o que o Mestre usa na história. null se não deu.
 */
function makeAbility(campaign: Campaign, name: string, brief?: string): Promise<Made | null> {
  const key = `${worldOf(campaign)}:${fold(name)}`;
  let p = inflight.get(key);
  if (!p) {
    p = create(campaign, "ability", { count: 1, name, focus: brief, canon: campaign.ruleset.canonBased, existing: [] })
      .then(([made]) => made && (campaign.ruleset.abilityNaming ? made : { ...made, data: { ...made.data, name: name.trim() } }))
      .catch((e) => {
        console.error(`[makeAbility ${name}]`, e);
        return null;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

/** Grava o que o Criador fez; se o nome (oficial) já existe no mundo, devolve a que existe. */
async function storeMade(campaign: Campaign, made: Made): Promise<LibraryEntry | null> {
  const { name } = made.data;
  return (
    (await findLibrary(campaign, "ability", name)) ??
    (await saveLibrary(campaign, "ability", made.data, made.canon)) ??
    (await findLibrary(campaign, "ability", name))
  );
}

/** Entrada do mundo para a habilidade: a da biblioteca ou, se não existir, criada agora pelo Criador (e guardada). */
export async function ensureAbility(campaign: Campaign, name: string, brief?: string): Promise<LibraryEntry | null> {
  const hit = await findLibrary(campaign, "ability", name);
  if (hit) return hit;
  const made = await makeAbility(campaign, name, brief);
  return made && storeMade(campaign, made);
}

export const BATCH = 6;
export const MAX_GENERATE = 60;

/**
 * Lotes até `total` entradas novas: cada lote recebe os nomes que já existem para não repetir.
 * Para quando 2 lotes seguidos não trazem nada novo (vazio, repetido ou erro). Devolve quantas entraram.
 */
export async function fillLibrary(
  campaign: Campaign,
  kind: LibraryKind,
  total: number,
  make: (want: number, existing: string[]) => Promise<Made[]>,
  progress: (done: number, total: number) => Promise<void>
): Promise<number> {
  const existing = (await listLibrary(campaign, kind, { limit: 5000 })).map((e) => e.name);
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
        if (await saveLibrary(campaign, kind, e.data, e.canon)) {
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
      await fillLibrary(campaign, kind, total, (want, existing) => create(campaign, kind, { count: want, focus: f, canon, existing }), progress);
    })),
  };
}
