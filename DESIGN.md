# Chronicle RPG: design system

Fonte única de verdade da interface. CSS puro em `src/app/globals.css` (sem Tailwind, sem lib de UI).
Se algo aqui não cobre o seu caso, siga o espírito e avise quem mantém este arquivo.

## Princípios

1. **Mesa de jogo, não dashboard.** Atmosfera (luz, textura, profundidade), mas a narração do Mestre é o centro: leitura confortável vem antes de enfeite.
2. **O tema é da campanha.** Paleta, fonte display, textura e cores de modo vêm do tema. Componentes só usam tokens; **nenhuma cor solta** (`#hex`, `rgb()`) em componente. Cor que vem de dado (cor do recurso no ruleset) é a exceção.
3. **Movimento com propósito.** Entrada suave de conteúdo novo, retorno de hover/press, mudança de estado. Nada de animação em loop decorativa (só loaders e skeletons).
4. **Estado sempre desenhado.** Carregando = skeleton no formato do conteúdo ou `<Loader/>` temático. Vazio = frase útil + ação. Erro = `.error-box` perto de onde aconteceu, ou toast se for passageiro. Nunca "Carregando..." em texto puro.
5. **Acessível por padrão.** Texto AA (4.5:1), foco visível (já global), alvo de toque ≥ 36 px em `pointer: coarse`, `prefers-reduced-motion` respeitado (já global).

## Temas

Todos escuros. Aplicar com `data-theme` num elemento; dentro dele todos os tokens mudam.

| key | Nome | Paleta | Display | Narração | Glifo |
|---|---|---|---|---|---|
| `chronicle` | Chronicle (padrão) | obsidiana + âmbar | Cormorant Garamond | Literata | ◆ |
| `arcano` | Arcano | violeta profundo + ouro, poeira de estrelas | Cinzel | Literata | ✦ |
| `shinobi` | Shinobi | tinta sumi, fibra de washi, vermelhão | Shippori Mincho B1 | Literata | ※ |
| `neon` | Neon | preto azulado, ciano + magenta, scanlines | Chakra Petch | Geist | // |
| `estelar` | Estelar | ardósia fria, teal, campo de estrelas | Michroma | Geist | ✧ |
| `gotico` | Gótico | carmesim, osso, névoa | IM Fell English | Literata | † |

- **Tela de jogo:** a raiz do jogo leva `className="... theme-root" data-theme={campaignTheme(campaign)} data-mode={scene.mode}`. Com `.theme-root`, o **documento inteiro** adota o tema (nav, fundo, toasts, modais em portal) por `:root:has(...)`, sem JS. Ao sair do jogo, volta ao padrão.
- **Telas fora do jogo:** tema padrão (não aplicar nada). Para prévia de tema (ex.: escolher tema na criação), `data-theme="x"` num cartão sem `.theme-root` tematiza só ele.
- `campaignTheme()` e a lista `THEMES` ficam em `src/lib/theme.ts` (client-safe): `campaign.state.theme` > `campaign.ruleset.theme` > inferência pelo nome do ruleset > `chronicle`.
- `data-mode` (`exploration|dialogue|battle|training|downtime`) define `--mode` com a cor do modo atual: use `var(--mode, var(--accent))` para tingir banner, bordas, brilho.

## Tokens

Use sempre pelo nome. Os nomes antigos (`--bg`, `--bg-panel`, `--text-dim`...) **são** os tokens oficiais (estilos inline existentes continuam valendo).

**Superfícies** (do fundo para cima)
| token | uso |
|---|---|
| `--bg-sunken` | campos de formulário, trilho de barra, poços, `pre` |
| `--bg` | fundo da página e do feed |
| `--bg-raise` | cromo: nav, barra lateral, composer, banner, tooltip |
| `--bg-panel` | cartões, modais, itens de lista; prefira `--panel-grad` (mesmo tom com luz no topo) |
| `--bg-hover` | hover de linha/item |

**Linhas e texto**: `--border` (padrão), `--border-strong` (hover, modal); `--text` (corpo), `--text-dim` (secundário, AA), `--text-faint` (meta não essencial e placeholder, ~3.6:1: nunca para texto que o jogador precisa ler).

**Acento**: `--accent` (texto, links, foco, destaques; AA sobre superfícies), `--accent-fill` (fundo de botão primário), `--accent-ink` (texto sobre `--accent-fill`), `--accent-soft` (fundo tingido 13%), `--accent-line` (borda tingida 42%), `--accent-2` (só ornamento: brilho, detalhe; nunca texto nem interação), `--glow` (box-shadow de brilho), `--ring` (anel de foco em campos).

