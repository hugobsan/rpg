/**
 * Correções do registro pelo jogador, sem IA (src/lib/corrections.ts): roda o runTurn com a rede falsa (o Narrador
 * responde por roteiro com o bloco de efeitos; Jev, Intérprete e embeddings falham) numa campanha temporária.
 * Confere: os efeitos aplicados ficam em meta.scribe e as etiquetas levam { messageId, index }; desfazer item,
 * dinheiro, memória, missão criada e status de missão (com a XP da conclusão); desfazer duas vezes não duplica;
 * registro de turno anterior não se desfaz; edição manual (XP sobe nível, recurso, item, domínio, missão perdida que
 * foi cumprida dá a XP uma vez só); a linha no contexto do Mestre e o consumo dela; gerar novamente coerente; a rota
 * recusa durante o turno; a tabela corrections.
 * Rodar: npx tsx scripts/corrections-check.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { NextRequest } from "next/server";
import { DEFAULT_AGENTS } from "../src/lib/agents";
import { runTurn } from "../src/lib/engine";
import { applyFix, clearPlayerFixes, fixStatus, turns, undoScribe, type ScribeEntry } from "../src/lib/corrections";
import { restoreSnapshot } from "../src/lib/turnSnapshot";
import { blankSheet, normalizeRuleset } from "../src/lib/ruleset";
import { getObjectives, type Objective } from "../src/lib/objectives";
import { powerLevel } from "../src/lib/progression";
import type { Sheet, TurnEvent } from "../src/lib/types";
import { POST } from "../src/app/api/campaigns/[id]/corrections/route";

// ---------- banco: o real, menos agentes, configurações de IA e api_logs (como no scribe-check) ----------
const real = new Pool({ connectionString: process.env.DATABASE_URL || "postgres://rpg:rpg@localhost:5433/rpg", max: 4 });
const scribeRow = { ...DEFAULT_AGENTS.find((a) => a.id === "scribe")!, source: "openrouter" };
const g = global as unknown as { __pgPool?: unknown; __schemaReady?: Promise<boolean> };
g.__pgPool = {
  query(text: string, params: unknown[] = []) {
    if (/FROM settings WHERE key/.test(text) && params[0] === "openrouter") return { rows: [{ value: { apiKey: "k-teste" } }] };
    if (/FROM settings WHERE key/.test(text) && ["sources", "embeddings"].includes(params[0] as string)) return { rows: [] };
    if (/SELECT source(, params)? FROM agents/.test(text)) return { rows: [{ source: "openrouter", params: {} }] };
    if (/INSERT INTO api_logs/.test(text)) return { rows: [] };
    if (/^\s*(INSERT INTO|UPDATE|DELETE FROM) agents/.test(text)) return { rows: [] };
    if (/SELECT \* FROM agents WHERE id/.test(text) && params[0] === "scribe") return { rows: [scribeRow] };
    return real.query(text, params);
  },
  connect: () => real.connect(),
  end: () => real.end(),
};

// ---------- rede: o Narrador por roteiro, com o bloco de efeitos ----------
const gmScript: string[] = [];
const gmCtx: string[] = []; // contexto do turno que o Narrador recebeu
let events: TurnEvent[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (!String(input).endsWith("/chat/completions")) return new Response("fora do roteiro", { status: 500 });
  const body = JSON.parse(String(init?.body));
  const tools: string[] = (body.tools || []).map((t: { function: { name: string } }) => t.function.name);
  if (tools.includes("search_lore")) {
    const text = gmScript.shift();
    assert.ok(text, "Narrador chamado além do roteiro");
    gmCtx.push(body.messages.map((m: { content: unknown }) => String(m.content ?? "")).join("\n"));
    const chunks = [{ choices: [{ delta: { content: text } }] }, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }];
    return new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n");
  }
  return Response.json({ choices: [{ message: { content: "?" } }] });
}) as typeof fetch;

const rs = normalizeRuleset(JSON.parse(fs.readFileSync("naruto-ruleset.json", "utf-8")));

async function main() {
  // regra pura do status: concluir dá a XP uma vez; sair de concluída devolve; concluída antiga (sem xpGiven) não dá de novo
  const base: Objective = { id: "o1", title: "T", kind: "missao", description: "", status: "perdido", xpSize: "pequena", createdAt: 0, closedAt: 10 };
  const won = fixStatus(base, "concluido", 20, 7);
  assert.deepEqual([won.xp, won.next.xpGiven, won.next.closedAt], [7, 7, 20]);
  const back = fixStatus(won.next, "aberto", 20, 9);
  assert.deepEqual([back.xp, back.next.xpGiven, back.next.closedAt], [-7, undefined, undefined]);
  const legacy = fixStatus({ ...base, status: "concluido" }, "cancelado", 20, 7);
  assert.deepEqual([legacy.xp, legacy.next.xpGiven], [0, 0]);
  assert.equal(fixStatus(legacy.next, "concluido", 20, 7).xp, 0, "concluída antiga não dá a XP de novo");

  const world = `test-${randomUUID()}`;
  const { rows: [c] } = await real.query(
    `INSERT INTO campaigns (name, style, ruleset, state) VALUES ('[teste-correções]', 'open', $1, $2) RETURNING id`,
    [
      JSON.stringify({ ...rs, world }),
      JSON.stringify({
        clock: { minutes: 480 },
        objectives: [
          { id: "o9", title: "Treinar o Konohamaru", kind: "missao", description: "", status: "aberto", xpSize: "pequena", createdAt: 480 },
          { id: "o8", title: "Achar o Akamaru", kind: "missao", description: "", status: "perdido", xpSize: "media", createdAt: 0, deadlineMinutes: 400, closedAt: 470 },
        ],
      }),
    ]
  );
  const id: string = c.id;
  const sheet0 = blankSheet(rs);
  sheet0.inventory = [{ name: "Shuriken", qty: 3 }];
  sheet0.money = 1000;
  const sheetOf = async () =>
    (await real.query(`SELECT sheet FROM characters WHERE campaign_id = $1 AND kind = 'player'`, [id])).rows[0].sheet as Sheet;
  const stateOf = async () => (await real.query(`SELECT state FROM campaigns WHERE id = $1`, [id])).rows[0].state as Record<string, unknown>;
  const lastGm = async () =>
    (await real.query(`SELECT id::int AS id, meta FROM messages WHERE campaign_id = $1 AND role = 'gm' ORDER BY id DESC LIMIT 1`, [id])).rows[0] as {
      id: number; meta: { notes: string[]; scribe: ScribeEntry[] };
    };
  const turn = async (input: string, narration: string, effects: object) => {
    gmScript.push(`${narration}\n\`\`\`efeitos\n${JSON.stringify(effects)}\n\`\`\``);
    events = [];
    const started = Date.now();
    await runTurn(id, input, (e) => events.push(e));
    await clearPlayerFixes(id, started); // como a rota do turno, depois da narração
  };
  const fails = (p: Promise<unknown>, re: RegExp) => assert.rejects(p, (e: Error) => re.test(e.message));
  try {
    await real.query(`INSERT INTO scenes (campaign_id, seq, mode, location) VALUES ($1, 1, 'exploration', 'Academia')`, [id]);
    await real.query(`INSERT INTO characters (campaign_id, kind, name, sheet) VALUES ($1, 'player', 'Hugo', $2)`, [id, JSON.stringify(sheet0)]);

    // 1. turno: o bloco erra (tigela como item) e registra compra, fato e missão oferecida
    await turn("como no Ichiraku", "Você come uma tigela de lámen e esbarra na mesa.", {
      items: [{ name: "Tigela", qty: 1 }],
      purchase: { item: "Lámen", qty: 1, price: 300 },
      facts: [{ text: "Hugo comeu no Ichiraku." }],
      mission: { op: "offer", title: "Pagar o Teuchi" },
    });
    let m1 = await lastGm();
    const idx = (tool: string, m = m1, name?: string) => m.meta.scribe.findIndex((e) => e.tool === tool && (!name || e.args.name === name));
    assert.equal(m1.meta.scribe.length, 5, "cada registro fica em meta.scribe");
    assert.ok(m1.meta.scribe.every((e) => e.undo && e.note), "com o que desfazer e a linha das notas");
    assert.deepEqual(m1.meta.notes, m1.meta.scribe.map((e) => e.note));
    const chip = events.find((e) => e.type === "tool" && /Tigela/.test(e.summary)) as Extract<TurnEvent, { type: "tool" }>;
    assert.deepEqual(chip.scribe, { messageId: m1.id, index: idx("add_item") }, "a etiqueta sabe qual registro é");
    let s = await sheetOf();
    assert.ok(s.inventory.some((i) => i.name === "Tigela"));
    assert.equal(s.money, 700, "compra paga");

    // 2. desfazer: item, dinheiro, item da compra, memória e missão criada
    const memBefore = (await real.query(`SELECT count(*)::int AS n FROM memories WHERE campaign_id = $1`, [id])).rows[0].n;
    assert.match(await undoScribe(id, m1.id, idx("add_item")), /Hugo \+1x Tigela/);
    await fails(undoScribe(id, m1.id, idx("add_item")), /já foi desfeito/);
    await undoScribe(id, m1.id, idx("update_money"));
    await undoScribe(id, m1.id, idx("add_item", m1, "Lámen"));
    await undoScribe(id, m1.id, idx("add_memory"));
    await undoScribe(id, m1.id, idx("add_objective"));
    s = await sheetOf();
    assert.ok(!s.inventory.some((i) => i.name === "Tigela"), "item sai");
    assert.equal(s.inventory.find((i) => i.name === "Shuriken")?.qty, 3, "desfazer duas vezes não mexe em mais nada");
    assert.ok(!s.inventory.some((i) => i.name === "Lámen"), "item da compra sai");
    assert.equal(s.money, 1000, "dinheiro volta");
    assert.equal((await real.query(`SELECT count(*)::int AS n FROM memories WHERE campaign_id = $1`, [id])).rows[0].n, memBefore - 1, "memória criada sai");
    assert.ok(!getObjectives(await stateOf()).some((o) => o.title === "Pagar o Teuchi"), "missão criada sai");
    m1 = await lastGm();
    assert.ok(m1.meta.scribe.every((e) => e.undone), "todos marcados como desfeitos");
    assert.deepEqual(m1.meta.notes, [], "o que foi desfeito não fica como registro");
    assert.equal(((await stateOf()).playerFixes as unknown[]).length, 5);

    // 3. próximo turno: o Narrador lê as correções numa linha e ela é consumida; o bloco conclui a missão com tamanho
    await turn("vou treinar o Konohamaru", "O Konohamaru acerta o alvo.", { mission: { op: "complete", id: "o9" } });
    assert.match(gmCtx.at(-1)!, /O JOGADOR CORRIGIU A FICHA desde o seu último turno[^\n]*\ndesfez o registro: Hugo \+1x Tigela; desfez/);
    assert.deepEqual((await stateOf()).playerFixes, [], "consumida depois da narração");
    await fails(undoScribe(id, m1.id, 0), /último turno/);
    const m2 = await lastGm();
    const xpMission = (await sheetOf()).xp;
    assert.ok(xpMission > 0, "a missão deu XP");
    assert.equal(getObjectives(await stateOf()).find((o) => o.id === "o9")?.xpGiven, xpMission, "a conclusão guarda a XP que deu");
    // status de missão desfeito: volta a aberta e a XP sai
    await undoScribe(id, m2.id, idx("update_objective", m2));
    const o9 = getObjectives(await stateOf()).find((o) => o.id === "o9")!;
    assert.equal(o9.status, "aberto");
    assert.equal(o9.xpGiven, undefined);
    assert.equal((await sheetOf()).xp, 0, "XP da missão sai");

    // 4. gerar novamente depois de desfazer: volta à foto de antes do turno; a narração (e a marca) somem
    await restoreSnapshot(id);
    assert.equal(getObjectives(await stateOf()).find((o) => o.id === "o9")?.status, "aberto");
    assert.equal((await lastGm()).id, m1.id, "a narração do turno refeito some com a marca de desfeito");
    // as correções de antes do turno voltam (o turno refeito lê de novo, como o decidedAt); a feita depois da foto some
    const again = (await stateOf()).playerFixes as { text: string }[];
    assert.equal(again.length, 5);
    assert.ok(!again.some((f) => /Konohamaru/.test(f.text)));
    // de novo, e agora o turno fica
    await turn("vou treinar o Konohamaru", "O Konohamaru acerta o alvo.", { mission: { op: "complete", id: "o9" } });
    assert.equal((await sheetOf()).xp, xpMission);

    // 5. edição manual: XP sobe nível pela regra, recurso, item, domínio, missão perdida que foi cumprida
    const lvl = (xp: number) => powerLevel(rs, xp).level?.label;
    const next = powerLevel(rs, xpMission).next!;
    const up = await applyFix(id, { fix: "xp", xp: next.xpRequired + 5 });
    assert.match(up, new RegExp(`XP ${xpMission} → ${next.xpRequired + 5} \\(Nível de poder: ${next.label}\\)`));
    assert.equal(lvl((await sheetOf()).xp), next.label);
    await fails(applyFix(id, { fix: "xp", xp: next.xpRequired + 5 }), /Nada mudou/);
    assert.match(await applyFix(id, { fix: "resource", resource: "hp", current: 5 }), /→ 5\//);
    assert.equal((await sheetOf()).resources.hp.current, 5);
    assert.match(await applyFix(id, { fix: "item", name: "Shuriken", qty: -1 }), /removeu 1x Shuriken/);
    assert.match(await applyFix(id, { fix: "item", name: "Kunai", qty: 2 }), /adicionou 2x Kunai/);
    s = await sheetOf();
    assert.deepEqual(s.inventory.map((i) => [i.name, i.qty]), [["Shuriken", 2], ["Kunai", 2]]);
    const xpNow = s.xp;
    const won8 = await applyFix(id, { fix: "objective", objective: "o8", status: "concluido" });
    assert.match(won8, /missão o8 "Achar o Akamaru" perdida → concluída \(\+\d+ XP\)/);
    const gained = (await sheetOf()).xp - xpNow;
    assert.ok(gained > 0);
    await applyFix(id, { fix: "objective", objective: "o8", status: "cancelado" });
    assert.equal((await sheetOf()).xp, xpNow, "sair de concluída devolve a XP");
    await applyFix(id, { fix: "objective", objective: "o8", status: "concluido" });
    assert.equal((await sheetOf()).xp - xpNow, gained, "concluir de novo dá uma vez só");
    await fails(applyFix(id, { fix: "objective", objective: "o8", status: "aberto" }), /prazo já passou/);
    // domínio: liga uma técnica crua na ficha (sem biblioteca) e corrige
    await real.query(
      `UPDATE characters SET sheet = jsonb_set(sheet, '{abilities}', '[{"name":"Kawarimi","type":"ninjutsu","progress":30}]') WHERE campaign_id = $1 AND kind = 'player'`,
      [id]
    );
    assert.match(await applyFix(id, { fix: "mastery", ability: "kawarimi", progress: 45 }), /domínio de Kawarimi 30% → 45%/);
    assert.equal((await sheetOf()).abilities[0].progress, 45);

    // 6. a rota recusa durante um turno
    const post = (body: unknown) =>
      POST(new NextRequest(`http://x/api/campaigns/${id}/corrections`, { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
    turns.set(id, { stop: new AbortController(), done: Promise.resolve() });
    assert.equal((await post({ fix: "xp", xp: 1 })).status, 409, "turno em andamento");
    turns.delete(id);
    const ok = await post({ fix: "resource", resource: "hp", current: 6 });
    assert.equal(ok.status, 200);
    assert.match((await ok.json()).summary, /→ 6\//);

    // 7. medição: tudo na tabela corrections, com a origem e o agente do registro desfeito
    const rows = (await real.query(`SELECT source, agent, kind FROM corrections WHERE campaign_id = $1 ORDER BY id`, [id])).rows;
    assert.equal(rows.filter((r) => r.source === "desfazer" && r.agent === "scribe").length, 6, "5 do 1º turno + o status (o do turno refeito fica medido)");
    assert.deepEqual(rows.filter((r) => r.source === "manual").map((r) => r.kind), ["xp", "resource", "item", "item", "objective", "objective", "objective", "mastery", "resource"]);
    const fixes = (await stateOf()).playerFixes as { text: string }[];
    assert.ok(fixes.some((f) => /removeu 1x Shuriken/.test(f.text)), "a próxima narração vai ler as correções manuais");

    console.log("corrections-check: ok (meta.scribe e etiquetas, desfazer item/dinheiro/memória/missão/status uma vez só, só o último turno, linha ao Mestre consumida, gerar novamente coerente, edição manual pelas regras, rota bloqueada no turno, tabela corrections)");
  } finally {
    await new Promise((r) => setTimeout(r, 300)); // o índice do histórico roda depois do done
    await real.query(`DELETE FROM campaigns WHERE id = $1`, [id]);
    await real.query(`DELETE FROM corrections WHERE campaign_id = $1`, [id]);
    await real.query(`DELETE FROM library WHERE world = $1`, [world]);
    await real.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
