# API da fase 1 (src/lib/library.ts, types.ts, ruleset.ts)

Referência para os agentes da fase 2. Não edite library.ts, types.ts, schema.sql nem ruleset.ts (exceto onde o seu prompt autorizar); se precisar de algo novo neles, descreva no relatório.

```ts
worldOf(campaign: { ruleset: Ruleset }): string   // ruleset.world || slugKey(ruleset.name) (slugKey de table.ts)
listLibrary(campaign: Campaign, kind: LibraryKind, opts?: { query?: string; limit?: number }): Promise<LibraryEntry[]>   // sem excluídas
findLibrary(campaign: Campaign, kind: LibraryKind, name: string): Promise<LibraryEntry | null>   // sem diferenciar caixa/acento, sem excluídas
getLibraryByIds(ids: number[]): Promise<LibraryEntry[]>   // inclui excluídas (deleted: true)
hydrateSheets<T extends { sheet: Sheet | StoredSheet }>(rows: T[]): Promise<(Omit<T,"sheet"> & { sheet: Sheet })[]>
hydrateSheet(sheet: Sheet | StoredSheet): Promise<Sheet>
dehydrateSheet(sheet: Sheet | StoredSheet): StoredSheet   // abilities → { ref, progress }; entrada sem ref (formato antigo) fica intacta
linkAbility(campaign, name, opts?: { brief?; fallback?: Record<string, unknown>; timeoutMs?; onCreator?: () => void }): Promise<{ entry: LibraryEntry; from: "library" | "creator" | "incomplete" }>   // ref = entry.id; se o Criador responder depois do prazo, completa a incompleta
ensureLibraryAbility(campaign, ability: unknown, source?: "agent"|"gm" = "gm", canon = false): Promise<LibraryEntry | null>   // sem IA (kit inicial, extras da criação)
editAbility(campaign, target: string | number, patch: Record<string, unknown>): Promise<LibraryEntry | string>   // string = erro legível; null no patch apaga o campo; editar tira incomplete
ensureAbility(campaign, name, brief?): Promise<LibraryEntry | null>
importSheetAbilities(campaign): Promise<{ added: string[]; total: number }>   // só para a migração; as chamadas na UI/OOC/rota saem
deleteLibrary(campaign, id): Promise<boolean>   // soft delete
fillLibrary(campaign, kind, total, make, progress) / generateLibrary(campaign, kind, count, focus, canon)
itemText, libraryLine(r, e), pickKey, normalizeAbility(r, raw), normalizeItem, fallbackAbility(r, name, args), parseCreatorJson, creatorPrompt, creatorName, BATCH, MAX_GENERATE
```

Tipos:
- `Ruleset.world?`, `Ruleset.abilityNaming?`
- `LibraryAbility { name; translation?; type; rank?; costFree?; description?; effect?; damage?; requirements?; milestones?; users?; incomplete? }` (sem `cost`)
- `Ability extends LibraryAbility { ref?: number; progress?: number; removed?: true }` (formato em memória; `Sheet.abilities: Ability[]`)
- `StoredAbility = { ref: number; progress?: number }`, `StoredSheet = Omit<Sheet,"abilities"> & { abilities: (StoredAbility | Ability)[] }`
- `LibraryEntry` ganha `world: string`, `deleted?: boolean`
- `abilityCost(r, a)` (ruleset.ts): sem `r.abilityCosts` → null; `costFree` → 0; senão `byRank[rank]`; sem rank → null. `effectiveCost` aplica o domínio.

Regras para todos:
- Toda leitura de `characters` cujo `sheet.abilities` seja usado passa por `hydrateSheets`/`hydrateSheet`.
- Todo INSERT/UPDATE de `characters.sheet` passa por `dehydrateSheet`.
- Identidade de habilidade na ficha = `ref` (não o nome). Dedupe por `ref`.
- A ficha nunca recebe habilidade sem `ref` (use `linkAbility` ou `ensureLibraryAbility`).
- Não faça commit. Outros agentes editam outros arquivos ao mesmo tempo: no `npx tsc --noEmit -p .`, conserte só os erros dos seus arquivos.
- O banco local (docker `rpg-pgvector`, `psql -U rpg -d rpg`) ainda NÃO foi migrado: não rode a migração nem altere dados; leitura é livre.
