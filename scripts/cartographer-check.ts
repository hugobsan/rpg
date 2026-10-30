/**
 * Verificação do Cartógrafo sem IA: validação e limites do spec (lib/mapSpec.ts), expansão,
 * relevo e, numa campanha temporária, o vínculo local ↔ mapa (ids que mudam), remover, as travas
 * do Mestre, o interruptor das Configurações (restaurado no fim) e o bloco do prompt.
 * Rodar: npx tsx scripts/cartographer-check.ts
 */
import assert from "node:assert/strict";
import { pool, q } from "../src/lib/db";
import { executeGmTool, GM_TOOLS, ToolContext } from "../src/lib/tools";
import { listLocalMaps, localMapsPromptBlock, requestLocalMap, saveLocalMap } from "../src/lib/cartographer";
import { expandSpec, groundHeight, LIMITS, normalizeSpec, parseSpecText, type MapSpec } from "../src/lib/mapSpec";
import type { Campaign, Scene, WorldMap } from "../src/lib/types";

const house = [
  { shape: "box", at: [0, 0, 0], size: [6, 4, 6], color: "#c9b28f" },
  { shape: "pyramid", at: [0, 4, 0], size: [7, 3, 7], color: ["#a0442c", "#6b3b2a", "#3f5a7a"] },
];
const base = {
  title: "Vila de teste",
  size: 80,
  ground: { color: "#6b8f4e", relief: 0, hills: [{ at: [20, -20], radius: 10, height: 6 }] },
  parts: { casa: house },
  items: [{ part: "casa", at: [0, 0, 0] }],
  pois: [{ name: "Praça", note: "o centro", at: [0, 0, 0] }],
};

