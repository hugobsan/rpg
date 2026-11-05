from naruto_arcs import PART2, bad

ARC = dict(
    **PART2,
    title="Naruto Shippūden (Parte II) - Arco do Resgate do Kazekage",
    name="Kazekage Rescue Mission",
    arc_page="Kazekage Rescue Mission",
    eps=(1, 32),
    chapters="245-281",
    part_sections=["Kazekage Rescue Mission"],
    # o que só se revela depois deste arco (Pain/Nagato, Tobi = Obito, verdade de Itachi, mortes, Sage Mode, guerra...)
    bad=bad(
        r"Nagato|Yahiko|Six Paths of Pain|Deva Path|Rinnegan|Konan\b|Obito|Madara|Kaguya|Ōtsutsuki|Otsutsuki|Hagoromo|"
        r"Six Paths|Black Zetsu|Ten-Tails|Juubi|Kurama\b|Sage Mode|Senjutsu|Myōboku|Myoboku|Fukasaku|Rasen-?shuriken|"
        r"Tailed Beast Bomb|Fourth Shinobi|Fourth Great|Allied Shinobi|Infinite Tsukuyomi|Edo Tensei|"
        r"Tenchi Bridge|Akatsuki Suppression|Itachi Pursuit|Fated Battle|Pain's Assault|Five Kage|Past Arc|"
        r"Hidan|Kakuzu|Asuma.{0,40}(?:death|died|dies|killed)|Jiraiya.{0,40}(?:death|died|dies|killed)|"
        r"Itachi.{0,60}(?:truth|ordered|true|death|died|dies|killed|illness|disease)|Shisui|Danzō|Danzo|Root\b|\bcoup\b|"
        r"Sasuke.{0,40}(?:killed|defeated|absorbed) Orochimaru|Orochimaru.{0,40}(?:death|defeated|killed)|"
        r"Team (?:Hebi|Taka)|Suigetsu|Karin\b|Jūgo|Juugo|Raikage|Kumogakure|Killer B|Yugito|Mizukage|Tsuchikage|"
        r"Land of Iron|Hinata.{0,40}confess|Tsunade.{0,40}coma|"
        r"(?-i:Pain\b)|Six Fire|Hokage garb|Hokage position|role as Hokage|Naruto has had his turn|"
        r"(?:his|her) death|had (?:he|she) lived|lived longer|Decades later|Kabuto.{0,60}reincarnat|"
        r"\bthe war\b|war's|Minato|Namikaze|Kushina|Naruto strongly resembles|inherited his mother|Uzushiogakure|"
        r"Sixth Hokage|Rokudaime|Isobu|Deidara.{0,80}Sasuke|Sasuke.{0,30}Deidara|Rōshi|Roshi|Utakata|"
        r"(?:Two|Three|Four|Five|Six|Seven|Eight)-Tails\b|(?:Three|Four|Five|Six|Seven|Eight)-Tailed|"
        r"reincarnated (?:Kage|shinobi)|Naruto Gaiden|single-handedly defeated|destroy the world|Rinne Festival|"
        r"(?-i:Sai\b)|Yamato|seven in its history|seven Hokage|Metal Lee|Duy\b|Ao of Kirigakure|natural energy|"
        r"different individuals|make the world a better place|concerned for where things"
    ),
    characters=["Naruto Uzumaki", "Sakura Haruno", "Kakashi Hatake", "Tsunade", "Shizune",
                "Jiraiya", "Gaara", "Kankurō", "Temari", "Baki", "Chiyo", "Sasori", "Deidara", "Might Guy",
                "Neji Hyūga", "Rock Lee", "Tenten", "Shikamaru Nara", "Sasuke Uchiha", "Itachi Uchiha",
                "Kisame Hoshigaki", "Yūra", "Ebizō", "Pakkun", "Konohamaru Sarutobi"],
    techniques=["Puppet Technique", "Iron Sand", "Hiruko", "Red Secret Technique: Performance of a Hundred Puppets",
                "White Secret Technique: The Chikamatsu Collection of Ten Puppets", "Iron Sand World Method",
                "Air Sand Protective Wall", "Morning Peacock", "Sand Waterfall Funeral", "Explosive Clay",
                "C1", "C3", "Suicide Bombing Clone", "Puppet Performance: Skilful Achievement with a Human Body",
                "One's Own Life Reincarnation", "Chakra Enhanced Strength", "Sand Binding Coffin", "Shield of Sand",
                "Eight Trigrams Vacuum Palm", "Kamui", "Mangekyō Sharingan", "Sharingan", "Rasengan",
                "Big Ball Rasengan", "Mystical Palm Technique", "Medical Ninjutsu", "Eight Gates",
                "Five-Seal Barrier", "Sealing Technique: Phantom Dragons Nine Consuming Seals",
                "Genjutsu", "Shadow Clone Technique", "Multiple Shadow Clone Technique", "Byakugan",
                "Jinchūriki", "Shukaku", "Samehada", "Chakra Scalpel", "Summoning Technique"],
    places=["Sunagakure", "Konohagakure", "Land of Wind", "Land of Fire", "Land of Rivers", "Akatsuki",
            "Team Guy", "Team Kakashi", "Kazekage Rescue Team",
            "Kazekage", "Third Kazekage", "Sannin", "Shinobi"],
)
