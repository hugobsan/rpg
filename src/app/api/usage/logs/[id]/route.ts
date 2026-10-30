import { NextRequest, NextResponse } from "next/server";
import { q } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Request e response de uma chamada, buscados só quando a linha do histórico abre. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^\d+$/.test(id)) return NextResponse.json({ error: "Id inválido" }, { status: 400 });
  const [row] = await q(`SELECT request, response, error FROM api_logs WHERE id = $1`, [id]);
  if (!row) return NextResponse.json({ error: "Chamada não encontrada" }, { status: 404 });
  return NextResponse.json(row);
}
