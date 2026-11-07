import { randomInt } from "node:crypto";
import { getAgent } from "./agents";
import { chat, ChatMessage } from "./openrouter";
import { clockParts, getClock } from "./clock";
import { getTable } from "./table";
import { executeGmTool, loadObjectives, saveObjectives, type ToolContext } from "./tools";
import { getObjectives } from "./objectives";
import { recordFact } from "./knowledge";
import { scribeState, scribeUndo, type ScribeEntry } from "./corrections";
import { emptyEffects, type Effects, type EffectsCtx, parseLooseJson, splitNarration, TIME_SPANS, validateEffects } from "./contracts";
import type { Character, TurnEvent } from "./types";

/**
 * O bloco de efeitos aplicado por código, campo a campo, pelas ferramentas de sempre (as regras continuam valendo:
 * pagamento e XP de missão em objectives, relógio e prazos em saveClock). Cada aplicação vira um registro com o que
 * mudou (corrections.ts): a etiqueta no chat desfaz, como fazia o Escrivão.
 * Ordem: NPC novo antes do elenco; missão antes do relógio (prazo que vence no mesmo turno não derruba a conclusão).
 */
export async function applyEffects(
  ctx: ToolContext,
  fx: Effects,
  opts: { player: Character; messageId: number; audience?: string[] }
): Promise<ScribeEntry[]> {
  const applied: ScribeEntry[] = [];
  // fatos: com a narração (gerar novamente apaga) e, na conversa particular, só o jogador e o NPC ficam sabendo
  ctx.messageId = opts.messageId || undefined;
  ctx.audience = opts.audience;
  const emit = ctx.emit;
  const run = async (name: string, args: Record<string, unknown>) => {
    const chips: Extract<TurnEvent, { type: "tool" }>[] = [];
    ctx.emit = (e) => (e.type === "tool" ? chips.push(e) : emit(e));
    try {
      const before = await scribeState(ctx.campaign.id, args);
      const out = await executeGmTool(name, args, ctx).catch((e) => `Erro: ${e instanceof Error ? e.message : String(e)}`);
      if (/^(Erro|Nada mudou)|não existe|precisa/.test(out)) {
        console.warn(`[efeitos] ${name}: ${out}`);
        return out;
      }
      const undo = await scribeUndo(ctx.campaign.id, before, name, args).catch(() => undefined);
      const scribe = undo && opts.messageId ? { messageId: Number(opts.messageId), index: applied.length } : undefined;
      ctx.emit = emit;
      for (const chip of chips) emit({ ...chip, scribe });
      applied.push({ tool: name, args, summary: chips.map((c) => c.summary).join(" · ") || name, note: `${name} → ${out}`.slice(0, 240), undo });
      return out;
    } finally {
      ctx.emit = emit;
    }
  };

  for (const n of fx.newNpcs)
    await run("create_npc", { name: n.name, gender: n.gender === "m" ? "male" : n.gender === "f" ? "female" : "unknown", brief: n.brief });

  const moved = fx.scene.newScene || (!!fx.scene.location && fx.scene.location !== ctx.scene.location);
  if (moved) await run("set_scene", { newScene: fx.scene.newScene, ...(fx.scene.location && { location: fx.scene.location }), ...(fx.scene.newScene && { title: "" }) });
  if (fx.scene.present) await run("set_scene", { present: fx.scene.present });

  const m = fx.mission;
  if (m?.op === "offer")
    await run("add_objective", { title: m.title, kind: "missao", description: m.title, status: "oferecida", xpSize: m.size || "pequena", ...(m.pay && { pay: m.pay }) });
  else if (m?.op === "accept") await run("update_objective", { objective: m.id, status: "aberto" });
  else if (m?.op === "complete") await run("update_objective", { objective: m.id, status: "concluido" });
  else if (m?.op === "fail") await failMission(ctx, m.id);

  for (const it of fx.items)
    await run(it.qty > 0 ? "add_item" : "remove_item", { character: opts.player.name, name: it.name, qty: Math.abs(it.qty) });
  if (fx.purchase && ctx.campaign.ruleset.currency) {
    const paid = await run("update_money", { character: opts.player.name, amount: -fx.purchase.price, reason: fx.purchase.item });
    if (!/^(Erro|Nada mudou)/.test(paid)) await run("add_item", { character: opts.player.name, name: fx.purchase.item, qty: fx.purchase.qty });
  }

  if (fx.rest !== "none") {
    // regra de descanso da mesa (faixa por recurso); sem ela: leve +15% do máximo, completo enche
    const rule = getTable(ctx.campaign.state).rest?.[fx.rest];
    for (const r of ctx.campaign.ruleset.resources) {
      const pool = opts.player.sheet.resources[r.key];
      const band = rule?.[r.key];
      if (!pool || (rule && !band)) continue;
      const delta = band ? randomInt(band.min, band.max + 1) : fx.rest === "full" ? pool.max : Math.ceil(pool.max * 0.15);
      await run("update_resource", { character: opts.player.name, resource: r.key, delta });
    }
  }

  const span = TIME_SPANS[fx.time];
  const clock = getClock(ctx.campaign.state);
  // ponytail: campanha sem relógio começa no Dia 1, 8h (antes o Mestre definia com set_time)
  if (!clock) await run("set_time", { day: 1, hour: 8 });
  if (span > 0) await run("advance_time", { minutes: span });
  else if (span < 0) await run("set_time", { day: clockParts(getClock(ctx.campaign.state)?.minutes ?? 0).day + 1, hour: 7 });

  // fatos e "contou" por último: testemunha = quem está na cena no fim do turno (depois de cena e elenco)
  for (const f of fx.facts) await run("add_fact", { text: f.text, public: f.public });
  for (const t of fx.told) await run("tell_fact", { fact: t.fact, by: t.by, to: t.to });
  // o que mais a cena viu, sem etiqueta: a compra (o vendedor lembra) e a missão aceita ou cumprida
  const seen: string[] = [];
  if (fx.purchase && applied.some((e) => e.tool === "update_money")) seen.push(`${opts.player.name} comprou ${fx.purchase.qty}x ${fx.purchase.item}`);
  const mission = m && (m.op === "accept" || m.op === "complete") ? getObjectives(ctx.campaign.state).find((o) => o.id === m.id) : undefined;
  if (mission) seen.push(`${opts.player.name} ${m!.op === "accept" ? "aceitou" : "cumpriu"} a missão "${mission.title}"`);
  for (const text of seen)
    await recordFact(ctx.campaign.id, text, { sceneId: ctx.scene.id, messageId: ctx.messageId, minute: getClock(ctx.campaign.state)?.minutes ?? null, witnesses: ctx.audience }).catch((e) =>
      console.warn("[fatos]", e)
    );
  return applied;
}

