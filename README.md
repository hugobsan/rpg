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
│  │ 1. Intérprete: ação livre → passos tipados   │     ┌────────────────┐   │
│  │ 2. Resolvedor (código): regras e oráculo     │────▶│   OpenRouter   │   │
│  │ 3. Narrador: prosa + bloco ```efeitos        │◀────│  (todos os     │   │
│  │ 4. código valida e aplica os efeitos         │     │   agentes)     │   │
│  │    (sem bloco: Anotador; falhou: nada)       │     └────────────────┘   │
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

**Prompts padrão**: o padrão de cada agente fica em `DEFAULT_AGENTS` (`src/lib/agents.ts`), e mudar um prompt é só editar ali. O banco guarda em `agents.prompt_base` o hash do padrão de onde o prompt veio: no boot, prompt não editado recebe o padrão novo inteiro; prompt editado à mão fica como está e o card em /agents avisa, com Ver diferença e Restaurar padrão (salvar pela tela não mexe no `prompt_base`).

**Presets de fonte** (topo de /agents, `settings.agentPresets`): para trocar todos os agentes de fonte quando o saldo aperta (ex.: OpenAI pelo plano do ChatGPT → Anthropic pela API key → OpenRouter). Deixe os agentes como quer e clique em Salvar configuração atual com um nome; o preset guarda fonte, modelo, modelo de turnos complexos do Mestre, cache e busca web de cada agente. Aplicar passa cada agente pelo mesmo PUT do Salvar agente (valida e busca o preço) e só mexe em quem está diferente; Atualizar regrava o preset com a configuração atual; "em uso" marca o preset igual aos agentes. Jev, Ilustrador e Voz ficam fora (`PRESET_FIXED` em `src/lib/agentPresets.ts`): dependem do OpenRouter.

**Login com ChatGPT** (preview): a fonte OpenAI pode usar o plano do ChatGPT em vez da API key (Sign in with ChatGPT para apps open source locais). Em Configurações > Fontes de modelos, adicione a fonte OpenAI com a autenticação "Login com ChatGPT" e clique em **Continuar com o ChatGPT**; o retorno vem em `http://127.0.0.1:3000/auth/callback` e os tokens ficam só no banco local, renovados sozinhos. Os agentes de texto dessa fonte vão pela Responses API (`src/lib/responsesApi.ts`); temperatura e máximo de tokens são ignorados, e Ilustrador, Voz, Jev e embeddings não funcionam nela. No Plus, o limite de 5 h é dividido com os outros apps que usam o plano; uso e limites em [chatgpt.com/settings/usage](https://chatgpt.com/settings/usage). Verificação sem IA: `npx tsx scripts/chatgpt-auth-check.ts`. O histórico completo de chamadas (fonte, custo, tokens, duração, request/response) fica em **/usage** (Custos e uso), para você avaliar o gasto e trocar modelos quando quiser; o OpenRouter informa o custo real, e o das outras fontes é estimado pelo preço do mesmo modelo no catálogo do OpenRouter.

