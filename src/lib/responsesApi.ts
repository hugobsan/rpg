// Tradutor entre o formato de chat() (mensagens e tools no estilo Chat Completions) e a Responses API, usada no
// Login com ChatGPT. Ida: responsesRequest. Volta: readResponses lê o SSE e monta o mesmo JSON que readStream,
// então chat(), o log e Custos e uso não mudam. Regras do SIWC: store false, stream true, histórico inteiro no input,
// sem temperature, max_output_tokens, top_p, previous_response_id, metadata, user etc.
// Doc: https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
import type { ChatMessage, ChatOptions, Source, ToolCall } from "./openrouter";
import type { ChatgptLimits, ChatgptWindow } from "./types";

export const USAGE_URL = "https://chatgpt.com/settings/usage";
// o SIWC pede as funções agrupadas num namespace; a chamada volta com o nome curto e namespace "chronicle"
const NAMESPACE = "chronicle";

// ponytail: só texto (partes de imagem viram nada); nenhum chamador manda imagem para chat() hoje
const text = (c: ChatMessage["content"]) => (typeof c === "string" ? c : (c ?? []).map((p) => p.text ?? "").join(""));

/** URL, cabeçalhos e corpo de POST {url}/responses com o Bearer da fonte (o access token do ChatGPT). */
export function responsesRequest(opts: ChatOptions, src: Source) {
  const input: Record<string, unknown>[] = [];
  for (const m of opts.messages) {
    if (m.role === "system") continue; // vai em instructions (item com role system é recusado)
    if (m.role === "tool") {
      input.push({ type: "function_call_output", call_id: m.tool_call_id, output: text(m.content) });
      continue;
    }
    if (m.role === "user" || text(m.content)) input.push({ role: m.role, content: text(m.content) });
    for (const t of m.tool_calls || [])
      input.push({ type: "function_call", call_id: t.id, name: t.function.name, arguments: t.function.arguments, namespace: NAMESPACE });
  }
  const body: Record<string, unknown> = { model: opts.model, input, store: false, stream: true };
  const instructions = opts.messages.filter((m) => m.role === "system").map((m) => text(m.content)).join("\n\n");
  if (instructions) body.instructions = instructions;
  if (opts.tools?.length)
    body.tools = [{
      type: "namespace",
      name: NAMESPACE,
      description: "Ferramentas do jogo Chronicle RPG.",
      // strict false: o mesmo comportamento do Chat Completions (a Responses tentaria o modo estrito)
      tools: opts.tools.map(({ function: f }) => ({ type: "function", name: f.name, description: f.description, parameters: f.parameters, strict: false })),
    }];
  if (opts.reasoning?.effort) body.reasoning = { effort: opts.reasoning.effort };
  return { url: `${src.url}/responses`, headers: { "Content-Type": "application/json", Authorization: `Bearer ${src.apiKey}` }, body };
}

/**
 * Limites da assinatura nos cabeçalhos x-codex-* (o formato que o Codex lê: codex-rs/codex-api/src/rate_limits.rs):
 * primary é a janela de 5 h e secondary a semanal. A doc do SIWC não promete esses cabeçalhos: sem eles, null.
 */
export function codexLimits(h: Headers): ChatgptLimits | null {
  const num = (k: string) => (h.get(k) ? Number(h.get(k)) : NaN);
  const win = (w: string): ChatgptWindow | null => {
    const used = num(`x-codex-${w}-used-percent`), min = num(`x-codex-${w}-window-minutes`), reset = num(`x-codex-${w}-reset-at`);
    return isNaN(used) ? null : { usedPercent: used, windowMinutes: isNaN(min) ? null : min, resetsAt: isNaN(reset) ? null : reset };
  };
  const primary = win("primary"), secondary = win("secondary");
  return primary || secondary ? { primary, secondary, seenAt: new Date().toISOString() } : null;
}

type RespError = { code?: string | null; message?: string; param?: string | null; detail?: string };

