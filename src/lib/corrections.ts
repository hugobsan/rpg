import { q } from "./db";
import { formatClock, getClock } from "./clock";
import { dehydrateSheet, hydrateSheets } from "./library";
import { getObjectives, objectiveXp, type Objective, type ObjectiveStatus } from "./objectives";
import { getTable } from "./table";
import { executeGmTool, loadObjectives, saveObjectives, type ToolContext } from "./tools";
import type { Ability, Campaign, Character, Scene, Sheet } from "./types";

/**
 * Correções do registro pelo jogador, como numa mesa de verdade: edição manual da ficha (recursos, itens, domínio, XP,
 * status de missão) e desfazer um efeito aplicado (bloco de efeitos do Narrador) pela etiqueta no chat. A edição passa pelas ferramentas do jogo
 * (as regras continuam valendo: XP sobe nível, missão concluída dá a XP uma vez só), vira uma linha para o Mestre no
 * próximo turno (state.playerFixes, consumida depois da narração, como o decidedAt das missões) e uma linha na tabela
 * corrections, para medir quantos registros dos agentes estavam errados.
 * Verificação sem IA: npx tsx scripts/corrections-check.ts
 */

// turno em andamento por campanha (rota do turno): a ficha não muda por fora enquanto ele grava.
// No globalThis: cada rota pode carregar a sua cópia deste módulo
export const turns: Map<string, { stop: AbortController; done: Promise<void> }> = ((
  globalThis as { __turns?: Map<string, { stop: AbortController; done: Promise<void> }> }
).__turns ??= new Map());

export class FixError extends Error {}

// ---------- efeitos aplicados e o desfazer ----------

type CharUndo = {
  id: string;
  xp?: number;
  money?: number;
  res?: Record<string, [current: number, max: number]>;
  items?: { name: string; qty: number; description?: string }[];
  mastery?: Record<string, number>; // ref (ou nome, ficha antiga) → pontos
  extra?: Record<string, string>; // valor de antes
};
/** O que um registro mudou, em deltas: desfazer subtrai e preserva o que mudou depois. */
export interface ScribeUndo {
  chars?: CharUndo[];
  objectives?: { id: string; before: Objective | null }[]; // null = criada pelo registro
  memory?: number;
}
/** Efeito aplicado guardado na narração (meta.scribe); note é a linha de meta.notes. */
export interface ScribeEntry {
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  note: string;
  undo?: ScribeUndo;
  undone?: boolean;
}

type Raw = { id: string; sheet: Sheet };
export type ScribeBefore = { chars: Raw[]; objectives: Objective[]; mem: number };

/** O que um registro pode mudar: o jogador e o personagem citado, as missões e a última memória. */
export async function scribeState(campaignId: string, args: Record<string, unknown>): Promise<ScribeBefore> {
  const [chars, [row]] = await Promise.all([
    q<Raw>(`SELECT id, sheet FROM characters WHERE campaign_id = $1 AND (kind = 'player' OR lower(name) = lower($2))`, [
      campaignId,
      String(args.character ?? ""),
    ]),
    q<{ state: Record<string, unknown>; mem: string | null }>(
      `SELECT state, (SELECT MAX(id) FROM memories WHERE campaign_id = $1) AS mem FROM campaigns WHERE id = $1`,
      [campaignId]
    ),
  ]);
  return { chars, objectives: getObjectives(row?.state), mem: Number(row?.mem ?? 0) };
}

const abilityKey = (a: Pick<Ability, "ref" | "name">) => String(a.ref ?? a.name);

