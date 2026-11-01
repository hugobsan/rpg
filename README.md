# ⚔ Chronicle RPG

RPG de mesa individual conduzido por IA, com **múltiplos agentes**, **memória persistente em pgvector** e **mecânica configurável** — pré-configurado para o universo de Naruto, mas agnóstico de cenário.

Resolve o problema clássico de jogar RPG em chatbots genéricos: depois de uma campanha longa, o modelo esquece habilidades, níveis, equipamentos, interações com NPCs e confunde o cânone da obra. Aqui, nada disso vive na janela de contexto — vive no banco.

https://github.com/user-attachments/assets/c9d0b1a6-0587-45f9-834e-c3af30bd950a

## Como rodar

```bash
cp .env.example .env       # ajuste se necessário
npm install
npm run db:up              # sobe o Postgres + pgvector em container (porta 5433)
npm run dev                # http://localhost:3000
```

Depois, em **Configurações** > Fontes de modelos, informe sua API key do [OpenRouter](https://openrouter.ai/keys). Opcionalmente habilite os embeddings (também via OpenRouter, só escolher o modelo) para busca semântica de verdade — sem eles, o sistema usa full-text search do Postgres como fallback e continua 100% funcional.

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

Cada agente é um registro editável (fonte + modelo + system prompt + parâmetros) na tela **/agents**. As fontes e as chaves ficam num lugar só, em **Configurações > Fontes de modelos**: o OpenRouter (embutido, padrão) e qualquer API compatível com a da OpenAI (nome, URL base e API key; OpenAI, Anthropic, Gemini e OpenCode já vêm com a URL, só falta a chave). Em /agents, Salvar agente (ou Ctrl+S com o card aberto) grava e recolhe o card; cada agente escolhe a sua fonte, inclusive Jev, Voz e Ilustrador, que chamam na fonte o mesmo caminho que usam no OpenRouter; a fonte dos embeddings fica logo abaixo, nas Configurações.

**Presets de fonte** (topo de /agents, `settings.agentPresets`): para trocar todos os agentes de fonte quando o saldo aperta (ex.: OpenAI pelo plano do ChatGPT → Anthropic pela API key → OpenRouter). Deixe os agentes como quer e clique em Salvar configuração atual com um nome; o preset guarda fonte, modelo, modelo de turnos complexos do Mestre, cache e busca web de cada agente. Aplicar passa cada agente pelo mesmo PUT do Salvar agente (valida e busca o preço) e só mexe em quem está diferente; Atualizar regrava o preset com a configuração atual; "em uso" marca o preset igual aos agentes. Jev, Ilustrador e Voz ficam fora (`PRESET_FIXED` em `src/lib/agentPresets.ts`): dependem do OpenRouter.

**Login com ChatGPT** (preview): a fonte OpenAI pode usar o plano do ChatGPT em vez da API key (Sign in with ChatGPT para apps open source locais). Em Configurações > Fontes de modelos, adicione a fonte OpenAI com a autenticação "Login com ChatGPT" e clique em **Continuar com o ChatGPT**; o retorno vem em `http://127.0.0.1:3000/auth/callback` e os tokens ficam só no banco local, renovados sozinhos. Os agentes de texto dessa fonte vão pela Responses API (`src/lib/responsesApi.ts`); temperatura e máximo de tokens são ignorados, e Ilustrador, Voz, Jev e embeddings não funcionam nela. No Plus, o limite de 5 h é dividido com os outros apps que usam o plano; uso e limites em [chatgpt.com/settings/usage](https://chatgpt.com/settings/usage). Verificação sem IA: `npx tsx scripts/chatgpt-auth-check.ts`. O histórico completo de chamadas (fonte, custo, tokens, duração, request/response) fica em **/usage** (Custos e uso), para você avaliar o gasto e trocar modelos quando quiser; o OpenRouter informa o custo real, e o das outras fontes é estimado pelo preço do mesmo modelo no catálogo do OpenRouter.

| Agente | Modelo default | Papel | Por quê |
|---|---|---|---|
| **Mestre** | `openai/gpt-6.1-terra` nos turnos simples, `anthropic/claude-sonnet-5.5` nos complexos (+`:online` quando o Jev pede) | Narra, arbitra, usa ~24 ferramentas (dados, técnicas, treino, NPCs, cena, livros, roteiro, mapas); as anotações rodam depois da narração e o registro das fichas fica com o Escrivão | Narrativa e tool use são o coração do jogo; o modelo caro só entra em batalha/arbitragem |
| **NPC (base)** | `deepseek/deepseek-v4-pro` | Interpreta qualquer NPC em conversas particulares | Ótimo roleplay por uma fração do custo |
| **Roteirista** | `deepseek/deepseek-v4-pro` (+`:online`) | Gera o roteiro interno (arcos, eventos canônicos, ganchos) | Roda raramente; longo e barato |
| **Cronista** | `google/gemini-3.5-flash` | Compacta histórico e extrai memórias estruturadas | Roda com frequência; rápido e barato |
| **Escrivão** | `google/gemini-3.5-flash` (raciocínio baixo) | Depois de cada narração, registra o que ela estabeleceu: dano, cura e gasto, itens, XP, domínio por evento, campos da ficha, memórias e missões (das anotações `note_objective` do Mestre, com o prazo certo) | Tira do Mestre as ferramentas de anotação, que custavam outra rodada com o prompt inteiro dele; ~US$0,001 e 1 a 3 s por turno, antes do fim do turno |
| **Ações rápidas** | `google/gemini-3.5-flash` (raciocínio baixo) | No botão Ações rápidas do campo da ação, sugere 4 a 5 ações pela cena, pelas últimas mensagens e pela ficha (técnicas e itens pelo nome); elas aparecem no lugar das opções do Mestre, nos mesmos cartões (clicar envia, lápis edita). Não muda nada no jogo | Só quando o jogador pede; ~US$0,005 por pedido. Para pôr um jutsu ou item no campo, o botão Usar fica no card dele na lateral |
| **Jev (decisões)** | `typesafe/jev-1.14-20261014` | Decide, sem gerar texto: modelo do turno, busca web, memórias relevantes, recusa de NPC, importância de memórias | Modelo de decisão: ~US$0,00005 e <1 s por chamada |
| **Ilustrador** | `google/gemini-3.1-flash-image-preview` | Gera a imagem do ambiente atual e o retrato dos personagens, sob demanda. Aceita qualquer modelo de imagem do OpenRouter: os que só geram imagem (FLUX, Recraft...) vão pelo POST /images do OpenRouter (o catálogo diz quem é), e o resultado pode ser PNG, JPEG, WebP, GIF ou SVG (servido sem rodar nada). No card, "Reescrever o prompt" escolhe um modelo de texto que deixa o prompt curto e em inglês antes de gerar | Nano Banana 2: qualidade alta, custo baixo |
| **Voz** | `heygen/heygen-voice-1-turbo:free` | Lê as falas dos NPCs (TTS), com voz padrão por sexo | Grátis e fala português; áudio em cache |
| **Criador de personagens** | `nvidia/nemotron-3.5-super-vl:free` | Monta em segundo plano o perfil rico e a ficha de cada NPC novo (`create_npc`) e do botão Refazer perfil, a partir da biblioteca | Grátis; raciocina antes (~1,5 min por NPC), fora do turno |
| **Criador de aventuras** | `nvidia/nemotron-3.5-super-vl:free` | Entrevista o jogador e monta o JSON de uma aventura nova (Criar com IA) | Grátis; raciocina antes de responder (rodada de 1 a 2 min) |
| **Criador de habilidades** | `nvidia/nemotron-3.5-super-vl:free` | Cria técnicas (jutsus, feitiços...) para a biblioteca: na hora, quando o `add_ability` pede uma que não existe, e em lotes no segundo plano | Grátis; prazo de 90 s dentro do turno |
| **Criador de itens** | `nvidia/nemotron-3.5-super-vl:free` | Cria ferramentas, armas e consumíveis para a biblioteca, em lotes | Grátis |
| **Cartógrafo** | `anthropic/claude-opus-5.5` (raciocínio médio) | Compõe o mapa 3D de um lugar como descrição declarativa (relevo, contornos, caminhos, espalhamento, materiais, luz, pontos de interesse) | ~US$0,14 por mapa novo e US$0,18 por edição; só gera quando pedido |
| **Topógrafo** | `google/gemini-3.5-flash` (raciocínio baixo) | Recebe do Mestre uma frase sobre o que mudou no espaço (`map_brief`) e chama as ferramentas do mapa: palco (`set_stage`), mapa do mundo (`update_map`) e mapa 3D (`local_map`, pelo Cartógrafo) | Tira os esquemas e as regras do mapa de toda chamada do Mestre (~1,6 mil tokens); ~US$0,002 e poucos segundos por brief |

O seletor de modelos busca a lista viva de `openrouter.ai/api/v1/models` com preço e contexto — os defaults nunca ficam obrigatórios.

### Jev: o modelo de decisão

O Jev (TypeSafe, via [Decisions API do OpenRouter](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request)) não escreve texto: recebe um estado e perguntas tipadas e devolve probabilidades. O código decide com limiares fixos em `src/lib/decisions.ts`. Ele entra em cinco pontos:

1. **Modelo do Mestre por turno**: classifica a ação como simples ou complexa (batalha, regras, vários efeitos, consequência séria). Turno complexo usa o "modelo para turnos complexos" do Mestre (`params.complexModel`, editável em /agents). Se esse campo estiver vazio, o roteamento fica desligado. O modelo é escolhido uma vez e vale para todas as rodadas de ferramentas do turno.
2. **Busca web só quando precisa**: `:online` só liga se o Mestre tiver busca web ativa e o turno depender de um fato da obra que falta no contexto, e só na 1ª rodada do turno (as fontes seguem como texto para as rodadas seguintes).
3. **Recusa de NPC**: no início de uma conversa particular, decide se o NPC toparia conversar agora. Na recusa, o próprio NPC recusa em personagem e a troca não fica gravada; se o jogador insistir, o Jev decide de novo.
4. **Filtro de memórias**: das candidatas recuperadas no código (top-k + mais importantes), só entram as relevantes para a ação. Importância 5 entra sempre. Até 2 trechos antigos do chat (a 4ª camada da memória, abaixo) passam pela mesma pergunta com limiar mais alto; se o Jev falhar, nenhum entra.
5. **Importância das memórias** novas (compactação e fim de conversa com NPC): uma nota de 1 a 5 por memória, num lote só.

As decisões 1, 2 e 4 vão numa única chamada antes do turno. Se o Jev falhar (sem chave, erro ou timeout de 7 s), tudo segue o comportamento padrão. Cada chamada aparece em /usage, filtrando pelo agente **Jev**. Ao trocar o modelo do Jev, rode `npx tsx scripts/jev-check.ts` de novo: ele imprime as probabilidades dos casos de probe e confere os casos claros contra os limiares.

### Sistema de memória (o antídoto contra perda de contexto)

1. **Fichas são estado, não texto**: atributos, recursos (HP/chakra), habilidades, inventário, XP e rank vivem em JSONB e só entram no prompt como resumo estruturado. O Mestre **não pode** alterá-los narrando — só via ferramentas (`use_ability`, `train`, `add_ability`...) e pelo **Escrivão**, que depois de cada narração registra com as mesmas ferramentas o que ela estabeleceu (`update_resource`, `add_item`, `grant_xp`, `add_memory`...), então nada "se perde na conversa".
2. **Janela de histórico + compactação**: o histórico recente entra bruto até um budget de tokens (configurável no agente Mestre). O começo da janela só anda em saltos de meio budget, para ficar igual por vários turnos; no prompt do Mestre a ordem é prefixo fixo, histórico e, por último, o contexto do turno (cena, fichas, memórias), assim o cache de prompt (Claude, com pontos de 1 h, e o automático da OpenAI) reaproveita o histórico de um turno para o outro. Verificação sem IA: `npx tsx scripts/cache-check.ts`. Quando o total não-compactado passa do limiar, o Cronista resume o trecho antigo para o `summary` da cena e **extrai memórias atômicas** (eventos, revelações, mudanças de relação) com importância 1–5.
3. **Recuperação por relevância**: a cada turno, a ação do jogador vira query — memórias candidatas (vetorial via pgvector, ou FTS) + memórias mais importantes são filtradas pelo Jev, e só as relevantes entram no contexto. O Mestre também busca ativamente com `search_memories` quando precisa.
4. **Histórico completo no banco vetorial (4ª camada)**: além da janela recente, do resumo da cena e das memórias, o chat inteiro fica em `history_chunks`: cada turno (ação do jogador + narração do Mestre) e cada troca de conversa particular com NPC (marcada com o NPC) vira um trecho com embedding, dia e hora do jogo e local. É gravado depois da narração, sem atrasar a resposta; sem embeddings fica o texto e a busca cai no full-text. O Mestre consulta com `search_history` (query e NPC opcional) para lembrar exatamente o que alguém disse ou fez, ou um detalhe antigo que não virou memória, e recebe trechos curtos, cortados em volta do que bate com a busca e marcados como o que aconteceu naquele momento (ficha e memórias atuais valem mais). A cada turno, até 2 trechos antigos (fora da janela recente) muito parecidos com a ação entram como candidatos na mesma pergunta do Jev e só passam com folga; se o Jev falhar, nenhum entra. O "gerar novamente" e apagar a campanha limpam os trechos (FK com CASCADE). Para vetorizar o histórico de antes: `npx tsx scripts/history-backfill.ts`; o Reprocessar das Configurações refaz esses vetores junto com memórias e livros. Verificação sem IA: `npx tsx scripts/history-check.ts`.
5. **Livros com paginação real**: o material enviado é indexado em páginas + chunks com embeddings. O Mestre usa `search_book` (retorna chunks com nº de página) e depois `read_pages` para ler a página inteira, a seguinte/anterior ou um intervalo — quanto consultar é decisão dele.
6. **Roteiro interno**: para campanhas com cânone, o Roteirista monta arcos ancorados na linha do tempo da obra. O Mestre consulta (`get_script`) e anota progresso (`update_script`) — é assim que ele "sabe onde está" no cânone.
7. **NPCs com vida própria**: conversas particulares acontecem com o agente NPC (que pode **recusar** conforme a cena). O NPC guarda a conversa inteira; ao encerrar, o modal fecha na hora e o Cronista salva em segundo plano (tarefa `npc-memory`, no cabeçalho) só os pontos importantes como memórias — exatamente o que o Mestre "ficaria sabendo".

**Configurações avançadas** (fim de **Configurações**, recolhidas): os parâmetros de recuperação e indexação por cenário, com nomes técnicos de propósito. Memórias: kNN top-k, top-k por importância, limiar de distância de cosseno, gate do Jev, importância que pula o gate, top-k do `search_memories` e do NPC. Histórico (`history_chunks`, um chunk por turno, sem overlap): janela do trecho devolvido, top-k do `search_history`, top-k e limiar de distância da recuperação automática, gate do Jev, batch. Livros: chunk size e chunk overlap (em caracteres), top-k do `search_book`, páginas por `read_pages`. Embeddings: `dimensions` (truncamento Matryoshka, enviado no POST /embeddings; 0 = nativa) e batch. Jev: os limiares das decisões, calibrados pelo `jev-check.ts`. Os padrões são os valores medidos no código, e o banco (`settings.advanced`) guarda só o que difere deles. Chunk size, overlap e dimensões exigem **Reprocessar embeddings**, que refaz os chunks dos livros a partir de `book_pages` e avisa se o modelo ignorou `dimensions`; até lá a busca compara só vetores da mesma dimensão da consulta. Rota: `GET/PUT /api/settings/advanced`. Verificação sem IA (num banco descartável): `npx tsx scripts/advanced-check.ts`.

**NPC que chama o jogador**: quando o NPC tem algo a contar, um pedido, um aviso ou um segredo, o Mestre usa `npc_message` (mensagem em personagem + motivo oculto). A mensagem chega à caixa de entrada (`inbox` no `GET /api/campaigns/[id]`, evento `npc_message` no turno); ao abrir o NPC, o modal entra nessa conversa e a marca como lida. A conversa não passa pela recusa do Jev, o agente do NPC recebe o motivo no contexto e, ao encerrar, o Cronista salva as memórias como sempre. O "gerar novamente" desfaz a mensagem. Verificação: `npx tsx scripts/npc-message-check.ts`.

**NPC novo (Criador de personagens)**: o `create_npc` do Mestre só registra, na hora, nome, sexo, canon e um brief (quem é, papel, o que já foi narrado), porque o portão de NPC exige o registro antes da narração. Em segundo plano (tarefa `character`, no cabeçalho), o agente **Criador de personagens** monta o perfil rico (aparência, idade, papel, personalidade, jeito de falar, passado, objetivos, segredos, relações, manias) e a ficha coerente com o cargo e o nível de poder, preferindo as habilidades e os itens da biblioteca da campanha (habilidade que falta vai para o Criador de habilidades e fica guardada lá). A gravação trava a linha e faz merge com a foto do registro: o que o Mestre mudou no meio tempo fica (cargo, habilidade nova, máximo de recurso; dano e gasto continuam descontados do máximo novo) e o sexo nunca muda. O retrato não é gerado sozinho: fica para o botão Gerar retrato. No modal do NPC, a aba **Perfil** mostra tudo menos os segredos, e **Refazer perfil** roda o Criador de novo mantendo o que já é fato (bom para NPCs antigos). O Mestre vê o perfil enxuto na ficha da cena (completo no `get_character`); o agente do NPC recebe tudo. Verificação sem IA: `npx tsx scripts/characters-check.ts`.

**Abaixo da última resposta do Mestre**: o ícone ↻ gera a resposta de novo (desfaz o turno pela foto em `turn_snapshots`, com motivo opcional); **Continuar** manda a ação interna `(continuar a cena)` (`src/lib/continueScene.ts`, salva mas não exibida no chat; depois dela não há o que editar) e o Mestre segue a cena sem o seu personagem agir, ou, se a narração anterior esperava algo de você, responde só uma linha curta ("Ele ainda espera sua resposta."); o lápis embaixo da sua última mensagem a edita no lugar: o turno é desfeito e o Mestre responde ao texto novo (`POST /turn` com `regenerate` e `input`).

**Conversa fora do jogo**: o botão "💬 Falar com o Mestre (fora do jogo)" abre uma conversa sua, como jogador, com o Mestre (`gm_notes`, fora da história, do histórico do turno e do "gerar novamente"); ele responde sem spoilers e sem mexer no jogo, e orientações viram diretrizes (memória `directive`, permanentes ou só nesta cena e na próxima) que entram em todo turno em "DIRETRIZES DO JOGADOR" até você desativá-las no ✕.

### Anotações depois da narração e Escrivão

Cada ferramenta que o Mestre chama obriga outra rodada com o prompt inteiro (~35 mil tokens), e a maioria era anotação cujo resultado ele não precisa para narrar. Agora as anotações (`DEFERRED_TOOLS` em `src/lib/tools.ts`: `set_scene`, `set_npc_active`, `set_rank`, `update_script`, `note_objective`) só rodam depois da narração: se a resposta traz narração e só anotações, o turno acaba ali, sem outra chamada; numa rodada mista ou sem texto, a anotação responde "Anotado" na hora e as outras ferramentas rodam como sempre. Depois que a narração é salva e enviada, e antes do fim do turno (o "gerar novamente" não cruza com elas), rodam as anotações e, em paralelo, o relógio do Jev seguido do **Escrivão**, o local e o elenco. O Escrivão lê a ação, a narração, o que as ferramentas do Mestre já fizeram (dados, `use_ability`, que já cobrou o custo, `train`) e um estado compacto (fichas do jogador e dos NPCs em cena, missões com id, hora) e registra só o que a narração estabeleceu, numa chamada com as ferramentas em paralelo (uma segunda só se alguma deu erro). `update_resource`, `add_item`, `remove_item`, `add_memory`, `grant_xp`, `update_ability_progress`, `update_extra_field`, `add_objective`, `update_objective` e `advance_time` saíram do turno do Mestre, mas continuam na conversa fora do jogo para corrigir o que for preciso. Verificação sem IA: `npx tsx scripts/scribe-check.ts`.

### Ritmo por modo de cena

A cena atual tem um modo — `exploration`, `dialogue`, `battle`, `training`, `downtime` — que o Mestre troca via `set_scene`. Cada modo muda as instruções de ritmo (batalha = turnos táticos com recursos honestos; diálogo = falas curtas; treino = progresso incremental com recompensas mecânicas) e a cor/indicador na interface.

### Elenco da cena

Só os NPCs em cena entram inteiros no prompt do Mestre. Ao abrir cena nova ou mudar de local, o Mestre informa em `set_scene` a lista `present` (todos os NPCs que estão no novo lugar): quem fica de fora sai de cena e quem é listado volta. Se ele esquecer, depois da narração o Jev julga, para cada NPC em cena que não falou, se ele continua ali (foi embora, ficou para trás, morreu); quem não continua sai. Isso roda todo turno com NPC calado em cena (custa ~US$0,00005 e corre junto do relógio, depois da narração) e, se o Jev falhar, ninguém sai. NPC registrado fora de cena que fala na narração (`**Nome:**`) volta sozinho, sem IA.

O local também tem rede de segurança: se o Mestre não trocou o local no turno, o Jev julga se a narração levou o jogador a outro lugar; se levou, o Cronista dá o nome ("Casa do Ren, Konoha", reaproveitando os nomes do mapa) e o código aplica pelo mesmo `set_scene`, então o mapa e o cabeçalho acompanham. Isso roda antes do elenco, que já julga quem ficou para trás no lugar novo (inclusive quem falou antes de o jogador sair). Falha em qualquer passo = nada muda. Verificação: `npx tsx scripts/cast-check.ts`.

### Relógio do jogo

A história tem dia e hora (`campaigns.state.clock`, minutos desde o "Dia 1, 00:00" da campanha; helpers em `src/lib/clock.ts`). O banner da cena mostra "Dia 1 · 08:40 · manhã" e a hora entra no contexto do Mestre a cada turno. O Mestre fixa o relógio com `set_time` (abertura e saltos como "na manhã seguinte") e o `train` avança pelas horas treinadas; nos outros turnos, depois da narração, o Jev escolhe uma faixa de tempo (quase nada, alguns minutos, ~15 min, ~1 h, algumas horas, meio dia ou mais) e o código soma os minutos da faixa; se o Jev falhar, o relógio não anda. O "gerar novamente" volta o relógio junto com o resto do turno, e a imagem do ambiente usa o período do dia.

**Missões e prazos** (`campaigns.state.objectives`, aba **Missões**): o Mestre anota numa frase com `note_objective` a missão, o evento marcado ou o compromisso que a história criou, cumpriu ou cancelou ("Hokage deu a missão de escoltar o Tazuna, prazo de 3 dias; recompensa 30 mil ryō") e o Escrivão registra com `add_objective` (prazo absoluto ou relativo, em tempo do jogo) ou `update_objective`; fora do jogo o Mestre usa as duas direto; toda mudança do relógio passa por `saveClock`, que marca como perdido o que venceu (treinar ou viajar demais faz perder a missão) e avisa o Mestre para narrar a consequência. Verificação: `npx tsx scripts/objectives-check.ts`.

### Mapa do mundo e palco da cena

O mapa (`campaigns.state.map`, `src/lib/map.ts`) se monta sozinho: todo `set_scene` com local novo registra o lugar e a rota a partir do anterior. "Sala 3, Academia, Konoha" vira uma cadeia (a sala dentro da academia, dentro de Konoha), e variações de nome caem no mesmo lugar ("a Academia" = "Academia Ninja de Konoha"; "Konoha" não). O tipo sai do nome (floresta, torre, casa...) e vira o ícone. Campanhas antigas montam o mapa inicial com as cenas passadas. O Mestre não carrega as ferramentas do mapa: manda um `map_brief` (uma frase, ex.: "o jogador ouviu falar da Vila da Névoa, ao sul, dois dias de barco") e o **Topógrafo**, um agente barato, traduz em `update_map` (tipo, descrição, local que contém, outros nomes, direção e distância em relação a outro local, rotas com tempo de viagem). O resultado é só informativo para o Mestre, que narra sem esperar por ele. Fora do jogo o Mestre continua com `update_map`, `set_stage` e `local_map` diretos, para correções exatas pedidas pelo jogador. As posições são calculadas pelo código (a dica do Mestre ou o primeiro ponto livre em volta do vizinho) e os locais já posicionados não se mexem.

O palco (`scenes.state.stage`, ferramenta `set_stage`) guarda as zonas do lugar e onde cada personagem está em relação ao jogador: distância (corpo a corpo, perto, médio, longe), postura (aliado, hostil, neutro), cobertura e elevação. É o que mantém a batalha coerente entre os turnos: o Mestre manda um `map_brief` no começo da luta e a cada movimento relevante ("Bandido 1 caiu; Zabuza recuou para a névoa, longe") e o Topógrafo monta e atualiza o palco; sem palco em batalha, o contexto pede o brief. Mudar de lugar dentro da mesma cena limpa o palco. O contexto do Mestre leva um bloco curto com o local atual, as rotas daqui e o palco; os locais distantes, os mapas 3D e as regras de zonas, rotas e distâncias vão só para o Topógrafo. O "gerar novamente" volta mapa e palco junto com o resto. Verificação (com o Topógrafo falso, sem rede): `npx tsx scripts/map-check.ts`.

Na tela, `src/components/map/MapPanel.tsx` (props: `campaign`, `scene`, `characters`) mostra o mapa como um diorama 3D low-poly (three, carregado sob demanda): cada tipo de lugar vira uma miniatura, rotas são trilhas pontilhadas, o jogador e quem está com ele são peões (cor pela postura no palco), lugares conhecidos e não visitados aparecem translúcidos e a luz segue o período do dia. Arrastar gira, clicar num lugar abre o cartão dele, a câmera desliza até o lugar novo quando você se move, e "Ampliar" abre o mapa em tela cheia com zoom. Cores e fontes vêm dos tokens do tema da campanha. Só renderiza quando algo se mexe; sem WebGL, cai para uma visão 2D em SVG. O palco aparece em 2D no mesmo painel (anéis de distância, zonas, cobertura e elevação), primeiro em batalha.

### Mapas 3D dos lugares (Cartógrafo)

Além do diorama do mundo, cada lugar pode ter uma maquete 3D própria, composta pelo **Cartógrafo** a partir da obra, da narração e da cena (`src/lib/cartographer.ts`). O modelo devolve um spec declarativo, nunca código; `src/lib/mapSpec.ts` valida e limita tudo (quantidades, faixas, cores) e o mapa fica na tabela `maps`, ligado ao lugar do mapa do mundo. O Topógrafo usa a ferramenta `local_map` (gerar, editar, remover), a partir do brief do Mestre, quando o jogador chega a um lugar relevante sem mapa ou a história muda o lugar; os pontos de interesse do mapa viram as zonas do `set_stage`, e os peões aparecem nelas. Na aba **Mapa**: **Local** traz em destaque o mapa da cena atual (girar, zoom, pontos clicáveis, tela cheia), com os botões Gerar, Editar, Regerar e Remover e a galeria dos outros lugares; **Mundo** é o diorama. Como o Opus custa, a geração por iniciativa do jogo tem um interruptor nas Configurações ("O Mestre gera mapas 3D sozinho"); os botões funcionam sempre. Verificação sem IA: `npx tsx scripts/cartographer-check.ts`.

### Biblioteca, retratos e tarefas em segundo plano

- **Biblioteca** (tabela `library`, `src/lib/library.ts`, aba Biblioteca): técnicas e itens do mundo da campanha. O `add_ability` do Mestre recebe só nome e brief: vem da biblioteca ou o **Criador de habilidades** cria na hora (e guarda); `add_item` completa a descrição pela biblioteca; `search_library` consulta antes de inventar. Na aba (ou pedindo ao Mestre fora do jogo, `generate_library`) o jogador manda gerar N técnicas ou itens com um foco, em lotes que recebem os nomes já existentes para não repetir. Verificação: `npx tsx scripts/library-check.ts`.
- **Retratos** (tabela `portraits`, `src/lib/portrait.ts`, componente `Portrait`): um por personagem, gerado só quando o jogador clica em Gerar retrato (modal do NPC ou ficha). Quem pinta é o **Ilustrador**, só com a geração de imagens ligada nas Configurações (desligada, o botão avisa e nada é gerado). Verificação: `npx tsx scripts/portrait-check.ts`.
- **Tarefas em segundo plano** (tabela `jobs`, `src/lib/jobs.ts`): perfis de NPC, memórias de conversa com NPC, retratos, lotes da biblioteca e mapas rodam fora do turno. O cabeçalho do jogo mostra o que está rodando (com progresso) e, quando termina, a tela recarrega e avisa. Duas tarefas iguais não rodam juntas; uma parada há 15 min sem sinal (servidor reiniciado) vira erro. Verificação: `npx tsx scripts/jobs-check.ts`.

### Estilos de campanha

Escolhido na criação: **Aberta** (você descreve tudo livremente), **Híbrida** (opções sugeridas + digitação livre; diálogos sempre livres) ou **Guiada** (o Mestre dá opções concretas e a história fica mais controlada e verossímil).

### Interface e temas

O design system está em [`DESIGN.md`](./DESIGN.md) (tokens, temas, primitivas e o que é proibido). Cada campanha tem um tema visual (`chronicle`, `arcano`, `shinobi`, `neon`, `estelar`, `gotico`): `campaign.state.theme` (escolhido na criação ou no painel **Mesa**) > `ruleset.theme` > palpite pelo nome do cenário (`src/lib/theme.ts`). A tela de jogo aplica o tema na raiz e a página inteira acompanha.

- A narração chega em streaming (`narration_delta`/`narration_reset`) e a espera mostra a fase do turno (lendo a cena, consultando, dados, escrevendo).
- A campanha vem pronta no HTML (`src/lib/campaignView.ts`, usado pela página e pelo GET); imagens são servidas por URL com cache, não em base64 no JSON.
- Avisos (dano, cura, XP, nível, itens, NPC entrando/saindo, missões, salto de tempo) saem da diferença de estado a cada turno (`src/components/game/stateToasts.ts`).
- No celular, a lateral vira uma folha que sobe de baixo, com barra fixa de atalhos.

## Mecânica configurável (agnóstica de cenário)

A mecânica (atributos, barras de recurso, tipos de habilidade, ranks/progressão, campos extras, notas de rolagem e lore) é um JSON importável/exportável. O preset de Naruto está em [`naruto-ruleset.json`](./naruto-ruleset.json) na raiz — chakra, ranks ninja (Genin → Kage), jutsus por categoria, kekkei genkai, elementos, custos de chakra por rank de jutsu.

Para criar outro cenário (Star Wars, D&D, cyberpunk...), copie o JSON, ajuste os campos e importe no assistente de nova campanha. Exportação: aba **Roteiro** da campanha (mecânica ou campanha completa).

Sem mexer em JSON: **Criar com IA**, no primeiro passo do assistente, abre uma conversa com o agente **Criador de aventuras** (`adventure`, modelo grátis por padrão). Ele pergunta em linguagem natural (universo, recorte, tom, como o poder funciona, progressão), infere o resto pela obra e monta o JSON por trás; ao lado, a lista do que já está definido. A resposta do agente traz o texto e um bloco `{"patch", "choices", "done"}` (`src/lib/adventure.ts` faz o parse, o merge e a validação final: só fecha quando o JSON funciona numa campanha). O rascunho fica em `adventure_drafts` e dá para retomar depois de um refresh. No fim: **Baixar JSON** ou **Iniciar campanha com esta aventura** (o mesmo caminho do Importar). Verificação sem IA: `npx tsx scripts/adventure-check.ts`.

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

### Regras da mesa (dificuldade e dados)

A dificuldade muda a qualquer momento (`campaigns.state.table`, helpers em `src/lib/table.ts`, rota `GET/PUT /api/campaigns/[id]/table`). Ausente = Normal, sem ajustes e sem críticos.

- **Preset**: História (CD −5), Fácil (−2), Normal (0), Difícil (+2), Brutal (+5). Trocar o preset traz o ajuste dele, que dá para editar (`dcOffset`, −10 a 10). O preset também diz ao Mestre o tom: letalidade, recursos dos inimigos, generosidade de pistas.
- **Tipos de ação**: ajuste próprio da CD (Combate +2, Furtividade −1...), livres por campanha. O Mestre informa `category` em `roll_dice`/`use_ability`.
- **A conta é do servidor**: CD efetiva = CD do Mestre + ajuste geral + ajuste do tipo (mínimo 1). O resultado da ferramenta diz a base, os ajustes e a efetiva (para o Mestre não compensar), e o dado leva `baseDc`/`dcAdjust` para a UI mostrar "CD 15 +2 Difícil = 17".
- **Críticos** (opcional): em 1d20 com CD, 20 natural passa e 1 natural falha.
- **Ganho de XP**: Lento, Normal ou Rápido (ou cada número à mão), em % do que falta para o próximo nível; o Escrivão aplica (`xp`).
- **Modos de cena**: o texto de como o Mestre conduz exploração, diálogo, batalha, treino e descanso, por campanha (`modes`; vazio volta ao padrão de `MODE_HINTS`). O do modo atual vai no contexto de todo turno, em MODO DA CENA; o Mestre fora do jogo também ajusta a pedido.
- **Notas**: orientação livre de dificuldade para o Mestre.

Tudo entra no bloco REGRAS DA MESA do prompt do turno. Na conversa fora do jogo, "deixa os combates mais difíceis" ou "quero modo história" viram `set_table_rules`, e a resposta mostra o que mudou. O "gerar novamente" não desfaz regra da mesa nem tema. Verificação: `npx tsx scripts/table-check.ts`.

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
scripts/map-check.ts       # mapa e palco: nomes, layout, ferramentas e "gerar novamente", sem IA
docker-compose.yml         # Postgres + pgvector (porta 5433)
src/lib/
  schema.sql               # schema idempotente (aplicado no boot)
  openrouter.ts            # cliente de chat (OpenRouter ou outra fonte OpenAI-compatível) + logging obrigatório em api_logs
  sourcePresets.ts         # fontes conhecidas (OpenAI, Anthropic, Gemini, OpenCode): URL pronta, só falta a chave
  chatgptAuth.ts           # Login com ChatGPT: OAuth com PKCE, tokens só no servidor, refresh e logout
  responsesApi.ts          # tradutor chat() ↔ Responses API (modo Login com ChatGPT)
  agents.ts                # agentes default (modelos + prompts)
  engine.ts                # turno, contexto, compactação, roteirista
  tools.ts                 # ~20 ferramentas do Mestre
  decisions.ts             # Jev (Decisions API): perguntas, limiares e fallbacks
  tts.ts                   # voz dos NPCs (TTS do OpenRouter) + cache de áudio
  npc.ts                   # conversas particulares com NPCs
  characters.ts            # Criador de personagens: perfil e ficha do NPC em segundo plano, merge sem atropelar o Mestre
  library.ts               # biblioteca de técnicas e itens, Criador de habilidades e de itens, lotes
  portrait.ts              # retratos: Ilustrador
  cartographer.ts          # Cartógrafo: mapas 3D por lugar (pedido, entrada, gravação); Topógrafo (map_brief do Mestre)
  mapSpec.ts               # spec declarativo do mapa 3D: validação e limites
  jobs.ts                  # tarefas em segundo plano acompanhadas pela tela
  retrieval.ts             # busca vetorial com fallback FTS
  books.ts                 # ingestão/paginação/chunking de livros
  ruleset.ts               # mecânica agnóstica + normalização
  adventure.ts             # Criador de aventuras: parse da resposta, merge do rascunho, validação, progresso
  progression.ts           # domínio, nível de poder, pontos livres, teto e treino
  map.ts                   # mapa do mundo (locais, rotas, layout) e palco da cena
src/app/                   # telas + rotas de API (Next.js App Router)
```
