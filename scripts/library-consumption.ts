/**
 * Custo separado do rank no mundo naruto, sem IA: põe consumption (faixa de consumo) e costUnit nas habilidades da
 * biblioteca pelo mapa explícito de scripts/data/naruto-costs.json (as que não estão no mapa caem na faixa
 * equivalente ao rank e vão para o log); acrescenta abilityCosts.byConsumption e costControlLabel do preset nas
 * campanhas do mundo naruto; aplica os costMult dos NPCs canônicos do mapa (ficha e vínculo de técnica) nas
 * campanhas do mundo. O jogador fica como está. Idempotente; numa transação só.
 *
 *   DATABASE_URL=... npx tsx scripts/library-consumption.ts [--dry-run]
 */
import fs from "node:fs";
import path from "node:path";
import { pool } from "../src/lib/db";
import type { LibraryAbility, Ruleset, StoredSheet } from "../src/lib/types";

if (!process.env.DATABASE_URL) throw new Error("Defina DATABASE_URL (sem ele o db.ts usaria o banco padrão).");
const dry = process.argv.includes("--dry-run");
const PRESET = JSON.parse(fs.readFileSync(path.join(process.cwd(), "naruto-ruleset.json"), "utf-8")) as Ruleset;
type Spec = { consumption?: string; costUnit?: string; costFree?: boolean };
const MAP = JSON.parse(fs.readFileSync(path.join(process.cwd(), "scripts/data/naruto-costs.json"), "utf-8")) as {
  abilities: Record<string, Spec>;
  rankFallback: Record<string, string>;
  characters: Record<string, { costMult?: number; abilities?: Record<string, number>; why?: string }>;
};
const bands = new Set(PRESET.abilityCosts!.byConsumption!.map((b) => b.key));
for (const [n, s] of Object.entries(MAP.abilities)) if (s.consumption && !bands.has(s.consumption)) throw new Error(`${n}: faixa "${s.consumption}" não existe no preset`);

async function main() {
  const c = await pool().connect();
  try {
    await c.query("BEGIN");
    const camps = (await c.query<{ id: string; ruleset: Ruleset }>(`SELECT id, ruleset FROM campaigns`)).rows.filter((x) => x.ruleset.world === "naruto");
    for (const camp of camps) {
      const ac = camp.ruleset.abilityCosts;
      if (ac && !ac.byConsumption?.length) {
        await c.query(`UPDATE campaigns SET ruleset = jsonb_set(ruleset, '{abilityCosts,byConsumption}', $2::jsonb) WHERE id = $1`, [
          camp.id,
          JSON.stringify(PRESET.abilityCosts!.byConsumption),
        ]);
        console.log(`campanha "${camp.ruleset.name}": abilityCosts.byConsumption do preset`);
      }
      if (!camp.ruleset.costControlLabel) {
        await c.query(`UPDATE campaigns SET ruleset = ruleset || $2::jsonb WHERE id = $1`, [camp.id, JSON.stringify({ costControlLabel: PRESET.costControlLabel })]);
        console.log(`campanha "${camp.ruleset.name}": costControlLabel "${PRESET.costControlLabel}"`);
      }
    }

    // biblioteca: mapa explícito; fora dele, a faixa do rank (log)
    const rows = (
      await c.query<{ id: string; name: string; data: LibraryAbility }>(
        `SELECT id, name, data FROM library WHERE world = 'naruto' AND kind = 'ability' AND deleted_at IS NULL ORDER BY name`
      )
    ).rows;
    const fallback: string[] = [];
    const table: string[] = [];
    let changed = 0;
    for (const r of rows) {
      const spec: Spec | undefined = MAP.abilities[r.name];
      let want: Spec;
      if (spec) want = spec;
      else if (r.data.costFree) want = {};
      else {
        want = { consumption: r.data.rank ? MAP.rankFallback[r.data.rank] : undefined };
        fallback.push(`${r.name} (rank ${r.data.rank ?? "-"} → ${want.consumption ?? "sem rank: fica sem faixa"})`);
      }
      const next: LibraryAbility = { ...r.data };
      if (want.costFree) {
        next.costFree = true;
        delete next.consumption;
        delete next.costUnit;
      } else if (!next.costFree) {
        if (want.consumption) next.consumption = want.consumption;
        if (want.costUnit) next.costUnit = want.costUnit;
        else delete next.costUnit;
      }
      table.push(`${r.name} | ${r.data.rank ?? "-"} | ${next.costFree ? "sem custo" : next.consumption ?? "-"} | ${next.costUnit ?? ""}`);
      if (JSON.stringify(next) !== JSON.stringify(r.data)) {
        await c.query(`UPDATE library SET data = $2 WHERE id = $1`, [r.id, JSON.stringify(next)]);
        changed++;
      }
    }
    console.log(`\nbiblioteca naruto: ${rows.length} habilidades, ${changed} alteradas\nnome | rank | consumo | unidade\n${table.join("\n")}`);
    console.log(`\nfora do mapa, pela faixa do rank (${fallback.length}): ${fallback.join("; ") || "nenhuma"}`);
    const missing = Object.keys(MAP.abilities).filter((n) => !rows.some((r) => r.name === n));
    if (missing.length) console.log(`no mapa e não na biblioteca (${missing.length}): ${missing.join(", ")}`);

    // NPCs canônicos: costMult da ficha e do vínculo (por nome da técnica na biblioteca)
    const byName = new Map(rows.map((r) => [r.name, Number(r.id)]));
    for (const camp of camps) {
      const chars = (
        await c.query<{ id: string; name: string; kind: string; sheet: StoredSheet }>(`SELECT id, name, kind, sheet FROM characters WHERE campaign_id = $1`, [camp.id])
      ).rows;
      for (const ch of chars) {
        const spec = MAP.characters[ch.name];
        if (!spec || ch.kind === "player") continue;
        const sheet = ch.sheet;
        const before = JSON.stringify(sheet);
        if (spec.costMult !== undefined) sheet.costMult = spec.costMult === 1 ? undefined : spec.costMult;
        const notes: string[] = [`ficha ×${spec.costMult ?? 1}`];
        for (const [abName, m] of Object.entries(spec.abilities ?? {})) {
          const a = sheet.abilities.find((x) => "ref" in x && x.ref === byName.get(abName));
          if (!a) {
            notes.push(`${abName}: não está na ficha`);
            continue;
          }
          a.costMult = m === 1 ? undefined : m;
          notes.push(`${abName} ×${m}`);
        }
        const after = JSON.stringify(sheet);
        if (after !== before) await c.query(`UPDATE characters SET sheet = $2, updated_at = now() WHERE id = $1`, [ch.id, after]);
        console.log(`${ch.name}: ${notes.join(", ")}${after === before ? " (já estava)" : ""} — ${spec.why ?? ""}`);
      }
    }
    await c.query(dry ? "ROLLBACK" : "COMMIT");
    console.log(dry ? "\nROLLBACK (dry-run)" : "\nCOMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
    await pool().end();
  }
}
main();
