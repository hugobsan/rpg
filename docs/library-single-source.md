# Biblioteca como fonte única de habilidades

Status: concluído e migrado em 2026-11-01. Backups de antes da migração: `backups/pre-library-migration-2026-11-01.dump` e `backups/pre-library-migration-final-2026-11-01.dump` (`pg_restore -U rpg -d rpg --clean`); log da migração em `backups/library-migration-2026-11-01.log`.

## Objetivo

A biblioteca passa a ser a única descrição de cada habilidade (jutsu). A ficha de cada personagem (jogador e NPC)
guarda só a relação com a entrada da biblioteca e os dados que variam por personagem. A biblioteca deixa de ser
por campanha e passa a ser por tipo de campanha (mundo), compartilhada por todas as campanhas daquele mundo.

## Contrato

### 1. Mundo (escopo da biblioteca)

- `Ruleset.world?: string`: slug do tipo de campanha (ex.: `"naruto"`). O preset `naruto-ruleset.json` tem `"world": "naruto"`.
- Campanha criada sem `world` no ruleset recebe `slug(ruleset.name)` na criação (`src/app/api/campaigns/route.ts`).
- `worldOf(campaign)` em `src/lib/library.ts` é o único jeito de obter o mundo (com fallback para o slug do nome).

### 2. Tabela `library`

- Novas colunas: `world TEXT NOT NULL`, `deleted_at TIMESTAMPTZ` (soft delete).
- `campaign_id` vira opcional (`ON DELETE SET NULL`): só registra em qual campanha a entrada nasceu.
- Índice único: `(world, kind, lower(name)) WHERE deleted_at IS NULL`.
- Listagem e busca ignoram as excluídas; a leitura por id (hidratação da ficha) inclui as excluídas.
- Excluir = `UPDATE ... SET deleted_at = now()`. Nada é apagado de verdade.

### 3. Entrada de habilidade (`LibraryAbility`)

Só o que é da técnica e não varia com quem usa nem com a mesa:

| campo | |
|---|---|
| `name` | nome no padrão do mundo (seção 6) |
| `translation?` | tradução para exibição (Naruto: em português). Não é um nome alternativo: ficha e biblioteca se ligam pelo id |
| `type` | key de `abilityTypes` |
| `element?` | key de `Ruleset.abilityElements` (Naruto: natureza do chakra: katon, suiton, futon, doton, raiton); vazio = sem elemento. Filtro "Elemento" na aba Jutsus e na Biblioteca |
| `rank?` | rank da técnica (D/C/B/A/S) |
| `costFree?` | `true` se a técnica não gasta recurso (técnicas físicas, armas, ofícios, passivas) |
| `consumption?` | key de `Ruleset.abilityCosts.byConsumption` (faixa de consumo do mundo): quanto recurso gasta, independente do rank. Validada contra as keys do ruleset |
| `costUnit?` | texto livre: o custo é por unidade ("clone", "rodada", "invocação"); `use_ability` recebe `units` |
| `description?`, `effect?`, `damage?`, `requirements?` | |
| `milestones?` | marcos de domínio (o progresso é de cada personagem) |
| `users?` | quem é conhecido por usar no cânone |
| `incomplete?` | `true` quando foi registrada sem o Criador (só com o que o Mestre passou); o Mestre deve completar com `edit_ability` |

Sai da biblioteca: `cost` (o valor é regra do mundo e o ajuste é de quem usa).

### 4. Habilidade na ficha

- Formato gravado em `characters.sheet.abilities`: `{ ref: number; progress?: number; costMult?: number }[]` (`ref` = `library.id`;
  `costMult` = multiplicador de custo desta técnica para este personagem, ex.: linhagem por implante ×1,5; ausente = 1).
- `Sheet.costMult?`: multiplicador geral de custo do personagem (rótulo do mundo em `Ruleset.costControlLabel`; sem ele, "Eficiência").
- Formato em memória (`Ability`): a entrada da biblioteca hidratada + `ref` + `progress` + `removed?: true` se a entrada foi excluída (soft delete).
- `hydrateSheets(chars)` / `hydrateSheet(sheet)` em `library.ts`: uma consulta por lote (`WHERE id = ANY($1)`), mantém a ordem da ficha.
  Toda leitura de `characters` que use `sheet.abilities` passa por ela. Entrada sem `ref` (formato antigo) é mantida
  como está, para não quebrar, e a checagem acusa.
