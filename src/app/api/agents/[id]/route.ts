import { NextRequest, NextResponse } from "next/server";
import { q } from "@/lib/db";
import { getAgent } from "@/lib/agents";
import { getModelPricing } from "@/lib/openrouter";
import { modelVoices } from "@/lib/tts";

export const dynamic = "force-dynamic";

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const current = await getAgent(id);
  const body = await req.json();
  const model = body.model ?? current.model;
  // ao salvar, valida o modelo no catálogo do OpenRouter e guarda o preço atual
  let pricing;
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
  // agente Voz: as vozes padrão precisam existir no modelo escolhido (quando o catálogo lista as vozes)
  if (id === "voice") {
    const voices = await modelVoices(model).catch(() => null);
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
     max_tokens=$5, web_search=$6, system_prompt=$7, params=$8, pricing=$9, updated_at=now()
     WHERE id=$10`,
    [
      body.name ?? current.name,
      body.description ?? current.description,
      model,
      body.temperature ?? current.temperature,
      body.max_tokens ?? current.max_tokens,
      body.web_search ?? current.web_search,
      body.system_prompt ?? current.system_prompt,
      JSON.stringify(body.params ?? current.params),
      JSON.stringify(pricing),
      id,
    ]
  );
  return NextResponse.json(await getAgent(id));
}
