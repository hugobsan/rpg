import { getSetting, q } from "./db";

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

/**
 * Chamada única ao OpenRouter (chat completions). Toda chamada é registrada
 * em api_logs com tokens, duração e erro — visível na tela de Agentes.
 */
export async function chat(opts: ChatOptions): Promise<ChatResult> {
  const apiKey = await getOpenRouterKey();
  if (!apiKey)
    throw new Error(
      "Chave do OpenRouter não configurada. Vá em Configurações e informe sua API key."
    );

  const model = opts.webSearch ? `${opts.model}:online` : opts.model;
  const body: Record<string, unknown> = {
    model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.8,
    max_tokens: opts.max_tokens ?? 2048,
  };
  if (opts.tools?.length) body.tools = opts.tools;
  if (opts.modalities) body.modalities = opts.modalities;

  const started = Date.now();
  let responseJson: Record<string, unknown> | null = null;
  let error: string | null = null;
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/hugobsan/rpg",
        "X-Title": "Chronicle RPG",
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    try {
      responseJson = JSON.parse(text);
    } catch {
      responseJson = { raw: text };
    }
    if (!res.ok)
      throw new Error(
        `OpenRouter ${res.status}: ${text.slice(0, 500)}`
      );
    const errObj = (responseJson as { error?: { message?: string } }).error;
    if (errObj) throw new Error(`OpenRouter: ${errObj.message || "erro"}`);

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
      usage?: { prompt_tokens?: number; completion_tokens?: number };
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
            ? m.content.slice(0, 4000)
            : "[multimodal]",
        tool_calls: m.tool_calls?.map((t) => t.function.name),
      })),
    };
    const logResponse = responseJson
      ? JSON.parse(
          JSON.stringify(responseJson, (k, v) =>
            typeof v === "string" && v.startsWith("data:image")
              ? "[imagem]"
              : v
          ).slice(0, 20000)
        )
      : null;
    await q(
      `INSERT INTO api_logs (agent_id, campaign_id, model, purpose, request, response, prompt_tokens, completion_tokens, duration_ms, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        opts.agentId,
        opts.campaignId || null,
        model,
        opts.purpose,
        JSON.stringify(logRequest),
        logResponse ? JSON.stringify(logResponse) : null,
        usage?.prompt_tokens ?? null,
        usage?.completion_tokens ?? null,
        Date.now() - started,
        error,
      ]
    ).catch(() => {});
  }
}

/** Lista modelos disponíveis no OpenRouter (para o seletor da tela de Agentes). */
export async function listModels(): Promise<
  { id: string; name: string; context: number; pricing: { prompt: string; completion: string } }[]
> {
  const apiKey = await getOpenRouterKey();
  const res = await fetch("https://openrouter.ai/api/v1/models", {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  });
  if (!res.ok) throw new Error(`OpenRouter models: ${res.status}`);
  const data = (await res.json()) as {
    data: {
      id: string;
      name: string;
      context_length: number;
      pricing: { prompt: string; completion: string };
    }[];
  };
  return data.data
    .map((m) => ({
      id: m.id,
      name: m.name,
      context: m.context_length,
      pricing: m.pricing,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Estimativa grosseira de tokens (~3.5 chars/token para pt-BR). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}
