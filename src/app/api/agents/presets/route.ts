import { NextRequest, NextResponse } from "next/server";
import { setSetting } from "@/lib/db";
import { PRESET_FIXED, type AgentPreset, type PresetEntry } from "@/lib/agentPresets";

export const dynamic = "force-dynamic";

/** PUT { presets } → grava a lista inteira (a tela cria, atualiza e exclui). Aplicar é o PUT de cada agente. */
export async function PUT(req: NextRequest) {
  const body = await req.json();
  if (!Array.isArray(body.presets)) return NextResponse.json({ error: "Lista de presets inválida." }, { status: 400 });
  const presets: AgentPreset[] = body.presets.map((p: AgentPreset) => ({
    id: String(p.id).slice(0, 60),
    name: String(p.name ?? "").trim().slice(0, 60) || "Preset",
    agents: Object.fromEntries(
      Object.entries((p.agents ?? {}) as Record<string, PresetEntry>)
        .filter(([id, e]) => !PRESET_FIXED.includes(id) && e?.source && e?.model)
        .map(([id, e]) => [id, {
          source: String(e.source),
          model: String(e.model),
          ...(e.complexModel !== undefined && { complexModel: String(e.complexModel) }),
          cache: !!e.cache,
          web_search: !!e.web_search,
        }])
    ),
  }));
  await setSetting("agentPresets", presets);
  return NextResponse.json(presets);
}