| Agente | Modelo default | Papel | Por quê |
|---|---|---|---|
| **Narrador** (`gm`) | `openai/gpt-6.1-terra` nos turnos simples, `anthropic/claude-sonnet-5.5` nos complexos (+`:online` quando o Jev pede) | Só conta a história: recebe o resultado já decidido em palavras (nunca número), a ficha em níveis (cheio/firme/baixo/esgotado; iniciante/praticando/sólido/mestre) e as últimas 6 trocas; consulta `search_history`, `search_lore` e `get_character` (até 2 rodadas) e fecha com o bloco ```efeitos (tempo, cena, NPC novo, itens, compra, descanso, missão, fatos, opções) | Prompt curto (~1k tokens), uma chamada por turno na maioria das vezes |
| **Intérprete** | `google/gemini-3.5-flash` (raciocínio baixo) | Traduz o texto livre do jogador em até 3 passos tipados (técnica, atributo, item, treino, fala, movimento) e uma pergunta ao oráculo; opção clicada não passa por ele | Barato e rápido; JSON validado contra a ficha, falhou = passo genérico |
| **NPC (base)** | `deepseek/deepseek-v4-pro` | Interpreta qualquer NPC em conversas particulares | Ótimo roleplay por uma fração do custo |
| **Roteirista** | `deepseek/deepseek-v4-pro` (+`:online`) | Gera o roteiro interno (arcos, eventos canônicos, ganchos) | Roda raramente; longo e barato |
| **Anotador** (`scribe`) | `google/gemini-3.5-flash` (raciocínio médio) | Só quando o bloco de efeitos do Narrador não veio ou não deu para ler, e ao fechar uma conversa particular com NPC: lê o texto e devolve só o bloco | Rede de segurança; falhou = efeitos vazios (nada inventado) |
| **Jev (decisões)** | `typesafe/jev-1.14-20261014` | Decide, sem gerar texto: modelo do turno, busca web, fala fora do jogo, se a ação é conversa com um NPC em cena, trecho dos livros, recusa de NPC | Modelo de decisão: ~US$0,00005 e <1 s por chamada |
| **Ilustrador** | `google/gemini-3.1-flash-image-preview` | Gera a imagem do ambiente atual e o retrato dos personagens, sob demanda. Aceita qualquer modelo de imagem do OpenRouter: os que só geram imagem (FLUX, Recraft...) vão pelo POST /images do OpenRouter (o catálogo diz quem é), e o resultado pode ser PNG, JPEG, WebP, GIF ou SVG (servido sem rodar nada). No card, "Reescrever o prompt" escolhe um modelo de texto que deixa o prompt curto e em inglês antes de gerar | Nano Banana 2: qualidade alta, custo baixo |
| **Voz** | `heygen/heygen-voice-1-turbo:free` | Lê as falas dos NPCs (TTS), com voz padrão por sexo | Grátis e fala português; áudio em cache |
| **Criador de personagens** | `nvidia/nemotron-3.5-super-vl:free` | Monta em segundo plano o perfil rico e a ficha de cada NPC novo (`create_npc`) e do botão Refazer perfil, a partir da biblioteca | Grátis; raciocina antes (~1,5 min por NPC), fora do turno |
| **Criador de aventuras** | `nvidia/nemotron-3.5-super-vl:free` | Entrevista o jogador e monta o JSON de uma aventura nova (Criar com IA) | Grátis; raciocina antes de responder (rodada de 1 a 2 min) |
| **Criador de habilidades** | `nvidia/nemotron-3.5-super-vl:free` | Cria técnicas (jutsus, feitiços...) para a biblioteca: na hora, quando o `add_ability` pede uma que não existe, e em lotes no segundo plano | Grátis; prazo de 90 s dentro do turno |
| **Criador de itens** | `nvidia/nemotron-3.5-super-vl:free` | Cria ferramentas, armas e consumíveis para a biblioteca, em lotes | Grátis |

O seletor de modelos busca a lista viva de `openrouter.ai/api/v1/models` com preço e contexto — os defaults nunca ficam obrigatórios.

### Jev: o modelo de decisão

O Jev (TypeSafe, via [Decisions API do OpenRouter](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request)) não escreve texto: recebe um estado e perguntas tipadas e devolve probabilidades. O código decide com limiares fixos em `src/lib/decisions.ts`. Ele entra nestes pontos:

1. **Modelo do Mestre por turno**: classifica a ação como simples ou complexa (batalha, regras, vários efeitos, consequência séria). Turno complexo usa o "modelo para turnos complexos" do Narrador (`params.complexModel`, editável em /agents). Se esse campo estiver vazio, o roteamento fica desligado. O modelo é escolhido uma vez e vale para todas as rodadas de ferramentas do turno.
2. **Busca web só quando precisa**: `:online` só liga se o Mestre tiver busca web ativa e o turno depender de um fato da obra que falta no contexto, e só na 1ª rodada do turno (as fontes seguem como texto para as rodadas seguintes).
3. **Recusa de NPC**: no início de uma conversa particular, decide se o NPC toparia conversar agora. Na recusa, o próprio NPC recusa em personagem e a troca não fica gravada; se o jogador insistir, o Jev decide de novo.
7. **Fala fora do jogo no chat do jogo**: a ação é o jogador perguntando, reclamando ou corrigindo o registro (ficha, inventário, missões, XP, relógio, regras), e não ação ou fala do personagem? Se sim (`jev.metaMin`, 0,75, alto de propósito, ainda sem probe), vai à conversa fora do jogo (abaixo). Não pergunta no Continuar, no gerar novamente nem ao editar a ação.
8. **Conversa à parte com um NPC em cena**: a ação é o personagem puxando uma conversa à parte com um dos NPCs em cena (papo, assunto pessoal, curiosidade, compra simples), que pode seguir em particular com a cena parada (escolha entre eles e "nenhum")? Fala que faz parte da cena (sobre o treino, a missão ou a investigação em andamento, perguntar como fazer o que está sendo ensinado, propor método ou plano, escolher o próximo passo), ação no mundo junto da fala ("entro e pergunto...", "entrego a ficha e digo..."), fala para vários, NPC fora de cena, batalha e treino (nem pergunta) ficam no turno normal. Se sim (`jev.talkMin`, 0,75; probe com casos reais: conversa à parte 0,86–0,94, falas do treino e informação para a missão 0,00, o resto 0,00–0,20), a conversa vai ao chat do NPC (abaixo, em NPCs com vida própria). Mesmas exceções do 7; se 7 e 8 passam, vale o 7. Opção clicada não pergunta nenhum dos dois.
9. **Trecho dos livros antes do turno**: só com livros indexados na campanha (os títulos vão no estado). A ação precisa de um fato que os livros cobrem e que falta no contexto? Se sim (`jev.bookMin`, 0,45; probe: precisa 0,59–0,97, rotina e treino 0,05–0,36), os 2 chunks mais próximos da ação entram no contexto do turno cortados em ~700 caracteres, com título e página, e o Narrador não gasta uma rodada buscando.

As decisões 1, 2, 7, 8 e 9 vão numa única chamada antes do turno, antes da foto do turno e de a ação ser salva. Se o Jev falhar (sem chave, erro ou timeout de 7 s), tudo segue o comportamento padrão. Cada chamada aparece em /usage, filtrando pelo agente **Jev**. Ao trocar o modelo do Jev, rode `npx tsx scripts/jev-check.ts` de novo: ele imprime as probabilidades dos casos de probe e confere os casos claros contra os limiares.

### Sistema de memória (o antídoto contra perda de contexto)

1. **Fichas são estado, não texto**: atributos, recursos, habilidades, inventário, XP e rank vivem em JSONB. O Narrador recebe a ficha em palavras (`characterInWords`: recurso por nível, domínio por faixa) e não altera nada narrando: o Resolvedor aplica as regras antes dele (`use_ability`, `train`, teste pela tabela única de dificuldade) e o código aplica o bloco de efeitos depois (`src/lib/effects.ts`), campo a campo, pelas ferramentas de sempre.
2. **Histórico recente**: as últimas 6 trocas (ação + narração) entram brutas, com a conversa particular com NPC no lugar dela. Sem compactação nesta fase; o que ficou de fora o Narrador busca com `search_history`. (Memórias por relevância saíram do turno do Narrador; voltam como fatos com testemunhas na F3.) Verificação sem IA: `npx tsx scripts/cache-check.ts` e `npx tsx scripts/world-check.ts` (Roteirista).
3. **Fatos do bloco**: `facts` e `told` do bloco de efeitos viram memórias `event` (TODO F3: eventos com testemunhas e conhecimento por NPC).
4. **Histórico completo no banco vetorial (4ª camada)**: além da janela recente, do resumo da cena e das memórias, o chat inteiro fica em `history_chunks`: cada turno (ação do jogador + narração do Mestre) e cada troca de conversa particular com NPC (marcada com o NPC) vira um trecho com embedding, dia e hora do jogo e local. É gravado depois da narração, sem atrasar a resposta; sem embeddings fica o texto e a busca cai no full-text. O Narrador consulta com `search_history` (query e NPC opcional) para lembrar exatamente o que alguém disse ou fez, ou um detalhe antigo que não virou memória, e recebe trechos curtos, cortados em volta do que bate com a busca e marcados como o que aconteceu naquele momento (ficha e memórias atuais valem mais). O "gerar novamente" e apagar a campanha limpam os trechos (FK com CASCADE). Para vetorizar o histórico de antes: `npx tsx scripts/history-backfill.ts`; o Reprocessar das Configurações refaz esses vetores junto com memórias e livros. Verificação sem IA: `npx tsx scripts/history-check.ts`.
5. **Livros e biblioteca**: o material enviado é indexado em páginas + chunks com embeddings. O Narrador usa `search_lore`, que junta os trechos dos livros com as técnicas e itens da biblioteca do mundo.
6. **Roteiro interno**: para campanhas com cânone, o Roteirista monta arcos ancorados na linha do tempo da obra. Regenerar com a campanha em andamento **replaneja a partir de onde a história parou**: o Roteirista recebe a hora, os resumos de todas as cenas, os marcos e memórias importantes, a situação dos NPCs, a última narração, as diretrizes e o roteiro atual; os arcos concluídos ficam como estão, o 1º arco devolvido é o atual e as notas dos arcos que continuam são mantidas (antes ele só via o cenário e a ficha e voltava a história ao ponto de inserção). Sem narração ainda, o roteiro é feito do zero. O contexto de cada turno traz o arco ativo com o ponto atual (a última nota de progresso), os próximos 2 eventos canônicos e o arco seguinte em uma linha; é assim que o Narrador "sabe onde está" no cânone (anotar progresso do arco fica para a F2).
7. **NPCs com vida própria**: conversas particulares acontecem com o agente NPC (que pode **recusar** conforme a cena), que recebe o perfil inteiro e, se está em cena, a última narração. Fala escrita no chat da campanha só para um NPC em cena também vai para lá (decisão 8 do Jev): cada fala no agente NPC custa ~3 mil tokens, contra ~20 mil de um turno do Mestre. Não há Narrador nem Anotador no turno, a fala não fica no chat da campanha nem apaga a foto do turno anterior, e o modal do NPC abre com a fala e a resposta; se o NPC recusaria (Jev) ou a chamada falha, segue o turno normal. Se a fala era para a cena e não uma conversa particular, o botão "Não era uma conversa? Continuar no chat da campanha" (só antes de responder ao NPC) apaga a conversa (o NPC não lembra dela) e manda a mesma fala como turno do Mestre, sem a pergunta 8. Ao encerrar qualquer conversa, antes de o modal fechar, o **Anotador** lê a conversa inteira e devolve o bloco de efeitos (tempo dela, item comprado, missão oferecida, que abre o card de Aceitar e Recusar), aplicado como o do Narrador. Ao fechar e não a cada fala: uma chamada por conversa, que vê oferta e aceite juntos, e o modal aberto segura o próximo turno até tudo estar gravado. Uma linha discreta ("Conversa particular com X", mensagem `talk`) entra no chat da campanha. Se a conversa nasceu de uma fala no chat da campanha, o NPC fecha com uma fala curta de encerramento (despedida, recado final ou reação; uma chamada do agente NPC em paralelo com o Anotador), que aparece no chat logo depois da linha, como as falas da narração, para mostrar que houve uma troca ali. A conversa fica no histórico do Narrador no lugar dela (como nota do lado do jogador): o texto dela (até 1.500 caracteres; numa longa, o começo e o fim), a fala de encerramento e o que ficou registrado, com a indicação de que ela inteira está no `search_history`; antes ia só ao contexto do próximo turno e sumia depois dele. O "gerar novamente" do turno anterior desfaz a conversa junto. O NPC recebe as memórias que levam o nome dele ou que o citam no texto ("Time 7" com o Naruto no texto também é do Naruto), da mais antiga para a mais recente, com a mais recente valendo num conflito. O NPC guarda a conversa inteira; os fatos do bloco do Anotador viram memórias com o nome dele. Verificação: `npx tsx scripts/talk-check.ts`.

**Configurações avançadas** (fim de **Configurações**, recolhidas): os parâmetros de recuperação e indexação por cenário, com nomes técnicos de propósito. Memórias: top-k do `search_memories` e do NPC. Histórico (`history_chunks`, um chunk por turno, sem overlap): janela do trecho devolvido, top-k do `search_history`, batch. Livros: chunk size e chunk overlap (em caracteres), top-k do `search_lore`. Embeddings: `dimensions` (truncamento Matryoshka, enviado no POST /embeddings; 0 = nativa) e batch. Jev: os limiares das decisões, calibrados pelo `jev-check.ts`. Os padrões são os valores medidos no código, e o banco (`settings.advanced`) guarda só o que difere deles. Chunk size, overlap e dimensões exigem **Reprocessar embeddings**, que refaz os chunks dos livros a partir de `book_pages` e avisa se o modelo ignorou `dimensions`; até lá a busca compara só vetores da mesma dimensão da consulta. Rota: `GET/PUT /api/settings/advanced`. Verificação sem IA (num banco descartável): `npx tsx scripts/advanced-check.ts`.

**NPC novo (Criador de personagens)**: personagem da obra só entra se, naquele ponto da linha do tempo, estaria ali (vivo, solto, na vila e já apresentado na obra). O `newNpcs` do bloco de efeitos registra nome, sexo e um brief (`create_npc`); NPC que fala sem estar registrado é descartado do bloco (o Narrador precisa declará-lo). Em segundo plano (tarefa `character`, no cabeçalho), o agente **Criador de personagens** monta o perfil rico (aparência, idade, papel, personalidade, jeito de falar, passado, objetivos, segredos, relações, manias) e a ficha coerente com o cargo e o nível de poder, preferindo as habilidades e os itens da biblioteca da campanha (habilidade que falta vai para o Criador de habilidades e fica guardada lá). A gravação trava a linha e faz merge com a foto do registro: o que o Mestre mudou no meio tempo fica (cargo, habilidade nova, máximo de recurso; dano e gasto continuam descontados do máximo novo) e o sexo nunca muda. O retrato não é gerado sozinho: fica para o botão Gerar retrato. No modal do NPC, a aba **Perfil** mostra tudo menos os segredos, e **Refazer perfil** roda o Criador de novo mantendo o que já é fato (bom para NPCs antigos). O Mestre vê o perfil enxuto na ficha da cena (completo no `get_character`); o agente do NPC recebe tudo. Verificação sem IA: `npx tsx scripts/characters-check.ts`.

**Abaixo da última resposta do Narrador**: o ícone ↻ gera a resposta de novo (desfaz o turno pela foto em `turn_snapshots` (que guarda também a opção clicada, refeita sem o Intérprete), com motivo opcional; os motivos de cada ↻ da mesma ação ficam na foto e vão todos ao Mestre, então pedir uma coisa nova não desfaz a anterior); **Continuar** manda a ação interna `(continuar a cena)` (`src/lib/continueScene.ts`, salva mas não exibida no chat; depois dela não há o que editar) e o Mestre segue a cena sem o seu personagem agir, ou, se a narração anterior esperava algo de você, responde só uma linha curta ("Ele ainda espera sua resposta."); o lápis embaixo da sua última mensagem a edita no lugar: o turno é desfeito e o Mestre responde ao texto novo (`POST /turn` com `regenerate` e `input`).

**Conversa fora do jogo**: o botão "💬 Falar com o Mestre (fora do jogo)" abre uma conversa sua, como jogador, com o Mestre (`gm_notes`, fora da história, do histórico do turno e do "gerar novamente"); ele responde sem spoilers e sem mexer no jogo, pedidos que cabem numa regra da mesa (dificuldade, críticos, modos de cena, XP, descanso) viram `set_table_rules`, erro pontual de um turno (teste rolado duas vezes, recurso cobrado em dobro, domínio contado de novo) ele desfaz na ficha com as ferramentas, sem virar diretriz, e narração incompleta ele manda refazer com o "gerar novamente"; as outras orientações (narração, tom, cânone, foco em personagens) viram diretrizes (memória `directive`, permanentes ou só nesta cena e na próxima) que entram em todo turno em "DIRETRIZES DO JOGADOR" até você desativá-las no ✕. Reclamação do registro escrita no chat do jogo ("por que você me deu uma tigela?", "você cancelou 3 missões") também vem para cá quando o Jev reconhece (decisão 7): não há turno do Narrador nem Anotador, a mensagem não fica no chat da história nem apaga a foto do turno anterior, e a tela abre esta conversa já com a pergunta e a resposta; as opções do turno anterior voltam. Se a conversa fora do jogo falhar, o turno segue normal. Verificação: `npx tsx scripts/meta-check.ts`.

### Contrato do Narrador: Intérprete, Resolvedor e bloco de efeitos

O turno (`runTurn` em `src/lib/engine.ts`): Jev → **Intérprete** (texto livre → até 3 passos tipados, `src/lib/resolver.ts`; opção clicada chega como `{ optionIndex }` e vira passos direto) → **Resolvedor** em código (técnica da ficha por `use_ability` com a CD da tabela única `dcFor`; técnica fora da ficha fica no máximo em parcial; treino por `train`; teste de atributo; falha contra alguém em passo arriscado machuca; a primeira falha corta os passos seguintes; pergunta ao mundo pelo oráculo Mythic de tabela fixa) → resultado em palavras no contexto → **Narrador** → validador de prosa (`proseIssues`: número de regra, CD, "pontos de chakra", dados; hora, preço, distância e quantidade passam), com uma nova tentativa se reprovar → bloco ```efeitos validado campo a campo (`validateEffects`, `src/lib/contracts.ts`; campo inválido sai sozinho e fica em `meta.dropped`) → sem bloco legível, o **Anotador** → aplicação por código (`applyEffects`). Opções tipadas vão em `meta.options` e no evento SSE `options` (`choices` continua com os rótulos). Árbitro, Escrivão lendo prosa, Cronista, Ações rápidas, decisões de relógio/elenco/local/modo do Jev e ~22 ferramentas do Mestre saíram; as ferramentas de registro continuam na conversa fora do jogo. Qualquer agente num modelo GPT sem `params.reasoning` vai com esforço médio (`chat()`). Verificação sem IA: `npx tsx scripts/eval-check.ts` (fixtures reais em `scripts/eval/fixtures`).

