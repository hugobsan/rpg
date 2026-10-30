import { getSetting, q } from "./db";
import { chat, type ToolDef } from "./openrouter";
import { getAgent } from "./agents";
import { startJob } from "./jobs";
import { findPlace, getStage, loadMap, normName, relation } from "./map";
import { formatClock, getClock, period } from "./clock";
import { campaignTheme } from "./theme";
import { parseSpecText, type LocalMapInfo, type MapSpec } from "./mapSpec";
import type { ToolContext } from "./tools";
import type { Campaign, MapPlace, Scene, WorldMap } from "./types";

/**
 * Cartógrafo: mapa 3D de um local (tabela maps), gerado, editado e removido em segundo plano
 * pelo Mestre (local_map) ou pelos botões da aba Mapa (POST /api/campaigns/[id]/maps).
 * O modelo devolve um spec declarativo (lib/mapSpec.ts), que é validado antes de gravar.
 */

/** "O Mestre gera mapas 3D sozinho" (Configurações; ligado por padrão). Os botões valem sempre. */
export const autoMapsOn = async () => (await getSetting<{ autoMaps?: boolean }>("ui", {})).autoMaps !== false;

const sameName = (p: MapPlace, name: string) => [p.name, ...(p.aliases ?? [])].some((n) => normName(n) === normName(name));

/**
 * Mapas da campanha ligados aos lugares de agora: pelo id, se o lugar com esse id ainda tem o
 * nome; senão pelo nome (lugar juntado a outro, id reaproveitado depois de "gerar novamente").
 * Lugar que saiu do mapa do mundo esconde o mapa dele. Dois mapas no mesmo lugar: vale o mais novo.
 */
export async function listLocalMaps(campaignId: string, world: WorldMap): Promise<LocalMapInfo[]> {
  const rows = await q<{ id: string; place_id: string; place_name: string; updated_at: string; pois: string[] | null }>(
    `SELECT id, place_id, place_name, updated_at::text,
            (SELECT array_agg(p->>'name') FROM jsonb_array_elements(spec->'pois') p) AS pois
       FROM maps WHERE campaign_id = $1 ORDER BY updated_at DESC`,
    [campaignId]
  );
  const out: LocalMapInfo[] = [];
  for (const r of rows) {
    const byId = world.places.find((p) => p.id === r.place_id);
    const place = byId && sameName(byId, r.place_name) ? byId : findPlace(world, r.place_name);
    if (place && !out.some((m) => m.placeId === place.id))
      out.push({ id: Number(r.id), placeId: place.id, name: place.name, updatedAt: r.updated_at, pois: r.pois ?? [] });
  }
  return out;
}

export async function getLocalMapSpec(campaignId: string, mapId: number): Promise<MapSpec | null> {
  const [row] = await q<{ spec: MapSpec }>(`SELECT spec FROM maps WHERE campaign_id = $1 AND id = $2`, [campaignId, mapId]);
  return row?.spec ?? null;
}

/** Grava o spec do lugar: atualiza o mapa que já é dele (religando id e nome) ou cria. */
export async function saveLocalMap(campaignId: string, world: WorldMap, place: MapPlace, spec: MapSpec): Promise<number> {
  const mine = (await listLocalMaps(campaignId, world)).find((m) => m.placeId === place.id);
  if (mine) {
    await q(`UPDATE maps SET spec = $2, place_id = $3, place_name = $4, updated_at = now() WHERE id = $1`, [
      mine.id,
      JSON.stringify(spec),
      place.id,
      place.name,
    ]);
    return mine.id;
  }
  const [row] = await q<{ id: string }>(
    `INSERT INTO maps (campaign_id, place_id, place_name, spec) VALUES ($1,$2,$3,$4) RETURNING id`,
    [campaignId, place.id, place.name, JSON.stringify(spec)]
  );
  return Number(row.id);
}

type Action = "generate" | "edit" | "remove";