/** Diferença entre duas fichas (formato gravado ou hidratado); null = igual no que os efeitos mexem. */
export function sheetDiff(a: Sheet, b: Sheet): Omit<CharUndo, "id"> | null {
  const d: Omit<CharUndo, "id"> = {};
  if ((b.xp ?? 0) !== (a.xp ?? 0)) d.xp = (b.xp ?? 0) - (a.xp ?? 0);
  if ((b.money ?? 0) !== (a.money ?? 0)) d.money = (b.money ?? 0) - (a.money ?? 0);
  for (const [k, r] of Object.entries(b.resources ?? {})) {
    const o = a.resources?.[k];
    if (o && (r.current !== o.current || r.max !== o.max)) (d.res ??= {})[k] = [r.current - o.current, r.max - o.max];
  }
  const ia = new Map((a.inventory ?? []).map((i) => [i.name, i]));
  const ib = new Map((b.inventory ?? []).map((i) => [i.name, i]));
  for (const name of new Set([...ia.keys(), ...ib.keys()])) {
    const qty = (ib.get(name)?.qty ?? 0) - (ia.get(name)?.qty ?? 0);
    if (qty) (d.items ??= []).push({ name, qty, description: (ia.get(name) ?? ib.get(name))?.description });
  }
  const pa = new Map((a.abilities ?? []).map((x) => [abilityKey(x), x.progress ?? 0]));
  for (const x of b.abilities ?? []) {
    const was = pa.get(abilityKey(x));
    if (was !== undefined && (x.progress ?? 0) !== was) (d.mastery ??= {})[abilityKey(x)] = (x.progress ?? 0) - was;
  }
  for (const k of new Set([...Object.keys(a.extra ?? {}), ...Object.keys(b.extra ?? {})]))
    if ((a.extra?.[k] ?? "") !== (b.extra?.[k] ?? "")) (d.extra ??= {})[k] = a.extra?.[k] ?? "";
  return Object.keys(d).length ? d : null;
}

/** Desfaz na ficha (hidratada) o que sheetDiff registrou. */
export function revertSheet(s: Sheet, d: Omit<CharUndo, "id">): void {
  if (d.xp) s.xp -= d.xp;
  if (d.money) s.money = Math.max(0, (s.money ?? 0) - d.money);
  for (const [k, [cur, max]] of Object.entries(d.res ?? {})) {
    const r = s.resources[k];
    if (!r) continue;
    r.max = Math.max(1, r.max - max);
    r.current = Math.max(0, Math.min(r.current - cur, r.max));
  }
  for (const it of d.items ?? []) {
    const have = s.inventory.find((i) => i.name.toLowerCase() === it.name.toLowerCase());
    if (have) have.qty -= it.qty;
    else if (it.qty < 0) s.inventory.push({ name: it.name, qty: -it.qty, description: it.description });
  }
  s.inventory = s.inventory.filter((i) => i.qty > 0);
  for (const [key, n] of Object.entries(d.mastery ?? {})) {
    const a = s.abilities.find((x) => abilityKey(x) === key);
    if (a) a.progress = Math.max(0, Math.min(100, (a.progress ?? 0) - n));
  }
  for (const [k, v] of Object.entries(d.extra ?? {})) s.extra[k] = v;
}

/** O que o registro mudou desde `before`; undefined = nada (não há o que desfazer). */
export async function scribeUndo(
  campaignId: string,
  before: ScribeBefore,
  tool: string,
  args: Record<string, unknown>
): Promise<ScribeUndo | undefined> {
  const after = await scribeState(campaignId, args);
  const u: ScribeUndo = {};
  for (const b of after.chars) {
    const a = before.chars.find((c) => c.id === b.id);
    const d = a && sheetDiff(a.sheet, b.sheet);
    if (d) (u.chars ??= []).push({ id: b.id, ...d });
  }
  for (const o of after.objectives) {
    const was = before.objectives.find((x) => x.id === o.id) ?? null;
    if (JSON.stringify(was) !== JSON.stringify(o)) (u.objectives ??= []).push({ id: o.id, before: was });
  }
  if (tool === "add_memory") {
    const [m] = await q<{ id: string }>(
      `SELECT id FROM memories WHERE campaign_id = $1 AND id > $2 AND right(content, length($3)) = $3 ORDER BY id DESC LIMIT 1`,
      [campaignId, before.mem, String(args.content ?? "")]
    );
    if (m) u.memory = Number(m.id);
  }
  return Object.keys(u).length ? u : undefined;
}

const saveSheet = (c: Character) =>
  q(`UPDATE characters SET sheet = $1, updated_at = now() WHERE id = $2`, [JSON.stringify(dehydrateSheet(c.sheet)), c.id]);

async function applyUndo(campaignId: string, u: ScribeUndo): Promise<void> {
  if (u.chars?.length) {
    const rows = await hydrateSheets(
      await q<Character>(`SELECT * FROM characters WHERE campaign_id = $1 AND id = ANY($2::uuid[])`, [campaignId, u.chars.map((c) => c.id)])
    );
    for (const c of rows) {
      revertSheet(c.sheet, u.chars.find((d) => d.id === c.id)!);
      await saveSheet(c);
    }
  }
  if (u.objectives?.length) {
    let list = await loadObjectives(campaignId);
    for (const { id, before } of u.objectives)
      list = !before ? list.filter((o) => o.id !== id) : list.some((o) => o.id === id) ? list.map((o) => (o.id === id ? before : o)) : [...list, before];
    await saveObjectives(campaignId, list);
  }
  if (u.memory) await q(`DELETE FROM memories WHERE id = $1 AND campaign_id = $2`, [u.memory, campaignId]);
}