### Correções do jogador

Como numa mesa de verdade, o jogador corrige a própria ficha onde o dado aparece, sem IA (`src/lib/corrections.ts`, rota `POST /api/campaigns/[id]/corrections`; recusada durante um turno): **Corrigir** na Ficha (recursos, atual e máximo, e XP), no Inventário (pôr, tirar, mudar a quantidade; não é largar na história), domínio no card aberto da técnica e o status da missão (aberta, concluída, cancelada; perdida que foi cumprida vira concluída). Passa pelas ferramentas do jogo: XP sobe nível, e concluir dá a XP da missão uma vez só (`xpGiven`; sair de concluída devolve). Cada efeito aplicado fica na narração (`meta.scribe`: ferramenta, argumentos e a diferença que ele fez), e as etiquetas dele no chat do último turno têm **desfazer** (inverso por delta: item, recurso, XP, domínio, campo, memória criada, missão criada, status anterior de missão com a XP; desfeito uma vez só, e sai de `meta.notes`). O Mestre fica sabendo numa linha do contexto do turno seguinte (`state.playerFixes`, consumida depois da narração, como o `decidedAt` das missões); o "gerar novamente" volta à foto, então correção e desfeito feitos depois do turno somem com ele. Cada correção vai para a tabela `corrections` (origem `manual` ou `desfazer`, agente do registro quando se sabe), para medir os erros:

