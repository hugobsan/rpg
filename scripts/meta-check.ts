/**
 * Fala fora do jogo no chat do jogo, sem IA: roda o runTurn de ponta a ponta numa campanha temporária, com a rede falsa
 * (Jev da decisão do turno, Mestre, Escrivão e Mestre fora do jogo por roteiro; o resto falha e cai no padrão). Os
 * agentes e as configurações reais não são lidos nem mexidos: fonte, chave, api_logs e a semeadura de agentes são
 * interceptados.
 * Confere: meta sim = sem Mestre nem Escrivão, a conversa fora do jogo responde (gm_notes), nada em messages e a foto
 * do turno anterior fica; meta abaixo do limiar, Jev falhando, fora do jogo falhando, Continuar e ação editada = turno normal.
 * Rodar: npx tsx scripts/meta-check.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { Pool } from "pg";
import { DEFAULT_AGENTS } from "../src/lib/agents";
import { runTurn } from "../src/lib/engine";
import { CONTINUE_INPUT } from "../src/lib/continueScene";
import { blankSheet, normalizeRuleset } from "../src/lib/ruleset";
import type { TurnEvent } from "../src/lib/types";

// ---------- banco: o real, menos agentes, configurações de IA e api_logs ----------
const real = new Pool({ connectionString: process.env.DATABASE_URL || "postgres://rpg:rpg@localhost:5433/rpg", max: 4 });
const row = (id: string) => ({ ...DEFAULT_AGENTS.find((a) => a.id === id)!, source: "openrouter" });
const g = global as unknown as { __pgPool?: unknown; __schemaReady?: Promise<boolean> };
g.__schemaReady = Promise.resolve(true);
g.__pgPool = {
  query(text: string, params: unknown[] = []) {
    if (/FROM settings WHERE key/.test(text) && params[0] === "openrouter") return { rows: [{ value: { apiKey: "k-teste" } }] };
    if (/FROM settings WHERE key/.test(text) && ["sources", "embeddings", "advanced"].includes(params[0] as string)) return { rows: [] };
    if (/SELECT source(, params)? FROM agents/.test(text)) return { rows: [{ source: "openrouter", params: {} }] };
    if (/INSERT INTO api_logs/.test(text)) return { rows: [] };
    if (/^\s*(INSERT INTO|UPDATE|DELETE FROM) agents/.test(text)) return { rows: [] };
    if (/SELECT \* FROM agents WHERE id/.test(text) && ["gm", "scribe", "decider", "chronicler"].includes(params[0] as string))
      return { rows: [row(params[0] as string)] };
    return real.query(text, params);
  },
  connect: () => real.connect(),
  end: () => real.end(),
};

// ---------- rede ----------
let jevMeta: number | "falha" = 0;
let oocFails = false;
const calls = { gm: 0, scribe: 0, ooc: 0 };
const jevQuestions: string[][] = []; // perguntas de cada decisão do turno
let events: TurnEvent[] = [];
const sse = (text: string) =>
  new Response(
    [{ choices: [{ delta: { content: text } }] }, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }]
      .map((c) => `data: ${JSON.stringify(c)}\n\n`)
      .join("") + "data: [DONE]\n\n"
  );
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const body = JSON.parse(String(init?.body || "{}"));
  if (url.endsWith("/decisions")) {
    const qs = body.questions as Record<string, { type: string; criteria: Record<string, unknown> }>;
    // só a decisão do turno (tem perguntas de turno ou nenhuma de pós-narração); relógio, local e elenco falham
    if (qs.moved || qs.elapsed || qs.n0) return new Response("fora do roteiro", { status: 500 });
    jevQuestions.push(Object.keys(qs));
    if (jevMeta === "falha") return new Response("fora do roteiro", { status: 500 });
    const answers = Object.fromEntries(
      Object.entries(qs).map(([k, q]) => [k, q.type === "choice" ? { type: "choice", choice: Object.keys(q.criteria)[0] } : { type: "noul", noul: k === "meta" ? jevMeta : 0 }])
    );
    return Response.json({ answers });
  }
  if (!url.endsWith("/chat/completions")) return new Response("fora do roteiro", { status: 500 });
  const tools: string[] = (body.tools || []).map((t: { function: { name: string } }) => t.function.name);
  if (tools.includes("save_directive")) {
    calls.ooc++;
    if (oocFails) return new Response("fora do ar", { status: 500 });
    return Response.json({ choices: [{ message: { content: "Foi engano do registro: a tigela não devia estar aí." } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  }
  if (tools.includes("note_objective")) return calls.gm++, sse("Você olha em volta.");
  if (tools.includes("update_resource")) return calls.scribe++, Response.json({ choices: [{ message: { content: "" } }] });
  return Response.json({ choices: [{ message: { content: "?" } }] });
}) as typeof fetch;

const rs = normalizeRuleset(JSON.parse(fs.readFileSync("naruto-ruleset.json", "utf-8")));
const QUESTION = "Porque você me deu uma tigela?";

async function main() {
  const { rows: [c] } = await real.query(`INSERT INTO campaigns (name, style, ruleset) VALUES ('[teste-meta]', 'open', $1) RETURNING id`, [JSON.stringify(rs)]);
  const id: string = c.id;
  const one = async <T>(sql: string) => (await real.query(sql, [id])).rows[0] as T;
  const count = async (table: string) => Number((await one<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE campaign_id = $1`)).n);
  const snapshotInput = async () => (await one<{ player_input: string }>(`SELECT player_input FROM turn_snapshots WHERE campaign_id = $1`)).player_input;
  const turn = async (input: string, askMeta?: boolean) => {
    events = [];
    const before = { ...calls };
    await runTurn(id, input, (e) => events.push(e), undefined, undefined, askMeta);
    return { gm: calls.gm - before.gm, scribe: calls.scribe - before.scribe, ooc: calls.ooc - before.ooc };
  };
  try {
    await real.query(`INSERT INTO scenes (campaign_id, seq, mode, location) VALUES ($1, 1, 'exploration', 'Konoha')`, [id]);
    await real.query(`INSERT INTO characters (campaign_id, kind, name, sheet) VALUES ($1, 'player', 'Hugo', $2)`, [id, JSON.stringify(blankSheet(rs))]);

    // turno normal antes: a foto dele tem que sobreviver à fala fora do jogo
    assert.deepEqual(await turn("olho em volta"), { gm: 1, scribe: 1, ooc: 0 });
    assert.ok(jevQuestions.at(-1)!.includes("meta"), "ação do jogador pergunta meta");
    const msgs = await count("messages");
    assert.equal(msgs, 2);

    // 1. meta sim: sem Mestre nem Escrivão, a conversa fora do jogo responde e nada fica no chat da campanha
    jevMeta = 0.9;
    assert.deepEqual(await turn(QUESTION), { gm: 0, scribe: 0, ooc: 1 });
    assert.deepEqual(events.map((e) => e.type), ["status", "status", "ooc", "done"]);
    assert.equal(await count("messages"), msgs, "nada em messages");
    assert.equal(await snapshotInput(), "olho em volta", "a foto do turno anterior fica (o gerar novamente ainda vale para ele)");
    const notes = (await real.query(`SELECT role, content FROM gm_notes WHERE campaign_id = $1 ORDER BY id`, [id])).rows;
    assert.deepEqual(notes, [
      { role: "player", content: QUESTION },
      { role: "gm", content: "Foi engano do registro: a tigela não devia estar aí." },
    ]);

    // 2. abaixo do limiar (0,6), 3. Jev falhando e 4. fora do jogo falhando: turno normal
    for (const [label, meta, fails] of [["abaixo do limiar", 0.5, false], ["Jev falhando", "falha", false], ["fora do jogo falhando", 0.9, true]] as const) {
      jevMeta = meta;
      oocFails = fails;
      const before = await count("messages");
      const r = await turn("Você sabe se ele comeu?");
      assert.deepEqual([r.gm, r.scribe], [1, 1], label);
      assert.equal(r.ooc, fails ? 1 : 0, label);
      assert.equal(await count("messages"), before + 2, label);
      assert.equal(await snapshotInput(), "Você sabe se ele comeu?", label);
      assert.ok(!events.some((e) => e.type === "ooc"), label);
    }
    oocFails = false;

    // 5. Continuar e 6. ação editada (askMeta = false): nem perguntam
    jevMeta = 0.9;
    for (const [input, askMeta] of [[CONTINUE_INPUT, undefined], [QUESTION, false]] as const) {
      const r = await turn(input, askMeta);
      assert.deepEqual(r, { gm: 1, scribe: 1, ooc: 0 }, input);
      assert.ok(!jevQuestions.at(-1)?.includes("meta"), `${input}: sem pergunta meta`);
    }

    console.log("meta-check: ok (fala sobre o registro vai à conversa fora do jogo sem Mestre, Escrivão nem mensagem salva, e a foto do turno anterior fica; abaixo do limiar, Jev ou fora do jogo falhando, Continuar e ação editada seguem o turno normal)");
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
