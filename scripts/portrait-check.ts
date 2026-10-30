/**
 * Verificação dos retratos (lib/portrait.ts): grade do Pixel artista → SVG, validações e versão no banco.
 * Campanha temporária, sem IA. Rodar: npx tsx scripts/portrait-check.ts
 */
import assert from "node:assert/strict";
import { pool, q } from "../src/lib/db";
import { describe, gridToSvg, savePortrait } from "../src/lib/portrait";

const grid = (rows: string[], palette: Record<string, string> = { a: "#112233", b: "#AABBCC" }) => JSON.stringify({ palette, rows });
// 16×16: metade de cima transparente, embaixo faixas de a e b
const ROWS = Array.from({ length: 16 }, (_, y) => (y < 8 ? ".".repeat(16) : "aaaabbbbaaaa...."));

async function main() {
  // conversão: um path por cor, linhas mescladas, cores em minúsculas, nítido
  const svg = gridToSvg(grid(ROWS));
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges">'));
  assert.equal((svg.match(/<path /g) || []).length, 2, "um path por cor");
  assert.ok(svg.includes('fill="#aabbcc"'));
  assert.ok(svg.includes('<path fill="#112233" d="M0 8h4v1h-4zM8 8h4v1h-4z'), "corridas da mesma cor mescladas");
  assert.ok(!/<script|on\w+=|href/i.test(svg));

  // tolera cerca de código e texto em volta; linha 1-2 pixels curta vira transparente
  assert.equal(gridToSvg("```json\n" + grid(ROWS) + "\n```"), svg);
  const short = [...ROWS];
  short[10] = "aaaabbbbaaaa..";
  assert.equal(gridToSvg(grid(short)), svg);

  // recusa
  const bad = (raw: string, msg: RegExp) => assert.throws(() => gridToSvg(raw), msg);
  bad("sem json aqui", /JSON/);
  bad(grid(ROWS.slice(0, 10)), /16 a 64/);
  bad(grid(ROWS, { a: "red", b: "#000000" }), /Cor inválida/);
  bad(grid(ROWS, { a: "#112233\"/><script>", b: "#000000" }), /Cor inválida/);
  bad(grid(ROWS, { ab: "#112233", b: "#000000" }), /Cor inválida/);
  bad(grid(ROWS, { a: "#112233" }), /Paleta com 1/);
  bad(grid(ROWS.map((r, y) => (y === 3 ? "...." : r))), /Linha 4/);
  bad(grid(ROWS.map((r, y) => (y >= 8 ? r.replace(/b/g, "z") : r))), /fora da paleta/);
  bad(grid(Array(16).fill(".".repeat(16))), /quase vazio/);
  bad(JSON.stringify({ palette: { a: "#112233", b: "#000000" }, rows: [1, 2] }), /sem linhas/);

  // descrição: agnóstica, usa cargo e campos extras do ruleset
  const who = describe(
    { ruleset: { name: "Hogwarts", description: "Escola de magia.", ranks: [{ key: "y1", label: "Primeiranista" }], extraFields: [{ key: "casa", label: "Casa" }] } as never },
    { name: "Ana", kind: "npc", canon: false, sheet: { rank: "y1", extra: { casa: "Corvinal" } } as never, persona: { appearance: "cabelo ruivo" } }
  );
  assert.match(who, /Cenário: Hogwarts\. Escola de magia\./);
  assert.match(who, /Cargo: Primeiranista/);
  assert.match(who, /Casa: Corvinal/);
  assert.match(who, /Aparência: cabelo ruivo/);

  // banco: gravar de novo sobe a versão; apagar o personagem apaga o retrato
  const [c] = await q<{ id: string }>(`INSERT INTO campaigns (name, ruleset) VALUES ('[teste-retratos] check', '{}') RETURNING id`);
  try {
    const [ch] = await q<{ id: string }>(`INSERT INTO characters (campaign_id, kind, name) VALUES ($1, 'npc', 'Ana') RETURNING id`, [c.id]);
    await savePortrait(ch.id, "image/svg+xml", Buffer.from(svg));
    await savePortrait(ch.id, "image/svg+xml", Buffer.from(svg));
    const [p] = await q<{ version: number; data: Buffer }>(`SELECT version, data FROM portraits WHERE character_id = $1`, [ch.id]);
    assert.equal(p.version, 2);
    assert.equal(p.data.toString(), svg);
    await q(`DELETE FROM characters WHERE id = $1`, [ch.id]);
    assert.equal((await q(`SELECT 1 FROM portraits WHERE character_id = $1`, [ch.id])).length, 0);
    console.log("portrait-check: ok");
  } finally {
    await q(`DELETE FROM campaigns WHERE id = $1`, [c.id]);
    await pool().end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
