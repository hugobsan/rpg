// npx tsx scripts/chatgpt-auth-check.ts — Login com ChatGPT sem IA, sem banco e sem rede:
// PKCE e URL de autorização (1º login e re-login), callback (state, client_id, id_token pelo JWKS, escopo do plano),
// refresh serializado com rotação e erros, logout com revogação, status sem token, o tradutor para a Responses API
// (sem campos proibidos) e o parser do SSE; no fim, chat() e GET /models numa fonte OpenAI no modo ChatGPT.
// O banco é um pool falso em global.__pgPool (o mesmo global de src/lib/db.ts) e o fetch é trocado.
import assert from "node:assert";
import { generateKeyPairSync, sign } from "node:crypto";
import { chatgptAccessToken, chatgptStatus, finishLogin, logout, pkceChallenge, startLogin } from "../src/lib/chatgptAuth";
import { readResponses, responsesHttpError, responsesRequest } from "../src/lib/responsesApi";
import { chat, listSourceModels, type ChatMessage, type ChatOptions, type Source, type ToolDef } from "../src/lib/openrouter";

// ---------- banco falso ----------
const settings: Record<string, unknown> = {
  sources: [{ id: "gpt", name: "OpenAI", url: "https://api.openai.com/v1", apiKey: "", kind: "openai", auth: "chatgpt" }],
};
const logs: unknown[][] = [];
const g = global as unknown as { __pgPool?: unknown; __schemaReady?: Promise<boolean> };
g.__schemaReady = Promise.resolve(false);
g.__pgPool = {
  async query(text: string, params: unknown[] = []) {
    if (/SELECT value FROM settings/.test(text)) return { rows: params[0] as string in settings ? [{ value: structuredClone(settings[params[0] as string]) }] : [] };
    if (/INSERT INTO settings/.test(text)) settings[params[0] as string] = JSON.parse(params[1] as string);
    if (/SELECT source(, params)? FROM agents/.test(text)) return { rows: [{ source: "gpt", params: {} }] };
    if (/INSERT INTO api_logs/.test(text)) logs.push(params);
    return { rows: [] };
  },
};
const creds = () => settings.chatgpt as Record<string, unknown>;

// ---------- chaves e id_token ----------
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
function idToken(claims: Record<string, unknown>, key = privateKey) {
  const head = `${b64({ alg: "RS256", kid: "k1", typ: "JWT" })}.${b64({ iss: "https://auth.openai.com", sub: "user-1", email: "hugo@example.com", exp: Math.floor(Date.now() / 1000) + 3600, ...claims })}`;
  return `${head}.${sign("sha256", Buffer.from(head), key).toString("base64url")}`;
}

// ---------- rede falsa ----------
type Form = Record<string, string>;
let onToken: (f: Form) => Response = () => new Response("{}", { status: 500 });
let onResponses: (body: Record<string, unknown>) => Response = () => new Response("", { status: 500 });
let revokeOk = true;
const calls: { url: string; form?: Form; headers?: Record<string, string>; body?: Record<string, unknown> }[] = [];
globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  const isForm = init?.body instanceof URLSearchParams;
  const form = isForm ? Object.fromEntries(init!.body as URLSearchParams) : undefined;
  const body = !isForm && init?.body ? JSON.parse(String(init.body)) : undefined;
  calls.push({ url, form, body, headers: init?.headers as Record<string, string> });
  if (url.endsWith("/.well-known/openid-configuration"))
    return Response.json({ jwks_uri: "https://auth.openai.com/.well-known/jwks.json", revocation_endpoint: "https://auth.openai.com/api/accounts/oauth/revoke" });
  if (url.endsWith("/jwks.json")) return Response.json({ keys: [jwk] });
  if (url.endsWith("/oauth/token")) return onToken(form!);
  if (url.endsWith("/oauth/revoke")) return new Response(null, { status: revokeOk ? 200 : 503 });
  if (url === "https://api.openai.com/v1/responses") return onResponses(body!);
  if (url === "https://api.openai.com/v1/models")
    return Response.json({ models: [
      { slug: "gpt-6.1-sol", display_name: "GPT-6.1 Sol", visibility: "list" },
      { slug: "interno", display_name: "Interno", visibility: "hide" },
      { slug: "gpt-6-luna", display_name: "GPT-6 Luna", visibility: "list" },
    ] });
  return new Response("não achei", { status: 404 });
}) as typeof fetch;

