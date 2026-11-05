from naruto_arcs import AFFIL, ARC_TEXT_BAD, PART2, bad

ARC = dict(
    **{**PART2, "affil": AFFIL.replace("|Akatsuki", ""), "text_bad": ARC_TEXT_BAD + r"|Fated Battle|Madara|Minato|Namikaze|Kushina|Uzushiogakure|Konan\b|(?-i:Pain)\b|Amegakure"},
    title="Naruto Shippūden (Parte II) - Arco da Perseguição a Itachi (Itachi Pursuit)",
    name="Itachi Pursuit Mission",
    arc_page="Itachi Pursuit Mission",
    eps=(113, 126),
    chapters="343-367 (episódios 119-120 são filler e ficaram de fora)",
    part_sections=["Itachi Pursuit Mission"],
    # o que só se revela depois deste arco: Fated Battle (verdade de Itachi, Mangekyō/Susanoo/Amaterasu, Team Taka, Orochimaru
    # sobrevivendo em Sasuke, morte de Kisame), Pain/Nagato/Konan, Tobi = Madara/Obito, morte de Jiraiya, Sage Mode, guerra...
    bad=bad(
        r"Nagato|Yahiko|Six Paths of Pain|Deva Path|Rinnegan|Konan\b|Obito|Madara|Kaguya|Ōtsutsuki|Otsutsuki|Hagoromo|"
        r"Six Paths|Black Zetsu|Ten-Tails|Juubi|Kurama\b|Matatabi|Isobu|Sage Mode|Senjutsu|Myōboku|Myoboku|Fukasaku|"
        r"Tailed Beast Bomb|Tailed Beast Mode|Chakra Mode|Fourth Shinobi|Fourth Great|Allied Shinobi|Infinite Tsukuyomi|"
        r"Fated Battle|Tale of Jiraiya|Pain's Assault|Five Kage|Past Arc|Night Guy|Gate of Death|Mirai\b|Amegakure|"
        r"Team Taka|Taka\b|Team Hawk|"
        r"Jiraiya.{0,40}(?:death|died|dies|killed)|"
        r"Itachi.{0,60}(?:truth|ordered|true|death|died|dies|killed|illness|disease|sick)|Itachi's (?:death|true|real|illness|sacrifice)|"
        r"Sasuke.{0,50}(?:killed|killing|kills|defeated|defeating) (?:his (?:older )?brother|Itachi)|"
        r"Shisui|Amaterasu|Susanoo|Izanagi|Izanami|Kotoamatsukami|Eternal Mangekyō|Mangekyō Sharingan.{0,40}Sasuke|Sasuke.{0,60}Mangekyō|"
        r"Kisame.{0,60}(?:death|died|dies|killed|suicide)|Suigetsu.{0,60}(?:obtain|wield|inherit|took|acquire).{0,30}Samehada|"
        r"Samehada.{0,60}(?:new owner|new wielder|inherit)|"
        r"Danzō.{0,80}(?:Hokage|Izanagi|Five Kage|death|died|dies|killed|Sasuke)|Sharingans? (?:on|in|from) his (?:right )?arm|"
        r"Deidara.{0,80}(?:Edo|reanimat|revived|Allied|war\b)|Hidan.{0,80}(?:Edo|reanimat|revived|Allied|war\b)|"
        r"Kakuzu.{0,80}(?:Edo|reanimat|revived|Allied|war\b)|"
        r"Orochimaru.{0,80}(?:survived|resurfac|re-emerge|within Sasuke|inside Sasuke|revived|resurrect|reanimat|Evil Releasing)|"
        r"Raikage|Killer B|Mizukage|Tsuchikage|Land of Iron|Hinata.{0,40}confess|Tsunade.{0,40}coma|"
        r"Tsunade.{0,60}(?:retire|resign|step down)|(?-i:Pain\b)|Six Fire|Hokage garb|Hokage position|role as Hokage|"
        r"Naruto has had his turn|(?:his|her) death|had (?:he|she) lived|lived longer|Decades later|"
        r"Kabuto.{0,80}(?:Sage|Edo|reanimat|Ōtsutsuki)|Kabuto.{0,60}reincarnat|\bthe war\b|war's|Minato|Namikaze|Kushina|"
        r"Naruto strongly resembles|inherited his mother|Uzumaki clan|Uzushiogakure|Naruto's? (?:relative|cousin)|distant relative|"
        r"Sixth Hokage|Rokudaime|Utakata|Edo Tensei|Hiruzen.{0,40}Edo|"
        r"(?:Five|Six|Seven|Eight)-Tails\b|(?:Five|Six|Seven|Eight)-Tailed|"
        r"reincarnated (?:Kage|shinobi)|Naruto Gaiden|single-handedly defeated|destroy the world|Rinne Festival|"
        r"seven in its history|seven Hokage|Metal Lee|Duy\b|Ao of Kirigakure|natural energy|"
        r"different individuals|make the world a better place|concerned for where things|"
        r"Izuna|according to Hashirama|would later|later (?:regain|obtain)|White Zetsu|"
        r"Hashirama cell|Hashirama's cells|Orochimaru's characteristic|Power arc|fully converted|"
        r"snake also fuses|Sharingan underneath|concealing a Sharingan|ten more Sharingan|Shin Uchiha|"
        r"secretly worked closely|illegal experiments|have Hiruzen assassinated|after the death of its founder|"
        r"re-emerged|sealed with him|Eight Branches|Sword of Totsuka|entirety of Part II|Flying Thunder|"
        r"Tiger Vision|emotional energy|reincarnated by|giving birth|talisman|clone was later summoned|Kabuto summoned|"
        r"Manda II|In later years|reestablished|truce with Konohagakure|turn him back to good|defeat Sasuke and|final battle|Kirin|"
        r"fireballs launched by the two brothers|Even had he died|alluding to Tobi|pawn|truth about Itachi|Clan Downfall|impressed he was by|"
        r"allied with Akatsuki|healed from all her|adapting their DNA|Sasuke's former team|Konohamaru's usage|Ryūki|deal with Sasuke alone|File:|\.svg"
    ),
    characters=["Sasuke Uchiha", "Orochimaru", "Kabuto Yakushi", "Karin", "Suigetsu Hōzuki", "Jūgo",
                "Itachi Uchiha", "Kisame Hoshigaki", "Tobi", "Deidara", "Naruto Uzumaki", "Sakura Haruno",
                "Kakashi Hatake", "Yamato", "Sai", "Tsunade", "Jiraiya", "Hinata Hyūga", "Kiba Inuzuka",
                "Shino Aburame", "Akamaru", "Manda"],
    techniques=["Chidori Sharp Spear", "Chidori Senbon", "Chidori Current", "Chidori",
                "Sword of Kusanagi (Sasuke Uchiha)", "Cursed Seal of Heaven", "Hidden Shadow Snake Hands",
                "Genjutsu: Sharingan", "Sharingan", "Mangekyō Sharingan", "Demonic Illusion: Mirage Crow",
                "Demonic Illusion: Shackling Stakes Technique", "Kubikiribōchō", "Samehada", "Hydrification Technique",
                "Water Release: Great Water Arm Technique", "Mind's Eye of the Kagura", "Binding Snake Glare Spell",
                "Living Corpse Reincarnation", "Explosive Clay", "C1", "C2", "C4", "C0", "Fire Release: Dragon Fire Technique",
                "Summoning Technique", "Multiple Shadow Clone Technique", "Rasengan", "Big Ball Rasengan",
                "Wind Release: Rasenshuriken", "Lightning Blade", "Sealing Technique: Phantom Dragons Nine Consuming Seals",
                "Jinchūriki", "Genjutsu"],
    places=["Eight Man Squad", "Otogakure", "Akatsuki", "Seven Ninja Swordsmen of the Mist",
            "Land of Waves", "Great Naruto Bridge", "Konohagakure", "Team 8", "Team Kakashi", "Kirigakure",
            "Sannin", "Uchiha Hideout"],
)
