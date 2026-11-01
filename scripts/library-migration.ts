/**
 * Fase 3 da biblioteca como fonte única (docs/library-single-source.md): migra os dados e confere os
 * critérios A1–A7 e A13. Idempotente, numa transação só; nada é apagado de verdade (soft delete).
 *
 *   DATABASE_URL=postgres://rpg:...@localhost:5433/rpg_migtest npx tsx scripts/library-migration.ts            migra e confere
 *   ... npx tsx scripts/library-migration.ts --dry-run    migra, confere e desfaz (ROLLBACK)
 *   (só faz COMMIT se a verificação passar)
 *   ... npx tsx scripts/library-migration.ts --verify     só confere
 *
 * A4 e A7 comparam com o backup restaurado em BEFORE_URL (padrão: o mesmo servidor, banco rpg_before):
 *   docker cp backups/pre-library-migration-2026-11-01.dump rpg-pgvector:/tmp/pre-lib.dump
 *   docker exec rpg-pgvector createdb -U rpg rpg_before
 *   docker exec rpg-pgvector pg_restore -U rpg -d rpg_before --no-owner /tmp/pre-lib.dump
 */
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Pool, type PoolClient } from "pg";
import { db, pool } from "../src/lib/db";
import { dehydrateSheet, fallbackAbility, normalizeAbility, worldOf } from "../src/lib/library";
import { slugKey } from "../src/lib/table";
import type { Ability, LibraryAbility, Ruleset, StoredSheet } from "../src/lib/types";

// sem padrão de propósito: o db.ts cai no banco rpg quando DATABASE_URL falta
if (!process.env.DATABASE_URL) {
  console.error("Defina DATABASE_URL apontando para o banco a migrar.");
  process.exit(1);
}
const args = process.argv.slice(2);
const VERIFY_ONLY = args.includes("--verify");
const DRY = args.includes("--dry-run");
const BEFORE_URL = process.env.BEFORE_URL || Object.assign(new URL(process.env.DATABASE_URL), { pathname: "/rpg_before" }).toString();

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- JSON cru do banco
type Run = <T = Json>(sql: string, params?: unknown[]) => Promise<T[]>;
type Camp = { id: string; ruleset: Ruleset };
type Row = { id: number; world: string | null; kind: string; name: string; data: Json; canon: boolean; campaign_id: string | null; deleted: boolean };

const root = process.cwd();
const NAMES = JSON.parse(fs.readFileSync(path.join(root, "scripts/data/library-names.json"), "utf-8")) as {
  standard: string;
  renames: { from: string; name: string; translation: string | null }[];
  merges: { name: string; from: string[] }[];
  patches?: { name: string; why: string; set: Json }[]; // correções de conteúdo (texto pessoal, entrada vazia)
};
const PRESET = JSON.parse(fs.readFileSync(path.join(root, "naruto-ruleset.json"), "utf-8")) as Ruleset;
const NARUTO = PRESET.world || "naruto";

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();

// nome atual (ou já no padrão, para a segunda rodada) -> nome no padrão + tradução
const RENAME = new Map<string, { name: string; translation: string | null }>();
for (const m of NAMES.merges) for (const f of m.from) RENAME.set(fold(f), { name: m.name, translation: null });
for (const r of NAMES.renames) {
  RENAME.set(fold(r.name), r);
  RENAME.set(fold(r.from), r);
}
const mapped = (world: string, name: string) => (world === NARUTO && RENAME.get(fold(name))) || { name, translation: null };

/** Mundo de um ruleset antigo: o do preset Naruto se veio dele (pelo nome), senão o slug do nome. */
const worldFor = (r: Ruleset) => r.world || (r.name === PRESET.name ? NARUTO : slugKey(r.name));

// cost.amount 0 = não gasta recurso (mesma regra de normalizeAbility)
const freeCost = (cost: unknown) => {
  const a = (cost && typeof cost === "object" ? (cost as Json).amount : undefined) as unknown;
  return a !== undefined && a !== null && a !== "" && Number(a) === 0;
};

