import { getSetting, q } from "./db";
import type { SourceView } from "./types";
import { presetOf } from "./sourcePresets";
import { chatgptAccessToken } from "./chatgptAuth";
import { readResponses, responsesHttpError, responsesRequest } from "./responsesApi";
import { anthropicChat } from "./anthropicApi";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null | ContentPart[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  /** ponto de cache entre turnos (Claude): fim do histórico, antes do contexto do turno; não vai no corpo da API */
  cache?: boolean;
}

export interface ContentPart {
  type: string;
  text?: string;
  image_url?: { url: string };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatOptions {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  tools?: ToolDef[];
  webSearch?: boolean;
  modalities?: string[];
  // raciocínio do modelo (parâmetro unificado do OpenRouter), ex.: { effort: "low" }
  reasoning?: Record<string, unknown>;
  // streaming: recebe cada pedaço do texto enquanto a resposta é gerada (o resultado final vem igual)
  onDelta?: (text: string) => void;
  // metadados para o log
  agentId: string;
  campaignId?: string | null;
  purpose: string;
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  images: string[]; // data URLs quando modalities inclui image
  raw: unknown;
}

export async function getOpenRouterKey(): Promise<string> {
  const fromSettings = await getSetting<{ apiKey?: string }>("openrouter", {});
  return fromSettings.apiKey || process.env.OPENROUTER_API_KEY || "";
}

// ---------- Fontes de modelos ----------

/**
 * Fonte OpenAI-compatível: cada chamada monta em {url} o mesmo caminho que usa no OpenRouter
 * (/chat/completions, /models, /embeddings, /audio/speech, ../alpha/decisions). "openrouter" é a embutida.
 */
export interface Source {
  id: string; name: string; url: string; apiKey: string;
  kind?: string; // tipo conhecido (sourcePresets)
  auth?: "chatgpt"; // fonte OpenAI no Login com ChatGPT: apiKey vira o access token na hora (getSource) e o chat vai pela Responses API
}
export const OPENROUTER = "openrouter";
const OPENROUTER_URL = "https://openrouter.ai/api/v1";

/** Fontes cadastradas em /agents (a chave fica só no banco, em settings.sources). */
export async function getSources(): Promise<Source[]> {
  // tipo conhecido usa sempre a URL do preset: não dá para trocar (e uma correção da URL no código vale para quem já cadastrou)
  return (await getSetting<Source[]>("sources", [])).map((s) => ({ ...s, url: presetOf(s.kind)?.url ?? s.url }));
}

export function pickSource(id: string, sources: Source[], openrouterKey: string): Source {
  if (id === OPENROUTER) return { id, name: "OpenRouter", url: OPENROUTER_URL, apiKey: openrouterKey };
  const s = sources.find((x) => x.id === id);
  if (!s) throw new Error(`A fonte de modelos "${id}" não existe mais. Escolha outra fonte no agente, em Agentes.`);
  return s;
}

/** A fonte pelo id; a embutida usa a chave do OpenRouter das Configurações (obrigatória). */
export async function getSource(id: string): Promise<Source> {
  if (id !== OPENROUTER) {
    const s = pickSource(id, await getSources(), "");
    return s.auth === "chatgpt" ? { ...s, apiKey: await chatgptAccessToken() } : s;
  }
  const key = await getOpenRouterKey();
  if (!key) throw new Error("Chave do OpenRouter não configurada. Vá em Configurações e informe sua API key.");
  return pickSource(id, [], key);
}

/** A fonte escolhida no agente (agente desconhecido: OpenRouter). */
export async function agentSource(agentId: string): Promise<Source> {
  const [row] = await q<{ source: string }>(`SELECT source FROM agents WHERE id = $1`, [agentId]);
  return getSource(row?.source ?? OPENROUTER);
}

/** Cabeçalho de autenticação da fonte (sem chave, nenhum: Ollama local, por exemplo). */
export const authHeader = (src: Source): Record<string, string> => ({
  ...presetOf(src.kind)?.headers,
  ...(src.apiKey ? { Authorization: `Bearer ${src.apiKey}` } : {}),
});

/** Chave para mostrar na tela: começo e fim, nunca inteira. */
export function maskKey(key: string): string {
  if (!key) return "";
  return key.length > 8 ? `${key.slice(0, 6)}...${key.slice(-4)}` : "***";
}

export const sourceView = ({ id, name, url, apiKey, kind, auth }: Source): SourceView => ({ id, name, url, kind, auth, apiKeyMasked: maskKey(apiKey) });

/** Modelo da Anthropic: na fonte Anthropic ou anthropic/* no OpenRouter. Só neles o agente pode ligar o cache. */
export const isClaude = (src: Source, model: string) =>
  src.kind === "anthropic" || (src.id === OPENROUTER && model.startsWith("anthropic/"));

/** Mensagens de sistema seguidas viram uma só, com o texto de antes (só o cache precisa delas separadas). */
export function mergeSystem(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    const prev = out[out.length - 1];
    if (m.role === "system" && prev?.role === "system" && typeof prev.content === "string" && typeof m.content === "string")
      out[out.length - 1] = { ...prev, content: `${prev.content}\n${m.content}` };
    else out.push(m);
  }
  return out;
}

