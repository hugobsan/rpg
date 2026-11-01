/**
 * Biblioteca como fonte única (docs/library-single-source.md, A8–A12), sem IA: o Criador de habilidades responde
 * por roteiro (rede falsa: entrada pronta, erro ou resposta atrasada) e os agentes, a chave e api_logs do banco não
 * são lidos nem mexidos. Confere:
 *   A8  custo cobrado em use_ability = byRank[rank] × multiplicador do domínio; 0 com costFree
 *   A9  add_ability sempre liga uma ref: da biblioteca, nova pelo Criador, Criador falhando (incomplete);
 *       Criador atrasado completa a entrada incompleta (mesmo id, sem duplicar)
 *   A10 edit_ability muda a entrada e a mudança aparece na ficha de duas campanhas do mesmo mundo; rename com colisão
 *   A11 exclusão = soft delete (some da lista e da busca; na ficha fica removed e use_ability funciona)
 *   A12 POST /api/campaigns põe kit e extras na biblioteca do mundo sem duplicar e a ficha recebe refs
 *   e a ida e volta dehydrateSheet/hydrateSheet (ordem, progress; gravado só { ref, progress }).
 * Campanhas em mundos test-<uuid>; campanhas e linhas desses mundos apagadas no fim (também em falha).
 * Rodar: npx tsx scripts/library-source-check.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { NextRequest } from "next/server";
import { DEFAULT_AGENTS } from "../src/lib/agents";
import { q } from "../src/lib/db";
import { blankSheet, normalizeRuleset, startingKit } from "../src/lib/ruleset";
import { NEW_ABILITY_MASTERY } from "../src/lib/progression";
import {
  dehydrateSheet, deleteLibrary, ensureLibraryAbility, findLibrary, getLibraryByIds, hydrateSheet, hydrateSheets, linkAbility, listLibrary, worldOf,
} from "../src/lib/library";
import { executeGmTool, type ToolContext } from "../src/lib/tools";
import { POST as createCampaign } from "../src/app/api/campaigns/route";
import type { Ability, Campaign, Character, LibraryAbility, LibraryEntry, Scene, Sheet, StoredSheet, TurnEvent } from "../src/lib/types";

// ---------- banco: o real, menos agentes, configurações de IA e api_logs ----------
const real = new Pool({ connectionString: process.env.DATABASE_URL || "postgres://rpg:rpg@localhost:5433/rpg", max: 4 });
const creatorRow = { ...DEFAULT_AGENTS.find((a) => a.id === "abilities")!, source: "openrouter" };
const g = global as unknown as { __pgPool?: unknown; __schemaReady?: Promise<boolean> };
g.__schemaReady = Promise.resolve(true);
g.__pgPool = {
  query(text: string, params: unknown[] = []) {
    if (/FROM settings WHERE key/.test(text) && params[0] === "openrouter") return { rows: [{ value: { apiKey: "k-teste" } }] };
    if (/FROM settings WHERE key/.test(text)) return { rows: [] };
    if (/SELECT source(, params)? FROM agents/.test(text)) return { rows: [{ source: "openrouter", params: {} }] };
    if (/INSERT INTO api_logs/.test(text)) return { rows: [] };
    if (/^\s*(INSERT INTO|UPDATE|DELETE FROM) agents/.test(text)) return { rows: [] }; // agentes do banco ficam como estão
    if (/SELECT \* FROM agents WHERE id/.test(text) && params[0] === "abilities") return { rows: [creatorRow] };
    return real.query(text, params);
  },
  connect: () => real.connect(),
  end: () => real.end(),
};

// ---------- rede: só o Criador de habilidades, por roteiro ----------
type Creator = (asked: string) => Response | Promise<Response>;
const failing: Creator = () => new Response("Criador fora do ar (roteiro)", { status: 503 });
let creator: Creator = failing;
const asked: string[] = [];
const made = (entry: Record<string, unknown>) =>
  Response.json({ choices: [{ message: { content: JSON.stringify({ items: [entry] }) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (!String(input).endsWith("/chat/completions")) return new Response("fora do roteiro", { status: 500 });
  const text = (JSON.parse(String(init?.body)).messages as { content: string }[]).map((m) => m.content).join("\n");
  const name = text.match(/chamou de "([^"]+)"|nome exato "([^"]+)"/);
  assert.ok(name, "só o pedido de uma técnica (add_ability) chega ao Criador");
  asked.push(name[1] ?? name[2]);
  return creator(asked[asked.length - 1]);
}) as typeof fetch;
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

const rs = normalizeRuleset(JSON.parse(fs.readFileSync("naruto-ruleset.json", "utf-8")));
const W = `test-${randomUUID()}`; // mundo das duas campanhas de teste (A e B)
const W2 = `test-${randomUUID()}`; // mundo das campanhas criadas pela rota (começa vazio)
const campaignIds: string[] = [];

const failures: string[] = [];
async function check(label: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`✔ ${label}`);
  } catch (e) {
    failures.push(label);
    console.error(`✘ ${label}\n   ${e instanceof Error ? e.message.split("\n").join("\n   ") : e}`);
  }
}

async function newCampaign(name: string, world: string) {
  const [c] = await q<Campaign>(`INSERT INTO campaigns (name, style, ruleset, state) VALUES ($1, 'hybrid', $2, '{}') RETURNING *`, [
    name,
    JSON.stringify({ ...rs, world }),
  ]);
  campaignIds.push(c.id);
  const [scene] = await q<Scene>(`INSERT INTO scenes (campaign_id, seq, mode, title) VALUES ($1,1,'battle','t') RETURNING *`, [c.id]);
  const events: TurnEvent[] = [];
  const ctx: ToolContext = { campaign: c, scene, emit: (e) => events.push(e) };
  // turn(): contexto novo, como o de um turno de verdade (engine cria um por turno)
  const turn = (): ToolContext => ({ campaign: c, scene, emit: (e) => events.push(e) });
  return { c, events, turn, run: (tool: string, args: Record<string, unknown>) => executeGmTool(tool, args, ctx) };
}
const addPlayer = (cid: string, name: string) =>
  q(`INSERT INTO characters (campaign_id, kind, name, sheet, persona) VALUES ($1,'player',$2,$3,'{}')`, [cid, name, JSON.stringify(blankSheet(rs))]);
const raw = async (cid: string, name: string) =>
  (await q<{ id: string; sheet: StoredSheet }>(`SELECT id, sheet FROM characters WHERE campaign_id = $1 AND name = $2`, [cid, name]))[0];
const sheetOf = async (cid: string, name: string) => (await hydrateSheets([await raw(cid, name)]))[0].sheet;
const abilityOf = async (cid: string, who: string, ref: number) => (await sheetOf(cid, who)).abilities.find((a) => a.ref === ref);
const chakra = async (cid: string, who: string) => (await sheetOf(cid, who)).resources.chakra.current;
const activeRows = (world: string) =>
  q<{ id: string; name: string; data: LibraryAbility }>(`SELECT id, name, data FROM library WHERE world = $1 AND deleted_at IS NULL ORDER BY id`, [world]);

async function main() {
  const A = await newCampaign("[teste-fonte-unica] A", W);
  const B = await newCampaign("[teste-fonte-unica] B", W);
  await addPlayer(A.c.id, "Ana");
  await addPlayer(B.c.id, "Beto");
  const ids: Record<string, number> = {};

  await check("mundo: worldOf usa ruleset.world; sem ele, o slug do nome", async () => {
    assert.equal(worldOf(A.c), W);
    assert.equal(worldOf({ ruleset: { ...rs, world: undefined, name: "Mundo Shinobi (Naruto)" } }), "mundo_shinobi_naruto");
  });

  // ---------- A9: add_ability sempre liga uma ref ----------
  await check("A9 biblioteca: técnica do mundo pelo nome (sem acento/caixa), sem chamar o Criador; ficha grava { ref, progress }", async () => {
    const e = (await ensureLibraryAbility(A.c, { name: "Katon: Gōkakyū no Jutsu", translation: "Liberação de Fogo: Técnica da Grande Bola de Fogo", type: "ninjutsu", rank: "C" }))!;
    ids.katon = e.id;
    const out = await A.run("add_ability", { character: "Ana", name: "katon: gokakyu no jutsu" });
    assert.match(out, /adicionada \(da biblioteca\)/);
    assert.deepEqual(asked, []);
    assert.ok(!A.events.some((x) => x.type === "status"), "sem status do Criador");
    assert.deepEqual((await raw(A.c.id, "Ana")).sheet.abilities, [{ ref: e.id, progress: NEW_ABILITY_MASTERY }]);
    // pelo nome em português (translation), sem acento: a mesma entrada, sem chamar o Criador
    assert.match(await A.run("add_ability", { character: "Ana", name: "liberacao de fogo: tecnica da grande bola de fogo" }), /já estava na ficha \(da biblioteca\)/);
    assert.deepEqual(asked, [], "tradução não chama o Criador");
    assert.deepEqual((await raw(A.c.id, "Ana")).sheet.abilities, [{ ref: e.id, progress: NEW_ABILITY_MASTERY }], "sem duplicar na ficha");
  });

  await check("A9 Criador: técnica nova criada (nome no padrão do Criador), guardada no mundo e ligada", async () => {
    creator = () =>
      made({ name: "Raiton: Chidori", translation: "Liberação de Raio: Mil Pássaros", type: "ninjutsu", rank: "A", effect: "estocada de raio", canon: true });
    const out = await A.run("add_ability", { character: "Ana", name: "Chidori", brief: "lâmina de raio na mão" });
    assert.match(out, /criada pelo Criador de habilidades/);
    assert.deepEqual(asked, ["Chidori"]);
    assert.ok(A.events.some((x) => x.type === "status" && /Criador de habilidades: Chidori/.test(x.text)));
    const e = (await findLibrary(A.c, "ability", "Raiton: Chidori"))!;
    assert.ok(e && !(e.data as LibraryAbility).incomplete && e.canon && e.world === W);
    ids.chidori = e.id;
    assert.deepEqual((await raw(A.c.id, "Ana")).sheet.abilities.at(-1), { ref: e.id, progress: NEW_ABILITY_MASTERY });
    // o Criador corrige para um nome que já está na biblioteca: liga a existente, sem duplicar
    creator = () => made({ name: "KATON: GŌKAKYŪ NO JUTSU", type: "ninjutsu", rank: "C" });
    await B.run("add_ability", { character: "Beto", name: "Bola de fogo grande" });
    assert.deepEqual((await raw(B.c.id, "Beto")).sheet.abilities, [{ ref: ids.katon, progress: NEW_ABILITY_MASTERY }]);
    assert.equal((await activeRows(W)).length, 2);
  });

  await check("A9 Criador falhando: registrada incomplete com o que o Mestre passou e ligada", async () => {
    creator = failing;
    const out = await A.run("add_ability", { character: "Ana", name: "Soco Giratório", abilityType: "taijutsu", rank: "C", brief: "soco com giro do corpo" });
    assert.match(out, /INCOMPLETA/);
    const e = (await findLibrary(A.c, "ability", "soco giratorio"))!;
    assert.deepEqual(e.data, { name: "Soco Giratório", type: "taijutsu", rank: "C", description: "soco com giro do corpo", incomplete: true });
    ids.soco = e.id;
    assert.deepEqual((await raw(A.c.id, "Ana")).sheet.abilities.at(-1), { ref: e.id, progress: NEW_ABILITY_MASTERY });
  });

  // Criador atrasado (responde depois do prazo): linkAbility com prazo curto
  const lateCase = (label: string, gmName: string, creatorName: string) =>
    check(label, async () => {
      creator = async () => (await sleep(300), made({ name: creatorName, translation: "Técnica", type: "ninjutsu", rank: "B", effect: "efeito do Criador" }));
      const { entry, from } = await linkAbility(A.c, gmName, { timeoutMs: 50, fallback: { abilityType: "ninjutsu", brief: "do Mestre" } });
      assert.equal(from, "incomplete");
      assert.equal((entry.data as LibraryAbility).incomplete, true);
      let now: LibraryEntry | undefined;
      for (let i = 0; i < 40 && !now; i++) {
        await sleep(100);
        const [e] = await q<{ id: string }>(`SELECT id FROM library WHERE id = $1 AND NOT (data ? 'incomplete')`, [entry.id]);
        if (e) now = (await findLibrary(A.c, "ability", creatorName)) ?? undefined;
      }
      assert.ok(now, `a resposta atrasada do Criador não completou a entrada incompleta #${entry.id} (continua só com o que o Mestre passou)`);
      assert.equal(now.id, entry.id, "mesmo id (as fichas já apontam para ele)");
      assert.deepEqual([now.name, (now.data as LibraryAbility).rank, (now.data as LibraryAbility).effect], [creatorName, "B", "efeito do Criador"]);
      const same = (await activeRows(W)).filter((r) => [gmName, creatorName].some((n) => r.name.toLowerCase() === n.toLowerCase()));
      assert.equal(same.length, 1, "nenhuma entrada duplicada");
    });
  await lateCase("A9 Criador atrasado, com nome corrigido: completa a incompleta (mesmo id, sem duplicar)", "Kage Bunshin", "Kage Bunshin no Jutsu");
  await lateCase("A9 Criador atrasado, mesmo nome que o Mestre usou: completa a incompleta (mesmo id, sem duplicar)", "Doton: Doryūheki", "Doton: Doryūheki");
  await check("A9 Criador atrasado com nome oficial que já é de outra entrada: completa a incompleta com o nome do Mestre e não mexe na outra", async () => {
    const before = (await findLibrary(A.c, "ability", "Katon: Gōkakyū no Jutsu"))!;
    creator = async () => (await sleep(300), made({ name: "Katon: Gōkakyū no Jutsu", type: "ninjutsu", rank: "C", effect: "efeito atrasado" }));
    const { entry, from } = await linkAbility(A.c, "Bola de Fogo Lenta", { timeoutMs: 50, fallback: { abilityType: "ninjutsu" } });
    assert.equal(from, "incomplete");
    let done: LibraryEntry | undefined;
    for (let i = 0; i < 40 && !done; i++) {
      await sleep(100);
      const [e] = await getLibraryByIds([entry.id]);
      if (!(e.data as LibraryAbility).incomplete) done = e;
    }
    assert.ok(done, `a resposta atrasada não completou #${entry.id}`);
    assert.deepEqual([done.name, (done.data as LibraryAbility).effect, done.deleted], ["Bola de Fogo Lenta", "efeito atrasado", false]);
    const after = (await getLibraryByIds([before.id]))[0];
    assert.deepEqual([after.name, after.data, after.deleted], [before.name, before.data, false], "a outra entrada fica intacta");
  });
  creator = failing;

  // ---------- domínio: o Escrivão não repete o ganho do uso no mesmo turno ----------
  await check("domínio: depois de use_ability, update_ability_progress com delta no mesmo turno não soma de novo; em outro turno soma", async () => {
    const ref = (await abilityOf(A.c.id, "Ana", (await findLibrary(A.c, "ability", "Katon: Gōkakyū no Jutsu"))!.id))!.ref!;
    await A.run("update_ability_progress", { character: "Ana", name: "Katon: Gōkakyū no Jutsu", set: 30 });
    await A.run("update_resource", { character: "Ana", resource: "chakra", set: 50 });
    const turn = A.turn();
    await executeGmTool("use_ability", { character: "Ana", ability: "Katon: Gōkakyū no Jutsu", dc: 10 }, turn);
    const afterUse = (await abilityOf(A.c.id, "Ana", ref))!.progress!;
    assert.ok(afterUse > 30, "o uso sobe o domínio");
    const scribe = { ...turn }; // o Escrivão recebe uma cópia do contexto do turno (engine.runScribe)
    assert.match(await executeGmTool("update_ability_progress", { character: "Ana", name: "Katon: Gōkakyū no Jutsu", delta: 3 }, scribe), /^Nada mudou/);
    assert.equal((await abilityOf(A.c.id, "Ana", ref))!.progress, afterUse, "não somou de novo");
    await executeGmTool("update_ability_progress", { character: "Ana", name: "Katon: Gōkakyū no Jutsu", delta: 3 }, A.turn());
    assert.equal((await abilityOf(A.c.id, "Ana", ref))!.progress, afterUse + 3, "em outro turno soma");
  });

  // ---------- A8: custo ----------
  await check("A8 custo: byRank[rank] × multiplicador do domínio (C=6: 10% → 9, 50% → 6, 100% → 4); costFree → 0; exibido igual", async () => {
    const steps: [number, number][] = [[10, 9], [50, 6], [100, 4]];
    for (const [progress, cost] of steps) {
      await A.run("update_ability_progress", { character: "Ana", name: "Katon: Gōkakyū no Jutsu", set: progress });
      await A.run("update_resource", { character: "Ana", resource: "chakra", set: 50 });
      const out = await A.run("use_ability", { character: "Ana", ability: "Katon: Gōkakyū no Jutsu", dc: 10 });
      assert.match(out, new RegExp(`Custo pago: ${cost} chakra`), out);
      assert.equal(await chakra(A.c.id, "Ana"), 50 - cost);
    }
    const free = (await ensureLibraryAbility(A.c, { name: "Taijutsu da Academia", type: "taijutsu", rank: "S", costFree: true }))!;
    assert.equal((free.data as LibraryAbility).costFree, true);
    const out = await A.run("add_ability", { character: "Ana", name: "Taijutsu da Academia", progress: 0 });
    assert.doesNotMatch(out, /custo [1-9]/, "linha exibida ao Mestre sem custo");
    await A.run("update_resource", { character: "Ana", resource: "chakra", set: 50 });
    assert.match(await A.run("use_ability", { character: "Ana", ability: "Taijutsu da Academia", dc: 10 }), /Sem custo\./);
    assert.equal(await chakra(A.c.id, "Ana"), 50);
    const line = await A.run("search_library", { kind: "ability", query: "academia" });
    assert.match(line, /rank S, sem custo/);
    assert.match(await A.run("search_library", { kind: "ability", query: "Gōkakyū" }), /custo 6 chakra/);
  });

  // nomes no padrão têm mácrons (Gōkakyū, Doryūheki): o Mestre digita sem eles
  await check("search_library acha o nome no padrão digitado sem mácron/acento (como findLibrary)", async () => {
    assert.match(await A.run("search_library", { kind: "ability", query: "gokakyu" }), /Katon: Gōkakyū/);
  });

  // ---------- A10: edit_ability vale para todos do mundo ----------
  await check("A10 edit_ability: muda a entrada e aparece na ficha de Ana (campanha A) e Beto (campanha B); rename mantém a ref", async () => {
    let out = await A.run("edit_ability", { name: "katon: gokakyu no jutsu", effect: "bola de fogo maior", rank: "B" });
    assert.match(out, /^Técnica editada na biblioteca do mundo/);
    for (const [cid, who] of [[A.c.id, "Ana"], [B.c.id, "Beto"]]) {
      const a = (await abilityOf(cid, who, ids.katon))!;
      assert.deepEqual([a.name, a.effect, a.rank, a.translation], ["Katon: Gōkakyū no Jutsu", "bola de fogo maior", "B", "Liberação de Fogo: Técnica da Grande Bola de Fogo"], who);
    }
    out = await B.run("edit_ability", { name: "Katon: Gōkakyū no Jutsu", new_name: "Katon: Gōkakyū" });
    assert.match(out, /Katon: Gōkakyū/);
    assert.equal((await abilityOf(A.c.id, "Ana", ids.katon))!.name, "Katon: Gōkakyū");
    assert.equal((await abilityOf(B.c.id, "Beto", ids.katon))!.name, "Katon: Gōkakyū");
    assert.deepEqual((await raw(B.c.id, "Beto")).sheet.abilities, [{ ref: ids.katon, progress: NEW_ABILITY_MASTERY }], "a ficha continua só com a ref");
    // custo novo (B=12) vale na hora: Beto com 15% → ×1.5 = 18
    assert.match(await B.run("use_ability", { character: "Beto", ability: "Katon: Gōkakyū", dc: 10 }), /Custo pago: 18 chakra/);
  });

  await check("A10 rename com colisão devolve erro legível e não muda nada; outro mundo não edita; editar tira incomplete", async () => {
    const out = await A.run("edit_ability", { name: "Katon: Gōkakyū", new_name: "raiton: CHIDORI" });
    assert.match(out, /^Erro: Já existe "raiton: CHIDORI" na biblioteca deste mundo/);
    assert.equal((await findLibrary(A.c, "ability", "Katon: Gōkakyū"))!.id, ids.katon);
    const other = await newCampaign("[teste-fonte-unica] outro mundo", W2);
    assert.match(await other.run("edit_ability", { name: "Katon: Gōkakyū", effect: "x" }), /não está na biblioteca deste mundo/);
    assert.equal((await abilityOf(A.c.id, "Ana", ids.katon))!.effect, "bola de fogo maior");
    assert.match(await A.run("edit_ability", { name: "Soco Giratório", effect: "gira e acerta" }), /^Técnica editada/);
    assert.equal(((await findLibrary(A.c, "ability", "Soco Giratório"))!.data as LibraryAbility).incomplete, undefined);
    assert.match(await A.run("edit_ability", { name: "Soco Giratório", type: "magia" }), /^Erro: Edição recusada/);
  });

  // ---------- A11: exclusão = soft delete ----------
  await check("A11 exclusão: some de listLibrary/search_library/findLibrary; ficha mostra removed e use_ability funciona", async () => {
    assert.equal(await deleteLibrary(B.c, ids.chidori), true, "mesmo mundo, outra campanha");
    assert.equal(await deleteLibrary(B.c, ids.chidori), false, "já excluída");
    assert.ok(!(await listLibrary(A.c, "ability")).some((e) => e.id === ids.chidori));
    assert.match(await A.run("search_library", { kind: "ability", query: "chidori" }), /^Nada na biblioteca/);
    assert.doesNotMatch(await A.run("search_library", { kind: "ability" }), /Chidori/);
    assert.equal(await findLibrary(A.c, "ability", "Raiton: Chidori"), null);
    const [row] = await q<{ deleted_at: Date | null }>(`SELECT deleted_at FROM library WHERE id = $1`, [ids.chidori]);
    assert.ok(row.deleted_at, "a linha continua na tabela");
    const a = (await abilityOf(A.c.id, "Ana", ids.chidori))!;
    assert.deepEqual([a.name, a.removed, a.effect], ["Raiton: Chidori", true, "estocada de raio"]);
    await A.run("update_resource", { character: "Ana", resource: "chakra", set: 50 });
    assert.match(await A.run("use_ability", { character: "Ana", ability: "Raiton: Chidori", dc: 10 }), /Custo pago: 30 chakra \(base 20/);
    assert.deepEqual((await raw(A.c.id, "Ana")).sheet.abilities.find((x) => x.ref === ids.chidori), { ref: ids.chidori, progress: NEW_ABILITY_MASTERY + 5 });
    const outsider = await newCampaign("[teste-fonte-unica] outro mundo 2", W2);
    assert.equal(await deleteLibrary(outsider.c, ids.katon), false, "outro mundo não exclui");
  });

  // ---------- A12: criação de campanha ----------
  await check("A12 POST /api/campaigns: kit e extras entram na biblioteca do mundo sem duplicar; a ficha recebe refs", async () => {
    const post = async (player: string) => {
      const res = await createCampaign(
        new NextRequest("http://x/api/campaigns", {
          method: "POST",
          body: JSON.stringify({
            name: "[teste-fonte-unica] rota",
            style: "hybrid",
            ruleset: { ...rs, world: W2 },
            character: {
              name: player,
              abilities: [
                { name: "Rasengan", type: "ninjutsu", rank: "A", progress: 30, cost: { resource: "chakra", amount: 99 } },
                { name: "henge no jutsu", type: "ninjutsu", progress: 90 }, // mesma entrada do kit: troca o domínio
                { name: "Sem tipo" },
              ],
            },
            generateScript: false,
          }),
        })
      );
      const { id } = (await res.json()) as { id: string };
      assert.ok(id, `rota respondeu ${res.status}`);
      campaignIds.push(id);
      return id;
    };
    const kit = startingKit(rs, rs.ranks[0].key);
    const c1 = await post("Hugo");
    const lib = await activeRows(W2);
    assert.deepEqual(lib.map((r) => r.name).sort(), [...kit.map((a) => a.name), "Rasengan"].sort(), "kit + extra válido, nenhum a mais");
    assert.ok(lib.every((r) => !("cost" in r.data)), "sem cost na biblioteca");
    assert.equal(lib.find((r) => r.name === "Arremesso de shuriken e kunai")!.data.costFree, true);
    const [camp] = await q<Campaign>(`SELECT * FROM campaigns WHERE id = $1`, [c1]);
    assert.equal(camp.ruleset.world, W2);
    const stored = (await raw(c1, "Hugo")).sheet.abilities;
    assert.ok(stored.every((a) => Object.keys(a).every((k) => k === "ref" || k === "progress")), "ficha só com { ref, progress }");
    const byName = new Map(lib.map((r) => [r.name, Number(r.id)]));
    const progressOf = (name: string) => stored.find((a) => a.ref === byName.get(name))?.progress;
    assert.equal(stored.length, kit.length + 1);
    assert.deepEqual([progressOf("Henge no Jutsu"), progressOf("Rasengan"), progressOf("Bunshin no Jutsu")], [90, 30, 60]);
    const c2 = await post("Iris");
    assert.equal((await activeRows(W2)).length, lib.length, "segunda campanha no mesmo mundo não duplica");
    assert.deepEqual(
      (await raw(c2, "Iris")).sheet.abilities.map((a) => a.ref),
      stored.map((a) => a.ref),
      "a segunda ficha aponta para as mesmas entradas"
    );
  });

  // ---------- ida e volta da ficha ----------
  await check("dehydrate/hydrate: ida e volta preserva ordem e progress; formato antigo intacto; ref sumida vira removed; gravar a hidratada grava só { ref, progress }", async () => {
    const old: Ability = { name: "Velha", type: "ninjutsu", rank: "D" };
    const sheet: Sheet = { ...blankSheet(rs), abilities: [
      { ...(await abilityOf(A.c.id, "Ana", ids.soco))!, progress: 0 },
      old,
      { ...(await abilityOf(A.c.id, "Ana", ids.katon))!, progress: undefined },
      { ...(await abilityOf(A.c.id, "Ana", ids.chidori))!, progress: 77 },
    ] };
    const dry = dehydrateSheet(sheet);
    assert.deepEqual(dry.abilities, [{ ref: ids.soco, progress: 0 }, old, { ref: ids.katon }, { ref: ids.chidori, progress: 77 }]);
    assert.deepEqual(dry.attributes, sheet.attributes, "o resto da ficha fica igual");
    const wet = await hydrateSheet(dry);
    assert.deepEqual(wet.abilities.map((a) => [a.name, a.ref, a.progress, a.removed]), [
      ["Soco Giratório", ids.soco, 0, undefined],
      ["Velha", undefined, undefined, undefined],
      ["Katon: Gōkakyū", ids.katon, undefined, undefined],
      ["Raiton: Chidori", ids.chidori, 77, true],
    ]);
    assert.deepEqual(dehydrateSheet(wet), dry, "volta igual");
    assert.deepEqual((await hydrateSheet({ ...dry, abilities: [{ ref: 2 ** 40 }] })).abilities, [{ name: `#${2 ** 40}`, type: "", ref: 2 ** 40, removed: true }]);
    // grava a hidratada pelas ferramentas (saveSheet) e confere o banco
    await A.run("update_ability_progress", { character: "Ana", name: "Soco Giratório", set: 42 });
    const rows = await q<{ k: string }>(
      `SELECT DISTINCT jsonb_object_keys(a) AS k FROM characters c, jsonb_array_elements(c.sheet->'abilities') a WHERE c.campaign_id = ANY($1::uuid[])`,
      [campaignIds]
    );
    assert.deepEqual(rows.map((r) => r.k).sort(), ["progress", "ref"]);
    assert.equal((await raw(A.c.id, "Ana")).sheet.abilities.find((a) => a.ref === ids.soco)!.progress, 42);
  });
}

main()
  .catch((e) => {
    failures.push("erro fora das checagens");
    console.error(e);
  })
  .finally(async () => {
    await sleep(500); // resposta atrasada do Criador ainda em voo
    if (campaignIds.length) await real.query(`DELETE FROM campaigns WHERE id = ANY($1::uuid[])`, [campaignIds]);
    await real.query(`DELETE FROM library WHERE world = ANY($1)`, [[W, W2]]);
    await real.end();
    console.log(failures.length ? `\n${failures.length} falha(s): ${failures.join(" | ")}` : "\nlibrary-source-check: ok");
    if (failures.length) process.exitCode = 1;
  });