**Estado**: `--danger`, `--ok`, `--warn`, `--info`, `--ooc` (fora do jogo) e as versões `--danger-soft`, `--ok-soft`, `--warn-soft`, `--info-soft` para fundos.

**Modos de cena**: `--mode-exploration`, `--mode-dialogue`, `--mode-battle`, `--mode-training`, `--mode-downtime`, e `--mode` (o atual, via `data-mode`).

**Tipografia**: `--font-display` (títulos, nomes, números grandes), `--font-narr` (narração, falas de NPC), `--font-body` (UI), `--font-mono` (JSON, código). `--display-weight`, `--display-tracking` e `--display-scale` acompanham a fonte display do tema: ao usar a display fora de `h1-h3`, use a classe `.display` e multiplique o tamanho por `--display-scale` (`font-size: calc(20px * var(--display-scale))`). Antigos: `--serif` = display, `--sans` = body, `--mono` = mono.

**Espaço** (base 4): `--s-1` 4 · `--s-2` 8 · `--s-3` 12 · `--s-4` 16 · `--s-5` 24 · `--s-6` 32 · `--s-7` 48 · `--s-8` 64.

**Raio** (varia por tema: neon é quase reto, shinobi é cortado): `--r-sm` (botão pequeno, chip interno), `--r-md` (botão, campo, item), `--r-lg` (cartão, modal, balão), `--r-pill` (chips e badges).

**Elevação** (luz vem de cima): `--hl` (brilho de borda superior, inset), `--shadow-1` (cartão), `--shadow-2` (hover, popover), `--shadow-3` (modal, drawer). Cartão = `background: var(--panel-grad); border: 1px solid var(--border); box-shadow: var(--hl), var(--shadow-1)`.

**Movimento**: `--ease-out` (padrão de tudo), `--ease-in-out` (loops), `--ease-spring` (só pop pequeno, ex.: número subindo); `--dur-fast` 120 ms (press), `--dur` 200 ms (hover, cor), `--dur-slow` 360 ms (painel, modal), `--dur-enter` 480 ms (entrada de bloco). Keyframes prontos: `rise` (sobe 8 px + fade), `pop` (escala .98 + fade), `fade`, `pulse`, `shimmer`, `spin`. Anime só `transform` e `opacity`. Entradas com atraso em cascata usam `animation-fill-mode: backwards` (nunca `both`, que trava o `transform` do hover).

**Camadas**: `--z-nav` 50 · `--z-drawer` 80 · `--z-modal` 100 · `--z-viewer` 200 · `--z-toast` 300 · `--z-tooltip` 400. Nada de z-index solto acima de 20.

**Layout**: `--nav-h` (52 px; a tela de jogo usa `calc(100dvh - var(--nav-h))`), `--measure` (68ch, largura da narração). Breakpoints: 900 px (lateral do jogo vira drawer), 640 px (celular: modal vira folha de baixo, gutter 16 px).

## Tipografia

- `h1` display, ~34 px × escala, `text-wrap: balance`. `h2` 22 px, `h3` 17 px. Sentence case; nada de título em caixa alta (Cinzel já é versalete por natureza).
- Corpo de UI: Geist 15 px / 1.55. Secundário 13 px (`.muted`). Rótulo de seção: `.overline` (11 px, caixa alta, tracking): **no máximo um por bloco**.
- Narração (`.msg-gm`): `--font-narr`, `--narr-size` (17 px), entrelinha 1.78, `max-width: var(--measure)`. Nomes de NPC em `strong` saem no acento; ações em `em` saem em `--text-dim`.
- Números (atributos, custos, XP): `.num` ou `font-variant-numeric: tabular-nums`.

## Componentes (classes existentes, já reestilizadas)

Botões. Um primário por área; o resto secundário ou ghost.
```html
<button class="btn primary">Iniciar aventura</button>
<button class="btn">Exportar</button>            <!-- secundário: acento tingido -->
<button class="btn ghost small">excluir</button>  <!-- discreto -->
<button class="btn danger">Apagar campanha</button>
```

Cartão / painel e campo:
```html
<div class="card">
  <label class="field"><span>Nome da campanha</span><input type="text" /></label>
</div>
```

Chips: `.pill` (etiqueta), `.pill.on` (ativo/ok), `.pill.err`; filtro clicável: `<button class="pill filter-pill on">`. Badge de modo: `.mode-badge` com `style={{ color: "var(--mode-battle)" }}` (borda e fundo seguem `currentColor`).

Modal (no celular vira folha que sobe de baixo):
```html
<div class="modal-backdrop"><div class="modal" role="dialog" aria-modal="true">
  <div class="modal-head"><h3>Título</h3></div><div class="modal-body">…</div>
  <div class="modal-foot"><button class="btn ghost">Cancelar</button><button class="btn primary">Salvar</button></div>
</div></div>
```

