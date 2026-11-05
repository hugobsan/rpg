#!/usr/bin/env python3
"""Gera os arquivos de referência de cânone (Naruto) a partir da Narutopedia.

Uso: python3 scripts/narutopedia.py [arco ...]   (sem argumento: todos os arcos)
Arcos da Parte I (configurados no fim deste arquivo): pais-das-ondas, exame-chunin,
  invasao-de-konoha, busca-por-tsunade, fuga-de-sasuke
Arcos da Parte II (Shippūden): um arquivo por arco em scripts/naruto_arcs/NN_chave.py
  (ex.: 06_kazekage-rescue.py -> arco "kazekage-rescue", saída 06-kazekage-rescue.md).
  Como criar um arco novo: scripts/naruto_arcs/README.md. Arcos hoje: ver essa pasta.
Saída: references/naruto/<arco>.md. Cache bruto em references/.cache/ (fora do git).
Conteúdo da Narutopedia (naruto.fandom.com), CC BY-SA 3.0. Só stdlib.
"""
import html
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # para importar naruto_arcs

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "references" / ".cache"
OUT = ROOT / "references" / "naruto"
API = "https://naruto.fandom.com/api.php"
UA = "ChronicleRPG-reference-builder/1.0 (uso pessoal)"
BASE = "https://naruto.fandom.com/wiki/"
_last = [0.0]


# --------------------------------------------------------------------- fetch
def fetch(title, prop):
    """prop: 'wikitext' ou 'text' (HTML). Devolve string ou None se a página não existe."""
    CACHE.mkdir(parents=True, exist_ok=True)
    f = CACHE / (prop + "__" + re.sub(r"[^\w.-]+", "_", title)[:150] + ".json")
    if f.exists():
        return json.loads(f.read_text())["v"]
    wait = 1.1 - (time.time() - _last[0])
    if wait > 0:
        time.sleep(wait)
    q = urllib.parse.urlencode(
        dict(action="parse", page=title, prop=prop, format="json", redirects=1)
    )
    val = None
    for attempt in range(3):
        try:
            _last[0] = time.time()
            req = urllib.request.Request(API + "?" + q, headers={"User-Agent": UA})
            d = json.load(urllib.request.urlopen(req, timeout=30))
            if "parse" in d:
                val = d["parse"][prop]["*"]
            break
        except Exception as e:  # noqa: BLE001
            if attempt == 2:
                print("  ! falha", title, e, file=sys.stderr)
                return None
            time.sleep(3)
    f.write_text(json.dumps({"v": val}))
    return val


# --------------------------------------------------------------- limpeza wiki
def strip_balanced(s, opener, closer, repl):
    """Remove construções aninhadas opener...closer; repl(inner) decide o que fica."""
    out, i, n = [], 0, len(s)
    while i < n:
        if s.startswith(opener, i):
            depth, j = 0, i
            while j < n:
                if s.startswith(opener, j):
                    depth += 1
                    j += len(opener)
                elif s.startswith(closer, j):
                    depth -= 1
                    j += len(closer)
                    if depth == 0:
                        break
                else:
                    j += 1
            out.append(repl(s[i + len(opener): j - len(closer)] if depth == 0 else ""))
            i = j
        else:
            out.append(s[i])
            i += 1
    return "".join(out)


def split_args(inner):
    """Divide 'a|b|[[c|d]]' em argumentos respeitando [[ ]] e {{ }}."""
    parts, cur, d1, d2, i = [], "", 0, 0, 0
    while i < len(inner):
        two = inner[i:i + 2]
        if two == "[[":
            d1 += 1; cur += two; i += 2; continue
        if two == "]]":
            d1 -= 1; cur += two; i += 2; continue
        if two == "{{":
            d2 += 1; cur += two; i += 2; continue
        if two == "}}":
            d2 -= 1; cur += two; i += 2; continue
        if inner[i] == "|" and not d1 and not d2:
            parts.append(cur); cur = ""
        else:
            cur += inner[i]
        i += 1
    parts.append(cur)
    return parts


def template_repl(inner):
    args = split_args(inner)
    name = args[0].strip().lower()
    if name == "translation":
        # {{translation|English|kanji|romaji|...}} -> English (romaji)
        pos = [a for a in args[1:] if "=" not in a.split("[[")[0]]
        eng = pos[0].strip() if pos else ""
        rom = pos[2].strip() if len(pos) > 2 else ""
        if rom and eng and rom.lower() != eng.lower():
            return f"{eng} ({rom})"
        return eng or rom
    if name in ("quote", "-", "-l", "-r"):
        return ""
    return ""  # demais templates (infobox, navbox, hatnote...) são descartados