// Sharingan: técnica geral do dōjutsu (o que era só de Kakashi fica na persona e no campo kekkei_genkai dele)
const SHARINGAN: Partial<LibraryAbility> = {
  description:
    "Dōjutsu hereditário do clã Uchiha, despertado sob emoção intensa. Evolui de um a três tomoe e amplia a percepção visual: lê movimentos, enxerga o chakra e permite copiar técnicas observadas. Quem o recebe por transplante, sem ser Uchiha, não consegue desativá-lo e se desgasta mais ao usá-lo.",
  effect:
    "Com o olho ativo, por uma cena: contra alvo visível, acompanha selos e movimentos rápidos e antecipa ações observáveis (teste oposto de Ninjutsu contra Velocidade); o acerto ajuda a reagir, mas não supera os limites do corpo. Enxerga o fluxo de chakra e percebe genjutsu. Nos estágios mais altos, copia técnicas observadas que o usuário seja capaz de executar, que continuam com seus próprios requisitos e custos.",
  requirements: "Linhagem Uchiha ou olho Uchiha transplantado; o olho precisa estar descoberto e ativo.",
  users: "Clã Uchiha (Sasuke, Itachi, Obito, Madara) e Kakashi Hatake.",
  milestones: [
    { threshold: 0, description: "Um tomoe: percepção ampliada e instável; distingue detalhes com mais clareza, mas ainda não antecipa movimentos nem copia técnicas com confiança." },
    { threshold: 25, description: "Dois tomoe: lê movimentos e selos simples e antecipa ações observáveis, dentro dos limites de reação do usuário." },
    { threshold: 50, description: "Acompanhamento refinado de movimentos e cópia de técnicas compatíveis, sem ignorar requisitos nem dar domínio instantâneo." },
    { threshold: 75, description: "Três tomoe: domínio da leitura de movimentos, da percepção de chakra e do genjutsu ocular. O domínio não desperta o Mangekyō Sharingan." },
  ],
};

// ---------------------------------------------------------------- migração

