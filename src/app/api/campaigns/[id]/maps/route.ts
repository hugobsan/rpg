import { NextRequest, NextResponse } from "next/server";
import { getLocalMapSpec, requestLocalMap } from "@/lib/cartographer";

export const dynamic = "force-dynamic";

/** GET ?map=id → spec do mapa 3D (a lista, sem spec, vem no GET da campanha). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const spec = await getLocalMapSpec(id, Number(req.nextUrl.searchParams.get("map")) || 0);
  return spec ? NextResponse.json(spec) : NextResponse.json({ error: "Mapa não encontrado." }, { status: 404 });
}

/** POST { action: generate | edit | remove, placeId, brief? } → botões da aba Mapa; gerar e editar rodam em segundo plano. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const action = (["generate", "edit", "remove"] as const).find((a) => a === body.action);
  if (!action || typeof body.placeId !== "string") return NextResponse.json({ error: "Pedido inválido." }, { status: 400 });
  const r = await requestLocalMap(id, body.placeId, action, String(body.brief ?? ""));
  return NextResponse.json(r.ok ? r : { error: r.message }, { status: r.ok ? 200 : 400 });
}
