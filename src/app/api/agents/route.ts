import { NextResponse } from "next/server";
import { listAgents } from "@/lib/agents";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await listAgents());
}
