-- Schema idempotente: aplicado automaticamente no boot (lib/db.ts).

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL,
  temperature REAL NOT NULL DEFAULT 0.8,
  max_tokens INT NOT NULL DEFAULT 2048,
  web_search BOOLEAN NOT NULL DEFAULT FALSE,
  system_prompt TEXT NOT NULL DEFAULT '',
  params JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_logs (
  id BIGSERIAL PRIMARY KEY,
  agent_id TEXT,
  campaign_id UUID,
  model TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT '',
  request JSONB,
  response JSONB,
  prompt_tokens INT,
  completion_tokens INT,
  duration_ms INT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS api_logs_agent_idx ON api_logs (agent_id, created_at DESC);
-- custo em USD informado pelo OpenRouter (usage.cost); NULL quando não veio
ALTER TABLE api_logs ADD COLUMN IF NOT EXISTS cost NUMERIC;
-- preço do modelo (USD por milhão de tokens) buscado no catálogo ao salvar o agente
ALTER TABLE agents ADD COLUMN IF NOT EXISTS pricing JSONB;
-- fonte de modelos do agente: 'openrouter' (embutida) ou o id de uma fonte OpenAI-compatível (settings.sources)
ALTER TABLE agents ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'openrouter';
-- hash do prompt padrão (DEFAULT_AGENTS) de onde o system_prompt veio; igual ao hash do prompt = não editado à mão.
-- NULL: anterior a este controle ou editado na migração (conta como editado)
ALTER TABLE agents ADD COLUMN IF NOT EXISTS prompt_base TEXT;
-- fonte que atendeu a chamada (as antigas foram todas no OpenRouter)
ALTER TABLE api_logs ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'openrouter';

CREATE TABLE IF NOT EXISTS campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  style TEXT NOT NULL DEFAULT 'hybrid', -- open | hybrid | guided
  ruleset JSONB NOT NULL,
  script JSONB, -- roteiro interno do mestre (arcos, eventos canônicos, progresso)
  state JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS characters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, -- player | npc
  name TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  canon BOOLEAN NOT NULL DEFAULT FALSE,
  sheet JSONB NOT NULL DEFAULT '{}',   -- atributos, recursos, habilidades, inventário, rank, xp
  persona JSONB NOT NULL DEFAULT '{}', -- história, personalidade, objetivos, segredos, aparência
  voice JSONB,                          -- { model, voice } escolhida à mão; NULL = padrão pelo sexo
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, name)
);

CREATE TABLE IF NOT EXISTS scenes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  seq INT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'exploration', -- exploration | dialogue | battle | training | downtime
  title TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  state JSONB NOT NULL DEFAULT '{}',
  is_current BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS scenes_campaign_idx ON scenes (campaign_id, seq);

CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  scene_id UUID REFERENCES scenes(id) ON DELETE SET NULL,
  role TEXT NOT NULL, -- player | gm | system | tool
  speaker TEXT,
  content TEXT NOT NULL,
  meta JSONB NOT NULL DEFAULT '{}',
  tokens INT,
  compacted BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_campaign_idx ON messages (campaign_id, id);

