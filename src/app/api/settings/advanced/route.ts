import { NextRequest, NextResponse } from "next/server";
import { getAdvanced, saveAdvanced } from "@/lib/advanced";

export const dynamic = "force-dynamic";

/** Configurações avançadas (lib/advanced.ts): GET os valores em uso; PUT substitui e devolve o normalizado. */
export async function GET() {
  return NextResponse.json(await getAdvanced());
}

export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  return NextResponse.json(await saveAdvanced(body));
}
