// Temas visuais por campanha (client-safe). As cores e fontes de cada um vivem em globals.css ([data-theme="..."]).
import type { Campaign } from "./types";

export const THEMES = [
  { key: "chronicle", label: "Chronicle", description: "Obsidiana e âmbar. Neutro, serve a qualquer cenário." },
  { key: "arcano", label: "Arcano", description: "Violeta profundo e ouro. Magia, fantasia clássica." },
  { key: "shinobi", label: "Shinobi", description: "Tinta sumi, papel washi e vermelhão. Ninjas, samurais, Japão feudal." },
  { key: "neon", label: "Neon", description: "Preto, ciano e magenta com scanlines. Cyberpunk, hackers, distopia." },
  { key: "estelar", label: "Estelar", description: "Ardósia fria e teal sob estrelas. Ficção científica, espaço." },
  { key: "gotico", label: "Gótico", description: "Carmesim, osso e névoa. Terror, vampiros, horror cósmico." },
] as const;

export type ThemeKey = (typeof THEMES)[number]["key"];
export const DEFAULT_THEME: ThemeKey = "chronicle";

const isTheme = (v: unknown): v is ThemeKey => THEMES.some((t) => t.key === v);

// palavra no nome/descrição do ruleset -> tema (a primeira regra que bater vence)
const HINTS: [RegExp, ThemeKey][] = [
  [/naruto|ninja|shinobi|samurai|ronin|bushido|japão|japan|feudal|konoha|wuxia/i, "shinobi"],
  [/cyber|neon|punk|hacker|matrix|netrunner|android|distop/i, "neon"],
  [/star ?wars|star ?trek|estelar|espacial|sideral|space|gal[áa]xi|planeta|\bnaves?\b|sci-?fi|fic[çc][ãa]o cient|expanse|dune|mass effect|alien/i, "estelar"],
  [/terror|horror|g[óo]tic|vampir|lovecraft|cthulhu|zumbi|zombie|assombra|dem[ôo]ni|sobrenatural/i, "gotico"],
  [/magia|m[áa]gic|arcan|fantasia|fantasy|d&d|dnd|dungeons|drag[ãa]o|dragon|feiti[çc]|wizard|\belf|tolkien|hogwarts|harry potter|tormenta/i, "arcano"],
];

/** Tema do ruleset: explícito, ou inferido pelo nome e descrição. */
export function inferTheme(ruleset: { name?: string; description?: string; theme?: string } | null | undefined): ThemeKey | undefined {
  if (!ruleset) return undefined;
  if (isTheme(ruleset.theme)) return ruleset.theme;
  const text = `${ruleset.name ?? ""} ${ruleset.description ?? ""}`;
  return HINTS.find(([re]) => re.test(text))?.[1];
}

/** Tema da campanha: escolha do jogador (state.theme) > ruleset (theme ou inferência) > padrão. */
export function campaignTheme(campaign: Pick<Campaign, "state" | "ruleset"> | null | undefined): ThemeKey {
  const chosen = campaign?.state?.theme;
  if (isTheme(chosen)) return chosen;
  return inferTheme(campaign?.ruleset) ?? DEFAULT_THEME;
}
