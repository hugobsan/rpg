import { formatClock } from "./clock";
import { powerLevel, powerLevels } from "./progression";
import { xpRule } from "./table";
import type { Currency, Ruleset, TableRules } from "./types";

/**
 * Missões, eventos e prazos da história (campaigns.state.objectives). Sem relação com os
 * marcos de domínio das habilidades (Ability.milestones). Só funções puras: a tela também usa.
 */
export type ObjectiveKind = "missao" | "evento" | "outro";
// oferecida: proposta na história, o jogador ainda não aceitou (não vence pelo relógio; o prazo é informativo)
export type ObjectiveStatus = "oferecida" | "aberto" | "concluido" | "perdido" | "cancelado";
export type ObjectiveXpSize = "pequena" | "media" | "grande" | "excepcional";
export const OBJECTIVE_XP_SIZES: ObjectiveXpSize[] = ["pequena", "media", "grande", "excepcional"];

export interface Objective {
  id: string;
  title: string;
  kind: ObjectiveKind;
  description: string;
  deadlineMinutes?: number; // minutos absolutos do relógio
  status: ObjectiveStatus;
  reward?: string;
  giver?: string; // quem ofereceu (NPC), se houver
  xpSize?: ObjectiveXpSize; // XP dada ao concluir, pela regra de XP da mesa
  xp?: number; // só com excepcional: valor livre
  xpGiven?: number; // XP que a conclusão deu e não devolveu (0 = deu antes de existir este campo): não dá de novo
  pay?: number; // dinheiro do jogador ao concluir (a parte dele), na menor moeda do mundo
  payGiven?: number; // pagamento que a conclusão deu e não devolveu: não paga de novo
  createdAt: number; // minutos do relógio (0 se ainda não havia relógio)
  closedAt?: number;
  // aceita ou recusada pelo painel (Date.now): o Mestre reconhece na cena; sai quando o turno seguinte termina
  decidedAt?: number;
  scope?: ObjectiveScope; // main = missão de beat do arco principal; side = o resto (sem campo = side)
  arcId?: string;
  beatId?: string; // beat de onde veio (main) ou cuja pista ela traz (side do quadro)
  board?: boolean; // oferta do quadro de missões (código): fica no painel, sem o aviso na tela nem o Narrador
  domestic?: boolean; // doméstica rank D do quadro (no máximo uma por dia de jogo)
  proof?: string; // prova de técnica: nome da técnica que está no platô do treino
}

export type ObjectiveScope = "main" | "side";
export const scopeOf = (o: Objective): ObjectiveScope => o.scope ?? "side";

/** Modo de jogo (campaigns.state.play): em missão a ação é só pelas opções; exploração e conversa, texto livre. */
export interface Play {
  mode: "exploration" | "mission" | "conversation";
  beatId?: string; // só em missão principal: o beat que ela fecha
  objectiveId?: string;
  title?: string;
  scope?: ObjectiveScope;
}
export const getPlay = (state: Record<string, unknown> | null | undefined): Play => {
  const p = state?.play as Play | undefined;
  return p && typeof p === "object" && p.mode ? p : { mode: "exploration" };
};

export const OBJECTIVE_KIND_LABEL: Record<ObjectiveKind, string> = { missao: "Missão", evento: "Evento", outro: "Outro" };

export function getObjectives(state: Record<string, unknown> | null | undefined): Objective[] {
  return Array.isArray(state?.objectives) ? (state.objectives as Objective[]) : [];
}

/**
 * XP da missão ao concluir: pequena/media/grande = min/max/great% do que falta para o próximo nível
 * (no último nível, do último intervalo entre níveis), arredondado, mínimo 1; excepcional = o.xp; sem tamanho, null.
 */
export function objectiveXp(o: Objective, ruleset: Ruleset, table: TableRules, playerXp: number): number | null {
  if (!o.xpSize) return null;
  if (o.xpSize === "excepcional") return o.xp ?? null;
  const { next } = powerLevel(ruleset, playerXp);
  const levels = powerLevels(ruleset);
  const base = next ? next.xpRequired - playerXp : levels.length > 1 ? levels.at(-1)!.xpRequired - levels.at(-2)!.xpRequired : 0;
  const pct = xpRule(table)[o.xpSize === "pequena" ? "min" : o.xpSize === "media" ? "max" : "great"];
  return Math.max(1, Math.round((base * pct) / 100));
}

/**
 * Pagamento padrão da parte do jogador pelo tamanho, quando a oferta veio sem pay: o começo da faixa do rank nos preços
 * de referência do mundo (pequena = D, media = C, grande = B, excepcional = A; "rank D 5 mil a 50 mil; C 30 mil..."); sem faixa
 * legível, um décimo do saldo inicial ×1/2/4/8. Sem moeda: undefined.
 */
export function defaultPay(c: Currency | undefined, size: ObjectiveXpSize = "pequena"): number | undefined {
  if (!c) return undefined;
  const rank = { pequena: "D", media: "C", grande: "B", excepcional: "A" }[size];
  const m = c.prices?.match(new RegExp(`(?:\\brank\\s+|[;,:]\\s*)${rank}\\s+([\\d.,]+)\\s*(mil|milh[aãoõ]+)?`, "i"));
  if (m) {
    const n = Number(m[1].replace(/\./g, "").replace(",", "."));
    const mult = !m[2] ? 1 : /^mil$/i.test(m[2]) ? 1000 : 1_000_000;
    if (n > 0) return Math.round(n * mult) * (c.units.at(-1)?.value ?? 1);
  }
  const k = { pequena: 1, media: 2, grande: 4, excepcional: 8 }[size];
  return Math.max(1, Math.round(((c.start ?? 1000) / 10) * k));
}

