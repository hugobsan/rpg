/**
 * Anotações depois da narração e Escrivão, sem IA: roda o runTurn de ponta a ponta numa campanha temporária, com a
 * rede falsa (Mestre e Escrivão respondem por roteiro; Jev e embeddings falham e caem no padrão). Os agentes e as
 * configurações reais não são lidos nem mexidos: fonte, chave, api_logs e a semeadura de agentes são interceptados.
 * Confere: rodada só com anotações junto da narração encerra o turno sem outra chamada; rodada mista; anotações rodam
 * depois da narração; ferramentas do Escrivão aplicadas; o fora do jogo continua com as ferramentas que saíram do turno.
 * Rodar: npx tsx scripts/scribe-check.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { Pool } from "pg";
import { DEFAULT_AGENTS } from "../src/lib/agents";
import { runTurn } from "../src/lib/engine";
import { OOC_GAME_TOOLS } from "../src/lib/ooc";
import { blankSheet, normalizeRuleset } from "../src/lib/ruleset";
import { getObjectives } from "../src/lib/objectives";
import { DEFERRED_TOOLS, GM_TURN_TOOLS, SCRIBE_TOOLS } from "../src/lib/tools";
import type { TurnEvent } from "../src/lib/types";

// ---------- banco: o real, menos agentes, configurações de IA e api_logs ----------
const real = new Pool({ connectionString: process.env.DATABASE_URL || "postgres://rpg:rpg@localhost:5433/rpg", max: 4 });
const logs: unknown[][] = [];
const scribeRow = { ...DEFAULT_AGENTS.find((a) => a.id === "scribe")!, source: "openrouter" };
const g = global as unknown as { __pgPool?: unknown; __schemaReady?: Promise<boolean> };
g.__schemaReady = Promise.resolve(true);
g.__pgPool = {
  query(text: string, params: unknown[] = []) {
    if (/FROM settings WHERE key/.test(text) && params[0] === "openrouter") return { rows: [{ value: { apiKey: "k-teste" } }] };
    if (/FROM settings WHERE key/.test(text) && ["sources", "embeddings"].includes(params[0] as string)) return { rows: [] };
    if (/SELECT source(, params)? FROM agents/.test(text)) return { rows: [{ source: "openrouter", params: {} }] };
    if (/INSERT INTO api_logs/.test(text)) return logs.push(params), { rows: [] };
    if (/^\s*(INSERT INTO|UPDATE|DELETE FROM) agents/.test(text)) return { rows: [] }; // agentes do banco ficam como estão
    if (/SELECT \* FROM agents WHERE id/.test(text) && params[0] === "scribe") return { rows: [scribeRow] };
    return real.query(text, params);
  },
  connect: () => real.connect(),
  end: () => real.end(),
};

// ---------- rede: Mestre (em streaming) e Escrivão por roteiro; o resto falha ----------
type Call = { name: string; args: Record<string, unknown> };
type Reply = { text: string; calls: Call[] };
const gmScript: Reply[] = [];
const scribeScript: Reply[] = [];
const gmReqs: { messages: { role: string; content: unknown; name?: string }[]; tools: string[] }[] = [];
const scribeReqs: { messages: { role: string; content: string }[]; tools: string[] }[] = [];
let events: TurnEvent[] = [];
const toolCalls = (calls: Call[]) => calls.map((c, i) => ({ id: `c${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }));
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (!url.endsWith("/chat/completions")) return new Response("fora do roteiro", { status: 500 });
  const body = JSON.parse(String(init?.body));
  const tools: string[] = (body.tools || []).map((t: { function: { name: string } }) => t.function.name);
  if (tools.includes("use_ability")) {
    gmReqs.push({ messages: body.messages, tools });
    const r = gmScript.shift();
    assert.ok(r, "Mestre chamado além do roteiro");
    events.push({ type: "status", text: "[mestre]" }); // marca a chamada na linha do tempo
    const chunks = [
      { choices: [{ delta: { content: r.text } }] },
      ...(r.calls.length ? [{ choices: [{ delta: { tool_calls: toolCalls(r.calls).map((c, index) => ({ index, ...c })) } }] }] : []),
      { choices: [{ delta: {}, finish_reason: r.calls.length ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ];
    return new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n");
  }
  if (tools.includes("update_resource")) {
    scribeReqs.push({ messages: body.messages, tools });
    const r = scribeScript.shift() ?? { text: "", calls: [] };
    return Response.json({ choices: [{ message: { content: r.text, tool_calls: r.calls.length ? toolCalls(r.calls) : undefined } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  }
  return Response.json({ choices: [{ message: { content: "?" } }] }); // Cronista (nome do local): não sabe
}) as typeof fetch;

const rs = normalizeRuleset(JSON.parse(fs.readFileSync("naruto-ruleset.json", "utf-8")));

async function main() {
  // ferramentas: o turno perde as do Escrivão e ganha note_objective; advance_time fica, como anotação (o Mestre controla o ritmo)
  const turn = GM_TURN_TOOLS.map((t) => t.function.name);
  const ooc = OOC_GAME_TOOLS.map((t) => t.function.name);
  assert.ok(turn.includes("advance_time") && DEFERRED_TOOLS.has("advance_time"), "advance_time no turno, depois da narração");
  for (const name of SCRIBE_TOOLS) {
    assert.ok(!turn.includes(name), `${name} saiu do turno`);
    assert.ok(ooc.includes(name), `${name} continua no fora do jogo`);
  }
  assert.ok(turn.includes("note_objective") && !ooc.includes("note_objective"));
  assert.ok(["set_time", "train", "create_npc", "use_ability", "set_scene"].every((n) => turn.includes(n)));

  const { rows: [c] } = await real.query(
    `INSERT INTO campaigns (name, style, ruleset, state) VALUES ('[teste-escrivão]', 'open', $1, '{"clock":{"minutes":480}}') RETURNING id`,
    [JSON.stringify(rs)]
  );
  const id: string = c.id;
  const db = async <T>(sql: string) => (await real.query(sql, [id])).rows as T[];
  try {
    await real.query(`INSERT INTO scenes (campaign_id, seq, mode, location) VALUES ($1, 1, 'exploration', 'Academia')`, [id]);
    await real.query(
      `INSERT INTO characters (campaign_id, kind, name, sheet) VALUES ($1, 'player', 'Hugo', $2), ($1, 'npc', 'Iruka', $2)`,
      [id, JSON.stringify(blankSheet(rs))]
    );
    const hp0 = (await db<{ sheet: { resources: { hp: { current: number } } } }>(`SELECT sheet FROM characters WHERE campaign_id = $1 AND name = 'Hugo'`))[0].sheet.resources.hp.current;
    const at = (pred: (e: TurnEvent) => boolean) => events.findIndex(pred);

    // 1. narração + só anotações (set_scene, note_objective): o turno acaba sem outra chamada ao Mestre
    gmScript.push({
      text: "Você atravessa a vila até a ponte, onde o Iruka espera com um pergaminho.",
      calls: [
        { name: "set_scene", args: { location: "Ponte", present: ["Iruka"] } },
        { name: "note_objective", args: { brief: "Iruka pediu para entregar o pergaminho ao Hokage em 2 horas; recompensa 100 ryō" } },
      ],
    });
    scribeScript.push({
      text: "",
      calls: [
        { name: "add_objective", args: { title: "Entregar o pergaminho", kind: "missao", description: "levar ao Hokage", reward: "100 ryō", inHours: 2 } },
        { name: "update_resource", args: { character: "Hugo", resource: "hp", delta: -3 } },
        { name: "add_item", args: { character: "Hugo", name: "Pergaminho selado", qty: 1 } },
      ],
    });
    events = [];
    await runTurn(id, "vou até a ponte", (e) => events.push(e));
    assert.equal(gmReqs.length, 1, "uma chamada só ao Mestre");
    assert.ok(!gmReqs[0].tools.includes("update_resource") && gmReqs[0].tools.includes("note_objective"), "o Mestre recebe as ferramentas do turno");
    const narr = at((e) => e.type === "narration");
    assert.equal((events[narr] as { content: string }).content, "Você atravessa a vila até a ponte, onde o Iruka espera com um pergaminho.");
    const sceneEv = at((e) => e.type === "scene");
    assert.ok(narr >= 0 && sceneEv > narr, "set_scene roda depois da narração");
    assert.ok(at((e) => e.type === "done") > sceneEv, "e antes do done");
    const [sc] = await db<{ location: string }>(`SELECT location FROM scenes WHERE campaign_id = $1 AND is_current`);
    assert.equal(sc.location, "Ponte");
    // Escrivão: recebe narração, anotação e estado; o que ele chamou foi aplicado
    assert.equal(scribeReqs.length, 1, "uma chamada ao Escrivão");
    assert.deepEqual(new Set(scribeReqs[0].tools), SCRIBE_TOOLS);
    const ask = scribeReqs[0].messages[1].content;
    assert.match(ask, /ANOTAÇÕES DE MISSÃO DO MESTRE ---\n- Iruka pediu para entregar o pergaminho/);
    assert.match(ask, /NARRAÇÃO DO MESTRE ---\nVocê atravessa a vila/);
    assert.match(ask, /Hugo \(player\)/);
    const [camp] = await db<{ state: Record<string, unknown> }>(`SELECT state FROM campaigns WHERE id = $1`);
    const [o] = getObjectives(camp.state);
    assert.equal(o?.title, "Entregar o pergaminho");
    assert.equal(o.deadlineMinutes, 480 + 120, "prazo relativo a partir da hora do turno");
    const [hugo] = await db<{ sheet: { resources: { hp: { current: number } }; inventory: { name: string }[] } }>(`SELECT sheet FROM characters WHERE campaign_id = $1 AND name = 'Hugo'`);
    assert.equal(hugo.sheet.resources.hp.current, hp0 - 3);
    assert.ok(hugo.sheet.inventory.some((i) => i.name === "Pergaminho selado"));
    assert.ok(at((e) => e.type === "tool" && /Pergaminho selado/.test(e.summary)) > narr, "chips do Escrivão depois da narração");
    const scribeLogs = logs.filter((l) => l[0] === "scribe");
    assert.equal(scribeLogs.length, 1, "o Escrivão entra em api_logs");
    assert.equal(scribeLogs[0][1], id);
    assert.equal(scribeLogs[0][3], "anotações do turno");
    const [gmMsg] = await db<{ meta: { notes?: string[] } }>(`SELECT meta FROM messages WHERE campaign_id = $1 AND role = 'gm' ORDER BY id DESC LIMIT 1`);
    assert.ok(gmMsg.meta.notes?.some((n) => /^update_resource .*→ Hugo agora tem hp/.test(n)), "o que o Escrivão gravou fica junto da narração");

    // 2. rodada mista sem texto: o dado roda, a anotação responde "Anotado" e espera a narração da rodada seguinte
    gmScript.push(
      { text: "", calls: [{ name: "roll_dice", args: { notation: "1d20", reason: "percepção" } }, { name: "set_npc_active", args: { name: "Iruka", active: false } }] },
      { text: "O Iruka acena e some na fumaça.", calls: [] }
    );
    events = [];
    await runTurn(id, "olho em volta", (e) => events.push(e));
    assert.equal(gmReqs.length, 3, "duas chamadas ao Mestre neste turno");
    const results = gmReqs[2].messages.filter((m) => m.role === "tool");
    assert.match(String(results.find((m) => m.name === "roll_dice")?.content), /TOTAL/);
    assert.equal(results.find((m) => m.name === "set_npc_active")?.content, "Anotado: será aplicado depois da narração.");
    const ctx2 = gmReqs[1].messages.map((m) => String(m.content ?? "")).join("\n");
    assert.match(ctx2, /O ESCRIVÃO REGISTROU DEPOIS DA SUA ÚLTIMA NARRAÇÃO[^\n]*\n(- .*\n)*- add_item .*Pergaminho selado/, "o Mestre vê no turno seguinte o que o Escrivão gravou");
    const narr2 = at((e) => e.type === "narration");
    const out = at((e) => e.type === "tool" && e.summary === "Iruka saiu de cena");
    assert.ok(narr2 >= 0 && out > narr2 && at((e) => e.type === "done") > out, "set_npc_active depois da narração e antes do done");
    const [iruka] = await db<{ active: boolean }>(`SELECT active FROM characters WHERE campaign_id = $1 AND name = 'Iruka'`);
    assert.equal(iruka.active, false);
    assert.match(scribeReqs[1].messages[1].content, /JÁ FEITO PELO MESTRE NESTE TURNO \(não repita\) ---\nroll_dice .*TOTAL/, "o Escrivão sabe do dado");
    assert.ok(!/ANOTAÇÕES DE MISSÃO/.test(scribeReqs[1].messages[1].content));
    assert.equal(gmScript.length, 0);

    console.log("scribe-check: ok (anotações depois da narração, rodada mista, Escrivão aplicado e logado, fora do jogo com todas as ferramentas)");
  } finally {
    await new Promise((r) => setTimeout(r, 300)); // o índice do histórico roda depois do done
    await real.query(`DELETE FROM campaigns WHERE id = $1`, [id]);
    await real.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
