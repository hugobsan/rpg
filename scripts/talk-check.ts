/**
 * Conversa com NPC em cena no chat do NPC, sem IA: roda o runTurn e o fim da conversa de ponta a ponta numa campanha
 * temporária, com a rede falsa (Jev, Narrador com o bloco de efeitos, Anotador e agente NPC por roteiro; o resto falha e cai no padrão). Os
 * agentes e as configurações reais não são lidos nem mexidos: fonte, chave, api_logs e a semeadura de agentes são
 * interceptados.
 * Confere: conversa sim = sem Narrador nem Anotador, o NPC responde, nada em messages, a foto do turno anterior fica e o
 * evento npc_talk traz as duas falas; ao fechar, o Anotador lê a conversa (item e tempo) e a linha
 * 'talk' entra no chat com a fala de encerramento do NPC (conversa nascida na campanha); a conversa fica no histórico do
 * Narrador nos turnos seguintes, com o começo, o fim, a despedida e o registro; abaixo do limiar, Jev
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
    if (/SELECT \* FROM agents WHERE id/.test(text) && ["gm", "scribe", "decider", "interpreter", "npc"].includes(params[0] as string))
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
const gmContexts: string[] = []; // mensagens (histórico e contexto do turno) de cada chamada do Mestre
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
    // pós-checagem das falas (SABE): nenhuma passou
    if (Object.keys(qs).every((k) => k.startsWith("leak_"))) return Response.json({ answers: Object.fromEntries(Object.keys(qs).map((k) => [k, { type: "noul", noul: 0 }])) });
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
  if (tools.includes("search_lore")) {
    gmContexts.push(JSON.stringify(body.messages));
    return calls.gm++, sse('**Teuchi:** "Vai querer uma tigela?"\n```efeitos\n{"time":"minutes"}\n```');
  }
  if (system.includes("Anotador")) {
    calls.scribe++;
    scribeInput = String(body.messages[1].content);
    if (!scribeInput.includes("CONVERSA PARTICULAR")) return Response.json({ choices: [{ message: { content: "" } }] });
    return Response.json({ choices: [{ message: { content: '```efeitos\n{"time":"quarter","items":[{"name":"Lámen de porco","qty":1}]}\n```' } }] });
  }
  if (system.includes("PERSONAGEM QUE VOCÊ INTERPRETA")) {
    calls.npc++;
    if (String(body.messages.at(-1).content).includes("encerrou a conversa"))
      return Response.json({ choices: [{ message: { content: "*acena com a concha* Volte sempre, Hugo!" } }] });
    assert.ok(system.includes("Vai querer uma tigela?"), "o NPC em cena vê a última narração");
    return Response.json({ choices: [{ message: { content: "Ela foi ao mercado. Uma tigela de porco, então? Fica 300 ryō." } }] });
  }
  return Response.json({ choices: [{ message: { content: "?" } }] }); // Intérprete: lixo, cai no passo genérico
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
    assert.deepEqual(await turn("olho o cardápio"), { gm: 1, scribe: 0, npc: 0 });
    assert.ok(jevQuestions.at(-1)!.includes("talk"), "ação do jogador pergunta talk");
    gmContexts.length = 0;
    const msgs = await count("messages");

    // 1. conversa sim: o NPC responde, sem Narrador nem Anotador, nada no chat da campanha, a foto anterior fica
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

    // 2. ao fechar: o Anotador lê a conversa (tempo e item), linha 'talk' no chat
    const t0 = await clock();
    const npcBefore = calls.npc;
    const ended = await endNpcChat(id, teuchi.id, ev.sessionId, true);
    assert.equal(calls.npc - npcBefore, 1, "uma chamada do NPC para a despedida");
    assert.equal("farewell" in ended && ended.farewell, "*acena com a concha* Volte sempre, Hugo!", "a despedida volta para a tela");
    assert.equal(await clock(), t0 + 15, "o relógio anda pelo tempo da conversa");
    assert.ok(scribeInput.includes(`Hugo: ${LINE}`) && scribeInput.includes("Teuchi: Ela foi ao mercado"), "o Anotador lê a conversa");
    const inv = (await one<{ sheet: { inventory: { name: string; qty: number }[] } }>(`SELECT sheet FROM characters WHERE campaign_id = $1 AND kind = 'player'`)).sheet.inventory;
    assert.ok(inv.some((i) => i.name === "Lámen de porco"), "item do bloco aplicado");
    const page = await messagePage(id);
    const last = page.messages.at(-1) as { role: string; content: string; speaker?: string; meta: { notes?: string[]; farewell?: string } };
    assert.deepEqual([last.role, last.content, last.speaker], ["talk", "Conversa particular com Teuchi", "Teuchi"]);
    assert.ok(last.meta.notes?.some((n) => n.includes("Lámen de porco")), "o que foi registrado fica na linha");
    assert.equal(last.meta.farewell, "*acena com a concha* Volte sempre, Hugo!", "a despedida fica na linha");

    // 3. a conversa fica no histórico do Mestre, no lugar dela, nos turnos seguintes (não só no próximo)
    jevTalk = 0;
    for (const input of ["Agradeço e como.", "Pago e saio."]) {
      await turn(input);
      const ctx = gmContexts.at(-1)!;
      assert.ok(ctx.includes("conversou em particular com Teuchi") && ctx.includes(`Hugo: ${LINE}`), `${input}: conversa no histórico`);
      assert.ok(ctx.includes("Teuchi, ao encerrar: *acena com a concha*"), `${input}: despedida no histórico`);
      assert.ok(ctx.includes("Ficou registrado:") && ctx.includes("Lámen de porco"), `${input}: registro no histórico`);
    }

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
      else assert.deepEqual([r.gm, r.scribe, await count("messages")], [1, 0, before + 2], label);
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
      assert.deepEqual(r, { gm: 1, scribe: 0, npc: 0 }, input);
      assert.ok(!jevQuestions.at(-1)?.includes("talk"), `${input}: sem pergunta talk`);
    }
    await real.query(`UPDATE scenes SET mode = 'battle' WHERE campaign_id = $1`, [id]);
    assert.deepEqual(await turn(LINE), { gm: 1, scribe: 0, npc: 0 }, "batalha");
    assert.ok(!jevQuestions.at(-1)?.includes("talk"), "batalha: sem pergunta talk");
    await real.query(`UPDATE scenes SET mode = 'training' WHERE campaign_id = $1`, [id]);
    assert.deepEqual(await turn(LINE), { gm: 1, scribe: 0, npc: 0 }, "treino");
    assert.ok(!jevQuestions.at(-1)?.includes("talk"), "treino: sem pergunta talk");

    console.log("talk-check: ok (fala só com um NPC em cena vai ao chat dele sem Narrador nem mensagem salva; ao fechar, o Anotador (relógio e item), despedida do NPC e a linha no chat; a conversa fica no histórico do Narrador; \"não era uma conversa\" apaga e vira turno sem perguntar; limiar, Jev falhando, recusa, meta, Continuar, ação editada, batalha e treino seguem o padrão)");
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