Outros globais: `.msg-gm`, `.msg-player`, `table.plain`, `pre.log-json`, `.error-box`.

Componentes com estilo próprio (CSS Module ao lado do `.tsx`): estilo específico de um componente vai no `.module.css` dele, só com tokens; o `globals.css` fica para o que é genérico. Referências: abas e trilho em `src/components/game/SidePanel`, feed (falas, rolagens, escolhas) em `game/Feed`, barras de recurso e atributos em `SheetView`, conversa em `NpcModal`, cartões de campanha em `src/app/(home)`, passos do assistente em `src/app/campaigns/new`.

Utilitários: `.sr-only`, `.muted`, `.faint`, `.num`, `.overline`, `.display`, `.divider` (`<div class="divider"><span></span></div>`: linha com o glifo do tema no meio).

Tooltip (CSS puro, sem componente): `<span data-tip="Gasta 1 ponto livre">+</span>`. Põe `position: relative` no elemento; não funciona dentro de `overflow: hidden` (use `title` ali, ou um balão controlado por estado como o dos atributos em `SheetView`).

Drawer (base para a lateral do jogo no celular):
```html
<div class="scrim" onClick={close}></div>
<aside class="drawer open">…</aside>            <!-- da direita -->
<aside class="drawer bottom open">…</aside>     <!-- folha de baixo -->
```

Skeleton (CSS; o componente só embrulha): `<span class="skeleton title"></span>`, `.skeleton.text`, `.skeleton.block`, `.skeleton.circle` + `style={{ width, height }}`.

## Primitivas (`src/components/ui/`)

```tsx
import Skeleton from "@/components/ui/Skeleton";
import Loader from "@/components/ui/Loader";
import { toast } from "@/components/ui/Toast";
```

- **Skeleton** (server-safe): `<Skeleton w="60%" h={14} />` bloco, `<Skeleton lines={3} />` parágrafo (última linha mais curta), `<Skeleton circle w={32} h={32} />`, aceita `className="title|block"`. Shimmer no formato do conteúdo, `aria-hidden`. Envolva a área em `aria-busy="true"`. Ex.: lista de NPCs carregando = 3 × `<Skeleton h={52} className="block" />`.
- **Loader** (server-safe): `<Loader label="O Mestre está narrando" showLabel />` (padrão 40 px) ou `<Loader size={16} />` dentro de botão. Selo no acento do tema com o glifo do tema no centro; `role="status"`, o `label` vai para leitor de tela mesmo sem `showLabel`. Use em espera longa sem formato conhecido (turno do Mestre, imagem sendo pintada); quando o formato é conhecido, prefira Skeleton.
- **toast** (cliente; `<Toaster/>` já está no layout e herda o tema do jogo):
  `toast(texto, { kind?, title?, duration?, action? })` → id; `dismissToast(id)`.
  `kind`: `info` (padrão) · `sucesso` · `dano` · `cura` · `xp` · `alerta`. Duração 4,5 s (8 s para `alerta` ou com `action`); pausa com o mouse em cima; no máximo 4 na tela.
  `action: { label, onClick }` vira um `.btn small` no aviso e fecha ao clicar: `toast("Kakashi quer falar com você", { title: "Mensagem", action: { label: "Abrir", onClick: () => openNpc(id) } })`.
  Para eventos passageiros (dano, cura, XP, NPC saiu da cena, mensagem privada chegou); erro que pede ação do jogador fica inline.
- **Nav** (`ui/Nav.tsx`, montada no layout): link ativo por `aria-current="page"`; abaixo de 520 px só a marca fica, sem o nome.
- **Tema**: `import { campaignTheme, THEMES, type ThemeKey } from "@/lib/theme"`. `THEMES` = `{ key, label, description }[]` para um seletor; a escolha do jogador vai em `campaign.state.theme`. Checagem: `npx tsx scripts/theme-check.ts`.

## Proibido

- Cor solta em componente; `outline: none` sem substituto; z-index fora da escala.
- "Carregando..." em texto puro; spinner genérico de círculo.
- Animar `width/height/top/left` (exceção herdada: largura da `.bar-inner`); animação em loop fora de loader/skeleton; ignorar `prefers-reduced-motion` em JS (cheque `matchMedia` antes de animar por script).
- `backdrop-filter` em área que rola (só nav, modal, scrim, overlays fixos).
- Emoji como ícone em UI nova (os existentes saem aos poucos); `alert()`/`confirm()` em fluxo novo (use toast ou confirmação inline).
- Eyebrow/overline em todo título; texto de UI em inglês; travessão (—) em texto novo de UI.
- Tema claro, glow neon fora do tema `neon`, gradiente roxo "de IA" fora do `arcano`.