// 1 h no que dura entre turnos (o jogador pensa mais de 5 min, e cada modelo do Mestre tem o seu cache);
// 5 min no fim da conversa, que só as rodadas do mesmo turno leem. O mais longo vem antes, como a API exige.
export const CACHE_LONG = { type: "ephemeral", ttl: "1h" } as const;
export const CACHE_SHORT = { type: "ephemeral" } as const;

/**
 * URL, cabeçalhos e corpo da chamada. Fora do OpenRouter vai só o formato OpenAI: sem :online, reasoning e cabeçalhos de app.
 * cache (Claude no OpenRouter): cache automático no fim da conversa e pontos de 1 h no fim da 1ª mensagem de sistema
 * e na mensagem marcada com cache (fim do histórico).
 */
export function chatRequest(opts: ChatOptions, src: Source, cache = false) {
  const or = src.id === OPENROUTER;
  const messages = opts.messages.map(({ cache: _, ...m }) => m);
  const body: Record<string, unknown> = {
    model: or && opts.webSearch ? `${opts.model}:online` : opts.model,
    messages,
    max_tokens: opts.max_tokens ?? 2048,
  };
  if (or && cache) {
    body.cache_control = CACHE_SHORT;
    const sys = opts.messages.findIndex((m) => m.role === "system" && typeof m.content === "string");
    body.messages = messages.map((m, j) =>
      (j === sys || opts.messages[j].cache) && typeof m.content === "string"
        ? { ...m, content: [{ type: "text", text: m.content, cache_control: CACHE_LONG }] }
        : m
    );
  }
  if (!presetOf(src.kind)?.noTemperature) body.temperature = opts.temperature ?? 0.8;
  if (opts.tools?.length) body.tools = opts.tools;
  if (opts.modalities) body.modalities = opts.modalities;
  // reasoning é o parâmetro unificado do OpenRouter; na OpenAI vira reasoning_effort; nas outras fica de fora
  if (or && opts.reasoning) body.reasoning = opts.reasoning;
  if (presetOf(src.kind)?.reasoningEffort && opts.reasoning?.effort) body.reasoning_effort = opts.reasoning.effort;
  if (opts.onDelta) {
    body.stream = true;
    body.stream_options = { include_usage: true }; // usage (tokens e, no OpenRouter, custo) chega no último pedaço
  }
  const headers: Record<string, string> = { "Content-Type": "application/json", ...authHeader(src) };
  if (or) Object.assign(headers, { "HTTP-Referer": "https://github.com/hugobsan/rpg", "X-Title": "Chronicle RPG" });
  return { url: `${src.url}/chat/completions`, headers, body };
}

/**
 * Imagem por endpoint próprio, com o pedido de chat virando prompt de texto: no OpenRouter, POST /images para os modelos
 * que só geram imagem (FLUX, Recraft...; o chat/completions recusa); nas outras fontes (Gemini), /images/generations da OpenAI.
 * Doc: https://openrouter.ai/docs/api/api-reference/images/generate-an-image
 */
export function imagesRequest(opts: ChatOptions, src: Source) {
  const prompt = opts.messages
    .map((m) => (typeof m.content === "string" ? m.content : (m.content ?? []).map((p) => p.text ?? "").join("")))
    .filter(Boolean)
    .join("\n\n");
  const { headers } = chatRequest(opts, src);
  if (src.id === OPENROUTER) return { url: `${src.url}/images`, headers, body: { model: opts.model, prompt } as Record<string, unknown> };
  return { url: `${src.url}/images/generations`, headers, body: { model: opts.model, prompt, n: 1, response_format: "b64_json" } as Record<string, unknown> };
}

