import { getSetting, q } from "./db";
import type { SourceView } from "./types";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null | ContentPart[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
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
export interface Source { id: string; name: string; url: string; apiKey: string }
export const OPENROUTER = "openrouter";
const OPENROUTER_URL = "https://openrouter.ai/api/v1";

/** Fontes cadastradas em /agents (a chave fica só no banco, em settings.sources). */
export async function getSources(): Promise<Source[]> {
  return getSetting<Source[]>("sources", []);
}

export function pickSource(id: string, sources: Source[], openrouterKey: string): Source {
  if (id === OPENROUTER) return { id, name: "OpenRouter", url: OPENROUTER_URL, apiKey: openrouterKey };
  const s = sources.find((x) => x.id === id);
  if (!s) throw new Error(`A fonte de modelos "${id}" não existe mais. Escolha outra fonte no agente, em Agentes.`);
  return s;
}

/** A fonte pelo id; a embutida usa a chave do OpenRouter das Configurações (obrigatória). */
export async function getSource(id: string): Promise<Source> {
  if (id !== OPENROUTER) return pickSource(id, await getSources(), "");
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
export const authHeader = (src: Source): Record<string, string> =>
  src.apiKey ? { Authorization: `Bearer ${src.apiKey}` } : {};

/** Chave para mostrar na tela: começo e fim, nunca inteira. */
export function maskKey(key: string): string {
  if (!key) return "";
  return key.length > 8 ? `${key.slice(0, 6)}...${key.slice(-4)}` : "***";
}

export const sourceView = ({ id, name, url, apiKey }: Source): SourceView => ({ id, name, url, apiKeyMasked: maskKey(apiKey) });

/** URL, cabeçalhos e corpo da chamada. Fora do OpenRouter vai só o formato OpenAI: sem :online, reasoning e cabeçalhos de app. */
export function chatRequest(opts: ChatOptions, src: Source) {
  const or = src.id === OPENROUTER;
  const body: Record<string, unknown> = {
    model: or && opts.webSearch ? `${opts.model}:online` : opts.model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.8,
    max_tokens: opts.max_tokens ?? 2048,
  };
  if (opts.tools?.length) body.tools = opts.tools;
  if (opts.modalities) body.modalities = opts.modalities;
  // ponytail: reasoning é o parâmetro unificado do OpenRouter; nas outras fontes fica de fora (mapear para reasoning_effort se fizer falta)
  if (or && opts.reasoning) body.reasoning = opts.reasoning;
  if (opts.onDelta) {
    body.stream = true;
    body.stream_options = { include_usage: true }; // usage (tokens e, no OpenRouter, custo) chega no último pedaço
  }
  const headers: Record<string, string> = { "Content-Type": "application/json", ...authHeader(src) };
  if (or) Object.assign(headers, { "HTTP-Referer": "https://github.com/hugobsan/rpg", "X-Title": "Chronicle RPG" });
  return { url: `${src.url}/chat/completions`, headers, body };
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
  const src = await agentSource(opts.agentId);
  const { url, headers, body } = chatRequest(opts, src);
  const model = body.model as string;
  const started = Date.now();
  let responseJson: Record<string, unknown> | null = null;
  let error: string | null = null;
  try {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (opts.onDelta && res.ok && res.body) responseJson = await readStream(res.body, opts.onDelta);
    else {
      const text = await res.text();
      try {
        responseJson = JSON.parse(text);
      } catch {
        responseJson = { raw: text };
      }
      if (!res.ok)
        throw new Error(
          `${src.name} ${res.status}: ${text.slice(0, 500)}`
        );
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
    const usage = (responseJson as {
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
    } | null)?.usage;
    // log truncado: sem base64 de imagens, mensagens limitadas
    const logRequest = {
      model,
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
      cost: src.id === OPENROUTER ? usage?.cost : null, // USD real do OpenRouter (já com cache/busca/raciocínio); as outras fontes não informam
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
};

/** Lista modelos disponíveis no OpenRouter (para o seletor da tela de Agentes). */
export async function listModels(): Promise<
  {
    id: string; slug: string; name: string; context: number; pricing: ModelPricing;
    speech: boolean; // modelo de fala (TTS)
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
  });
  if (!res.ok) throw new Error(`${src.name} GET /models: ${res.status}`);
  const data = (await res.json()) as { data?: { id: string; name?: string }[] };
  if (!Array.isArray(data.data)) throw new Error(`${src.name} GET /models: resposta fora do formato OpenAI`);
  return data.data.map((m) => ({ id: m.id, name: m.name || m.id })).sort((a, b) => a.id.localeCompare(b.id));
}

/** Preço salvo no agente: USD por milhão de tokens + contexto. null se o modelo não existe no catálogo. */
export async function getModelPricing(id: string) {
  const m = (await listModels()).find((x) => x.id === id || x.slug === id); // aceita o id ou o slug versionado
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

/** Estimativa grosseira de tokens (~3.5 chars/token para pt-BR). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}
