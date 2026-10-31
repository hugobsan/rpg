// npx tsx scripts/cache-check.ts — cache de prompt (Claude) e custo estimado pelo catálogo do OpenRouter, sem IA,
// sem banco e sem rede: tradução para a API nativa da Anthropic e pontos de cache, corpo do OpenRouter com cache,
// mensagens de sistema juntadas sem cache, id do modelo no catálogo, conta do custo e chat() de ponta a ponta
// (API nativa em streaming pelo SDK, com a rede falsa). Banco falso em global.__pgPool, como no sources-check.
import assert from "node:assert";
import { catalogCost, catalogMatch, chat, chatRequest, mergeSystem, type ChatOptions, type Source } from "../src/lib/openrouter";
import { anthropicParams, toChatJson } from "../src/lib/anthropicApi";
import type Anthropic from "@anthropic-ai/sdk";

const ANT: Source = { id: "anthropic", name: "Anthropic", url: "https://api.anthropic.com/v1", apiKey: "sk-ant-test-0001", kind: "anthropic" };
const OR: Source = { id: "openrouter", name: "OpenRouter", url: "https://openrouter.ai/api/v1", apiKey: "k-or" };
const SONNET = { prompt: "0.000002", completion: "0.00001", input_cache_read: "0.0000001", input_cache_write: "0.0000025" };

// ---------- banco falso ----------
const state = { source: "anthropic", params: {} as Record<string, unknown> };
const logs: unknown[][] = [];
const g = global as unknown as { __pgPool?: unknown; __schemaReady?: Promise<boolean> };
g.__schemaReady = Promise.resolve(false);
g.__pgPool = {
  async query(text: string, params: unknown[] = []) {
    if (/FROM settings/.test(text)) {
      const v = { sources: [ANT], openrouter: { apiKey: "k-or" } }[params[0] as string];
      return { rows: v ? [{ value: v }] : [] };
    }
    if (/SELECT source, params FROM agents/.test(text)) return { rows: [{ source: state.source, params: state.params }] };
    if (/INSERT INTO api_logs/.test(text)) logs.push(params);
    return { rows: [] };
  },
};
const lastLog = () => {
  const l = logs[logs.length - 1]; // ordem do INSERT: agent_id, campaign_id, model, purpose, request, response, prompt, completion, ms, error, cost, provider
  return { request: JSON.parse(String(l[4])), prompt: l[6], cost: l[10] as number | null, provider: l[11], error: l[9] };
};

// ---------- rede falsa: a API nativa responde em SSE; o catálogo do OpenRouter; chat/completions do OpenRouter ----------
const sent: { url: string; body: Record<string, unknown> }[] = [];
const sse = (events: Record<string, unknown>[]) =>
  new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  const raw = input instanceof Request ? await input.text() : init?.body;
  sent.push({ url, body: raw ? JSON.parse(String(raw)) : {} });
  if (url.includes("/models?output_modalities=all"))
    return Response.json({ data: [
      { id: "anthropic/claude-sonnet-5.5", name: "Claude Sonnet 5.5", context_length: 1e6, pricing: SONNET },
      { id: "anthropic/claude-sonnet-5.5:batch", name: "batch", context_length: 1e6, pricing: { prompt: "1", completion: "1" } },
    ] });
  if (url === "https://api.anthropic.com/v1/messages")
    return sse([
      { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 9000, cache_creation_input_tokens: 400 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Você " } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "entra." } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "roll_dice", input: {} } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"expr\":" } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "\"1d20\"}" } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 50 } },
      { type: "message_stop" },
    ]);
  if (url.endsWith("/chat/completions")) return Response.json({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 3, completion_tokens: 1, cost: 0.5 } });
  return new Response("não achei", { status: 404 });
}) as typeof fetch;

const TOOLS: ChatOptions["tools"] = [
  { type: "function", function: { name: "roll_dice", description: "rola", parameters: { type: "object", properties: { expr: { type: "string" } } } } },
  { type: "function", function: { name: "set_scene", description: "cena", parameters: { type: "object", properties: {} } } },
];
const GM: ChatOptions = {
  model: "claude-sonnet-5-5",
  max_tokens: 3000,
  temperature: 0.8,
  tools: TOOLS,
  agentId: "gm",
  purpose: "check",
  messages: [
    { role: "system", content: "FIXO" },
    { role: "system", content: "TURNO" },
    { role: "user", content: "abro a porta" },
    { role: "assistant", content: null, tool_calls: [
      { id: "c1", type: "function", function: { name: "roll_dice", arguments: "{\"expr\":\"1d20\"}" } },
      { id: "c2", type: "function", function: { name: "set_scene", arguments: "{quebrado" } },
    ] },
    { role: "tool", tool_call_id: "c1", name: "roll_dice", content: "17" },
    { role: "tool", tool_call_id: "c2", name: "set_scene", content: "Erro: json" },
    { role: "user", content: "(Sistema: registre o NPC)" },
    { role: "assistant", content: "" }, // vazio: some (a API recusa texto vazio)
  ],
};

