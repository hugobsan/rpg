import { NextRequest, NextResponse } from "next/server";
import { q, setSetting } from "@/lib/db";
import { getEmbeddingConfig } from "@/lib/embeddings";
import { getSources, OPENROUTER, sourceView } from "@/lib/openrouter";
import { presetOf } from "@/lib/sourcePresets";

export const dynamic = "force-dynamic";

// Fontes de modelos OpenAI-compatíveis (settings.sources). A chave nunca sai daqui inteira.

const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });

/** nome e URL base validados (sem a barra final), ou o erro em texto */
function clean(body: { name?: unknown; url?: unknown }): { name: string; url: string } | string {
  const name = String(body.name ?? "").trim().slice(0, 60);
  const url = String(body.url ?? "").trim().replace(/\/+$/, "");
  if (!name) return "Informe o nome da fonte.";
  try {
    if (!/^https?:$/.test(new URL(url).protocol)) throw new Error();
  } catch {
    return "URL inválida: use a URL base da API, como https://api.openai.com/v1.";
  }
  return { name, url };
}

export async function GET() {
  return NextResponse.json((await getSources()).map(sourceView));
}

// Login com ChatGPT: só na fonte do tipo OpenAI; a chave fica de fora (o token vem de src/lib/chatgptAuth.ts)
const authOf = (kind: string | undefined, auth: unknown) => (kind === "openai" && auth === "chatgpt" ? ("chatgpt" as const) : undefined);
// o login é de uma conta só por instalação: uma segunda fonte ChatGPT seria a mesma coisa duplicada
const GPT_TAKEN = "Já existe uma fonte com Login com ChatGPT. O login vale para uma conta por instalação: use a fonte que já existe.";

/** POST { name, url, apiKey, kind?, auth? } → cria; o id sai do nome e não muda depois (nem o tipo) */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const preset = presetOf(body.kind);
  if (preset) body.url = preset.url; // tipo conhecido: URL fixa
  const c = clean(body);
  if (typeof c === "string") return bad(c);
  const list = await getSources();
  const base = c.name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "fonte";
  let id = base;
  for (let i = 2; id === OPENROUTER || list.some((s) => s.id === id); i++) id = `${base}-${i}`;
  const kind = presetOf(body.kind)?.kind;
  const src = { id, ...c, apiKey: String(body.apiKey ?? "").trim(), kind, auth: authOf(kind, body.auth) };
  if (src.auth && list.some((s) => s.auth)) return bad(GPT_TAKEN, 409);
  if (src.kind && !src.apiKey && !src.auth) return bad(`Informe a API key da ${c.name}.`);
  await setSetting("sources", [...list, src]);
  return NextResponse.json(sourceView(src));
}

/** PUT { id, name, url, apiKey?, auth? } → edita; chave vazia mantém a atual */
export async function PUT(req: NextRequest) {
  const body = await req.json();
  const list = await getSources();
  const src = list.find((s) => s.id === body.id);
  if (!src) return bad("Fonte não encontrada.", 404);
  if (presetOf(src.kind)) body.url = src.url; // tipo conhecido: URL fixa (getSources já trouxe a do preset)
  const c = clean(body);
  if (typeof c === "string") return bad(c);
  Object.assign(src, c);
  if (String(body.apiKey ?? "").trim()) src.apiKey = String(body.apiKey).trim();
  src.auth = authOf(src.kind, body.auth);
  if (src.auth && list.some((s) => s.auth && s.id !== src.id)) return bad(GPT_TAKEN, 409);
  if (src.kind && !src.apiKey && !src.auth) return bad(`Informe a API key da ${c.name}.`);
  await setSetting("sources", list);
  return NextResponse.json(sourceView(src));
}

/** DELETE ?id= → remove, se nenhum agente nem os embeddings usam a fonte */
export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id") || "";
  const users = (await q<{ name: string }>(`SELECT name FROM agents WHERE source = $1 ORDER BY name`, [id])).map((a) => a.name);
  if ((await getEmbeddingConfig()).source === id) users.push("Embeddings (Configurações)");
  if (users.length) return bad(`A fonte está em uso por: ${users.join(", ")}. Troque a fonte deles antes de remover.`, 409);
  await setSetting("sources", (await getSources()).filter((s) => s.id !== id));
  return NextResponse.json({ ok: true });
}
