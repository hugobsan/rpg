// API nativa da fonte Anthropic. A camada compatível com a OpenAI (/v1/chat/completions) não faz cache e ignora
// reasoning_effort, então o agente com cache ligado ou com raciocínio (params.reasoning.effort) vai por /v1/messages (SDK oficial). Ida: anthropicParams traduz
// mensagens e tools do formato de chat(). Volta: toChatJson monta o mesmo JSON de readStream (choices[0].message,
// usage no formato do OpenRouter), então chat(), o log e Custos e uso não mudam.
// Doc: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
import Anthropic from "@anthropic-ai/sdk";
import { CACHE_LONG, CACHE_SHORT, type ChatMessage, type ChatOptions, type Source, type ToolCall } from "./openrouter";

const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

// ponytail: só texto (parte de imagem vira nada), como em responsesApi; nenhum chamador manda imagem para chat() hoje
const text = (c: ChatMessage["content"]) => (typeof c === "string" ? c : (c ?? []).map((p) => p.text ?? "").join(""));

function input(args: string): Record<string, unknown> {
  try {
    return JSON.parse(args || "{}");
  } catch {
    return {}; // argumento quebrado: o executor já respondeu erro na mensagem tool seguinte
  }
}

/**
 * Corpo de messages.create. Com cache, até quatro pontos (o limite da API): fim das tools e fim da 1ª mensagem de
 * sistema (o prefixo fixo do agente), fim da mensagem marcada com cache (o histórico, que o próximo turno lê),
 * todos de 1 h, e o automático de 5 min no fim da conversa, que cada rodada de ferramentas lê da anterior. Sem temperature (Claude 4.7+ recusa) nem thinking (os 5.x pensam por padrão, e o Opus 5.5 recusa
 * desligar); a profundidade vai em output_config.effort. Os blocos de raciocínio não voltam no histórico.
 */
export function anthropicParams(opts: ChatOptions, cache = true): Anthropic.MessageCreateParamsNonStreaming {
  const system: Anthropic.TextBlockParam[] = opts.messages
    .filter((m) => m.role === "system")
    .map((m) => ({ type: "text", text: text(m.content) }));
  if (cache && system[0]) system[0].cache_control = CACHE_LONG;

  const messages: Anthropic.MessageParam[] = [];
  const push = (role: "user" | "assistant", blocks: Anthropic.ContentBlockParam[]) => {
    const prev = messages[messages.length - 1];
    // tool_result de várias tools (e o aviso do sistema que vem depois) numa mensagem só de user
    if (prev?.role === role && Array.isArray(prev.content)) prev.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };
  for (const m of opts.messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      push("user", [{ type: "tool_result", tool_use_id: m.tool_call_id ?? "", content: text(m.content) }]);
      continue;
    }
    const blocks: Anthropic.ContentBlockParam[] = [];
    if (text(m.content)) blocks.push({ type: "text", text: text(m.content) });
    for (const t of m.tool_calls || []) blocks.push({ type: "tool_use", id: t.id, name: t.function.name, input: input(t.function.arguments) });
    if (!blocks.length) continue; // texto vazio é recusado pela API
    push(m.role, blocks);
    if (cache && m.cache) (blocks[blocks.length - 1] as Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam).cache_control = CACHE_LONG;
  }

  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model: opts.model,
    max_tokens: opts.max_tokens ?? 2048,
    system,
    messages,
  };
  if (cache) params.cache_control = CACHE_SHORT;
  const effort = opts.reasoning?.effort;
  // effort do OpenRouter fora da escala da Anthropic ("minimal", "none") fica de fora: vale o padrão do modelo
  if (typeof effort === "string" && EFFORTS.has(effort))
    params.output_config = { effort: effort as Anthropic.OutputConfig["effort"] };
  if (opts.tools?.length) {
    params.tools = opts.tools.map(({ function: f }) => ({
      name: f.name,
      description: f.description,
      input_schema: f.parameters as Anthropic.Tool.InputSchema,
    }));
    if (cache) params.tools[params.tools.length - 1].cache_control = CACHE_LONG;
    if (opts.noTools) params.tool_choice = { type: "none" };
  }
  return params;
}

/** Resposta nativa → JSON de readStream; cache lido e gravado em prompt_tokens_details (os nomes do OpenRouter). */
export function toChatJson(msg: Anthropic.Message): Record<string, unknown> {
  const content = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const calls: ToolCall[] = msg.content
    .filter((b) => b.type === "tool_use")
    .map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input) } }));
  const read = msg.usage.cache_read_input_tokens ?? 0;
  const write = msg.usage.cache_creation_input_tokens ?? 0;
  const out: Record<string, unknown> = {
    id: msg.id,
    model: msg.model,
    choices: [{
      message: { role: "assistant", content, ...(calls.length ? { tool_calls: calls } : {}) },
      finish_reason: calls.length ? "tool_calls" : msg.stop_reason === "max_tokens" ? "length" : "stop",
    }],
    usage: {
      prompt_tokens: msg.usage.input_tokens + read + write,
      completion_tokens: msg.usage.output_tokens,
      prompt_tokens_details: { cached_tokens: read, cache_write_tokens: write },
    },
  };
  if (msg.stop_reason === "refusal") out.error = { message: "o modelo recusou responder (filtro de segurança da Anthropic)" };
  return out;
}

/** POST /v1/messages em streaming pelo SDK; erro da API ou da rede vira `error` no resultado, como em readStream. */
export async function anthropicChat(opts: ChatOptions, src: Source, cache = true): Promise<Record<string, unknown>> {
  try {
    const stream = new Anthropic({ apiKey: src.apiKey }).messages.stream(anthropicParams(opts, cache), { signal: opts.signal });
    if (opts.onDelta) stream.on("text", (delta) => opts.onDelta!(delta));
    return toChatJson(await stream.finalMessage());
  } catch (e) {
    const status = e instanceof Anthropic.APIError && e.status ? `${e.status} ` : "";
    return { error: { message: `${status}${e instanceof Error ? e.message : String(e)}` } };
  }
}