// tipo da imagem pelos primeiros bytes em base64, quando a resposta não traz media_type
const mimeOf = (b64: string) =>
  b64.startsWith("/9j/") ? "image/jpeg"
  : b64.startsWith("UklGR") ? "image/webp"
  : b64.startsWith("R0lGOD") ? "image/gif"
  : /^(PHN2Zy|PD94bW)/.test(b64) ? "image/svg+xml" // "<svg" ou "<?xml"
  : "image/png";

/** Resposta de /images/generations (data[].b64_json) → JSON de chat com message.images, como o OpenRouter devolve. */
export function imagesToChat(json: Record<string, unknown>): Record<string, unknown> {
  const data = (json.data as { b64_json?: string; media_type?: string }[] | undefined) ?? [];
  const images = data.filter((d) => d.b64_json).map((d) => ({ image_url: { url: `data:${d.media_type || mimeOf(d.b64_json!)};base64,${d.b64_json}` } }));
  return { ...json, data: undefined, choices: [{ message: { role: "assistant", content: "", images }, finish_reason: "stop" }] };
}

export interface ApiLog {
  agentId: string;
  provider?: string; // fonte que atendeu (padrão openrouter)
  campaignId?: string | null;
  model: string;
  purpose: string;
  request: unknown;
  response: unknown;
  promptTokens?: number | null;
  completionTokens?: number | null;
  durationMs?: number | null;
  error?: string | null;
  cost?: number | null; // USD
}