async function migrate(c: PoolClient, log: (s: string) => void) {
  const run: Run = async (sql, p = []) => (await c.query(sql, p)).rows;
  // as junções passam por nomes repetidos; o índice volta no fim pelo schema.sql
  await run(`DROP INDEX IF EXISTS library_world_name_idx`);

  // 2 e 7. mundo, padrão de nomes e kit inicial de cada campanha
  const camps = await run<Camp>(`SELECT id, ruleset FROM campaigns ORDER BY created_at`);
  for (const camp of camps) {
    const r = camp.ruleset;
    const world = worldFor(r);
    const patch: Partial<Ruleset> = {};
    if (r.world !== world) patch.world = world;
    if (world === NARUTO && !r.abilityNaming) patch.abilityNaming = NAMES.standard;
    if (r.startingAbilities) {
      const kit = Object.fromEntries(
        Object.entries(r.startingAbilities).map(([k, list]) => [
          k,
          list.map((a) => {
            const m = mapped(world, a.name);
            const raw = { ...a, name: m.name, translation: m.translation ?? a.translation };
            return normalizeAbility(r, raw) ?? fallbackAbility(r, m.name, raw);
          }),
        ])
      );
      if (!isDeepStrictEqual(kit, r.startingAbilities)) {
        patch.startingAbilities = kit as Record<string, Ability[]>;
        for (const [k, list] of Object.entries(r.startingAbilities))
          list.forEach((a, i) => a.name !== kit[k][i].name && log(`kit ${k}: "${a.name}" -> "${kit[k][i].name}"`));
      }
    }
    if (Object.keys(patch).length) {
      Object.assign(r, patch);
      await run(`UPDATE campaigns SET ruleset = ruleset || $2::jsonb WHERE id = $1`, [camp.id, JSON.stringify(patch)]);
      log(`campanha "${r.name}": ${Object.keys(patch).join(", ")} gravados (world = ${world})`);
    }
    const set = await run(`UPDATE library SET world = $2 WHERE campaign_id = $1 AND world IS NULL RETURNING id`, [camp.id, world]);
    if (set.length) log(`biblioteca: ${set.length} linhas de "${r.name}" -> world ${world}`);
  }
  const lost = await run<{ id: string }>(`SELECT id FROM library WHERE world IS NULL`);
  if (lost.length) throw new Error(`linhas da biblioteca sem campanha e sem world: ${lost.map((x) => x.id).join(", ")}`);
  const campById = new Map(camps.map((x) => [x.id, x]));

  // 3 e 4. nomes, cost e Sharingan, em memória; grava cada linha mudada uma vez
  const rows = (await run<Row>(`SELECT id, world, kind, name, data, canon, campaign_id, deleted_at IS NOT NULL AS deleted FROM library ORDER BY id`)).map(
    (x) => ({ ...x, id: Number(x.id) })
  );
  const dirty = new Set<Row>();
  for (const row of rows) {
    if (row.kind !== "ability") continue;
    const d = row.data;
    if ("cost" in d) {
      if (freeCost(d.cost)) d.costFree = true;
      delete d.cost;
      dirty.add(row);
    }
    if (row.deleted) continue;
    const m = mapped(row.world!, row.name);
    if (m.name !== row.name) {
      log(`renomeada #${row.id}: "${row.name}" -> "${m.name}"`);
      row.name = m.name;
      dirty.add(row);
    }
    if (m.translation && d.translation !== m.translation) {
      d.translation = m.translation;
      dirty.add(row);
    }
    if (d.name !== row.name) {
      d.name = row.name;
      dirty.add(row);
    }
    const fix = row.world === NARUTO && NAMES.patches?.find((x) => fold(x.name) === fold(row.name));
    if (fix && Object.entries(fix.set).some(([k, v]) => !isDeepStrictEqual(d[k], v))) {
      log(`corrigida #${row.id} "${row.name}" (${fix.why}); antes: ${JSON.stringify(Object.fromEntries(Object.keys(fix.set).map((k) => [k, d[k]])))}`);
      Object.assign(d, fix.set);
      dirty.add(row);
    }
    if (row.world === NARUTO && fold(row.name) === "sharingan" && /Kakashi|Obito/.test(`${d.description} ${d.requirements}`)) {
      log(`Sharingan #${row.id} reescrito em termos gerais; texto antigo para revisão:\n${JSON.stringify(Object.fromEntries(Object.keys(SHARINGAN).map((k) => [k, d[k]])), null, 2)}`);
      Object.assign(d, SHARINGAN);
      dirty.add(row);
    }
  }

  // junções: mesmo nome (sem caixa/acento) no mesmo mundo -> fica a mais completa, as outras com deleted_at
  const mergedInto = new Map<number, number>();
  const groups = new Map<string, Row[]>();
  for (const row of rows.filter((x) => !x.deleted)) {
    const k = `${row.world}|${row.kind}|${fold(row.name)}`;
    groups.set(k, [...(groups.get(k) ?? []), row]);
  }
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const [keep, ...rest] = [...g].sort((a, b) => JSON.stringify(b.data).length - JSON.stringify(a.data).length || a.id - b.id);
    for (const r of rest) {
      const added = Object.keys(r.data).filter((k) => !(k in keep.data));
      keep.data = { ...r.data, ...keep.data };
      r.deleted = true;
      mergedInto.set(r.id, keep.id);
      dirty.add(keep);
      await run(`UPDATE library SET deleted_at = now() WHERE id = $1`, [r.id]);
      log(`junção: #${r.id} "${r.name}" -> #${keep.id} "${keep.name}" (soft delete${added.length ? `; campos levados: ${added.join(", ")}` : ""})`);
    }
  }
  for (const row of dirty) await run(`UPDATE library SET name = $2, data = $3 WHERE id = $1`, [row.id, row.name, JSON.stringify(row.data)]);

  // 5, 6 e 8. fichas (characters e turn_snapshots) -> { ref, progress }
  const live = new Map<string, Row>();
  for (const row of rows) if (!row.deleted && row.kind === "ability") live.set(`${row.world}|${fold(row.name)}`, row);
  const said = new Set<string>();
  const once = (k: string, s: string) => !said.has(k) && (said.add(k), log(s));

  const FIELDS = ["type", "rank", "damage", "requirements", "description", "effect", "milestones"];
  async function refFor(camp: Camp, a: Json, who: string): Promise<number | null> {
    if (typeof a.name !== "string" || !a.name.trim()) return null;
    const r = camp.ruleset;
    const world = worldOf(camp);
    const m = mapped(world, a.name);
    const raw = { ...a, name: m.name, translation: m.translation ?? a.translation };
    let row = live.get(`${world}|${fold(m.name)}`);
    if (!row) {
      const data = normalizeAbility(r, raw) ?? fallbackAbility(r, m.name, raw);
      const kit = Object.values(r.startingAbilities ?? {}).flat().some((k) => fold(k.name) === fold(m.name));
      const canon = !!r.canonBased && kit;
      const [ins] = await run<{ id: string }>(
        `INSERT INTO library (world, campaign_id, kind, name, data, canon, source) VALUES ($1,$2,'ability',$3,$4,$5,'gm') RETURNING id`,
        [world, camp.id, data.name, JSON.stringify(data), canon]
      );
      row = { id: Number(ins.id), world, kind: "ability", name: data.name, data: data as unknown as Json, canon, campaign_id: camp.id, deleted: false };
      live.set(`${world}|${fold(data.name)}`, row);
      log(`criada a partir da ficha de ${who}: #${row.id} "${data.name}" (canon ${canon})`);
      return row.id;
    }
    // a biblioteca vence; campo que só a ficha tem vai para a biblioteca, e o resto que difere fica no log
    const s = normalizeAbility(r, raw) as Json | null;
    if (!s) return row.id;
    const lib = row.data;
    const filled = FIELDS.filter((f) => s[f] !== undefined && (lib[f] === undefined || lib[f] === "" || (Array.isArray(lib[f]) && !(lib[f] as unknown[]).length)));
    if (filled.length) {
      for (const f of filled) lib[f] = s[f];
      await run(`UPDATE library SET data = $2 WHERE id = $1`, [row.id, JSON.stringify(lib)]);
      log(`#${row.id} "${row.name}": ${filled.join(", ")} levados da ficha de ${who} (a biblioteca não tinha)`);
    }
    for (const f of FIELDS) {
      const x = typeof s[f] === "string" ? (s[f] as string).trim() : JSON.stringify(s[f] ?? "");
      const y = typeof lib[f] === "string" ? (lib[f] as string).trim() : JSON.stringify(lib[f] ?? "");
      // ficha sem o campo não é diferença; normalizeAbility corta texto em 600: prefixo também não
      if (s[f] === undefined || x === y || (x.length >= 300 && y.startsWith(x)) || (y.length >= 300 && x.startsWith(y))) continue;
      once(`${row.id}|${f}|${x}`, `diferença ficha×biblioteca "${row.name}" (${who}) em ${f}: ficha «${x.slice(0, 160)}» × biblioteca «${y.slice(0, 160)}»`);
    }
    return row.id;
  }

  /** Converte a ficha no lugar; devolve se mudou. */
  async function convert(camp: Camp, sheet: StoredSheet | null, who: string): Promise<boolean> {
    if (!sheet || !Array.isArray(sheet.abilities)) return false;
    const before = JSON.stringify(sheet);
    const out: (Ability & { ref: number })[] = [];
    const kept: unknown[] = [];
    for (const a of sheet.abilities as Json[]) {
      const ref = typeof a.ref === "number" ? (mergedInto.get(a.ref) ?? a.ref) : await refFor(camp, a, who);
      if (ref === null) {
        log(`AVISO ${who}: habilidade sem nome mantida como está: ${JSON.stringify(a).slice(0, 120)}`);
        kept.push(a);
        continue;
      }
      const dup = out.find((o) => o.ref === ref);
      if (dup) {
        if (Number(a.progress ?? -1) > Number(dup.progress ?? -1)) dup.progress = a.progress as number;
        log(`${who}: repetida juntada na ref #${ref} (fica o maior progress: ${dup.progress})`);
        continue;
      }
      out.push({ ref, progress: a.progress as number | undefined } as Ability & { ref: number });
    }
    sheet.abilities = [...dehydrateSheet({ ...sheet, abilities: out }).abilities, ...(kept as Ability[])];
    const mastery = sheet.trainingLog?.mastery;
    if (mastery) {
      const world = worldOf(camp);
      const next: Record<string, number> = {};
      for (const [k, v] of Object.entries(mastery)) {
        const nk = mapped(world, k).name.toLowerCase(); // a chave é o nome em minúsculas (progression.ts)
        next[nk] = Math.max(next[nk] ?? 0, v); // ponytail: duas chaves que viram uma ficam com o maior ganho do dia
      }
      sheet.trainingLog!.mastery = next;
    }
    return JSON.stringify(sheet) !== before;
  }

  const chars = await run<{ id: string; campaign_id: string; name: string; sheet: StoredSheet }>(
    `SELECT id, campaign_id, name, sheet FROM characters ORDER BY campaign_id, canon DESC, kind DESC, name`
  );
  let n = 0;
  for (const ch of chars)
    if (await convert(campById.get(ch.campaign_id)!, ch.sheet, ch.name)) {
      await run(`UPDATE characters SET sheet = $2 WHERE id = $1`, [ch.id, JSON.stringify(ch.sheet)]);
      n++;
    }
  log(`fichas convertidas: ${n} de ${chars.length}`);

  const snaps = await run<{ campaign_id: string; data: { characters?: { name: string; sheet: StoredSheet }[] } }>(`SELECT campaign_id, data FROM turn_snapshots`);
  n = 0;
  for (const sn of snaps) {
    let changed = false;
    for (const ch of sn.data.characters ?? []) changed = (await convert(campById.get(sn.campaign_id)!, ch.sheet, `snapshot/${ch.name}`)) || changed;
    if (changed) {
      await run(`UPDATE turn_snapshots SET data = $2 WHERE campaign_id = $1`, [sn.campaign_id, JSON.stringify(sn.data)]);
      n++;
    }
  }
  log(`snapshots convertidos: ${n} de ${snaps.length}`);

  // 1 (fim). índice único e NOT NULL
  await run(fs.readFileSync(path.join(root, "src/lib/schema.sql"), "utf-8"));
  await run(`ALTER TABLE library ALTER COLUMN world SET NOT NULL`);
}

