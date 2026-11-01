/**
 * Verificação do mapa e do palco: funções puras (nomes, layout, palco, bloco do prompt) e,
 * numa campanha temporária, set_scene / update_map / set_stage direto (sem IA), o
 * "gerar novamente" voltando o mapa e o map_brief com o Topógrafo falso (fetch falso, sem rede).
 * Rodar: npx tsx scripts/map-check.ts
 */
import assert from "node:assert/strict";

// rede falsa: só o chat/completions do OpenRouter responde (o Topógrafo); qualquer outra chamada falha
const sent: Record<string, unknown>[] = [];
let reply: Record<string, unknown> = {};
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.endsWith("/chat/completions")) return new Response("sem rede no check", { status: 404 });
  sent.push(JSON.parse(String(init?.body)));
  return Response.json(reply);
}) as typeof fetch;
const call = (name: string, args: Record<string, unknown>, i: number) => ({ id: `c${i}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
import { pool, q } from "../src/lib/db";
import { executeGmTool, GM_TOOLS, ToolContext } from "../src/lib/tools";
import { applyStage, enterPlace, findPlace, getMap, getStage, guessKind, layoutMap, mapFromLocations, mapPromptBlock, MIN_GAP } from "../src/lib/map";
import { restoreSnapshot, takeSnapshot } from "../src/lib/turnSnapshot";
import type { Campaign, Scene, WorldMap } from "../src/lib/types";

const near = (m: WorldMap) => {
  let min = Infinity;
  for (const a of m.places) for (const b of m.places) if (a !== b) min = Math.min(min, Math.hypot(a.x! - b.x!, a.y! - b.y!));
  return min;
};

async function main() {
  // nomes: variações casam, lugares diferentes não
  let m: WorldMap = enterPlace({ places: [], routes: [] }, "Academia Ninja").map;
  assert.equal(findPlace(m, "a Academia")?.name, "Academia Ninja");
  assert.equal(findPlace(m, "Academia Ninja de Konoha")?.name, "Academia Ninja");
  assert.equal(findPlace(m, "ACADÊMIA  ninja!")?.name, "Academia Ninja");
  assert.equal(findPlace(m, "Konoha"), undefined, "a vila não é a academia");
  assert.equal(findPlace(m, "Campo de Treinamento"), undefined);
  m = enterPlace(m, "Academia Ninja de Konoha").map;
  assert.equal(m.places.length, 1, "variação não cria local novo");
  assert.equal(m.places[0].name, "Academia Ninja de Konoha", "o nome mais completo vira o principal");
  assert.deepEqual(m.places[0].aliases, ["Academia Ninja"]);
  assert.equal(m.places[0].visits, 1, "mesmo lugar não conta visita de novo");

  // tipos pelo nome
  assert.equal(guessKind("Floresta da Morte"), "floresta");
  assert.equal(guessKind("Residência de Hugo"), "casa");
  assert.equal(guessKind("Campo de Treinamento da Academia"), "campo");
  assert.equal(guessKind("Ruínas de Uzushio"), "ruina");
  assert.equal(guessKind("Konoha"), undefined);

  // vírgula = dentro de; rota desde o anterior, não entre um lugar e o que o contém
  m = mapFromLocations(["Residência de Hugo, Konoha", "Campo de Treinamento da Academia, Konoha", "Konoha", "Floresta da Morte"]);
  const by = (n: string) => findPlace(m, n)!;
  assert.equal(m.places.length, 4);
  assert.equal(by("Konoha").kind, "regiao");
  assert.equal(by("Residência de Hugo").parent, by("Konoha").id);
  assert.equal(by("Campo de Treinamento").parent, by("Konoha").id);
  assert.equal(by("Konoha").visits, 2, "estar numa casa de Konoha conta como ter estado lá (1) + a chegada direta (1)");
  assert.equal(m.current, by("Floresta da Morte").id);
  const pairs = m.routes.map((r) => [r.from, r.to].map((id) => m.places.find((p) => p.id === id)!.name).join(" → "));
  assert.deepEqual(pairs, ["Residência de Hugo → Campo de Treinamento da Academia", "Konoha → Floresta da Morte"]);
  // o que está dentro fica perto do pai; o resto, fora da região
  const d = (a: string, b: string) => Math.hypot(by(a).x! - by(b).x!, by(a).y! - by(b).y!);
  assert.ok(d("Residência de Hugo", "Konoha") < 1.5);
  assert.ok(d("Floresta da Morte", "Konoha") >= 2.5);
  assert.ok(near(m) >= MIN_GAP - 1e-6, "sem sobreposição");

  // layout estável: local novo não mexe nos antigos; mesma entrada, mesmas posições
  const before = JSON.stringify(m.places.map((p) => [p.x, p.y]));
  const m2 = layoutMap(enterPlace(m, "Torre Hokage, Konoha").map);
  assert.equal(JSON.stringify(m2.places.slice(0, 4).map((p) => [p.x, p.y])), before);
  assert.equal(JSON.stringify(mapFromLocations(["Residência de Hugo, Konoha", "Campo de Treinamento da Academia, Konoha", "Konoha", "Floresta da Morte"])), JSON.stringify(m));
  // muitos locais em sequência: ainda sem sobreposição
  const many = mapFromLocations(Array.from({ length: 30 }, (_, i) => `Lugar ${i}${i % 3 ? ", Cidade " + (i % 4) : ""}`));
  assert.ok(near(many) >= MIN_GAP - 1e-6, `sem sobreposição com 30 locais (${near(many)})`);

  // palco: zonas substituem, atores mudam por nome, remove tira, clear zera
  let st = applyStage(null, {
    zones: [{ name: "ponte", note: "pilares: cobertura" }, { name: "margem norte" }],
    actors: [{ name: "Bandido 1", distance: "perto", stance: "hostil", zone: "margem norte" }, { name: "Kakashi", stance: "aliado" }],
  })!;
  assert.equal(st.actors[1].distance, "medio", "distância padrão");
  st = applyStage(st, { actors: [{ name: "bandido 1", distance: "corpo_a_corpo", cover: "parcial" }, { name: "Kakashi", remove: true }] })!;
  assert.deepEqual(JSON.parse(JSON.stringify(st.actors)), [{ name: "bandido 1", zone: "margem norte", distance: "corpo_a_corpo", stance: "hostil", cover: "parcial" }]);
  assert.equal(st.zones.length, 2);
  assert.equal(applyStage(st, { clear: true }), null);
  assert.match(mapPromptBlock({ places: [], routes: [] }, null, "battle"), /BATALHA SEM PALCO: mande map_brief/);
  assert.equal(mapPromptBlock({ places: [], routes: [] }, null, "exploration"), "");

  // ---------- integração: ferramentas numa campanha temporária ----------
  // no turno o Mestre só tem o map_brief; as ferramentas diretas seguem no executeGmTool (Topógrafo e fora do jogo)
  const names = GM_TOOLS.map((t) => t.function.name);
  assert.ok(names.includes("map_brief") && !names.some((n) => ["update_map", "set_stage", "local_map"].includes(n)));
  // o Topógrafo (agente novo) entra no banco no 1º getAgent; se foi o check que criou, sai no fim (o prompt do código vale depois)
  const [hadSurveyor] = await q(`SELECT 1 FROM agents WHERE id = 'surveyor'`);
  const [c] = await q<{ id: string }>(
    `INSERT INTO campaigns (name, ruleset, script, state) VALUES ('[teste-mapa]', '{}', '{"arcs":[]}', '{"clock":{"minutes":600},"startingPoint":"Após a formatura"}') RETURNING id`
  );
  const id = c.id;
  try {
    // campanha antiga: cenas sem mapa salvo (a de abertura com o ponto de partida não vira lugar)
    await q(
      `INSERT INTO scenes (campaign_id, seq, mode, location, is_current) VALUES ($1, 1, 'exploration', 'Após a formatura', FALSE), ($1, 2, 'exploration', 'Residência de Hugo, Konoha', TRUE)`,
      [id]
    );
    const load = async () => {
      const [campaign] = await q<Campaign>(`SELECT * FROM campaigns WHERE id = $1`, [id]);
      const [scene] = await q<Scene>(`SELECT * FROM scenes WHERE campaign_id = $1 AND is_current`, [id]);
      const events: string[] = [];
      const ctx: ToolContext = { campaign, scene, emit: (e) => e.type === "tool" && events.push(e.summary) };
      return { ctx, events };
    };
    let { ctx } = await load();
    assert.equal(getMap(ctx.campaign.state), null);
    await executeGmTool("set_scene", { location: "Campo de Treinamento 3, Konoha", mode: "battle" }, ctx);
    let map = getMap((await load()).ctx.campaign.state)!;
    assert.deepEqual(map.places.map((p) => p.name), ["Konoha", "Residência de Hugo", "Campo de Treinamento 3"], "mapa das cenas antigas gravado junto");
    assert.equal(map.places[2].discoveredAt, 600);

    ({ ctx } = await load());
    let out = await executeGmTool(
      "update_map",
      { place: "Floresta da Morte", kind: "floresta", from: "Campo de Treinamento 3", direction: "N", distance: "longe", travel: "1 h a pé", description: "Floresta cercada, usada no exame." },
      ctx
    );
    assert.match(out, /a partir daqui: N, longe/);
    map = getMap(ctx.campaign.state)!;
    const camp = findPlace(map, "Campo de Treinamento 3")!, forest = findPlace(map, "Floresta da Morte")!;
    assert.ok(forest.y! - camp.y! > 7 && Math.abs(forest.x! - camp.x!) < 0.01, "dica N/longe vira posição");
    assert.equal(map.routes.find((r) => r.to === forest.id)?.travel, "1 h a pé");
    assert.equal(forest.visits, 0, "conhecido, não visitado");
    // outro nome do mesmo lugar junta os dois
    await executeGmTool("update_map", { place: "Vila da Folha" }, ctx);
    await executeGmTool("update_map", { place: "Konoha", kind: "vila", aka: ["Vila da Folha"] }, ctx);
    map = getMap(ctx.campaign.state)!;
    assert.equal(map.places.filter((p) => p.name === "Konoha" || p.name === "Vila da Folha").length, 1);
    assert.equal(findPlace(map, "Vila Oculta da Folha")?.name, "Konoha");

    // palco em batalha
    await executeGmTool("set_stage", { zones: [{ name: "clareira" }], actors: [{ name: "Ninja renegado", distance: "perto", stance: "hostil" }] }, ctx);
    assert.equal(getStage((await load()).ctx.scene.state)?.actors[0].name, "Ninja renegado");
    const block = mapPromptBlock(getMap(ctx.campaign.state)!, getStage(ctx.scene.state), "battle");
    assert.match(block, /Aqui: Campo de Treinamento 3 \(campo, em Konoha\)/);
    assert.match(block, /Floresta da Morte \(N, longe, 1 h a pé\)/);
    assert.match(block, /Ninja renegado: hostil, perto/);

    // "gerar novamente" volta mapa e palco
    await takeSnapshot(id, "corro para a floresta");
    ({ ctx } = await load());
    await executeGmTool("set_scene", { location: "Floresta da Morte" }, ctx);
    let after = await load();
    assert.equal(findPlace(getMap(after.ctx.campaign.state)!, "Floresta da Morte")!.visits, 1);
    assert.equal(getStage(after.ctx.scene.state), null, "mudou de lugar na mesma cena: o palco sai");
    await restoreSnapshot(id);
    after = await load();
    map = getMap(after.ctx.campaign.state)!;
    assert.equal(map.current, camp.id);
    assert.equal(findPlace(map, "Floresta da Morte")!.visits, 0);
    assert.equal(getStage(after.ctx.scene.state)?.actors.length, 1);

    // map_brief: o Topógrafo falso responde com chamadas; os executores de verdade mudam palco e mapa
    reply = {
      choices: [
        {
          message: {
            content: "",
            tool_calls: [
              call("update_map", { place: "Vila da Névoa", kind: "vila", from: "Campo de Treinamento 3", direction: "S", distance: "muito_longe", travel: "2 dias de barco" }, 1),
              call("set_stage", { zones: [{ name: "ponte" }, { name: "névoa" }], actors: [{ name: "Zabuza", zone: "névoa", distance: "longe", stance: "hostil" }, { name: "Ninja renegado", remove: true }] }, 2),
              call("local_map", { action: "edit", place: "Vila da Névoa", brief: "a ponte caiu" }, 3),
              call("roll_dice", { notation: "1d20" }, 4),
            ],
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0 },
    };
    const brief = "Zabuza recuou para a névoa, longe; o ninja renegado fugiu. O jogador ouviu falar da Vila da Névoa, ao sul, dois dias de barco";
    const { ctx: bctx, events } = await load();
    out = await executeGmTool("map_brief", { brief }, bctx);
    const req = sent.at(-1)!;
    const msgs = req.messages as { role: string; content: string }[];
    assert.deepEqual((req.tools as { function: { name: string } }[]).map((t) => t.function.name), ["update_map", "set_stage", "local_map"]);
    assert.match(msgs[1].content, new RegExp(`BRIEF DO MESTRE: ${brief}`));
    assert.match(msgs[1].content, /PALCO ATUAL:[\s\S]*Ninja renegado: hostil, perto/, "o Topógrafo recebe o palco atual");
    assert.match(msgs[1].content, /Aqui: Campo de Treinamento 3/);
    const now = await load();
    const stage = getStage(now.ctx.scene.state)!;
    assert.deepEqual(stage.actors.map((a) => [a.name, a.distance, a.zone]), [["Zabuza", "longe", "névoa"]], "palco pelo set_stage de verdade");
    assert.deepEqual(stage.zones.map((z) => z.name), ["ponte", "névoa"]);
    map = getMap(now.ctx.campaign.state)!;
    const mist = findPlace(map, "Vila da Névoa")!;
    assert.equal(mist.visits, 0);
    assert.equal(map.routes.find((r) => r.to === mist.id)?.travel, "2 dias de barco");
    assert.match(out, /Mapa: Vila da Névoa/);
    assert.match(out, /ainda não tem mapa 3D|desligou/, "local_map passou pelo executor (sem gerar nada)");
    assert.match(out, /Ferramenta desconhecida: roll_dice/, "o Topógrafo só usa as ferramentas do mapa");
    assert.ok(events.some((e) => e.startsWith("⚔ Palco")) && events.includes("🗺 Vila da Névoa"));
    const [log] = await q<{ purpose: string }>(`SELECT purpose FROM api_logs WHERE campaign_id = $1 AND agent_id = 'surveyor'`, [id]);
    assert.equal(log?.purpose, "map_brief", "a chamada vai para Custos e uso");
    // sem chamadas: só avisa
    reply = { choices: [{ message: { content: "nada" } }] };
    assert.match(await executeGmTool("map_brief", { brief: "nada mudou" }, (await load()).ctx), /nada a mudar/);
    assert.equal(await executeGmTool("map_brief", { brief: " " }, (await load()).ctx), "Informe brief.");
    console.log("map-check: ok");
  } finally {
    await q(`DELETE FROM api_logs WHERE campaign_id = $1`, [id]);
    if (!hadSurveyor) await q(`DELETE FROM agents WHERE id = 'surveyor'`);
    await q(`DELETE FROM campaigns WHERE id = $1`, [id]);
    await pool().end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
