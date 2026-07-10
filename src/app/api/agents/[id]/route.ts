import { NextRequest, NextResponse } from "next/server";
import { q } from "@/lib/db";
import { getAgent } from "@/lib/agents";

export const dynamic = "force-dynamic";

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const current = await getAgent(id);
  const body = await req.json();
  await q(
    `UPDATE agents SET name=$1, description=$2, model=$3, temperature=$4,
     max_tokens=$5, web_search=$6, system_prompt=$7, params=$8, updated_at=now()
     WHERE id=$9`,
    [
      body.name ?? current.name,
      body.description ?? current.description,
      body.model ?? current.model,
      body.temperature ?? current.temperature,
      body.max_tokens ?? current.max_tokens,
      body.web_search ?? current.web_search,
      body.system_prompt ?? current.system_prompt,
      JSON.stringify(body.params ?? current.params),
      id,
    ]
  );
  return NextResponse.json(await getAgent(id));
}