def clean(wt):
    s = wt
    s = re.sub(r"<!--.*?-->", "", s, flags=re.S)
    s = re.sub(r"<ref[^>/]*/>", "", s)
    s = re.sub(r"<ref[^>]*>.*?</ref>", "", s, flags=re.S)
    s = re.sub(r"<(gallery|noinclude|includeonly|onlyinclude|div|center|small|big)[^>]*>.*?</\1>", "", s, flags=re.S | re.I) if False else s
    s = re.sub(r"<gallery[^>]*>.*?</gallery>", "", s, flags=re.S)
    s = re.sub(r"<section [^>]*/>", "", s)
    s = re.sub(r"\{\|.*?\|\}", "", s, flags=re.S)  # tabelas
    s = strip_balanced(s, "{{", "}}", template_repl)
    # arquivos/categorias/interwiki (legenda pode ter links aninhados)
    s = strip_balanced(
        s, "[[", "]]",
        lambda inner: "" if re.match(r"\s*(File|Image|Category|[a-z]{2,3}(-[a-z]+)?):", inner, re.I)
        and not inner.lower().startswith(("anime:", "manga:"))
        else "[[" + inner + "]]",
    )
    # [[a|b]] -> b, [[a]] -> a, [[a#b]] -> a#b
    s = re.sub(r"\[\[([^\[\]|]*)\|([^\[\]]*)\]\]", r"\2", s)
    s = re.sub(r"\[\[([^\[\]]*)\]\]", r"\1", s)
    s = re.sub(r"\[https?://[^\s\]]+\s+([^\]]*)\]", r"\1", s)
    s = re.sub(r"\[https?://[^\s\]]+\]", "", s)
    s = re.sub(r"<br\s*/?>", " ", s, flags=re.I)
    s = re.sub(r"</?(?:span|div|center|small|big|u|s|sup|sub|nowiki|poem|blockquote|onlyinclude|includeonly|noinclude)[^>]*>", "", s, flags=re.I)
    s = re.sub(r"<[^>]+>", "", s)
    s = html.unescape(s)
    s = re.sub(r"'{2,5}", "", s)
    s = re.sub(r"^[*#:;]+\s*", lambda m: "- " if "*" in m.group(0) or "#" in m.group(0) else "", s, flags=re.M)
    s = s.replace("__TOC__", "").replace("__NOTOC__", "")
    s = re.sub(r"[ \t ]+", " ", s)
    s = re.sub(r" *\n *", "\n", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


def sections(wt):
    """-> (lead, [(nivel, titulo, texto_wiki)]) na ordem da página."""
    parts = re.split(r"^(={2,6})\s*(.*?)\s*\1\s*$", wt, flags=re.M)
    lead = parts[0]
    secs = []
    for i in range(1, len(parts), 3):
        secs.append((len(parts[i]), clean(parts[i + 1]), parts[i + 2]))
    return lead, secs


def subsections(wt, name):
    """[(titulo, texto_limpo)] das subseções da seção de nível 2 `name` (texto próprio primeiro)."""
    _, secs = sections(wt)
    res = []
    for k, (lvl, title, body) in enumerate(secs):
        if lvl == 2 and title.lower() == name.lower():
            if clean(body):
                res.append(("", clean(body)))
            for lvl2, t2, b2 in secs[k + 1:]:
                if lvl2 <= lvl:
                    break
                if lvl2 == lvl + 1:
                    res.append((t2, clean(b2)))
                elif res:
                    res[-1] = (res[-1][0], res[-1][1] + "\n\n" + clean(b2))
            break
    return res


def section_text(wt, names, with_subs=False):
    """Texto limpo da seção de nível 2 (ou subseção) cujo título está em names."""
    _, secs = sections(wt)
    for k, (lvl, title, body) in enumerate(secs):
        if title.lower() in [n.lower() for n in names]:
            txt = [body]
            if with_subs:
                for lvl2, t2, b2 in secs[k + 1:]:
                    if lvl2 <= lvl:
                        break
                    txt.append(f"\n\n**{t2}**\n\n" + b2)
            return clean("".join(txt))
    return ""


# ------------------------------------------------------------ filtro spoiler
def sentence_filter(text, bad, strict=False):
    """Remove frases com termos proibidos (bad: regex). strict: se a 1ª frase do parágrafo
    é cortada, o parágrafo inteiro sai (seções gerais misturam Parte I e futuro)."""
    rx = re.compile(bad, re.I)
    out = []
    for para in text.split("\n"):
        if para.startswith(("- ", "**")) or len(para) < 60:
            if not rx.search(para):
                out.append(para)
            continue
        sents = re.split(r"(?<=[.!?])\s+(?=[A-Z\"'(])", para)
        if strict and rx.search(sents[0]):
            continue
        kept = [x for x in sents if not rx.search(x)]
        out.append(" ".join(kept))
    return re.sub(r"\n{3,}", "\n\n", "\n".join(out)).strip()


def first_paras(text, n):
    return "\n\n".join([p for p in text.split("\n") if p.strip()][:n])


# termos que não devem aparecer nem no texto do próprio arco (revelações da Parte II / cânone tardio)
ARC_TEXT_BAD = (r"Shisui|Part II|Shipp[uū]den|Boruto|Obito|Madara|Kaguya Ōtsutsuki|Namikaze|Kushina|Minato|"
                r"Seventh Hokage|Sixth Hokage|Rinnegan|Hagoromo|Fourth Shinobi World War")


def drop_sentences(text, rx, where=""):
    """Corta frases com rx (e avisa no stderr); linhas de lista/curtas ficam se não casam."""
    r = re.compile(rx)
    out = []
    for para in text.split("\n"):
        sents = re.split(r"(?<=[.!?])\s+(?=[A-Z\"'(])", para)
        kept = [x for x in sents if not r.search(x)]
        if len(kept) != len(sents) and where:
            print(f"  [corte em {where}] {[x[:90] for x in sents if r.search(x)]}")
        out.append(" ".join(kept))
    return "\n".join(out)


def shorten(text, limit):
    if len(text) <= limit:
        return text
    cut = text[:limit]
    k = max(cut.rfind(". "), cut.rfind("\n"))
    return cut[: k + 1] if k > limit // 2 else cut


# ---------------------------------------------------------- páginas da wiki
def infobox_rows(title):
    """Linhas úteis da infobox renderizada (HTML) de um personagem."""
    h = fetch(title, "text")
    if not h:
        return {}
    t = h[: h.find("</table>")]
    rows = {}
    for m in re.finditer(r"<tr[^>]*>(.*?)</tr>", t, re.S):
        r = re.sub(r"<sup.*?</sup>", "", m.group(1), flags=re.S)
        r = re.sub(r"<br\s*/?>", "|", r)
        pieces = [html.unescape(x).strip() for x in re.split(r"<[^>]+>", r)]
        pieces = [x for x in pieces if x and x not in ("&#160;",)]
        if len(pieces) >= 2:
            rows[pieces[0]] = pieces[1:]
    return rows


def part_value(vals, part="Part I"):
    """De ['Part I:', '12', 'Part II:', '17'] pega só o valor da parte pedida."""
    if part + ":" in vals:
        i = vals.index(part + ":")
        if i + 1 < len(vals) and not vals[i + 1].startswith("Part") and not vals[i + 1].endswith(":"):
            return vals[i + 1]
        return ""
    if part != "Part I":  # formato 'Part II: 15–17' numa célula só (na Parte I fica como sempre foi: vazio)
        return next((v.split(":", 1)[1].strip() for v in vals if v.startswith(part + ":")), "")
    return ", ".join(v for v in vals if not v.startswith("Part"))


def character_block(name, arc):
    wt = fetch(name, "wikitext")
    if wt is None:
        return None
    bad = arc["bad"]
    part = arc.get("part", "Part I")
    rows = infobox_rows(name)
    ficha = []
    for label, key in [("Sex", "Sex"), ("Birthdate", "Birthdate"), ("Age", f"Age ({part})"),
                       ("Affiliation", "Village/affiliation"), ("Ninja Rank", f"Ninja rank ({part})")]:
        if label in rows:
            v = rows[label]
            val = part_value(v, part) if label in ("Age", "Ninja Rank") else ", ".join(x for x in v if not x.startswith("Part"))
            items = [x.strip() for x in re.split(r"\s*,\s*", val) if x.strip()]
            items = [x for x in items if not re.search(bad, x, re.I)]
            if label == "Affiliation":  # só vila/país/clã; times e grupos posteriores vazam spoiler
                items = [x for x in items if re.search(arc.get("affil", r"gakure|Land of|Konoha|Kiri|Suna|Oto|Waves|Clan|Company|Yuki|Demon"), x)]
            if items:
                ficha.append(f"- {key}: {', '.join(items)}")
    pname = clean(name)
    out = [f"### {pname}\n"]
    if ficha:
        out.append("Ficha básica:\n" + "\n".join(ficha) + "\n")
    for label, names in [("Aparência", ["Appearance"]), ("Personalidade", ["Personality"])]:
        t = sentence_filter(first_paras(section_text(wt, names), 2), bad, strict=True)
        if t:
            out.append(f"**{pname} - {label}**\n\n{shorten(t, 1500)}\n")
    ab = section_text(wt, ["Abilities"])
    ab = sentence_filter(first_paras(ab, 1), bad, strict=True)
    if ab:
        out.append(f"**{pname} - Habilidades (visão geral, até este ponto)**\n\n{shorten(ab, 1500)}\n")
    # só as subseções deste arco dentro da Parte (I ou II) do arco
    _, secs = sections(wt)
    in_part = False
    for lvl, t, body in secs:
        if lvl == 2:
            in_part = t.lower() == part.lower()
            continue
        if in_part and lvl == 3 and t.lower() in [x.lower() for x in arc["part_sections"]]:
            txt = sentence_filter(clean(body), bad)
            if txt:
                out.append(f"**{pname} - papel no arco {arc['name']}**\n\n{shorten(txt, 3500)}\n")
    return "\n".join(out)


def lead_text(wt):
    lead, secs = sections(wt)
    # o resumo costuma estar no lead; se vazio, usa a 1ª seção
    t = clean(lead)
    if len(t) < 80 and secs:
        t = clean(secs[0][2])
    return t


def technique_block(name, arc):
    wt = fetch(name, "wikitext")
    if wt is None:
        return None
    m = re.search(r"\{\{Infobox/[^\n]*(.*?)\n\}\}", wt, re.S)
    fields = {}
    if m:
        for line in m.group(1).split("\n|"):
            if "=" in line:
                k, v = line.split("=", 1)
                fields[k.strip()] = clean(v)
    rom = fields.get("romaji", "")
    eng = fields.get("literal english") or fields.get("english tv") or ""
    head = name if not rom else f"{rom} ({name})"
    if rom and eng and eng.lower() != name.lower():
        head = f"{rom} - {name} (literal: {eng})"
    if rom and rom.lower() == name.lower():
        head = f"{name} (literal: {eng})" if eng else name
    meta = []
    for k, lab in [("jutsu rank", "Rank"), ("jutsu classification", "Classification"), ("hand signs", "Hand signs")]:
        if fields.get(k):
            meta.append(f"{lab}: {fields[k]}")
    # remove o infobox antes de pegar o corpo
    body = wt[m.end():] if m else wt
    lead, secs = sections(body)
    cands = [clean(lead)] + [clean(b) for _, _, b in secs[:4]]
    txt = ""
    for c in cands:  # 1º trecho que sobrevive ao filtro (o lead às vezes só tem spoiler)
        if len(c) >= 100 or c is cands[-1]:
            txt = sentence_filter(c, arc["bad"])
            if len(txt) >= 60:
                break
    if not txt:
        return None
    return f"### {head}\n" + (" ; ".join(meta) + "\n\n" if meta else "\n") + shorten(txt, 1400) + "\n"


def place_block(name, arc):
    wt = fetch(name, "wikitext")
    if wt is None:
        return None
    txt = sentence_filter(lead_text(wt), arc["bad"])
    return f"### {clean(name)}\n\n{shorten(txt, 1400)}\n" if txt else None


# ---------------------------------------------------------------- episódios
def arc_episodes(arc_page):
    """Lista [(num, titulo_pagina)] de episódios e [(num, titulo)] de capítulos do arco."""
    h = fetch(arc_page, "text")
    eps, chs = [], []
    for tb in re.findall(r"<table.*?</table>", h, re.S):
        kind = "ep" if "Episode Title" in tb else "ch" if "English title" in tb else None
        if not kind:
            continue
        for m in re.finditer(r'<th>\s*(\d+)\s*</th>\s*<td>"?<a href="/wiki/([^"]+)"', tb):
            (eps if kind == "ep" else chs).append((int(m.group(1)), urllib.parse.unquote(m.group(2))))
    return eps, chs


def synopsis(title):
    wt = fetch(title, "wikitext")
    if not wt:
        return None, ""
    txt = section_text(wt, ["Synopsis", "Summary", "Plot", "Overview"])
    return wt, txt


def is_filler(wt):
    return bool(re.search(r"filler", wt or "", re.I)) and bool(
        re.search(r"(first|a|is a|this is (a|the)[^.\n]*) filler|filler episode|filler arc", wt, re.I)
    )


def build(key):
    arc = ARCS[key]
    print(f"== {key}")
    lines_log = []
    eps, chs = arc_episodes(arc["arc_page"])
    chmap = {}
    eps = sorted((n, t) for n, t in eps if arc["eps"][0] <= n <= arc["eps"][1])
    if arc.get("chapter_pages_from"):
        pass
    out = []
    out.append(f"# {arc['title']}\n")
    out.append(f"- Episódios (anime{arc.get('series', '')}): {arc['eps'][0]}-{arc['eps'][1]} (só canônicos; fillers ignorados)")
    out.append(f"- Capítulos (mangá): {arc['chapters']}")
    srcs = [BASE + urllib.parse.quote(arc["arc_page"].replace(" ", "_"))]
    out.append("- Fonte: Narutopedia (páginas do arco, dos episódios, dos personagens, das técnicas e dos lugares). Página do arco: " + srcs[0])
    out.append("- Licença: Conteúdo da Narutopedia (naruto.fandom.com), CC BY-SA 3.0")
    out.append("- Escopo: só o cânone até o fim deste arco; o que acontece depois foi deixado de fora de propósito. Texto em inglês, como na wiki.\n")

    # resumo do arco
    wt = fetch(arc["arc_page"], "wikitext")
    intro = lead_text(wt)
    out.append(f"## Resumo do arco: {arc['name']}\n")
    text_bad = arc.get("text_bad", ARC_TEXT_BAD)
    intro = drop_sentences(intro, r"followed by")
    out.append(drop_sentences(intro, text_bad, "intro") + "\n")
    for t, body in subsections(wt, "Summary"):
        out.append((f"### {t}\n\n" if t else "") + drop_sentences(body, text_bad, "summary") + "\n")

    # episódios
    out.append("## Sinopse dos episódios (ordem cronológica)\n")
    used, skipped, weak = [], [], []
    ep_pages = []
    for num, title in eps:
        wt_e, txt = synopsis(title)
        if wt_e is None:
            skipped.append((num, title, "page not found"))
            continue
        if num in arc.get("filler", ()) or is_filler(wt_e):
            skipped.append((num, title, "filler"))
            continue
        if len(txt) < 300:
            weak.append(num)
            # fallback: capítulo
            m = re.search(r"\|chapters=([\d,\- ]+)", wt_e)
            cnum = int(re.split(r"[,\-]", m.group(1).strip())[0]) if m else None
            ctitle = dict(chs).get(cnum)
            if ctitle:
                _, ctxt = synopsis(ctitle)
                if len(ctxt) > len(txt):
                    txt = ctxt
        if not txt:
            skipped.append((num, title, "no synopsis"))
            continue
        m = re.search(r"\|chapters=([^\n|]*)", wt_e)
        chap = clean(m.group(1)) if m else ""
        m = re.search(r"\|japanese airdate=([^\n|]*)", wt_e)
        air = clean(m.group(1)) if m else ""
        out.append(f"### Episódio {num}: {title.replace('_', ' ').removesuffix(' (episode)')}\n")
        out.append(f"(arco {arc['name']}" + (f"; capítulo(s) do mangá: {chap}" if chap else "") + (f"; exibido no Japão em {air}" if air else "") + ")\n")
        out.append(drop_sentences(txt, text_bad, f"ep{num}") + "\n")
        used.append(num)
        ep_pages.append(BASE + urllib.parse.quote(title.replace(" ", "_")))

    # personagens
    out.append("## Personagens (aparência, personalidade e habilidades conhecidas até o fim deste arco)\n")
    chars_ok, chars_fail = [], []
    for c in arc["characters"]:
        b = character_block(c, arc)
        if b:
            out.append(b)
            chars_ok.append(c)
        else:
            chars_fail.append(c)
    out.append("## Técnicas e habilidades que aparecem no arco\n")
    techs_ok, techs_fail = [], []
    for t in arc["techniques"]:
        b = technique_block(t, arc)
        if b:
            out.append(b)
            techs_ok.append(t)
        else:
            techs_fail.append(t)
    out.append("## Lugares e organizações\n")
    places_ok, places_fail = [], []
    for p in arc["places"]:
        b = place_block(p, arc)
        if b:
            out.append(b)
            places_ok.append(p)
        else:
            places_fail.append(p)

    out.append("## Fontes das páginas\n")
    out.append("- Arco: " + srcs[0])
    out.append("- Episódios: uma página por episódio em https://naruto.fandom.com/wiki/ (título do episódio com _ no lugar de espaços), por exemplo " + (ep_pages[0] if ep_pages else ""))
    out.append("- Personagens, técnicas e lugares: mesma base de URL, uma página cada. Texto sob CC BY-SA 3.0 (colaboradores da Narutopedia).\n")
    text = "\n".join(out)
    text = re.sub(r"\n{3,}", "\n\n", text)
    OUT.mkdir(parents=True, exist_ok=True)
    f = OUT / arc["file"]
    f.write_text(text, encoding="utf-8")
    print(f"  {f}: {len(text)} chars, {len(text.split())} words, {text.count(chr(10) + '#')} headings")
    print(f"  episodes: {len(used)} used, skipped {skipped}, weak synopsis {weak}")
    print(f"  characters ok {len(chars_ok)}, failed {chars_fail}")
    print(f"  techniques ok {len(techs_ok)}, failed {techs_fail}")
    print(f"  places ok {len(places_ok)}, failed {places_fail}")


# ------------------------------------------------------------ configuração
# Termos de spoiler: frases com eles são cortadas das páginas de personagem/técnica/lugar
# (episódios e página do arco não são filtrados: são o próprio conteúdo do arco).
# BASE vale para toda a Parte I; cada arco soma o que só é revelado depois dele.
SPOILER_BASE = (r"Part II|Shippūden|Shippuden|Blank Period|New Era|Boruto|Kaguya|Madara|Obito|Minato|Namikaze|Kushina|"
        r"Kurama|Tobi\b|Nagato|Konan\b|Zetsu|Hidan|Kakuzu|Deidara|Sasori|Danzō|Danzo|World War|Rinnegan|"
        r"Susanoo|Amaterasu|Hagoromo|Six Paths|Ōtsutsuki|Otsutsuki|(?-i:Pain\b)|Kawaki|Sarada|Himawari|Mitsuki|"
        r"Sage Mode|Senjutsu|Uzumaki clan|Chakra Mode|Tailed Beast Bomb|Land of Tea|Interlude|"
        r"Kazekage Rescue|adulthood|(?-i:adult\b)|The Last|Seventh Hokage|Sixth Hokage|Fifth Kazekage|Kazekage Gaara|"
        r"Fourth Hokage'?s? (?:son|child)|grew up to|eventually became|movie|Retsuden|Hiden|Shinden|"
        r"strongest shinobi|years later|Konoha 11|Konoha Eleven|wanderer|wedding|married|wife|husband|daughter|"
        r"children|\bwar\b|crimes|combined might|only rival|destroy the world|Hokage candidate|Konoha's hero|"
        r"became Hokage|role as Hokage|end of his life|Shin Uchiha|Sixth|forgiven|Naruto's? (?:son|daughter)|"
        r"two and a half years|training trip|Jiraiya.{0,30}(?:death|died|killed|dies)|"
        r"Itachi.{0,40}(?:death|died|dies)|Root\b|\bcoup\b|Shisui|Anbu Root")
ARC1 = (r"Orochimaru|Itachi|Akatsuki|Kisame|Gaara|Rasengan|Chūnin Exam|Chunin Exam|Jiraiya|Tsunade|Sannin|Kabuto|"
        r"Cursed Seal|(?-i:\bSound\b)|Otogakure|Mangekyō|Mangekyo|massacre|jinchūriki|jinchuriki|Kyūbi|Kyubi|"
        r"Sunagakure|Tailed Beast|Rock Lee|Neji|Shukaku|Fifth Hokage|Konoha Crush|Sasuke Recovery|"
        r"Fourth Hokage|Yondaime|Kakashi Gaiden|Anbu|revenge|avenge|clan'?s? (?:deaths|massacre|destruction)|"
        r"Edo Tensei|Reanimation|Hashirama|Tobirama|defect|Hiruzen.{0,40}(?:death|died|dies|killed|sacrific)")
ARC2 = (r"invasion|Itachi|Akatsuki|Kisame|Mangekyō|Mangekyo|massacre|Tsunade|Fifth Hokage|Konoha Crush|Sasuke Recovery|"
        r"Temple of Nirvana|Edo Tensei|Reanimation|Hashirama|Tobirama|defect|Anbu|"
        r"(?:Hiruzen|Third Hokage).{0,40}(?:death|died|dies|killed|sacrific)|Kazekage.{0,30}(?:killed|death|dead|impersonat)|"
        r"Valley of the End|Kimimaro|Sound Four|Tayuya|Jirōbō|Kidōmaru|Sakon|Ukon")
ARC3 = (r"Itachi|Akatsuki|Kisame|Mangekyō|Mangekyo|massacre|Fifth Hokage|Sasuke Recovery|defect|"
        r"Valley of the End|Kimimaro|Kabuto.{0,30}spy")
ARC4 = (r"Sasuke Recovery|defect|Valley of the End|Kimimaro|Itachi.{0,60}(?:truth|ordered|true|real)|"
        r"Sasuke.{0,30}(?:left|leaves|leaving) (?:the village|Konoha)|Sound Four.{0,40}(?:Sasuke|abduct)")
ARC5 = (r"Kazekage Rescue|Akatsuki Suppression|Itachi.{0,60}(?:truth|ordered|true motive)|Hokage Rock.{0,20}Seventh")

def bad(*extras):
    return SPOILER_BASE + "|" + "|".join(extras)

_CHARS_COMMON = ["Naruto Uzumaki", "Sasuke Uchiha", "Sakura Haruno", "Kakashi Hatake"]

ARCS = {
    "pais-das-ondas": dict(
        file="01-pais-das-ondas.md",
        title="Naruto Clássico (Parte I) - Prólogo e arco do País das Ondas",
        name="Prologue - Land of Waves",
        arc_page="Prologue — Land of Waves",
        eps=(1, 19),
        chapters="1-33",
        part_sections=["Prologue — Land of Waves"],
        bad=bad(ARC1),
        characters=_CHARS_COMMON + ["Iruka Umino", "Hiruzen Sarutobi", "Mizuki", "Konohamaru Sarutobi",
                    "Zabuza Momochi", "Haku", "Gatō", "Tazuna", "Inari", "Tsunami", "Demon Brothers"],
        techniques=["Clone Technique", "Sexy Technique", "Multiple Shadow Clone Technique", "Transformation Technique",
                    "Body Replacement Technique", "Fire Release: Great Fireball Technique", "Hidden Mist Technique",
                    "Silent Killing", "Water Clone Technique", "Water Release: Water Dragon Bullet Technique",
                    "Water Prison Technique", "Demonic Mirroring Ice Crystals", "Chidori", "Sharingan",
                    "Tree Climbing Practice", "Chakra", "Shuriken Shadow Clone Technique"],
        places=["Konohagakure", "Land of Fire", "Land of Waves", "Kirigakure", "Ninja Academy", "Hokage",
                "Team Kakashi", "Seven Ninja Swordsmen of the Mist", "Great Naruto Bridge", "Gatō Company",
                "Scroll of Seals", "Missing-nin", "Shinobi"],
    ),
    "exame-chunin": dict(
        file="02-exame-chunin.md",
        title="Naruto Clássico (Parte I) - Arco do Exame Chunin",
        name="Chūnin Exams",
        arc_page="Chūnin Exams (Arc)",
        eps=(20, 67),
        chapters="34-115 (as sinopses dos episódios cobrem até o episódio 67; o fim das provas e a invasão estão no arquivo 03)",
        part_sections=["Chūnin Exams"],
        bad=bad(ARC2),
        characters=_CHARS_COMMON + ["Iruka Umino", "Hiruzen Sarutobi", "Orochimaru", "Kabuto Yakushi", "Anko Mitarashi",
                    "Ibiki Morino", "Hayate Gekkō", "Gaara", "Temari", "Kankurō", "Baki", "Rock Lee", "Neji Hyūga",
                    "Tenten", "Might Guy", "Hinata Hyūga", "Shino Aburame", "Kiba Inuzuka", "Shikamaru Nara",
                    "Ino Yamanaka", "Chōji Akimichi", "Kurenai Yūhi", "Asuma Sarutobi", "Jiraiya", "Ebisu",
                    "Dosu Kinuta", "Zaku Abumi", "Kin Tsuchi", "Konohamaru Sarutobi", "Gamabunta", "Akamaru"],
        techniques=["Rasengan", "Cursed Seal of Heaven", "Chidori", "Sharingan", "Byakugan", "Gentle Fist",
                    "Eight Trigrams Sixty-Four Palms", "Rotation", "Primary Lotus", "Hidden Lotus", "Eight Gates",
                    "Lion Combo", "Leaf Whirlwind", "Leaf Hurricane", "Shadow Imitation Technique", "Mind Transfer Technique",
                    "Multi-Size Technique", "Sand Coffin", "Sand Burial", "Sand Shield",
                    "Fang Over Fang", "Beast Human Clone", "Wind Release: Great Sickle Weasel Technique", "Puppet Technique",
                    "Summoning Technique", "Genjutsu", "Earth Release: Double Suicide Decapitation Technique",
                    "Five Elements Seal", "Summoning: Rashomon", "Body Flicker Technique", "Shadow Clone Technique",
                    "Multiple Shadow Clone Technique", "Tree Climbing Practice", "Sexy Technique"],
        places=["Chūnin Exams", "Forest of Death", "Chūnin", "Genin", "Jōnin", "Sunagakure", "Otogakure",
                "Land of Wind", "Hyūga clan", "Aburame clan", "Inuzuka clan", "Nara clan", "Akimichi clan",
                "Yamanaka clan", "Team Gai", "Team Kurenai", "Team Asuma", "Three Sand Siblings", "Hokage",
                "Konohagakure", "Sannin"],
    ),
    "invasao-de-konoha": dict(
        file="03-invasao-de-konoha.md",
        title="Naruto Clássico (Parte I) - Arco da Invasão de Konoha (Konoha Crush)",
        name="Konoha Crush",
        arc_page="Konoha Crush (Arc)",
        eps=(68, 80),
        chapters="116-138",
        part_sections=["Konoha Crush"],
        bad=bad(ARC3),
        characters=_CHARS_COMMON + ["Hiruzen Sarutobi", "Orochimaru", "Kabuto Yakushi", "Gaara", "Temari", "Kankurō",
                    "Baki", "Rasa", "Jiraiya", "Anko Mitarashi", "Shikamaru Nara", "Shino Aburame", "Asuma Sarutobi",
                    "Might Guy", "Rock Lee", "Neji Hyūga", "Hinata Hyūga", "Kiba Inuzuka", "Chōji Akimichi",
                    "Ino Yamanaka", "Konohamaru Sarutobi", "Hayate Gekkō", "Pakkun", "Gamabunta", "Iruka Umino",
                    "Tayuya", "Sakon and Ukon", "Jirōbō", "Kidōmaru", "Hashirama Senju", "Tobirama Senju", "Manda",
                    "Ebisu", "Ibiki Morino"],
        techniques=["Edo Tensei", "Temple of Nirvana Technique", "Four Violet Flames Formation", "Dead Demon Consuming Seal",
                    "Three Giant Snakes", "Cursed Seal of Heaven", "Rasengan", "Chidori", "Sharingan",
                    "Summoning Technique", "Genjutsu", "Shadow Possession Technique", "Sand Shield", "Sand Coffin",
                    "Shukaku", "Jinchūriki", "Tailed Beast", "Sound Four", "Wind Release: Great Sickle Weasel Technique",
                    "Puppet Technique", "Fire Release: Great Fireball Technique", "Multiple Shadow Clone Technique",
                    "Shadow Clone Technique", "Eight Gates", "Primary Lotus", "Mind Transfer Technique", "Shadow Imitation Technique"],
        places=["Konoha Crush", "Konohagakure", "Sunagakure", "Otogakure", "Land of Wind", "Land of Fire",
                "Sound Four", "Hokage", "Sannin", "Chūnin Exams", "Fourth Kazekage", "Konoha Hospital"],
    ),
    "busca-por-tsunade": dict(
        file="04-busca-por-tsunade.md",
        title="Naruto Clássico (Parte I) - Arco da Busca por Tsunade",
        name="Search for Tsunade",
        arc_page="Search for Tsunade",
        eps=(81, 100),
        chapters="139-171",
        part_sections=["Search for Tsunade"],
        bad=bad(ARC4),
        characters=_CHARS_COMMON + ["Jiraiya", "Tsunade", "Shizune", "Tonton", "Orochimaru", "Kabuto Yakushi",
                    "Itachi Uchiha", "Kisame Hoshigaki", "Might Guy", "Rock Lee", "Asuma Sarutobi", "Kurenai Yūhi",
                    "Hiruzen Sarutobi", "Konohamaru Sarutobi", "Gamabunta", "Katsuyu", "Manda", "Pakkun",
                    "Iruka Umino", "Ebisu", "Teuchi", "Ayame", "Kotetsu Hagane", "Izumo Kamizuki",
                    "Hashirama Senju", "Dan Katō", "Nawaki"],
        techniques=["Mangekyō Sharingan", "Tsukuyomi", "Samehada", "Water Release: Great Shark Bullet Technique",
                    "Rasengan", "Chidori", "Sharingan", "Summoning Technique", "Creation Rebirth",
                    "Strength of a Hundred Seal", "Medical Ninjutsu", "Mystical Palm Technique", "Genjutsu",
                    "Fire Release: Great Fireball Technique", "Cursed Seal of Heaven", "Multiple Shadow Clone Technique",
                    "Sexy Technique", "Shadow Clone Technique", "Hidden Mist Technique", "Water Clone Technique",
                    "Water Prison Technique", "Body Flicker Technique", "Tree Climbing Practice", "Heavenly Foot of Pain",
                    "Chakra Scalpel"],
        places=["Konohagakure", "Tanzaku Quarters", "Akatsuki", "Sannin", "Hokage", "Kirigakure", "Land of Fire",
                "Otogakure", "Konoha Hospital", "Third Hokage", "First Hokage", "Fifth Hokage", "Senju clan"],
    ),
    "fuga-de-sasuke": dict(
        file="05-fuga-de-sasuke.md",
        title="Naruto Clássico (Parte I) - Arco da Fuga de Sasuke (Sasuke Recovery Mission)",
        name="Sasuke Recovery Mission",
        arc_page="Sasuke Recovery Mission",
        eps=(107, 135),
        chapters="172-238 (episódios 107-135; os episódios 136 em diante são filler e ficaram de fora)",
        part_sections=["Sasuke Recovery Mission"],
        bad=bad(ARC5),
        characters=_CHARS_COMMON + ["Shikamaru Nara", "Neji Hyūga", "Chōji Akimichi", "Kiba Inuzuka", "Rock Lee",
                    "Gaara", "Temari", "Kankurō", "Might Guy", "Tsunade", "Shizune", "Jiraiya", "Orochimaru",
                    "Kabuto Yakushi", "Kimimaro", "Jirōbō", "Kidōmaru", "Sakon and Ukon", "Tayuya", "Akamaru",
                    "Pakkun", "Hinata Hyūga", "Ino Yamanaka", "Shino Aburame", "Asuma Sarutobi", "Kurenai Yūhi",
                    "Iruka Umino", "Itachi Uchiha", "Kisame Hoshigaki", "Fugaku Uchiha"],
        techniques=["Cursed Seal of Heaven", "Chidori", "Rasengan", "Sharingan", "Shadow Imitation Technique",
                    "Shadow Neck Bind Technique", "Mind Transfer Technique", "Eight Gates", "Primary Lotus",
                    "Hidden Lotus", "Dance of the Camellia", "Dance of the Clematis", "Dance of the Seedling Fern",
                    "Sand Waterfall Funeral", "Gentle Fist", "Rotation", "Byakugan",
                    "Partial Multi-Size Technique", "Multi-Size Technique", "Puppet Technique", "Fang Over Fang",
                    "Summoning Technique", "Multiple Shadow Clone Technique", "Shadow Clone Technique", "Sand Shield",
                    "Fire Release: Great Fireball Technique", "Genjutsu", "Lightning Blade", "Mangekyō Sharingan",
                    "Sound Four", "Body Flicker Technique", "Creation Rebirth"],
        places=["Valley of the End", "Otogakure", "Sound Four", "Konohagakure", "Land of Fire", "Land of Rivers",
                "Sunagakure", "Sannin", "Akatsuki", "Hokage", "Team Kakashi", "Konoha Hospital",
                "Sasuke Recovery Team"],
    ),
}


def load_part2():
    """Arcos da Parte II: scripts/naruto_arcs/NN_chave.py com ARC = dict(...). Chave e arquivo vêm do nome."""
    import importlib
    for f in sorted((Path(__file__).resolve().parent / "naruto_arcs").glob("[0-9][0-9]_*.py")):
        nn, key = f.stem.split("_", 1)
        arc = importlib.import_module("naruto_arcs." + f.stem).ARC
        ARCS[key] = dict(arc, file=f"{nn}-{key}.md")


load_part2()

if __name__ == "__main__":
    keys = sys.argv[1:] or list(ARCS)
    for k in keys:
        if k not in ARCS:
            sys.exit(f"arco desconhecido: {k}. Opções: {', '.join(ARCS)}")
        build(k)
