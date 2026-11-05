"""Base compartilhada dos arcos da Parte II (Shippūden). Só stdlib; não importa narutopedia.py.

Cada arquivo NN_chave.py desta pasta faz `from naruto_arcs import bad, PART2` e define ARC = dict(...).
Ver README.md.
"""

# Termos que ficam de fora em QUALQUER arco da Parte II: o que só se sabe depois do último arco
# do mangá/anime (Blank Period, filmes, Boruto, casamentos, filhos, Sétimo Hokage...).
# Coisas que o cânone revela no meio da Parte II (Pain, Obito, guerra...) NÃO entram aqui:
# cada arco lista as suas em bad(...), senão os arcos finais ficariam sem esse conteúdo.
SPOILER_BASE = (r"Blank Period|New Era|Boruto|Kawaki|Sarada|Himawari|Mitsuki|The Last|Road to Ninja|"
                r"Retsuden|Hiden\b|Shinden|movie|Seventh Hokage|adulthood|(?-i:adult\b)|wedding|"
                r"marri(?:ed|age)|husband|\bwife\b|his daughter|her daughter|his son|her son|"
                r"grew up to|years later|Konoha 11|Konoha Eleven|Hokage candidate|"
                r"end of his life|Naruto's? (?:son|daughter)")

# Texto do próprio arco (resumo e sinopses): só corta o que não pode aparecer nem aqui.
# Na Parte II NÃO cortar "Part II" nem "Shippūden" (é o próprio assunto) nem nomes do arco.
ARC_TEXT_BAD = r"Boruto|Blank Period|Seventh Hokage|Naruto Shippūden: The Movie|The Last"

# Infobox: vilas/clãs/grupos que entram na ficha (na Parte II, Akatsuki faz parte).
AFFIL = r"gakure|Land of|Konoha|Kiri|Suna|Oto|Waves|Clan|Company|Yuki|Demon|Akatsuki"

# Pedaços de ARC comuns a todo arco da Parte II (use **PART2 no dict).
PART2 = dict(part="Part II", series=" de Shippūden, numeração própria", text_bad=ARC_TEXT_BAD, affil=AFFIL)


def bad(*extras):
    """Regex de spoiler de um arco: base da Parte II + o que só é revelado depois dele."""
    return SPOILER_BASE + "|" + "|".join(extras)
