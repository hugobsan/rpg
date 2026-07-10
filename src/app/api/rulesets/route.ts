import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_RULESET, normalizeRuleset } from "@/lib/ruleset";

export const dynamic = "force-dynamic";

/** GET /api/rulesets?preset=default|naruto — presets de mecânica. */
export async function GET(req: NextRequest) {
  const preset = req.nextUrl.searchParams.get("preset") || "default";
  if (preset === "naruto") {
    const raw = fs.readFileSync(path.join(process.cwd(), "naruto-ruleset.json"), "utf-8");
    return NextResponse.json(normalizeRuleset(JSON.parse(raw)));
  }
  return NextResponse.json(DEFAULT_RULESET);
}
