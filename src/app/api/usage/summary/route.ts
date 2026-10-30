import { NextRequest, NextResponse } from "next/server";
import { usageSummary } from "@/app/usage/data";

export const dynamic = "force-dynamic";

// totais, quebras por agente/modelo/dia do recorte filtrado + opções dos filtros
export async function GET(req: NextRequest) {
  return NextResponse.json(await usageSummary(req.nextUrl.searchParams));
}
