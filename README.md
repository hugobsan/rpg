# ⚔ Chronicle RPG

RPG de mesa individual conduzido por IA, com **vários agentes pequenos**, **estado no banco** (Postgres + pgvector) e
**mecânica configurável**. Vem pronto para o universo de Naruto, mas não depende de cenário.

O que precisa ser consistente (regras, rumo da história, quem sabe o quê, missões, dinheiro) é estado + código. O LLM
escreve uma cena já decidida. Por isso trocar o modelo de um agente pode piorar o texto, mas não quebra a continuidade.

https://github.com/user-attachments/assets/c9d0b1a6-0587-45f9-834e-c3af30bd950a

## Como rodar

```bash
cp .env.example .env       # ajuste se necessário
npm install
npm run db:up              # Postgres + pgvector em container (porta 5433)
npm run dev                # http://localhost:3000
```

Em **Configurações > Fontes de modelos**, informe a API key do [OpenRouter](https://openrouter.ai/keys) (ou outra fonte
compatível com a API da OpenAI). Embeddings são opcionais: sem eles, a busca cai no full-text do Postgres. O schema
(`src/lib/schema.sql`) é idempotente e aplicado no boot; não há migração.

Para começar: **Nova campanha** (5 passos: mundo, visual, personagem, extras, revisão) → **Iniciar aventura**.

## Arquitetura

Um app Next.js; o turno é um SSE (`POST /api/campaigns/[id]/turn`, `runTurn` em `src/lib/engine.ts`).

```
 ação do jogador ─┬─ texto livre (exploração) ──▶ Jev: fora do jogo? conversa particular? modelo? livros?
                  └─ opção clicada {optionIndex} (missão: só assim)
                              │
            Intérprete (LLM pequeno): texto → até 3 passos tipados      (opção: passos já tipados, sem Intérprete)
                              │
            Resolvedor (código): técnica, atributo, item, treino, oráculo → resultado EM PALAVRAS
                              │
            história (código): relógios, gatilhos, beats vencidos ─▶ Diretor (LLM): cartão da cena
                              │
            Narrador (LLM): cartão + resultado + ficha em níveis + SABE de cada NPC + 6 trocas
                            → prosa (streaming) + bloco ```efeitos
                              │
            validação (código): prosa sem número de regra (1 nova tentativa) · Jev: NPC falou fora do SABE? (refaz 1x)
                            · bloco campo a campo (ilegível → Anotador; falhou → nada)
                              │
            efeitos (código): tempo, cena, elenco, NPC novo, itens, compra, descanso, missão, fatos, "contou"
                              │
            história + conhecimento: beat feito/avançado, modo de jogo, quadro de missões, events/knowledge,
                                     opções de missão garantidas, histórico vetorial
```

Tudo o que um agente precisa vem do banco a cada chamada (R1). Cada papel recebe pouco, devolve formato fixo, é
validado por código, tem 1 nova tentativa com o erro do validador e um fallback por código (R2).

### Papéis e modelos

Cada agente é editável em **/agents** (fonte, modelo, prompt, parâmetros). O padrão fica em `DEFAULT_AGENTS`
(`src/lib/agents.ts`); prompt não editado recebe o padrão novo no boot (hash em `agents.prompt_base`), o editado à mão
fica e o card mostra a diferença.

| Agente | Padrão | Quando | Entra → sai | Modelo forte? |
|---|---|---|---|---|
| **Narrador** (`gm`) | `openai/gpt-6.1-terra`; `claude-sonnet-5.5` nos turnos complexos (Jev) | todo turno | cartão, resultado em palavras, ficha em níveis, NPCs com SABE, missões, 6 trocas → prosa + ```efeitos | não (prompt ~1,2k tokens) |
| **Intérprete** | `gemini-3.5-flash` | ação em texto livre | ação + ficha resumida → `{steps[≤3], declaresOutcome, question?}` | não |
| **Diretor** | `gemini-3.5-flash` | cena nova, beat pronto/avançado, a cada 8 turnos | beats elegíveis, relógios, NPCs, fatos → cartão JSON | não |
| **Roteirista** | `deepseek-v4-pro` | criar campanha, Refazer arco, agenda < 4 beats | estado + cânone → arco JSON (8-12 beats, relógios, ganchos, agenda dos NPCs) | **sim** (`strongOnly`) |
| **Anotador** (`scribe`) | `gemini-3.5-flash` | bloco ausente/ilegível; fim da conversa particular | texto → só o bloco de efeitos | não |
| **NPC** | `deepseek-v4-pro` | conversa particular | persona, agenda, SABE, lore → fala | não |
| **Jev** (`decider`) | `typesafe/jev-1.14-20261014` | antes do turno e checagens | perguntas tipadas → probabilidades | decision model |
| Ilustrador, Voz, Criadores (personagem, habilidade, item, aventura) | ver /agents | sob demanda, fora do turno | — | não |