/**
 * Pedido de gerar, editar ou remover o mapa de um lugar. Remover é na hora; gerar e editar viram
 * tarefa em segundo plano (kind map, alvo = id do lugar). Pelo Mestre (gm) há travas de custo:
 * não regenera mapa que já existe e um mapa por vez.
 */
export async function requestLocalMap(
  campaignId: string,
  placeId: string,
  action: Action,
  brief: string,
  gm = false
): Promise<{ ok: boolean; message: string }> {
  const [c] = await q<Campaign>(`SELECT * FROM campaigns WHERE id = $1`, [campaignId]);
  if (!c) return { ok: false, message: "Campanha não encontrada." };
  const world = await loadMap(campaignId, c.state);
  const place = world.places.find((p) => p.id === placeId);
  if (!place) return { ok: false, message: "Esse lugar não está no mapa do mundo." };
  const mine = (await listLocalMaps(campaignId, world)).find((m) => m.placeId === place.id);
  brief = brief.trim().slice(0, 600);
  if (action === "remove") {
    if (!mine) return { ok: false, message: `${place.name} não tem mapa 3D.` };
    await q(`DELETE FROM maps WHERE id = $1`, [mine.id]);
    return { ok: true, message: `Mapa 3D de ${place.name} removido.` };
  }
  if (action === "edit" && !mine) return { ok: false, message: `${place.name} ainda não tem mapa 3D: gere primeiro.` };
  if (action === "edit" && !brief) return { ok: false, message: "Diga o que mudar no mapa." };
  if (gm && action === "generate" && mine) return { ok: false, message: `${place.name} já tem mapa 3D; para mudar algo, use action=edit.` };
  if (gm) {
    const [busy] = await q(`SELECT 1 FROM jobs WHERE campaign_id = $1 AND kind = 'map' AND status = 'running' AND updated_at > now() - interval '15 minutes'`, [campaignId]);
    if (busy) return { ok: false, message: "O Cartógrafo já está desenhando outro mapa; um por vez. Siga a narração." };
  }
  const label = `Cartógrafo ${action === "edit" ? "redesenhando" : "desenhando"} ${place.name}`;
  const job = await startJob(campaignId, "map", place.id, label, () => drawLocalMap(campaignId, place.id, action, brief));
  return job.started
    ? { ok: true, message: `${label} em segundo plano (1 a 3 min); o jogador é avisado quando ficar pronto.` }
    : { ok: true, message: `O Cartógrafo já está desenhando ${place.name}.` };
}