```sql
-- quantos efeitos aplicados foram desfeitos
SELECT count(*) AS registros, count(*) FILTER (WHERE (e->>'undone')::boolean) AS desfeitos
FROM messages m, jsonb_array_elements(m.meta->'scribe') e;
-- correções por origem e tipo
SELECT source, agent, kind, count(*) FROM corrections GROUP BY 1, 2, 3 ORDER BY 4 DESC;
```

Verificação sem IA: `npx tsx scripts/corrections-check.ts`.

### Cena e elenco

O bloco de efeitos diz a cena: `scene.newScene`/`location` abre cena nova ou muda o local (`set_scene`) e `scene.present` é a lista de quem está ali (quem fica de fora sai). Só os NPCs em cena entram inteiros no contexto do Narrador. O modo da cena não é mais trocado nesta fase (os modos da mesa ficam sem efeito no Narrador). Verificação: `npx tsx scripts/cast-check.ts`.

### Relógio do jogo

A história tem dia e hora (`campaigns.state.clock`, minutos desde o "Dia 1, 00:00" da campanha; helpers em `src/lib/clock.ts`). O banner da cena mostra "Dia 1 · 08:40 · manhã" e a hora entra no contexto do Mestre a cada turno. O `train` do Resolvedor avança pelas horas treinadas e o `time` do bloco de efeitos escolhe uma faixa (nada, minutos, ~15 min, ~1 h, horas, meio dia, manhã seguinte), que o código soma; campanha sem relógio começa no Dia 1, 8h. O "gerar novamente" volta o relógio junto com o resto do turno, e a imagem do ambiente usa o período do dia.

