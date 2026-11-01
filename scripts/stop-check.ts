/**
 * "Parar o Mestre", sem IA: chama a rota do turno (POST) numa campanha temporária, com a rede falsa (o Mestre responde
 * por roteiro, em streaming; uma resposta "trava" no meio até a requisição ser abortada). Banco: o de DATABASE_URL, com
 * agentes, configurações de IA e api_logs interceptados, como no scribe-check.
 * Confere: parar no meio da narração aborta o fetch do Mestre, o turno volta à foto (o que a ferramenta gravou some), a
 * ação do jogador fica, o SSE acaba sem narração e o api_logs registra a chamada interrompida; parar e logo gerar de
 * novo não cruza os dois turnos (o novo espera a volta à foto).
 * Rodar: npx tsx scripts/stop-check.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { NextRequest } from "next/server";
import { DEFAULT_AGENTS } from "../src/lib/agents";
import { blankSheet, normalizeRuleset } from "../src/lib/ruleset";
import type { TurnEvent } from "../src/lib/types";
import { POST } from "../src/app/api/campaigns/[id]/turn/route";

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
    if (/^\s*(INSERT INTO|UPDATE|DELETE FROM) agents/.test(text)) return { rows: [] };
    if (/SELECT \* FROM agents WHERE id/.test(text) && params[0] === "scribe") return { rows: [scribeRow] };
    return real.query(text, params);
  },
  connect: () => real.connect(),
  end: () => real.end(),
};

// ---------- rede: o Mestre por roteiro, em streaming; hang = manda o texto e espera o abort ----------
type Reply = { text: string; calls?: { name: string; args: Record<string, unknown> }[]; hang?: boolean };
const gmScript: Reply[] = [];
const gmReqs: { messages: { role: string; content: unknown }[]; signal?: AbortSignal | null }[] = [];
const sse = (c: object) => `data: ${JSON.stringify(c)}\n\n`;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (!url.endsWith("/chat/completions")) return new Response("fora do roteiro", { status: 500 });
  const body = JSON.parse(String(init?.body));
  const tools: string[] = (body.tools || []).map((t: { function: { name: string } }) => t.function.name);
  if (!tools.includes("use_ability")) return Response.json({ choices: [{ message: { content: "?" } }] }); // Escrivão, Cronista
  const signal = init?.signal;
  gmReqs.push({ messages: body.messages, signal });
  signal?.throwIfAborted(); // como o fetch de verdade: sinal já abortado nem sai
  const r = gmScript.shift();
  assert.ok(r, "Mestre chamado além do roteiro");
  const calls = (r.calls ?? []).map((c, index) => ({ index, id: `c${index}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }));
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(ctl) {
        ctl.enqueue(enc.encode(sse({ id: "gen-x", choices: [{ delta: { content: r.text } }] })));
        // o undici erra o corpo com o motivo do abort: é assim que o readStream fica sabendo. Com atraso, para abrir a
        // janela em que um turno novo sem a fila cruzaria com a volta à foto do parado
        if (r.hang) return signal?.addEventListener("abort", () => setTimeout(() => ctl.error(signal.reason), 200));
        if (calls.length) ctl.enqueue(enc.encode(sse({ choices: [{ delta: { tool_calls: calls } }] })));
        ctl.enqueue(enc.encode(sse({ choices: [{ delta: {}, finish_reason: calls.length ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) + "data: [DONE]\n\n"));
        ctl.close();
      },
    })
  );
}) as typeof fetch;

const rs = normalizeRuleset(JSON.parse(fs.readFileSync("naruto-ruleset.json", "utf-8")));

// ---------- rota ----------
let campaignId = "";
const post = (body: object) =>
  POST(new Request("http://teste/turn", { method: "POST", body: JSON.stringify(body) }) as unknown as NextRequest, {
    params: Promise.resolve({ id: campaignId }),
  });
/** Lê o SSE do turno até o fim, guardando os eventos em evs. */
async function readTurn(res: Response, evs: TurnEvent[]) {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return evs;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const p of parts) if (p.startsWith("data: ")) evs.push(JSON.parse(p.slice(6)));
  }
}
const until = async (ok: () => boolean, what: string) => {
  for (let i = 0; i < 500 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(ok(), `esperando ${what}`);
};

async function main() {
  const world = `test-${randomUUID()}`;
  const { rows: [c] } = await real.query(
    `INSERT INTO campaigns (name, style, ruleset, state) VALUES ('[teste-parar]', 'open', $1, '{"clock":{"minutes":480}}') RETURNING id`,
    [JSON.stringify({ ...rs, world })]
  );
  campaignId = c.id;
  const db = async <T>(sql: string) => (await real.query(sql, [campaignId])).rows as T[];
  const clock = async () => (await db<{ m: number }>(`SELECT (state->'clock'->>'minutes')::int AS m FROM campaigns WHERE id = $1`))[0].m;
  const msgs = async () => (await db<{ role: string; content: string }>(`SELECT role, content FROM messages WHERE campaign_id = $1 ORDER BY id`)).map((m) => `${m.role}: ${m.content}`);
  try {
    const { rows: [scene] } = await real.query(`INSERT INTO scenes (campaign_id, seq, mode, location) VALUES ($1, 1, 'exploration', 'Academia') RETURNING id`, [campaignId]);
    await real.query(`INSERT INTO characters (campaign_id, kind, name, sheet) VALUES ($1, 'player', 'Hugo', $2)`, [campaignId, JSON.stringify(blankSheet(rs))]);
    await real.query(`INSERT INTO messages (campaign_id, scene_id, role, content) VALUES ($1, $2, 'gm', 'abertura')`, [campaignId, scene.id]);

    // 1. parar no meio da narração, depois de uma rodada com ferramenta que gravou (set_time)
    gmScript.push({ text: "", calls: [{ name: "set_time", args: { hour: 20 } }] }, { text: "Você avança contra o boneco", hang: true });
    const evs: TurnEvent[] = [];
    const reading = readTurn(await post({ input: "ataco o boneco" }), evs);
    await until(() => evs.some((e) => e.type === "narration_delta"), "a narração começar");
    assert.equal(await clock(), 1200, "a ferramenta gravou durante o turno");
    const hung = gmReqs[gmReqs.length - 1].signal;
    assert.equal(hung?.aborted, false);
    const stopRes = await post({ stop: true });
    assert.equal(stopRes.status, 200);
    await reading;
    assert.equal(hung?.aborted, true, "o fetch do Mestre recebeu o abort");
    assert.ok(!evs.some((e) => e.type === "narration" || e.type === "error"), "nem narração nem erro depois de parar");
    assert.equal(evs[evs.length - 1].type, "done");
    assert.equal(await clock(), 480, "o turno voltou à foto");
    assert.deepEqual(await msgs(), ["gm: abertura", "player: ataco o boneco"], "a ação do jogador fica, sem resposta");
    const [snap] = await db<{ player_input: string }>(`SELECT player_input FROM turn_snapshots WHERE campaign_id = $1`);
    assert.equal(snap.player_input, "ataco o boneco", "gerar novamente refaz a ação parada");
    const cut = logs.filter((l) => l[0] === "gm" && l[9] === "interrompido pelo jogador (parar)");
    assert.equal(cut.length, 1, "a chamada interrompida entra em api_logs");
    assert.match(String(cut[0][5]), /Você avança contra o boneco/, "com o texto parcial");

    // 2. parar e logo gerar de novo (sem esperar o parar): o novo turno espera a volta à foto, nada se cruza
    gmScript.push({ text: "Você hesita", hang: true });
    const evs2: TurnEvent[] = [];
    const reading2 = readTurn(await post({ regenerate: true }), evs2);
    await until(() => evs2.some((e) => e.type === "narration_delta"), "a narração do gerar novamente começar");
    gmScript.push({ text: "", calls: [{ name: "set_time", args: { hour: 9 } }] }, { text: "Você acerta o boneco em cheio.", calls: [] });
    const reqsBefore = gmReqs.length;
    const stopP = post({ stop: true });
    const evs3: TurnEvent[] = [];
    const regen = readTurn(await post({ regenerate: true, feedback: "mais ação" }), evs3);
    await Promise.all([stopP, reading2, regen]);
    assert.ok(!evs2.some((e) => e.type === "narration"), "o turno parado não narrou");
    assert.equal(evs3.filter((e) => e.type === "narration").length, 1, "o novo turno narrou");
    assert.ok(!evs3.some((e) => e.type === "error"), JSON.stringify(evs3.find((e) => e.type === "error")));
    assert.equal(gmReqs.length, reqsBefore + 2, "o Mestre só foi chamado pelo turno novo");
    const asked = gmReqs[reqsBefore].messages.filter((m) => m.role === "user" && String(m.content).startsWith("ataco o boneco"));
    assert.equal(asked.length, 1, "a ação aparece uma vez só para o Mestre (a parada não duplicou)");
    assert.deepEqual(await msgs(), ["gm: abertura", "player: ataco o boneco", "gm: Você acerta o boneco em cheio."]);
    assert.equal(await clock(), 540, "só a ferramenta do turno novo valeu (9h, a partir das 8h da foto)");

    // 3. parar sem turno em andamento não faz nada
    assert.equal((await post({ stop: true })).status, 200);
    assert.equal((await msgs()).length, 3);
    assert.equal(gmScript.length, 0);
    console.log("stop-check: ok (parar aborta o fetch do Mestre, volta à foto mantendo a ação, registra o uso; parar e gerar de novo não se cruzam)");
  } finally {
    await new Promise((r) => setTimeout(r, 300)); // o índice do histórico roda depois do done
    await real.query(`DELETE FROM campaigns WHERE id = $1`, [campaignId]);
    await real.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