O Roteirista só roda com modelo forte: nome com `:free`, `flash`, `luna`, `nano`, `mini` ou `haiku` = fraco, e aí o
arco vem do fallback por código. **Presets de fonte** (topo de /agents) trocam todos os agentes de fonte de uma vez.

### Modos de jogo

`campaigns.state.play = { mode, objectiveId?, beatId?, title?, scope? }`.

- **Missão (só opções)**: o campo de texto some e fica a faixa "Missão principal: X" (acento) ou "Missão: X" (info);
  a ação é um dos cartões de opção (teclas 1-4). A API recusa texto livre em missão com 400 (Continuar e gerar novamente
  passam). O código garante 3-4 opções, ≥1 composta montada da ficha (técnicas e itens que o jogador tem, até 3 passos,
  resolvidos passo a passo) e ≥1 de avanço; faltando, entram as saídas do cartão e "Esperar e observar"
  (`missionOptions`, `src/lib/contracts.ts`). Opção `exit` = **abandonar**: a missão falha; na principal, o beat fica
  perdido (o fallback vira notícia) e o primeiro relógio do arco anda um segmento. Em missão, todo uso de técnica conta
  como arriscado.
- **Exploração**: texto livre (Intérprete) com as opções como sugestão.
- **Conversa particular**: livre em qualquer modo (botão "Falar com X" na faixa de missão, retrato do NPC ou a decisão
  do Jev numa fala no chat da campanha).

Entra em missão: beat ativo com recompensa (principal), `mission accept` do bloco, aceitar no painel ou numa conversa.
Sai ao concluir, falhar, perder o prazo ou abandonar; se uma principal abriu enquanto o jogador estava numa secundária,
ele entra nela em seguida.

### Missões: principal × secundária e o quadro

Objetivos ficam em `campaigns.state.objectives` (`src/lib/objectives.ts`), com `scope: main|side`, `arcId`, `beatId`.
Toda missão tem tamanho de XP e pagamento: sem `pay`, o código põe pelo tamanho a partir dos preços de referência do
mundo (pequena = começo da faixa D, média = C, grande = B; `defaultPay`). XP e pagamento entram por código ao concluir,
uma vez (`xpGiven`, `payGiven`).

**Quadro de missões** (`boardOffers` + `ensureBoard`, `src/lib/story.ts`): em exploração e sem secundária aberta, o
código completa até 3 ofertas no painel Missões: 1 ligada à trama (o detalhe ou a pista de um beat que vem, senão o
pedido de um NPC com agenda), prova de técnica parada no platô e no máximo 1 doméstica rank D por dia de jogo (sem
repetir a dos últimos 5 dias). Ofertas do quadro não abrem aviso na tela, não vão ao Narrador e saem depois de 2 dias.
Aceitar no painel entra em missão; em missão não dá para aceitar outra.

### Campanha como estado

Tabelas `arcs`, `beats`, `clocks`, `hooks` (`src/lib/story.ts`).

