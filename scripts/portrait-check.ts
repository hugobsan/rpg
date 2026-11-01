/**
 * Verificação dos retratos (lib/portrait.ts): descrição do personagem e versão no banco.
 * Campanha temporária, sem IA. Rodar: npx tsx scripts/portrait-check.ts
 */
import assert from "node:assert/strict";
import { pool, q } from "../src/lib/db";
import { describe, savePortrait } from "../src/lib/portrait";

async function main() {
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
    const png = Buffer.from("retrato");
    await savePortrait(ch.id, "image/png", png);
    await savePortrait(ch.id, "image/png", png);
    const [p] = await q<{ version: number; data: Buffer }>(`SELECT version, data FROM portraits WHERE character_id = $1`, [ch.id]);
    assert.equal(p.version, 2);
    assert.equal(p.data.toString(), "retrato");
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
