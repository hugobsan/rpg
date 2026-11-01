// Login com ChatGPT (Sign in with ChatGPT, token sharing para apps open source locais): OAuth authorization code
// com PKCE S256 e nonce OIDC, cliente público registrado no 1º login. Doc: https://developers.openai.com/siwc/token-sharing-open-source
// Os tokens ficam só no servidor, em settings.chatgpt: nunca vão para o cliente, para URL nem para log.
import { createHash, createPublicKey, randomBytes, randomUUID, verify, type JsonWebKey } from "node:crypto";
import { getSetting, setSetting } from "./db";
import type { ChatgptLimits, ChatgptStatus } from "./types";

const ISSUER = "https://auth.openai.com";
const AUTHORIZE = `${ISSUER}/api/accounts/authorize`;
const TOKEN = `${ISSUER}/api/accounts/oauth/token`;
const RESOURCE = "https://api.openai.com/v1";
const PLAN_SCOPE = "chatgpt.tokens.use.direct"; // sem ele o login vale, mas o plano não paga a inferência
const SCOPE = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
const DYNAMIC = "dynamic_agent_client"; // só para o 1º login (registro); depois vale o client_id emitido
const SKEW = 5 * 60_000; // renova o access token (1 h) quando faltam 5 min
const SESSION_MS = 30 * 86_400_000; // o refresh token vale 30 dias e renova a cada refresh
const NOT_CONNECTED = "Login com ChatGPT não conectado. Em Configurações > Fontes de modelos, clique em Continuar com o ChatGPT.";
// refresh token que não serve mais: limpar e refazer o login
const TERMINAL = new Set(["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"]);

interface Creds {
  hostId?: string; // ext_agent_host_id: urn:uuid gerado uma vez por instalação (opaco, não é segredo nem identidade)
  clientId?: string; // oaiapp_... emitido no registro; vale para login, troca, refresh e revogação
  sub?: string;
  email?: string;
  idToken?: string; // id_token_hint do próximo login (some ao desconectar)
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number; // ms
  savedAt?: number; // ms do último token recebido (a sessão vale 30 dias a partir dele)
  scopes?: string[];
  reconsent?: boolean; // o último login veio sem o escopo do plano: o próximo pede o consentimento de novo
}
interface Pending { verifier: string; nonce: string; clientId: string; redirectUri: string; returnTo: string; expires: number }
interface TokenResponse { access_token: string; refresh_token?: string; id_token?: string; expires_in?: number; scope?: string }

const load = () => getSetting<Creds>("chatgpt", {});
const save = (c: Creds) => setSetting("chatgpt", c);
const g = global as unknown as { __chatgptPending?: Map<string, Pending>; __chatgptRefresh?: Promise<string> | null };
const pending = (g.__chatgptPending ??= new Map()); // tentativas de login em andamento, por state (10 min)
const rand = (bytes = 32) => randomBytes(bytes).toString("base64url");
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const pkceChallenge = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

class OAuthError extends Error {
  constructor(public code: string, msg: string) {
    super(msg);
  }
}

/**
 * URL de autorização para abrir no navegador. `origin` é de onde o login partiu (http://localhost:3000): o callback
 * usa a mesma porta em 127.0.0.1 (a doc exige 127.0.0.1, nunca localhost, e o caminho exato /auth/callback) e no
 * fim volta para {origin}/settings (Configurações, onde fica o botão).
 */
export async function startLogin(origin: string): Promise<string> {
  const c = await load();
  if (!c.hostId) {
    c.hostId = `urn:uuid:${randomUUID()}`;
    await save(c);
  }
  const port = new URL(origin).port;
  const redirectUri = `http://127.0.0.1${port ? `:${port}` : ""}/auth/callback`;
  const [state, nonce, verifier] = [rand(), rand(), rand(64)];
  const clientId = c.clientId || DYNAMIC;
  for (const [k, p] of pending) if (p.expires < Date.now()) pending.delete(k);
  pending.set(state, { verifier, nonce, clientId, redirectUri, returnTo: new URL("/settings", origin).href, expires: Date.now() + 10 * 60_000 });
  const q = new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: redirectUri, scope: SCOPE, resource: RESOURCE,
    state, nonce, code_challenge_method: "S256", code_challenge: pkceChallenge(verifier), ext_agent_host_id: c.hostId,
  });
  if (clientId === DYNAMIC) q.set("agent_name_hint", "Chronicle RPG");
  else {
    if (c.idToken) q.set("id_token_hint", c.idToken); // pula a escolha de conta
    if (c.email) q.set("login_hint", c.email);
    if (c.reconsent) q.set("prompt", "consent");
  }
  return `${AUTHORIZE}?${q}`;
}