/** O que o Cartógrafo recebe: cenário, o lugar no mapa do mundo, a cena (se for aqui), o pedido e, ao editar, o mapa atual. */
async function cartographerInput(c: Campaign, world: WorldMap, place: MapPlace, action: Action, brief: string, current: MapSpec | null) {
  const byId = (id?: string) => world.places.find((p) => p.id === id);
  const parent = byId(place.parent);
  const inside = world.places.filter((p) => p.parent === place.id).map((p) => `${p.name} (${p.kind}${p.description ? `: ${p.description}` : ""})`);
  const routes = world.routes
    .filter((r) => r.from === place.id || r.to === place.id)
    .map((r) => {
      const o = byId(r.from === place.id ? r.to : r.from);
      return o ? `${o.name} (${[o.kind, relation(place, o), r.travel, r.label].filter(Boolean).join(", ")})` : "";
    })
    .filter(Boolean);
  const r = c.ruleset;
  const lines = [
    `CENÁRIO: ${r?.name ?? "?"}${r?.description ? ` — ${r.description}` : ""}`,
    `Tema visual da mesa: ${campaignTheme(c)}`,
    r?.loreNotes ? `Mundo: ${String(r.loreNotes).slice(0, 1500)}` : "",
    `\nLOCAL: ${place.name} (${place.kind}${parent ? `, dentro de ${parent.name}` : ""})`,
    place.aliases?.length ? `Outros nomes: ${place.aliases.join(", ")}` : "",
    place.description ? `Descrição: ${place.description}` : "",
    inside.length ? `Lugares dentro dele (cabem no mapa, se fizer sentido): ${inside.join("; ")}` : "",
    routes.length ? `Caminhos daqui (direção e distância no mundo): ${routes.join("; ")}` : "",
  ];
  // cena e narrações só quando o jogador está nele (ou dentro dele): de outro lugar, confundem
  const here = byId(world.current);
  if (here && (here.id === place.id || here.parent === place.id || place.parent === here.id)) {
    const [scene] = await q<Scene>(`SELECT * FROM scenes WHERE campaign_id = $1 AND is_current ORDER BY seq DESC LIMIT 1`, [c.id]);
    const gm = await q<{ content: string }>(
      `SELECT content FROM messages WHERE campaign_id = $1 AND role = 'gm' ORDER BY id DESC LIMIT 4`,
      [c.id]
    );
    const clock = getClock(c.state);
    const zones = getStage(scene?.state)?.zones ?? [];
    if (scene)
      lines.push(
        `\nCENA ATUAL: ${scene.title || "-"} | modo ${scene.mode} | local "${scene.location}"${clock ? ` | ${formatClock(clock.minutes)} (${period(clock.minutes)})` : ""}`,
        scene.summary ? `Resumo da cena: ${scene.summary.slice(0, 1200)}` : "",
        zones.length ? `Zonas do palco (crie um POI com cada nome): ${zones.map((z) => z.name + (z.note ? ` (${z.note})` : "")).join("; ")}` : ""
      );
    if (gm.length) lines.push(`Últimas narrações do Mestre:\n${gm.reverse().map((m) => `---\n${m.content.slice(0, 1400)}`).join("\n")}\n---`);
  }
  if (action === "edit" && current)
    lines.push(`\nMAPA ATUAL:\n${JSON.stringify(current)}`, `\nINSTRUÇÃO DE EDIÇÃO: ${brief}\nDevolva o JSON completo do mapa novo.`);
  else lines.push(`\nPEDIDO: ${brief || "desenhe o local como a história o descreve até aqui."}`);
  return lines.filter(Boolean).join("\n");
}

/** A tarefa: chama o Cartógrafo, valida o spec e grava. Erro vira aviso na tela (jobs). */
async function drawLocalMap(campaignId: string, placeId: string, action: Action, brief: string): Promise<void> {
  const [agent, [c]] = await Promise.all([getAgent("cartographer"), q<Campaign>(`SELECT * FROM campaigns WHERE id = $1`, [campaignId])]);
  if (!c) return;
  const world = await loadMap(campaignId, c.state);
  const place = world.places.find((p) => p.id === placeId);
  if (!place) throw new Error("O lugar saiu do mapa do mundo.");
  const mine = (await listLocalMaps(campaignId, world)).find((m) => m.placeId === place.id);
  const current = action === "edit" && mine ? await getLocalMapSpec(campaignId, mine.id) : null;
  const res = await chat({
    model: agent.model,
    messages: [
      { role: "system", content: agent.system_prompt },
      { role: "user", content: await cartographerInput(c, world, place, action, brief, current) },
    ],
    temperature: agent.temperature,
    max_tokens: agent.max_tokens,
    agentId: "cartographer",
    campaignId,
    purpose: action === "edit" ? "map_edit" : "map",
  });
  const spec = parseSpecText(res.content);
  if (!spec) throw new Error("O Cartógrafo devolveu um mapa inválido. Tente de novo.");
  // o mapa do mundo pode ter mudado nesses minutos: relê para ligar ao lugar certo
  const [fresh] = await q<Campaign>(`SELECT state FROM campaigns WHERE id = $1`, [campaignId]);
  const now = await loadMap(campaignId, fresh?.state ?? c.state);
  const target = now.places.find((p) => p.id === place.id && sameName(p, place.name)) ?? findPlace(now, place.name);
  if (!target) throw new Error(`${place.name} saiu do mapa do mundo enquanto o Cartógrafo desenhava.`);
  await saveLocalMap(campaignId, now, target, spec);
}

