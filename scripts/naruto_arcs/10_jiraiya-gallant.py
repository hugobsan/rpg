from naruto_arcs import PART2, bad

ARC = dict(
    **PART2,
    title="Naruto Shippūden (Parte II) - Arco da Lenda de Jiraiya, o Intrépido",
    name="Tale of Jiraiya the Gallant",
    arc_page="Tale of Jiraiya the Gallant",
    eps=(127, 133),
    chapters="368-383",
    part_sections=["Tale of Jiraiya the Gallant"],
    # o que só se revela depois deste arco: verdade de Itachi, Tobi = Obito/Madara, o que Nagato é de verdade,
    # Naruto no Monte Myōboku, o ataque de Pain a Konoha, Cúpula dos Cinco Kage, guerra
    bad=bad(
        r"Obito|Madara|Kaguya|Ōtsutsuki|Otsutsuki|Hagoromo|Six Paths(?! of Pain)|Black Zetsu|Ten-Tails|Juubi|Kurama\b|"
        r"Fourth Shinobi|Fourth Great|Allied Shinobi|Infinite Tsukuyomi|Edo Tensei|Reanimation|"
        r"Fated Battle|Pain's Assault|Five Kage|Past Arc|Six-Tails|"
        r"Itachi.{0,60}(?:truth|ordered|true|death|died|dies|killed|illness|disease)|Shisui|Danzō|Danzo|Root\b|\bcoup\b|"
        r"Team (?:Taka|Hawk)|Suigetsu|Karin\b|Jūgo|Juugo|Raikage|Kumogakure|Killer B|Yugito|Mizukage|Tsuchikage|"
        r"Land of Iron|Hinata.{0,40}confess|coma\b|Hokage garb|Hokage position|role as Hokage|Sixth Hokage|Rokudaime|"
        r"Naruto has had his turn|Orochimaru.{0,40}(?:death|defeated|killed)|Kabuto.{0,60}(?:reincarnat|Sage)|"
        r"Uzushiogakure|Rōshi|Roshi|Utakata|Isobu|Naruto Gaiden|Rinne Festival|destroy the world|"
        r"Shinra Tensei|Bansh[oō] Ten'?in|Chibaku Tensei|Gedō|Gedo|Outer Path|Rinne Rebirth|Almighty Push|Universal Pull|"
        r"Planetary Devastation|Uzumaki clan|descend|receivers?\b|puppet|corpses|true body|real body|"
        r"Nagato.{0,80}(?:controll|frail|dying|sacrific|reviv|Uzumaki|body)|Yahiko.{0,80}(?:sacrific|kunai)|"
        r"Naruto.{0,80}(?:Sage|senjutsu|natural energy|Myōboku|Myoboku)|Fukasaku.{0,60}Naruto|Shima.{0,60}Naruto|"
        r"Tsunade.{0,60}(?:Katsuyu|sacrific)|(?:Konoha|village).{0,40}(?:destroy|devastat|annihilat)|"
        r"Kabuto Yakushi stated|crying|sensitiv|original Akatsuki|spent his entire life|true identity|Chōza|questioning|remove their tongue|unzip|Samsara|Eight-Tails|Tailed Beast (?:chakra|Ball|Bomb)|Before he faced|never lost|Nagato's remains|Tobi ordered|"
        r"suicidal|debilitat|Nagato performed|Nagato openly|prior knowledge|clone was made|Decades later|Tobi felt|"
        r"single-handedly|had he lived|lived longer|decimated|battle with Pain|During his battle|red coat|"
        r"real one|isn't among|killed by Pain|get killed|Pain's invasion|defend Konoha|once again states|"
        r"Delta|shinobi-ware|Gale Palm|piercings|transmit|caster|Inoichi|controlled bod|corpse|statue|"
        r"hair colou?r|Gaara's sand|muscle memory|nullified|through the body|interrogat|judgement|"
        r"Kushina.{0,80}jinch|inevitably be deployed|"
        r"(?-i:Sai\b)|Yamato|seven in its history|seven Hokage|Metal Lee|Duy\b|natural energy|"
        r"make the world a better place|concerned for where things"
    ),
    characters=["Jiraiya", "Nagato", "Konan", "Fukasaku", "Shima", "Gamaken", "Tsunade", "Naruto Uzumaki",
                "Gerotora"],
    techniques=["Sage Mode", "Summoning Technique", "Animal Path", "Preta Path",
                "Asura Path", "Naraka Path", "Rinnegan",
                "Summoning: Toad Shop Technique", "Hiding in a Toad Technique", "Fire Release: Flame Bullet",
                "Toad Oil Bullet", "Sage Art: Goemon", "Demonic Illusion: Toad Confrontation Chant",
                "Ultra-Big Ball Rasengan", "Barrier: Toad Gourd Prison", "Finger Carving Seal",
                "Summoning: Crushing Toad Stomach", "Dance of the Shikigami", "Paper Shuriken",
                "Water Release: Wild Bubble Wave", "Hair Needle Senbon", "Wild Lion's Mane Technique",
                "Summoning Rinnegan", "Giant Crustacean", "Rasengan", "Eight Trigrams Sealing Style",
                "Sage Art: Amphibian Technique"],
    places=["Amegakure", "Mount Myōboku", "Pain's Tower", "Akatsuki", "Konohagakure", "Sannin",
            "Two Great Sage Toads", "Great Toad Sage"],
)
