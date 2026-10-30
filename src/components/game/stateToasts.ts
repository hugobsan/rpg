// Avisos (toasts) a partir da diferença entre dois estados da campanha, depois de cada recarga.
// Puro: a tela chama toast() com o resultado. Checagem: npx tsx scripts/game-screen-check.ts
import type { CampaignView } from "@/lib/campaignView";
import type { ToastKind } from "@/components/ui/Toast";
import { formatClock, formatDuration, getClock } from "@/lib/clock";
import { getObjectives, OBJECTIVE_KIND_LABEL } from "@/lib/objectives";
import { attributePoints, powerLevel } from "@/lib/progression";

export interface StateToast { text: string; kind: ToastKind; title?: string }

export const MAX_TOASTS = 4; // o Toaster mostra 4 de cada vez; ficam os mais importantes
export const TIME_JUMP = 180; // minutos: salto de tempo que merece aviso
const HEALTH = /^(hp|pv|vida|sa[uú]de|health)$/i;

const signed = (n: number) => (n > 0 ? `+${n}` : `−${-n}`);
/** "A", "A e B", "A, B e C" */
const joinNames = (names: string[]) =>
  names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} e ${names[names.length - 1]}`;

export function stateToasts(prev: CampaignView, next: CampaignView): StateToast[] {
  if (prev.campaign.id !== next.campaign.id) return [];
  const out: StateToast[] = []; // em ordem de importância
  const r = next.campaign.ruleset;
  const was = prev.characters.find((c) => c.kind === "player")?.sheet;
  const now = next.characters.find((c) => c.kind === "player")?.sheet;

  if (was && now) {
    const lvBefore = powerLevel(r, was.xp ?? 0).level;
    const lvAfter = powerLevel(r, now.xp ?? 0).level;
    if (lvAfter && lvAfter.key !== lvBefore?.key && (now.xp ?? 0) > (was.xp ?? 0))
      out.push({ kind: "sucesso", title: "Nível de poder", text: `Você alcançou ${lvAfter.label}` });
    if (now.rank && now.rank !== was.rank)
      out.push({ kind: "sucesso", title: "Novo cargo", text: r.ranks.find((k) => k.key === now.rank)?.label ?? now.rank });
  }

  // missões: novas, concluídas, perdidas, canceladas
  const before = new Map(getObjectives(prev.campaign.state).map((o) => [o.id, o]));
  for (const o of getObjectives(next.campaign.state)) {
    const old = before.get(o.id);
    const kind = OBJECTIVE_KIND_LABEL[o.kind] ?? "Missão";
    if (!old && o.status === "aberto") out.push({ kind: "info", title: `${kind} nova`, text: o.title });
    else if (old && old.status !== o.status) {
      if (o.status === "concluido") out.push({ kind: "sucesso", title: `${kind} concluída`, text: o.title });
      else if (o.status === "perdido") out.push({ kind: "dano", title: "Prazo perdido", text: o.title });
      else if (o.status === "cancelado") out.push({ kind: "info", title: `${kind} cancelada`, text: o.title });
    }
  }

  if (was && now) {
    // recursos: vida num aviso (dano/cura), os outros juntos (gasto/recuperação)
    const health: string[] = [];
    const other: string[] = [];
    let hurt = false;
    let spent = false;
    for (const def of r.resources) {
      const a = was.resources?.[def.key];
      const b = now.resources?.[def.key];
      if (!a || !b || a.current === b.current) continue;
      const d = b.current - a.current;
      const part = `${signed(d)} ${def.label} (${b.current}/${b.max})`;
      if (HEALTH.test(def.key) || HEALTH.test(def.label)) {
        health.push(part);
        hurt ||= d < 0;
      } else {
        other.push(part);
        spent ||= d < 0;
      }
    }
    if (health.length) out.push({ kind: hurt ? "dano" : "cura", text: health.join(" · ") });
    if (other.length) out.push({ kind: spent ? "info" : "cura", text: other.join(" · ") });

    const xp = (now.xp ?? 0) - (was.xp ?? 0);
    if (xp > 0) {
      const pts = attributePoints(r, now).earned - attributePoints(r, was).earned;
      out.push({ kind: "xp", text: `+${xp} XP${pts > 0 ? ` · ${pts} ponto${pts > 1 ? "s" : ""} livre${pts > 1 ? "s" : ""} de atributo` : ""}` });
    }

    const known = new Set(was.abilities?.map((a) => a.name.toLowerCase()));
    const learned = now.abilities?.filter((a) => !known.has(a.name.toLowerCase())).map((a) => a.name) ?? [];
    if (learned.length) out.push({ kind: "sucesso", title: "Aprendeu", text: joinNames(learned) });

    // inventário por nome
    const qty = new Map<string, number>();
    for (const i of was.inventory ?? []) qty.set(i.name.toLowerCase(), -i.qty);
    const names = new Map<string, string>();
    for (const i of now.inventory ?? []) {
      qty.set(i.name.toLowerCase(), (qty.get(i.name.toLowerCase()) ?? 0) + i.qty);
      names.set(i.name.toLowerCase(), i.name);
    }
    for (const i of was.inventory ?? []) if (!names.has(i.name.toLowerCase())) names.set(i.name.toLowerCase(), i.name);
    const items = [...qty].filter(([, d]) => d !== 0).map(([k, d]) => ({ d, text: `${signed(d)} ${names.get(k)}` }));
    if (items.length)
      out.push({ kind: items.every((i) => i.d > 0) ? "sucesso" : "info", title: "Inventário", text: items.map((i) => i.text).join(" · ") });
  }

  // NPCs que entraram ou saíram de cena (NPC novo já em cena conta como entrada)
  const npcBefore = new Map(prev.characters.filter((c) => c.kind === "npc").map((c) => [c.id, c.active]));
  const came: string[] = [];
  const left: string[] = [];
  for (const c of next.characters) {
    if (c.kind !== "npc") continue;
    const wasActive = npcBefore.get(c.id) ?? false;
    if (c.active && !wasActive) came.push(c.name);
    else if (!c.active && wasActive) left.push(c.name);
  }
  if (came.length) out.push({ kind: "info", text: `${joinNames(came)} ${came.length > 1 ? "entraram" : "entrou"} em cena` });
  if (left.length) out.push({ kind: "info", text: `${joinNames(left)} ${left.length > 1 ? "saíram" : "saiu"} de cena` });

  const t0 = getClock(prev.campaign.state)?.minutes;
  const t1 = getClock(next.campaign.state)?.minutes;
  if (t0 !== undefined && t1 !== undefined && t1 - t0 >= TIME_JUMP)
    out.push({ kind: "info", title: "O tempo passou", text: `+${formatDuration(t1 - t0)} · ${formatClock(t1)}` });

  return out.slice(0, MAX_TOASTS);
}
