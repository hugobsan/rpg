import { NextResponse } from "next/server";
import { listModels } from "@/lib/openrouter";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await listModels());
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "erro" },
      { status: 502 }
    );
  }
}