// ---------- Mestre ----------

/** Bloco do contexto: que lugares têm mapa, os pontos do mapa daqui (zonas do palco) e quando gerar. */
export async function localMapsPromptBlock(campaign: Campaign): Promise<string> {
  const world = await loadMap(campaign.id, campaign.state);
  const here = world.places.find((p) => p.id === world.current);
  const [maps, auto] = await Promise.all([listLocalMaps(campaign.id, world), autoMapsOn()]);
  if (!here && !maps.length) return "";
  const mine = here && maps.find((m) => m.placeId === here.id);
  const lines = [maps.length ? `Locais com mapa 3D: ${maps.map((m) => m.name).join(", ")}.` : "Nenhum local tem mapa 3D ainda."];
  if (mine) lines.push(`Mapa daqui (${here.name}), pontos: ${mine.pois.join(", ") || "-"}. Em set_stage, use esses nomes como zonas: o jogador vê os peões neles.`);
  else if (here) lines.push(`${here.name} ainda não tem mapa 3D.`);
  lines.push(
    auto
      ? "Gere (action=generate) quando o jogador chegar a um lugar relevante sem mapa que vai ser explorado ou palco de luta (vila, castelo, base, arena, masmorra), ou quando a cena pedir; não para passagens rápidas nem lugares de uma fala só. Edite (action=edit) quando a história mudar o lugar (ponte destruída, incêndio, construção nova). Nunca regenere à toa: custa caro. Roda em segundo plano (1 a 3 min): siga a narração sem esperar nem descrever o mapa."
      : "O jogador desligou a geração automática de mapas: não gere nem edite (ele usa os botões da aba Mapa)."
  );
  return `\n--- MAPAS 3D DOS LOCAIS (local_map) ---\n${lines.join("\n")}`;
}

export const LOCAL_MAP_TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "local_map",
      description:
        "Mapa 3D de um local, desenhado pelo Cartógrafo em segundo plano; o jogador vê na aba Mapa. generate: cria o mapa de um local que ainda não tem; edit: muda o mapa existente porque a história mudou o lugar; remove: apaga. Quais locais já têm mapa e quando gerar estão em MAPAS 3D DOS LOCAIS.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["generate", "edit", "remove"] },
          place: { type: "string", description: "local do mapa do mundo (padrão: onde o jogador está)" },
          brief: {
            type: "string",
            description: "generate: o que o mapa precisa mostrar (pontos de interesse, estado do lugar); edit: a mudança (ex.: 'a ponte foi destruída')",
          },
        },
        required: ["action"],
      },
    },
  },
];

export async function executeLocalMapTool(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const action = (["generate", "edit", "remove"] as const).find((a) => a === args.action);
  if (!action) return "action: generate, edit ou remove.";
  if (action !== "remove" && !(await autoMapsOn())) return "O jogador desligou a geração automática de mapas 3D nas Configurações; ele usa os botões da aba Mapa.";
  const world = await loadMap(ctx.campaign.id, ctx.campaign.state);
  const place = args.place ? findPlace(world, String(args.place)) : world.places.find((p) => p.id === world.current);
  if (!place) return "Esse local não está no mapa do mundo (set_scene ou update_map registram).";
  const r = await requestLocalMap(ctx.campaign.id, place.id, action, String(args.brief ?? ""), true);
  if (r.ok) ctx.emit({ type: "tool", name: "local_map", summary: action === "remove" ? `🗺 Mapa 3D de ${place.name} removido` : `🗺 Cartógrafo: ${place.name}` });
  if (r.ok) ctx.emit({ type: "state" }); // a tela relê a campanha e acompanha a tarefa
  return r.message;
}
