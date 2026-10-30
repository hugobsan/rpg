import { q } from "@/lib/db";
import { campaignTheme, type ThemeKey } from "@/lib/theme";
import type { Campaign } from "@/lib/types";

/** Linha da lista de campanhas: o que a home precisa para retomar o jogo. */
export interface CampaignRow {
  id: string;
  name: string;
  style: string;
  ruleset_name: string;
  theme: ThemeKey;
  mode: string | null; // modo da cena atual
  location: string | null; // local da cena atual (ou o título dela)
  clock: number | null; // minutos do relógio do jogo
  character_name: string | null;
  message_count: number;
  last_played: string; // última mensagem (ou última mudança da campanha)
  image_id: string | null; // última imagem do ambiente, se não foi tirada da ficha
  created_at: string;
  updated_at: string;
}

/** Usada pela home (Server Component) e por GET /api/campaigns. */
export async function listCampaigns(): Promise<CampaignRow[]> {
  // só os campos que o tema usa (o state inteiro pode ser grande: mapa, missões...)
  const rows = await q<Omit<CampaignRow, "theme"> & Pick<Campaign, "state" | "ruleset">>(
    `SELECT c.id, c.name, c.style, c.created_at::text, c.updated_at::text,
            c.ruleset->>'name' AS ruleset_name,
            jsonb_build_object('name', c.ruleset->'name', 'description', c.ruleset->'description', 'theme', c.ruleset->'theme') AS ruleset,
            jsonb_build_object('theme', c.state->'theme') AS state,
            (c.state->'clock'->>'minutes')::float AS clock,
            s.mode, NULLIF(COALESCE(NULLIF(s.location, ''), s.title), '') AS location,
            p.name AS character_name,
            m.count AS message_count,
            COALESCE(m.last, c.updated_at)::text AS last_played,
            NULLIF(i.id, (c.state->>'hiddenSheetImageId')::bigint)::text AS image_id
     FROM campaigns c
     LEFT JOIN LATERAL (SELECT mode, location, title FROM scenes
                        WHERE campaign_id = c.id AND is_current ORDER BY seq DESC LIMIT 1) s ON true
     LEFT JOIN LATERAL (SELECT name FROM characters
                        WHERE campaign_id = c.id AND kind = 'player' ORDER BY created_at LIMIT 1) p ON true
     LEFT JOIN LATERAL (SELECT count(*)::int AS count, max(created_at) AS last FROM messages
                        WHERE campaign_id = c.id) m ON true
     LEFT JOIN LATERAL (SELECT max(id) AS id FROM scene_images WHERE campaign_id = c.id) i ON true
     ORDER BY COALESCE(m.last, c.updated_at) DESC`
  );
  return rows.map(({ state, ruleset, ...r }) => ({ ...r, theme: campaignTheme({ state, ruleset }) }));
}
