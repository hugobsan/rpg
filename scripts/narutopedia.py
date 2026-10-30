#!/usr/bin/env python3
"""Gera os arquivos de referência de cânone (Naruto) a partir da Narutopedia.

Uso: python3 scripts/narutopedia.py [arco ...]   (sem argumento: todos os arcos)
Arcos: pais-das-ondas, exame-chunin, invasao-de-konoha, busca-por-tsunade, fuga-de-sasuke
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


def part1_value(vals):
    """De ['Part I:', '12', 'Part II:', '17'] pega só o valor da Parte I."""
    if "Part I:" in vals:
        i = vals.index("Part I:")
        if i + 1 < len(vals) and not vals[i + 1].startswith("Part"):
            return vals[i + 1]
        return ""
    return ", ".join(v for v in vals if not v.startswith("Part"))


def character_block(name, arc):
    wt = fetch(name, "wikitext")
    if wt is None:
        return None
    bad = arc["bad"]
    rows = infobox_rows(name)
    ficha = []
    for label, key in [("Sex", "Sex"), ("Birthdate", "Birthdate"), ("Age", "Age (Part I)"),
                       ("Affiliation", "Village/affiliation"), ("Ninja Rank", "Ninja rank (Part I)")]:
        if label in rows:
            v = rows[label]
            val = part1_value(v) if label in ("Age", "Ninja Rank") else ", ".join(x for x in v if not x.startswith("Part"))
            items = [x.strip() for x in re.split(r"\s*,\s*", val) if x.strip()]
            items = [x for x in items if not re.search(bad, x, re.I)]
            if label == "Affiliation":  # só vila/país/clã; times e grupos posteriores vazam spoiler
                items = [x for x in items if re.search(r"gakure|Land of|Konoha|Kiri|Suna|Oto|Waves|Clan|Company|Yuki|Demon", x)]
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
    # Parte I: só as subseções deste arco
    _, secs = sections(wt)
    in_p1 = False
    for lvl, t, body in secs:
        if lvl == 2:
            in_p1 = t.lower() == "part i"
            continue
        if in_p1 and lvl == 3 and t.lower() in [x.lower() for x in arc["part1_sections"]]:
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
    txt = clean(lead)
    if len(txt) < 100 and secs:  # algumas páginas só têm "Overview"
        txt = clean(secs[0][2])
    txt = sentence_filter(txt, arc["bad"])
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
    out.append(f"- Episódios (anime): {arc['eps'][0]}-{arc['eps'][1]} (só canônicos; fillers ignorados)")
    out.append(f"- Capítulos (mangá): {arc['chapters']}")
    srcs = [BASE + urllib.parse.quote(arc["arc_page"].replace(" ", "_"))]
    out.append("- Fonte: Narutopedia (páginas do arco, dos episódios, dos personagens, das técnicas e dos lugares). Página do arco: " + srcs[0])
    out.append("- Licença: Conteúdo da Narutopedia (naruto.fandom.com), CC BY-SA 3.0")
    out.append("- Escopo: só o cânone até o fim deste arco; o que acontece depois foi deixado de fora de propósito. Texto em inglês, como na wiki.\n")

    # resumo do arco
    wt = fetch(arc["arc_page"], "wikitext")
    intro = lead_text(wt)
    out.append(f"## Resumo do arco: {arc['name']}\n")
    intro = re.sub(r"\s*This arc is followed by[^.]*\.", "", intro)
    out.append(intro + "\n")
    for t, body in subsections(wt, "Summary"):
        out.append((f"### {t}\n\n" if t else "") + body + "\n")

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
        out.append(f"### Episódio {num}: {title.replace('_', ' ')}\n")
        out.append(f"(arco {arc['name']}" + (f"; capítulo(s) do mangá: {chap}" if chap else "") + (f"; exibido no Japão em {air}" if air else "") + ")\n")
        out.append(txt + "\n")
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
ALWAYS = (r"Part II|Shippūden|Shippuden|Blank Period|New Era|Boruto|Kaguya|Madara|Obito|Minato|Namikaze|Kushina|"
          r"Kurama|Tobi\b|Nagato|Konan\b|Zetsu|Hidan|Kakuzu|Deidara|Sasori|Danzō|Danzo|World War|Rinnegan|"
          r"Susanoo|Amaterasu|Hagoromo|Six Paths|Ōtsutsuki|Otsutsuki|Pain\b|Kawaki|Sarada|Himawari|Mitsuki|"
          r"Sage Mode|Senjutsu|Uzumaki clan|Chakra Mode|Tailed Beast Bomb|Hashirama|Tobirama|Land of Tea|"
          r"Kazekage Rescue|Edo Tensei|Reanimation|adulthood|adult\b|The Last|Seventh Hokage|Sixth Hokage|"
          r"defect|Fourth Hokage'?s? (?:son|child)|grew up to|eventually became|movie|Retsuden|Hiden|Shinden|"
          r"strongest shinobi|years later|Konoha 11|Konoha Eleven|wanderer|wedding|married|wife|husband|daughter|"
          r"children|\bwar\b|crimes|combined might|only rival|destroy the world|Hokage candidate|Konoha's hero|"
          r"became Hokage|role as Hokage|end of his life|Shin Uchiha|Sixth|become the Hokage's|forgiven|Naruto's? (?:son|daughter)")
ARC1_EXTRA = (r"Orochimaru|Itachi|Akatsuki|Kisame|Gaara|Rasengan|Chūnin Exam|Chunin Exam|Jiraiya|Tsunade|Sannin|Kabuto|"
              r"Cursed Seal|\bSound\b|Otogakure|Mangekyō|Mangekyo|massacre|jinchūriki|jinchuriki|Kyūbi|Kyubi|"
              r"Sunagakure|Tailed Beast|Rock Lee|Neji|Shukaku|Fifth Hokage|Shisui|Konoha Crush|Sasuke Recovery|"
              r"Fourth Hokage|Yondaime|Kakashi Gaiden|Anbu|revenge|avenge|clan'?s? (?:deaths|massacre|destruction)|"
              r"Sharingan.{0,40}(?:two|three) tomoe")

ARCS = {
    "pais-das-ondas": dict(
        file="01-pais-das-ondas.md",
        title="Naruto Clássico (Parte I) - Prólogo e arco do País das Ondas",
        name="Prologue - Land of Waves",
        arc_page="Prologue — Land of Waves",
        eps=(1, 19),
        chapters="1-33",
        part1_sections=["Prologue — Land of Waves"],
        bad=ALWAYS + "|" + ARC1_EXTRA,
        characters=["Naruto Uzumaki", "Sasuke Uchiha", "Sakura Haruno", "Kakashi Hatake", "Iruka Umino",
                    "Hiruzen Sarutobi", "Mizuki", "Konohamaru Sarutobi", "Zabuza Momochi", "Haku",
                    "Gatō", "Tazuna", "Inari", "Tsunami", "Demon Brothers"],
        techniques=["Clone Technique", "Sexy Technique", "Multiple Shadow Clone Technique", "Transformation Technique",
                    "Body Replacement Technique", "Fire Release: Great Fireball Technique", "Hidden Mist Technique",
                    "Silent Killing", "Water Clone Technique", "Water Release: Water Dragon Bullet Technique",
                    "Water Prison Technique", "Demonic Mirroring Ice Crystals", "Chidori", "Sharingan",
                    "Tree Climbing Practice", "Chakra", "Shuriken Shadow Clone Technique"],
        places=["Konohagakure", "Land of Fire", "Land of Waves", "Kirigakure", "Ninja Academy", "Hokage",
                "Team Kakashi", "Seven Ninja Swordsmen of the Mist", "Great Naruto Bridge", "Gatō Company",
                "Scroll of Seals", "Missing-nin", "Shinobi"],
    ),
}


if __name__ == "__main__":
    keys = sys.argv[1:] or list(ARCS)
    for k in keys:
        if k not in ARCS:
            sys.exit(f"arco desconhecido: {k}. Opções: {', '.join(ARCS)}")
        build(k)