async function main() {
  // 1. tradução para a API nativa e os três pontos de cache
  const p = anthropicParams(GM);
  assert.deepEqual(p.cache_control, { type: "ephemeral" }, "cache automático no fim da conversa");
  const system = p.system as Anthropic.TextBlockParam[];
  assert.deepEqual(system.map((b) => b.text), ["FIXO", "TURNO"], "cada mensagem de sistema vira um bloco, na ordem");
  assert.deepEqual(system[0].cache_control, { type: "ephemeral" }, "ponto de cache no fim do prefixo fixo");
  assert.equal(system[1].cache_control, undefined);
  assert.deepEqual(p.tools!.map((t) => ("cache_control" in t ? t.cache_control : undefined)), [undefined, { type: "ephemeral" }], "ponto de cache na última tool");
  assert.equal((p.tools![0] as Anthropic.Tool).input_schema.type, "object");
  assert.ok(!("temperature" in p) && !("thinking" in p), "sem temperature nem thinking, como na camada compatível");
  assert.equal(p.max_tokens, 3000);
  assert.deepEqual(p.messages.map((m) => m.role), ["user", "assistant", "user"], "tool_result e o aviso seguinte numa mensagem só de user; assistant vazio some");
  const [, asst, results] = p.messages as unknown as { content: Record<string, unknown>[] }[];
  assert.deepEqual(asst.content.map((b) => [b.type, b.input]), [["tool_use", { expr: "1d20" }], ["tool_use", {}]], "argumento quebrado vira {}");
  assert.deepEqual(results.content.map((b) => b.type), ["tool_result", "tool_result", "text"]);
  assert.equal(results.content[0].tool_use_id, "c1");

  // 2. volta: JSON de readStream, cache em prompt_tokens_details, recusa vira erro
  const msg = (stop: Anthropic.StopReason, content: unknown[]) => ({
    id: "m", model: "claude-sonnet-5-5", content, stop_reason: stop,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 80, cache_creation_input_tokens: 20 },
  }) as unknown as Anthropic.Message;
  const j = toChatJson(msg("tool_use", [{ type: "thinking", thinking: "", signature: "s" }, { type: "text", text: "oi" }, { type: "tool_use", id: "t", name: "roll_dice", input: { expr: "1d6" } }])) as {
    choices: { message: { content: string; tool_calls: { function: { arguments: string } }[] }; finish_reason: string }[]; usage: unknown;
  };
  assert.equal(j.choices[0].message.content, "oi", "raciocínio fica de fora");
  assert.equal(j.choices[0].message.tool_calls[0].function.arguments, "{\"expr\":\"1d6\"}");
  assert.equal(j.choices[0].finish_reason, "tool_calls");
  assert.deepEqual(j.usage, { prompt_tokens: 110, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 20 } });
  assert.ok((toChatJson(msg("refusal", [])) as { error?: unknown }).error, "recusa vira erro");

  // 3. OpenRouter com cache: automático + ponto fixo na 1ª mensagem de sistema; sem cache, corpo de antes
  const orGm = { ...GM, model: "anthropic/claude-sonnet-5.5" };
  const c = chatRequest(orGm, OR, true).body as { cache_control: unknown; messages: { content: unknown }[] };
  assert.deepEqual(c.cache_control, { type: "ephemeral" });
  assert.deepEqual(c.messages[0].content, [{ type: "text", text: "FIXO", cache_control: { type: "ephemeral" } }]);
  assert.equal(c.messages[1].content, "TURNO");
  const off = chatRequest(orGm, OR).body;
  assert.ok(!("cache_control" in off) && off.messages === orGm.messages, "sem cache, nada muda");
  assert.ok(!("cache_control" in chatRequest(GM, ANT, true).body), "fora do OpenRouter o cache não entra no corpo OpenAI");

  // 4. sem cache, as mensagens de sistema seguidas voltam a ser uma só (o texto de antes)
  assert.deepEqual(mergeSystem(GM.messages).slice(0, 2).map((m) => [m.role, m.content]), [["system", "FIXO\nTURNO"], ["user", "abro a porta"]]);
  assert.equal(mergeSystem([{ role: "user", content: "a" }, { role: "user", content: "b" }]).length, 2, "só junta sistema");

  // 5. modelo de outra fonte no catálogo e a conta do custo
  const list = [{ id: "anthropic/claude-sonnet-5.5:batch" }, { id: "anthropic/claude-sonnet-5.5" }, { id: "anthropic/claude-haiku-4.5" }, { id: "openai/gpt-6.1-terra" }];
  assert.equal(catalogMatch("claude-sonnet-5-5", list)?.id, "anthropic/claude-sonnet-5.5", "hífen da versão vira ponto; :batch fica de fora");
  assert.equal(catalogMatch("claude-haiku-4-5-20251001", list)?.id, "anthropic/claude-haiku-4.5", "data no fim cai");
  assert.equal(catalogMatch("gpt-6.1-terra", list)?.id, "openai/gpt-6.1-terra");
  assert.equal(catalogMatch("anthropic/claude-sonnet-5.5", list)?.id, "anthropic/claude-sonnet-5.5");
  assert.equal(catalogMatch("modelo-local", list), undefined);
  const usage = { prompt_tokens: 10000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 8000, cache_write_tokens: 1000 } };
  const near = (a: number | null, b: number) => assert.ok(a != null && Math.abs(a - b) < 1e-12, `${a} ≠ ${b}`);
  near(catalogCost(SONNET, usage), (1000 * 2 + 8000 * 0.1 + 1000 * 2.5 + 500 * 10) / 1e6);
  near(catalogCost({ prompt: "0.000002", completion: "0.00001" }, usage), (10000 * 2 + 500 * 10) / 1e6); // sem preço de cache: o de entrada
  assert.equal(catalogCost({ prompt: "-1", completion: "-1" }, usage), null, "preço variável não estima");

  // 6. chat() de ponta a ponta na fonte Anthropic com cache: API nativa em streaming, custo pelo catálogo
  state.params = { cache: true, catalogCost: true };
  const deltas: string[] = [];
  const r = await chat({ ...GM, onDelta: (t) => deltas.push(t) });
  const nat = sent.filter((x) => x.url === "https://api.anthropic.com/v1/messages");
  assert.equal(nat.length, 1, "foi pela API nativa, não por /chat/completions");
  assert.equal(nat[0].body.stream, true);
  assert.deepEqual(nat[0].body.cache_control, { type: "ephemeral" });
  assert.equal(deltas.join(""), "Você entra.", "texto em streaming");
  assert.equal(r.content, "Você entra.");
  assert.deepEqual(r.toolCalls.map((t) => [t.id, t.function.name, JSON.parse(t.function.arguments)]), [["toolu_1", "roll_dice", { expr: "1d20" }]]);
  const log = lastLog();
  assert.equal(log.error, null);
  assert.equal(log.provider, "anthropic");
  assert.equal(log.prompt, 9500, "prompt_tokens soma entrada, cache lido e gravado");
  assert.equal(log.request.cache, true);
  near(log.cost, (100 * 2 + 9000 * 0.1 + 400 * 2.5 + 50 * 10) / 1e6);

  // 7. mesma fonte sem cache e sem custo estimado: camada compatível, sistema juntado, custo nulo
  state.params = {};
  sent.length = 0;
  await chat(GM);
  assert.deepEqual(sent.map((x) => x.url), ["https://api.anthropic.com/v1/chat/completions"]);
  assert.equal((sent[0].body.messages as unknown[]).length, GM.messages.length - 1, "duas mensagens de sistema viraram uma");
  assert.equal(lastLog().cost, null);
  assert.equal(lastLog().request.cache, undefined);

  // 8. cache ligado num modelo que não é da Anthropic no OpenRouter: ignorado
  state.source = "openrouter";
  state.params = { cache: true };
  sent.length = 0;
  await chat({ ...GM, model: "google/gemini-3.8-flash" });
  assert.ok(!("cache_control" in sent[0].body), "cache só em modelo da Anthropic");
  assert.equal(lastLog().cost, 0.5, "OpenRouter: custo real");
  await chat(orGm);
  assert.deepEqual(sent[1].body.cache_control, { type: "ephemeral" }, "anthropic/* no OpenRouter leva o cache");

  console.log("cache-check ok");
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
