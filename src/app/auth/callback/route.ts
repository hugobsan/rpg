import { NextRequest, NextResponse } from "next/server";
import { finishLogin } from "@/lib/chatgptAuth";

export const dynamic = "force-dynamic";

// Retorno do Login com ChatGPT em http://127.0.0.1:{porta}/auth/callback (caminho exigido pela OpenAI):
// troca o code e volta para Agentes com ?chatgpt=ok ou ?chatgpt_erro=<mensagem>.
export async function GET(req: NextRequest) {
  const r = await finishLogin(req.nextUrl.searchParams);
  const to = new URL(r.returnTo || "/agents", req.nextUrl.origin);
  if (r.error) to.searchParams.set("chatgpt_erro", r.error);
  else to.searchParams.set("chatgpt", "ok");
  return NextResponse.redirect(to);
}