**Dinheiro** (`Ruleset.currency`, `src/lib/money.ts`): o mundo diz suas moedas, uma (Naruto: Ryō) ou várias com o valor de cada uma na menor (Harry Potter: Galeão 493, Sicle 29, Nuque 1; fantasia: ouro 100, prata 10, cobre 1), o saldo inicial e preços de referência em texto (missões por rank, comida, equipamento), que vão ao Mestre na MECÂNICA. A ficha guarda o total na menor moeda (`sheet.money`, troco automático) e mostra decomposto ("2 Galeões, 3 Sicles e 5 Nuques"). Só muda por `update_money` (`purchase` do bloco de efeitos e fora do jogo; recusa gasto maior que o saldo; desfazer pela etiqueta 💰) ou pelo pagamento de missão: `pay` em `add_objective` é a parte do jogador (o total da equipe fica em `reward`), entra sozinho ao concluir, uma vez (`payGiven`), e o painel devolve ao reabrir a missão. O Mestre diz na entrega da missão quanto paga, quem paga e a parte do personagem (regra 11); o Criador de aventuras preenche `currency` em mundos novos. Verificação sem IA: `npx tsx scripts/money-check.ts`.

**Missões e prazos** (`campaigns.state.objectives`, aba **Missões**): o `mission` do bloco de efeitos oferece (`offer`: título, pagamento, tamanho), aceita, conclui ou falha uma missão, aplicado por `add_objective`/`update_objective` (a XP vem da conclusão); fora do jogo o Mestre usa as duas direto; toda mudança do relógio passa por `saveClock`, que marca como perdido o que venceu (treinar ou viajar demais faz perder a missão) e avisa o Mestre para narrar a consequência. As últimas 30 missões cumpridas vão ao Mestre só pelo título, para ele não oferecer a mesma como se fosse inédita (repetir pode, com motivo na história e o mundo lembrando). Verificação: `npx tsx scripts/objectives-check.ts`.