/** Corpo SSE em pedaços de `size` bytes, no formato da Responses API (event: + data:). */
function sse(events: object[], size = 1e6, end = true): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join(""));
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i >= bytes.length) return end ? c.close() : c.error(new Error("socket hang up"));
      c.enqueue(bytes.slice(i, (i += size)));
    },
  });
}
const params = (url: string) => Object.fromEntries(new URL(url).searchParams);
const tokens = (n: number, extra: object = {}) =>
  ({ access_token: `at-${n}`, refresh_token: `rt-${n}`, token_type: "Bearer", expires_in: 3600, scope: "chatgpt.tokens.use.direct email offline_access openid profile resource.invoke", ...extra });
const ORIGIN = "http://localhost:3000";

async function login(n: number, idClaims: (nonce: string) => Record<string, unknown> = (nonce) => ({ aud: ["oaiapp_1"], nonce }), extra: object = {}, issued: string | null = "oaiapp_1") {
  const p = params(await startLogin(ORIGIN));
  let form: Form = {};
  onToken = (f) => ((form = f), Response.json({ ...tokens(n, extra), id_token: idToken(idClaims(p.nonce)) }));
  const q = new URLSearchParams({ code: `code-${n}`, state: p.state, scope: "openid" });
  if (issued) q.set("client_id", issued);
  return { p, form: () => form, r: await finishLogin(q), q };
}

