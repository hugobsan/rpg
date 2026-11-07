import { randomInt } from "node:crypto";
import { getAgent } from "./agents";
import { chat, ChatMessage } from "./openrouter";
import { rollDice } from "./dice";
import { findAbility } from "./progression";
import { getTable, tableDc } from "./table";
import { executeGmTool, useAbility, type ToolContext } from "./tools";
import {
  dcFor,
  fallbackInterpretation,
  type InterpStep,
  type Interpretation,
  oracle,
  ORACLE_WORDS,
  outcomeOf,
  parseLooseJson,
  PERCEIVED,
  resourceLevel,
  resultLine,
  type StepResult,
  validateInterpretation,
  masteryWord,
} from "./contracts";
import type { Character } from "./types";

/**
 * Intérprete (LLM pequeno) e Resolvedor (código). O Intérprete só traduz o texto livre do jogador em até 3 passos
 * tipados; o Resolvedor decide cada passo com as regras de sempre (use_ability, train, teste de atributo pela tabela
 * única de dificuldade) e devolve o resultado em palavras para o Narrador, que nunca vê número.
 */

const sheetFor = (player: Character, attributes: { key: string; label: string }[], npcs: string[]) =>
  [
    `TÉCNICAS DA FICHA: ${player.sheet.abilities.map((a) => a.name).join("; ") || "(nenhuma)"}`,
    `ATRIBUTOS: ${attributes.map((a) => `${a.key} (${a.label})`).join(", ")}`,
    `INVENTÁRIO: ${player.sheet.inventory.map((i) => i.name).join("; ") || "(vazio)"}`,
    `NPCs EM CENA: ${npcs.join(", ") || "(nenhum)"}`,
  ].join("\n");

/** Texto livre → passos tipados. Uma nova tentativa com o erro; falhou de novo = um passo `other` médio. */
export async function interpret(
  campaignId: string,
  action: string,
  player: Character,
  attributes: { key: string; label: string }[],
  npcs: string[],
  lastNarration: string
): Promise<Interpretation> {
  const agent = await getAgent("interpreter").catch((e) => (console.warn("[intérprete]", e), null));
  if (!agent) return fallbackInterpretation(action);
  const ctx = {
    abilities: player.sheet.abilities.flatMap((a) => [a.name, ...(a.translation ? [a.translation] : [])]),
    attributes: attributes.map((a) => a.key),
    items: player.sheet.inventory.map((i) => i.name),
    npcs,
  };
  const messages: ChatMessage[] = [
    { role: "system", content: agent.system_prompt },
    {
      role: "user",
      content: `${sheetFor(player, attributes, npcs)}\n\nFIM DA ÚLTIMA NARRAÇÃO:\n${lastNarration.slice(-600) || "(nenhuma)"}\n\nAÇÃO DO JOGADOR:\n${action}`,
    },
  ];
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await chat({
      model: agent.model,
      messages,
      temperature: agent.temperature,
      max_tokens: agent.max_tokens,
      reasoning: agent.params.reasoning as Record<string, unknown> | undefined,
      agentId: "interpreter",
      campaignId,
      purpose: attempt ? "intérprete (nova tentativa)" : "intérprete da ação",
    }).catch((e) => (console.warn("[intérprete]", e), null));
    if (!r) break;
    const ok = validateInterpretation(parseLooseJson(r.content), ctx);
    if (ok) return ok;
    messages.push(
      { role: "assistant", content: r.content },
      { role: "user", content: 'Resposta inválida: mande só o JSON {"steps":[...],"declaresOutcome":false}, com 1 a 3 passos.' }
    );
  }
  return fallbackInterpretation(action);
}

// atributo do teste sem técnica: o pedido, senão a média dos atributos do jogador (neutro)
// ponytail: sem mapa abordagem → atributo; entra quando a F4 tiver opções por abordagem
function attrMod(player: Character, mult: number, key?: string): { mod: number; label: string } {
  const vals = Object.values(player.sheet.attributes);
  const v = key && player.sheet.attributes[key] !== undefined ? player.sheet.attributes[key] : vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0;
  return { mod: v * mult, label: key || "atributos" };
}

const costOf = (amount: number, max: number): StepResult["cost"] => (amount <= 0 ? "none" : amount / Math.max(max, 1) > 0.25 ? "heavy" : "light");

/**
 * Resolve os passos em ordem; uma falha interrompe os seguintes. Emite dados e chips como as ferramentas de sempre.
 * Dano: técnica com dano que deu certo rola o dano no alvo registrado; falha contra um alvo, em passo arriscado, custa
 * vida ao jogador (leve em médio, pesado em difícil ou mais).
 */
