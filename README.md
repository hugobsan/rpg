# ⚔ Chronicle RPG

RPG de mesa individual conduzido por IA, com **múltiplos agentes**, **memória persistente em pgvector** e **mecânica configurável** — pré-configurado para o universo de Naruto, mas agnóstico de cenário.

Resolve o problema clássico de jogar RPG em chatbots genéricos: depois de uma campanha longa, o modelo esquece habilidades, níveis, equipamentos, interações com NPCs e confunde o cânone da obra. Aqui, nada disso vive na janela de contexto — vive no banco.

## Como rodar

```bash
cp .env.example .env       # ajuste se necessário
npm install
npm run db:up              # sobe o Postgres + pgvector em container (porta 5433)
npm run dev                # http://localhost:3000
```

Depois, em **Configurações**, informe sua API key do [OpenRouter](https://openrouter.ai/keys). Opcionalmente habilite os embeddings (também via OpenRouter, só escolher o modelo) para busca semântica de verdade — sem eles, o sistema usa full-text search do Postgres como fallback e continua 100% funcional.

O schema do banco é aplicado automaticamente no primeiro acesso — não há passo de migração.

## Arquitetura

```
┌─────────────────────────── Next.js (app único) ───────────────────────────┐
│                                                                            │
│  Telas: Campanhas · Jogo · NPCs · Agentes (+logs) · Configurações          │
│                                                                            │
│  ┌──────────── Motor de turno (SSE) ────────────┐                          │
│  │ 1. monta contexto: ficha + NPCs ativos +     │     ┌────────────────┐   │
│  │    cena + memórias relevantes + arco ativo   │────▶│   OpenRouter   │   │
│  │ 2. loop agêntico do Mestre (tools)           │◀────│  (todos os     │   │
│  │ 3. persiste narração/efeitos                 │     │   agentes)     │   │
│  │ 4. compacta histórico quando estoura budget  │     └────────────────┘   │
│  └──────────────────────────────────────────────┘                          │
│                        │                                                   │
└────────────────────────┼───────────────────────────────────────────────────┘
                         ▼
        ┌─────────── Postgres + pgvector (container) ───────────┐
        │ campanhas · fichas · cenas · mensagens · memórias(vec) │
        │ livros → páginas → chunks(vec) · roteiro · api_logs    │
        └────────────────────────────────────────────────────────┘
```

### Os agentes

Cada agente é um registro editável (modelo + system prompt + parâmetros) na tela **/agents**, com histórico completo de chamadas ao OpenRouter (tokens, duração, request/response) para você avaliar custo e trocar modelos quando quiser.

| Agente | Modelo default | Papel | Por quê |
|---|---|---|---|
| **Mestre** | `openai/gpt-6.1-terra` nos turnos simples, `anthropic/claude-sonnet-5.5` nos complexos (+`:online` quando o Jev pede) | Narra, arbitra, usa ~20 ferramentas (dados, fichas, NPCs, cena, memórias, livros, roteiro) | Narrativa e tool use são o coração do jogo; o modelo caro só entra em batalha/arbitragem |
| **NPC (base)** | `deepseek/deepseek-v4-pro` | Interpreta qualquer NPC em conversas particulares | Ótimo roleplay por uma fração do custo |
| **Roteirista** | `deepseek/deepseek-v4-pro` (+`:online`) | Gera o roteiro interno (arcos, eventos canônicos, ganchos) | Roda raramente; longo e barato |
| **Cronista** | `google/gemini-3.5-flash` | Compacta histórico e extrai memórias estruturadas | Roda com frequência; rápido e barato |
| **Jev (decisões)** | `typesafe/jev-1.14-20261014` | Decide, sem gerar texto: modelo do turno, busca web, memórias relevantes, recusa de NPC, importância de memórias | Modelo de decisão: ~US$0,00005 e <1 s por chamada |
| **Ilustrador** | `google/gemini-3.1-flash-image-preview` | Gera a imagem do ambiente atual sob demanda | Nano Banana 2: qualidade alta, custo baixo |

O seletor de modelos busca a lista viva de `openrouter.ai/api/v1/models` com preço e contexto — os defaults nunca ficam obrigatórios.

### Jev: o modelo de decisão

O Jev (TypeSafe, via [Decisions API do OpenRouter](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request)) não escreve texto: recebe um estado e perguntas tipadas e devolve probabilidades. O código decide com limiares fixos em `src/lib/decisions.ts`. Ele entra em cinco pontos:

1. **Modelo do Mestre por turno**: classifica a ação como simples ou complexa (batalha, regras, vários efeitos, consequência séria). Turno complexo usa o "modelo para turnos complexos" do Mestre (`params.complexModel`, editável em /agents). Se esse campo estiver vazio, o roteamento fica desligado. O modelo é escolhido uma vez e vale para todas as rodadas de ferramentas do turno.
2. **Busca web só quando precisa**: `:online` só liga se o Mestre tiver busca web ativa e o turno depender de um fato da obra que falta no contexto, e só na 1ª rodada do turno (as fontes seguem como texto para as rodadas seguintes).
3. **Recusa de NPC**: no início de uma conversa particular, decide se o NPC toparia conversar agora. Na recusa, o próprio NPC recusa em personagem e a troca não fica gravada; se o jogador insistir, o Jev decide de novo.
4. **Filtro de memórias**: das candidatas recuperadas no código (top-k + mais importantes), só entram as relevantes para a ação. Importância 5 entra sempre.
5. **Importância das memórias** novas (compactação e fim de conversa com NPC): uma nota de 1 a 5 por memória, num lote só.

As decisões 1, 2 e 4 vão numa única chamada antes do turno. Se o Jev falhar (sem chave, erro ou timeout de 7 s), tudo segue o comportamento padrão. Cada chamada aparece no histórico do agente **Jev** em /agents. Ao trocar o modelo do Jev, rode `npx tsx scripts/jev-check.ts` de novo: ele imprime as probabilidades dos casos de probe e confere os casos claros contra os limiares.

### Sistema de memória (o antídoto contra perda de contexto)

1. **Fichas são estado, não texto**: atributos, recursos (HP/chakra), habilidades, inventário, XP e rank vivem em JSONB e só entram no prompt como resumo estruturado. O Mestre **não pode** alterá-los narrando — só via ferramentas (`update_resource`, `add_ability`, `grant_xp`...), então nada "se perde na conversa".
2. **Janela deslizante + compactação**: o histórico recente entra bruto até um budget de tokens (configurável no agente Mestre). Quando o total não-compactado passa do limiar, o Cronista resume o trecho antigo para o `summary` da cena e **extrai memórias atômicas** (eventos, revelações, mudanças de relação) com importância 1–5.
3. **Recuperação por relevância**: a cada turno, a ação do jogador vira query — memórias candidatas (vetorial via pgvector, ou FTS) + memórias mais importantes são filtradas pelo Jev, e só as relevantes entram no contexto. O Mestre também busca ativamente com `search_memories` quando precisa.
4. **Livros com paginação real**: o material enviado é indexado em páginas + chunks com embeddings. O Mestre usa `search_book` (retorna chunks com nº de página) e depois `read_pages` para ler a página inteira, a seguinte/anterior ou um intervalo — quanto consultar é decisão dele.
5. **Roteiro interno**: para campanhas com cânone, o Roteirista monta arcos ancorados na linha do tempo da obra. O Mestre consulta (`get_script`) e anota progresso (`update_script`) — é assim que ele "sabe onde está" no cânone.
6. **NPCs com vida própria**: conversas particulares acontecem com o agente NPC (que pode **recusar** conforme a cena). O NPC guarda a conversa inteira; ao encerrar, o Cronista salva só os pontos importantes como memórias — exatamente o que o Mestre "ficaria sabendo".

### Ritmo por modo de cena

A cena atual tem um modo — `exploration`, `dialogue`, `battle`, `training`, `downtime` — que o Mestre troca via `set_scene`. Cada modo muda as instruções de ritmo (batalha = turnos táticos com recursos honestos; diálogo = falas curtas; treino = progresso incremental com recompensas mecânicas) e a cor/indicador na interface.

### Estilos de campanha

Escolhido na criação: **Aberta** (você descreve tudo livremente), **Híbrida** (opções sugeridas + digitação livre; diálogos sempre livres) ou **Guiada** (o Mestre dá opções concretas e a história fica mais controlada e verossímil).

## Mecânica configurável (agnóstica de cenário)

A mecânica (atributos, barras de recurso, tipos de habilidade, ranks/progressão, campos extras, notas de rolagem e lore) é um JSON importável/exportável. O preset de Naruto está em [`naruto-ruleset.json`](./naruto-ruleset.json) na raiz — chakra, ranks ninja (Genin → Kage), jutsus por categoria, kekkei genkai, elementos, custos de chakra por rank de jutsu.

Para criar outro cenário (Star Wars, D&D, cyberpunk...), copie o JSON, ajuste os campos e importe no assistente de nova campanha. Exportação: aba **Roteiro** da campanha (mecânica ou campanha completa).

## Voz dos NPCs

Cada NPC tem um perfil de voz (voz do navegador, tom, velocidade) configurável no modal do NPC — clique em 🔊 em qualquer fala para ouvi-lo. Usa `speechSynthesis` do navegador: zero custo e zero latência de API.

## Custos sob controle

- Modelos baratos nas tarefas frequentes (Cronista) e caros só onde importa (Mestre).
- Budget de tokens do histórico + compactação evitam requisições monstro.
- Memórias/livros entram por relevância (top-k), nunca inteiros.
- Tela de agentes mostra tokens de cada chamada — dá para auditar o gasto por agente e trocar o modelo em dois cliques.

## Estrutura

```
naruto-ruleset.json        # preset de mecânica de Naruto (importável)
scripts/jev-check.ts       # probe do Jev (rodar ao trocar o modelo de decisão)
docker-compose.yml         # Postgres + pgvector (porta 5433)
src/lib/
  schema.sql               # schema idempotente (aplicado no boot)
  openrouter.ts            # cliente OpenRouter + logging obrigatório em api_logs
  agents.ts                # agentes default (modelos + prompts)
  engine.ts                # turno, contexto, compactação, roteirista
  tools.ts                 # ~20 ferramentas do Mestre
  decisions.ts             # Jev (Decisions API): perguntas, limiares e fallbacks
  npc.ts                   # conversas particulares com NPCs
  retrieval.ts             # busca vetorial com fallback FTS
  books.ts                 # ingestão/paginação/chunking de livros
  ruleset.ts               # mecânica agnóstica + normalização
src/app/                   # telas + rotas de API (Next.js App Router)
```
