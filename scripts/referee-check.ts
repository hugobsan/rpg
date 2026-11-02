/**
 * Árbitro sem IA: roda o runTurn de ponta a ponta numa campanha temporária, com a rede falsa (Jev, Árbitro, Mestre e
 * Escrivão respondem por roteiro; embeddings falham e caem no padrão). Os agentes e as configurações reais não são
 * lidos nem mexidos: fonte, chave, api_logs e a semeadura de agentes são interceptados.
 * Confere: com mechanic sim, o Árbitro resolve antes e o Mestre narra numa chamada só, com o resultado no contexto; o
 * dano só rola se a técnica passou; o treino anda o relógio; a guarda não deixa o Mestre repetir; com mechanic não ou
 * o Jev falhando, o Árbitro não é chamado.
 * Rodar: npx tsx scripts/referee-check.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { DEFAULT_AGENTS } from "../src/lib/agents";
import { runTurn } from "../src/lib/engine";
import { executeGmTool } from "../src/lib/tools";
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
    if (/^\s*(INSERT INTO|UPDATE|DELETE FROM) agents/.test(text)) return { rows: [] }; // agentes do banco ficam como estão
    if (/SELECT \* FROM agents WHERE id/.test(text) && ["gm", "referee", "scribe", "decider", "chronicler"].includes(params[0] as string))
      return { rows: [row(params[0] as string)] };
    return real.query(text, params);
  },
  connect: () => real.connect(),
  end: () => real.end(),
};

// ---------- rede: Jev (só a decisão do turno), Árbitro, Mestre (em streaming) e Escrivão por roteiro ----------
type Call = { name: string; args: Record<string, unknown> };
type Reply = { text: string; calls: Call[] };
let jevMechanic: number | "falha" = 0.9;
const refScript: Reply[] = [];
const gmScript: Reply[] = [];
const refReqs: { messages: { role: string; content: string }[]; tools: string[] }[] = [];
const gmReqs: { messages: { role: string; content: unknown; name?: string }[] }[] = [];
const scribeReqs: { messages: { role: string; content: string }[] }[] = [];
let events: TurnEvent[] = [];
const toolCalls = (calls: Call[]) => calls.map((c, i) => ({ id: `c${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }));
const json = (r: Reply) =>
  Response.json({ choices: [{ message: { content: r.text, tool_calls: r.calls.length ? toolCalls(r.calls) : undefined } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const body = JSON.parse(String(init?.body || "{}"));
  if (url.endsWith("/decisions")) {
    // só a decisão do turno (tem a pergunta mechanic); relógio, local e elenco caem no padrão
    if (jevMechanic === "falha" || !body.questions?.mechanic) return new Response("fora do roteiro", { status: 500 });
    const answers = Object.fromEntries(
      Object.entries(body.questions as Record<string, { type: string; criteria: Record<string, unknown> }>).map(([k, q]) => [
        k,
        q.type === "choice" ? { type: "choice", choice: Object.keys(q.criteria)[0] } : { type: "noul", noul: k === "mechanic" ? jevMechanic : 0 },
      ])
    );
    return Response.json({ answers });
  }
  if (!url.endsWith("/chat/completions")) return new Response("fora do roteiro", { status: 500 });
  const tools: string[] = (body.tools || []).map((t: { function: { name: string } }) => t.function.name);
  if (tools.includes("note_objective")) {
    gmReqs.push({ messages: body.messages });
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
  if (tools.includes("train")) {
    refReqs.push({ messages: body.messages, tools });
    const r = refScript.shift();
    assert.ok(r, "Árbitro chamado além do roteiro");
    events.push({ type: "status", text: "[árbitro]" });
    return json(r);
  }
  if (tools.includes("update_resource")) {
    scribeReqs.push({ messages: body.messages });
    return json({ text: "", calls: [] });
  }
  return Response.json({ choices: [{ message: { content: "?" } }] }); // Cronista (nome do local): não sabe
}) as typeof fetch;

const rs = normalizeRuleset(JSON.parse(fs.readFileSync("naruto-ruleset.json", "utf-8")));
const BLOCK = "JÁ RESOLVIDO NESTE TURNO";
const arc = (title: string, status: string, canonEvents: string[], notes: string[] = []) => ({ title, summary: `resumo de ${title}`, canonEvents, hooks: [`gancho de ${title}`], status, notes });
const script = {
  premise: "premissa do teste",
  arcs: [arc("Academia", "done", ["formatura"]), arc("Ondas", "active", ["ponte"], ["nota 1", "nota 2"]), arc("Exame", "pending", ["prova escrita"]), arc("Invasão", "pending", ["ataque", "funeral"])],
};

async function main() {
  const world = `test-${randomUUID()}`;
  const { rows: [c] } = await real.query(
    `INSERT INTO campaigns (name, style, ruleset, state, script) VALUES ('[teste-árbitro]', 'open', $1, '{"clock":{"minutes":480}}', $2) RETURNING id`,
    [JSON.stringify({ ...rs, world }), JSON.stringify(script)]
  );
  const id: string = c.id;
  const db = async <T>(sql: string) => (await real.query(sql, [id])).rows as T[];
  const chakra = async () => (await db<{ v: number }>(`SELECT (sheet->'resources'->'chakra'->>'current')::int AS v FROM characters WHERE campaign_id = $1 AND kind = 'player'`))[0].v;
  const ctxOf = (i: number) => gmReqs[i].messages.map((m) => String(m.content ?? "")).join("\n");
  try {
    const { rows: [lib] } = await real.query(
      `INSERT INTO library (world, campaign_id, kind, name, data) VALUES ($1, $2, 'ability', 'Katon Teste', $3) RETURNING id`,
      [world, id, JSON.stringify({ name: "Katon Teste", type: "ninjutsu", rank: "C", effect: "bola de fogo", damage: "2d6" })]
    );
    await real.query(`INSERT INTO scenes (campaign_id, seq, mode, location) VALUES ($1, 1, 'battle', 'Campo de treino')`, [id]);
    await real.query(
      `INSERT INTO characters (campaign_id, kind, name, sheet) VALUES ($1, 'player', 'Hugo', $2), ($1, 'npc', 'Iruka', $3)`,
      [id, JSON.stringify({ ...blankSheet(rs), abilities: [{ ref: Number(lib.id), progress: 30 }] }), JSON.stringify(blankSheet(rs))]
    );
    const c0 = await chakra();

    // 1. mechanic sim: o Árbitro resolve (sempre para o jogador, mesmo com outro nome) e o dano rola; o Mestre narra numa chamada
    refScript.push({
      text: "",
      calls: [
        { name: "roll_dice", args: { notation: "2d6", reason: "dano de Katon Teste" } },
        { name: "use_ability", args: { character: "Iruka", ability: "Katon Teste", target: "Iruka" } }, // disputa: sem CD, o dano vale
      ],
    });
    gmScript.push({ text: "A bola de fogo explode diante do Iruka.", calls: [] });
    events = [];
    await runTurn(id, "uso o Katon Teste no Iruka", (e) => events.push(e));
    assert.equal(refReqs.length, 1, "uma chamada ao Árbitro");
    assert.deepEqual(new Set(refReqs[0].tools), new Set(["use_ability", "train", "roll_dice"]));
    const ask = refReqs[0].messages[1].content;
    assert.match(ask, /--- JOGADOR ---\nHugo \(player\)[\s\S]*Katon Teste/, "o Árbitro vê a ficha do jogador");
    assert.match(ask, /REGRAS DA MESA[\s\S]*Escala de CD/);
    assert.match(ask, /Treino simultâneo/);
    assert.match(ask, /NPCs em cena: Iruka/);
    assert.match(ask, /AÇÃO DO JOGADOR ---\nuso o Katon Teste no Iruka/);
    assert.equal(gmReqs.length, 1, "o Mestre narra numa chamada só");
    const ctx = ctxOf(0);
    assert.match(ctx, new RegExp(`${BLOCK}[^\\n]*\\n- use_ability \\{"character":"Hugo".*Custo pago: 6 chakra`), "resultado no contexto, para o jogador");
    assert.match(ctx, /\n- roll_dice .*dano de Katon Teste.*TOTAL/, "dano rolado depois da técnica");
    // roteiro no contexto: ponto atual, próximos eventos e arco seguinte, sem precisar do get_script
    assert.match(ctx, /ROTEIRO: ARCO ATIVO \(2º de 4\) ---\nOndas: resumo de Ondas\nEventos canônicos deste arco: ponte\nGanchos: gancho de Ondas\nPonto atual: nota 2\nNotas anteriores: nota 1\nPróximos eventos canônicos \(depois deste arco\): prova escrita \| ataque\nArco seguinte: Exame: resumo de Exame\n/);
    const toolCtx = { campaign: { id, script } as never, scene: {} as never, emit: () => {} };
    const short = JSON.parse(await executeGmTool("get_script", {}, toolCtx));
    assert.deepEqual(short.arcs.map((a: { title: string }) => a.title), ["Ondas", "Exame"], "get_script: arco ativo e o seguinte");
    assert.deepEqual(short.otherArcs, ["Academia (done)", "Invasão (pending)"]);
    assert.equal(JSON.parse(await executeGmTool("get_script", { full: true }, toolCtx)).arcs.length, 4, "full=true: o roteiro inteiro");
    assert.equal(await chakra(), c0 - 6, "custo cobrado uma vez, do jogador");
    assert.ok(events.findIndex((e) => e.type === "dice") < events.findIndex((e) => e.type === "status" && e.text === "[mestre]"), "dados antes do Mestre");
    assert.match(scribeReqs[0].messages[1].content, /JÁ FEITO PELO MESTRE NESTE TURNO \(não repita\) ---\nuse_ability .*Katon Teste/, "o Escrivão sabe do que o Árbitro fez");

    // 2. guarda: o Mestre chama de novo a mesma técnica para o jogador e recebe o resultado já resolvido; dano de técnica que falhou não rola
    refScript.push({ text: "", calls: [{ name: "use_ability", args: { ability: "Katon Teste", dc: 100 } }, { name: "roll_dice", args: { notation: "2d6", reason: "dano" } }] });
    gmScript.push(
      { text: "", calls: [{ name: "use_ability", args: { character: "Hugo", ability: "katon teste", dc: 15 } }] },
      { text: "O fogo se apaga antes de chegar.", calls: [] }
    );
    const c1 = await chakra();
    await runTurn(id, "tento de novo o Katon Teste", (e) => events.push(e));
    assert.equal(gmReqs.length, 3);
    assert.ok(!/\n- roll_dice/.test(ctxOf(1)), "técnica falhou: sem dano");
    const again = gmReqs[2].messages.find((m) => m.role === "tool" && m.name === "use_ability");
    assert.match(String(again?.content), /^Já resolvido neste turno: Katon Teste .*FALHA/, "a guarda devolve o resultado do Árbitro");
    assert.equal(await chakra(), c1 - 6, "a guarda não cobra de novo");

    // 3. treino: o relógio anda pelas horas do treino
    refScript.push({ text: "", calls: [{ name: "train", args: { target: "taijutsu", hours: 2 } }] });
    gmScript.push({ text: "Duas horas de socos no tronco.", calls: [] });
    await runTurn(id, "treino taijutsu por duas horas", (e) => events.push(e));
    assert.match(ctxOf(3), new RegExp(`${BLOCK}[^\\n]*\\n- train .*Treino de 2 h`));
    const [camp] = await db<{ state: { clock: { minutes: number } } }>(`SELECT state FROM campaigns WHERE id = $1`);
    assert.equal(camp.state.clock.minutes, 480 + 120);

    // 4. mechanic não e 5. Jev falhando: o Árbitro não roda e o contexto não tem o bloco
    for (const p of [0.1, "falha"] as const) {
      jevMechanic = p;
      gmScript.push({ text: "Você olha em volta.", calls: [] });
      const before: { ref: number; gm: number } = { ref: refReqs.length, gm: gmReqs.length };
      await runTurn(id, "olho em volta", (e) => events.push(e));
      assert.equal(refReqs.length, before.ref, `Árbitro não chamado (${p})`);
      assert.equal(gmReqs.length, before.gm + 1);
      assert.ok(!ctxOf(gmReqs.length - 1).includes(BLOCK));
    }
    assert.equal(refScript.length + gmScript.length, 0);

    console.log("referee-check: ok (Árbitro resolve antes e o Mestre narra numa chamada, dano só se a técnica passou, treino anda o relógio, guarda contra repetição, mechanic não e Jev falhando não chamam o Árbitro)");
  } finally {
    await new Promise((r) => setTimeout(r, 300)); // o índice do histórico roda depois do done
    await real.query(`DELETE FROM campaigns WHERE id = $1`, [id]);
    await real.query(`DELETE FROM library WHERE world = $1`, [world]);
    await real.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
