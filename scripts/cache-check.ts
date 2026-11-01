// npx tsx scripts/cache-check.ts — cache de prompt (Claude) e custo estimado pelo catálogo do OpenRouter, sem IA,
// sem banco e sem rede: tradução para a API nativa da Anthropic e pontos de cache, corpo do OpenRouter com cache,
// mensagens de sistema juntadas sem cache, id do modelo no catálogo, conta do custo e chat() de ponta a ponta
// (API nativa em streaming pelo SDK, com a rede falsa). Banco falso em global.__pgPool, como no sources-check.
import assert from "node:assert";
import { catalogCost, catalogMatch, chat, chatRequest, mergeSystem, type ChatOptions, type Source } from "../src/lib/openrouter";
import { anthropicParams, toChatJson } from "../src/lib/anthropicApi";
import { windowStart } from "../src/lib/engine";
import { imageFromDataUrl } from "../src/lib/portrait";
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
      { id: "black-forest-labs/flux-3-image-klein", name: "FLUX klein", context_length: 0, pricing: { prompt: "0", completion: "0" }, architecture: { output_modalities: ["image"] } },
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
  if (url === "https://openrouter.ai/api/v1/images")
    return Response.json({ created: 1, data: [{ b64_json: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>").toString("base64"), media_type: "image/svg+xml" }], usage: { prompt_tokens: 0, completion_tokens: 4175, total_tokens: 4175, cost: 0.008 } });
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
    { role: "user", content: "entro na vila" },
    { role: "assistant", content: "A vila está quieta.", cache: true }, // fim do histórico
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
  // 1. tradução para a API nativa e os quatro pontos de cache (1 h nos que duram entre turnos, 5 min no fim)
  const p = anthropicParams(GM);
  assert.deepEqual(p.cache_control, { type: "ephemeral" }, "cache automático no fim da conversa");
  const system = p.system as Anthropic.TextBlockParam[];
  assert.deepEqual(system.map((b) => b.text), ["FIXO", "TURNO"], "cada mensagem de sistema vira um bloco, na ordem");
  const LONG = { type: "ephemeral", ttl: "1h" };
  assert.deepEqual(system[0].cache_control, LONG, "ponto de cache de 1 h no fim do prefixo fixo");
  assert.equal(system[1].cache_control, undefined);
  assert.deepEqual(p.tools!.map((t) => ("cache_control" in t ? t.cache_control : undefined)), [undefined, LONG], "ponto de cache de 1 h na última tool");
  assert.equal((p.tools![0] as Anthropic.Tool).input_schema.type, "object");
  assert.ok(!("temperature" in p) && !("thinking" in p), "sem temperature nem thinking, como na camada compatível");
  assert.equal(p.max_tokens, 3000);
  assert.deepEqual(p.messages.map((m) => m.role), ["user", "assistant", "user", "assistant", "user"], "tool_result e o aviso seguinte numa mensagem só de user; assistant vazio some");
  const hist = p.messages[1].content as Anthropic.TextBlockParam[];
  assert.deepEqual(hist[0].cache_control, LONG, "ponto de cache de 1 h no fim do histórico");
  const marks = JSON.stringify(p).split("cache_control").length - 1;
  assert.equal(marks, 4, "quatro pontos, o limite da API");
  const [, , , asst, results] = p.messages as unknown as { content: Record<string, unknown>[] }[];
  assert.deepEqual(asst.content.map((b) => [b.type, b.input]), [["tool_use", { expr: "1d20" }], ["tool_use", {}]], "argumento quebrado vira {}");
  assert.deepEqual(results.content.map((b) => b.type), ["tool_result", "tool_result", "text"]);
  assert.equal(results.content[0].tool_use_id, "c1");

  // 1b. sem cache (agente com raciocínio e cache desligado): nenhum ponto de cache; effort vai em output_config
  const nc = anthropicParams({ ...GM, reasoning: { effort: "low" } }, false);
  assert.equal(nc.cache_control, undefined);
  assert.ok((nc.system as Anthropic.TextBlockParam[]).every((b) => !b.cache_control) && nc.tools!.every((t) => !("cache_control" in t) || !t.cache_control));
  assert.deepEqual(nc.output_config, { effort: "low" }, "effort do agente vai para a API nativa");
  assert.equal(anthropicParams({ ...GM, reasoning: { effort: "minimal" } }).output_config, undefined, "effort fora da escala fica de fora");
  assert.equal(p.output_config, undefined);

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
  assert.deepEqual(c.messages[0].content, [{ type: "text", text: "FIXO", cache_control: { type: "ephemeral", ttl: "1h" } }]);
  assert.equal(c.messages[1].content, "TURNO");
  assert.deepEqual(c.messages[3].content, [{ type: "text", text: "A vila está quieta.", cache_control: { type: "ephemeral", ttl: "1h" } }], "fim do histórico");
  assert.ok(c.messages.every((m) => !("cache" in m)), "a marca não vai no corpo da API");
  const off = chatRequest(orGm, OR).body;
  assert.ok(!("cache_control" in off), "sem cache, sem ponto automático");
  assert.deepEqual(off.messages, orGm.messages.map(({ cache: _, ...m }) => m), "sem cache, as mensagens vão como vieram (sem a marca)");
  assert.ok(!("cache_control" in chatRequest(GM, ANT, true).body), "fora do OpenRouter o cache não entra no corpo OpenAI");

  // 4. sem cache, as mensagens de sistema seguidas voltam a ser uma só (o texto de antes)
  assert.deepEqual(mergeSystem(GM.messages).slice(0, 2).map((m) => [m.role, m.content]), [["system", "FIXO\nTURNO"], ["user", "entro na vila"]]);
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
  state.params = { cache: true };
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

  // 7. mesma fonte sem cache: camada compatível, sistema juntado, custo ainda estimado pelo catálogo
  state.params = {};
  sent.length = 0;
  await chat(GM);
  assert.deepEqual(sent.map((x) => x.url), ["https://api.anthropic.com/v1/chat/completions"]);
  assert.equal((sent[0].body.messages as unknown[]).length, GM.messages.length - 1, "duas mensagens de sistema viraram uma");
  near(lastLog().cost, (3 * 2 + 1 * 10) / 1e6);
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

  // 10. provedor que recusa temperature (GPT-5 image mini pela OpenAI): repete uma vez sem ela
  const realFetch = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_u: string, init?: RequestInit) => {
    const b = JSON.parse(String(init?.body));
    bodies.push(b);
    return "temperature" in b
      ? new Response(JSON.stringify({ error: { message: "Unsupported parameter: 'temperature' is not supported with this model." } }), { status: 400 })
      : Response.json({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.01 } });
  }) as typeof fetch;
  const noTemp = await chat({ ...GM, model: "openai/gpt-5-image-mini", tools: undefined });
  globalThis.fetch = realFetch;
  assert.equal(noTemp.content, "ok");
  assert.equal(bodies.length, 2, "uma repetição");
  assert.ok("temperature" in bodies[0] && !("temperature" in bodies[1]), "a repetição vai sem temperature");
  assert.equal(lastLog().error, null);

  // 11. modelo que só gera imagem (pelo catálogo): vai por POST /images do OpenRouter; os de imagem + texto seguem no chat
  state.source = "openrouter";
  sent.length = 0;
  const flux = await chat({ ...GM, model: "black-forest-labs/flux-3-image-klein", tools: undefined, modalities: ["image", "text"] });
  const imgCall = sent.find((x) => x.url === "https://openrouter.ai/api/v1/images");
  assert.ok(imgCall, "modelo que só gera imagem vai por POST /images do OpenRouter");
  assert.equal(imgCall.body.model, "black-forest-labs/flux-3-image-klein");
  assert.match(String(imgCall.body.prompt), /abro a porta/, "o prompt é o texto das mensagens");
  assert.ok(flux.images[0].startsWith("data:image/svg+xml;base64,"), "media_type da resposta vira o tipo do data URL");
  assert.equal(lastLog().cost, 0.008, "custo real do OpenRouter");
  await chat({ ...GM, model: "google/gemini-3.1-flash-lite-image", tools: undefined, modalities: ["image", "text"] });
  assert.deepEqual(sent.at(-1)?.body.modalities, ["image", "text"], "modelo de imagem e texto segue no chat/completions");

  // 12. imagem em data URL: png e svg (base64 ou texto) valem; outro tipo não (viraria página no nosso domínio)
  assert.equal(imageFromDataUrl("data:image/png;base64,iVBORw0KGgo=")?.mime, "image/png");
  const svg = "<svg xmlns='http://www.w3.org/2000/svg'/>";
  assert.equal(imageFromDataUrl(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`)?.data.toString(), svg);
  assert.equal(imageFromDataUrl(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`)?.data.toString(), svg);
  assert.equal(imageFromDataUrl(`data:image/svg+xml,${svg} 100%`)?.data.toString(), `${svg} 100%`, "% solto não quebra");
  assert.equal(imageFromDataUrl("data:text/html,<script>alert(1)</script>"), null);

  // 9. janela do histórico: começo estável por vários turnos, cabe no orçamento e anda em saltos
  const lens = [400, 300, 500, 200, 600, 300, 400];
  for (let n = 1; n <= lens.length; n++) {
    const part = lens.slice(0, n);
    const i = windowStart(part, 1000);
    const tail = part.slice(i).reduce((a, x) => a + x, 0);
    assert.ok(tail <= 1000, `janela cabe no orçamento (${tail})`);
  }
  assert.equal(windowStart([400, 300], 1000), 0, "cabe tudo: começa do início");
  assert.equal(windowStart([400, 300, 500], 1000), 2, "passou: pula meio orçamento de uma vez");
  assert.equal(windowStart([400, 300, 500, 200], 1000), 2, "o começo fica no turno seguinte");
  assert.equal(windowStart([400, 300, 500, 200, 100], 1000), 2, "e no outro");
  assert.equal(windowStart([400, 300, 500, 200, 100, 200], 1000), 3, "passou de novo: outro salto");

  console.log("cache-check ok");
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