/**
 * Desfaz o efeito `index` aplicado depois da narração `messageId`. Só o do último turno: o "gerar novamente" volta à foto
 * de antes dele e apaga a narração junto com a marca de desfeito. A marca é posta antes, numa gravação só: dois
 * cliques não desfazem duas vezes.
 */
export async function undoScribe(campaignId: string, messageId: number, index: number): Promise<string> {
  const [last] = await q<{ id: string | null; snap: string | null }>(
    `SELECT (SELECT MAX(id) FROM messages WHERE campaign_id = $1 AND role = 'gm') AS id,
            (SELECT data->>'maxMessageId' FROM turn_snapshots WHERE campaign_id = $1) AS snap`,
    [campaignId]
  );
  if (Number(last?.id) !== messageId || (last?.snap != null && Number(last.snap) >= messageId))
    throw new FixError("Só dá para desfazer o registro do último turno.");
  const [row] = await q<{ entry: ScribeEntry }>(
    `UPDATE messages SET meta = jsonb_set(meta, ARRAY['scribe', $4, 'undone'], 'true')
     WHERE id = $2 AND campaign_id = $1 AND meta->'scribe'->$3::int ? 'undo'
       AND NOT COALESCE((meta->'scribe'->$3::int->>'undone')::boolean, false)
     RETURNING meta->'scribe'->$3::int AS entry`,
    [campaignId, messageId, index, String(index)]
  );
  if (!row) {
    const [had] = await q<{ undone: boolean | null }>(`SELECT (meta->'scribe'->$2::int->>'undone')::boolean AS undone FROM messages WHERE id = $1`, [messageId, index]);
    throw new FixError(had?.undone ? "Esse registro já foi desfeito." : "Esse registro não tem o que desfazer.");
  }
  try {
    await applyUndo(campaignId, row.entry.undo!);
  } catch (e) {
    await q(`UPDATE messages SET meta = jsonb_set(meta, ARRAY['scribe', $2, 'undone'], 'false') WHERE id = $1`, [messageId, String(index)]);
    throw e;
  }
  // o que ficou registrado (meta.notes) perde o desfeito
  await q(
    `UPDATE messages SET meta = jsonb_set(meta, '{notes}', COALESCE((SELECT jsonb_agg(e->'note') FROM jsonb_array_elements(meta->'scribe') e
       WHERE NOT COALESCE((e->>'undone')::boolean, false)), '[]'::jsonb)) WHERE id = $1`,
    [messageId]
  );
  await record(campaignId, "desfazer", row.entry.tool, row.entry.summary, "scribe", messageId);
  return row.entry.summary;
}

// ---------- edição manual da ficha do jogador ----------

export type Fix =
  | { fix: "resource"; resource: string; current?: number; max?: number }
  | { fix: "item"; name: string; qty: number } // qty > 0 adiciona, < 0 tira
  | { fix: "mastery"; ability: string; progress: number }
  | { fix: "xp"; xp: number }
  | { fix: "objective"; objective: string; status: ObjectiveStatus };

const STATUS_TEXT: Record<ObjectiveStatus, string> = {
  oferecida: "oferecida", aberto: "aberta", concluido: "concluída", perdido: "perdida", cancelado: "cancelada",
};

/**
 * Status de missão corrigido pelo jogador. xpGiven = XP que a missão deu e não devolveu: concluir dá a XP só se não há
 * xpGiven; sair de concluída devolve a que deu. Concluída antes de existir xpGiven (valor desconhecido) fica com 0:
 * não devolve nem dá de novo.
 */
