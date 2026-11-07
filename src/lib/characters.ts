import { isDeepStrictEqual } from "node:util";
import { db, q } from "./db";
import { getAgent } from "./agents";
import { chat } from "./openrouter";
import { startJob } from "./jobs";
import { dehydrateSheet, hydrateSheet, linkAbility, listLibrary } from "./library";
import { rulesetPromptSummary } from "./ruleset";
import { controlLabel, COST_MULT_MAX, COST_MULT_MIN, costMultOf, powerLevels } from "./progression";
import type { Ability, Campaign, Character, Item, LibraryItem, Persona, Ruleset, Sheet } from "./types";

/**
 * Criador de personagens: perfil rico e ficha de um NPC, em segundo plano. O create_npc registra na hora
 * (o bloco de efeitos registra depois da narração, ou o fora do jogo) e este job completa depois, sem atropelar o que
 * o Mestre mudou no meio tempo. No fim pede o retrato (que usa a aparência rica).
 */

export const PROFILE_FIELDS = [
  "appearance", "age", "role", "personality", "speech", "backstory", "goals", "secrets", "relationships", "quirks",
] as const;

/** sheet + persona de um personagem: a foto do registro (base) e a da hora de gravar. */
export interface Snapshot {
  sheet: Sheet;
  persona: Persona;
}

/** Saída do Criador já limpa e coerente com o ruleset. */
export interface Draft {
  persona: Partial<Persona>;
  sheet: Partial<Pick<Sheet, "rank" | "xp" | "attributes" | "resources" | "extra" | "inventory" | "costMult">>;
  /** do Criador: nome + domínio (+ definição, que só vale como fallback incompleto do linkAbility); depois de createProfile, ligadas à biblioteca (com ref) */
  abilities: Ability[];
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown, max = 1500) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const num = (v: unknown) => {
  const n = typeof v === "string" && v.trim() ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};
/** multiplicador de custo do Criador: dentro dos limites e diferente de 1, senão nada (padrão) */
const mult = (v: unknown) => {
  const n = num(v);
  return n === undefined || n <= 0 ? undefined : costMultOf(n) === 1 ? undefined : Math.round(costMultOf(n) * 100) / 100;
};
const list = (v: unknown) => (Array.isArray(v) ? v.map(obj).filter((x) => str(x.name, 80)) : []);

/** O JSON da resposta (o modelo raciocina antes e às vezes cerca com ``` ou deixa vírgula sobrando). */
export function parseCreatorJson(text: string): unknown {
  const t = text.replace(/<think>[\s\S]*?<\/think>/g, "");
  const body = t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1);
  for (const s of [body, body.replace(/,(\s*[}\]])/g, "$1")]) {
    try {
      return JSON.parse(s);
    } catch {}
  }
  throw new Error("O Criador de personagens não devolveu um JSON legível.");
}

