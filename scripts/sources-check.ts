// npx tsx scripts/sources-check.ts — fontes de modelos sem IA, sem banco e sem rede:
// resolução da fonte, montagem do request (sem campos do OpenRouter fora dele), máscara da chave e
// chat, Jev (decider), Voz (TTS), Ilustrador (imagem) e embeddings chamando a URL e a chave da fonte certa.
// O banco é um pool falso posto em global.__pgPool (o mesmo global que src/lib/db.ts usa) e o fetch é trocado.
import assert from "node:assert";
import { authHeader, chat, chatRequest, maskKey, pickSource, sourceView, type ChatOptions, type Source } from "../src/lib/openrouter";
import { decide, type DecisionRequest } from "../src/lib/decisions";
import { synthesize } from "../src/lib/tts";
import { embed } from "../src/lib/embeddings";
import { SOURCE_PRESETS } from "../src/lib/sourcePresets";

const OR_URL = "https://openrouter.ai/api/v1";
const POD: Source = { id: "pod", name: "Pod do Jev", url: "http://pod:8000/v1", apiKey: "pod-secret-key-0001" };
const state = { source: "pod", orKey: "sk-or-v1-secret-key-9999", sources: [POD] as Source[] };
delete process.env.OPENROUTER_API_KEY; // a chave só vem do banco falso

// ---------- banco falso ----------
const logs: unknown[][] = [];
const g = global as unknown as { __pgPool?: unknown; __schemaReady?: Promise<boolean> };
g.__schemaReady = Promise.resolve(false);
g.__pgPool = {
  async query(text: string, params: unknown[] = []) {
    if (/FROM settings/.test(text)) {
      const v = { sources: state.sources, openrouter: { apiKey: state.orKey }, embeddings: { enabled: true, model: "emb-1", source: state.source } }[params[0] as string];
      return { rows: v ? [{ value: v }] : [] };
    }
    if (/SELECT source(, params)? FROM agents/.test(text)) return { rows: [{ source: state.source, params: {} }] };
    if (/SELECT \* FROM agents/.test(text)) return { rows: [{ id: params[0], model: "m-1", params: {}, source: state.source }] };
    if (/INSERT INTO api_logs/.test(text)) logs.push(params);
    if (/INSERT INTO settings/.test(text) && params[0] === "sources") state.sources = JSON.parse(String(params[1]));
    return { rows: [] }; // agentes padrão, tts_cache...
  },
};
const lastLog = () => {
  const l = logs[logs.length - 1]; // ordem do INSERT: agent_id, ..., cost (10), provider (11)
  return { agent: l[0], model: l[2], cost: l[10], provider: l[11] };
};

// ---------- rede falsa ----------
const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> | null }[] = [];
globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : null });
  if (url.endsWith("/chat/completions"))
    return Response.json({ choices: [{ message: { content: "ok", images: [{ image_url: { url: "data:image/png;base64,AA" } }] } }], usage: { prompt_tokens: 3, completion_tokens: 1, cost: 0.5 } });
  if (url.endsWith("/alpha/decisions")) return Response.json({ answers: { x: { type: "noul", noul: 0.9 } } });
  if (url.endsWith("/audio/speech")) return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } });
  if (url.endsWith("/embeddings")) return Response.json({ data: [{ index: 0, embedding: [0.1, 0.2] }] });
  return new Response("não achei", { status: 404 });
}) as typeof fetch;
const last = () => calls[calls.length - 1];
const tick = () => new Promise((r) => setTimeout(r, 20)); // o log da Voz é gravado depois, sem segurar a fala

const base: ChatOptions = { model: "m-1", messages: [{ role: "user", content: "oi" }], agentId: "gm", purpose: "check" };
const question: DecisionRequest = { state: {}, questions: { x: { type: "noul", instructions: "?" } } };