/** "faltam 2 dias e 3 h", "faltam 5 h e 20 min", "vence em 40 min", "venceu". */
export function formatRemaining(minutes: number): string {
  if (minutes <= 0) return "venceu";
  if (minutes < 60) return `vence em ${minutes} min`;
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  const parts = d ? [`${d} dia${d > 1 ? "s" : ""}`, h && `${h} h`] : [`${h} h`, m && `${m} min`];
  return `faltam ${parts.filter(Boolean).join(" e ")}`;
}

/** Abertos com prazo antes de `now` viram perdidos (no prazo exato ainda vale). */
export function expireObjectives(list: Objective[], now: number): { list: Objective[]; lost: Objective[] } {
  const lost: Objective[] = [];
  const next = list.map((o) => {
    if (o.status !== "aberto" || o.deadlineMinutes === undefined || o.deadlineMinutes >= now) return o;
    const l = { ...o, status: "perdido" as const, closedAt: now };
    lost.push(l);
    return l;
  });
  return { list: next, lost };
}

/**
 * Aceitar (aberto) ou recusar (cancelado) pelo painel uma oferecida, sem IA. Devolve a lista nova ou o erro.
 * Mesma regra do update_objective: aceitar com o prazo vencido viraria perdida no próximo avanço do relógio.
 */
export function decideOffer(list: Objective[], id: string, accept: boolean, now: number | undefined, at = Date.now()): Objective[] | string {
  const o = list.find((x) => x.id === id);
  if (!o) return "Missão não encontrada.";
  if (o.status !== "oferecida") return "Essa missão já foi decidida.";
  if (accept && o.deadlineMinutes !== undefined && now !== undefined && o.deadlineMinutes < now)
    return `O prazo já passou (${formatClock(o.deadlineMinutes)}). Se ainda vale, fale com o Mestre.`;
  const next: Objective = accept ? { ...o, status: "aberto", decidedAt: at } : { ...o, status: "cancelado", closedAt: now ?? 0, decidedAt: at };
  return list.map((x) => (x === o ? next : x));
}

/**
 * Bloco do contexto do Mestre: oferecidas, abertos com o tempo restante e perdidos nos últimos 3 dias.
 * xpOf (objectiveXp com ruleset, mesa e XP do jogador) põe a XP estimada na recompensa.
 */
export function objectivesPromptBlock(list: Objective[], now: number | null, xpOf?: (o: Objective) => number | null, moneyOf?: (n: number) => string): string {
  const offered = list.filter((o) => o.status === "oferecida");
  const open = list.filter((o) => o.status === "aberto");
  const lost = list.filter((o) => o.status === "perdido" && now !== null && (o.closedAt ?? 0) >= now - 3 * 1440);
  const refused = list.filter((o) => o.status === "cancelado" && o.decidedAt !== undefined);
  // ponytail: as 30 últimas bastam para não repetir; título curto, sem descrição
  const done = list.filter((o) => o.status === "concluido" && o.kind === "missao").slice(-30);
  if (!offered.length && !open.length && !lost.length && !refused.length && !done.length) return "";
  const reward = (o: Objective) => {
    const xp = xpOf?.(o);
    const r = [o.reward, o.pay && moneyOf && `${moneyOf(o.pay)} para o jogador`, xp != null && `≈ ${xp} XP`].filter(Boolean).join(" + ");
    return r ? ` | recompensa: ${r}` : "";
  };
  const line = (o: Objective) =>
    `[${o.id}] ${OBJECTIVE_KIND_LABEL[o.kind] || o.kind}: ${o.title}${o.description ? ` — ${o.description}` : ""}${
      o.deadlineMinutes !== undefined
        ? ` | prazo: ${formatClock(o.deadlineMinutes)}${now !== null ? ` (${formatRemaining(o.deadlineMinutes - now)})` : ""}`
        : " | sem prazo"
    }${reward(o)}${o.giver ? ` | quem ofereceu: ${o.giver}` : ""}`;
  return [
    "\n--- MISSÕES E PRAZOS (update_objective para concluir, cancelar ou mudar o prazo; oferecida: aberto quando o jogador aceitar, cancelado se recusar) ---",
    ...offered.map((o) => `OFERECIDA, o jogador ainda não aceitou: ${line(o)}`),
    ...open.map((o) => (o.decidedAt !== undefined ? `${line(o)} (o jogador aceitou pelo painel: reconheça na cena se ainda não reconheceu)` : line(o))),
    ...refused.map((o) => `RECUSADA pelo jogador no painel: [${o.id}] ${o.title}. Reconheça na cena se ainda não reconheceu (quem ofereceu reage à recusa).`),
    ...lost.map(
      (o) =>
        `PERDIDO desde ${formatClock(o.deadlineMinutes ?? o.closedAt ?? 0)}: [${o.id}] ${o.title}. Narre a consequência se ainda não narrou; não desfaça a perda.`
    ),
    done.length
      ? `Missões que o jogador JÁ CUMPRIU: ${done.map((o) => o.title).join("; ")}. Não ofereça uma delas de novo como se fosse inédita. Se uma voltar (cliente que retorna, problema que reapareceu, rotina da vila), que seja por um motivo da história e com o mundo lembrando que já aconteceu.`
      : "",
  ].filter(Boolean).join("\n");
}