### Biblioteca, retratos e tarefas em segundo plano

- **Biblioteca** (tabela `library`, `src/lib/library.ts`, aba Biblioteca): técnicas e itens do mundo da campanha. O `add_ability` do Mestre recebe só nome e brief: vem da biblioteca ou o **Criador de habilidades** cria na hora (e guarda); `add_item` completa a descrição pela biblioteca; `search_library` consulta antes de inventar. Na aba (ou pedindo ao Mestre fora do jogo, `generate_library`) o jogador manda gerar N técnicas ou itens com um foco, em lotes que recebem os nomes já existentes para não repetir. Verificação: `npx tsx scripts/library-check.ts`.
- **Retratos** (tabela `portraits`, `src/lib/portrait.ts`, componente `Portrait`): um por personagem, gerado só quando o jogador clica em Gerar retrato (modal do NPC ou ficha). Quem pinta é o **Ilustrador**, só com a geração de imagens ligada nas Configurações (desligada, o botão avisa e nada é gerado). Verificação: `npx tsx scripts/portrait-check.ts`.
- **Tarefas em segundo plano** (tabela `jobs`, `src/lib/jobs.ts`): perfis de NPC, memórias de conversa com NPC, retratos e lotes da biblioteca rodam fora do turno. O cabeçalho do jogo mostra o que está rodando (com progresso) e, quando termina, a tela recarrega e avisa. Duas tarefas iguais não rodam juntas; uma parada há 15 min sem sinal (servidor reiniciado) vira erro. Verificação: `npx tsx scripts/jobs-check.ts`.

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
- **Ganho de XP**: Lento, Normal ou Rápido (ou cada número à mão), em % do que falta para o próximo nível; aplicado na conclusão de missão (`xp`).
- **Descanso**: quanto cada recurso do mundo recupera num descanso leve (refeição, pausa) e num completo (noite de sono), em faixa mín–máx por recurso (`rest`; keys do ruleset, as que não existem são descartadas). Aplicada pelo código quando o bloco de efeitos traz `rest`; vazio = leve +15% do máximo, completo enche.
- **Modos de cena**: o texto de como o Mestre conduz exploração, diálogo, batalha, treino e descanso, por campanha (`modes`; vazio volta ao padrão de `MODE_HINTS`). O do modo atual vai no contexto de todo turno, em MODO DA CENA; o Mestre fora do jogo também ajusta a pedido.
- **Notas**: orientação livre de dificuldade para o Mestre.

