from naruto_arcs import PART2, bad

ARC = dict(
    **PART2,
    title="Naruto Shippūden (Parte II) - Arco da Missão de Reconhecimento da Ponte Tenchi",
    name="Tenchi Bridge Reconnaissance Mission",
    arc_page="Tenchi Bridge Reconnaissance Mission",
    eps=(33, 53),
    chapters="282-310",
    part_sections=["Tenchi Bridge Reconnaissance Mission"],
    # o que só se revela depois deste arco: Hidan e Kakuzu, morte de Asuma, Rasenshuriken, Pain/Nagato,
    # Tobi, Team Hebi/Taka, morte de Orochimaru, verdade de Itachi, Danzō (Izanagi, Hokage), guerra...
    bad=bad(
        r"Nagato|Yahiko|Six Paths of Pain|Deva Path|Rinnegan|Konan\b|Obito|Madara|Kaguya|Ōtsutsuki|Otsutsuki|Hagoromo|"
        r"Six Paths|Black Zetsu|Ten-Tails|Juubi|Kurama\b|Sage Mode|Senjutsu|Myōboku|Myoboku|Fukasaku|Rasen-?shuriken|"
        r"Wind Release: Rasengan|Wind Style: Rasengan|Nature Transformation|wind nature|wind-nature|"
        r"Tailed Beast Bomb|Tailed Beast Mode|Chakra Mode|Fourth Shinobi|Fourth Great|Allied Shinobi|Infinite Tsukuyomi|"
        r"Akatsuki Suppression|Itachi Pursuit|Fated Battle|Pain's Assault|Five Kage|Past Arc|Tobi\b|"
        r"Hidan|Kakuzu|Jashin|Asuma.{0,40}(?:death|died|dies|killed)|Jiraiya.{0,40}(?:death|died|dies|killed)|"
        r"Itachi.{0,60}(?:truth|ordered|true|death|died|dies|killed|illness|disease)|Shisui|Amaterasu|Susanoo|Izanagi|Izanami|"
        r"Kotoamatsukami|Eternal Mangekyō|Mangekyō Sharingan.{0,40}Sasuke|Sasuke.{0,60}Mangekyō|"
        r"Danzō.{0,80}(?:Hokage|Izanagi|Five Kage|death|died|dies|killed|Sasuke)|Sharingans? (?:on|in|from) his (?:right )?arm|"
        r"Sasuke.{0,40}(?:killed|defeated|absorbed) Orochimaru|Orochimaru.{0,40}(?:death|defeated|killed|dies|died)|"
        r"Team (?:Hebi|Taka)|Suigetsu|Karin\b|Jūgo|Juugo|Raikage|Kumogakure|Killer B|Yugito|Mizukage|Tsuchikage|"
        r"Land of Iron|Hinata.{0,40}confess|Tsunade.{0,40}coma|Tsunade.{0,60}(?:retire|resign|step down)|"
        r"(?-i:Pain\b)|Six Fire|Hokage garb|Hokage position|role as Hokage|Naruto has had his turn|"
        r"(?:his|her) death|had (?:he|she) lived|lived longer|Decades later|Kabuto.{0,80}(?:Sage|Edo|reanimat|Uchiha|Ōtsutsuki)|"
        r"Kabuto.{0,60}reincarnat|\bthe war\b|war's|Minato|Namikaze|Kushina|Naruto strongly resembles|inherited his mother|"
        r"Uzushiogakure|Sixth Hokage|Rokudaime|Isobu|Rōshi|Roshi|Utakata|Edo Tensei|Hiruzen.{0,40}Edo|"
        r"(?:Two|Three|Four|Five|Six|Seven|Eight)-Tails\b|(?:Three|Four|Five|Six|Seven|Eight)-Tailed|"
        r"reincarnated (?:Kage|shinobi)|Naruto Gaiden|single-handedly defeated|destroy the world|Rinne Festival|"
        r"seven in its history|seven Hokage|Metal Lee|Duy\b|Ao of Kirigakure|natural energy|"
        r"different individuals|make the world a better place|concerned for where things|"
        r"Izuna|according to Hashirama|true form|giant white snake|would later|later (?:regain|obtain)|White Zetsu|"
        r"Hashirama cell|Hashirama's cells|Orochimaru's remains|Orochimaru's characteristic|Power arc|fully converted|"
        r"snake also fuses|Sharingan underneath|concealing a Sharingan|ten more Sharingan|Shin Uchiha|"
        r"secretly worked closely|illegal experiments|have Hiruzen assassinated|after the death of its founder|"
        r"re-emerged|sealed with him|Eight Branches|Sword of Totsuka|Evil Releasing|entirety of Part II|Flying Thunder|Tiger Vision|emotional energy|File:|\.svg"
    ),
    characters=["Naruto Uzumaki", "Sakura Haruno", "Kakashi Hatake", "Sai", "Yamato", "Sasuke Uchiha",
                "Orochimaru", "Kabuto Yakushi", "Tsunade", "Shizune", "Jiraiya", "Danzō Shimura",
                "Shikamaru Nara", "Ino Yamanaka", "Chōji Akimichi", "Rock Lee", "Hinata Hyūga"],
    techniques=["Super Beast Imitating Drawing", "Wood Clone Technique", "Wood Release: Four-Pillar House Technique",
                "Wood Release: Wood Locking Wall", "Wood Release",
                "Jinchūriki Forms", "Orochimaru-Style Body Replacement Technique",
                "Sword of Kusanagi (Orochimaru)", "Sword of Kusanagi (Sasuke Uchiha)", "Chakra Scalpel",
                "Rasengan", "Chidori", "Sharingan", "Mangekyō Sharingan", "Cursed Seal of Heaven",
                "Shadow Clone Technique", "Multiple Shadow Clone Technique", "Body Replacement Technique",
                "Shadow Imitation Technique", "Chakra Enhanced Strength", "Summoning Technique", "Genjutsu",
                "Medical Ninjutsu", "Mystical Palm Technique", "Jinchūriki", "Hiruko", "Mind Transfer Technique",
                "Eight Gates"],
    places=["Konohagakure", "Land of Fire", "Tenchi Bridge", "Kusagakure", "Anbu", "Konoha Council", "Team Kakashi", "Sannin", "First Hokage's Necklace",
            "Root", "Third Hokage", "First Hokage"],
)