/** Missão falhou na história: perdida, com a etiqueta. (update_objective não tem esse status: perder é do relógio.) */
async function failMission(ctx: ToolContext, id: string) {
  const list = await loadObjectives(ctx.campaign.id);
  const o = list.find((x) => x.id === id);
  if (!o || (o.status !== "aberto" && o.status !== "oferecida")) return;
  o.status = o.status === "oferecida" ? "cancelado" : "perdido";
  o.closedAt = getClock(ctx.campaign.state)?.minutes ?? 0;
  await saveObjectives(ctx.campaign.id, list);
  ctx.campaign.state = { ...ctx.campaign.state, objectives: list };
  ctx.emit({ type: "tool", name: "objective", summary: `✖ Falhou: ${o.title}` });
  ctx.emit({ type: "state" });
}

/**
 * Anotador: só quando o bloco do Narrador não veio ou não deu para ler (e no fim da conversa particular). Lê o texto e
 * devolve só o bloco de efeitos; uma nova tentativa com o erro; falhou = efeitos vazios (nada inventado).
 */
export async function annotate(campaignId: string, text: string, ctx: EffectsCtx, label = "narração"): Promise<Effects> {
  const agent = await getAgent("scribe").catch((e) => (console.warn("[anotador]", e), null));
  if (!agent) return emptyEffects();
  const messages: ChatMessage[] = [
    { role: "system", content: agent.system_prompt },
    {
      role: "user",
      content: [
        `PERSONAGEM DO JOGADOR: ${ctx.player}`,
        `TÉCNICAS DA FICHA: ${ctx.abilities.join("; ") || "(nenhuma)"}`,
        `INVENTÁRIO: ${ctx.items.join("; ") || "(vazio)"}`,
        `NPCs REGISTRADOS: ${ctx.npcs.join(", ") || "(nenhum)"}`,
        `MISSÕES: ${ctx.missions.map((m) => `[${m.id}] ${m.title} (${m.status})`).join("; ") || "(nenhuma)"}`,
        ctx.money !== null ? `SALDO: ${ctx.money}` : "",
        `\n${label.toUpperCase()}:\n${text.slice(-6000)}`,
      ]
        .filter(Boolean)
        .join("\n"),
    },
  ];
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await chat({
      model: agent.model,
      messages,
      temperature: agent.temperature,
      max_tokens: agent.max_tokens,
      reasoning: agent.params.reasoning as Record<string, unknown> | undefined,
      agentId: "scribe",
      campaignId,
      purpose: attempt ? `anotador: ${label} (nova tentativa)` : `anotador: ${label}`,
    }).catch((e) => (console.warn("[anotador]", e), null));
    if (!r) break;
    const raw = parseLooseJson(splitNarration(r.content).block ?? r.content);
    if (raw) return validateEffects(raw, ctx).effects;
    messages.push(
      { role: "assistant", content: r.content },
      { role: "user", content: "Não deu para ler o JSON. Responda só com o bloco ```efeitos { ... }```, JSON válido." }
    );
  }
  return emptyEffects();
}