- **Beat** = o que o MUNDO faz (nunca ato do personagem do jogador), com gatilho (beat anterior, dia, relógio ou pergunta
  sim/não ao Jev), prazo, `fallback` fora de cena, `foreshadow`, pista e recompensa. O código avança tudo
  (`stepStory`, puro): relógios por dia e cena, vencido vira perdido e o fallback vira evento público e notícia, o beat
  em jogo nunca é perdido pelo prazo, nenhuma missão do jogador é tocada pelo beat, arco acabado abre o próximo.
- **Roteirista** escreve; validação por código + regex/Jev contra beat que exige ato do jogador; fallback: um beat por
  episódio do cânone (`references/<mundo>/NN-*.md`) ou arco genérico da premissa.
- **Diretor** monta o cartão (`scenes.state.card`): objetivo, conflito, intenção dos NPCs, pista, detalhe a plantar,
  ganchos parados > 5 cenas, saídas, segredos. Fallback: cartão do beat de maior prioridade.
- A aba **Roteiro** mostra só título, o que está em jogo e os relógios (os beats são spoiler).

### Memória por testemunha

Tabelas `events` (fatos atômicos, embedding opcional, full-text) e `knowledge` (`witnessed|told|public`), em
`src/lib/knowledge.ts`.

- Quem testemunha é decidido por código: jogador + NPCs na cena no fim do turno; conversa particular: só os dois.
  `public` vale para todos, inclusive NPC criado depois. `told` (inclusive o jogador contando) vem do bloco; se a ação
  traz fala entre aspas para um NPC em cena e o bloco veio sem `told`, o código registra o que o jogador disse
  (`spokenTold`; pergunta não conta).
- **SABE**: cada NPC em cena chega ao Narrador (e ao agente NPC) com até 8 fatos dele; mais "o que só o jogador sabe".
- **Pós-checagem** do Jev por NPC que falou: fala fora do SABE → refaz a narração uma vez (`meta.leaks`).
- **Anti-bajulação**: NPC sustenta só o que está no SABE; correção de algo que ele não viu, aceita ou confere; do que ele
  viu, mantém com educação; no máximo uma desculpa por cena. **Anti-pergunta**: a narração termina numa ação ou fala do
  mundo; NPC só pergunta quando é a agenda dele.
- NPC genérico (Lojista, Guarda...) ganha o local no nome. `memories` guarda só as diretrizes do jogador; diretriz que
  só fala de registro (ferramentas) não vai ao Narrador.
- Histórico inteiro vetorizado em `history_chunks`; o Narrador consulta com `search_history`.

### Progressão sem grind

Contas em `src/lib/progression.ts`; o Resolvedor só escolhe dificuldade e horas.

- Domínio da técnica 0-100% (bônus no teste e custo por faixa); nível de poder pela XP (teto de atributo, pontos livres);
  cargo só muda na história.
- **Retorno decrescente** por técnica por dia de jogo: o 2º bloco de treino rende metade, o 3º nada (o Narrador recebe
  "platô de cansaço"). Uso da mesma técnica sem risco (sem alvo, fácil, fora de missão) também decresce: 1º inteiro,
  2º metade, 3º zero.
- **Salto de faixa por prova**: treino e uso sem risco param um ponto antes do próximo marco da técnica; só o uso
  arriscado (alvo, difícil, em missão) passa. Técnica parada no platô gera uma oferta "Prova: X" no quadro.
- Limites do dia continuam: 10 h de treino e +25% de domínio por técnica.

### Troca de modelo segura e modelo fraco

| Papel | Recebe | Validação | Fallback |
|---|---|---|---|
| Narrador | system ~1,2k tokens com 1 exemplo; contexto do turno montado do banco | prosa sem número de regra; bloco campo a campo (técnica/item na ficha, alvo em cena, missão existe, compra ≤ saldo) | Anotador; sem bloco = efeitos vazios + saídas do cartão; em missão, opções montadas pelo código |
| Intérprete | ação + ficha resumida | JSON contra a ficha | 1 passo `other` médio |
| Diretor | ≤ 3 beats, relógios, NPCs | beatId de lista fechada, nomes em cena | cartão do beat |
| Roteirista | estado + cânone | gatilhos, prazos, fallback, ≥ 4 beats, regex + Jev | cânone ou arco genérico |
| Anotador | texto + listas da campanha | mesmo validador do bloco | nada registrado |
| NPC | persona + SABE + lore | — | segue o turno normal |
| Jev | perguntas tipadas com default | limiares no código, probe em `jev-check.ts` | todo `null` tem caminho por código |

