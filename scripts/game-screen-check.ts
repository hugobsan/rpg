// Checagem da tela de jogo sem banco e sem IA: npx tsx scripts/game-screen-check.ts
// Blocos da narração, grupos do feed, fases do turno e os avisos pela diferença de estado.
import assert from "node:assert/strict";
import ruleset from "../naruto-ruleset.json";
import { chipIcon, chipText, draftSafe, excerpt, groupFeed, narrationBlocks, phaseOf } from "../src/components/game/feedModel";
import { stateToasts } from "../src/components/game/stateToasts";
import type { CampaignView } from "../src/lib/campaignView";
import type { Character, Ruleset, Sheet } from "../src/lib/types";

// ---------- narração ----------
const blocks = narrationBlocks(
  `O garoto para de comer.\n\n**Naruto Uzumaki:** "Sou eu, sim!"\nEle sorri.\n\n- A Academia\n- O Monumento\n\n**Iruka**: "Calma."\n*Ele suspira.*`
);
assert.deepEqual(blocks.map((b) => b.kind), ["p", "say", "p", "list", "say", "p"]);
assert.deepEqual(blocks[1], { kind: "say", name: "Naruto Uzumaki", line: `"Sou eu, sim!"` });
assert.deepEqual(blocks[3], { kind: "list", items: ["A Academia", "O Monumento"] });
assert.equal(blocks[4].kind === "say" && blocks[4].name, "Iruka");
assert.equal(blocks[5].kind === "p" && blocks[5].text, "*Ele suspira.*", "itálico no começo da linha não vira lista");
assert.equal(excerpt("**Naruto:** curto"), "Naruto: curto");
assert.equal(draftSafe("Ele ri.\n\n**Naru"), "Ele ri.\n\n");
assert.equal(draftSafe("**Naruto:** \"Ei"), "**Naruto:** \"Ei", "negrito fechado fica");
assert.equal(draftSafe("Ele viu **Kaka"), "Ele viu ");
assert.equal(excerpt("um dois três quatro cinco", 12), "…quatro cinco");

// ---------- feed ----------
const g = groupFeed([
  { key: "m1", kind: "player", content: "ataco" },
  { key: "k1", kind: "chip", content: "a", name: "update_resource" },
  { key: "k2", kind: "chip", content: "b" },
  { key: "k3", kind: "dice", content: "🎲" },
  { key: "k4", kind: "chip", content: "c" },
  { key: "k5", kind: "gm", content: "narra" },
]);
assert.deepEqual(g.map((x) => x.chips?.length ?? x.item!.kind), ["player", 2, "dice", 1, "gm"]);
assert.equal(g[1].key, "k1", "o grupo leva a key do primeiro chip (estável enquanto cresce)");
assert.equal(chipIcon({ name: "update_resource", content: "" }), "heart");
assert.equal(chipIcon({ name: "npc_message", content: "" }), "mail");
assert.equal(chipIcon({ name: "set_npc_active", content: "" }), "people");
assert.equal(chipIcon({ content: "🕐 Dia 2 · 14:00" }), "clock");
assert.equal(chipText("🎬 training — Campo de Treino"), "Treinamento · Campo de Treino");
assert.equal(chipText("✉️ Kakashi quer falar com você em particular"), "Kakashi quer falar com você em particular");

assert.equal(phaseOf({ type: "status", text: "Lendo a cena..." }), "think");
assert.equal(phaseOf({ type: "status", text: "O Mestre está pensando..." }), "think");
assert.equal(phaseOf({ type: "status", text: "Escrevendo..." }), "write");
assert.equal(phaseOf({ type: "status", text: "Consultando memórias e livros..." }), "consult");
assert.equal(phaseOf({ type: "tool", name: "search_memories" }), "consult");
assert.equal(phaseOf({ type: "tool", name: "update_resource" }), null);
assert.equal(phaseOf({ type: "dice" }), "dice");
assert.equal(phaseOf({ type: "narration_delta" }), "write");

// ---------- avisos pela diferença de estado ----------
const r = ruleset as unknown as Ruleset;
const sheet = (o: Partial<Sheet> = {}): Sheet => ({
  attributes: {}, abilities: [], inventory: [], xp: 0, extra: {},
  resources: { hp: { current: 40, max: 40 }, chakra: { current: 50, max: 50 }, stamina: { current: 30, max: 30 } },
  ...o,
});
const char = (id: string, kind: "player" | "npc", name: string, o: Partial<Character> = {}): Character =>
  ({ id, campaign_id: "c", kind, name, active: true, canon: false, sheet: sheet(), persona: {}, voice: null, ...o }) as Character;
const view = (o: { player?: Partial<Sheet>; npcs?: Character[]; state?: Record<string, unknown>; id?: string } = {}): CampaignView =>
  ({
    campaign: { id: o.id ?? "c", name: "t", style: "hybrid", ruleset: r, script: null, state: o.state ?? {} },
    characters: [char("p", "player", "Hugo", { sheet: sheet(o.player) }), ...(o.npcs ?? [])],
  }) as CampaignView;