// ---------------------------------------------------------------- verificação

type Sheetish = { who: string; campaign: Camp; sheet: StoredSheet | null };

async function verify(run: Run, before: Run): Promise<boolean> {
  const results: [string, boolean, string[]][] = [];
  const check = (id: string, problems: string[], ok?: string) => results.push([id, problems.length === 0, problems.length ? problems : ok ? [ok] : []]);

  const camps = await run<Camp>(`SELECT id, ruleset FROM campaigns`);
  const campById = new Map(camps.map((c) => [c.id, c]));
  const lib = (await run<Row>(`SELECT id, world, kind, name, data, canon, campaign_id, deleted_at IS NOT NULL AS deleted FROM library`)).map((x) => ({ ...x, id: Number(x.id) }));
  const libById = new Map(lib.map((x) => [x.id, x]));
  const live = lib.filter((x) => !x.deleted);
  const chars = await run<{ id: string; name: string; campaign_id: string; sheet: StoredSheet }>(`SELECT id, name, campaign_id, sheet FROM characters`);
  const snaps = await run<{ campaign_id: string; data: { characters?: { name: string; sheet: StoredSheet }[] } }>(`SELECT campaign_id, data FROM turn_snapshots`);

  // A1/A2 (e A3 para os snapshots)
  const shape = (list: Sheetish[]) => {
    const a1: string[] = [];
    const a2: string[] = [];
    const warn: string[] = [];
    let total = 0;
    for (const { who, campaign, sheet } of list)
      for (const a of (Array.isArray(sheet?.abilities) ? sheet!.abilities : []) as Json[]) {
        total++;
        const extra = Object.keys(a).filter((k) => k !== "ref" && k !== "progress");
        if (typeof a.ref !== "number" || extra.length) {
          a1.push(`${who}: ${JSON.stringify(a).slice(0, 100)}`);
          continue;
        }
        const e = libById.get(a.ref);
        if (!e) a2.push(`${who}: ref #${a.ref} não existe`);
        else if (e.kind !== "ability" || e.world !== worldOf(campaign)) a2.push(`${who}: ref #${a.ref} é ${e.kind} do mundo ${e.world} (campanha: ${worldOf(campaign)})`);
        else if (e.deleted) warn.push(`${who}: ref #${a.ref} "${e.name}" está excluída`);
      }
    return { a1, a2, warn, total };
  };
  const cs = shape(chars.map((c) => ({ who: c.name, campaign: campById.get(c.campaign_id)!, sheet: c.sheet })));
  check("A1", cs.a1, `${cs.total} habilidades em ${chars.length} fichas, todas só { ref, progress }`);
  check("A2", cs.a2, `todas as ${cs.total} refs existem no mundo da campanha${cs.warn.length ? `; aviso: ${cs.warn.join("; ")}` : ""}`);
  const ss = shape(snaps.flatMap((s) => (s.data.characters ?? []).map((c) => ({ who: `snapshot/${c.name}`, campaign: campById.get(s.campaign_id)!, sheet: c.sheet }))));
  check("A3", [...ss.a1, ...ss.a2], `${ss.total} habilidades em ${snaps.length} snapshot(s): só { ref, progress }, refs válidas${ss.warn.length ? `; aviso: ${ss.warn.join("; ")}` : ""}`);

  // backup: o que era custo 0 deve virar costFree
  const bCamps = await before<Camp>(`SELECT id, ruleset FROM campaigns`);
  const bCampById = new Map(bCamps.map((c) => [c.id, c]));
  const bLib = await before<{ id: string; name: string; kind: string; data: Json }>(`SELECT id, name, kind, data FROM library`);
  const bChars = await before<{ id: string; name: string; campaign_id: string; sheet: StoredSheet }>(`SELECT id, name, campaign_id, sheet FROM characters`);

  // A4
  const a4: string[] = [];
  for (const e of lib) if (e.kind === "ability" && "cost" in e.data) a4.push(`#${e.id} "${e.name}" ainda tem cost`);
  for (const b of bLib) {
    if (b.kind !== "ability" || !freeCost(b.data.cost)) continue;
    const now = libById.get(Number(b.id));
    if (!now?.data.costFree) a4.push(`#${b.id} "${b.name}" tinha custo 0 e não tem costFree`);
  }
  for (const c of camps)
    for (const [k, list] of Object.entries(c.ruleset.startingAbilities ?? {}))
      for (const a of list) if ("cost" in a) a4.push(`kit ${k} "${a.name}" ainda tem cost`);
  for (const c of bCamps)
    for (const [k, list] of Object.entries(c.ruleset.startingAbilities ?? {}))
      list.forEach((a, i) => {
        if (freeCost((a as Json).cost) && !campById.get(c.id)?.ruleset.startingAbilities?.[k]?.[i]?.costFree) a4.push(`kit ${k} "${a.name}" tinha custo 0 e não tem costFree`);
      });
  const costFree = lib.filter((e) => e.kind === "ability" && !e.deleted && e.data.costFree).map((e) => e.name);
  check("A4", a4, `nenhuma entrada com cost; costFree em: ${costFree.join(", ")}`);

  // A5
  const a5: string[] = [];
  const [{ n: noWorld }] = await run<{ n: string }>(`SELECT count(*) n FROM library WHERE world IS NULL`);
  if (Number(noWorld)) a5.push(`${noWorld} linhas sem world`);
  const [col] = await run<{ is_nullable: string }>(`SELECT is_nullable FROM information_schema.columns WHERE table_name = 'library' AND column_name = 'world'`);
  if (col?.is_nullable !== "NO") a5.push(`library.world aceita NULL`);
  for (const c of camps.filter((c) => c.ruleset.name === PRESET.name)) {
    if (c.ruleset.world !== NARUTO) a5.push(`campanha "${c.ruleset.name}" com world ${c.ruleset.world}`);
    const wrong = lib.filter((e) => e.campaign_id === c.id && e.world !== NARUTO);
    if (wrong.length) a5.push(`${wrong.length} linhas da campanha atual fora de ${NARUTO}: ${wrong.map((e) => e.id).join(", ")}`);
  }
  const worlds = [...new Set(lib.map((e) => e.world))].join(", ");
  check("A5", a5, `toda linha tem world (${worlds}); coluna NOT NULL; campanha atual = ${NARUTO}`);

  // A6
  const a6: string[] = [];
  const abil = live.filter((e) => e.kind === "ability");
  for (const e of abil) if (/[()]/.test(e.name) || /de Kakashi|Três Tomoe/i.test(e.name)) a6.push(`#${e.id} "${e.name}" fora do padrão`);
  const nar = abil.filter((e) => e.world === NARUTO);
  for (const r of NAMES.renames) {
    if (fold(r.from) !== fold(r.name)) for (const e of nar.filter((e) => fold(e.name) === fold(r.from))) a6.push(`#${e.id} ainda com o nome antigo "${e.name}"`);
    for (const e of nar.filter((e) => fold(e.name) === fold(r.name))) {
      if (e.name !== r.name) a6.push(`#${e.id} "${e.name}" deveria ser "${r.name}"`);
      if (r.translation && e.data.translation !== r.translation) a6.push(`#${e.id} "${e.name}" sem a translation "${r.translation}"`);
    }
  }
  for (const m of NAMES.merges) {
    const n = nar.filter((e) => fold(e.name) === fold(m.name)).length;
    if (n > 1) a6.push(`junção "${m.name}": ${n} entradas vivas`);
  }
  const seen = new Map<string, number>();
  for (const e of live) {
    const k = `${e.world}|${e.kind}|${fold(e.name)}`;
    if (seen.has(k)) a6.push(`duplicada: "${e.name}" (#${seen.get(k)} e #${e.id})`);
    seen.set(k, e.id);
  }
  for (const c of camps)
    for (const [k, list] of Object.entries(c.ruleset.startingAbilities ?? {}))
      for (const a of list) if (worldOf(c) === NARUTO && mapped(NARUTO, a.name).name !== a.name) a6.push(`kit ${k}: "${a.name}" fora do padrão`);
  check("A6", a6, `${abil.length} habilidades vivas, ${NAMES.renames.length} renomes e ${NAMES.merges.length} junção(ões) do mapa conferidos; sem duplicadas`);

  // A7: mesmas habilidades (pelo mapa de nomes) e mesmo domínio, personagem a personagem
  const a7: string[] = [];
  const nowById = new Map(chars.map((c) => [c.id, c]));
  let compared = 0;
  for (const b of bChars) {
    const world = worldFor(bCampById.get(b.campaign_id)!.ruleset);
    const want = new Map<string, unknown>();
    for (const a of (b.sheet?.abilities ?? []) as Json[]) {
      const k = fold(mapped(world, String(a.name)).name);
      if (!want.has(k) || Number(a.progress ?? -1) > Number(want.get(k) ?? -1)) want.set(k, a.progress);
    }
    const now = nowById.get(b.id);
    if (!now) {
      a7.push(`${b.name}: personagem sumiu`);
      continue;
    }
    const got = new Map<string, unknown>();
    for (const a of (now.sheet?.abilities ?? []) as Json[]) got.set(fold(libById.get(a.ref as number)?.name ?? `#${a.ref}`), a.progress);
    for (const [k, p] of want) {
      if (!got.has(k)) a7.push(`${b.name}: perdeu "${k}"`);
      else if (got.get(k) !== p) a7.push(`${b.name}: "${k}" progress ${p} -> ${got.get(k)}`);
    }
    for (const k of got.keys()) if (!want.has(k)) a7.push(`${b.name}: ganhou "${k}"`);
    compared += want.size;
  }
  check("A7", a7, `${bChars.length} personagens, ${compared} habilidades: mesmo conjunto e mesmo progress do backup`);

  // A13
  const [{ n: tests }] = await run<{ n: string }>(`SELECT count(*) n FROM library WHERE world LIKE 'test-%'`);
  check("A13", Number(tests) ? [`${tests} linhas com world test-*`] : [], `zero linhas test-*`);

  console.log("\n=== verificação ===");
  for (const [id, ok, lines] of results) console.log(`${id} ${ok ? "PASSOU" : "FALHOU"}${lines.length ? ` — ${lines.join("\n     ")}` : ""}`);
  return results.every(([, ok]) => ok);
}