export function fixStatus(o: Objective, status: ObjectiveStatus, now: number | undefined, xpNow: number | null): { next: Objective; xp: number; money: number } {
  const next: Objective = { ...o, status };
  if (status === "aberto") delete next.closedAt;
  else next.closedAt = now ?? 0;
  let xp = 0;
  if (o.status === "concluido") {
    xp = o.xpGiven ? -o.xpGiven : 0;
    if (o.xpGiven) delete next.xpGiven;
    else if (o.xpSize) next.xpGiven = 0;
  }
  if (status === "concluido" && next.xpGiven === undefined && xpNow) {
    xp = xpNow;
    next.xpGiven = xpNow;
  }
  // pagamento: mesma regra (sair de concluída devolve o que pagou; concluir paga uma vez)
  let money = 0;
  if (o.status === "concluido" && o.payGiven) (money = -o.payGiven), delete next.payGiven;
  if (status === "concluido" && !next.payGiven && o.pay) (money = o.pay), (next.payGiven = o.pay);
  return { next, xp, money };
}

const int = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : Number.isFinite(Number(v)) ? Math.round(Number(v)) : NaN);

/** Correção manual na ficha do jogador, pelas mesmas ferramentas do jogo. Devolve o resumo (o que o Mestre lê). */
export async function applyFix(campaignId: string, body: Fix): Promise<string> {
  const [campaign] = await q<Campaign>(`SELECT * FROM campaigns WHERE id = $1`, [campaignId]);
  if (!campaign) throw new FixError("Campanha não encontrada.");
  const [player] = await hydrateSheets(await q<Character>(`SELECT * FROM characters WHERE campaign_id = $1 AND kind = 'player' LIMIT 1`, [campaignId]));
  if (!player) throw new FixError("Personagem do jogador não encontrado.");
  const [scene] = await q<Scene>(`SELECT * FROM scenes WHERE campaign_id = $1 AND is_current ORDER BY seq DESC LIMIT 1`, [campaignId]);
  const chips: string[] = [];
  const ctx: ToolContext = { campaign, scene, emit: (e) => void (e.type === "tool" && chips.push(e.summary)) };
  const run = async (tool: string, args: Record<string, unknown>) => {
    const out = await executeGmTool(tool, { character: player.name, ...args }, ctx);
    if (/^Erro|não existe|precisa|Nada mudou|recusad/.test(out)) throw new FixError(out.replace(/^Erro:\s*/, ""));
  };
  const s = player.sheet;
  const rs = campaign.ruleset;
  let summary: string;
  switch (body.fix) {
    case "resource": {
      const r = s.resources[body.resource];
      if (!r) throw new FixError("Esse recurso não está na ficha.");
      const cur = int(body.current);
      const max = int(body.max);
      if (Number.isNaN(cur) || Number.isNaN(max)) throw new FixError("Use números.");
      // mesma conta do update_resource: máximo (mínimo 1) e depois o atual, entre 0 e o máximo
      const newMax = max !== undefined ? Math.max(1, max) : r.max;
      const newCur = Math.max(0, Math.min(cur ?? r.current, newMax));
      if (newCur === r.current && newMax === r.max) throw new FixError("Nada mudou.");
      const label = rs.resources.find((x) => x.key === body.resource)?.label || body.resource;
      summary = `${label} ${r.current}/${r.max} → ${newCur}/${newMax}`;
      await run("update_resource", { resource: body.resource, set: newCur, ...(newMax !== r.max && { setMax: newMax }) });
      break;
    }
    case "item": {
      const name = String(body.name || "").trim();
      const qty = int(body.qty);
      if (!name || !qty) throw new FixError("Informe o item e a quantidade.");
      if (qty > 0) {
        await run("add_item", { name, qty });
        summary = `adicionou ${qty}x ${name}`;
      } else {
        const have = s.inventory.find((i) => i.name.toLowerCase() === name.toLowerCase());
        if (!have) throw new FixError(`${player.name} não tem "${name}".`);
        await run("remove_item", { name: have.name, qty: -qty });
        summary = `removeu ${Math.min(-qty, have.qty)}x ${have.name}`;
      }
      break;
    }
    case "mastery": {
      const a = s.abilities.find((x) => x.name.toLowerCase() === String(body.ability || "").toLowerCase());
      const p = int(body.progress);
      if (!a) throw new FixError("Essa técnica não está na ficha.");
      if (p === undefined || Number.isNaN(p) || p < 0 || p > 100) throw new FixError("Domínio de 0 a 100.");
      if (p === (a.progress ?? 0)) throw new FixError("Nada mudou.");
      summary = `domínio de ${a.name} ${a.progress ?? 0}% → ${p}%`;
      await run("update_ability_progress", { name: a.name, set: p });
      break;
    }
    case "xp": {
      const xp = int(body.xp);
      if (xp === undefined || Number.isNaN(xp) || xp < 0) throw new FixError("XP precisa ser um número a partir de 0.");
      if (xp === s.xp) throw new FixError("Nada mudou.");
      await run("grant_xp", { amount: xp - s.xp, reason: "corrigido pelo jogador" });
      const level = chips.find((c) => c.startsWith("⬆"))?.replace(/^⬆\s*/, "");
      summary = `XP ${s.xp} → ${xp}${level ? ` (${level})` : ""}`;
      break;
    }
    case "objective": {
      const status = body.status;
      if (!["aberto", "concluido", "cancelado"].includes(status)) throw new FixError("Status: aberto, concluido ou cancelado.");
      const list = await loadObjectives(campaignId);
      const o = list.find((x) => x.id === body.objective);
      if (!o) throw new FixError("Missão não encontrada.");
      if (o.status === status) throw new FixError("Nada mudou.");
      const now = getClock(campaign.state)?.minutes;
      // aberta com o prazo vencido viraria perdida no próximo avanço do relógio
      if (status === "aberto" && o.deadlineMinutes !== undefined && now !== undefined && o.deadlineMinutes < now)
        throw new FixError(`O prazo já passou (${formatClock(o.deadlineMinutes)}): conclua, cancele ou peça um prazo novo ao Mestre.`);
      const { next, xp, money } = fixStatus(o, status, now, objectiveXp(o, rs, getTable(campaign.state), s.xp));
      await saveObjectives(campaignId, list.map((x) => (x === o ? next : x)));
      if (xp) await run("grant_xp", { amount: xp, reason: `missão: ${o.title}` });
      // devolver mais do que sobrou zera o saldo (o resto já foi gasto na história)
      if (money && rs.currency) {
        const amount = money < 0 ? -Math.min(-money, s.money ?? 0) : money;
        if (amount) await run("update_money", { amount, unit: rs.currency.units.at(-1)!.key, reason: `missão: ${o.title}` });
      }
      summary = `missão ${o.id} "${o.title}" ${STATUS_TEXT[o.status]} → ${STATUS_TEXT[status]}${xp ? ` (${xp > 0 ? "+" : ""}${xp} XP)` : ""}`;
      break;
    }
    default:
      throw new FixError("Correção desconhecida.");
  }
  await record(campaignId, "manual", body.fix, summary);
  return summary;
}

