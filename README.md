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
│  Telas: Campanhas · Jogo · NPCs · Agentes · Custos e uso · Configurações   │
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

Cada agente é um registro editável (modelo + system prompt + parâmetros) na tela **/agents**. O histórico completo de chamadas ao OpenRouter (custo, tokens, duração, request/response) fica em **/usage** (Custos e uso), para você avaliar o gasto e trocar modelos quando quiser.

| Agente | Modelo default | Papel | Por quê |
|---|---|---|---|
| **Mestre** | `openai/gpt-6.1-terra` nos turnos simples, `anthropic/claude-sonnet-5.5` nos complexos (+`:online` quando o Jev pede) | Narra, arbitra, usa ~20 ferramentas (dados, fichas, NPCs, cena, memórias, livros, roteiro) | Narrativa e tool use são o coração do jogo; o modelo caro só entra em batalha/arbitragem |
| **NPC (base)** | `deepseek/deepseek-v4-pro` | Interpreta qualquer NPC em conversas particulares | Ótimo roleplay por uma fração do custo |
| **Roteirista** | `deepseek/deepseek-v4-pro` (+`:online`) | Gera o roteiro interno (arcos, eventos canônicos, ganchos) | Roda raramente; longo e barato |
| **Cronista** | `google/gemini-3.5-flash` | Compacta histórico e extrai memórias estruturadas | Roda com frequência; rápido e barato |
| **Jev (decisões)** | `typesafe/jev-1.14-20261014` | Decide, sem gerar texto: modelo do turno, busca web, memórias relevantes, recusa de NPC, importância de memórias | Modelo de decisão: ~US$0,00005 e <1 s por chamada |
| **Ilustrador** | `google/gemini-3.1-flash-image-preview` | Gera a imagem do ambiente atual sob demanda | Nano Banana 2: qualidade alta, custo baixo |
| **Voz** | `heygen/heygen-voice-1-turbo:free` | Lê as falas dos NPCs (TTS), com voz padrão por sexo | Grátis e fala português; áudio em cache |

O seletor de modelos busca a lista viva de `openrouter.ai/api/v1/models` com preço e contexto — os defaults nunca ficam obrigatórios.

### Jev: o modelo de decisão

O Jev (TypeSafe, via [Decisions API do OpenRouter](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request)) não escreve texto: recebe um estado e perguntas tipadas e devolve probabilidades. O código decide com limiares fixos em `src/lib/decisions.ts`. Ele entra em cinco pontos:

1. **Modelo do Mestre por turno**: classifica a ação como simples ou complexa (batalha, regras, vários efeitos, consequência séria). Turno complexo usa o "modelo para turnos complexos" do Mestre (`params.complexModel`, editável em /agents). Se esse campo estiver vazio, o roteamento fica desligado. O modelo é escolhido uma vez e vale para todas as rodadas de ferramentas do turno.
2. **Busca web só quando precisa**: `:online` só liga se o Mestre tiver busca web ativa e o turno depender de um fato da obra que falta no contexto, e só na 1ª rodada do turno (as fontes seguem como texto para as rodadas seguintes).
3. **Recusa de NPC**: no início de uma conversa particular, decide se o NPC toparia conversar agora. Na recusa, o próprio NPC recusa em personagem e a troca não fica gravada; se o jogador insistir, o Jev decide de novo.
4. **Filtro de memórias**: das candidatas recuperadas no código (top-k + mais importantes), só entram as relevantes para a ação. Importância 5 entra sempre.
5. **Importância das memórias** novas (compactação e fim de conversa com NPC): uma nota de 1 a 5 por memória, num lote só.

As decisões 1, 2 e 4 vão numa única chamada antes do turno. Se o Jev falhar (sem chave, erro ou timeout de 7 s), tudo segue o comportamento padrão. Cada chamada aparece em /usage, filtrando pelo agente **Jev**. Ao trocar o modelo do Jev, rode `npx tsx scripts/jev-check.ts` de novo: ele imprime as probabilidades dos casos de probe e confere os casos claros contra os limiares.

