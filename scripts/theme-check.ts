// Checagem do tema por campanha (sem banco, sem IA): npx tsx scripts/theme-check.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import { campaignTheme, inferTheme, THEMES } from "../src/lib/theme";

const rs = (name: string, extra: Record<string, unknown> = {}) => ({ name, description: "", ...extra });
const camp = (ruleset: Record<string, unknown>, state: Record<string, unknown> = {}) =>
  ({ ruleset, state }) as unknown as Parameters<typeof campaignTheme>[0];

// inferência pelo nome do ruleset
assert.equal(inferTheme(rs("Mundo Shinobi (Naruto)")), "shinobi");
assert.equal(inferTheme(rs("Cyberpunk 2077: Night City")), "neon");
assert.equal(inferTheme(rs("Star Wars: Orla Exterior")), "estelar");
assert.equal(inferTheme(rs("Chamado de Cthulhu")), "gotico");
assert.equal(inferTheme(rs("Dungeons & Dragons 5e")), "arcano");
assert.equal(inferTheme(rs("Velho Oeste")), undefined);
// palavras comuns não disparam tema
assert.equal(inferTheme(rs("Piratas", { description: "Navegação e espaço no porão" })), undefined);
assert.equal(inferTheme(rs("Detetives", { description: "uma sociedade oculta" })), undefined);

// precedência: escolha da campanha > theme do ruleset > inferência > padrão
assert.equal(campaignTheme(camp(rs("Mundo Shinobi (Naruto)"), { theme: "neon" })), "neon");
assert.equal(campaignTheme(camp(rs("Mundo Shinobi (Naruto)", { theme: "gotico" }))), "gotico");
assert.equal(campaignTheme(camp(rs("Mundo Shinobi (Naruto)", { theme: "inexistente" }))), "shinobi");
assert.equal(campaignTheme(camp(rs("Velho Oeste"), { theme: "xyz" })), "chronicle");
assert.equal(campaignTheme(null), "chronicle");

// o preset de Naruto declara o tema
assert.equal(JSON.parse(fs.readFileSync("naruto-ruleset.json", "utf8")).theme, "shinobi");

// todo tema da lista tem bloco em globals.css
const css = fs.readFileSync("src/app/globals.css", "utf8");
for (const t of THEMES) assert.ok(css.includes(`[data-theme="${t.key}"]`), `falta [data-theme="${t.key}"] em globals.css`);

console.log("theme-check ok");
