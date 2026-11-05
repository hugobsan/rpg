from naruto_arcs import PART2, bad

ARC = dict(
    **PART2,
    title="Naruto Shippūden (Parte II) - Arco da Supressão da Akatsuki (Hidan e Kakuzu)",
    name="Akatsuki Suppression Mission",
    arc_page="Akatsuki Suppression Mission",
    eps=(72, 88),
    chapters="311-342",
    part_sections=["Akatsuki Suppression Mission"],
    # o que só se revela depois deste arco: Itachi Pursuit (Team Hebi, morte de Orochimaru, Tobi, Deidara x Sasuke),
    # verdade de Itachi, Pain/Nagato, morte de Jiraiya, Sage Mode, Obito/Madara, guerra...
    bad=bad(
        r"Nagato|Yahiko|Six Paths of Pain|Deva Path|Rinnegan|Konan\b|Obito|Madara|Kaguya|Ōtsutsuki|Otsutsuki|Hagoromo|"
        r"Six Paths|Black Zetsu|Ten-Tails|Juubi|Kurama\b|Sage Mode|Senjutsu|Myōboku|Myoboku|Fukasaku|"
        r"Tailed Beast Bomb|Tailed Beast Mode|Chakra Mode|Fourth Shinobi|Fourth Great|Allied Shinobi|Infinite Tsukuyomi|"
        r"Itachi Pursuit|Fated Battle|Pain's Assault|Five Kage|Past Arc|Night Guy|Gate of Death|Mirai\b|"
        r"Jiraiya.{0,40}(?:death|died|dies|killed)|"
        r"Itachi.{0,60}(?:truth|ordered|true|death|died|dies|killed|illness|disease)|Shisui|Amaterasu|Susanoo|Izanagi|Izanami|"
        r"Kotoamatsukami|Eternal Mangekyō|Mangekyō Sharingan.{0,40}Sasuke|Sasuke.{0,60}Mangekyō|"
        r"Danzō.{0,80}(?:Hokage|Izanagi|Five Kage|death|died|dies|killed|Sasuke)|Sharingans? (?:on|in|from) his (?:right )?arm|"
        r"Deidara.{0,80}(?:Sasuke|death|died|dies|killed|self-destruct|C0)|Sasuke.{0,30}Deidara|"
        r"Hidan.{0,80}(?:Edo|reanimat|revived|Allied|war\b)|Kakuzu.{0,80}(?:Edo|reanimat|revived|Allied|war\b)|"
        r"Sasuke.{0,40}(?:killed|defeated|absorbed) Orochimaru|Orochimaru.{0,40}(?:death|defeated|killed|dies|died)|"
        r"Team (?:Hebi|Taka)|Suigetsu|Karin\b|Jūgo|Juugo|Raikage|Killer B|Mizukage|Tsuchikage|"
        r"Land of Iron|Hinata.{0,40}confess|Tsunade.{0,40}coma|Tsunade.{0,60}(?:retire|resign|step down)|"
        r"(?-i:Pain\b)|Six Fire|Hokage garb|Hokage position|role as Hokage|Naruto has had his turn|"
        r"(?:his|her) death|had (?:he|she) lived|lived longer|Decades later|Kabuto.{0,80}(?:Sage|Edo|reanimat|Uchiha|Ōtsutsuki)|"
        r"Kabuto.{0,60}reincarnat|\bthe war\b|war's|Minato|Namikaze|Kushina|Naruto strongly resembles|inherited his mother|"
        r"Uzushiogakure|Sixth Hokage|Rokudaime|Isobu|Rōshi|Roshi|Utakata|Edo Tensei|Hiruzen.{0,40}Edo|"
        r"(?:Four|Five|Six|Seven|Eight)-Tails\b|(?:Four|Five|Six|Seven|Eight)-Tailed|"
        r"reincarnated (?:Kage|shinobi)|Naruto Gaiden|single-handedly defeated|destroy the world|Rinne Festival|"
        r"seven in its history|seven Hokage|Metal Lee|Duy\b|Ao of Kirigakure|natural energy|"
        r"different individuals|make the world a better place|concerned for where things|"
        r"Izuna|according to Hashirama|true form|giant white snake|would later|later (?:regain|obtain)|White Zetsu|"
        r"Hashirama cell|Hashirama's cells|Orochimaru's remains|Orochimaru's characteristic|Power arc|fully converted|"
        r"snake also fuses|Sharingan underneath|concealing a Sharingan|ten more Sharingan|Shin Uchiha|"
        r"secretly worked closely|illegal experiments|have Hiruzen assassinated|after the death of its founder|"
        r"re-emerged|sealed with him|Eight Branches|Sword of Totsuka|Evil Releasing|entirety of Part II|Flying Thunder|"
        r"Tiger Vision|emotional energy|reincarnated by|giving birth|talisman|clone was later summoned|Kabuto summoned|"
        r"Konohamaru's usage|Ryūki|deal with Sasuke alone|File:|\.svg"
    ),
    characters=["Naruto Uzumaki", "Sakura Haruno", "Kakashi Hatake", "Sai", "Yamato", "Tsunade", "Shizune",
                "Shikamaru Nara", "Ino Yamanaka", "Chōji Akimichi", "Asuma Sarutobi", "Kurenai Yūhi",
                "Hidan", "Kakuzu", "Kotetsu Hagane", "Izumo Kamizuki", "Raidō Namiashi", "Aoba Yamashiro",
                "Chiriku", "Yugito Nii"],
    techniques=["Wind Release: Rasengan", "Wind Release: Rasenshuriken", "Rasengan", "Nature Transformation",
                "Shadow Clone Technique", "Multiple Shadow Clone Technique", "Chidori", "Lightning Blade",
                "Retractable Spear", "Triple-Bladed Scythe", "Curse Technique: Death Controlling Possessed Blood",
                "Earth Grudge Fear", "Earth Release: Earth Spear", "Fire Release: Ash Pile Burning",
                "Wind Release: Pressure Damage", "Lightning Release: False Darkness", "Water Release: Tearing Torrent",
                "Chakra Blade: Straight Line", "Shadow Sewing Technique", "Shadow–Neck Binding Technique",
                "Shadow Gathering Technique", "Shadow Imitation Technique", "Spiked Human Bullet Tank",
                "Cat Flame Roaring Fire", "Jinchūriki Forms", "Wood Release: Foo Dog Heads", "Mind Transfer Technique",
                "Sealed Iron Wall", "Water Release: Starch Syrup Capturing Field", "Fire Release: Intelligent Hard Work",
                "Strange Mask Exploding Flame", "Typhoon Water Vortex Technique", "Shadow Shuriken Technique",
                "Summoning Technique", "Jinchūriki", "Genjutsu", "Mystical Palm Technique", "Medical Ninjutsu"],
    places=["Konohagakure", "Land of Fire", "Akatsuki", "Twelve Guardian Ninja", "Team Asuma", "Team Kakashi",
            "Land of Fire Bounty Station", "Fire Temple", "Jashinism",
            "Anbu", "Shinobi", "Sannin"],
)