// ---------------------------------------------------------------- main

async function main() {
  const name = new URL(process.env.DATABASE_URL!).pathname.slice(1);
  console.log(`banco: ${name}${VERIFY_ONLY ? " (só verificação)" : DRY ? " (dry-run: ROLLBACK no fim)" : ""}; backup para comparar: ${new URL(BEFORE_URL).pathname.slice(1)}`);
  await db(); // 1. DDL do schema.sql (o mesmo que o app aplica ao iniciar)
  const beforePool = new Pool({ connectionString: BEFORE_URL, max: 2 });
  const before: Run = async (sql, p = []) => (await beforePool.query(sql, p as never[])).rows;
  const c = await pool().connect();
  let ok = false;
  try {
    const run: Run = async (sql, p = []) => (await c.query(sql, p as never[])).rows;
    if (VERIFY_ONLY) ok = await verify(run, before);
    else {
      await c.query("BEGIN");
      console.log("=== migração ===");
      await migrate(c, (s) => console.log(`- ${s}`));
      ok = await verify(run, before);
      // verificação com falha desfaz tudo
      await c.query(ok && !DRY ? "COMMIT" : "ROLLBACK");
      console.log(ok && !DRY ? "\nCOMMIT" : `\nROLLBACK (${DRY ? "dry-run" : "verificação falhou"})`);
    }
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
    await pool().end();
    await beforePool.end();
  }
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