/** Grava uma chamada de IA em api_logs (nunca lança). */
export async function logApiCall(l: ApiLog): Promise<void> {
  await q(
    `INSERT INTO api_logs (agent_id, campaign_id, model, purpose, request, response, prompt_tokens, completion_tokens, duration_ms, error, cost, provider)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      l.agentId,
      l.campaignId || null,
      l.model,
      l.purpose,
      JSON.stringify(l.request),
      l.response ? JSON.stringify(l.response) : null,
      l.promptTokens ?? null,
      l.completionTokens ?? null,
      l.durationMs ?? null,
      l.error ?? null,
      l.cost ?? null,
      l.provider || OPENROUTER,
    ]
  ).catch(() => {});
}

/**
 * Chamada única de chat completions na fonte do agente (OpenRouter ou outra OpenAI-compatível).
 * Toda chamada é registrada em api_logs com fonte, tokens, duração e erro — visível em Custos e uso.
 */
export async function chat(opts: ChatOptions): Promise<ChatResult> {
  const [agent] = await q<{ source: string; params: AgentFlags }>(`SELECT source, params FROM agents WHERE id = $1`, [opts.agentId]);
  const src = await getSource(agent?.source ?? OPENROUTER);
  const cache = !!agent?.params?.cache && isClaude(src, opts.model);
  if (!cache) opts = { ...opts, messages: mergeSystem(opts.messages) };
  // a camada compatível da Anthropic não faz cache e ignora reasoning_effort: com um dos dois vai pela API nativa
  const native = src.kind === "anthropic" && (cache || !!opts.reasoning?.effort);
  const resp = src.auth === "chatgpt"; // Login com ChatGPT: Responses API, sempre em streaming
  // imagem por endpoint próprio: fonte que só gera assim (Gemini) ou, no OpenRouter, modelo que só gera imagem (pelo catálogo)
  const img =
    !!opts.modalities?.includes("image") &&
    (!!presetOf(src.kind)?.imagesEndpoint || (src.id === OPENROUTER && !!catalogMatch(opts.model, await catalogModels())?.imageOnly));
  const { url, headers, body } = img ? imagesRequest(opts, src) : resp ? responsesRequest(opts, src) : chatRequest(opts, src, cache);
  const model = body.model as string;
  const started = Date.now();
  let responseJson: Record<string, unknown> | null = null;
  let error: string | null = null;
  try {
    const post = () => fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    let res = native ? null : await post();
    // modelo que recusa temperature (família GPT-5, mesmo quando o catálogo diz que aceita): repete uma vez sem ela
    if (res?.status === 400 && "temperature" in body) {
      const text = await res.clone().text();
      if (/temperature/i.test(text) && /not supported|unsupported/i.test(text)) {
        delete body.temperature;
        res = await post();
      }
    }
    if (!res) responseJson = await anthropicChat(opts, src, cache);
    else if (!img && (opts.onDelta || resp) && res.ok && res.body)
      responseJson = await (resp ? readResponses : readStream)(res.body, opts.onDelta ?? (() => {}));
    else {
      const text = await res.text();
      try {
        responseJson = JSON.parse(text);
      } catch {
        responseJson = { raw: text };
      }
      if (!res.ok)
        throw new Error(
          `${src.name} ${res.status}: ${resp ? responsesHttpError(text) : text.slice(0, 500)}`
        );
      if (img) responseJson = imagesToChat(responseJson ?? {});
    }
    const errObj = (responseJson as { error?: { message?: string } }).error;
    if (errObj) throw new Error(`${src.name}: ${errObj.message || "erro"}`);

    const choice = (responseJson as {
      choices?: {
        message?: {
          content?: string | null;
          tool_calls?: ToolCall[];
          images?: { image_url?: { url?: string } }[];
        };
      }[];
    }).choices?.[0];
    const msg = choice?.message;
    const images = (msg?.images || [])
      .map((i) => i.image_url?.url || "")
      .filter(Boolean);
    return {
      content: typeof msg?.content === "string" ? msg.content : "",
      toolCalls: msg?.tool_calls || [],
      images,
      raw: responseJson,
    };
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    throw e;
  } finally {
    const usage = (responseJson as { usage?: Usage } | null)?.usage;
    // log truncado: sem base64 de imagens, mensagens limitadas
    const logRequest = {
      model,
      cache: cache || undefined,
      temperature: body.temperature,
      max_tokens: body.max_tokens,
      tools: opts.tools?.map((t) => t.function.name),
      messages: opts.messages.map((m) => ({
        role: m.role,
        name: m.name,
        content:
          typeof m.content === "string"
            ? m.content.length <= 6000
              ? m.content
              // começo + fim: o fim do system tem o contexto do turno (memórias, diretrizes)
              : `${m.content.slice(0, 4000)}\n… [${m.content.length - 6000} caracteres cortados] …\n${m.content.slice(-2000)}`
            : "[multimodal]",
        tool_calls: m.tool_calls?.map((t) => t.function.name),
      })),
    };
    // encurta cada string (imagens base64, raciocínio...) em vez de cortar o JSON no meio,
    // que gerava "Unterminated string in JSON" e derrubava a chamada que já tinha dado certo
    const logResponse = responseJson
      ? JSON.parse(
          JSON.stringify(responseJson, (k, v) =>
            typeof v !== "string" ? v
            : v.startsWith("data:image") ? "[imagem]"
            : v.length > 4000 ? `${v.slice(0, 4000)}… [cortado, ${v.length} caracteres]`
            : v
          )
        )
      : null;
    await logApiCall({
      agentId: opts.agentId,
      provider: src.id,
      campaignId: opts.campaignId,
      model,
      purpose: opts.purpose,
      request: logRequest,
      response: logResponse,
      promptTokens: usage?.prompt_tokens,
      completionTokens: usage?.completion_tokens,
      durationMs: Date.now() - started,
      error,
      // USD real do OpenRouter (já com cache/busca/raciocínio); outras fontes não informam: estimado pelo preço do catálogo
      cost: src.id === OPENROUTER ? usage?.cost : usage ? await estimateCost(opts.model, usage) : null,
    });
  }
}

type StreamToolCall = { index?: number; id?: string; function?: { name?: string; arguments?: string } };

/**
 * Lê a resposta em streaming (SSE) e remonta o JSON de uma resposta sem streaming (choices[0].message
 * com content, tool_calls, annotations e reasoning; usage), para o resto do código e o log não mudarem.
 * Erro no meio do stream (pedaço com error, ou a conexão caiu) vira `error` no resultado, com o parcial.
 */
export async function readStream(
  stream: ReadableStream<Uint8Array>,
  onDelta: (text: string) => void
): Promise<Record<string, unknown>> {
  const msg: { role: string; content: string; tool_calls?: ToolCall[]; annotations?: unknown[]; reasoning?: string } = {
    role: "assistant",
    content: "",
  };
  const choice: { message: typeof msg; finish_reason: string | null } = { message: msg, finish_reason: null };
  const out: Record<string, unknown> = { choices: [choice] };
  const calls: ToolCall[] = [];
  const handle = (line: string) => {
    if (!line.startsWith("data:")) return; // ": OPENROUTER PROCESSING" (keep-alive) e linhas vazias
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    const chunk = JSON.parse(data) as {
      id?: string; model?: string; provider?: string; usage?: unknown; error?: unknown;
      choices?: { finish_reason?: string | null; delta?: { content?: string | null; reasoning?: string | null; annotations?: unknown[]; tool_calls?: StreamToolCall[] } }[];
    };
    out.id ??= chunk.id;
    out.model ??= chunk.model;
    out.provider ??= chunk.provider;
    if (chunk.usage) out.usage = chunk.usage;
    const c = chunk.choices?.[0];
    if (c?.finish_reason) choice.finish_reason = c.finish_reason;
    if (chunk.error || c?.finish_reason === "error") out.error = chunk.error || { message: "a resposta parou no meio" };
    const d = c?.delta;
    if (!d) return;
    if (d.content) {
      msg.content += d.content;
      onDelta(d.content);
    }
    if (d.reasoning) msg.reasoning = (msg.reasoning || "") + d.reasoning;
    if (d.annotations?.length) (msg.annotations ??= []).push(...d.annotations);
    // ferramentas chegam em pedaços: id e nome no primeiro, os argumentos aos poucos (pelo index)
    for (const t of d.tool_calls || []) {
      const i = t.index ?? (t.id ? calls.length : calls.length - 1);
      const call = (calls[i] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
      if (t.id) call.id = t.id;
      if (t.function?.name) call.function.name = t.function.name;
      if (t.function?.arguments) call.function.arguments += t.function.arguments;
    }
  };
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (!out.error) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const l of lines) handle(l.replace(/\r$/, ""));
    }
    handle(buf.trim());
  } catch (e) {
    out.error = { message: e instanceof Error ? e.message : String(e) };
  } finally {
    reader.cancel().catch(() => {});
  }
  if (calls.length) msg.tool_calls = calls.filter(Boolean);
  return out;
}

// preço em USD por token (strings), como vem do catálogo
export type ModelPricing = {
  prompt: string;
  completion: string;
  input_cache_read?: string;
  input_cache_write?: string; // gravação de cache de 5 min (Claude)
};

/** Opções do agente (params) que chat() lê a cada chamada. */
type AgentFlags = { cache?: boolean } | null;

/** usage como vem do OpenRouter (e como anthropicApi e readStream montam): cache lido e gravado em prompt_tokens_details. */
export type Usage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  cost?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
};

/**
 * Modelo de outra fonte no catálogo do OpenRouter, pelo id: gpt-6.1-terra → openai/gpt-6.1-terra;
 * claude-sonnet-5-5 → anthropic/claude-sonnet-5.5 (a Anthropic usa hífen na versão e às vezes data no fim).
 */
export function catalogMatch<T extends { id: string }>(model: string, list: T[]): T | undefined {
  const names = new Set([model, model.replace(/-\d{8}$/, "").replace(/-(\d+)-(\d+)$/, "-$1.$2")]);
  return list.find((m) => names.has(m.id) || names.has(m.id.slice(m.id.indexOf("/") + 1)));
}

/**
 * Custo pelo preço do catálogo: entrada sem cache, cache lido, cache gravado e saída (sem preço de cache, o de entrada).
 * ponytail: ignora a faixa de preço acima de 100 mil tokens de entrada (Haiku 5.5); os agentes ficam bem abaixo.
 */
export function catalogCost(p: ModelPricing, u: Usage): number | null {
  const price = (v: string | undefined, fallback: number) => (v == null || Number(v) < 0 ? fallback : Number(v));
  const input = price(p.prompt, NaN);
  if (Number.isNaN(input)) return null; // preço variável (-1) ou ausente
  const read = u.prompt_tokens_details?.cached_tokens ?? 0;
  const write = u.prompt_tokens_details?.cache_write_tokens ?? 0;
  const fresh = Math.max((u.prompt_tokens ?? 0) - read - write, 0);
  return fresh * input + read * price(p.input_cache_read, input) + write * price(p.input_cache_write, input) + (u.completion_tokens ?? 0) * price(p.completion, 0);
}

// catálogo guardado no processo por 6 h: o custo estimado e o tipo de saída de cada chamada não vão à rede toda vez
let catalog: { at: number; list: ReturnType<typeof listModels> } | null = null;

/** Catálogo do OpenRouter em cache; vazio se a rede falhar (nunca lança). */
async function catalogModels(): Promise<Awaited<ReturnType<typeof listModels>>> {
  if (!catalog || Date.now() - catalog.at > 6 * 3600_000) catalog = { at: Date.now(), list: listModels() };
  return catalog.list.catch(() => ((catalog = null), []));
}

/** Custo estimado de uma chamada de outra fonte pelo preço do OpenRouter; null se o modelo não está no catálogo (nunca lança). */
export async function estimateCost(model: string, usage: Usage): Promise<number | null> {
  const m = catalogMatch(model, await catalogModels());
  return m ? catalogCost(m.pricing, usage) : null;
}

/** Lista modelos disponíveis no OpenRouter (para o seletor da tela de Agentes). */
export async function listModels(): Promise<
  {
    id: string; slug: string; name: string; context: number; pricing: ModelPricing;
    speech: boolean; // modelo de fala (TTS)
    imageOnly: boolean; // gera imagem e nenhum texto (FLUX, Recraft...): no OpenRouter vai por POST /images
    voices: string[] | null; // vozes aceitas (null = o catálogo não lista)
  }[]
> {
  const apiKey = await getOpenRouterKey();
  // output_modalities=all inclui modelos de imagem, de fala e de decisão (a lista padrão só traz texto)
  const res = await fetch("https://openrouter.ai/api/v1/models?output_modalities=all", {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  });
  if (!res.ok) throw new Error(`OpenRouter models: ${res.status}`);
  const data = (await res.json()) as {
    data: {
      id: string;
      canonical_slug?: string;
      name: string;
      context_length: number;
      pricing: ModelPricing;
      architecture?: { output_modalities?: string[] };
      supported_voices?: string[] | null;
    }[];
  };
  return data.data
    .map((m) => ({
      id: m.id,
      slug: m.canonical_slug || m.id,
      name: m.name,
      context: m.context_length,
      pricing: m.pricing,
      speech: !!m.architecture?.output_modalities?.includes("speech"),
      imageOnly: !!m.architecture?.output_modalities?.includes("image") && !m.architecture.output_modalities.includes("text"),
      voices: m.supported_voices?.length ? m.supported_voices : null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Modelos de uma fonte (GET {url}/models, formato OpenAI). */
export async function listSourceModels(id: string): Promise<{ id: string; name: string }[]> {
  const src = await getSource(id);
  const res = await fetch(`${src.url}/models`, {
    headers: authHeader(src),
    signal: AbortSignal.timeout(15_000),
  }).catch((e) => {
    throw new Error(`${src.name} não respondeu em ${src.url}/models (${e.cause?.code || e.message})`);
  });
  if (!res.ok) throw new Error(`${src.name} GET /models: ${res.status}`);
  const data = (await res.json()) as { data?: { id: string; name?: string; display_name?: string }[]; models?: { slug: string; display_name?: string; visibility?: string }[] };
  // Login com ChatGPT: catálogo da conta em `models`, na ordem do servidor; só os de visibility "list"
  if (Array.isArray(data.models))
    return data.models.filter((m) => m.visibility === "list").map((m) => ({ id: m.slug, name: m.display_name || m.slug }));
  if (!Array.isArray(data.data)) throw new Error(`${src.name} GET /models: resposta fora do formato OpenAI`);
  return data.data.map((m) => ({ id: m.id, name: m.name || m.display_name || m.id })).sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Preço salvo no agente: USD por milhão de tokens + contexto. null se o modelo não existe no catálogo.
 * other: modelo de outra fonte, achado pelo nome (catalogMatch), para o custo estimado.
 */
export async function getModelPricing(id: string, other = false) {
  const list = await listModels();
  const m = list.find((x) => x.id === id || x.slug === id) ?? (other ? catalogMatch(id, list) : undefined); // aceita o id ou o slug versionado
  if (!m) return null;
  const perM = (v?: string) => (v == null || Number(v) < 0 ? null : Number((Number(v) * 1e6).toPrecision(6)));
  return {
    input: perM(m.pricing.prompt),
    output: perM(m.pricing.completion),
    cache_read: perM(m.pricing.input_cache_read),
    context: m.context,
    fetched_at: new Date().toISOString(),
  };
}

// medido num turno do Mestre em pt-BR: ~2,2 caracteres por token no Claude; o GPT rende um pouco mais por token
export const CHARS_PER_TOKEN = 2.5;

/** Estimativa grosseira de tokens em pt-BR. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