### Sistema de memória (o antídoto contra perda de contexto)

1. **Fichas são estado, não texto**: atributos, recursos (HP/chakra), habilidades, inventário, XP e rank vivem em JSONB e só entram no prompt como resumo estruturado. O Mestre **não pode** alterá-los narrando — só via ferramentas (`update_resource`, `add_ability`, `grant_xp`...), então nada "se perde na conversa".
2. **Janela deslizante + compactação**: o histórico recente entra bruto até um budget de tokens (configurável no agente Mestre). Quando o total não-compactado passa do limiar, o Cronista resume o trecho antigo para o `summary` da cena e **extrai memórias atômicas** (eventos, revelações, mudanças de relação) com importância 1–5.
3. **Recuperação por relevância**: a cada turno, a ação do jogador vira query — memórias candidatas (vetorial via pgvector, ou FTS) + memórias mais importantes são filtradas pelo Jev, e só as relevantes entram no contexto. O Mestre também busca ativamente com `search_memories` quando precisa.
4. **Livros com paginação real**: o material enviado é indexado em páginas + chunks com embeddings. O Mestre usa `search_book` (retorna chunks com nº de página) e depois `read_pages` para ler a página inteira, a seguinte/anterior ou um intervalo — quanto consultar é decisão dele.
5. **Roteiro interno**: para campanhas com cânone, o Roteirista monta arcos ancorados na linha do tempo da obra. O Mestre consulta (`get_script`) e anota progresso (`update_script`) — é assim que ele "sabe onde está" no cânone.
6. **NPCs com vida própria**: conversas particulares acontecem com o agente NPC (que pode **recusar** conforme a cena). O NPC guarda a conversa inteira; ao encerrar, o Cronista salva só os pontos importantes como memórias — exatamente o que o Mestre "ficaria sabendo".

**NPC que chama o jogador**: quando o NPC tem algo a contar, um pedido, um aviso ou um segredo, o Mestre usa `npc_message` (mensagem em personagem + motivo oculto). A mensagem chega à caixa de entrada (`inbox` no `GET /api/campaigns/[id]`, evento `npc_message` no turno); ao abrir o NPC, o modal entra nessa conversa e a marca como lida. A conversa não passa pela recusa do Jev, o agente do NPC recebe o motivo no contexto e, ao encerrar, o Cronista salva as memórias como sempre. O "gerar novamente" desfaz a mensagem. Verificação: `npx tsx scripts/npc-message-check.ts`.

**Conversa fora do jogo**: o botão "💬 Falar com o Mestre (fora do jogo)" abre uma conversa sua, como jogador, com o Mestre (`gm_notes`, fora da história, do histórico do turno e do "gerar novamente"); ele responde sem spoilers e sem mexer no jogo, e orientações viram diretrizes (memória `directive`, permanentes ou só nesta cena e na próxima) que entram em todo turno em "DIRETRIZES DO JOGADOR" até você desativá-las no ✕.

### Ritmo por modo de cena

A cena atual tem um modo — `exploration`, `dialogue`, `battle`, `training`, `downtime` — que o Mestre troca via `set_scene`. Cada modo muda as instruções de ritmo (batalha = turnos táticos com recursos honestos; diálogo = falas curtas; treino = progresso incremental com recompensas mecânicas) e a cor/indicador na interface.

### Elenco da cena

Só os NPCs em cena entram inteiros no prompt do Mestre. Ao abrir cena nova ou mudar de local, o Mestre informa em `set_scene` a lista `present` (todos os NPCs que estão no novo lugar): quem fica de fora sai de cena e quem é listado volta. Se ele esquecer, depois da narração o Jev julga, para cada NPC em cena que não falou, se ele continua ali (foi embora, ficou para trás, morreu); quem não continua sai. Isso roda todo turno com NPC calado em cena (custa ~US$0,00005 e corre junto do relógio, depois da narração) e, se o Jev falhar, ninguém sai. NPC registrado fora de cena que fala na narração (`**Nome:**`) volta sozinho, sem IA. Verificação: `npx tsx scripts/cast-check.ts`.

