import { NextRequest, NextResponse } from "next/server";
import { q } from "@/lib/db";
import { getAgent } from "@/lib/agents";
import { getModelPricing, getSources, OPENROUTER } from "@/lib/openrouter";
import { modelVoices } from "@/lib/tts";

export const dynamic = "force-dynamic";

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const current = await getAgent(id);
  const body = await req.json();
  const model = String(body.model ?? current.model).trim();
  const source = String(body.source ?? current.source);
  const or = source === OPENROUTER;
  if (!or && !(await getSources()).some((s) => s.id === source))
    return NextResponse.json({ error: `A fonte "${source}" não existe. Escolha outra fonte.` }, { status: 400 });
  if (!model) return NextResponse.json({ error: "Informe o modelo." }, { status: 400 });
  // no OpenRouter, valida o modelo no catálogo e guarda o preço atual; outras fontes não informam preço
  let pricing = null;
  if (or) {
    try {
      pricing = await getModelPricing(model);
    } catch (e) {
      return NextResponse.json(
        { error: `Não foi possível consultar o catálogo do OpenRouter: ${e instanceof Error ? e.message : e}` },
        { status: 502 }
      );
    }
    if (!pricing)
      return NextResponse.json(
        { error: `Modelo "${model}" não existe no catálogo do OpenRouter. Escolha um id da lista.` },
        { status: 400 }
      );
  }
  // agente Voz: as vozes padrão precisam existir no modelo escolhido (quando o catálogo lista as vozes)
  if (id === "voice") {
    const voices = await modelVoices(model, source).catch(() => null);
    const p = body.params ?? current.params;
    const bad = voices?.length
      ? [p.maleVoice, p.femaleVoice].map((v) => String(v ?? "")).find((v) => !voices.includes(v))
      : undefined;
    if (bad !== undefined)
      return NextResponse.json(
        { error: `A voz "${bad || "(vazia)"}" não existe em ${model}. Escolha as vozes padrão de novo.` },
        { status: 400 }
      );
  }
  await q(
    `UPDATE agents SET name=$1, description=$2, model=$3, temperature=$4,
     max_tokens=$5, web_search=$6, system_prompt=$7, params=$8, pricing=$9, source=$11, updated_at=now()
     WHERE id=$10`,
    [
      body.name ?? current.name,
      body.description ?? current.description,
      model,
      body.temperature ?? current.temperature,
      body.max_tokens ?? current.max_tokens,
      or && (body.web_search ?? current.web_search), // busca web (:online) só existe no OpenRouter
      body.system_prompt ?? current.system_prompt,
      JSON.stringify(body.params ?? current.params),
      JSON.stringify(pricing),
      id,
      source,
    ]
  );
  return NextResponse.json(await getAgent(id));
}