### Checagens sem IA

`npx tsx scripts/<nome>.ts`; usam campanhas temporárias (apagadas no fim) e rede falsa quando precisam de modelo.

- `eval-check` contrato do Narrador (prosa, bloco, Intérprete, opções de missão, `told` pela fala, pagamento padrão).
  Com `--campaign <id>`, lê as narrações gravadas e imprime a taxa de narrações que terminam em pergunta, com número de
  regra e com fala fora do SABE.
- `story-check` gatilhos, relógios, perdido, Roteirista, cânone, cartão, missão do beat, abandonar, quadro, foto.
- `objectives-check`, `money-check`, `progression-check`, `knowledge-check`, `talk-check`, `cast-check`, `meta-check`,
  `regen-check`, `stop-check`, `corrections-check`, `history-check`, `cache-check`, `table-check`, `world-check`,
  `advanced-check`, `characters-check`, `library-check`, `library-source-check`, `adventure-check`, `agents-check`,
  `cost-check`, `game-screen-check`, `jobs-check`, `portrait-check`, `sources-check`, `stream-check`, `theme-check`,
  `ooc-check`, `chatgpt-auth-check`.
- `jev-check` chama a API do Jev (custo desprezível): rode ao trocar o modelo de decisão ou mexer nas perguntas.

**Linha de base** (campanha antiga `50241ec9`, motor anterior, 573 narrações, `eval-check --campaign`): 18% terminam
em "?" (23% com pergunta no último parágrafo; o diagnóstico contou 33-38% por outra regra), 23% com número de regra,
fala fora do SABE sem dado (gravada só desde a F3). Rode de novo numa campanha nova para comparar.

### Custos

- Narrador com ~4-6k tokens de entrada (antes 19-37k) e quase sempre uma chamada; Diretor só por cena/beat/8 turnos;
  Intérprete e Anotador baratos; Jev ~US$0,00005 por chamada.
- Livros, histórico e fatos entram por relevância (top-k), nunca inteiros.
- **/usage** (Custos e uso): custo, tokens, tempo e erros por agente, modelo e dia, com request/response de cada chamada.

## Conversa fora do jogo, correções e "gerar novamente"

- **Fora do jogo** (botão no cabeçalho e no composer): o jogador fala com o Mestre como pessoa. Pedidos de dificuldade,
  dados, XP e descanso viram regras da mesa; erro pontual ele desfaz na ficha com as ferramentas de registro; orientação
  de condução vira diretriz. Reclamação do registro escrita no chat do jogo também vem para cá (Jev).
- **Correções do jogador** (`src/lib/corrections.ts`): Corrigir na Ficha, no Inventário, domínio da técnica e status da
  missão; cada efeito aplicado tem **desfazer** na etiqueta do último turno.
- **↻ gerar novamente** desfaz o turno pela foto (`turn_snapshots`: fichas, cena, estado, arcos, beats, relógios,
  ganchos, fatos e quem sabe, `state.play`) e refaz a mesma ação ou opção; **Continuar** segue a cena sem o personagem
  agir; o lápis edita a última ação (fora de missão).

## Fontes e Login com ChatGPT

Fontes ficam em **Configurações > Fontes de modelos**: OpenRouter (padrão) e qualquer API compatível com a da OpenAI
(OpenAI, Anthropic, Gemini e OpenCode já vêm com a URL). Cada agente escolhe a sua fonte.