/** Trata o retorno em /auth/callback: confere o state, troca o code, valida o id_token e salva os tokens. */
export async function finishLogin(q: URLSearchParams): Promise<{ returnTo?: string; email?: string; error?: string }> {
  const state = q.get("state") || "";
  const p = pending.get(state);
  pending.delete(state);
  if (!p || p.expires < Date.now())
    return { error: "Este retorno do ChatGPT não corresponde a um login em andamento (expirou ou já foi usado). Clique em Continuar com o ChatGPT de novo." };
  const fail = (error: string) => ({ returnTo: p.returnTo, error });
  const err = q.get("error");
  if (err)
    return fail(err === "access_denied"
      ? "Você não autorizou o Chronicle RPG no ChatGPT. Para usar o plano, clique em Continuar com o ChatGPT e aceite."
      : `O ChatGPT recusou o login (${err}${q.get("error_description") ? `: ${q.get("error_description")}` : ""}). O recurso está em preview e pode não estar liberado para a sua conta; a fonte OpenAI também funciona com API key.`);
  const code = q.get("code");
  if (!code) return fail("O ChatGPT voltou sem o código de autorização. Tente de novo.");
  const issued = q.get("client_id");
  let clientId = p.clientId;
  if (clientId === DYNAMIC) {
    if (!issued || issued === DYNAMIC) return fail("Registro incompleto: o ChatGPT não devolveu o client_id do app. Tente de novo.");
    clientId = issued;
  } else if (issued && issued !== clientId) return fail("O ChatGPT devolveu outro client_id para esta conta; o login foi descartado.");
  try {
    const tok = await tokenRequest({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: p.verifier, redirect_uri: p.redirectUri, resource: RESOURCE });
    const claims = await verifyIdToken(tok.id_token || "", clientId, p.nonce);
    const c = await load();
    if (c.clientId === clientId && c.sub && c.sub !== claims.sub) return fail("Essa é outra conta do ChatGPT, diferente da registrada neste app. Entre com a mesma conta.");
    const scopes = (tok.scope || "").split(" ").filter(Boolean);
    const base: Creds = { hostId: c.hostId, clientId, sub: claims.sub, email: claims.email, idToken: tok.id_token };
    if (!scopes.includes(PLAN_SCOPE)) {
      await save({ ...base, scopes, reconsent: true }); // guarda o registro, sem tokens: o plano não foi liberado
      return fail("Você entrou, mas o ChatGPT não liberou o uso do plano neste app (falta a permissão chatgpt.tokens.use.direct). O recurso está em preview e pode não estar liberado para a sua conta. Tente de novo aceitando o uso do plano, ou use a fonte OpenAI com API key.");
    }
    await save({ ...base, ...tokenFields(tok), scopes });
    return { returnTo: p.returnTo, email: claims.email };
  } catch (e) {
    return fail(e instanceof OAuthError && e.code === "invalid_grant" ? "O código do login expirou ou já foi usado. Clique em Continuar com o ChatGPT de novo." : message(e));
  }
}

/** Access token válido para a Responses API: renova sozinho perto do vencimento, um refresh por vez. */
export async function chatgptAccessToken(): Promise<string> {
  const c = await load();
  if (!c.accessToken || !c.refreshToken) throw new Error(NOT_CONNECTED);
  if ((c.expiresAt ?? 0) - Date.now() > SKEW) return c.accessToken;
  // ponytail: lock em memória (um processo do Next); com vários processos, lock no banco (pg_advisory_lock)
  return (g.__chatgptRefresh ??= refresh().finally(() => (g.__chatgptRefresh = null)));
}

async function refresh(): Promise<string> {
  const c = await load(); // relê: o refresh anterior pode ter acabado de trocar os tokens
  if (!c.refreshToken || !c.clientId) throw new Error(NOT_CONNECTED);
  if ((c.expiresAt ?? 0) - Date.now() > SKEW) return c.accessToken!;
  try {
    const tok = await tokenRequest({ grant_type: "refresh_token", client_id: c.clientId, refresh_token: c.refreshToken, resource: RESOURCE });
    // access, validade, escopos e o refresh token novo (rotativo) trocam juntos
    await save({ ...c, ...tokenFields(tok, c.refreshToken), scopes: tok.scope ? tok.scope.split(" ") : c.scopes });
    return tok.access_token;
  } catch (e) {
    if (e instanceof OAuthError && TERMINAL.has(e.code)) {
      await save({ hostId: c.hostId, clientId: c.clientId, sub: c.sub, email: c.email, idToken: c.idToken });
      throw new Error("A sessão do ChatGPT expirou ou foi desconectada. Em Configurações > Fontes de modelos, clique em Continuar com o ChatGPT.");
    }
    if (c.accessToken && (c.expiresAt ?? 0) > Date.now()) return c.accessToken; // falha passageira: o token atual ainda vale
    throw new Error(`Não foi possível renovar o acesso ao ChatGPT agora (${message(e)}). Tente de novo em instantes.`);
  }
}