// ---------- o Mestre fica sabendo; medição ----------

async function record(campaignId: string, source: "manual" | "desfazer", kind: string, summary: string, agent: string | null = null, messageId: number | null = null) {
  await q(`INSERT INTO corrections (campaign_id, source, agent, kind, summary, message_id) VALUES ($1, $2, $3, $4, $5, $6)`, [
    campaignId, source, agent, kind, summary, messageId,
  ]);
  const text = (source === "desfazer" ? `desfez o registro: ${summary}` : summary).slice(0, 200);
  await q(`UPDATE campaigns SET state = jsonb_set(state, '{playerFixes}', COALESCE(state->'playerFixes', '[]'::jsonb) || $2::jsonb) WHERE id = $1`, [
    campaignId,
    JSON.stringify([{ at: Date.now(), text }]),
  ]);
}

/** Linha do contexto do Mestre com as correções desde o último turno ("" = nenhuma). */
export function playerFixesLine(state: Record<string, unknown> | null | undefined): string {
  const list = Array.isArray(state?.playerFixes) ? (state.playerFixes as { text: string }[]) : [];
  return list.length
    ? `\n--- O JOGADOR CORRIGIU A FICHA desde o seu último turno (erro de registro, não acontecimento da história: já está nas fichas, não narre como fato) ---\n${list.slice(-12).map((f) => f.text).join("; ")}`
    : "";
}

/** O turno que começou em `since` terminou: as correções anteriores a ele já chegaram ao Mestre e saem. */
export async function clearPlayerFixes(campaignId: string, since: number): Promise<void> {
  await q(
    `UPDATE campaigns SET state = jsonb_set(state, '{playerFixes}', COALESCE((SELECT jsonb_agg(f) FROM jsonb_array_elements(state->'playerFixes') f
       WHERE (f->>'at')::bigint >= $2), '[]'::jsonb)) WHERE id = $1 AND jsonb_array_length(COALESCE(state->'playerFixes', '[]'::jsonb)) > 0`,
    [campaignId, since]
  );
}