### Relógio do jogo

A história tem dia e hora (`campaigns.state.clock`, minutos desde o "Dia 1, 00:00" da campanha; helpers em `src/lib/clock.ts`). O banner da cena mostra "Dia 1 · 08:40 · manhã" e a hora entra no contexto do Mestre a cada turno. O Mestre avança o relógio com `advance_time` (quanto a interação levou) e fixa com `set_time` (abertura e saltos como "na manhã seguinte"). Se ele esquecer, o Jev escolhe uma faixa de tempo (quase nada, alguns minutos, ~15 min, ~1 h, algumas horas, meio dia ou mais) e o código soma os minutos da faixa; se o Jev falhar, o relógio não anda. O "gerar novamente" volta o relógio junto com o resto do turno, e a imagem do ambiente usa o período do dia.

**Missões e prazos** (`campaigns.state.objectives`, aba **Missões**): o Mestre registra missões, eventos marcados e compromissos com `add_objective` (prazo absoluto ou relativo, em tempo do jogo) e conclui ou cancela com `update_objective`; toda mudança do relógio passa por `saveClock`, que marca como perdido o que venceu (treinar ou viajar demais faz perder a missão) e avisa o Mestre para narrar a consequência. Verificação: `npx tsx scripts/objectives-check.ts`.

### Estilos de campanha

Escolhido na criação: **Aberta** (você descreve tudo livremente), **Híbrida** (opções sugeridas + digitação livre; diálogos sempre livres) ou **Guiada** (o Mestre dá opções concretas e a história fica mais controlada e verossímil).

## Mecânica configurável (agnóstica de cenário)

A mecânica (atributos, barras de recurso, tipos de habilidade, ranks/progressão, campos extras, notas de rolagem e lore) é um JSON importável/exportável. O preset de Naruto está em [`naruto-ruleset.json`](./naruto-ruleset.json) na raiz — chakra, ranks ninja (Genin → Kage), jutsus por categoria, kekkei genkai, elementos, custos de chakra por rank de jutsu.

Para criar outro cenário (Star Wars, D&D, cyberpunk...), copie o JSON, ajuste os campos e importe no assistente de nova campanha. Exportação: aba **Roteiro** da campanha (mecânica ou campanha completa).

### Regras e progressão

As contas ficam no servidor (`src/lib/progression.ts`); o Mestre só escolhe a CD e as horas. Os parâmetros ficam no ruleset, com padrão no código para rulesets antigos.

- **Domínio do jutsu (0–100%)**: todo jutsu tem o seu, mostrado na aba Jutsus com o custo efetivo e o bônus. Kit do rank: 60%; registrado na hora do uso: 10–25% (padrão 15); extras da criação: 30%; sem valor (fichas antigas, NPCs): tratado como 50%.
  - Bônus no teste (`masteryBonus`): até 24% +0, 25–49% +1, 50–74% +2, 75–99% +3, 100% +4.
  - Custo (`masteryCost`): abaixo de 25% +50% (arredonda para cima); com 100% −25% (arredonda para baixo); no meio, o custo normal.