CREATE TABLE IF NOT EXISTS npc_chats (
  id BIGSERIAL PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  npc_id UUID NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  session_id UUID NOT NULL,
  role TEXT NOT NULL, -- player | npc
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS npc_chats_idx ON npc_chats (npc_id, session_id, id);
-- mensagem que o NPC mandou por iniciativa própria (npc_message) e o jogador ainda não leu; intent = motivo oculto
ALTER TABLE npc_chats ADD COLUMN IF NOT EXISTS unread BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE npc_chats ADD COLUMN IF NOT EXISTS intent TEXT;

CREATE TABLE IF NOT EXISTS memories (
  id BIGSERIAL PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'event', -- event | npc | discovery | milestone | relationship | directive (subject = escopo)
  subject TEXT,
  content TEXT NOT NULL,
  importance INT NOT NULL DEFAULT 3,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS memories_campaign_idx ON memories (campaign_id, kind);

CREATE TABLE IF NOT EXISTS books (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID REFERENCES campaigns(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  pages INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS book_pages (
  book_id UUID NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  page INT NOT NULL,
  content TEXT NOT NULL,
  PRIMARY KEY (book_id, page)
);

CREATE TABLE IF NOT EXISTS book_chunks (
  id BIGSERIAL PRIMARY KEY,
  book_id UUID NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  page INT NOT NULL,
  chunk_index INT NOT NULL,
  content TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS book_chunks_idx ON book_chunks (book_id, page);

CREATE TABLE IF NOT EXISTS scene_images (
  id BIGSERIAL PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  scene_id UUID,
  prompt TEXT NOT NULL,
  data_url TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- estado antes do último turno, para "gerar novamente" a resposta do Mestre
CREATE TABLE IF NOT EXISTS turn_snapshots (
  campaign_id UUID PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE,
  player_input TEXT NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- vozes antigas do navegador (speechSynthesis) não valem para o TTS do OpenRouter
UPDATE characters SET voice = NULL WHERE voice ? 'voiceName';

-- áudio de fala já gerado (TTS): tocar a mesma fala de novo não cobra outra vez
CREATE TABLE IF NOT EXISTS tts_cache (
  key TEXT PRIMARY KEY, -- sha256 de modelo + voz + texto
  mime TEXT NOT NULL,
  data BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- conversa fora do jogo com o Mestre (jogador como pessoa, não como personagem); não entra na história
CREATE TABLE IF NOT EXISTS gm_notes (
  id BIGSERIAL PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  role TEXT NOT NULL, -- player | gm
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gm_notes_campaign_idx ON gm_notes (campaign_id, id);

-- consultas quentes por campanha (tela de jogo, turno, caixa de entrada, /usage)
CREATE INDEX IF NOT EXISTS memories_campaign_id_idx ON memories (campaign_id, id);
CREATE INDEX IF NOT EXISTS npc_chats_campaign_idx ON npc_chats (campaign_id, id);
CREATE INDEX IF NOT EXISTS scene_images_campaign_idx ON scene_images (campaign_id, id);
CREATE INDEX IF NOT EXISTS api_logs_campaign_idx ON api_logs (campaign_id, created_at DESC);
CREATE INDEX IF NOT EXISTS api_logs_created_idx ON api_logs (created_at DESC);

-- tarefas em segundo plano (perfis de NPC, retratos, mapas 3D, biblioteca): a tela de jogo acompanha por aqui (lib/jobs.ts)
CREATE TABLE IF NOT EXISTS jobs (
  id BIGSERIAL PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,   -- character | portrait | map | library
  target TEXT,          -- o alvo (id do personagem, do local...): duas iguais não rodam juntas
  label TEXT NOT NULL,  -- o que o jogador lê ("Cartógrafo desenhando a Vila da Folha")
  status TEXT NOT NULL DEFAULT 'running', -- running | done | error
  progress JSONB,       -- { done, total }
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_campaign_idx ON jobs (campaign_id, id DESC);

-- biblioteca do mundo (tipo de campanha, Ruleset.world): habilidades e itens, fonte única das fichas
-- (characters.sheet.abilities guarda só { ref: library.id, progress }). Compartilhada por todas as campanhas
-- do mundo; campaign_id só registra onde a entrada nasceu. Excluir = deleted_at (as fichas continuam apontando).
CREATE TABLE IF NOT EXISTS library (
  id BIGSERIAL PRIMARY KEY,
  world TEXT NOT NULL,  -- worldOf(campaign) em library.ts
  campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,   -- ability | item
  name TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '{}', -- LibraryAbility | LibraryItem (types.ts)
  canon BOOLEAN NOT NULL DEFAULT FALSE,
  source TEXT NOT NULL DEFAULT 'agent', -- agent (Criador) | gm (registrada no jogo)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);
-- banco de antes do escopo por mundo: world entra sem NOT NULL porque as linhas antigas ainda não têm mundo;
-- scripts/library-migration.ts preenche e aplica o NOT NULL
ALTER TABLE library ADD COLUMN IF NOT EXISTS world TEXT;
ALTER TABLE library ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE library ALTER COLUMN campaign_id DROP NOT NULL;
DO $$ BEGIN
  -- a FK antiga apagava a biblioteca junto com a campanha (CASCADE); troca só se ainda for a antiga
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'library_campaign_id_fkey' AND confdeltype <> 'n') THEN
    ALTER TABLE library DROP CONSTRAINT library_campaign_id_fkey;
    ALTER TABLE library ADD CONSTRAINT library_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL;
  END IF;
END $$;
DROP INDEX IF EXISTS library_name_idx; -- era único por campanha
CREATE UNIQUE INDEX IF NOT EXISTS library_world_name_idx ON library (world, kind, lower(name)) WHERE deleted_at IS NULL;

-- Criador de aventuras: a entrevista (mensagens) e o ruleset parcial, para retomar depois de um refresh
CREATE TABLE IF NOT EXISTS adventure_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  messages JSONB NOT NULL DEFAULT '[]', -- [{ role: user|assistant, content, choices? }]
  draft JSONB NOT NULL DEFAULT '{}',    -- ruleset parcial (+ startingPoint)
  done BOOLEAN NOT NULL DEFAULT FALSE,  -- o agente fechou e a validação passou
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- retrato do personagem (lib/portrait.ts): imagem do Ilustrador (SVG nos antigos, do Pixel artista aposentado). Fora de characters,
-- que é lido em todo turno; a tela monta a URL com a versão (cache longo)
CREATE TABLE IF NOT EXISTS portraits (
  character_id UUID PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
  mime TEXT NOT NULL,   -- image/svg+xml | image/png...
  data BYTEA NOT NULL,
  version INT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- mapas 3D dos locais (Cartógrafo): spec declarativo (lib/mapSpec.ts) ligado a um lugar de campaigns.state.map;
-- o nome resolve quando o id do lugar muda (junção, gerar novamente). Fora do state, que é lido em todo turno.
CREATE TABLE IF NOT EXISTS maps (
  id BIGSERIAL PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  place_id TEXT NOT NULL,   -- id do lugar no mapa do mundo (l1, l2...)
  place_name TEXT NOT NULL,
  spec JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS maps_campaign_idx ON maps (campaign_id, updated_at DESC);

-- 4ª camada da memória: o chat inteiro em trechos com embedding (coluna em db.ts), para o Mestre consultar com
-- search_history. Turno = ação do jogador + narração (message_id = narração); conversa com NPC = falas do jogador +
-- resposta do NPC (npc_chat_id = resposta). As FKs com CASCADE limpam no "gerar novamente" e ao apagar a campanha.
CREATE TABLE IF NOT EXISTS history_chunks (
  id BIGSERIAL PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  message_id BIGINT UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  npc_chat_id BIGINT UNIQUE REFERENCES npc_chats(id) ON DELETE CASCADE,
  npc TEXT,       -- NPC da conversa particular
  clock INT,      -- relógio do jogo no turno (minutos, lib/clock.ts); NULL = não registrado
  location TEXT,  -- local da cena
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS history_chunks_campaign_idx ON history_chunks (campaign_id, id);

-- correções do registro pelo jogador (lib/corrections.ts), para medir quantos registros dos agentes estavam errados:
-- edição manual na ficha ou desfazer pela etiqueta do Escrivão. Sem FK, como api_logs: a medição fica se a campanha sai
CREATE TABLE IF NOT EXISTS corrections (
  id BIGSERIAL PRIMARY KEY,
  campaign_id UUID NOT NULL,
  source TEXT NOT NULL,   -- manual | desfazer
  agent TEXT,             -- agente do registro original, quando se sabe (scribe no desfazer)
  kind TEXT NOT NULL,     -- ferramenta desfeita (add_item...) ou o que foi corrigido (resource, item, mastery, xp, objective)
  summary TEXT NOT NULL,
  message_id BIGINT,      -- narração do registro desfeito (meta.scribe)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS corrections_campaign_idx ON corrections (campaign_id, created_at);
