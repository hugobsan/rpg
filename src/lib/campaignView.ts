import { getSetting, q } from "./db";
import { getCampaign, getCharacters, getCurrentScene } from "./engine";
import { listBooks } from "./books";
import { messagePage } from "./messages";
import { listInbox } from "./npc";
import type { Campaign, Character, InboxItem, Scene } from "./types";

export interface ChatLine {
  id: number;
  role: string;
  content: string;
  meta: { choices?: string[] };
}

/** Estado da campanha para a tela de jogo: GET /api/campaigns/[id] e o HTML inicial da página. */
export interface CampaignView {
  campaign: Campaign;
  scene: Scene;
  characters: Character[];
  books: { id: string; title: string; pages: number }[];
  messages: ChatLine[]; // só o lote mais recente; as anteriores vêm de /messages?before=
  hasMore: boolean; // há mensagens anteriores às carregadas
  memories: { id: number; kind: string; subject: string | null; content: string; importance: number }[];
  lastImage: { id: number; url: string } | null;
  ui: { diceAnimation: boolean; imageGeneration: boolean }; // Configurações, ligadas por padrão
  inbox: InboxItem[]; // mensagens particulares de NPC não lidas (npc_message)
}

/** Lança "Campanha não encontrada" se o id não existe. */
export async function campaignView(id: string): Promise<CampaignView> {
  const campaign = await getCampaign(id);
  const [scene, characters, books, page, memories, images, ui, inbox] = await Promise.all([
    getCurrentScene(id),
    getCharacters(id),
    listBooks(id),
    messagePage(id),
    q<CampaignView["memories"][number]>(
      `SELECT id, kind, subject, content, importance, created_at::text FROM memories
       WHERE campaign_id = $1 ORDER BY id DESC LIMIT 100`,
      [id]
    ),
    // só o id: a imagem vai por URL (binário com cache longo), nunca em base64 no JSON
    q<{ id: string }>(`SELECT id FROM scene_images WHERE campaign_id = $1 ORDER BY id DESC LIMIT 1`, [id]),
    getSetting<{ diceAnimation?: boolean; imageGeneration?: boolean }>("ui", {}),
    listInbox(id),
  ]);
  return {
    campaign,
    scene,
    characters,
    books,
    messages: page.messages as ChatLine[],
    hasMore: page.hasMore,
    memories,
    // a ficha mostra a última imagem, a menos que o jogador a tenha tirado de lá (✕); ela segue na galeria
    lastImage:
      images[0] && Number(images[0].id) !== Number(campaign.state?.hiddenSheetImageId)
        ? { id: Number(images[0].id), url: `/api/campaigns/${id}/images/${images[0].id}` }
        : null,
    ui: { diceAnimation: ui.diceAnimation !== false, imageGeneration: ui.imageGeneration !== false },
    inbox,
  };
}