async function main() {
  // 1. resolução pura
  const or = pickSource("openrouter", [POD], "k-or");
  assert.deepEqual(or, { id: "openrouter", name: "OpenRouter", url: OR_URL, apiKey: "k-or" });
  assert.equal(pickSource("pod", [POD], "k-or"), POD);
  assert.throws(() => pickSource("sumiu", [POD], "k-or"), /não existe mais/);

  // 2. request: OpenRouter leva :online, reasoning e cabeçalhos de app; outra fonte, só o formato OpenAI
  const full: ChatOptions = { ...base, webSearch: true, reasoning: { effort: "low" }, modalities: ["image", "text"], onDelta: () => {}, tools: [{ type: "function", function: { name: "t", description: "", parameters: {} } }] };
  const a = chatRequest(full, or);
  assert.equal(a.url, `${OR_URL}/chat/completions`);
  assert.equal(a.body.model, "m-1:online");
  assert.deepEqual(a.body.reasoning, { effort: "low" });
  assert.equal(a.headers.Authorization, "Bearer k-or");
  assert.equal(a.headers["X-Title"], "Chronicle RPG");
  const b = chatRequest(full, POD);
  assert.equal(b.url, "http://pod:8000/v1/chat/completions");
  assert.equal(b.body.model, "m-1", "sem :online fora do OpenRouter");
  assert.equal(b.body.reasoning, undefined, "reasoning é do OpenRouter");
  assert.deepEqual(b.body.modalities, ["image", "text"], "imagem pelo chat continua pedindo modalities");
  assert.deepEqual(b.body.stream_options, { include_usage: true });
  assert.equal(b.headers.Authorization, `Bearer ${POD.apiKey}`);
  assert.ok(!("X-Title" in b.headers) && !("HTTP-Referer" in b.headers));
  assert.deepEqual(Object.keys(b.body).sort(), ["max_tokens", "messages", "modalities", "model", "stream", "stream_options", "temperature", "tools"]);
  assert.ok(!("Authorization" in chatRequest(base, { ...POD, apiKey: "" }).headers), "fonte sem chave (Ollama) vai sem Authorization");
  assert.equal(chatRequest({ ...base, temperature: 0.3 }, POD).body.temperature, 0.3);
  // tipo Anthropic: Claude 4.7+ recusa temperature < 1, então ela não vai
  const anthropic = { id: "anthropic", name: "Anthropic", url: "https://api.anthropic.com/v1", apiKey: "k", kind: "anthropic" };
  const c = chatRequest({ ...base, temperature: 0.3 }, anthropic);
  assert.equal(c.url, "https://api.anthropic.com/v1/chat/completions");
  assert.ok(!("temperature" in c.body) && !("top_p" in c.body));
  assert.equal(sourceView(anthropic).kind, "anthropic");
  // Cartógrafo e Pixel artista (raciocínio + ferramentas) na Anthropic: nada que dê 400 (temperature, top_p, reasoning)
  const cartographer: ChatOptions = { ...full, webSearch: false, modalities: undefined, onDelta: undefined, temperature: 0.5, model: "claude-opus-5-5", agentId: "cartographer" };
  assert.deepEqual(Object.keys(chatRequest(cartographer, anthropic).body).sort(), ["max_tokens", "messages", "model", "tools"]);
  // na OpenAI o raciocínio vira reasoning_effort
  const oa = chatRequest(cartographer, { ...anthropic, id: "openai", kind: "openai", url: "https://api.openai.com/v1" }).body;
  assert.equal(oa.reasoning_effort, "low");
  assert.ok(!("reasoning" in oa));
  assert.ok(!("reasoning_effort" in chatRequest(cartographer, POD).body), "personalizada não recebe reasoning_effort");
  for (const p of SOURCE_PRESETS) assert.ok(/^https:\/\/[^/]+\/.*[^/]$/.test(p.url), `URL base de ${p.name} sem barra no fim`);

  // 3. chave mascarada
  assert.equal(maskKey(""), "");
  assert.equal(maskKey("curta"), "***");
  assert.equal(maskKey(POD.apiKey), "pod-se...0001");
  const view = sourceView(POD);
  assert.deepEqual(Object.keys(view).sort(), ["apiKeyMasked", "auth", "id", "kind", "name", "url"]);
  assert.ok(!JSON.stringify(view).includes(POD.apiKey));

  // 4. cada caminho resolve pela fonte do agente: pod
  const r = await chat({ ...base, webSearch: true });
  assert.equal(last().url, "http://pod:8000/v1/chat/completions");
  assert.equal(last().headers.Authorization, `Bearer ${POD.apiKey}`);
  assert.equal(last().body?.model, "m-1");
  assert.equal(r.content, "ok");
  assert.deepEqual(lastLog(), { agent: "gm", model: "m-1", cost: null, provider: "pod" }, "custo só do OpenRouter");

  const img = await chat({ ...base, agentId: "image", modalities: ["image", "text"] });
  assert.equal(last().url, "http://pod:8000/v1/chat/completions");
  assert.deepEqual(last().body?.modalities, ["image", "text"]);
  assert.equal(img.images.length, 1);

  const ans = await decide(question, { purpose: "check" });
  assert.equal(last().url, "http://pod:8000/alpha/decisions");
  assert.equal(last().headers.Authorization, `Bearer ${POD.apiKey}`);
  assert.equal(ans?.x.type === "noul" && ans.x.noul, 0.9);
  assert.equal(lastLog().provider, "pod");

  await synthesize("olá do pod", "tts-1", "alloy", { purpose: "check" });
  assert.equal(last().url, "http://pod:8000/v1/audio/speech");
  assert.equal(last().headers.Authorization, `Bearer ${POD.apiKey}`);
  await tick();
  assert.deepEqual([lastLog().agent, lastLog().provider], ["voice", "pod"]);

  assert.deepEqual(await embed(["a"]), [[0.1, 0.2]]);
  assert.equal(last().url, "http://pod:8000/v1/embeddings");
  assert.equal(last().headers.Authorization, `Bearer ${POD.apiKey}`);

  // 5. a fonte embutida monta exatamente as URLs de antes
  state.source = "openrouter";
  await chat({ ...base, webSearch: true });
  assert.equal(last().url, `${OR_URL}/chat/completions`);
  assert.equal(last().body?.model, "m-1:online");
  assert.equal(last().headers.Authorization, `Bearer ${state.orKey}`);
  assert.deepEqual(lastLog(), { agent: "gm", model: "m-1:online", cost: 0.5, provider: "openrouter" });
  await decide(question, { purpose: "check" });
  assert.equal(last().url, "https://openrouter.ai/api/alpha/decisions");
  await synthesize("olá do openrouter", "tts-1", "alloy", { purpose: "check" });
  assert.equal(last().url, `${OR_URL}/audio/speech`);
  await embed(["a"]);
  assert.equal(last().url, `${OR_URL}/embeddings`);

  // 6. falhas: fonte removida ou OpenRouter sem chave → chat lança, Jev e embeddings caem no padrão (null)
  const n = calls.length;
  state.source = "sumiu";
  await assert.rejects(chat(base), /não existe mais/);
  assert.equal(await decide(question, { purpose: "check" }), null);
  assert.equal(await embed(["a"]), null);
  state.source = "openrouter";
  state.orKey = "";
  await assert.rejects(chat(base), /Chave do OpenRouter/);
  assert.equal(await decide(question, { purpose: "check" }), null);
  assert.equal(calls.length, n, "sem fonte válida, nada vai para a rede");

  // a chave de nenhuma fonte vai para o log
  await tick();
  const logged = JSON.stringify(logs);
  assert.ok(!logged.includes(POD.apiKey) && !logged.includes("sk-or-v1-secret"));

  // rota /api/sources: tipo conhecido fica com a URL do preset; só uma fonte com Login com ChatGPT
  const { POST, PUT } = await import("../src/app/api/sources/route");
  const { NextRequest } = await import("next/server");
  const call = async (fn: typeof POST, body: object) => {
    const res = await fn(new NextRequest("http://x/api/sources", { method: "POST", body: JSON.stringify(body) }));
    return { status: res.status, d: await res.json() };
  };
  // Anthropic: anthropic-version em toda chamada (sem ele GET /models dá 400)
  assert.equal(authHeader({ ...POD, kind: "anthropic" })["anthropic-version"], "2023-06-01");
  assert.equal(authHeader(POD)["anthropic-version"], undefined);
  const OPENAI_URL = SOURCE_PRESETS.find((p) => p.kind === "openai")!.url;
  let res = await call(POST, { kind: "openai", name: "OpenAI", url: "http://evil", auth: "chatgpt" });
  assert.equal(res.status, 200);
  assert.equal(res.d.url, OPENAI_URL, "tipo conhecido ignora a URL que chega");
  assert.equal((await call(POST, { kind: "openai", name: "OpenAI", auth: "chatgpt" })).status, 409, "2ª fonte ChatGPT recusada");
  res = await call(POST, { kind: "openai", name: "OpenAI chave", apiKey: "k-1" });
  assert.equal(res.status, 200, "OpenAI com API key continua podendo repetir");
  assert.equal((await call(PUT, { id: res.d.id, name: "OpenAI chave", auth: "chatgpt" })).status, 409, "trocar outra para ChatGPT também");
  res = await call(PUT, { id: "openai", name: "OpenAI", url: "http://evil", auth: "chatgpt" });
  assert.equal(res.status, 200, "editar a própria fonte ChatGPT pode");
  assert.equal(res.d.url, OPENAI_URL);
  assert.equal(state.sources.filter((x) => x.auth).length, 1);

  console.log(`sources-check ok (${calls.length} chamadas simuladas, ${logs.length} logs)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
