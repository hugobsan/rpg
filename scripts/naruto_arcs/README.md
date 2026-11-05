# Arcos da Parte II (Naruto Shippūden)

Um arquivo por arco: `NN_chave.py` define `ARC = dict(...)`. `scripts/narutopedia.py` carrega todos sozinho.
A chave do arco e o arquivo de saída vêm do nome: `06_kazekage-rescue.py` -> arco `kazekage-rescue` -> `references/naruto/06-kazekage-rescue.md`.
O arco piloto é o `06_kazekage-rescue.py`: copie ele.

## Gerar um arco

    python3 scripts/narutopedia.py kazekage-rescue

Sempre passe a chave (sem argumento ele refaz todos). Na primeira vez baixa umas 150 páginas da wiki (1,1 s cada, uns 3 min);
depois sai do cache em `references/.cache/` (fora do git). Não use `python3 -c`/shell que rode de dentro de `references/`.

## Como criar um arco novo

1. `cp 06_kazekage-rescue.py NN_<chave>.py` (NN = ordem canônica, 2 dígitos; chave minúscula com hífen).
2. Ajuste, no `ARC`:
   - `title`, `name` (nome na wiki), `arc_page` (título da página do arco na Narutopedia; atenção aos sufixos: "Pain's Assault (Arc)", "Five Kage Summit Arc" funcionam, "Pain's Assault" não tem tabela de episódios).
   - `eps=(primeiro, último)` e `chapters="a-b"`: confira na página do arco (tabela "Episodes"/"Chapters"). A lista de episódios vem da tabela da página do arco, que só traz episódios canônicos, então fillers dentro do intervalo já ficam de fora (o script imprime `skipped` e `weak synopsis` no fim; olhe).
   - `part_sections`: títulos das subseções (nível 3) sob "Part II" nas páginas de personagem que contam este arco. Quase sempre é o nome do arco, mas confira em 2 ou 3 personagens (a wiki às vezes abrevia ou divide). Pode listar mais de um título.
   - `characters`, `techniques`, `places`: ver abaixo.
   - `bad=bad(...)`: spoilers, ver abaixo.
3. Rode, leia o resultado, itere (ver "Conferir").
4. Commite só o seu `NN_*.py` e o `references/naruto/NN-*.md`. Não mexa em `narutopedia.py` nem em `__init__.py` (se achar bug, avise).

## Escolher personagens, técnicas, lugares

- Personagens: quem aparece nas sinopses do arco. Truque: junte os links `[[...]]` do wikitext dos episódios e conte (ver o piloto: 25 personagens). Tamanho alvo do arquivo: 150-300 KB; o piloto tem 253 KB.
- Só entre personagem que já estreou no arco: página dele tem subseção "Part II > <arco>" (vira o bloco "papel no arco"). Quem estreia depois fica só com aparência/personalidade/habilidades gerais da página inteira, que vazam o futuro (no piloto tirei Sai, Yamato e Orochimaru por isso). Confira com `sections()` quais subseções a página tem.
- Técnicas: as que aparecem nas lutas (nome exato da página da wiki; se falhar aparece em `failed`, ache o título certo com `https://naruto.fandom.com/api.php?action=opensearch&search=...`).
- Lugares/organizações: páginas curtas viram esqueleto depois do filtro (ex.: "Hokage", "Anbu", "Tailed Beast" ficaram com uma frase solta e saíram). Se o bloco ficou com frase sem sujeito ("This allowed him to..."), tire a página.

## Escolher o regex de spoiler (`bad(...)`)

`bad()` já traz a base da Parte II (`__init__.py`): só o que é revelado depois do ÚLTIMO arco (Blank Period, filmes, Boruto, filhos, casamentos, Sétimo Hokage...). O que o cânone revela no meio da Parte II é com você: liste em `bad(...)` o que só é revelado DEPOIS do seu arco.

Método:
1. Leia o resumo e as seções "Part II" das páginas de personagem dos arcos seguintes (cache já tem muitas páginas) e anote nomes, termos e revelações novas (identidades, mortes, técnicas, bestas, organizações, guerra).
2. Comece pelo regex do arco anterior (o do piloto está pronto para copiar), tire o que o seu arco já revela (agora é conteúdo permitido) e some o que vem depois.
3. Regras do filtro: o regex roda com `re.I` em cada frase das páginas de personagem/técnica/lugar; frase que casa é cortada inteira; linha de lista (`- `) ou curta que casa sai inteira; em Aparência/Personalidade/Habilidades, se a 1ª frase do parágrafo casa, o parágrafo inteiro sai. Palavra curta que pode aparecer dentro de outra: `(?-i:Sai\b)`. Evite termos que existem no próprio arco (ex.: `Pain` só vale a pena banir se o arco é anterior ao Pain aparecer nas páginas).
4. Resumo do arco e sinopses dos episódios NÃO passam por `bad`: só por `text_bad` (em `PART2`, bem curto: Boruto, Blank Period...). Se uma frase da sinopse tem spoiler do futuro, ela é cortada e o script avisa `[corte em epN]`; revise esses avisos. Se precisar mudar, sobrescreva `text_bad=` no `ARC` depois do `**PART2`.