/** Limpa a resposta do Criador: só keys do ruleset, números nas faixas, atributos no teto do nível de poder. */
export function normalizeDraft(raw: unknown, r: Ruleset): Draft {
  const p = obj(obj(raw).profile);
  const s = obj(obj(raw).sheet);
  const persona: Partial<Persona> = {};
  for (const k of PROFILE_FIELDS) persona[k] = str(p[k]);
  for (const k of ["role", "age"] as const) persona[k] = persona[k]?.replace(/\.$/, "").slice(0, 160); // vão numa linha só
  if (p.gender === "male" || p.gender === "female") persona.gender = p.gender;

  const levels = powerLevels(r);
  // sem powerLevels no ruleset os cargos fazem as vezes de nível (progression.powerLevels)
  const level = levels.find((l) => l.key === s.powerLevel) ?? levels.find((l) => l.key === s.rank);
  const cap = level?.attributeCap ?? Infinity;
  const attributes: Record<string, number> = {};
  for (const a of r.attributes) {
    const v = num(obj(s.attributes)[a.key]);
    if (v !== undefined) attributes[a.key] = Math.round(Math.max(a.min, Math.min(a.max, cap, v)));
  }
  const resources: Sheet["resources"] = {};
  for (const x of r.resources) {
    const raw = obj(s.resources)[x.key];
    const v = num(raw) ?? num(obj(raw).max); // no Refazer o modelo às vezes copia o formato da ficha ({ max, current })
    if (v !== undefined && v >= 1) resources[x.key] = { current: Math.round(v), max: Math.round(v) };
  }
  const extra: Record<string, string> = {};
  for (const f of r.extraFields) {
    const v = str(obj(s.extra)[f.key], 300);
    if (v && !/^(vazio|nenhum|nenhuma|n\/?a|none|-+|—)\.?$/i.test(v)) extra[f.key] = v; // "Vazio" = não se aplica
  }

  const types = new Set(r.abilityTypes.map((t) => t.key));
  const seen = new Set<string>();
  const fresh = (name: string) => !seen.has(name.toLowerCase()) && !!seen.add(name.toLowerCase());
  const abilities: Ability[] = list(s.abilities).flatMap((a) => {
    const name = str(a.name, 80)!;
    if (!fresh(name)) return [];
    const milestones = Array.isArray(a.milestones)
      ? a.milestones
          .map(obj)
          .map((m) => ({ threshold: num(m.threshold), description: str(m.description, 300) }))
          .filter((m): m is { threshold: number; description: string } => m.threshold !== undefined && !!m.description)
          .sort((x, y) => x.threshold - y.threshold)
      : [];
    return [
      {
        name,
        type: types.has(String(a.type)) ? String(a.type) : "",
        rank: r.abilityRanks.includes(String(a.rank)) ? String(a.rank) : undefined,
        progress: Math.max(0, Math.min(100, Math.round(num(a.progress) ?? 50))),
        costMult: mult(a.costMult),
        description: str(a.description, 600),
        effect: str(a.effect, 600),
        damage: str(a.damage, 40),
        requirements: str(a.requirements, 300),
        milestones: milestones.length ? milestones : undefined,
      },
    ];
  });
  seen.clear();
  const inventory: Item[] = list(s.inventory).flatMap((i) => {
    const name = str(i.name, 80)!;
    return fresh(name) ? [{ name, qty: Math.max(1, Math.round(num(i.qty) ?? 1)), description: str(i.description, 400) }] : [];
  });

  const sheet: Draft["sheet"] = { attributes, resources, extra, inventory };
  if (mult(s.costMult)) sheet.costMult = mult(s.costMult);
  const rank = r.ranks.find((k) => k.key === s.rank)?.key;
  if (rank) sheet.rank = rank;
  if (level) sheet.xp = level.xpRequired;
  return { persona: JSON.parse(JSON.stringify(persona)), sheet, abilities };
}

/** O que já está na lista fica (campo a campo); o Criador acrescenta nomes novos e completa campos vazios. */
function byName<T extends { name: string }>(cur: T[] = [], add: T[] = []): T[] {
  const out = new Map(cur.map((c) => [c.name.toLowerCase(), c]));
  for (const a of add) {
    const k = a.name.toLowerCase();
    out.set(k, { ...a, ...out.get(k) });
  }
  return [...out.values()];
}

/** Habilidades: identidade é a ref (biblioteca). As da ficha ficam como estão; entram as refs novas. */
function byRef(cur: Ability[] = [], add: Ability[] = []): Ability[] {
  const has = new Set(cur.map((a) => a.ref));
  return [...cur, ...add.filter((a) => !has.has(a.ref) && !!has.add(a.ref))];
}

/**
 * Junta o rascunho do Criador à ficha atual. Campo que mudou desde o registro (base) foi o Mestre ou o
 * jogador mexendo no meio tempo (set_rank, voz...): fica como está. Recurso: o máximo vem do Criador e o
 * que faltava (dano, gasto) continua faltando; se o Mestre mudou o máximo, fica o dele. Sexo e voz nunca
 * vêm do Criador (só preenche o sexo se ainda não foi decidido). Habilidades e itens: soma, sem tirar nada.
 */