async function main() {
  // ---------- 1. PKCE (vetor do RFC 7636) e URL do 1º login ----------
  assert.equal(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  const u1 = await startLogin(ORIGIN);
  assert.ok(u1.startsWith("https://auth.openai.com/api/accounts/authorize?"));
  const p1 = params(u1);
  assert.equal(p1.client_id, "dynamic_agent_client");
  assert.equal(p1.agent_name_hint, "Chronicle RPG");
  assert.equal(p1.redirect_uri, "http://127.0.0.1:3000/auth/callback", "127.0.0.1, nunca localhost; a porta é a do app");
  assert.equal(p1.response_type, "code");
  assert.equal(p1.scope, "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct");
  assert.equal(p1.resource, "https://api.openai.com/v1");
  assert.equal(p1.code_challenge_method, "S256");
  assert.match(p1.code_challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(p1.state && p1.nonce && p1.state !== p1.nonce);
  assert.match(p1.ext_agent_host_id, /^urn:uuid:[0-9a-f-]{36}$/);
  assert.ok(!("id_token_hint" in p1) && !("login_hint" in p1));
  const host = creds().hostId;
  assert.equal(p1.ext_agent_host_id, host, "host id salvo em settings");
  assert.equal(params(await startLogin("http://localhost:4123")).redirect_uri, "http://127.0.0.1:4123/auth/callback");

  // ---------- 2. callback: troca do code com o client_id emitido e o mesmo verifier/redirect ----------
  const ok = await login(1);
  assert.deepEqual(ok.r, { returnTo: `${ORIGIN}/settings`, email: "hugo@example.com" });
  const f = ok.form();
  assert.equal(f.grant_type, "authorization_code");
  assert.equal(f.client_id, "oaiapp_1", "troca com o client_id emitido, não o dynamic");
  assert.equal(f.code, "code-1");
  assert.equal(f.redirect_uri, "http://127.0.0.1:3000/auth/callback");
  assert.equal(f.resource, "https://api.openai.com/v1");
  assert.equal(pkceChallenge(f.code_verifier), ok.p.code_challenge, "verifier da mesma tentativa");
  assert.equal(creds().clientId, "oaiapp_1");
  assert.equal(creds().accessToken, "at-1");
  assert.equal(creds().refreshToken, "rt-1");
  assert.equal(creds().hostId, host);
  assert.ok((creds().expiresAt as number) > Date.now() + 3500_000);
  // o mesmo state não serve duas vezes
  assert.match((await finishLogin(ok.q)).error!, /não corresponde a um login em andamento/);
  assert.match((await finishLogin(new URLSearchParams({ state: "inventado", code: "x" }))).error!, /não corresponde/);

  // status nunca leva token
  const st = await chatgptStatus();
  assert.equal(st.connected, true);
  assert.equal(st.email, "hugo@example.com");
  assert.ok(st.expiresAt && st.sessionUntil);
  const shown = JSON.stringify(st);
  for (const secret of ["at-1", "rt-1", String(creds().idToken)]) assert.ok(!shown.includes(secret), "status sem token");

  // ---------- 3. re-login: client_id emitido + hints, sem agent_name_hint, mesmo host ----------
  const p3 = params(await startLogin(ORIGIN));
  assert.equal(p3.client_id, "oaiapp_1");
  assert.ok(!("agent_name_hint" in p3));
  assert.equal(p3.id_token_hint, creds().idToken);
  assert.equal(p3.login_hint, "hugo@example.com");
  assert.equal(p3.ext_agent_host_id, host);
  assert.ok(!("prompt" in p3));
  // re-login que volta com outro client_id é descartado (e não troca o code)
  const before = calls.length;
  assert.match((await login(9, undefined, {}, "oaiapp_OUTRO")).r.error!, /outro client_id/);
  assert.ok(!calls.slice(before).some((c) => c.url.endsWith("/oauth/token")));
  // re-login sem client_id no callback usa o salvo
  assert.equal((await login(2, (nonce) => ({ aud: "oaiapp_1", nonce }), {}, null)).r.email, "hugo@example.com");
  assert.equal(creds().accessToken, "at-2");

  // ---------- 4. id_token inválido e erros do callback ----------
  assert.match((await login(3, (nonce) => ({ aud: ["oaiapp_1"], nonce: nonce + "x" }))).r.error!, /nonce/);
  assert.match((await login(3, (nonce) => ({ aud: ["oaiapp_2"], nonce }))).r.error!, /público/);
  assert.match((await login(3, (nonce) => ({ aud: ["oaiapp_1"], nonce, iss: "https://evil.example" }))).r.error!, /emissor/);
  assert.match((await login(3, (nonce) => ({ aud: ["oaiapp_1"], nonce, exp: 1000 }))).r.error!, /expirado/);
  assert.match((await login(3, (nonce) => ({ aud: ["oaiapp_1"], nonce, sub: "outra-pessoa" }))).r.error!, /outra conta/);
  {
    const p = params(await startLogin(ORIGIN));
    onToken = () => Response.json({ ...tokens(3), id_token: idToken({ aud: ["oaiapp_1"], nonce: p.nonce }, other.privateKey) });
    assert.match((await finishLogin(new URLSearchParams({ code: "c", state: p.state }))).error!, /assinatura/);
  }
  assert.equal(creds().accessToken, "at-2", "login que falhou não troca os tokens");
  {
    const p = params(await startLogin(ORIGIN));
    onToken = () => Response.json({ error: "invalid_grant" }, { status: 400 });
    assert.match((await finishLogin(new URLSearchParams({ code: "c", state: p.state }))).error!, /expirou ou já foi usado/);
    const d = params(await startLogin(ORIGIN));
    const denied = await finishLogin(new URLSearchParams({ error: "access_denied", state: d.state }));
    assert.match(denied.error!, /não autorizou/);
    assert.equal(denied.returnTo, `${ORIGIN}/settings`);
    const n = params(await startLogin(ORIGIN));
    assert.match((await finishLogin(new URLSearchParams({ error: "not_eligible", error_description: "plano", state: n.state }))).error!, /not_eligible: plano.*preview/);
  }
  // 1º login sem client_id emitido: registro incompleto
  settings.chatgpt = { hostId: host };
  assert.match((await login(4, undefined, {}, null)).r.error!, /Registro incompleto/);
  // sem o escopo do plano: guarda o registro sem tokens e o próximo login pede consentimento
  assert.match((await login(4, undefined, { scope: "openid email profile offline_access" })).r.error!, /chatgpt\.tokens\.use\.direct/);
  assert.equal(creds().clientId, "oaiapp_1");
  assert.equal(creds().accessToken, undefined);
  assert.equal((await chatgptStatus()).connected, false);
  assert.equal(params(await startLogin(ORIGIN)).prompt, "consent");
  await login(5);
  assert.equal(creds().accessToken, "at-5");
  assert.equal(creds().reconsent, undefined);

  // ---------- 5. access token: válido não renova; perto do fim renova uma vez só, com rotação ----------
  let n = 0;
  onToken = (fm) => {
    n++;
    assert.deepEqual(fm, { grant_type: "refresh_token", client_id: "oaiapp_1", refresh_token: "rt-5", resource: "https://api.openai.com/v1" });
    return Response.json(tokens(6));
  };
  assert.equal(await chatgptAccessToken(), "at-5");
  assert.equal(n, 0);
  creds().expiresAt = Date.now() + 60_000; // falta 1 min
  const [t1, t2, t3] = await Promise.all([chatgptAccessToken(), chatgptAccessToken(), chatgptAccessToken()]);
  assert.deepEqual([t1, t2, t3], ["at-6", "at-6", "at-6"]);
  assert.equal(n, 1, "refresh serializado");
  assert.equal(creds().refreshToken, "rt-6", "refresh token rotativo salvo");
  // falha passageira com o token ainda válido: segue com ele; já vencido: erro sem apagar nada
  creds().expiresAt = Date.now() + 60_000;
  onToken = () => new Response("bad gateway", { status: 502 });
  assert.equal(await chatgptAccessToken(), "at-6");
  creds().expiresAt = Date.now() - 1;
  await assert.rejects(chatgptAccessToken(), /Não foi possível renovar/);
  assert.equal(creds().refreshToken, "rt-6");
  // refresh token morto: limpa os tokens, guarda o registro
  onToken = () => Response.json({ error: "refresh_token_reused" }, { status: 400 });
  await assert.rejects(chatgptAccessToken(), /expirou ou foi desconectada/);
  assert.equal(creds().refreshToken, undefined);
  assert.equal(creds().clientId, "oaiapp_1");
  await assert.rejects(chatgptAccessToken(), /não conectado/);

  // ---------- 6. logout: revoga o refresh token e apaga os tokens ----------
  await login(7);
  const r0 = calls.length;
  assert.deepEqual(await logout(), { revoked: true });
  const rv = calls.slice(r0).find((c) => c.url.endsWith("/oauth/revoke"))!;
  assert.deepEqual(rv.form, { token: "rt-7", token_type_hint: "refresh_token", client_id: "oaiapp_1" });
  assert.deepEqual(Object.keys(creds()).sort(), ["clientId", "email", "hostId", "sub"]);
  assert.ok(!("id_token_hint" in params(await startLogin(ORIGIN))), "depois de sair, sem id_token_hint");
  await login(8);
  revokeOk = false;
  assert.deepEqual(await logout(), { revoked: false });
  assert.equal(creds().refreshToken, undefined, "apaga mesmo sem confirmar a revogação");

  // ---------- 7. tradutor: ida ----------
  const tools: ToolDef[] = [{ type: "function", function: { name: "roll_dice", description: "Rola dados", parameters: { type: "object", properties: { notation: { type: "string" } } } } }];
  const history: ChatMessage[] = [
    { role: "system", content: "Você é o Mestre." },
    { role: "user", content: "Rolo o dado." },
    { role: "assistant", content: "Vamos ver.", tool_calls: [{ id: "call_a", type: "function", function: { name: "roll_dice", arguments: '{"notation":"1d20"}' } }] },
    { role: "tool", tool_call_id: "call_a", name: "roll_dice", content: '{"total":17}' },
    { role: "assistant", content: null, tool_calls: [{ id: "call_b", type: "function", function: { name: "roll_dice", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_b", content: "ok" },
    { role: "assistant", content: "" },
  ];
  const SRC: Source = { id: "gpt", name: "OpenAI", url: "https://api.openai.com/v1", apiKey: "at-x", kind: "openai", auth: "chatgpt" };
  const opts: ChatOptions = { model: "gpt-6.1-sol", messages: history, tools, temperature: 0.8, max_tokens: 900, webSearch: true, modalities: ["text"], reasoning: { effort: "low" }, agentId: "gm", purpose: "check" };
  const req = responsesRequest(opts, SRC);
  assert.equal(req.url, "https://api.openai.com/v1/responses");
  assert.deepEqual(req.headers, { "Content-Type": "application/json", Authorization: "Bearer at-x" });
  assert.deepEqual(Object.keys(req.body).sort(), ["input", "instructions", "model", "reasoning", "store", "stream", "tools"]);
  const forbidden = ["temperature", "max_output_tokens", "max_tokens", "top_p", "previous_response_id", "metadata", "user", "background", "conversation", "max_tool_calls", "moderation", "multi_agent", "prompt", "prompt_cache_retention", "safety_identifier", "top_logprobs", "truncation"];
  for (const k of forbidden) assert.ok(!(k in req.body), `sem ${k}`);
  assert.equal(req.body.store, false);
  assert.equal(req.body.stream, true);
  assert.equal(req.body.instructions, "Você é o Mestre.");
  assert.deepEqual(req.body.reasoning, { effort: "low" });
  assert.deepEqual(req.body.input, [
    { role: "user", content: "Rolo o dado." },
    { role: "assistant", content: "Vamos ver." },
    { type: "function_call", call_id: "call_a", name: "roll_dice", arguments: '{"notation":"1d20"}', namespace: "chronicle" },
    { type: "function_call_output", call_id: "call_a", output: '{"total":17}' },
    { type: "function_call", call_id: "call_b", name: "roll_dice", arguments: "{}", namespace: "chronicle" },
    { type: "function_call_output", call_id: "call_b", output: "ok" },
  ]);
  assert.deepEqual(req.body.tools, [{
    type: "namespace", name: "chronicle", description: "Ferramentas do jogo Chronicle RPG.",
    tools: [{ type: "function", name: "roll_dice", description: "Rola dados", parameters: tools[0].function.parameters, strict: false }],
  }]);
  assert.ok(!(req.body.input as { role?: string }[]).some((i) => i.role === "system"), "nenhum item com role system");
  const plain = responsesRequest({ model: "m", messages: [{ role: "user", content: "oi" }], agentId: "gm", purpose: "x" }, SRC).body;
  assert.deepEqual(Object.keys(plain).sort(), ["input", "model", "store", "stream"], "sem system, tools nem reasoning: só o básico");

  // ---------- 8. parser do SSE: volta ----------
  const created = { type: "response.created", response: { id: "resp_1", status: "in_progress" } };
  const fcItem = { id: "fc_1", type: "function_call", status: "completed", call_id: "call_z", name: "roll_dice", arguments: '{"notation":"2d6"}', namespace: "chronicle" };
  const textEvents = [
    created,
    { type: "response.output_item.added", item: { type: "message" } },
    { type: "response.output_text.delta", delta: "Você entra na " },
    { type: "response.output_text.delta", delta: "sala — ação ✓" },
    { type: "response.output_item.added", item: { ...fcItem, arguments: "" } },
    { type: "response.function_call_arguments.delta", delta: '{"notation":' },
    { type: "response.function_call_arguments.done", arguments: '{"notation":"2d6"}' },
    { type: "response.output_item.done", item: fcItem },
    { type: "response.completed", response: { id: "resp_1", model: "gpt-6.1-sol", status: "completed", usage: { input_tokens: 120, output_tokens: 30 } } },
  ];
  for (const size of [1, 7, 100, 1e6]) {
    const deltas: string[] = [];
    const out = (await readResponses(sse(textEvents, size), (t) => deltas.push(t))) as {
      choices: { message: { content: string; tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[] }; finish_reason: string }[];
      usage: { prompt_tokens: number; completion_tokens: number }; error?: unknown; model: string;
    };
    assert.equal(out.error, undefined);
    assert.equal(out.choices[0].message.content, "Você entra na sala — ação ✓");
    assert.equal(deltas.join(""), out.choices[0].message.content);
    assert.deepEqual(out.choices[0].message.tool_calls, [{ id: "call_z", type: "function", function: { name: "roll_dice", arguments: '{"notation":"2d6"}' } }]);
    assert.equal(out.choices[0].finish_reason, "tool_calls");
    assert.deepEqual(out.usage, { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 0 } });
    assert.equal(out.model, "gpt-6.1-sol");
    // ida e volta: a chamada devolvida entra de novo no histórico com o mesmo call_id
    if (size === 1e6) {
      const again = responsesRequest({ ...opts, messages: [{ role: "user", content: "x" }, out.choices[0].message as ChatMessage, { role: "tool", tool_call_id: "call_z", content: "7" }] }, SRC).body.input;
      assert.deepEqual((again as object[]).slice(1), [
        { role: "assistant", content: "Você entra na sala — ação ✓" },
        { type: "function_call", call_id: "call_z", name: "roll_dice", arguments: '{"notation":"2d6"}', namespace: "chronicle" },
        { type: "function_call_output", call_id: "call_z", output: "7" },
      ]);
    }
  }
  const errOf = async (events: object[], end = true) => ((await readResponses(sse(events, 5, end), () => {})).error as { message: string; code?: string });
  const limit = await errOf([created, { type: "response.output_text.delta", delta: "Com" }, { type: "response.failed", response: { status: "failed", error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit" } } }]);
  assert.match(limit.message, /^Limite da sua assinatura ChatGPT atingido.*https:\/\/chatgpt\.com\/settings\/usage/);
  assert.equal(limit.code, "subscription_sharing_usage_limit_exceeded");
  assert.match((await errOf([created, { type: "response.failed", response: { error: { code: "subscription_sharing_user_not_eligible" } } }])).message, /preview.*API key/);
  assert.match((await errOf([created, { type: "response.failed", response: { error: { code: "server_error", message: "Inference connection error" } } }])).message, /Inference connection error/);
  assert.match((await errOf([created, { type: "response.incomplete", response: { incomplete_details: { reason: "content_filter" } } }])).message, /incompleta \(content_filter\)/);
  assert.match((await errOf([created, { type: "error", code: "subscription_sharing_unsupported_capability", param: "tools[0]" }])).message, /não aceita parte do pedido \(tools\[0\]\)/);
  assert.match((await errOf([created, { type: "response.output_text.delta", delta: "a" }])).message, /sem response\.completed/, "stream terminou sem completed");
  assert.match((await errOf([created], false)).message, /socket hang up/, "conexão caiu");
  // erros HTTP antes do stream
  assert.match(responsesHttpError(JSON.stringify({ error: { code: "subscription_sharing_usage_limit_exceeded", message: "x" } })), /Limite da sua assinatura/);
  assert.equal(responsesHttpError(JSON.stringify({ detail: "Region not supported" })), "Region not supported");
  assert.equal(responsesHttpError("<html>502</html>"), "<html>502</html>");

  // ---------- 9. chat() e GET /models numa fonte OpenAI no modo Login com ChatGPT ----------
  await login(10);
  let sent: Record<string, unknown> = {};
  onResponses = (b) => ((sent = b), new Response(sse(textEvents), { headers: { "content-type": "text/event-stream" } }));
  const c0 = calls.length;
  const res = await chat({ ...opts, messages: history.slice(0, 2) }); // sem onDelta: a Responses vai em streaming mesmo assim
  const call = calls.slice(c0).find((c) => c.url.endsWith("/responses"))!;
  assert.equal(call.headers!.Authorization, "Bearer at-10");
  assert.equal(sent.store, false);
  assert.equal(sent.stream, true);
  assert.ok(!("temperature" in sent) && !("max_output_tokens" in sent));
  assert.equal(res.content, "Você entra na sala — ação ✓");
  assert.deepEqual(res.toolCalls.map((t) => [t.id, t.function.name]), [["call_z", "roll_dice"]]);
  const log = logs[logs.length - 1]; // agent_id, campaign, model, purpose, request, response, prompt, completion, ms, error, cost, provider
  assert.deepEqual([log[0], log[2], log[6], log[7], log[9], log[10], log[11]], ["gm", "gpt-6.1-sol", 120, 30, null, null, "gpt"], "log com tokens, custo nulo e a fonte");
  const logged = JSON.stringify(log);
  assert.ok(!logged.includes("at-10") && !logged.includes("rt-10"), "token fora do log");
  onResponses = () => Response.json({ error: { code: "subscription_sharing_usage_limit_exceeded", message: "x" } }, { status: 429 });
  await assert.rejects(chat({ ...opts, messages: history.slice(0, 2) }), /OpenAI 429: Limite da sua assinatura ChatGPT atingido/);
  onResponses = () => new Response(sse([created, { type: "response.failed", response: { error: { code: "subscription_sharing_usage_unavailable" } } }]));
  await assert.rejects(chat({ ...opts, messages: history.slice(0, 2), onDelta: () => {} }), /OpenAI: O ChatGPT não conseguiu conferir o seu uso/);
  assert.deepEqual(await listSourceModels("gpt"), [{ id: "gpt-6.1-sol", name: "GPT-6.1 Sol" }, { id: "gpt-6-luna", name: "GPT-6 Luna" }], "só visibility list, na ordem do servidor");
  assert.equal(calls[calls.length - 1].headers && (calls[calls.length - 1].headers as Record<string, string>).Authorization, "Bearer at-10");
  await logout();
  await assert.rejects(chat({ ...opts, messages: history.slice(0, 2) }), /Login com ChatGPT não conectado/);

  console.log("chatgpt-auth-check: ok");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
