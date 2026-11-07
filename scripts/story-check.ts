/**
 * Campanha como estado (src/lib/story.ts) sem IA: a rede é desligada (fetch falha), então o Diretor e o Roteirista caem
 * no fallback por código e o Jev responde "não". Confere:
 *  - gatilhos (beat anterior, dia, relógio, pergunta narrativa) e o tick de relógios por dia e por cena;
 *  - beat obrigatório vencido vira perdido + notícia pública, e a missão aberta do jogador continua aberta (bug #785);
 *  - o ativo nunca é perdido pelo prazo; beat seguinte que dispara fecha o ativo; arco acabado abre o próximo;
 *  - validação do Roteirista: rejeita "Hugo é forçado a usar um poder" e aceita um arco bom;
 *  - fallback do cânone com references/naruto/01-pais-das-ondas.md (≥ 4 beats) e arco genérico;
 *  - cartão de fallback, beat com recompensa vira missão (state.play) e "done" do Narrador conclui e paga;
 *  - foto do turno e "gerar novamente" com arcos, beats, relógios, ganchos e state.play.
 * Campanha temporária, apagada no fim. Rodar: npx tsx scripts/story-check.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { q, pool } from "../src/lib/db";
import { normalizeRuleset } from "../src/lib/ruleset";
import { restoreSnapshot, takeSnapshot } from "../src/lib/turnSnapshot";
import { validateEffects } from "../src/lib/contracts";
import { getObjectives } from "../src/lib/objectives";
import {
  advanceStory, afterTurn, agendaSize, canonPlan, cardBlock, demandsPcAct, fallbackCard, genericPlan, getPlay, isWeakModel, loadStory,
  narrativeCandidates, parseCanon, pickCanonFile, prepareScene, savePlan, sid, stepStory, triggerMet, validatePlan, writeArc,
  type BeatRow, type Story,
} from "../src/lib/story";
import type { Campaign, Character, Scene } from "../src/lib/types";
import type { ToolContext } from "../src/lib/tools";

// sem rede: nenhum modelo é chamado de verdade
globalThis.fetch = (async () => {
  throw new Error("rede desligada no story-check");
}) as typeof fetch;

let n = 0;
const ok = (msg: string) => (n++, console.log(`ok: ${msg}`));

// ---------- puro ----------
const beat = (id: string, o: Partial<BeatRow> = {}): BeatRow => ({
  id, campaign_id: "c", arc_id: "A", ord: 0, title: id, situation: `o mundo faz ${id}`, npcs: [], location: "", trigger: {}, due_minute: null,
  required: false, fallback: `${id} acontece fora de cena`, foreshadow: "", clue: null, reward: null, status: "pending", resolved_at: null, ...o,
});
const story = (beats: BeatRow[], extra: Partial<Story> = {}): Story => ({
  arcs: [{ id: "A", campaign_id: "c", ord: 0, kind: "main", title: "Arco", premise: "", stakes: "s", status: "active", canon_ref: null }],
  beats, clocks: [], hooks: [], ...extra,
});
const day = (d: number, h = 9) => (d - 1) * 1440 + h * 60;

function pure() {
  const s = story(
    [
      beat("b1", { status: "done" }),
      beat("b2", { ord: 1, trigger: { after_beat: "b1", day_gte: 3 } }),
      beat("b3", { ord: 2, trigger: { clock: { id: "k", gte: 2 } } }),
      beat("b4", { ord: 3, trigger: { narrative: "Hugo chegou à ponte?" } }),
    ],
    { clocks: [{ id: "k", campaign_id: "c", arc_id: "A", name: "Gatō aperta", segments: 4, filled: 1, tick: ["day"], on_full_beat: null }] }
  );
  assert.equal(triggerMet(s.beats[1], s, 2), false, "dia 2 < day_gte 3");
  assert.equal(triggerMet(s.beats[1], s, 3), true, "beat anterior feito + dia 3");
  assert.equal(triggerMet(s.beats[2], s, 1), false, "relógio em 1 < 2");
  assert.equal(triggerMet(s.beats[3], s, 1), false, "narrativo sem o sim do Jev");
  assert.equal(triggerMet(s.beats[3], s, 1, new Set(["b4"])), true, "narrativo com o sim");
  assert.deepEqual(narrativeCandidates(s, 1).map((b) => b.id), ["b4"], "só o narrativo pronto vai ao Jev");
  ok("gatilhos: beat anterior, dia, relógio, pergunta narrativa");

  // tick: 1 dia enche o relógio de 1 para 2 e libera b3; b2 libera no dia 3
  const r = stepStory(s, { now: day(3), days: 1, scenes: 0 });
  assert.equal(r.story.clocks[0].filled, 2);
  assert.deepEqual(r.readied.map((b) => b.id).sort(), ["b2", "b3"]);
  const sc = stepStory(story([], { clocks: [{ ...s.clocks[0], tick: ["scene"], filled: 0 }] }), { now: day(1), days: 5, scenes: 2 });
  assert.equal(sc.story.clocks[0].filled, 2, "relógio de cena não anda por dia");
  // cheio dispara on_full_beat mesmo sem gatilho cumprido
  const full = stepStory(story([beat("x", { trigger: { day_gte: 99 } })], { clocks: [{ ...s.clocks[0], filled: 3, on_full_beat: "x" }] }), { now: day(1), days: 1, scenes: 0 });
  assert.deepEqual([full.filled.length, full.story.beats[0].status], [1, "ready"]);
  ok("relógios: enchem por dia e por cena; cheio dispara o beat");

  // vencidos: obrigatório vira notícia, opcional some calado, ativo nunca é perdido pelo prazo
  const due = story([
    beat("req", { required: true, due_minute: day(2, 23), status: "ready" }),
    beat("opt", { ord: 1, due_minute: day(2, 23) }),
    beat("act", { ord: 2, due_minute: day(2, 23), status: "active" }),
  ]);
  const m = stepStory(due, { now: day(3), days: 1, scenes: 0 });
  assert.deepEqual(m.story.beats.map((b) => b.status), ["missed", "missed", "active"]);
  assert.deepEqual(m.missed.map((b) => b.id), ["req"], "só o obrigatório vira notícia");
  // parado 2 dias depois do prazo, o ativo fecha (o mundo seguiu)
  assert.equal(stepStory(due, { now: day(6), days: 0, scenes: 0 }).story.beats[2].status, "done");
  ok("vencidos: obrigatório perdido + notícia, opcional calado, ativo protegido");

  // beat seguinte dispara: o ativo fecha; arco sem nada aberto abre o próximo
  const chain = story([beat("a1", { status: "active" }), beat("a2", { ord: 1, trigger: { day_gte: 2 } })], {
    arcs: [
      { id: "A", campaign_id: "c", ord: 0, kind: "main", title: "1", premise: "", stakes: "", status: "active", canon_ref: null },
      { id: "B", campaign_id: "c", ord: 1, kind: "main", title: "2", premise: "", stakes: "", status: "pending", canon_ref: null },
    ],
  });
  chain.beats.push(beat("b1", { arc_id: "B" }));
  const c1 = stepStory(chain, { now: day(2), days: 1, scenes: 0 });
  assert.deepEqual([c1.closed.map((b) => b.id), c1.story.beats[0].status, c1.story.beats[1].status], [["a1"], "done", "ready"]);
  c1.story.beats[1].status = "done";
  const c2 = stepStory(c1.story, { now: day(2), days: 0, scenes: 0 });
  assert.deepEqual(c2.story.arcs.map((a) => a.status), ["done", "active"]);
  assert.equal(c2.story.beats[2].status, "ready", "o 1º beat do arco novo fica pronto");
  ok("beat seguinte fecha o ativo; arco acabado abre o próximo");

  // Roteirista: "Hugo é forçado a usar um poder" sai; arco bom passa
  assert.ok(demandsPcAct("Hugo é forçado a usar um poder desconhecido diante do Hokage.", "Hugo Barbosa"));
  assert.ok(!demandsPcAct("O selo no braço de Hugo brilha quando Kakashi usa o Sharingan perto dele.", "Hugo Barbosa"), "o mundo agindo com ele passa");
  const good = {
    arc: { title: "A ponte de Tazuna", premise: "Gatō quer a ponte parada.", stakes: "O País das Ondas continua refém de Gatō." },
    beats: [
      { title: "O cliente mente", situation: "Tazuna pede escolta e esconde que é caçado.", cast: ["Tazuna"], dueDay: 2, required: true, fallback: "Outra equipe leva Tazuna.", reward: { pay: 30000, xp: "media" } },
      { title: "Emboscada", situation: "Os Irmãos Demônio atacam na estrada.", trigger: { afterBeat: 0 }, dueDay: 3, required: true, fallback: "Kakashi derrota os irmãos sem o jogador." },
      { title: "Zabuza", situation: "Zabuza surge na névoa e exige Tazuna.", dueDay: 4, required: true, fallback: "Kakashi enfrenta Zabuza; Haku leva o corpo." },
      { title: "A vila sem esperança", situation: "Inari diz que heróis morrem e Gatō cobra mais impostos.", trigger: { clock: { name: "Gatō aperta", gte: 2 } } },
      { title: "Haku na floresta", situation: "Um jovem colhe ervas e pergunta se alguém tem algo a proteger.", trigger: { narrative: "Alguém treina na floresta?" } },
      { title: "Ataque à casa", situation: "Capangas de Gatō invadem a casa de Tsunami.", dueDay: 6 },
      { title: "A ponte", situation: "Zabuza e Haku atacam na ponte inacabada.", dueDay: 7, required: true, fallback: "A batalha na ponte acontece; Haku e Zabuza morrem." },
      { title: "O fim de Gatō", situation: "Gatō chega com mercenários para matar todos.", dueDay: 8 },
      { title: "Errado", situation: "Hugo é forçado a usar um poder", dueDay: 8 },
    ],
    clocks: [{ name: "Gatō aperta", segments: 4, tick: ["day"], onFullBeat: 5 }],
    hooks: [{ text: "O homem pálido do sonho", beat: 2 }],
  };
  const v = validatePlan(good, { player: "Hugo", day: 1 });
  assert.ok(v.plan, "arco bom passa");
  assert.equal(v.plan!.beats.length, 8, "o beat que exige ato do jogador sai");
  assert.ok(v.errors.some((e) => /exige ato de Hugo/.test(e)), "o erro volta na nova tentativa");
  assert.deepEqual([v.plan!.beats[1].after, v.plan!.beats[2].after, v.plan!.beats[3].clock?.index], [0, 1, 0], "sem gatilho = depois do anterior");
  assert.deepEqual(v.plan!.beats[0].reward, { pay: 30000, xp: "media" });
  assert.equal(v.plan!.beats[5].dueDay, 6);
  assert.equal(v.plan!.clocks[0].onFullBeat, 5);
  const bad = validatePlan({ arc: { title: "x" }, beats: good.beats.slice(0, 3).concat([{ title: "Só", situation: "Hugo precisa salvar a vila sozinho." } as never]) }, { player: "Hugo", day: 1 });
  assert.equal(bad.plan, null, "menos de 4 beats = sem plano (nova tentativa ou fallback)");
  const req = validatePlan({ arc: { title: "x" }, beats: [{ title: "a", situation: "b", required: true }, ...good.beats.slice(1, 4)] }, { player: "Hugo", day: 1 });
  assert.ok(req.errors.some((e) => /required precisa de dueDay e fallback/.test(e)) && !req.plan!.beats[0].required, "obrigatório sem fallback vira opcional e avisa");
  ok("Roteirista: rejeita ato do jogador, aceita arco bom, conserta campo a campo");

  // fallback do cânone e genérico
  const text = fs.readFileSync("references/naruto/01-pais-das-ondas.md", "utf-8");
  const eps = parseCanon(text).episodes;
  assert.ok(eps.length >= 19 && eps[0].title.startsWith("Enter: Naruto"), `episódios: ${eps.length}`);
  const cp = canonPlan("01-pais-das-ondas.md", text, { day: 1 })!;
  assert.ok(cp.beats.length >= 4 && cp.beats.length <= 12, `${cp.beats.length} beats`);
  assert.ok(cp.beats.every((b) => b.fallback && b.dueDay >= 2), "todo beat tem prazo e fallback");
  assert.ok(cp.beats.some((b) => b.required) && cp.beats.slice(1).every((b, i) => b.after === i), "marcos obrigatórios e cadeia");
  assert.ok(cp.beats.every((b) => !demandsPcAct(b.situation, "Hugo")));
  assert.equal(cp.canonRef, "01-pais-das-ondas.md#ep");
  const more = canonPlan("01-pais-das-ondas.md", text, { day: 13, from: 12 })!;
  assert.deepEqual([more.ordFrom, more.beats[0].title], [12, eps[12].title], "estende do episódio seguinte");
  assert.equal(pickCanonFile(["01-pais-das-ondas.md", "02-exame-chunin.md"], ["Prólogo e País das Ondas", "Exame Chunin"], "Konoha, véspera do exame chunin"), "02-exame-chunin.md");
  assert.equal(pickCanonFile(["01-pais-das-ondas.md", "02-exame-chunin.md"], ["a", "b"], "algum lugar"), "01-pais-das-ondas.md");
  assert.equal(pickCanonFile(["01-pais-das-ondas.md", "03-invasao-de-konoha.md", "12-pain-assault.md"], ["Prólogo", "Invasão de Konoha", "Ataque de Pain a Konoha"], "Konoha, logo depois da formatura"), "01-pais-das-ondas.md", "palavra de vários arquivos não decide");
  const gp = genericPlan("Uma vila de pescadores", "Vila do Porto", 1);
  assert.ok(gp.beats.length >= 4 && gp.beats.some((b) => b.reward) && validatePlan({ ...gp, beats: gp.beats }, { player: "Hugo", day: 1 }).plan);
  ok("fallback: cânone (01-pais-das-ondas, ≥ 4 beats, estende) e arco genérico");

  // cartão de fallback e bloco do Narrador
  const cs = story([beat("rdy", { status: "ready", required: true, npcs: ["Tazuna"], clue: "a poça seca", title: "Emboscada" }), beat("nxt", { ord: 1, foreshadow: "névoa fora de época" })], {
    hooks: [{ id: 1, campaign_id: "c", text: "o homem pálido", beat_id: null, status: "open", last_touched_scene: 1 }],
  });
  const card = fallbackCard(cs, ["Tazuna", "Kakashi"], 9, 3);
  assert.deepEqual([card.beatId, card.clue, card.foreshadow, card.hooks, card.npcIntents.map((x) => x.name), card.exits.length], ["rdy", "a poça seca", "névoa fora de época", ["o homem pálido"], ["Tazuna"], 3]);
  const block = cardBlock(card, cs.beats[0], ["A escolta seguiu sem você"]);
  assert.ok(/Pista para entregar/.test(block) && /Plante de passagem/.test(block) && /"op":"done"/.test(block) && /Aconteceu fora de cena/.test(block));
  assert.ok(!/fora de cena: rdy acontece/.test(block), "o fallback do beat não vaza no cartão");
  ok("cartão de fallback e bloco do Narrador");

  // "beat" do bloco de efeitos só vale para o beat em jogo
  const ctx = { player: "Hugo", abilities: [], items: [], npcs: [], missions: [], money: null, resourceWords: [], activeBeat: "3f9a1c2e-0000-4000-8000-000000000000" };
  assert.deepEqual(validateEffects({ beat: { op: "done", id: "3f9a1c2e" } }, ctx).effects.beat, { op: "done", id: ctx.activeBeat });
  assert.equal(validateEffects({ beat: { op: "done", id: "ffffffff" } }, ctx).effects.beat, null);
  assert.equal(validateEffects({ beat: { op: "done", id: "3f" } }, ctx).effects.beat, null, "id curto demais");
  ok("beat no bloco de efeitos validado contra o cartão");

  assert.deepEqual(["x/y:free", "google/gemini-3.5-flash", "openai/gpt-6-luna", "openai/gpt-5-mini", "anthropic/claude-haiku-5.5"].map(isWeakModel), [true, true, true, true, true]);
  assert.deepEqual(["google/gemini-3.5-pro", "deepseek/deepseek-v4-pro", "anthropic/claude-sonnet-5.5"].map(isWeakModel), [false, false, false]);
  ok("modelo fraco por nome (gemini não é mini)");
}

// ---------- banco ----------
async function db() {
  const rs = normalizeRuleset(JSON.parse(fs.readFileSync("naruto-ruleset.json", "utf-8")));
  const [c] = await q<{ id: string }>(
    `INSERT INTO campaigns (name, ruleset, state) VALUES ('[teste-história]', $1, $2) RETURNING id`,
    [JSON.stringify(rs), JSON.stringify({ startingPoint: "Konoha, logo depois da formatura", clock: { minutes: day(1) } })]
  );
  const id = c.id;
  try {
    const [scene] = await q<Scene>(`INSERT INTO scenes (campaign_id, seq, mode, location) VALUES ($1, 1, 'exploration', 'Konoha') RETURNING *`, [id]);
    await q(`INSERT INTO characters (campaign_id, kind, name, sheet) VALUES ($1, 'player', 'Hugo', $2), ($1, 'npc', 'Tazuna', '{}')`, [
      id, JSON.stringify({ attributes: {}, resources: {}, abilities: [], inventory: [], xp: 0, extra: {}, money: 0, rank: "genin" }),
    ]);
    const [campaign] = await q<Campaign>(`SELECT * FROM campaigns WHERE id = $1`, [id]);
    const ctx: ToolContext = { campaign, scene, emit: () => {} };
    const chars = await q<Character>(`SELECT * FROM characters WHERE campaign_id = $1`, [id]);

    // Roteirista sem rede: fallback do cânone pelo ponto de partida (01, um beat por episódio), arco ativo
    const w = await writeArc(id, "new");
    let s = await loadStory(id);
    assert.equal(w.source, "canon");
    assert.ok(s.arcs[0].status === "active" && s.arcs[0].canon_ref === "01-pais-das-ondas.md#ep" && s.beats.length >= 4);
    ok(`writeArc sem rede → fallback do cânone (${s.beats.length} beats de "${w.title}")`);

    // plano com missão e relógio por cima (arco pendente, depois do cânone), e um 2º arco do zero para o teste de missão
    await q(`DELETE FROM arcs WHERE campaign_id = $1`, [id]);
    const v = validatePlan(
      {
        arc: { title: "Escolta", premise: "p", stakes: "Tazuna chega vivo ou não" },
        beats: [
          { title: "O pedido de Tazuna", situation: "Tazuna pede escolta até o País das Ondas.", cast: ["Tazuna"], dueDay: 3, required: true, fallback: "Outra equipe parte com Tazuna.", reward: { pay: 5000, xp: "pequena" } },
          { title: "Emboscada", situation: "Ninjas de Kiri atacam na estrada.", trigger: { day: 2 }, dueDay: 2, required: true, fallback: "A escolta é atacada sem você; Tazuna se fere." },
          { title: "Névoa", situation: "Zabuza aparece na névoa.", dueDay: 9 },
          { title: "Ponte", situation: "A ponte é atacada.", dueDay: 10 },
          { title: "Gatō", situation: "Gatō chega com mercenários.", dueDay: 11 },
          { title: "Festa", situation: "A vila batiza a ponte.", dueDay: 12 },
        ],
        clocks: [{ name: "Gatō aperta", segments: 3, tick: ["day", "scene"] }],
        hooks: [{ text: "o homem pálido", beat: 2 }],
      },
      { player: "Hugo", day: 1 }
    );
    await savePlan(id, v.plan!, 1, chars);
    s = await loadStory(id);
    const [b0, b1] = s.beats;
    assert.deepEqual([s.arcs[0].status, b1.trigger.day_gte, s.beats[2].trigger.after_beat, s.hooks[0].beat_id], ["active", 2, b1.id, s.beats[2].id]);

    // missão aberta do jogador (de fora da história) com prazo longe
    await q(`UPDATE campaigns SET state = state || $1::jsonb WHERE id = $2`, [
      JSON.stringify({ objectives: [{ id: "o1", title: "Ajudar o Teuchi", kind: "missao", description: "", status: "aberto", createdAt: 0 }] }),
      id,
    ]);
    ctx.campaign = (await q<Campaign>(`SELECT * FROM campaigns WHERE id = $1`, [id]))[0];

    // 1º turno: b0 pronto → Diretor sem rede → cartão de fallback com b0 → ativa e vira missão (state.play)
    const prep = await prepareScene(ctx, chars, new Set());
    assert.equal(prep.card?.source, "fallback");
    assert.equal(prep.beat?.id, b0.id, "o beat do cartão fica em jogo");
    assert.ok(prep.block.includes(`"${sid(b0.id)}"`));
    let play = getPlay(ctx.campaign.state);
    const objs = getObjectives(ctx.campaign.state);
    const o2 = objs.find((o) => o.title === "O pedido de Tazuna");
    assert.deepEqual([play.mode, play.beatId, play.objectiveId, o2?.status, o2?.pay, o2?.deadlineMinutes], ["mission", b0.id, o2?.id, "aberto", 5000, undefined]);
    ok("beat com recompensa ativa → missão aberta sem prazo + state.play em missão");

    // foto do turno, depois o tempo pula 3 dias: a emboscada (dia 2) vence fora de cena
    await takeSnapshot(id, "sigo pela estrada");
    await q(`UPDATE campaigns SET state = state || '{"clock":{"minutes":${day(4)}}}'::jsonb WHERE id = $1`, [id]);
    ctx.campaign = (await q<Campaign>(`SELECT * FROM campaigns WHERE id = $1`, [id]))[0];
    const step = await advanceStory(ctx, { clearNews: true });
    s = step.story;
    assert.deepEqual(step.missed.map((b) => b.id), [b1.id], "a emboscada venceu fora de cena");
    assert.equal(s.beats.find((b) => b.id === b0.id)!.status, "active", "o beat em jogo não é perdido pelo prazo");
    const objNow = getObjectives(ctx.campaign.state);
    assert.deepEqual(objNow.map((o) => o.status), ["aberto", "aberto"], "nenhuma missão do jogador perdida");
    assert.deepEqual(ctx.campaign.state.news, ["A escolta é atacada sem você; Tazuna se fere."]);
    const [ev] = await q<{ text: string; public: boolean }>(`SELECT text, public FROM events WHERE campaign_id = $1`, [id]);
    assert.deepEqual(ev, { text: "A escolta é atacada sem você; Tazuna se fere.", public: true }, "o fallback vira evento público");
    assert.equal(s.clocks[0].filled, 3, "3 dias encheram o relógio");
    ok("obrigatório vencido → perdido + notícia + evento público; missão do jogador intacta; relógio encheu");

    // "done" do Narrador: conclui a missão do beat (paga) e volta à exploração; agenda ainda ≥ 4 (sem Roteirista)
    assert.ok(agendaSize(s) >= 4);
    await afterTurn(ctx, { op: "done", id: b0.id });
    play = getPlay(ctx.campaign.state);
    const o2done = getObjectives(ctx.campaign.state).find((o) => o.id === o2!.id)!;
    const [player] = await q<{ sheet: { money: number } }>(`SELECT sheet FROM characters WHERE campaign_id = $1 AND kind = 'player'`, [id]);
    assert.deepEqual([play.mode, o2done.status, player.sheet.money], ["exploration", "concluido", 5000]);
    assert.equal((await loadStory(id)).hooks[0].status, "open");
    ok("Narrador marca o beat feito → missão concluída e paga por código, modo exploração");

    // gerar novamente: volta beats, relógio, ganchos, state.play e notícia
    await restoreSnapshot(id);
    const back = await loadStory(id);
    const [st] = await q<{ state: Record<string, unknown> }>(`SELECT state FROM campaigns WHERE id = $1`, [id]);
    assert.deepEqual(back.beats.slice(0, 2).map((b) => b.status), ["active", "pending"]);
    assert.deepEqual([back.clocks[0].filled, back.hooks.length, getPlay(st.state).mode, (st.state.news as string[]).length], [0, 1, "mission", 0]);
    assert.equal(getObjectives(st.state).find((o) => o.id === o2!.id)?.status, "aberto");
    assert.deepEqual(await q(`SELECT id FROM events WHERE campaign_id = $1`, [id]), [], "o evento público do beat perdido some com a foto");
    ok("foto do turno e gerar novamente com arcos, beats, relógios, ganchos, eventos e state.play");
  } finally {
    await q(`DELETE FROM api_logs WHERE campaign_id = $1`, [id]);
    await q(`DELETE FROM campaigns WHERE id = $1`, [id]);
  }
}

pure();
db()
  .then(() => console.log(`\n${n} verificações ok`))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool().end());
