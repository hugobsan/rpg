import { NextRequest, NextResponse } from "next/server";
import { listJobs } from "@/lib/jobs";

export const dynamic = "force-dynamic";

/** GET → tarefas em segundo plano da campanha (rodando + terminadas há pouco). A tela consulta enquanto há alguma rodando. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return NextResponse.json(await listJobs(id));
}
