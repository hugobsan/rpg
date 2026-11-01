/**
 * Verificação de missões, eventos e prazos: cria uma campanha temporária e chama as
 * ferramentas do Mestre direto (sem IA). Rodar: npx tsx scripts/objectives-check.ts
 */
import assert from "node:assert/strict";
import { pool, q } from "../src/lib/db";
import { executeGmTool, GM_TOOLS, ToolContext } from "../src/lib/tools";
import { formatRemaining, getObjectives, objectivesPromptBlock } from "../src/lib/objectives";
import { restoreSnapshot, takeSnapshot } from "../src/lib/turnSnapshot";
import { toMinutes } from "../src/lib/clock";
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
    assert.match(await run("update_objective", { objective: "Encontro", status: "concluido" }), /não volta/);

    await restoreSnapshot(id);
    assert.equal((await byTitle("Encontro")).status, "aberto", "gerar novamente devolve o objetivo aberto");

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

    console.log("ok: prazos relativo/absoluto, vencer ao avançar, concluir, contexto e gerar novamente");
  } finally {
    await q(`DELETE FROM campaigns WHERE id = $1`, [id]);
    await pool().end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