- `dehydrateSheet(sheet)`: reduz cada habilidade a `{ ref, progress, costMult? }` (costMult 1 não é gravado). Todo `UPDATE/INSERT` de `characters.sheet` passa por ela.
- `turn_snapshots` guardam o formato gravado (com `ref`); a migração converte os antigos.

### 5. Custo

- `abilityCost(r, a)`: `costFree` → `{ resource, amount: 0 }`; senão o `cost` da faixa `a.consumption` em
  `r.abilityCosts.byConsumption` (lista `{ key, label, cost, description? }` do mundo, opcional); sem faixa,
  `r.abilityCosts.byRank[a.rank]`; sem rank → `null`; mundo sem `abilityCosts` → `null` (sem custo).
- `effectiveCost(r, a, { sheet, units })`: base × units (só com `costUnit`, 1 a 1000) × `sheet.costMult` × `a.costMult` (vínculo,
  0,5 a 2) × multiplicador do domínio (`masteryCost`), arredondado no total (acréscimo para cima, desconto para baixo),
  nunca abaixo de 1 se a base > 0. `costBreakdown` escreve a conta (tooltip da aba, resposta do `use_ability`).
- `set_cost_modifier { character, ability?, mult, reason }` (Mestre e fora do jogo) ajusta o geral ou o do vínculo.
- Naruto: faixas e rótulo em `naruto-ruleset.json`; consumo de cada técnica e costMult dos NPCs canônicos em
  `scripts/data/naruto-costs.json` (aplicado por `scripts/library-consumption.ts`); praticabilidade em `scripts/cost-check.ts`.

### 6. Padrão de nomes (Naruto)

- Técnica do cânone: nome romanizado oficial da Narutopedia em Hepburn com mácrons, sem parênteses e sem tradução
  no nome. Ex.: `Katon: Gōkakyū no Jutsu`, `Kage Bunshin no Jutsu`, `Doton: Doryūheki`.
  A tradução vai em `translation` (ex.: `Liberação de Fogo: Técnica da Grande Bola de Fogo`).
- Técnica original da campanha (sem nome no cânone): nome descritivo em português, sem `translation`.
- O padrão fica no ruleset: `Ruleset.abilityNaming?: string` (texto para o Criador e o Mestre). O preset Naruto o define.

### 7. Fluxos

- `add_ability` (Mestre): procura no mundo pelo nome (sem diferenciar maiúsculas e acentos, `fold`), sem as excluídas →
  se não achar, chama o Criador de habilidades (que segue `abilityNaming`) → grava na biblioteca → liga na ficha.
  Se o Criador falhar, grava na biblioteca com o que o Mestre passou e `incomplete: true` → liga na ficha. A ficha
  sempre recebe uma `ref`.
- `edit_ability` (Mestre e Fora do jogo): altera a entrada da biblioteca (inclusive renomear dentro do padrão). Como as
  fichas apontam pelo id, vale na hora para todos que a têm, em todas as campanhas do mundo.
- Criador de personagens (NPC): cada habilidade vira `ref` (`ensureAbility`); se falhar, mesma regra do `incomplete`.
- Criação de campanha: kit inicial (`startingAbilities`) e extras da tela entram na biblioteca do mundo se ainda não
  existem (sem IA, `source: "gm"`) e a ficha recebe as `ref`.
- "Trazer das fichas" (botão, ferramenta do Fora do jogo, `POST {from:"sheets"}`) deixa de existir: não há mais
  habilidade fora da biblioteca.
- Excluir na biblioteca: soft delete; quem já tem continua tendo (a ficha mostra que saiu da biblioteca).
- Inventário: fora deste escopo (itens da biblioteca mudam para o escopo do mundo, mas o inventário continua como está).

### 8. Testes (scripts/*-check.ts)

Campanhas temporárias dos scripts usam `ruleset.world = "test-<uuid>"` e apagam as linhas desse mundo no fim, para
nunca sujar a biblioteca real.

## Critérios de aceite

Cada item diz como é conferido. "Banco" = consulta SQL no banco local; "check" = script sem IA em `scripts/`.

