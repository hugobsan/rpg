import sys

from naruto_arcs import PART2, ARC_TEXT_BAD, bad


def _fix_is_filler():
    """O ep 142 (canônico) é pego por is_filler porque a página cita 'a filler arc' (o arco de Utakata, que vem depois).
    Gambiarra mínima: só esta página (reconhecida por 'Kiyoi Yotsuki') deixa de contar como filler.
    ponytail: sair daqui quando o is_filler do narutopedia.py ignorar menções a outros arcos filler."""
    for name in ("__main__", "narutopedia"):
        m = sys.modules.get(name)
        f = getattr(m, "is_filler", None)
        if f and not getattr(f, "_arc11", False):
            def g(wt, _f=f):
                return False if wt and "Kiyoi Yotsuki" in wt else _f(wt)
            g._arc11 = True
            m.is_filler = g


_fix_is_filler()

ARC = dict(
    PART2,
    title="Naruto Shippūden (Parte II) - Arco da Batalha Predestinada entre Irmãos (Sasuke contra Itachi)",
    name="Fated Battle Between Brothers",
    arc_page="Fated Battle Between Brothers",
    eps=(134, 143),
    chapters="384-412",
    part_sections=["Fated Battle Between Brothers"],
    # A página do arco segue o mangá e inclui, no fim, a notícia da morte de Jiraiya, a decodificação da mensagem e o
    # treino de Sage Mode do Naruto; no anime isso é do começo de Pain's Assault (arco 12). Fica de fora aqui.
    text_bad=ARC_TEXT_BAD + r"|finding out about Jiraiya|Jiraiya was killed|Jiraiya's dying message|decoders|decode|"
             r"Iruka Umino|Kurenai|Reverse Summon|senjutsu|frog oil|toad statue|Sage Mode|Sage Art|"
             r"Rasenshuriken|Fukasaku asks|opts to help|real one isn't|natural chakra|Shikamaru reminded",
    # o que só se revela depois deste arco: Pain/Nagato de verdade, Naruto no Monte Myōboku, ataque a Konoha,
    # Tobi = Obito, Cúpula dos Cinco Kage, guerra
    bad=bad(
        r"Obito|Kaguya|Ōtsutsuki|Otsutsuki|Hagoromo|Six Paths(?! of Pain)|Black Zetsu|Ten-Tails|Juubi|Kurama\b|"
        r"Fourth Shinobi|Fourth Great|Allied Shinobi|Infinite Tsukuyomi|Eye of the Moon|Edo Tensei|Reanimation|"
        r"Pain's Assault|Five Kage|Past Arc|Six-Tails Unleashed|Gyūki|Gyuki|"
        r"impersonat|posing as|pose as|real Madara|original Madara|false Madara|not (?:actually )?Madara|"
        r"Shisui.{0,100}(?:suicide|Danzō|stole|eye|Kotoamatsukami|Izanagi|committed|forced)|Root\b|Kotoamatsukami|Izanagi|Izanami|Itachi.{0,60}(?:illness|disease|terminal)|Kabuto.{0,60}Itachi|"
        r"Danzō.{0,100}(?:Hokage|Kage Summit|Sharingan|died|death|killed|defeat|Root)|"
        r"(?:Hokage|Kage Summit|Sharingan|Root).{0,100}Danzō|Sasuke.{0,60}(?:Danzō|Raikage|Kage Summit)|"
        r"Raikage|Mizukage|Tsuchikage|Land of Iron|Mifune|Darui|Kurotsuchi|Chōjūrō|Yugito|Rōshi|Roshi|Utakata|Isobu|"
        r"Hinata.{0,40}confess|coma\b|Hokage garb|Hokage position|role as Hokage|Sixth Hokage|Rokudaime|"
        r"Naruto has had his turn|Kabuto.{0,60}(?:Sage|absorbed|reincarnat|Edo)|Orochimaru.{0,80}(?:Kabuto|reviv|resurrect|rebirth|reappear)|"
        r"Kisame.{0,60}(?:died|killed|death|suicide|Guy)|Tailed Beast (?:Ball|Bomb)|"
        r"Uzushiogakure|Naruto Gaiden|Rinne Festival|destroy the world|"
        r"Shinra Tensei|Bansh[oō] Ten'?in|Chibaku Tensei|Gedō|Gedo|Outer Path|Rinne Rebirth|Almighty Push|Universal Pull|"
        r"Planetary Devastation|Uzumaki clan|receivers?\b|true body|real body|true identity|Samsara|"
        r"Nagato.{0,80}(?:controll|frail|dying|sacrific|reviv|Uzumaki|body)|Yahiko.{0,80}(?:sacrific|kunai)|"
        r"Naruto.{0,80}(?:Sage|senjutsu|natural energy|Myōboku|Myoboku)|Fukasaku.{0,60}Naruto|Shima.{0,60}Naruto|"
        r"Naruto.{0,60}Jiraiya.{0,40}(?:death|died|killed|dead|mourn)|Jiraiya's (?:death|message)|real one|isn't among|"
        r"Tsunade.{0,60}(?:Katsuyu|sacrific)|(?:Konoha|village).{0,40}(?:destroy|devastat|annihilat)|decimated|"
        r"Before he faced|never lost|Nagato's remains|Tobi ordered|Nagato openly|prior knowledge|clone was made|"
        r"Decades later|Tobi felt|single-handedly|had he lived|lived longer|battle with Pain|During his battle|red coat|"
        r"killed by Pain|get killed|Pain's invasion|defend Konoha|Delta|shinobi-ware|Gale Palm|transmit|"
        r"Kushina.{0,80}jinch|inevitably be deployed|transplant|Itachi's (?:eyes|Mangekyō)|"
        r"File:|Kabuto Yakushi stated|Rinnegan.{0,60}Sasuke|Sasuke.{0,60}Rinnegan|acquiring his Rinnegan|according to Hashirama|"
        r"Taka will go|decided that Taka|black dress|Susanoo with senjutsu|adapting their DNA|later regain|enhanced DNA|"
        r"enhanced-White|Hashirama cell|rest inside Samehada|stores the rest|threat by Pain|maliciously|Danzō countered|"
        r"Danzō.{0,60}(?:apprentice|trained)|During the War|reincarnated Torune|worthy of being a Kage|"
        r"entirety of Part II|Kushina.{0,200}jinch|"
        r"(?-i:Sai\b)(?=.{0,60}Root)|seven in its history|seven Hokage|Metal Lee|Duy\b|natural energy|"
        r"make the world a better place|concerned for where things"
    ),
    characters=["Sasuke Uchiha", "Itachi Uchiha", "Tobi", "Kisame Hoshigaki", "Suigetsu", "Karin", "Jūgo",
                "Orochimaru", "Killer B", "Naruto Uzumaki", "Kakashi Hatake", "Yamato", "Sai", "Sakura Haruno",
                "Shino Aburame", "Hinata Hyūga", "Kiba Inuzuka"],
    techniques=["Mangekyō Sharingan", "Sharingan", "Tsukuyomi", "Amaterasu", "Susanoo", "Sword of Totsuka",
                "Yata Mirror", "Kirin", "Fire Release: Great Dragon Fire Technique", "Fire Release: Great Fireball Technique",
                "Chidori", "Chidori Sharp Spear", "Chidori Current",
                "Cursed Seal of Heaven", "Transcription Seal: Amaterasu", "Genjutsu: Sharingan", "Eight Branches Technique",
                "Earth Release: Earth Flow Divide", "Secret Technique: Insect Sphere", "Mind's Eye of the Kagura",
                "Hydrification Technique", "Kubikiribōchō", "Lightning Release: Lariat", "Disturbance Taijutsu",
                "Version 1", "Piston Fist: Style One", "Cellular Regeneration Ejection", "Samehada", "Kamui",
                "Wood Release"],
    places=["Uchiha Hideout", "Uchiha Clan Downfall", "Uchiha clan", "Konoha Military Police Force", "Konoha Council",
            "Hebi", "Eight Man Squad", "Akatsuki", "Kumogakure", "Valley of Clouds and Lightning", "Valley of the End",
            "Konohagakure", "Anbu"],
)