- **`use_ability`**: o Mestre resolve técnica da ficha com ela. Desconta o custo ajustado (sem recurso, falha sem rolar), rola 1d20 + atributo × `attributeMultiplier` + bônus do domínio contra a CD (mesmo evento de dados do `roll_dice`: chip verde/vermelho e animação 3D) e sobe o domínio pelo uso (+5/+4/+3/+2 conforme a faixa). O atributo padrão vem do tipo (`abilityAttributes`, ou o atributo de mesma key).
- **Cargo × nível de poder**: o cargo (`ranks`: Estudante da Academia, Genin…) é posição na história e só muda com `set_rank`. O nível de poder (`powerLevels`) vem só da XP, sobe sozinho e dá o teto dos atributos (Estudante 5, Genin 6, Chunin 7, Jounin Especial 8, Jounin 9, Kage 10). Sem `powerLevels`, os `ranks` servem de níveis, sem teto.
- **Pontos livres**: 1 a cada `xpPerAttributePoint` (50) XP. O jogador gasta na **Ficha** (botão + por atributo; a rota `POST /api/campaigns/[id]/attributes` valida saldo e teto e grava uma memória para o Mestre). Atributo que veio da criação acima do teto fica como está e só sobe quando o nível permitir. `update_attribute` do Mestre também recusa aumento acima do teto; reduções são livres.
- **Treino (`train`)**: avança o relógio pelas horas (pela `saveClock`, então prazos de missão vencem no treino) e só então aplica o ganho. Jutsu: +3 por hora até 49%, +2 até 74%, +1 a partir de 75%. Atributo: +1 a cada 20 h × valor atual, até o teto (no teto, as horas não acumulam). Limites (`training`): 10 h de treino por dia do jogo e +25% de domínio por jutsu por dia, somando treino e uso. Acima disso, o treino é recusado (exausto) e o relógio não anda.

Verificação sem IA: `npx tsx scripts/progression-check.ts`.

## Voz dos NPCs

Clique em 🔊 numa fala de NPC (no chat do Mestre, linhas `**Nome:** "fala"`, ou na conversa particular) para ouvi-la. A voz vem de um modelo de fala (TTS) do OpenRouter, escolhido no agente **Voz** em /agents junto com a voz masculina e a feminina padrão. O padrão é `heygen/heygen-voice-1-turbo:free` (grátis, fala português), com `lucian` (masculina) e `nadine` (feminina).

- Cada NPC usa a voz padrão do seu sexo (`persona.gender`). O Mestre informa o sexo ao criar o NPC; nos NPCs antigos, o Jev decide pelo nome, persona e obra na primeira fala e o app grava. Sexo desconhecido usa a voz masculina.
- No modal do NPC (aba 🔊) dá para trocar o sexo, escolher qualquer voz do modelo atual e ouvir uma prévia.
- Só a fala é lida (os trechos entre aspas, sem o nome e sem markdown). O áudio fica em `tts_cache`: ouvir a mesma fala de novo não chama o OpenRouter.

## Custos sob controle

- Modelos baratos nas tarefas frequentes (Cronista) e caros só onde importa (Mestre).
- Budget de tokens do histórico + compactação evitam requisições monstro.
- Memórias/livros entram por relevância (top-k), nunca inteiros.
- Tela **Custos e uso** (`/usage`): custo, chamadas, erros, tempo e tokens somados, por agente, por modelo e por dia, com filtros de agente, período, campanha e modelo (na URL) e o histórico paginado com request/response.

## Estrutura

```
naruto-ruleset.json        # preset de mecânica de Naruto (importável)
scripts/jev-check.ts       # probe do Jev (rodar ao trocar o modelo de decisão)
scripts/progression-check.ts # checagem da progressão (domínio, nível, teto, treino) sem IA
docker-compose.yml         # Postgres + pgvector (porta 5433)
src/lib/
  schema.sql               # schema idempotente (aplicado no boot)
  openrouter.ts            # cliente OpenRouter + logging obrigatório em api_logs
  agents.ts                # agentes default (modelos + prompts)
  engine.ts                # turno, contexto, compactação, roteirista
  tools.ts                 # ~20 ferramentas do Mestre
  decisions.ts             # Jev (Decisions API): perguntas, limiares e fallbacks
  tts.ts                   # voz dos NPCs (TTS do OpenRouter) + cache de áudio
  npc.ts                   # conversas particulares com NPCs
  retrieval.ts             # busca vetorial com fallback FTS
  books.ts                 # ingestão/paginação/chunking de livros
  ruleset.ts               # mecânica agnóstica + normalização
  progression.ts           # domínio, nível de poder, pontos livres, teto e treino
src/app/                   # telas + rotas de API (Next.js App Router)
```
