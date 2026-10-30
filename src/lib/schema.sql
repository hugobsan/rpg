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
  voice JSONB,                          -- { voiceName, pitch, rate, lang }
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

CREATE TABLE IF NOT EXISTS memories (
  id BIGSERIAL PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'event', -- event | npc | discovery | milestone | relationship
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
