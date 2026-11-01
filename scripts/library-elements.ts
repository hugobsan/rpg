/**
 * Preenche o elemento (Ruleset.abilityElements; Naruto: natureza do chakra) das habilidades que já estão na
 * biblioteca, sem IA: pelo nome ("Katon: ..."), pela tradução ("Liberação de Fogo") ou pelos requisitos.
 * Só grava quando há um elemento só; ambíguas e sem pista ficam no log. Também põe abilityElements do preset
 * nas campanhas do mundo naruto que ainda não têm. Idempotente.
 *
 *   DATABASE_URL=... npx tsx scripts/library-elements.ts [--dry-run]
 */
import fs from "node:fs";
import path from "node:path";
import { pool } from "../src/lib/db";
import type { LibraryAbility, Ruleset } from "../src/lib/types";

if (!process.env.DATABASE_URL) throw new Error("Defina DATABASE_URL (sem ele o db.ts usaria o banco padrão).");
const dry = process.argv.includes("--dry-run");
const PRESET = JSON.parse(fs.readFileSync(path.join(process.cwd(), "naruto-ruleset.json"), "utf-8")) as Ruleset;
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

// pistas por elemento: nome japonês e a tradução usada no padrão de nomes
const CLUES: Record<string, string[]> = {
  katon: ["katon", "liberacao de fogo"],
  suiton: ["suiton", "liberacao de agua"],
  futon: ["futon", "liberacao de vento"],
  doton: ["doton", "liberacao de terra"],
  raiton: ["raiton", "liberacao de relampago", "liberacao de raio"],
};
const found = (text: string) => Object.keys(CLUES).filter((k) => CLUES[k].some((c) => new RegExp(`\\b${c}\\b`).test(fold(text))));

async function main() {
  const c = await pool().connect();
  try {
    await c.query("BEGIN");
    const camps = await c.query<{ id: string; ruleset: Ruleset }>(`SELECT id, ruleset FROM campaigns`);
    for (const camp of camps.rows)
      if (camp.ruleset.world === "naruto" && !camp.ruleset.abilityElements?.length) {
        await c.query(`UPDATE campaigns SET ruleset = ruleset || $2::jsonb WHERE id = $1`, [camp.id, JSON.stringify({ abilityElements: PRESET.abilityElements })]);
        console.log(`campanha "${camp.ruleset.name}": abilityElements do preset`);
      }
    const rows = await c.query<{ id: string; name: string; data: LibraryAbility }>(
      `SELECT id, name, data FROM library WHERE world = 'naruto' AND kind = 'ability' AND NOT (data ? 'element') ORDER BY name`
    );
    const none: string[] = [];
    for (const r of rows.rows) {
      // o nome e a tradução decidem; os requisitos só quando o nome não diz nada
      const byName = found(`${r.name} ${r.data.translation ?? ""}`);
      const keys = byName.length ? byName : found(r.data.requirements ?? "");
      if (keys.length === 1) {
        await c.query(`UPDATE library SET data = data || $2::jsonb WHERE id = $1`, [r.id, JSON.stringify({ element: keys[0] })]);
        console.log(`#${r.id} ${r.name} -> ${keys[0]}`);
      } else if (keys.length > 1) console.log(`AMBÍGUA #${r.id} ${r.name}: ${keys.join(", ")} (não gravei)`);
      else none.push(r.name);
    }
    console.log(`sem elemento (${none.length}): ${none.join(", ")}`);
    await c.query(dry ? "ROLLBACK" : "COMMIT");
    console.log(dry ? "ROLLBACK (dry-run)" : "COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
    await pool().end();
  }
}
main();