async function main() {
  // ---------- validação ----------
  assert.equal(normalizeSpec(null), null);
  assert.equal(normalizeSpec("mapa"), null);
  assert.equal(normalizeSpec({ title: "vazio", items: [{ shape: "dragao" }] }), null, "nada desenhável");
  const spec = normalizeSpec(base)!;
  assert.equal(spec.parts.casa.length, 2);
  assert.deepEqual(spec.parts.casa[1].colors, ["#a0442c", "#6b3b2a", "#3f5a7a"], "lista de cores vira variação");
  assert.deepEqual(spec.items[0].part, ["casa"]);

  const wild = normalizeSpec({
    size: 9999,
    ground: { color: "verde", heights: [[0, 1, 2], [3, 4], "x", [5, 6, 7, 8]] },
    sky: { color: "accent", fog: 7 },
    parts: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`p${i}`, Array.from({ length: 40 }, () => ({ shape: "box" }))])),
    items: [
      ...Array.from({ length: 400 }, (_, i) => ({ shape: i % 2 ? "cone" : "nada", at: [1e6, -50, "3"], size: [-1, 1e9, 2], color: "javascript:alert(1)", glow: 9, opacity: 0 })),
    ],
    paths: [{ points: [[0, 0]] }, { points: [[0, 0], [10, 10]], width: 999, height: 5 }],
    pois: Array.from({ length: 40 }, (_, i) => ({ name: i ? `P${i}` : "", at: [0, 0, 0] })),
    script: "<script>",
  })!;
  assert.equal(wild.size, LIMITS.size[1], "size limitado");
  assert.equal(wild.ground.color, "#6f7a5c", "cor inválida vira padrão");
  assert.equal(wild.sky.color, "accent", "cor do tema aceita");
  assert.equal(wild.sky.fog, 1);
  assert.equal(Object.keys(wild.parts).length, LIMITS.parts);
  assert.equal(wild.parts.p0.length, LIMITS.partPrims);
  assert.equal(wild.items.length, LIMITS.items / 2, "forma desconhecida sai; lista cortada antes");
  const it = wild.items[0].look!;
  assert.equal(it.color, "#9a948a");
  assert.equal(it.glow, 1);
  assert.equal(it.opacity, 0.15);
  assert.deepEqual(it.size, [0.05, 240, 2], "dimensões dentro da faixa");
  assert.deepEqual(wild.items[0].at, [144, -50, 3], "posição dentro do terreno");
  assert.equal(wild.paths.length, 1, "caminho de 1 ponto sai");
  assert.equal(wild.paths[0].width, 60);
  assert.equal(wild.paths[0].height, 5, "muro");
  assert.equal(wild.pois.length, LIMITS.pois - 1, "POI sem nome sai");
  assert.deepEqual(wild.ground.heights, [[0, 1, 2], [3, 4, 0], [5, 6, 7]], "heightmap regular, linha inválida fora");
  assert.equal("script" in wild, false, "campo desconhecido não passa");

  const extr = normalizeSpec({ items: [{ shape: "extrude", points: [[0, 0], [5, 0]] }, { shape: "extrude", points: [[0, 0], [8, 0], [8, 6], [0, 6]], height: 12, at: [3, 0, 3] }] })!;
  assert.equal(extr.items.length, 1, "contorno com menos de 3 pontos sai");
  assert.deepEqual(extr.items[0].look!.size, [1, 12, 1]);
  const dens = normalizeSpec({ items: [{ shape: "cone", scatter: { at: [0, 0], radius: 10, density: 2 } }, { shape: "cone", scatter: { at: [0, 0], size: [100, 100], density: 99 } }] })!;
  assert.equal(dens.items[0].scatter!.n, Math.round((2 * Math.PI * 100) / 100), "densidade por 100 m² vira n");
  assert.equal(dens.items[1].scatter!.n, LIMITS.repeat, "n limitado");

  // resposta do modelo com cerca e texto em volta
  assert.equal(parseSpecText("Aqui está:\n```json\n" + JSON.stringify(base) + "\n```")?.title, "Vila de teste");
  assert.equal(parseSpecText("{ quebrado"), null);

  // ---------- relevo e expansão ----------
  assert.equal(groundHeight(spec, 20, -20), 6, "topo da colina");
  assert.equal(groundHeight(spec, 0, 0), 0, "fora da colina, plano (relief 0)");
  const hm = normalizeSpec({ ...base, ground: { heights: [[0, 10], [20, 30]], relief: 0 } })!;
  assert.equal(groundHeight(hm, -40, -40), 0);
  assert.equal(groundHeight(hm, 40, 40), 30);
  assert.equal(groundHeight(hm, 0, 0), 15, "bilinear no meio");

  const rows = normalizeSpec({ ...base, items: [{ part: "casa", row: { from: [-30, 0], to: [30, 0], n: 5 } }, { part: "casa", at: [20, 0, -20] }] })!;
  const prims = expandSpec(rows);
  assert.equal(prims.length, 12, "5 casas na fileira + 1 = 12 primitivas");
  assert.deepEqual(prims.slice(0, 2).map((p) => p.at), [[-30, 0, 0], [-30, 4, 0]], "telhado em cima da parede");
  assert.equal(prims[10].at[1], 6, "casa no alto da colina sobe com o relevo");
  assert.ok(prims.every((p) => !("colors" in p)) && prims.filter((p) => p.shape === "pyramid").every((p) => house[1].color.includes(p.color)));
  const turned = expandSpec(normalizeSpec({ ...base, items: [{ part: "casa", at: [0, 0, 0], rot: 90 }], parts: { casa: [{ shape: "box", at: [5, 0, 0] }] } })!);
  assert.deepEqual(turned[0].at.map((v) => Math.round(v)), [0, 0, -5], "peça girada 90° leva o filho de leste para norte (como o three)");
  assert.equal(turned[0].rot[1], 90);
  const sc = normalizeSpec({ ...base, items: [{ part: ["casa"], scatter: { at: [0, 0], size: [40, 40], n: 30, seed: 3 } }] })!;
  assert.deepEqual(expandSpec(sc), expandSpec(sc), "espalhamento determinístico");
  assert.ok(expandSpec(sc).every((p) => Math.abs(p.at[0]) <= 26 && Math.abs(p.at[2]) <= 26), "dentro da área (com a peça girada)");
  const huge = normalizeSpec({ size: 200, parts: { t: Array.from({ length: 12 }, () => ({ shape: "cone" })), e: [{ shape: "extrude", points: [[0, 0], [1, 0], [1, 1]] }] }, items: [...Array.from({ length: 5 }, () => ({ part: "t", scatter: { at: [0, 0], size: [100, 100], n: 120 } })), { part: "e", scatter: { at: [0, 0], radius: 50, n: 120 } }] })!;
  assert.equal(expandSpec(huge).length, LIMITS.prims, "teto de primitivas");
  const ex = normalizeSpec({ size: 200, parts: { e: [{ shape: "extrude", points: [[0, 0], [1, 0], [1, 1]] }] }, items: [{ part: "e", scatter: { at: [0, 0], radius: 50, n: 120 } }] })!;
  assert.equal(expandSpec(ex).length, LIMITS.extrudes, "teto de contornos");

  // ---------- campanha temporária: vínculo, remover, travas, interruptor, prompt ----------
  assert.ok(GM_TOOLS.some((t) => t.function.name === "local_map"));
  const world: WorldMap = {
    places: [
      { id: "l1", name: "Vila da Folha", kind: "vila", visits: 2, x: 0, y: 0 },
      { id: "l2", name: "Ponte do Rio", kind: "estrada", visits: 1, x: 3, y: 0 },
      { id: "l3", name: "Floresta Norte", kind: "floresta", visits: 0, x: 0, y: 4 },
    ],
    routes: [{ from: "l1", to: "l2", travel: "10 min a pé" }],
    current: "l1",
  };
  const [c] = await q<{ id: string }>(
    `INSERT INTO campaigns (name, ruleset, state) VALUES ('[teste-mapas] check', '{"name":"Teste"}', $1) RETURNING id`,
    [JSON.stringify({ map: world })]
  );
  const id = c.id;
  const [ui] = await q<{ value: Record<string, unknown> }>(`SELECT value FROM settings WHERE key = 'ui'`);
  try {
    await q(`INSERT INTO scenes (campaign_id, seq, location) VALUES ($1, 1, 'Vila da Folha')`, [id]);
    const load = async () => {
      const [campaign] = await q<Campaign>(`SELECT * FROM campaigns WHERE id = $1`, [id]);
      const [scene] = await q<Scene>(`SELECT * FROM scenes WHERE campaign_id = $1 AND is_current`, [id]);
      return { campaign, scene, emit: () => {} } as ToolContext;
    };
    const vila = await saveLocalMap(id, world, world.places[0], spec);
    await saveLocalMap(id, world, world.places[1], normalizeSpec({ ...base, title: "Ponte" })!);
    assert.equal(await saveLocalMap(id, world, world.places[0], { ...spec, title: "Vila 2" }), vila, "o mesmo lugar atualiza o mapa dele");
    let maps = await listLocalMaps(id, world);
    assert.deepEqual(maps.map((m) => [m.placeId, m.name, m.pois]).sort(), [["l1", "Vila da Folha", ["Praça"]], ["l2", "Ponte do Rio", ["Praça"]]]);

    // ids mudam: a vila virou l7 (junção, "gerar novamente") e l1 agora é outro lugar; a ponte saiu do mapa
    const moved: WorldMap = {
      places: [
        { id: "l1", name: "Mercado", kind: "bairro", visits: 1 },
        { id: "l7", name: "Vila Oculta da Folha", aliases: ["Vila da Folha"], kind: "vila", visits: 3 },
      ],
      routes: [],
      current: "l7",
    };
    maps = await listLocalMaps(id, moved);
    assert.deepEqual(maps.map((m) => [m.placeId, m.name]), [["l7", "Vila Oculta da Folha"]], "acha pelo nome; não liga ao lugar errado; lugar removido esconde o mapa");

    // remover; editar sem mapa; travas do Mestre
    assert.equal((await requestLocalMap(id, "l2", "remove", "")).ok, true);
    assert.deepEqual((await listLocalMaps(id, world)).map((m) => m.placeId), ["l1"]);
    assert.match((await requestLocalMap(id, "l2", "edit", "a ponte caiu")).message, /ainda não tem mapa/);
    assert.match((await requestLocalMap(id, "l1", "edit", "  ")).message, /Diga o que mudar/);
    assert.match((await requestLocalMap(id, "l1", "generate", "", true)).message, /já tem mapa 3D/, "o Mestre não regenera");
    await q(`INSERT INTO jobs (campaign_id, kind, target, label) VALUES ($1, 'map', 'l1', 'teste')`, [id]);
    assert.match((await requestLocalMap(id, "l3", "generate", "", true)).message, /um por vez/, "um mapa por vez para o Mestre");
    await q(`DELETE FROM jobs WHERE campaign_id = $1`, [id]);

    // ferramenta e bloco do prompt
    let ctx = await load();
    assert.match(await executeGmTool("local_map", { action: "generate" }, ctx), /já tem mapa 3D/, "padrão: o lugar atual");
    assert.match(await executeGmTool("local_map", { action: "edit", place: "Lugar Nenhum", brief: "x" }, ctx), /não está no mapa do mundo/);
    let block = await localMapsPromptBlock(ctx.campaign);
    assert.match(block, /Locais com mapa 3D: Vila da Folha\./);
    assert.match(block, /Mapa daqui \(Vila da Folha\), pontos: Praça/);
    assert.match(block, /Gere \(action=generate\)/);

    // interruptor desligado: o Mestre não gera nem edita; remover e os botões seguem valendo
    await q(`INSERT INTO settings (key, value) VALUES ('ui', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [
      JSON.stringify({ ...(ui?.value ?? {}), autoMaps: false }),
    ]);
    ctx = await load();
    assert.match(await executeGmTool("local_map", { action: "edit", brief: "incêndio" }, ctx), /desligou/);
    assert.match(await localMapsPromptBlock(ctx.campaign), /desligou a geração automática/);
    assert.match((await requestLocalMap(id, "l1", "edit", "")).message, /Diga o que mudar/, "o botão não passa pelo interruptor");
    assert.match(await executeGmTool("local_map", { action: "remove" }, ctx), /removido/);
    assert.equal((await listLocalMaps(id, world)).length, 0);
    console.log("cartographer-check: ok");
  } finally {
    if (ui) await q(`UPDATE settings SET value = $1 WHERE key = 'ui'`, [JSON.stringify(ui.value)]);
    else await q(`DELETE FROM settings WHERE key = 'ui'`);
    await q(`DELETE FROM campaigns WHERE id = $1`, [id]);
    await pool().end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
