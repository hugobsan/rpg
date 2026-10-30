import { formatClock } from "./clock";

/**
 * Missões, eventos e prazos da história (campaigns.state.objectives). Sem relação com os
 * marcos de domínio das habilidades (Ability.milestones). Só funções puras: a tela também usa.
 */
export type ObjectiveKind = "missao" | "evento" | "outro";
export type ObjectiveStatus = "aberto" | "concluido" | "perdido" | "cancelado";

export interface Objective {
  id: string;
  title: string;
  kind: ObjectiveKind;
  description: string;
  deadlineMinutes?: number; // minutos absolutos do relógio
  status: ObjectiveStatus;
  reward?: string;
  createdAt: number; // minutos do relógio (0 se ainda não havia relógio)
  closedAt?: number;
}

export const OBJECTIVE_KIND_LABEL: Record<ObjectiveKind, string> = { missao: "Missão", evento: "Evento", outro: "Outro" };

export function getObjectives(state: Record<string, unknown> | null | undefined): Objective[] {
  return Array.isArray(state?.objectives) ? (state.objectives as Objective[]) : [];
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

/** Bloco do contexto do Mestre: abertos com o tempo restante e perdidos nos últimos 3 dias. */
export function objectivesPromptBlock(list: Objective[], now: number | null): string {
  const open = list.filter((o) => o.status === "aberto");
  const lost = list.filter((o) => o.status === "perdido" && now !== null && (o.closedAt ?? 0) >= now - 3 * 1440);
  if (!open.length && !lost.length) return "";
  const line = (o: Objective) =>
    `[${o.id}] ${OBJECTIVE_KIND_LABEL[o.kind] || o.kind}: ${o.title}${o.description ? ` — ${o.description}` : ""}${
      o.deadlineMinutes !== undefined
        ? ` | prazo: ${formatClock(o.deadlineMinutes)}${now !== null ? ` (${formatRemaining(o.deadlineMinutes - now)})` : ""}`
        : " | sem prazo"
    }${o.reward ? ` | recompensa: ${o.reward}` : ""}`;
  return [
    "\n--- MISSÕES E PRAZOS (update_objective para concluir, cancelar ou mudar o prazo) ---",
    ...open.map(line),
    ...lost.map(
      (o) =>
        `PERDIDO desde ${formatClock(o.deadlineMinutes ?? o.closedAt ?? 0)}: [${o.id}] ${o.title}. Narre a consequência se ainda não narrou; não desfaça a perda.`
    ),
  ].join("\n");
}