**Login com ChatGPT** (preview): a fonte OpenAI pode usar o plano do ChatGPT. Adicione a fonte com a autenticação
"Login com ChatGPT" e clique em **Continuar com o ChatGPT**; o retorno vem em `http://127.0.0.1:3000/auth/callback` e
os tokens ficam só no banco local. Vai pela Responses API (`src/lib/responsesApi.ts`); temperatura e máximo de tokens
são ignorados; Ilustrador, Voz, Jev e embeddings não funcionam nela. Verificação: `scripts/chatgpt-auth-check.ts`.

## Biblioteca, retratos e tarefas em segundo plano

- **Biblioteca** (`library`): técnicas e itens do mundo; o Criador de habilidades cria o que falta e guarda. Lotes com
  foco pela aba Biblioteca.
- **Retratos**: um por personagem, só ao clicar em Gerar retrato (Ilustrador, com a geração de imagens ligada).
- **NPC novo**: o bloco registra nome, sexo e brief; o Criador de personagens monta perfil e ficha em segundo plano.
- **Tarefas** (`jobs`): perfis, retratos e lotes rodam fora do turno; o cabeçalho mostra o progresso.

## Voz dos NPCs

🔊 numa fala de NPC lê a fala com o modelo de TTS do agente **Voz** (padrão `heygen/heygen-voice-1-turbo:free`), voz
masculina ou feminina pelo sexo do NPC (trocável no modal). O áudio fica em `tts_cache`.

## Mecânica configurável

A mecânica (atributos, recursos, tipos e custos de habilidade, ranks, níveis de poder, treino, moedas e preços de
referência, lore) é um JSON. O preset de Naruto está em [`naruto-ruleset.json`](./naruto-ruleset.json). Para outro
cenário, copie, ajuste e importe no assistente, ou use **Criar com IA** (Criador de aventuras, `src/lib/adventure.ts`).

- **Regras da mesa** (painel Mesa, `src/lib/table.ts`): dificuldade (ajuste de CD geral e por tipo de ação), críticos,
  ritmo de XP e descanso valem no Resolvedor e nos efeitos. Os textos de modo de cena e as notas ficam guardados mas
  hoje não chegam ao Narrador.
- **Relógio** (`state.clock`): o `time` do bloco escolhe uma faixa (minutos a manhã seguinte) e o treino soma as horas;
  prazo vencido marca a missão como perdida.
- **Dinheiro** (`Ruleset.currency`): uma ou várias moedas, saldo na menor; muda por compra, pagamento de missão ou
  correção.

## Interface

Design system em [`DESIGN.md`](./DESIGN.md) (tokens, temas, componentes). Cada campanha tem um tema (`chronicle`,
`arcano`, `shinobi`, `neon`, `estelar`, `gotico`). A narração chega em streaming; avisos de dano, XP, itens e missões
saem da diferença de estado; no celular, a lateral vira folha.

## Estrutura

```
naruto-ruleset.json        preset de Naruto
references/<mundo>/        cânone por arco (fallback do Roteirista)
scripts/*-check.ts         checagens sem IA (e jev-check, com o Jev)
scripts/eval/fixtures/     trechos reais da campanha para o contrato do Narrador
src/lib/
  engine.ts                turno, contexto do Narrador, opções de missão
  contracts.ts             tipos e validadores do bloco, Intérprete, prosa, opções de missão, oráculo
  resolver.ts              Intérprete e Resolvedor
  effects.ts               aplica o bloco de efeitos; Anotador
  story.ts                 arcos, beats, relógios, ganchos, Roteirista, Diretor, modo de jogo, quadro de missões
  knowledge.ts             fatos e quem sabe (SABE)
  objectives.ts            missões (escopo, pagamento padrão, XP) e modo de jogo
  progression.ts           domínio, níveis, treino com retorno decrescente e platô
  decisions.ts             Jev: perguntas, limiares, fallbacks
  agents.ts                agentes padrão
  tools.ts                 ferramentas (Narrador: 3 de leitura; fora do jogo: registro)
  npc.ts, ooc.ts           conversa particular e fora do jogo
  schema.sql               schema idempotente
src/app/                   telas e rotas (Next.js App Router)
```
