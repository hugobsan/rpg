/**
 * Verificação de missões, eventos e prazos: cria uma campanha temporária e chama as
 * ferramentas do Mestre direto (sem IA). Rodar: npx tsx scripts/objectives-check.ts
 */
import assert from "node:assert/strict";
import { pool, q } from "../src/lib/db";
import { executeGmTool, GM_TOOLS, ToolContext } from "../src/lib/tools";
import { formatRemaining, getObjectives, Objective, objectivesPromptBlock, objectiveXp } from "../src/lib/objectives";
import { DEFAULT_TABLE } from "../src/lib/table";
import { restoreSnapshot, takeSnapshot } from "../src/lib/turnSnapshot";
import { getClock, toMinutes } from "../src/lib/clock";
const getClockMin = (st: Record<string, unknown>) => getClock(st)?.minutes ?? null;
import type { Campaign, Scene, TurnEvent } from "../src/lib/types";

async function main() {
  assert.equal(formatRemaining(40), "vence em 40 min");
  assert.equal(formatRemaining(2 * 1440 + 3 * 60 + 10), "faltam 2 dias e 3 h");
  assert.equal(formatRemaining(5 * 60 + 20), "faltam 5 h e 20 min");

  const [c] = await q<{ id: string }>(
    `INSERT INTO campaigns (name, ruleset, script, state) VALUES ('[teste-objetivos]', '{}', '{"arcs":[]}', '{"hiddenSheetImageId": 7}') RETURNING id`
  );
  const id = c.id;
  const events: TurnEvent[] = [];
  const ctx: ToolContext = {
    campaign: { id, state: { hiddenSheetImageId: 7 }, ruleset: {} } as unknown as Campaign,
    scene: {} as Scene,
    emit: (e) => events.push(e),
  };
  const run = (name: string, args: Record<string, unknown>) => executeGmTool(name, args, ctx);
  const state = async () => (await q<{ state: Record<string, unknown> }>(`SELECT state FROM campaigns WHERE id = $1`, [id]))[0].state;
  const byTitle = async (t: string) => getObjectives(await state()).find((o) => o.title === t)!;
  try {
    // sem relógio: só sem prazo
    assert.match(await run("add_objective", { title: "X", kind: "missao", description: "x", inHours: 2 }), /set_time/);
    assert.match(await run("add_objective", { title: "Diário", kind: "outro", description: "sem prazo" }), /aberto, sem prazo/);

    await run("set_time", { day: 1, hour: 8, minute: 0, reason: "abertura" }); // Dia 1 · 08:00 = 480
    assert.match(await run("add_objective", { title: "Escolta", kind: "missao", description: "levar o Tazuna", inHours: 3 }), /o2/);
    assert.equal((await byTitle("Escolta")).deadlineMinutes, 480 + 180, "prazo relativo");
    await run("add_objective", { title: "Exame", kind: "evento", description: "exame na Academia", day: 2, hour: 9 });
    assert.equal((await byTitle("Exame")).deadlineMinutes, toMinutes(2, 9, 0), "prazo absoluto");
    await run("add_objective", { title: "Encontro", kind: "evento", description: "ponte", hour: 7 }); // 07:00 já passou → amanhã
    assert.equal((await byTitle("Encontro")).deadlineMinutes, toMinutes(2, 7, 0));
    assert.match(await run("add_objective", { title: "Ontem", kind: "outro", description: "", day: 1, hour: 6 }), /depois de agora/);
    assert.match(await run("add_objective", { title: "Escolta", kind: "missao", description: "dup" }), /já existe \[o2\]/);
    // a mesma missão com prefixo de tipo ou pontuação diferente também é repetida (o Escrivão criava "Evento: X" ao lado de "X")
    assert.match(await run("add_objective", { title: "Missão: escolta!", kind: "missao", description: "dup" }), /já existe \[o2\]/);
    // o Escrivão não tira prazo sem anotação de missão do Mestre no turno; com anotação, ou o Mestre fora do jogo, tira
    const scribe = (briefs: number) => (n: string, a: Record<string, unknown>) => executeGmTool(n, a, { ...ctx, scribe: { briefs } });
    assert.match(await scribe(0)("update_objective", { objective: "o2", noDeadline: true }), /^Nada mudou/);
    assert.equal((await byTitle("Escolta")).deadlineMinutes, 480 + 180, "prazo mantido");

    const block = objectivesPromptBlock(getObjectives(await state()), 480);
    assert.match(block, /\[o2\] Missão: Escolta — levar o Tazuna \| prazo: Dia 1 · 11:00 \(faltam 3 h\)/);

    // não vence antes nem no minuto exato do prazo
    let out = await run("advance_time", { minutes: 180, reason: "caminhada" });
    assert.doesNotMatch(out, /PRAZO PERDIDO/);
    assert.equal((await byTitle("Escolta")).status, "aberto");

    // concluir antes do prazo
    events.length = 0;
    assert.match(await run("update_objective", { objective: "Escolta", status: "concluido" }), /concluido/);
    assert.ok(events.some((e) => e.type === "tool" && e.summary.startsWith("✅")));
    assert.ok(events.some((e) => e.type === "state"));

    // mudar o prazo por id
    await run("update_objective", { objective: "o3", inDays: 1 }); // Exame: agora (11:00) + 1 dia
    assert.equal((await byTitle("Exame")).deadlineMinutes, 660 + 1440);

    // "gerar novamente": foto antes do turno, o turno passa do prazo, restaura e volta aberto
    await takeSnapshot(id, "treino até amanhã");
    events.length = 0;
    out = await run("set_time", { day: 2, hour: 8, minute: 0, reason: "dormiu" }); // passa do Encontro (07:00)
    assert.match(out, /PRAZO PERDIDO: "Encontro"/);
    assert.ok(events.some((e) => e.type === "tool" && e.summary === "⌛ Prazo perdido: Encontro"));
    const enc = await byTitle("Encontro");
    assert.equal(enc.status, "perdido");
    assert.equal((await byTitle("Exame")).status, "aberto", "o que não venceu segue aberto");
    assert.equal((await state()).hiddenSheetImageId, 7, "resto do state intacto");
    assert.match(objectivesPromptBlock(getObjectives(await state()), toMinutes(2, 8, 0)), /PERDIDO desde Dia 2 · 07:00: \[o4\] Encontro/);
    await run("advance_time", { minutes: 1, reason: "um instante" });
    assert.match(await run("update_objective", { objective: "Encontro", status: "concluido" }), /não volta/, "perdido antes do instante atual não volta");

    await restoreSnapshot(id);
    assert.equal((await byTitle("Encontro")).status, "aberto", "gerar novamente devolve o objetivo aberto");
    ctx.campaign = { ...ctx.campaign, state: await state() };

    // perdido no mesmo turno em que foi cumprido: o advance_time (anotação) roda antes do Escrivão e passa do prazo;
    // o Escrivão ainda conclui, porque a perda é do instante atual
    await run("add_objective", { title: "Ajudar no fechamento", kind: "outro", description: "limpar os bancos", inMinutes: 15 });
    out = await run("advance_time", { minutes: 45, reason: "limpeza" });
    assert.match(out, /PRAZO PERDIDO: "Ajudar no fechamento"/);
    assert.match(await run("update_objective", { objective: "Ajudar no fechamento", status: "concluido" }), /concluido/);
    assert.equal((await byTitle("Ajudar no fechamento")).status, "concluido", "cumprido no mesmo turno vale");

    // treino longo (ferramenta train do outro agente, se já existir) passa do prazo
    if (GM_TOOLS.some((t) => t.function.name === "train")) {
      const { blankSheet, normalizeRuleset } = await import("../src/lib/ruleset");
      const fs = await import("node:fs");
      const rs = normalizeRuleset(JSON.parse(fs.readFileSync("naruto-ruleset.json", "utf8")));
      const sheet = blankSheet(rs);
      await q(`INSERT INTO characters (campaign_id, kind, name, sheet) VALUES ($1, 'player', 'Hugo', $2)`, [id, JSON.stringify(sheet)]);
      ctx.campaign = { ...ctx.campaign, ruleset: rs, state: await state() };
      await run("add_objective", { title: "Recado", kind: "outro", description: "avisar o sensei", inHours: 2 });
      out = await run("train", { character: "Hugo", target: rs.attributes[0].key, hours: 4, note: "treino pesado" });
      assert.match(out, /PRAZO PERDIDO: "Recado"/, out);
      assert.equal((await byTitle("Recado")).status, "perdido", "treino longo perde o prazo");
    } else console.log("(train ainda não existe: caso do treino pulado)");

    // ---- XP pelo tamanho da missão e missão oferecida ----
    const { blankSheet, normalizeRuleset } = await import("../src/lib/ruleset");
    const fs = await import("node:fs");
    const rs = normalizeRuleset(JSON.parse(fs.readFileSync("naruto-ruleset.json", "utf8"))); // genin 100, ..., jounin 3000, kage 8000
    const sized = (xpSize: Objective["xpSize"], xp?: number) => ({ xpSize, xp }) as Objective;
    assert.equal(objectiveXp(sized("pequena"), rs, DEFAULT_TABLE, 0), 5, "pequena = min% (normal 5) de 100");
    assert.equal(objectiveXp(sized("media"), rs, DEFAULT_TABLE, 0), 10, "media = max%");
    assert.equal(objectiveXp(sized("grande"), rs, DEFAULT_TABLE, 40), 15, "grande = great% (25) dos 60 que faltam");
    assert.equal(objectiveXp(sized("excepcional", 700), rs, DEFAULT_TABLE, 0), 700, "excepcional = valor livre");
    assert.equal(objectiveXp({} as Objective, rs, DEFAULT_TABLE, 0), null, "sem tamanho, sem XP");
    assert.equal(objectiveXp(sized("pequena"), rs, DEFAULT_TABLE, 9000), 250, "último nível: 5% do último intervalo (8000 - 3000)");
    assert.equal(objectiveXp(sized("pequena"), rs, { ...DEFAULT_TABLE, xp: { min: 2, max: 5, great: 12 } }, 90), 1, "mínimo 1");

    const [hasPlayer] = await q(`SELECT 1 FROM characters WHERE campaign_id = $1 AND kind = 'player'`, [id]);
    if (!hasPlayer) await q(`INSERT INTO characters (campaign_id, kind, name, sheet) VALUES ($1, 'player', 'Hugo', $2)`, [id, JSON.stringify(blankSheet(rs))]);
    await q(`UPDATE characters SET sheet = jsonb_set(sheet, '{xp}', '0') WHERE campaign_id = $1 AND kind = 'player'`, [id]);
    const playerXp = async () => (await q<{ xp: number }>(`SELECT (sheet->>'xp')::int AS xp FROM characters WHERE campaign_id = $1 AND kind = 'player'`, [id]))[0].xp;
    ctx.campaign = { ...ctx.campaign, ruleset: rs, state: await state() };

    // oferecida não vence pelo relógio; o título repetido também vale contra ela
    assert.match(await run("add_objective", { title: "Caçar o gato Tora", kind: "missao", description: "achar o gato da esposa do daimyō", status: "oferecida", xpSize: "media", inHours: 1 }), /oferecida/);
    assert.match(await run("add_objective", { title: "Missão: caçar o gato tora", kind: "missao", description: "dup" }), /já existe .* oferecida/);
    assert.match(await run("add_objective", { title: "Pergaminho proibido", kind: "missao", description: "x", xpSize: "excepcional" }), /precisa de xp/);
    await run("add_objective", { title: "Escoltar o Tazuna", kind: "missao", description: "até a Névoa", status: "oferecida", xpSize: "grande" });
    await run("add_objective", { title: "Entregar a carta", kind: "missao", description: "para o Iruka", status: "oferecida", xpSize: "pequena" });
    let block2 = objectivesPromptBlock(getObjectives(await state()), getClockMin(await state()), (o) => objectiveXp(o, rs, DEFAULT_TABLE, 0));
    assert.match(block2, /OFERECIDA, o jogador ainda não aceitou: \[o\d+\] Missão: Caçar o gato Tora .* \| recompensa: ≈ 10 XP/);
    assert.match(block2, /Escoltar o Tazuna .*≈ 25 XP/);
    out = await run("advance_time", { minutes: 120, reason: "espera" });
    assert.doesNotMatch(out, /Caçar o gato/);
    assert.equal((await byTitle("Caçar o gato Tora")).status, "oferecida", "oferecida não vence");

    // aceitar, recusar, concluir direto
    assert.match(await run("update_objective", { objective: "Caçar o gato Tora", status: "aberto", inHours: 5 }), /aberto/);
    assert.equal((await byTitle("Caçar o gato Tora")).status, "aberto");
    assert.match(await run("update_objective", { objective: "Escoltar o Tazuna", status: "cancelado" }), /cancelado/);
    events.length = 0;
    out = await run("update_objective", { objective: "Entregar a carta", status: "concluido" });
    assert.match(out, /deu 5 XP/, out);
    assert.equal(await playerXp(), 5, "concluir direto a oferecida dá a XP");
    assert.ok(events.some((e) => e.type === "tool" && e.summary === "✅ Concluído: Entregar a carta (+5 XP)"));
    assert.ok(events.some((e) => e.type === "tool" && e.summary.includes("+5 XP (total 5) — missão: Entregar a carta")));

    // conclusão com tamanho pelo Escrivão: o grant_xp no mesmo turno é recusado; em outro turno vale
    const sctx: ToolContext = { ...ctx, scribe: { briefs: 0 } };
    out = await executeGmTool("update_objective", { objective: "Caçar o gato Tora", status: "concluido" }, sctx);
    assert.match(out, /deu 10 XP/, out); // 10% dos 95 que faltam = 9,5 → 10
    assert.equal(await playerXp(), 15);
    assert.match(await executeGmTool("grant_xp", { character: "Hugo", amount: 10, reason: "missão" }, sctx), /^Nada mudou: a missão Caçar o gato Tora já deu 10 XP neste turno/);
    assert.equal(await playerXp(), 15, "sem XP em dobro");
    assert.match(await executeGmTool("grant_xp", { character: "Hugo", amount: 3 }, { ...ctx, scribe: { briefs: 0 } }), /18 XP/, "outro turno vale");
    assert.match(await run("grant_xp", { character: "Hugo", amount: 2 }), /20 XP/, "fora do jogo vale");

    // excepcional: xp livre; mudar o tamanho pelo update; perdido no instante atual concluído também dá a XP
    await run("add_objective", { title: "Derrotar o Zabuza", kind: "missao", description: "na ponte", xpSize: "pequena", inMinutes: 10 });
    assert.match(await run("update_objective", { objective: "Derrotar o Zabuza", xpSize: "excepcional", xp: 400 }), /aberto/);
    assert.equal((await byTitle("Derrotar o Zabuza")).xp, 400);
    assert.match(await run("advance_time", { minutes: 30, reason: "luta" }), /PRAZO PERDIDO: "Derrotar o Zabuza"/);
    assert.match(await run("update_objective", { objective: "Derrotar o Zabuza", status: "concluido" }), /deu 400 XP/);
    assert.equal(await playerXp(), 420);
    assert.equal(objectivesPromptBlock([{ ...(await byTitle("Derrotar o Zabuza")), status: "aberto" }], 0, (o) => objectiveXp(o, rs, DEFAULT_TABLE, 0)).includes("≈ 400 XP"), true);

    console.log("ok: prazos relativo/absoluto, vencer ao avançar, concluir, contexto e gerar novamente; XP por tamanho, oferecida, sem XP em dobro");
  } finally {
    await q(`DELETE FROM campaigns WHERE id = $1`, [id]);
    await pool().end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
