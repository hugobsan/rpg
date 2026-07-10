import { q } from "./db";
import { ToolDef } from "./openrouter";
import { rollDice } from "./dice";
import { addMemory, searchMemories, searchBookChunks } from "./retrieval";
import { listBooks, readPages } from "./books";
import { Campaign, Character, Scene, Sheet, TurnEvent } from "./types";
import { blankSheet } from "./ruleset";

const S = (props: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties: props,
  required,
});

export const GM_TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "roll_dice",
      description:
        "Rola dados em notação padrão (ex: 1d20+4, 2d6). O resultado é mostrado ao jogador.",
      parameters: S(
        {
          notation: { type: "string", description: "ex: 1d20+4" },
          reason: { type: "string", description: "o que está sendo testado" },
        },
        ["notation"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "update_resource",
      description:
        "Altera um recurso (saúde, chakra...) de um personagem. Use delta para dano/cura/gasto, ou set para fixar. Opcionalmente ajusta o máximo.",
      parameters: S(
        {
          character: { type: "string", description: "nome exato" },
          resource: { type: "string", description: "key do recurso (ex: hp, chakra)" },
          delta: { type: "number", description: "variação (+cura/-dano)" },
          set: { type: "number", description: "valor absoluto" },
          setMax: { type: "number", description: "novo máximo" },
        },
        ["character", "resource"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "update_attribute",
      description: "Define o valor de um atributo básico de um personagem.",
      parameters: S(
        {
          character: { type: "string" },
          attribute: { type: "string", description: "key do atributo" },
          value: { type: "number" },
        },
        ["character", "attribute", "value"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "add_ability",
      description:
        "Adiciona (ou atualiza, se mesmo nome) uma habilidade/jutsu ao personagem.",
      parameters: S(
        {
          character: { type: "string" },
          name: { type: "string" },
          abilityType: { type: "string", description: "key do tipo (ex: ninjutsu)" },
          rank: { type: "string", description: "nível de maestria (ex: C)" },
          description: { type: "string" },
        },
        ["character", "name", "abilityType"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "add_item",
      description: "Adiciona item ao inventário (soma quantidade se já existir).",
      parameters: S(
        {
          character: { type: "string" },
          name: { type: "string" },
          qty: { type: "number" },
          description: { type: "string" },
        },
        ["character", "name"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "remove_item",
      description: "Remove/consome itens do inventário.",
      parameters: S(
        { character: { type: "string" }, name: { type: "string" }, qty: { type: "number" } },
        ["character", "name"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "grant_xp",
      description:
        "Concede XP ao personagem. O retorno informa se o XP cruzou o limiar de um novo rank (a promoção em si é decisão narrativa sua, via set_rank).",
      parameters: S(
        { character: { type: "string" }, amount: { type: "number" }, reason: { type: "string" } },
        ["character", "amount"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "set_rank",
      description: "Define o rank/nível do personagem (key do ruleset, ex: chunin).",
      parameters: S({ character: { type: "string" }, rank: { type: "string" } }, [
        "character",
        "rank",
      ]),
    },
  },
  {
    type: "function",
    function: {
      name: "update_extra_field",
      description: "Define um campo extra da ficha (ex: elemento, kekkei_genkai).",
      parameters: S(
        { character: { type: "string" }, field: { type: "string" }, value: { type: "string" } },
        ["character", "field", "value"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "add_memory",
      description:
        "Registra memória de longo prazo da campanha. kind: event, npc, discovery, milestone (marcos de história), relationship.",
      parameters: S(
        {
          kind: { type: "string", enum: ["event", "npc", "discovery", "milestone", "relationship"] },
          content: { type: "string", description: "fato autossuficiente" },
          subject: { type: "string", description: "NPC/lugar relacionado" },
          importance: { type: "number", description: "1-5" },
        },
        ["kind", "content"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "search_memories",
      description:
        "Busca semântica nas memórias da campanha (eventos passados, interações com NPCs, descobertas, marcos).",
      parameters: S(
        { query: { type: "string" }, kind: { type: "string" }, subject: { type: "string" } },
        ["query"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "create_npc",
      description:
        "Cria um NPC novo (ativo na cena). Informe ficha resumida e persona. canon=true para personagens da obra original.",
      parameters: S(
        {
          name: { type: "string" },
          canon: { type: "boolean" },
          rank: { type: "string", description: "key do rank do ruleset" },
          appearance: { type: "string" },
          personality: { type: "string" },
          backstory: { type: "string" },
          goals: { type: "string" },
          secrets: { type: "string", description: "só o Mestre vê" },
          attributes: {
            type: "object",
            description: "mapa key->valor dos atributos que fogem do padrão",
            additionalProperties: { type: "number" },
          },
          abilities: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                type: { type: "string" },
                rank: { type: "string" },
                description: { type: "string" },
              },
              required: ["name", "type"],
            },
          },
        },
        ["name", "personality"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "set_npc_active",
      description:
        "Ativa (entrou em cena/está por perto) ou inativa (saiu de cena, viajou, morreu) um NPC. NPCs inativos não interagem.",
      parameters: S(
        { name: { type: "string" }, active: { type: "boolean" }, note: { type: "string" } },
        ["name", "active"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "set_scene",
      description:
        "Atualiza a cena atual (modo/título/local) ou inicia uma nova cena (newScene=true). Modos: exploration, dialogue, battle, training, downtime.",
      parameters: S(
        {
          mode: { type: "string", enum: ["exploration", "dialogue", "battle", "training", "downtime"] },
          title: { type: "string" },
          location: { type: "string" },
          newScene: { type: "boolean", description: "true para encerrar a cena atual e abrir outra" },
        },
        []
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "get_character",
      description: "Lê a ficha completa e persona de um personagem (player ou NPC, ativo ou não).",
      parameters: S({ name: { type: "string" } }, ["name"]),
    },
  },
  {
    type: "function",
    function: {
      name: "get_script",
      description:
        "Lê o roteiro interno da campanha (premissa, arcos, eventos canônicos, progresso). Use para se situar na linha do tempo.",
      parameters: S({}, []),
    },
  },
  {
    type: "function",
    function: {
      name: "update_script",
      description:
        "Anota progresso no roteiro: adiciona nota a um arco e/ou muda seu status (pending/active/done).",
      parameters: S(
        {
          arcTitle: { type: "string" },
          note: { type: "string" },
          status: { type: "string", enum: ["pending", "active", "done"] },
        },
        ["arcTitle"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "search_book",
      description:
        "Busca trechos nos livros/materiais de referência indexados. Retorna chunks com número de página — depois você pode ler páginas inteiras com read_pages.",
      parameters: S({ query: { type: "string" } }, ["query"]),
    },
  },
  {
    type: "function",
    function: {
      name: "read_pages",
      description:
        "Lê páginas inteiras de um livro indexado (até 8 por chamada). Use após search_book para contexto completo, página seguinte/anterior ou um intervalo específico.",
      parameters: S(
        {
          bookId: { type: "string" },
          from: { type: "number", description: "primeira página" },
          to: { type: "number", description: "última página (opcional, default = from)" },
        },
        ["bookId", "from"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "list_books",
      description: "Lista os livros/materiais indexados nesta campanha.",
      parameters: S({}, []),
    },
  },
];

export interface ToolContext {
  campaign: Campaign;
  scene: Scene;
  emit: (e: TurnEvent) => void;
}

async function getChar(campaignId: string, name: string): Promise<Character> {
  const rows = await q<Character>(
    `SELECT * FROM characters WHERE campaign_id = $1 AND lower(name) = lower($2)`,
    [campaignId, name]
  );
  if (!rows.length) throw new Error(`Personagem "${name}" não existe nesta campanha.`);
  return rows[0];
}

async function saveSheet(id: string, sheet: Sheet): Promise<void> {
  await q(`UPDATE characters SET sheet = $1, updated_at = now() WHERE id = $2`, [
    JSON.stringify(sheet),
    id,
  ]);
}

/** Executa uma tool do Mestre. Retorna string (resultado para o modelo). */
export async function executeGmTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<string> {
  const cid = ctx.campaign.id;
  switch (name) {
    case "roll_dice": {
      const result = rollDice(String(args.notation), args.reason as string | undefined);
      ctx.emit({ type: "dice", result });
      return `Rolagem ${result.notation}${result.reason ? ` (${result.reason})` : ""}: dados [${result.rolls.join(", ")}] ${result.modifier ? `mod ${result.modifier} ` : ""}= TOTAL ${result.total}`;
    }
    case "update_resource": {
      const c = await getChar(cid, String(args.character));
      const key = String(args.resource);
      const res = c.sheet.resources[key];
      if (!res) return `Erro: recurso "${key}" não existe na ficha de ${c.name}.`;
      if (typeof args.setMax === "number") res.max = Math.max(1, args.setMax);
      if (typeof args.set === "number") res.current = args.set;
      else if (typeof args.delta === "number") res.current += args.delta;
      res.current = Math.max(0, Math.min(res.current, res.max));
      await saveSheet(c.id, c.sheet);
      ctx.emit({ type: "state" });
      ctx.emit({
        type: "tool",
        name,
        summary: `${c.name}: ${key} → ${res.current}/${res.max}`,
      });
      return `${c.name} agora tem ${key} = ${res.current}/${res.max}.`;
    }
    case "update_attribute": {
      const c = await getChar(cid, String(args.character));
      c.sheet.attributes[String(args.attribute)] = Number(args.value);
      await saveSheet(c.id, c.sheet);
      ctx.emit({ type: "state" });
      ctx.emit({ type: "tool", name, summary: `${c.name}: ${args.attribute} = ${args.value}` });
      return `Atributo atualizado.`;
    }
    case "add_ability": {
      const c = await getChar(cid, String(args.character));
      const ability = {
        name: String(args.name),
        type: String(args.abilityType),
        rank: args.rank ? String(args.rank) : undefined,
        description: args.description ? String(args.description) : undefined,
      };
      const idx = c.sheet.abilities.findIndex(
        (a) => a.name.toLowerCase() === ability.name.toLowerCase()
      );
      if (idx >= 0) c.sheet.abilities[idx] = ability;
      else c.sheet.abilities.push(ability);
      await saveSheet(c.id, c.sheet);
      ctx.emit({ type: "state" });
      ctx.emit({ type: "tool", name, summary: `${c.name} ${idx >= 0 ? "aprimorou" : "aprendeu"}: ${ability.name}${ability.rank ? ` (${ability.rank})` : ""}` });
      return `Habilidade ${idx >= 0 ? "atualizada" : "adicionada"}.`;
    }
    case "add_item": {
      const c = await getChar(cid, String(args.character));
      const qty = Number(args.qty ?? 1);
      const existing = c.sheet.inventory.find(
        (i) => i.name.toLowerCase() === String(args.name).toLowerCase()
      );
      if (existing) existing.qty += qty;
      else
        c.sheet.inventory.push({
          name: String(args.name),
          qty,
          description: args.description ? String(args.description) : undefined,
        });
      await saveSheet(c.id, c.sheet);
      ctx.emit({ type: "state" });
      ctx.emit({ type: "tool", name, summary: `${c.name} +${qty}x ${args.name}` });
      return `Item adicionado.`;
    }
    case "remove_item": {
      const c = await getChar(cid, String(args.character));
      const qty = Number(args.qty ?? 1);
      const item = c.sheet.inventory.find(
        (i) => i.name.toLowerCase() === String(args.name).toLowerCase()
      );
      if (!item) return `Erro: ${c.name} não possui "${args.name}".`;
      item.qty -= qty;
      if (item.qty <= 0)
        c.sheet.inventory = c.sheet.inventory.filter((i) => i !== item);
      await saveSheet(c.id, c.sheet);
      ctx.emit({ type: "state" });
      ctx.emit({ type: "tool", name, summary: `${c.name} -${qty}x ${args.name}` });
      return `Item removido.`;
    }
    case "grant_xp": {
      const c = await getChar(cid, String(args.character));
      c.sheet.xp += Number(args.amount);
      await saveSheet(c.id, c.sheet);
      const ranks = ctx.campaign.ruleset.ranks;
      const eligible = [...ranks].reverse().find((r) => c.sheet.xp >= r.xpRequired);
      const current = ranks.find((r) => r.key === c.sheet.rank);
      ctx.emit({ type: "state" });
      ctx.emit({ type: "tool", name, summary: `${c.name} +${args.amount} XP (total ${c.sheet.xp})` });
      let msg = `${c.name} agora tem ${c.sheet.xp} XP.`;
      if (eligible && current && eligible.xpRequired > current.xpRequired)
        msg += ` ATENÇÃO: XP suficiente para ${eligible.label} — promova via set_rank se/quando fizer sentido narrativo (exame, cerimônia...).`;
      return msg;
    }
    case "set_rank": {
      const c = await getChar(cid, String(args.character));
      c.sheet.rank = String(args.rank);
      await saveSheet(c.id, c.sheet);
      ctx.emit({ type: "state" });
      ctx.emit({ type: "tool", name, summary: `${c.name} → ${args.rank}` });
      return `Rank atualizado.`;
    }
    case "update_extra_field": {
      const c = await getChar(cid, String(args.character));
      c.sheet.extra[String(args.field)] = String(args.value);
      await saveSheet(c.id, c.sheet);
      ctx.emit({ type: "state" });
      return `Campo atualizado.`;
    }
    case "add_memory": {
      await addMemory(
        cid,
        String(args.kind),
        String(args.content),
        args.subject ? String(args.subject) : null,
        Number(args.importance ?? 3)
      );
      ctx.emit({ type: "tool", name, summary: `📌 ${String(args.content).slice(0, 80)}` });
      return `Memória registrada.`;
    }
    case "search_memories": {
      const hits = await searchMemories(cid, String(args.query), {
        kind: args.kind ? String(args.kind) : undefined,
        subject: args.subject ? String(args.subject) : undefined,
        limit: 8,
      });
      if (!hits.length) return "Nenhuma memória encontrada.";
      return hits
        .map((h) => `[${h.kind}${h.subject ? `/${h.subject}` : ""} imp=${h.importance}] ${h.content}`)
        .join("\n");
    }
    case "create_npc": {
      const sheet = blankSheet(ctx.campaign.ruleset);
      if (args.rank) sheet.rank = String(args.rank);
      if (args.attributes && typeof args.attributes === "object")
        Object.assign(sheet.attributes, args.attributes as Record<string, number>);
      if (Array.isArray(args.abilities))
        sheet.abilities = (args.abilities as { name: string; type: string; rank?: string; description?: string }[]).map(
          (a) => ({ name: a.name, type: a.type, rank: a.rank, description: a.description })
        );
      const persona = {
        appearance: args.appearance ? String(args.appearance) : undefined,
        personality: String(args.personality),
        backstory: args.backstory ? String(args.backstory) : undefined,
        goals: args.goals ? String(args.goals) : undefined,
        secrets: args.secrets ? String(args.secrets) : undefined,
      };
      await q(
        `INSERT INTO characters (campaign_id, kind, name, active, canon, sheet, persona)
         VALUES ($1,'npc',$2,TRUE,$3,$4,$5)
         ON CONFLICT (campaign_id, name) DO UPDATE SET active = TRUE`,
        [cid, String(args.name), !!args.canon, JSON.stringify(sheet), JSON.stringify(persona)]
      );
      ctx.emit({ type: "state" });
      ctx.emit({ type: "tool", name, summary: `✨ NPC criado: ${args.name}` });
      return `NPC ${args.name} criado e ativo na cena.`;
    }
    case "set_npc_active": {
      const c = await getChar(cid, String(args.name));
      await q(`UPDATE characters SET active = $1, updated_at = now() WHERE id = $2`, [
        !!args.active,
        c.id,
      ]);
      if (args.note)
        await addMemory(cid, "npc", `${c.name}: ${args.note}`, c.name, 2);
      ctx.emit({ type: "state" });
      ctx.emit({
        type: "tool",
        name,
        summary: `${c.name} ${args.active ? "entrou em cena" : "saiu de cena"}`,
      });
      return `OK.`;
    }
    case "set_scene": {
      if (args.newScene) {
        await q(`UPDATE scenes SET is_current = FALSE WHERE campaign_id = $1`, [cid]);
        const rows = await q<Scene>(
          `INSERT INTO scenes (campaign_id, seq, mode, title, location)
           VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          [
            cid,
            ctx.scene.seq + 1,
            String(args.mode || ctx.scene.mode),
            String(args.title || ""),
            String(args.location || ctx.scene.location),
          ]
        );
        ctx.scene = rows[0];
        Object.assign(ctx, { scene: rows[0] });
      } else {
        if (args.mode) ctx.scene.mode = args.mode as Scene["mode"];
        if (args.title !== undefined) ctx.scene.title = String(args.title);
        if (args.location !== undefined) ctx.scene.location = String(args.location);
        await q(
          `UPDATE scenes SET mode = $1, title = $2, location = $3 WHERE id = $4`,
          [ctx.scene.mode, ctx.scene.title, ctx.scene.location, ctx.scene.id]
        );
      }
      ctx.emit({ type: "scene", scene: ctx.scene });
      ctx.emit({
        type: "tool",
        name,
        summary: `🎬 ${ctx.scene.mode}${ctx.scene.location ? ` — ${ctx.scene.location}` : ""}`,
      });
      return `Cena atualizada: modo=${ctx.scene.mode}, local=${ctx.scene.location}.`;
    }
    case "get_character": {
      const c = await getChar(cid, String(args.name));
      return JSON.stringify(
        { name: c.name, kind: c.kind, active: c.active, canon: c.canon, sheet: c.sheet, persona: c.persona },
        null,
        1
      );
    }
    case "get_script": {
      return ctx.campaign.script
        ? JSON.stringify(ctx.campaign.script, null, 1)
        : "Esta campanha não tem roteiro gerado.";
    }
    case "update_script": {
      const script = ctx.campaign.script;
      if (!script) return "Sem roteiro para atualizar.";
      const arc = script.arcs.find(
        (a) => a.title.toLowerCase() === String(args.arcTitle).toLowerCase()
      );
      if (!arc) return `Arco "${args.arcTitle}" não encontrado. Arcos: ${script.arcs.map((a) => a.title).join("; ")}`;
      if (args.note) arc.notes.push(String(args.note));
      if (args.status) arc.status = args.status as "pending" | "active" | "done";
      await q(`UPDATE campaigns SET script = $1, updated_at = now() WHERE id = $2`, [
        JSON.stringify(script),
        cid,
      ]);
      ctx.emit({ type: "tool", name, summary: `📜 roteiro: ${arc.title} (${arc.status})` });
      return "Roteiro atualizado.";
    }
    case "search_book": {
      const hits = await searchBookChunks(cid, String(args.query), 5);
      if (!hits.length) return "Nada encontrado nos livros indexados.";
      return hits
        .map((h) => `[${h.title} | bookId=${h.book_id} | pág. ${h.page}]\n${h.content}`)
        .join("\n---\n");
    }
    case "read_pages": {
      const from = Number(args.from);
      const to = Number(args.to ?? from);
      const pages = await readPages(String(args.bookId), from, to);
      if (!pages.length) return "Páginas não encontradas (verifique bookId e intervalo).";
      return pages.map((p) => `=== Página ${p.page} ===\n${p.content}`).join("\n\n");
    }
    case "list_books": {
      const books = await listBooks(cid);
      if (!books.length) return "Nenhum livro indexado nesta campanha.";
      return books.map((b) => `${b.title} — bookId=${b.id}, ${b.pages} páginas`).join("\n");
    }
    default:
      return `Ferramenta desconhecida: ${name}`;
  }
}