export function mergeProfile(base: Snapshot, cur: Snapshot, d: Draft): Snapshot {
  const b = JSON.parse(JSON.stringify(base)) as Snapshot; // como o JSONB guarda (sem chaves undefined)
  const untouched = (x: unknown, y: unknown) => isDeepStrictEqual(x, y);
  const persona: Persona = { ...cur.persona };
  for (const k of PROFILE_FIELDS) if (d.persona[k] && untouched(b.persona[k], cur.persona[k])) persona[k] = d.persona[k];
  if (cur.persona.gender === undefined && d.persona.gender) persona.gender = d.persona.gender;

  const sheet: Sheet = { ...cur.sheet };
  const perKey = <T>(from: Record<string, T> | undefined, was: Record<string, T> | undefined, now: Record<string, T> | undefined) => {
    const out = { ...now };
    for (const [k, v] of Object.entries(from ?? {})) if (untouched(was?.[k], now?.[k])) out[k] = v;
    return out;
  };
  sheet.attributes = perKey(d.sheet.attributes, b.sheet.attributes, cur.sheet.attributes);
  sheet.resources = { ...cur.sheet.resources };
  for (const [k, { max }] of Object.entries(d.sheet.resources ?? {})) {
    const was = b.sheet.resources?.[k];
    const now = cur.sheet.resources?.[k];
    if (now && was?.max !== now.max) continue;
    sheet.resources[k] = { max, current: Math.max(0, Math.min(max, max - (now ? now.max - now.current : 0))) };
  }
  sheet.extra = perKey(d.sheet.extra, b.sheet.extra, cur.sheet.extra);
  if (d.sheet.rank && untouched(b.sheet.rank, cur.sheet.rank)) sheet.rank = d.sheet.rank;
  if (d.sheet.xp !== undefined && untouched(b.sheet.xp, cur.sheet.xp)) sheet.xp = d.sheet.xp;
  if (d.sheet.costMult !== undefined && untouched(b.sheet.costMult, cur.sheet.costMult)) sheet.costMult = d.sheet.costMult;
  sheet.abilities = byRef(cur.sheet.abilities, d.abilities);
  sheet.inventory = byName(cur.sheet.inventory, d.sheet.inventory);
  return { sheet, persona };
}

/**
 * Grava o rascunho com a linha travada (FOR UPDATE): o merge vê o valor de agora, não o do começo do job.
 * false = o personagem sumiu (ex.: "gerar novamente" desfez o turno que o criou).
 * ponytail: as tools do Mestre leem e regravam a ficha inteira sem trava; se uma delas ler antes deste
 * commit e gravar depois (milissegundos), a ficha nova se perde (o perfil não). Trava nelas se acontecer.
 */