Tudo entra no bloco REGRAS DA MESA do prompt do turno. Na conversa fora do jogo, "deixa os combates mais difíceis" ou "quero modo história" viram `set_table_rules`, e a resposta mostra o que mudou. O "gerar novamente" não desfaz regra da mesa nem tema. Verificação: `npx tsx scripts/table-check.ts`.

## Voz dos NPCs

Clique em 🔊 numa fala de NPC (no chat do Mestre, linhas `**Nome:** "fala"`, ou na conversa particular) para ouvi-la. A voz vem de um modelo de fala (TTS) do OpenRouter, escolhido no agente **Voz** em /agents junto com a voz masculina e a feminina padrão. O padrão é `heygen/heygen-voice-1-turbo:free` (grátis, fala português), com `lucian` (masculina) e `nadine` (feminina).

- Cada NPC usa a voz padrão do seu sexo (`persona.gender`). O Mestre informa o sexo ao criar o NPC; nos NPCs antigos, o Jev decide pelo nome, persona e obra na primeira fala e o app grava. Sexo desconhecido usa a voz masculina.
- No modal do NPC (aba 🔊) dá para trocar o sexo, escolher qualquer voz do modelo atual e ouvir uma prévia.
- Só a fala é lida (os trechos entre aspas, sem o nome e sem markdown). O áudio fica em `tts_cache`: ouvir a mesma fala de novo não chama o OpenRouter.

