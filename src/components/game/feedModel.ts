// Funções puras da tela de jogo (sem React): blocos da narração, agrupamento do feed e fases do turno.
// Checagem: npx tsx scripts/game-screen-check.ts
import type { FeedItem } from "./useTurn";
import type { IconName } from "./Icon";

export type Block =
  | { kind: "p"; text: string }
  | { kind: "say"; name: string; line: string }
  | { kind: "list"; items: string[] };

/** Narração em blocos: parágrafos, falas (**Nome:** "fala") e listas (- item). Linha vazia só separa. */
export function narrationBlocks(text: string): Block[] {
  const out: Block[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const say = line.match(/^\*\*([^*]+?):\*\*\s*(.+)$/) ?? line.match(/^\*\*([^*]+?)\*\*:\s*(.+)$/);
    const item = line.match(/^[-•]\s+(.+)$/) ?? line.match(/^\*\s+(.+)$/);
    const last = out[out.length - 1];
    if (say) out.push({ kind: "say", name: say[1].trim(), line: say[2] });
    else if (item && last?.kind === "list") last.items.push(item[1]);
    else if (item) out.push({ kind: "list", items: [item[1]] });
    else out.push({ kind: "p", text: line });
  }
  return out;
}

/** Markdown mínimo da narração (negrito/itálico), com HTML escapado. */
export function md(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>");
}

// cor de quem fala: sempre um token do tema, escolhido pelo nome (a mesma pessoa tem sempre a mesma cor)
const SPEAKER_COLORS = ["var(--accent)", "var(--mode-dialogue)", "var(--mode-exploration)", "var(--info)", "var(--mode-downtime)", "var(--mode-training)"];
export function speakerColor(name: string): string {
  let h = 0;
  for (const ch of name.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return SPEAKER_COLORS[Math.abs(h) % SPEAKER_COLORS.length];
}

export type FeedGroup = { key: string; item: FeedItem; chips?: undefined } | { key: string; chips: FeedItem[]; item?: undefined };

/** Ações do Mestre (chips) seguidas viram um grupo só; o resto passa como está. */
export function groupFeed(feed: FeedItem[]): FeedGroup[] {
  const out: FeedGroup[] = [];
  for (const item of feed) {
    const last = out[out.length - 1];
    if (item.kind !== "chip") out.push({ key: item.key, item });
    else if (last?.chips) last.chips.push(item);
    else out.push({ key: item.key, chips: [item] });
  }
  return out;
}

export const MODE_LABEL: Record<string, string> = {
  exploration: "Exploração", dialogue: "Diálogo", battle: "Batalha", training: "Treinamento", downtime: "Descanso",
};

/** Texto do chip sem o emoji do servidor (a tela põe ícone), modo traduzido e sem travessão. */
export function chipText(content: string): string {
  return content
    .replace(/^\p{Extended_Pictographic}️?\s*/u, "")
    .replace(/^(exploration|dialogue|battle|training|downtime)\b/, (m) => MODE_LABEL[m])
    .replace(/\s+—\s+/g, " · ");
}

const TOOL_ICON: [RegExp, IconName][] = [
  [/resource/, "heart"],
  [/xp|rank|attribute/, "star"],
  [/item|inventory/, "bag"],
  [/abilit|train|mastery/, "spark"],
  [/npc_message/, "mail"],
  [/npc_talk/, "chat"],
  [/npc/, "people"],
  [/map/, "map"],
  [/scene|stage/, "pin"],
  [/time|clock/, "clock"],
  [/objective/, "flag"],
  [/memor/, "bookmark"],
  [/script/, "scroll"],
];
// chips sem name (versões antigas): o emoji do servidor diz o tipo
const EMOJI_ICON: [RegExp, IconName][] = [
  [/^🕐/u, "clock"], [/^📌/u, "bookmark"], [/^✨/u, "people"], [/^🎬/u, "pin"], [/^✉/u, "mail"],
  [/^📜/u, "scroll"], [/^⌛/u, "flag"], [/^⬆/u, "star"], [/^🏋/u, "spark"],
];
export function chipIcon(item: Pick<FeedItem, "name" | "content">): IconName {
  if (item.name) return TOOL_ICON.find(([re]) => re.test(item.name!))?.[1] ?? "dot";
  return EMOJI_ICON.find(([re]) => re.test(item.content))?.[1] ?? "dot";
}

/** Fases da espera do turno, na ordem em que costumam acontecer. */
export const PHASES = [
  { key: "think", label: "Pensando" },
  { key: "consult", label: "Consultando" },
  { key: "dice", label: "Dados" },
  { key: "write", label: "Escrevendo" },
] as const;
export type Phase = (typeof PHASES)[number]["key"];

const CONSULT_TOOLS = /search_memories|search_book|read_pages|get_script|get_npc|get_map/;

/** Fase indicada por um evento do turno (null = não muda). */
export function phaseOf(ev: { type: string; text?: string; name?: string }): Phase | null {
  if (ev.type === "status")
    return /mem[óo]r|livr|consult|busc/i.test(ev.text ?? "") ? "consult"
      : /dado|rol/i.test(ev.text ?? "") ? "dice"
      : /escrev|narr/i.test(ev.text ?? "") ? "write"
      : /pens|lend/i.test(ev.text ?? "") ? "think" : null;
  if (ev.type === "tool") return CONSULT_TOOLS.test(ev.name ?? "") ? "consult" : null;
  if (ev.type === "dice") return "dice";
  if (ev.type === "narration_delta" || ev.type === "narration") return "write";
  return null;
}

/** Fim de um texto para a retomada: sem markdown, cortado em palavra, com reticências na frente. */
export function excerpt(text: string, max = 240): string {
  const plain = text.replace(/\*\*([^*]+?)\*\*/g, "$1").replace(/\*([^*]+?)\*/g, "$1").replace(/\s+/g, " ").trim();
  if (plain.length <= max) return plain;
  const tail = plain.slice(-max - 1); // um caractere a mais: se for espaço, a primeira palavra está inteira
  return `…${tail.slice(tail.indexOf(" ") + 1)}`;
}

/** Rascunho do streaming sem negrito aberto no fim (o "**Nome" aparece quando fecha, sem asteriscos soltos). */
export function draftSafe(text: string): string {
  const cut = text.lastIndexOf("\n") + 1;
  const last = text.slice(cut);
  return (last.match(/\*\*/g)?.length ?? 0) % 2 ? text.slice(0, cut) + last.slice(0, last.lastIndexOf("**")) : text;
}