export async function resolveSteps(ctx: ToolContext, player: Character, steps: InterpStep[]): Promise<StepResult[]> {
  const rs = ctx.campaign.ruleset;
  const mult = rs.attributeMultiplier ?? 1;
  const table = getTable(ctx.campaign.state);
  const hp = rs.resources.find((r) => r.key === "hp") ?? rs.resources[0];
  const out: StepResult[] = [];
  for (const step of steps) {
    let r: StepResult = { intent: step.intent, result: "success", perceived: PERCEIVED.success, cost: "none", resource: null };
    const dc = dcFor(step.difficulty, mult);
    const test = (mod: number, reason: string, cap?: "partial") => {
      const adj = tableDc(table, dc, undefined);
      const roll = { ...rollDice(`1d20${mod >= 0 ? "+" : ""}${mod}`, reason, adj.dc, table.crits), ...adj.dice };
      ctx.emit({ type: "dice", result: roll });
      const res = outcomeOf(roll.total, roll.dc ?? dc, roll.crit);
      return cap && (res === "crit" || res === "success") ? cap : res;
    };

    if (step.kind === "ability" && step.ability) {
      const ability = findAbility(player.sheet, step.ability);
      if (ability) {
        const use = await useAbility(ctx, { character: player.name, ability: ability.name, dc, target: step.target });
        if (use.short) {
          r = { ...r, result: "fail", note: "Faltou energia para a técnica: nada saiu." };
        } else if (use.roll) {
          r.result = outcomeOf(use.roll.total, use.roll.dc ?? dc, use.roll.crit);
        } else r.result = "fail";
        if (use.pool && use.cost) {
          r.cost = use.short ? "none" : costOf(use.cost.amount, use.pool.max);
          r.resource = resourceLevel(use.pool.current, use.pool.max);
          r.resourceLabel = rs.resources.find((x) => x.key === use.cost!.resource)?.label ?? use.cost.resource;
        }
        // dano da técnica no alvo registrado
        if ((r.result === "success" || r.result === "crit") && ability.damage && step.target) {
          const dmg = rollDice(ability.damage, `dano de ${ability.name}`);
          ctx.emit({ type: "dice", result: dmg });
          const hit = await executeGmTool("update_resource", { character: step.target, resource: hp.key, delta: -dmg.total }, ctx).catch(() => "");
          if (hit && !hit.startsWith("Erro")) r.note = `${step.target} sente o golpe.`;
        }
      } else {
        // técnica fora da ficha: no máximo o começo dela
        r.result = test(attrMod(player, mult).mod, `${step.ability} (fora da ficha)`, "partial");
        r.note = "Ele não conhece essa técnica: no máximo um começo, incompleto (pode virar treino).";
      }
    } else if (step.kind === "train" && (step.ability || step.attribute)) {
      const target = step.ability ? findAbility(player.sheet, step.ability)?.name ?? step.ability : step.attribute!;
      const res = await executeGmTool("train", { character: player.name, target, hours: step.hours ?? 2 }, ctx);
      if (res.startsWith("Treino de")) {
        const after = (await refreshed(ctx, player)).sheet;
        const a = findAbility(after, target);
        r.note = a ? `Domínio de ${a.name} agora: ${masteryWord(a.progress ?? 0)}.` : "";
      } else r = { ...r, result: "fail", note: "O treino não rende agora (cansaço ou limite do dia)." };
    } else if (step.kind === "item" && step.item) {
      if (!player.sheet.inventory.some((i) => i.name === step.item)) r = { ...r, result: "fail", note: `Ele não tem ${step.item}.` };
      else r.result = step.difficulty === "trivial" ? "success" : test(attrMod(player, mult, step.attribute).mod, `${step.intent} (${step.item})`);
    } else if (["talk", "move", "wait"].includes(step.kind) && step.difficulty === "trivial") {
      r.result = "success";
    } else if (step.difficulty !== "trivial") {
      const a = attrMod(player, mult, step.attribute);
      r.result = test(a.mod, step.intent);
    }

    // falha arriscada contra alguém: o jogador se machuca
    if (r.result === "fail" && step.target && !["talk", "move", "wait"].includes(step.kind) && step.difficulty !== "trivial" && step.difficulty !== "easy") {
      const pool = (await refreshed(ctx, player)).sheet.resources[hp.key];
      if (pool) {
        const heavy = step.difficulty === "hard" || step.difficulty === "very_hard";
        await executeGmTool("update_resource", { character: player.name, resource: hp.key, delta: -Math.ceil(pool.max * (heavy ? 0.2 : 0.1)) }, ctx);
        const after = (await refreshed(ctx, player)).sheet.resources[hp.key];
        r = { ...r, cost: heavy ? "heavy" : "light", resource: resourceLevel(after.current, after.max), resourceLabel: hp.label };
      }
    }
    r.perceived = PERCEIVED[r.result];
    out.push(r);
    if (r.result === "fail") break;
  }
  return out;
}

// ficha relida (use_ability e train gravam no banco; o objeto do começo do turno fica velho)
async function refreshed(ctx: ToolContext, player: Character): Promise<Character> {
  const { getCharacters } = await import("./engine");
  return (await getCharacters(ctx.campaign.id)).find((c) => c.id === player.id) ?? player;
}

/** Oráculo: d100 contra a chance da categoria (tabela Mythic fixa). Devolve a linha em palavras para o Narrador. */
export function askOracle(q: NonNullable<Interpretation["question"]>): string {
  const ans = oracle(q.likelihood, randomInt(1, 101));
  return `Pergunta ao mundo: ${q.text} → ${ORACLE_WORDS[ans]}.`;
}

/** Bloco RESULTADO DESTE TURNO, em palavras. */
export function resultsBlock(results: StepResult[], total: number, it?: Interpretation, oracleLine?: string): string {
  if (!results.length && !oracleLine) return "";
  return [
    "\n--- RESULTADO DESTE TURNO (já decidido: narre exatamente isto, sem melhorar nem piorar) ---",
    ...results.map(resultLine),
    results.length < total ? "Os passos seguintes não chegaram a acontecer." : "",
    oracleLine ?? "",
    it?.declaresOutcome ? "O jogador escreveu um desfecho na ação: vale o resultado acima, não o que ele escreveu." : "",
  ]
    .filter(Boolean)
    .join("\n");
}