/** Desconecta: revoga o refresh token na OpenAI e apaga os tokens; o registro (client_id, conta, host) fica para o próximo login. */
export async function logout(): Promise<{ revoked: boolean }> {
  await g.__chatgptRefresh?.catch(() => {}); // um refresh no meio não pode regravar os tokens depois
  const c = await load();
  let revoked = true;
  if (c.refreshToken && c.clientId) {
    // ponytail: uma tentativa; sem confirmação, a tela manda desconectar o app nas configurações do ChatGPT
    revoked = await discovery()
      .then((d) => fetch(d.revocation_endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: c.refreshToken!, token_type_hint: "refresh_token", client_id: c.clientId! }),
        signal: AbortSignal.timeout(15_000),
      }))
      .then((r) => r.ok, () => false);
  }
  await save({ hostId: c.hostId, clientId: c.clientId, sub: c.sub, email: c.email });
  await setSetting("chatgptLimits", null); // os limites eram da conta que saiu
  return { revoked };
}

/** Para a tela: conectado, e-mail e validade. Nunca devolve token. */
export async function chatgptStatus(): Promise<ChatgptStatus> {
  const c = await load();
  return {
    connected: !!c.refreshToken,
    email: c.email ?? null,
    expiresAt: c.refreshToken && c.expiresAt ? new Date(c.expiresAt).toISOString() : null,
    sessionUntil: c.refreshToken && c.savedAt ? new Date(c.savedAt + SESSION_MS).toISOString() : null,
    limits: c.refreshToken ? await getSetting<ChatgptLimits | null>("chatgptLimits", null) : null,
  };
}

const tokenFields = (t: TokenResponse, oldRefresh?: string): Creds => ({
  accessToken: t.access_token,
  refreshToken: t.refresh_token || oldRefresh,
  expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000,
  savedAt: Date.now(),
});

async function tokenRequest(form: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(20_000),
  });
  const d = (await res.json().catch(() => ({}))) as Partial<TokenResponse> & { error?: string; error_description?: string };
  if (!res.ok || !d.access_token) {
    const code = d.error || `http_${res.status}`;
    throw new OAuthError(code, `O ChatGPT recusou o token (${code}${d.error_description ? `: ${d.error_description}` : ""}).`);
  }
  return d as TokenResponse;
}

const discovery = (): Promise<{ jwks_uri: string; revocation_endpoint: string }> =>
  fetch(`${ISSUER}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(15_000) }).then((r) => r.json());

/** id_token: assinatura RS256 pelo JWKS do discovery, emissor, público (o client_id), validade e nonce. */
async function verifyIdToken(jwt: string, clientId: string, nonce: string): Promise<{ sub: string; email?: string }> {
  const [h, p, sig] = jwt.split(".");
  const bad = (why: string) => new Error(`ID token do ChatGPT inválido (${why}). Tente entrar de novo.`);
  let header: { alg?: string; kid?: string }, claims: { iss?: string; aud?: string | string[]; exp?: number; nonce?: string; sub?: string; email?: string };
  try {
    header = JSON.parse(Buffer.from(h, "base64url").toString());
    claims = JSON.parse(Buffer.from(p, "base64url").toString());
  } catch {
    throw bad("formato");
  }
  const { keys } = (await (await fetch((await discovery()).jwks_uri, { signal: AbortSignal.timeout(15_000) })).json()) as { keys: JsonWebKey[] };
  const jwk = keys.find((k) => k.kid === header.kid);
  if (header.alg !== "RS256" || !jwk || !verify("sha256", Buffer.from(`${h}.${p}`), createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(sig || "", "base64url")))
    throw bad("assinatura");
  if (claims.iss !== ISSUER) throw bad("emissor");
  if (![claims.aud].flat().includes(clientId)) throw bad("público");
  if (!claims.exp || claims.exp * 1000 < Date.now() - 5_000) throw bad("expirado");
  if (claims.nonce !== nonce) throw bad("nonce");
  if (!claims.sub) throw bad("sem sub");
  return { sub: claims.sub, email: claims.email };
}