assert.deepEqual(stateToasts(view(), view()), [], "sem mudança, sem aviso");
assert.deepEqual(stateToasts(view(), view({ id: "outra" })), [], "outra campanha não compara");

const hurt = stateToasts(view(), view({ player: { resources: { hp: { current: 32, max: 40 }, chakra: { current: 45, max: 50 }, stamina: { current: 30, max: 30 } } } }));
assert.deepEqual(hurt, [
  { kind: "dano", text: "−8 Saúde (32/40)" },
  { kind: "info", text: "−5 Chakra (45/50)" },
]);
const healed = stateToasts(view({ player: { resources: { hp: { current: 20, max: 40 }, chakra: { current: 50, max: 50 }, stamina: { current: 30, max: 30 } } } }), view());
assert.deepEqual(healed, [{ kind: "cura", text: "+20 Saúde (40/40)" }]);

const lv = stateToasts(view({ player: { xp: 80 } }), view({ player: { xp: 120 } }));
assert.deepEqual(lv[0], { kind: "sucesso", title: "Nível de poder", text: "Você alcançou Genin" });
assert.deepEqual(lv[1], { kind: "xp", text: "+40 XP · 1 ponto livre de atributo" });
assert.deepEqual(stateToasts(view({ player: { xp: 120 } }), view({ player: { xp: 80 } })), [], "XP voltando (gerar novamente) não avisa");

const inv = stateToasts(
  view({ player: { inventory: [{ name: "Kunai", qty: 3 }, { name: "Pergaminho", qty: 1 }] } }),
  view({ player: { inventory: [{ name: "kunai", qty: 5 }, { name: "Bandana", qty: 1 }] } })
);
assert.deepEqual(inv, [{ kind: "info", title: "Inventário", text: "+2 kunai · −1 Pergaminho · +1 Bandana" }]);

// habilidade aprendida: por ref (renomear na biblioteca não é aprender); sem ref, por nome
const jutsu = (name: string, ref?: number) => ({ name, type: "ninjutsu", ref });
assert.deepEqual(stateToasts(view({ player: { abilities: [jutsu("Kawarimi", 1)] } }), view({ player: { abilities: [jutsu("Kawarimi no Jutsu", 1), jutsu("Chidori", 2)] } })),
  [{ kind: "sucesso", title: "Aprendeu", text: "Chidori" }]);
assert.deepEqual(stateToasts(view({ player: { abilities: [jutsu("Kawarimi")] } }), view({ player: { abilities: [jutsu("kawarimi")] } })), []);

const kakashi = char("n1", "npc", "Kakashi");
const iruka = char("n2", "npc", "Iruka");
const cast = stateToasts(view({ npcs: [kakashi, { ...iruka, active: false }] }), view({ npcs: [{ ...kakashi, active: false }, iruka, char("n3", "npc", "Gai")] }));
assert.deepEqual(cast, [
  { kind: "info", text: "Iruka e Gai entraram em cena" },
  { kind: "info", text: "Kakashi saiu de cena" },
]);

const mission = { id: "o1", title: "Achar o gato", kind: "missao", description: "", status: "aberto", createdAt: 0 };
assert.deepEqual(stateToasts(view(), view({ state: { objectives: [mission] } })), [{ kind: "info", title: "Missão nova", text: "Achar o gato" }]);
assert.deepEqual(
  stateToasts(view({ state: { objectives: [mission] } }), view({ state: { objectives: [{ ...mission, status: "perdido" }] } })),
  [{ kind: "dano", title: "Prazo perdido", text: "Achar o gato" }]
);
assert.deepEqual(
  stateToasts(view({ state: { objectives: [mission] } }), view({ state: { objectives: [{ ...mission, status: "concluido" }] } })),
  [{ kind: "sucesso", title: "Missão concluída", text: "Achar o gato" }]
);

assert.deepEqual(stateToasts(view({ state: { clock: { minutes: 600 } } }), view({ state: { clock: { minutes: 660 } } })), [], "1 h não avisa");
assert.deepEqual(stateToasts(view({ state: { clock: { minutes: 600 } } }), view({ state: { clock: { minutes: 1980 } } })), [
  { kind: "info", title: "O tempo passou", text: "+23 h · Dia 2 · 09:00" },
]);

// muitos avisos de uma vez: só os 4 mais importantes (nível antes de tempo)
const many = stateToasts(
  view({ player: { xp: 80 }, npcs: [kakashi], state: { clock: { minutes: 0 } } }),
  view({ player: { xp: 120, resources: { hp: { current: 1, max: 40 }, chakra: { current: 1, max: 50 }, stamina: { current: 30, max: 30 } } }, npcs: [{ ...kakashi, active: false }], state: { clock: { minutes: 900 } } })
);
assert.equal(many.length, 4);
assert.equal(many[0].title, "Nível de poder");
assert.ok(!many.some((t) => t.title === "O tempo passou"));

console.log("game-screen-check: ok");