## Custos sob controle

- Modelos baratos nas tarefas frequentes (Intérprete, Anotador) e caros só onde importa (Narrador).
- Histórico de 6 trocas e prompt curto do Narrador evitam requisições monstro.
- Memórias/livros entram por relevância (top-k), nunca inteiros.
- Tela **Custos e uso** (`/usage`): custo, chamadas, erros, tempo e tokens somados, por agente, por modelo e por dia, com filtros de agente, período, campanha e modelo (na URL) e o histórico paginado com request/response.

## Estrutura

```
naruto-ruleset.json        # preset de mecânica de Naruto (importável)
scripts/jev-check.ts       # probe do Jev (rodar ao trocar o modelo de decisão)
scripts/progression-check.ts # checagem da progressão (domínio, nível, teto, treino) sem IA
scripts/eval-check.ts      # contrato do Narrador sem IA (prosa, bloco de efeitos, Intérprete) com fixtures reais
docker-compose.yml         # Postgres + pgvector (porta 5433)
src/lib/
  schema.sql               # schema idempotente (aplicado no boot)
  openrouter.ts            # cliente de chat (OpenRouter ou outra fonte OpenAI-compatível) + logging obrigatório em api_logs
  sourcePresets.ts         # fontes conhecidas (OpenAI, Anthropic, Gemini, OpenCode): URL pronta, só falta a chave
  chatgptAuth.ts           # Login com ChatGPT: OAuth com PKCE, tokens só no servidor, refresh e logout
  responsesApi.ts          # tradutor chat() ↔ Responses API (modo Login com ChatGPT)
  agents.ts                # agentes default (modelos + prompts)
  engine.ts                # turno, contexto do Narrador, roteirista
  contracts.ts             # contrato do Narrador: tipos, validadores, tabelas fixas (CD, oráculo, níveis)
  resolver.ts              # Intérprete e Resolvedor
  effects.ts               # aplica o bloco de efeitos; Anotador
  tools.ts                 # ferramentas (Narrador: 3 de consulta; fora do jogo: registro)
  decisions.ts             # Jev (Decisions API): perguntas, limiares e fallbacks
  tts.ts                   # voz dos NPCs (TTS do OpenRouter) + cache de áudio
  npc.ts                   # conversas particulares com NPCs
  characters.ts            # Criador de personagens: perfil e ficha do NPC em segundo plano, merge sem atropelar o Mestre
  library.ts               # biblioteca de técnicas e itens, Criador de habilidades e de itens, lotes
  portrait.ts              # retratos: Ilustrador
  jobs.ts                  # tarefas em segundo plano acompanhadas pela tela
  retrieval.ts             # busca vetorial com fallback FTS
  books.ts                 # ingestão/paginação/chunking de livros
  ruleset.ts               # mecânica agnóstica + normalização
  adventure.ts             # Criador de aventuras: parse da resposta, merge do rascunho, validação, progresso
  progression.ts           # domínio, nível de poder, pontos livres, teto e treino
  corrections.ts           # correções do jogador: edição manual da ficha, desfazer efeito aplicado, linha ao Narrador, medição
src/app/                   # telas + rotas de API (Next.js App Router)
```