export async function applyProfile(id: string, base: Snapshot, d: Draft): Promise<boolean> {
  const client = await (await db()).connect();
  try {
    await client.query("BEGIN");
    // ficha crua (abilities = { ref, progress }): o merge junta por ref e grava desidratada
    const { rows } = await client.query<Snapshot>(`SELECT sheet, persona FROM characters WHERE id = $1 FOR UPDATE`, [id]);
    if (rows[0]) {
      const m = mergeProfile(base, rows[0], d);
      await client.query(`UPDATE characters SET sheet = $2, persona = $3, updated_at = now() WHERE id = $1`, [
        id,
        JSON.stringify(dehydrateSheet(m.sheet)),
        JSON.stringify(m.persona),
      ]);
    }
    await client.query("COMMIT");
    return !!rows[0];
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Keys da mecânica que o JSON do Criador usa (o resumo do ruleset mostra só os rótulos). */
function keysBlock(r: Ruleset): string {
  return [
    `cargos (rank): ${r.ranks.map((k) => `${k.key}=${k.label}`).join(", ") || "-"}`,
    `níveis de poder (powerLevel): ${powerLevels(r).map((l) => `${l.key}=${l.label}${l.attributeCap !== undefined ? ` (teto ${l.attributeCap})` : ""}`).join(", ")}`,
    `atributos: ${r.attributes.map((a) => `${a.key} (${a.min}-${a.max}, padrão ${a.default})`).join(", ")}`,
    `recursos (máximo padrão): ${r.resources.map((x) => `${x.key}=${x.defaultMax}`).join(", ")}`,
    `tipos de habilidade: ${r.abilityTypes.map((t) => t.key).join(", ")} | níveis: ${r.abilityRanks.join(", ")}`,
    `campos extras: ${r.extraFields.map((f) => `${f.key}=${f.label}${f.description ? ` (${f.description})` : ""}`).join("; ") || "-"}`,
    r.abilityCosts &&
      `costMult (${controlLabel(r)}): multiplicador de custo, ${COST_MULT_MIN} a ${COST_MULT_MAX}, padrão 1 (omita): na ficha, o geral do personagem; numa habilidade, só daquela técnica para ele`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Chama o Criador e devolve o rascunho com as habilidades já resolvidas na biblioteca. */
async function createProfile(
  campaign: Campaign,
  npc: Character,
  base: Snapshot,
  { brief = "", redo = false, fixedRank = false }: { brief?: string; redo?: boolean; fixedRank?: boolean }
): Promise<Draft> {
  const cid = campaign.id;
  const [agent, libAbilities, libItems, [scene], others, memories, baseSheet] = await Promise.all([
    getAgent("characters"),
    listLibrary(campaign, "ability", { limit: 400 }),
    listLibrary(campaign, "item", { limit: 200 }),
    q<{ location: string; title: string; summary: string }>(
      `SELECT location, title, summary FROM scenes WHERE campaign_id = $1 AND is_current LIMIT 1`,
      [cid]
    ),
    q<{ name: string; kind: string; role: string | null }>(
      `SELECT name, kind, persona->>'role' AS role FROM characters WHERE campaign_id = $1 AND id <> $2 ORDER BY kind DESC, name LIMIT 60`,
      [cid, npc.id]
    ),
    q<{ content: string }>(
      `SELECT content FROM memories WHERE campaign_id = $1 AND lower(subject) = lower($2) ORDER BY importance DESC, id DESC LIMIT 20`,
      [cid, npc.name]
    ),
    hydrateSheet(base.sheet), // a foto pode vir crua (só ref): o Refazer precisa dos nomes
  ]);
  const r = campaign.ruleset;
  const arc = campaign.arc;
  const { voiceFx: _fx, ...known } = base.persona;
  const sheetNow = { ...baseSheet, abilities: baseSheet.abilities.map((a) => ({ name: a.name, progress: a.progress, costMult: a.costMult })) };
  const user = [
    `MECÂNICA E CENÁRIO\n${rulesetPromptSummary(r)}`,
    `KEYS PARA O JSON\n${keysBlock(r)}`,
    `MUNDO AGORA\n${[
      arc && `Arco atual: ${arc.title}: ${arc.premise}`,
      typeof campaign.state.startingPoint === "string" && campaign.state.startingPoint && `Ponto de partida da campanha: ${campaign.state.startingPoint}`,
      scene && `Cena atual: ${scene.title || "-"} em ${scene.location || "?"}${scene.summary ? `. ${scene.summary.slice(-1200)}` : ""}`,
      others.length && `Personagens já registrados: ${others.map((o) => `${o.name}${o.kind === "player" ? " (jogador)" : o.role ? ` (${o.role})` : ""}`).join(", ")}`,
    ]
      .filter(Boolean)
      .join("\n")}`,
    `BIBLIOTECA: HABILIDADES (nome exato, tipo, nível)\n${libAbilities.map((e) => `${e.name} (${[(e.data as Ability).type, (e.data as Ability).rank].filter(Boolean).join(", ")})`).join("; ") || "(vazia)"}`,
    `BIBLIOTECA: ITENS\n${libItems.map((e) => e.name).join("; ") || "(vazia)"}`,
    `PERSONAGEM\nNome: ${npc.name} | ${npc.canon ? "CANÔNICO (da obra)" : "original"} | sexo: ${
      base.persona.gender === "male" ? "masculino" : base.persona.gender === "female" ? "feminino" : "não informado"
    }`,
    brief && `Pedido do Mestre: ${brief}`,
    redo
      ? `PERFIL E FICHA ATUAIS (o personagem já está na história: mantenha cargo, habilidades, itens e fatos; corrija só o que contradiz a obra; enriqueça o que estiver vazio ou raso)\n${JSON.stringify({ persona: known, sheet: sheetNow })}`
      : `Já definido pelo Mestre (expanda sem contradizer): ${JSON.stringify({ ...known, backstory: undefined })}${fixedRank ? ` | cargo FIXO: ${base.sheet.rank}` : ""}`, // backstory = o brief
    memories.length && `MEMÓRIAS DA CAMPANHA SOBRE ${npc.name}\n${memories.map((m) => `- ${m.content}`).join("\n")}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const res = await chat({
    model: agent.model,
    messages: [
      { role: "system", content: agent.system_prompt },
      { role: "user", content: user },
    ],
    temperature: agent.temperature,
    max_tokens: agent.max_tokens,
    webSearch: agent.web_search,
    agentId: "characters",
    campaignId: cid,
    purpose: `${redo ? "refazer perfil" : "perfil"}: ${npc.name}`,
  });
  const d = normalizeDraft(parseCreatorJson(res.content), r);
  if (!PROFILE_FIELDS.some((k) => d.persona[k])) throw new Error("O Criador de personagens devolveu um perfil vazio.");

  // cada habilidade vira ref: a da biblioteca, a criada agora pelo Criador de habilidades ou, se ele falhar,
  // a definição do Criador de personagens gravada como incomplete. Sem ref não entra na ficha.
  const resolved = await Promise.all(
    d.abilities.map(async (a) => {
      const def = [a.type, a.rank, a.description, a.effect].filter(Boolean).join(". ");
      const brief = `${def}${def ? ". " : ""}Usada por ${npc.name}.`;
      const linked = await linkAbility(campaign, a.name, { brief, fallback: { ...a, abilityType: a.type } }).catch((e) => {
        console.error(`[createProfile ${npc.name}] ${a.name}`, e);
        return null;
      });
      if (!linked) return null;
      const { entry } = linked;
      return { ...(entry.data as Ability), name: entry.name, ref: entry.id, progress: a.progress, costMult: a.costMult } as Ability;
    })
  );
  d.abilities = resolved.filter((a): a is Ability => !!a);
  const items = new Map(libItems.map((e) => [e.name.toLowerCase(), e.data as LibraryItem]));
  d.sheet.inventory = d.sheet.inventory?.map((i) => {
    const hit = items.get(i.name.toLowerCase());
    return hit ? { name: hit.name, qty: i.qty, description: i.description ?? hit.description } : i;
  });
  return d;
}

/**
 * Perfil e ficha em segundo plano (tarefa "character" na tela), depois o retrato. base = a foto do
 * registro (create_npc) ou da hora do pedido (Refazer perfil): o merge preserva o que mudou depois dela.
 * fixedRank: o Mestre deu o cargo, o Criador não troca.
 */
export function queueProfile(
  campaign: Campaign,
  npc: Character,
  opts: { brief?: string; redo?: boolean; fixedRank?: boolean } = {}
): Promise<{ id: number; started: boolean }> {
  const base: Snapshot = { sheet: npc.sheet, persona: npc.persona };
  return startJob(campaign.id, "character", npc.id, `${opts.redo ? "Perfil refeito" : "Perfil"}: ${npc.name}`, async () => {
    const d = await createProfile(campaign, npc, base, { ...opts, brief: opts.brief?.trim() });
    if (opts.fixedRank) delete d.sheet.rank;
    await applyProfile(npc.id, base, d); // retrato só pelo botão Gerar retrato
  });
}