## Conferir (obrigatório, leia o arquivo)

O hook do rtk trunca saída de `grep` grande ("Output too large"); use python ou `rtk proxy grep`. Varredura de termos suspeitos nas seções que passam pelo filtro:

    python3 - <<'PY'
    import re
    t = open("references/naruto/NN-chave.md").read()
    rest = "\n".join(re.split(r"\n(?=## )", t)[3:])   # personagens, técnicas, lugares
    for m in re.finditer(r"Pain|Nagato|Madara|Hokage|died|death|war\b|Sage|Gaiden", rest):
        print(m.group(0), "|", repr(rest[max(0, m.start()-90):m.end()+90]))
    PY

(ajuste os termos ao seu arco) e depois LEIA os blocos dos personagens principais inteiros: vazamento aparece como frase solta de futuro, não como palavra-chave. Cheque também:
- cada personagem tem "papel no arco"? seções vazias ou cortadas no meio? lixo de wikitext (`File:`, `{{`, `[[`)?
- `characters/techniques/places ok N, failed [...]` no fim da execução.
- `git diff --stat references/naruto/` não mostra mudança nos arquivos 01-05.

## Pegadinhas que já apareceram

- Personagem que morre depois (Jiraiya, Itachi...) tem a página toda no passado ("Jiraiya was...") e frases tipo "had he lived longer", "Upon death", "single-handedly defeated". Os termos dessas frases entram no regex; o tempo verbal em si é vazamento leve que não dá para filtrar.
- Idade e Ninja rank da ficha vêm da infobox e valem para a Parte II inteira, não para o arco (ex.: Gaara "Kage", Sakura "Chūnin"); confira se não entrega promoção posterior. Naruto e Kakashi saem sem ficha (a página começa com um aviso de desambiguação e o script pega a tabela errada); Orochimaru sai com "File:Gender Various.svg" no Sexo. Os dois são bugs antigos (valem para a Parte I também) e não foram mexidos para os arquivos 01-05 não mudarem.
- A numeração dos episódios de Shippūden recomeça em 1 (o cabeçalho do arquivo diz isso). Capítulos do mangá seguem a numeração contínua (245 em diante).
- Páginas de episódio com "(episode)" no título: o script já tira.
- Texto da wiki traz a linha do tempo inteira ("Hokage Rock...", "Kakashi... Sixth Hokage" nas roupas, "seven Hokage in its history" no lugar Konoha): sempre procure o futuro nas seções gerais (Aparência, Habilidades, páginas de lugar), não só no "papel no arco".
- `PYTHONDONTWRITEBYTECODE=1` evita criar `scripts/__pycache__`/`naruto_arcs/__pycache__` (não commite).

## Arcos canônicos da Parte II (página da wiki | episódios de Shippūden | capítulos)

Os episódios vêm da tabela da página do arco (só canônicos); lacunas = filler.

| NN | `arc_page` | eps | capítulos |
|----|------------|-----|-----------|
| 06 | Kazekage Rescue Mission (pronto) | 1-32 | 245-281 |
| 07 | Tenchi Bridge Reconnaissance Mission | 33-53 | 282-310 |
| 08 | Akatsuki Suppression Mission | 72-88 | 311-342 |
| 09 | Itachi Pursuit Mission | 113-118, 121-126 | 343-367 |
| 10 | Tale of Jiraiya the Gallant | 127-133 | 368-383 |
| 11 | Fated Battle Between Brothers | 134-143 | 384-412 |
| 12 | Pain's Assault (Arc) | 152-175 (a tabela lista 22 de 24) | 413-453 |
| 13 | Five Kage Summit Arc | 197-214 | 454-483 |
| 14 | Fourth Shinobi World War: Countdown | 215-222, 243-256 | 484-515 |
| 15 | Fourth Shinobi World War: Confrontation | 261-289, 296-321 | 516-559 |
| 16 | Fourth Shinobi World War: Climax | 322-348, 362-375 | 560-639 |
| 17 | Birth of the Ten-Tails' Jinchūriki | 378-393, 414-431 | 640-677 |
| 18 | Kaguya Ōtsutsuki Strikes | 458-479 (tabela: 451, 455, 458-468, 470-479) | 678-699 |

Arcos só do anime (filler, sem capítulos, fora daqui): Twelve Guardian Ninja (54-71), Three-Tails' Appearance (89-112), Six-Tails Unleashed (144-151), Past Arc: The Locus of Konoha (176-196), Paradise Life on a Boat (223-242), Power (290-295), Kakashi's Anbu Arc (349-361), In Naruto's Footsteps (394-413), Jiraiya Shinobi Handbook (432-450), Itachi Shinden Book (451-458), Childhood (480-483); episódios 119-120 (filler dentro de Itachi Pursuit).