/** Mensagem útil em português para os erros do plano do ChatGPT (subscription_sharing_*); os outros passam como vieram. */
export function chatgptError(e: RespError): string {
  switch (e.code) {
    case "subscription_sharing_usage_limit_exceeded":
      return `Limite da sua assinatura ChatGPT atingido (o do plano ou o que você deu a este app). Veja o uso e os limites em ${USAGE_URL}`;
    case "subscription_sharing_user_not_eligible":
      return "Sua conta ChatGPT não pode usar o plano neste app: o Login com ChatGPT está em preview, restrito por plano, workspace ou região. Enquanto isso, use a fonte OpenAI com API key (ou outra fonte).";
    case "subscription_sharing_usage_unavailable":
    case "subscription_sharing_user_unavailable":
      return "O ChatGPT não conseguiu conferir o seu uso agora. Tente de novo em alguns minutos.";
    case "subscription_sharing_unsupported_capability":
      return `O Login com ChatGPT não aceita parte do pedido${e.param ? ` (${e.param})` : ""}.`;
    case "subscription_sharing_route_not_supported":
      return "O Login com ChatGPT só faz texto, pela Responses API: imagem, voz, embeddings e o Jev não funcionam nessa fonte.";
    case "subscription_sharing_invalid_user":
    case "chatpass_v2_scope_not_authorized":
    case "chatpass_v2_invalid_authorization_context":
      return "O ChatGPT não aceitou a autorização deste app. Em Configurações > Fontes de modelos, desconecte e clique em Continuar com o ChatGPT de novo.";
  }
  return e.message || e.detail || e.code || "erro";
}

/** Corpo de um HTTP de erro antes do stream: {error: {...}} da API ou {detail: "..."} da admissão. */
export function responsesHttpError(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: RespError; detail?: string };
    return chatgptError({ ...j.error, detail: typeof j.detail === "string" ? j.detail : undefined });
  } catch {
    return body.slice(0, 500);
  }
}

type Event = {
  type: string;
  delta?: string;
  item?: { type?: string; call_id?: string; name?: string; arguments?: string };
  response?: {
    id?: string; model?: string; error?: RespError | null;
    incomplete_details?: { reason?: string } | null;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  error?: RespError;
} & RespError;

/**
 * Lê o SSE da Responses API: output_text.delta vira texto (e onDelta), cada function_call pronta vira tool_call,
 * response.completed é o único sucesso; failed, incomplete, evento error ou o stream acabar antes viram `error`.
 */
export async function readResponses(stream: ReadableStream<Uint8Array>, onDelta: (text: string) => void): Promise<Record<string, unknown>> {
  const msg: { role: string; content: string; tool_calls?: ToolCall[] } = { role: "assistant", content: "" };
  const choice: { message: typeof msg; finish_reason: string | null } = { message: msg, finish_reason: null };
  const out: Record<string, unknown> = { choices: [choice] };
  const calls: ToolCall[] = [];
  let completed = false;
  const handle = (line: string) => {
    if (!line.startsWith("data:")) return; // "event: ...", comentários e linhas vazias (o tipo vem também no JSON)
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    const e = JSON.parse(data) as Event;
    const r = e.response;
    if (e.type === "response.output_text.delta" && e.delta) {
      msg.content += e.delta;
      onDelta(e.delta);
    } else if (e.type === "response.output_item.done" && e.item?.type === "function_call")
      calls.push({ id: e.item.call_id || "", type: "function", function: { name: e.item.name || "", arguments: e.item.arguments || "" } });
    else if (e.type === "response.completed") {
      completed = true;
      out.id = r?.id;
      out.model = r?.model;
      if (r?.usage) out.usage = { prompt_tokens: r.usage.input_tokens, completion_tokens: r.usage.output_tokens };
    } else if (e.type === "response.failed") out.error = { code: r?.error?.code, message: chatgptError(r?.error || {}) };
    else if (e.type === "response.incomplete") out.error = { message: `a resposta veio incompleta (${r?.incomplete_details?.reason || "sem motivo"})` };
    else if (e.type === "error") out.error = { code: (e.error ?? e).code, message: chatgptError(e.error ?? e) };
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
  if (!completed && !out.error) out.error = { message: "a resposta parou antes do fim (sem response.completed)" };
  if (calls.length) msg.tool_calls = calls;
  choice.finish_reason = out.error ? "error" : calls.length ? "tool_calls" : "stop";
  return out;
}
