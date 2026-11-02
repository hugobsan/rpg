/**
 * Conversa com NPC em cena no chat do NPC, sem IA: roda o runTurn e o fim da conversa de ponta a ponta numa campanha
 * temporária, com a rede falsa (Jev, Mestre, Escrivão e agente NPC por roteiro; o resto falha e cai no padrão). Os
 * agentes e as configurações reais não são lidos nem mexidos: fonte, chave, api_logs e a semeadura de agentes são
 * interceptados.
 * Confere: conversa sim = sem Mestre nem Escrivão, o NPC responde, nada em messages, a foto do turno anterior fica e o
 * evento npc_talk traz as duas falas; ao fechar, o Escrivão registra (add_item) com a conversa, o relógio anda e a linha
 * 'talk' entra no chat; o próximo turno do Mestre recebe a conversa no contexto uma vez só; abaixo do limiar, Jev
 * falhando, NPC recusando, meta junto (prioridade), Continuar, ação editada e batalha = turno normal.
 * Rodar: npx tsx scripts/talk-check.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { Pool } from "pg";
import { DEFAULT_AGENTS } from "../src/lib/agents";
import { runTurn } from "../src/lib/engine";
import { discardNpcChat, endNpcChat } from "../src/lib/npc";
import { messagePage } from "../src/lib/messages";
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
    if (/SELECT \* FROM agents WHERE id/.test(text) && ["gm", "scribe", "decider", "chronicler", "npc"].includes(params[0] as string))
      return { rows: [row(params[0] as string)] };
    return real.query(text, params);
  },
  connect: () => real.connect(),
  end: () => real.end(),
};

// ---------- rede ----------
let jevTalk: number | "falha" = 0; // P de Teuchi na pergunta talk
let jevMeta = 0;
let willing = 0.9;
const calls = { gm: 0, scribe: 0, npc: 0 };
const jevQuestions: string[][] = []; // perguntas de cada decisão do turno
const gmContexts: string[] = []; // contexto do turno de cada chamada do Mestre
let scribeInput = "";
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
    if (qs.willing) return Response.json({ answers: { willing: { type: "noul", noul: willing } } });
    if (qs.elapsed) return Response.json({ answers: { elapsed: { type: "choice", choice: "quinze_minutos" } } });
    if (qs.moved || qs.n0 || qs.m0) return new Response("fora do roteiro", { status: 500 });
    jevQuestions.push(Object.keys(qs));
    if (jevTalk === "falha") return new Response("fora do roteiro", { status: 500 });
    const answers = Object.fromEntries(
      Object.entries(qs).map(([k, q]) => [
        k,
        k === "talk"
          ? { type: "choice", choice: (jevTalk as number) >= 0.5 ? "Teuchi" : "nenhum", probabilities: { Teuchi: jevTalk, nenhum: 1 - (jevTalk as number) } }
          : q.type === "choice"
            ? { type: "choice", choice: Object.keys(q.criteria)[0] }
            : { type: "noul", noul: k === "meta" ? jevMeta : 0 },
      ])
    );
    return Response.json({ answers });
  }
  if (!url.endsWith("/chat/completions")) return new Response("fora do roteiro", { status: 500 });
  const tools: string[] = (body.tools || []).map((t: { function: { name: string } }) => t.function.name);
  const system = String(body.messages?.[0]?.content || "");
  if (tools.includes("save_directive")) return Response.json({ choices: [{ message: { content: "Fora do jogo: anotado." } }] });
  if (tools.includes("note_objective")) {
    gmContexts.push(String(body.messages.at(-2).content));
    return calls.gm++, sse('**Teuchi:** "Vai querer uma tigela?"');
  }
  if (tools.includes("update_resource")) {
    calls.scribe++;
    scribeInput = String(body.messages[1].content);
    if (!scribeInput.includes("Conversa particular")) return Response.json({ choices: [{ message: { content: "" } }] });
    const call = { id: "c1", type: "function", function: { name: "add_item", arguments: JSON.stringify({ character: "Hugo", name: "Lámen de porco", qty: 1 }) } };
    return Response.json({ choices: [{ message: { content: "", tool_calls: [call] } }] });
  }
  if (system.includes("PERSONAGEM QUE VOCÊ INTERPRETA")) {
    calls.npc++;
    assert.ok(system.includes("Vai querer uma tigela?"), "o NPC em cena vê a última narração");
    return Response.json({ choices: [{ message: { content: "Ela foi ao mercado. Uma tigela de porco, então? Fica 300 ryō." } }] });
  }
  return Response.json({ choices: [{ message: { content: '{"memories":[]}' } }] }); // Cronista das memórias: nenhuma
}) as typeof fetch;

const rs = normalizeRuleset(JSON.parse(fs.readFileSync("naruto-ruleset.json", "utf-8")));
const LINE = "Acho que vou querer sim, hoje sua filha não está com você?";

async function main() {
  const { rows: [c] } = await real.query(
    `INSERT INTO campaigns (name, style, ruleset, state) VALUES ('[teste-conversa]', 'open', $1, '{"clock":{"minutes":1260}}') RETURNING id`,
    [JSON.stringify(rs)]
  );
  const id: string = c.id;
  const one = async <T>(sql: string) => (await real.query(sql, [id])).rows[0] as T;
  const count = async (table: string) => Number((await one<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE campaign_id = $1`)).n);
  const snapshotInput = async () => (await one<{ player_input: string }>(`SELECT player_input FROM turn_snapshots WHERE campaign_id = $1`)).player_input;
  const clock = async () => (await one<{ m: number }>(`SELECT (state->'clock'->>'minutes')::int AS m FROM campaigns WHERE id = $1`)).m;
  const turn = async (input: string, askMeta?: boolean) => {
    events = [];
    const before = { ...calls };
    await runTurn(id, input, (e) => events.push(e), undefined, undefined, askMeta);
    return { gm: calls.gm - before.gm, scribe: calls.scribe - before.scribe, npc: calls.npc - before.npc };
  };
  try {
    await real.query(`INSERT INTO scenes (campaign_id, seq, mode, location) VALUES ($1, 1, 'downtime', 'Ichiraku')`, [id]);
    await real.query(`INSERT INTO characters (campaign_id, kind, name, sheet) VALUES ($1, 'player', 'Hugo', $2)`, [id, JSON.stringify(blankSheet(rs))]);
    const { rows: [teuchi] } = await real.query(
      `INSERT INTO characters (campaign_id, kind, name, sheet, persona, active) VALUES ($1, 'npc', 'Teuchi', $2, '{"personality":"caloroso"}', true) RETURNING id`,
      [id, JSON.stringify(blankSheet(rs))]
    );
    // turno normal antes (a narração dele o NPC tem que ver): a foto dele tem que sobreviver à conversa
    assert.deepEqual(await turn("olho o cardápio"), { gm: 1, scribe: 1, npc: 0 });
    assert.ok(jevQuestions.at(-1)!.includes("talk"), "ação do jogador pergunta talk");
    gmContexts.length = 0;
    const msgs = await count("messages");

    // 1. conversa sim: o NPC responde, sem Mestre nem Escrivão, nada no chat da campanha, a foto anterior fica
    jevTalk = 0.9;
    assert.deepEqual(await turn(LINE), { gm: 0, scribe: 0, npc: 1 });
    assert.deepEqual(events.map((e) => e.type), ["status", "status", "npc_talk", "done"]);
    const ev = events.find((e) => e.type === "npc_talk") as Extract<TurnEvent, { type: "npc_talk" }>;
    assert.equal(ev.npcId, teuchi.id);
    assert.deepEqual(ev.messages, [
      { role: "player", content: LINE },
      { role: "npc", content: "Ela foi ao mercado. Uma tigela de porco, então? Fica 300 ryō." },
    ]);
    assert.equal(await count("messages"), msgs, "nada em messages");
    assert.equal(await snapshotInput(), "olho o cardápio", "a foto do turno anterior fica");
    assert.equal(await count("npc_chats"), 2, "a fala do jogador e a resposta ficam na conversa particular");

    // 2. ao fechar: relógio anda (Jev: ~15 min), Escrivão registra com a conversa, linha 'talk' no chat
    const t0 = await clock();
    await endNpcChat(id, teuchi.id, ev.sessionId);
    assert.equal(await clock(), t0 + 15, "o relógio anda pelo tempo da conversa");
    assert.ok(scribeInput.includes(`Hugo: ${LINE}`) && scribeInput.includes("Teuchi: Ela foi ao mercado"), "o Escrivão lê a conversa");
    const inv = (await one<{ sheet: { inventory: { name: string; qty: number }[] } }>(`SELECT sheet FROM characters WHERE campaign_id = $1 AND kind = 'player'`)).sheet.inventory;
    assert.ok(inv.some((i) => i.name === "Lámen de porco"), "add_item do Escrivão aplicado");
    const page = await messagePage(id);
    const last = page.messages.at(-1) as { role: string; content: string; meta: { notes?: string[] } };
    assert.deepEqual([last.role, last.content], ["talk", "Conversa particular com Teuchi"]);
    assert.ok(last.meta.notes?.[0]?.startsWith("add_item"), "o que o Escrivão gravou fica na linha");

    // 3. o próximo turno do Mestre recebe a conversa (e o registro) uma vez só
    jevTalk = 0;
    await turn("Agradeço e como.");
    assert.ok(gmContexts.at(-1)!.includes("CONVERSA PARTICULAR QUE ACABOU DE ACONTECER") && gmContexts.at(-1)!.includes(`Hugo: ${LINE}`), "conversa no contexto");
    assert.ok(gmContexts.at(-1)!.includes("O Escrivão já registrou:\n- add_item"), "registro no contexto");
    await turn("Pago e saio.");
    assert.ok(!gmContexts.at(-1)!.includes("CONVERSA PARTICULAR"), "só uma vez");

    // 4. abaixo do limiar (0,75), Jev falhando, NPC recusando e meta junto (prioridade): turno normal ou fora do jogo
    for (const [label, talk, w, meta] of [["abaixo do limiar", 0.7, 0.9, 0], ["Jev falhando", "falha", 0.9, 0], ["NPC recusa", 0.9, 0.1, 0], ["meta junto", 0.9, 0.9, 0.9]] as const) {
      jevTalk = talk;
      willing = w;
      jevMeta = meta;
      const before = await count("messages");
      const r = await turn("Você sabe se ele comeu?");
      assert.equal(r.npc, 0, `${label}: o NPC não fala (a recusa do desvio não chama o modelo)`);
      assert.ok(!events.some((e) => e.type === "npc_talk"), label);
      if (meta) assert.deepEqual([r.gm, events.some((e) => e.type === "ooc")], [0, true], label);
      else assert.deepEqual([r.gm, r.scribe, await count("messages")], [1, 1, before + 2], label);
    }
    willing = 0.9;
    jevMeta = 0;

    // 6. "não era uma conversa": a conversa é apagada e a mesma fala vira turno do Mestre, sem a pergunta talk
    jevTalk = 0.9;
    await turn(LINE);
    const back = events.find((e) => e.type === "npc_talk") as Extract<TurnEvent, { type: "npc_talk" }>;
    const chats = await count("npc_chats");
    await discardNpcChat(id, teuchi.id, back.sessionId);
    assert.equal(await count("npc_chats"), chats - 2, "as duas falas saem da conversa particular");
    const msgsBack = await count("messages");
    events = [];
    const g = calls.gm;
    await runTurn(id, LINE, (e) => events.push(e), undefined, undefined, true, false);
    assert.equal(calls.gm - g, 1, "o Mestre narra");
    assert.ok(!jevQuestions.at(-1)?.includes("talk"), "sem pergunta talk");
    assert.equal(await count("messages"), msgsBack + 2, "a fala e a narração no chat da campanha");

    // 5. Continuar, ação editada (askMeta = false), batalha e treino: nem perguntam
    jevTalk = 0.9;
    for (const [input, askMeta] of [[CONTINUE_INPUT, undefined], [LINE, false]] as const) {
      const r = await turn(input, askMeta);
      assert.deepEqual(r, { gm: 1, scribe: 1, npc: 0 }, input);
      assert.ok(!jevQuestions.at(-1)?.includes("talk"), `${input}: sem pergunta talk`);
    }
    await real.query(`UPDATE scenes SET mode = 'battle' WHERE campaign_id = $1`, [id]);
    assert.deepEqual(await turn(LINE), { gm: 1, scribe: 1, npc: 0 }, "batalha");
    assert.ok(!jevQuestions.at(-1)?.includes("talk"), "batalha: sem pergunta talk");
    await real.query(`UPDATE scenes SET mode = 'training' WHERE campaign_id = $1`, [id]);
    assert.deepEqual(await turn(LINE), { gm: 1, scribe: 1, npc: 0 }, "treino");
    assert.ok(!jevQuestions.at(-1)?.includes("talk"), "treino: sem pergunta talk");

    console.log("talk-check: ok (fala só com um NPC em cena vai ao chat dele sem Mestre, Escrivão nem mensagem salva; ao fechar, relógio, Escrivão e a linha no chat; o próximo turno do Mestre vê a conversa uma vez; \"não era uma conversa\" apaga e vira turno sem perguntar; limiar, Jev falhando, recusa, meta, Continuar, ação editada, batalha e treino seguem o padrão)");
  } finally {
    await new Promise((r) => setTimeout(r, 500)); // índice do histórico e memórias da conversa rodam em segundo plano
    await real.query(`DELETE FROM campaigns WHERE id = $1`, [id]);
    await real.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