| # | resultado esperado | como conferir |
|---|---|---|
| A1 | Nenhuma ficha guarda definição de habilidade: toda entrada de `sheet.abilities` tem só `ref`, `progress` e `costMult` | banco: `jsonb_object_keys` das entradas de todas as fichas ⊆ {ref, progress, costMult} |
| A2 | Toda `ref` aponta para uma linha existente da biblioteca do mesmo mundo da campanha | banco: join fichas × library por id e world, zero órfãs |
| A3 | Os mesmos dois critérios valem para `turn_snapshots` | banco |
| A4 | A biblioteca não tem `cost` em nenhuma entrada; técnicas que não gastam recurso têm `costFree` | banco |
| A5 | Toda linha da biblioteca tem `world`; a da campanha atual é `naruto` | banco |
| A6 | Nenhum nome fora do padrão: sem parênteses, todos os nomes de `library-names.json` aplicados, duplicadas juntadas | banco × `scripts/data/library-names.json` |
| A7 | Nenhuma habilidade se perdeu: cada personagem tem as mesmas habilidades (pelo mapa de nomes) e o mesmo domínio de antes | banco atual × backup restaurado num banco temporário |
| A8 | Custo exibido e cobrado = (faixa de consumo ou `byRank[rank]`) × units × costMult da ficha × costMult do vínculo × multiplicador do domínio, ou 0 se `costFree` | check (`use_ability` via `executeGmTool`; `scripts/cost-check.ts`) |
| A9 | `add_ability` sempre liga uma `ref`: jutsu da biblioteca, jutsu novo pelo Criador e jutsu com Criador falhando (`incomplete: true`) | check, com o Criador simulado |
| A10 | `edit_ability` muda a entrada e a mudança aparece na ficha de todos que a têm, inclusive de outra campanha do mesmo mundo | check com duas campanhas de teste no mesmo mundo |
| A11 | Excluir na biblioteca é soft delete: some da lista e da busca, continua na ficha marcado como removido | check + tela |
| A12 | Campanha nova: kit inicial e extras da criação entram na biblioteca do mundo (sem duplicar) e a ficha recebe `ref` | check |
| A13 | Checks não sujam a biblioteca real (mundo `test-*`, apagado no fim) | banco: zero linhas `world LIKE 'test-%'` depois dos checks |
| A14 | "Trazer das fichas" não existe mais (botão, ferramenta, rota) | grep |
| A15 | Telas: aba Jutsus, ficha de NPC e Biblioteca mostram nome, tradução, custo calculado e o aviso de removida | navegador |
| A16 | `npx tsc --noEmit` e `next lint` sem erros; todos os `scripts/*-check.ts` passam | rodar |
| A17 | Prompts gravados no banco: Mestre, Escrivão e Fora do jogo citam `edit_ability`; Criadores seguem o padrão de nomes e não pedem custo na biblioteca | banco: tabela `agents` |

| A18 | O diagrama de agentes (`src/app/agents/AgentsFlow.tsx`, tela /agents) mostra o fluxo novo: biblioteca por mundo, ficha ligada à biblioteca, `edit_ability` no Mestre e no Fora do jogo, sem "Trazer das fichas" | leitura do diagrama × código + navegador |

Fora do alcance da verificação automática: se o Mestre, numa partida de verdade, consulta a biblioteca, usa `edit_ability` quando deve e se o Criador segue o padrão de nomes em técnicas novas. Isso depende do modelo e só aparece jogando (ou num turno real, que gasta API).

## Fases

| fase | o quê | arquivos |
|---|---|---|
| 1a | base: schema, tipos, library.ts (mundo, soft delete, hidratação, edição, custo) | schema.sql, db.ts, types.ts, library.ts, ruleset.ts (abilityCost) |
| 1b | mapa de nomes: nome atual → nome no padrão + tradução, junções de duplicadas | `scripts/data/library-names.json` |
| 2a | ferramentas e regras de jogo | tools.ts, ooc.ts, progression.ts |
| 2b | leituras e criação | engine.ts, characters.ts, npc.ts, suggest.ts, turnSnapshot.ts, rotas em src/app/api |
| 2c | telas | AbilitiesView, LibraryView, NpcModal, Wizard |
| 2d | prompts e preset | agents.ts (+ correção dos prompts gravados no banco), naruto-ruleset.json, adventure.ts |
| 3 | migração dos dados | `scripts/library-migration.ts` |
| 0 | diagrama de agentes em dia com o que mudou antes desta feature (em paralelo à fase 1) | src/app/agents/AgentsFlow.tsx, AgentsDiagram.tsx |
| 4 | checagens, revisão e diagrama de agentes com o fluxo novo | scripts/*-check.ts, tsc, revisão independente, AgentsFlow.tsx |
