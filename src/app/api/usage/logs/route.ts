import { NextRequest, NextResponse } from "next/server";
import { usageLogs } from "@/app/usage/data";

export const dynamic = "force-dynamic";

// histórico paginado do recorte filtrado (sem request/response: ver logs/[id])
export async function GET(req: NextRequest) {
  return NextResponse.json(await usageLogs(req.nextUrl.searchParams));
}
