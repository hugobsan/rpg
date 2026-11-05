from naruto_arcs import PART2, ARC_TEXT_BAD, bad

ARC = dict(
    PART2,
    title="Naruto Shippūden (Parte II) - Arco do Ataque de Pain a Konoha",
    name="Pain's Assault",
    arc_page="Pain's Assault (Arc)",
    eps=(152, 175),
    chapters="413-453",
    part_sections=["Pain's Assault"],
    # A página do arco segue o mangá e termina com coisas do arco seguinte (Cúpula dos Cinco Kage): Danzō como Sexto
    # Hokage interino, Tsunade em coma, Team Samui em Konoha, a missão de Taka contra Danzō e o Plano Olho da Lua.
    text_bad=ARC_TEXT_BAD + r"|Danzō was able to persuade|acting Sixth Hokage|labelled Sasuke|Team Samui of Kumogakure arrived|"
             r"abandoned Akatsuki after capturing|assigned Taka|Zetsu's white half|Pain's defeat was a major|"
             r"Eye of the Moon|Kumo-nin J|comatose|Fourth Shinobi World War|When he was discovered|in the manga it takes place",
    # o que só se revela depois deste arco: Cúpula dos Cinco Kage (Danzō Hokage, Raikage, Mizukage...), Tobi = Obito,
    # Kurama, Plano Olho da Lua, guerra, Edo Tensei, Hagoromo/Kaguya
    bad=bad(
        r"Obito|Kaguya|Ōtsutsuki|Otsutsuki|Hagoromo|Six Paths(?! of Pain)|Sage of the Six|Black Zetsu.{0,80}(?:Madara|will|Kaguya)|"
        r"Ten-Tails|Juubi|Kurama\b|Fourth Shinobi|Fourth Great|Allied Shinobi|the Fourth War|Infinite Tsukuyomi|Eye of the Moon|"
        r"Edo Tensei|Impure World|Reanimation|reanimated|Kabuto.{0,60}(?:Nagato|Itachi|Sage|absorbed|reincarnat)|"
        r"Nagato.{0,60}Kabuto|Five Kage|Past Arc|Power Arc|Paradise Life|"
        r"Perfect Sage|Sage Mode.{0,80}(?:Kabuto|Orochimaru)|Nine-Tails Chakra Mode|Naruto.{0,60}Killer B|Killer B.{0,60}Naruto|"
        r"Shisui|Root.{0,100}(?:Shisui|Izanagi|Kotoamatsukami|Sharingan|eye|Hokage)|Kotoamatsukami|Izanagi|Izanami|"
        r"Danzō.{0,100}(?:Hokage|Kage Summit|Sharingan|died|death|killed|defeat|Shisui|Izanagi|summit)|"
        r"(?:Hokage|Kage Summit|Sharingan|summit).{0,100}Danzō|Sasuke.{0,60}(?:Danzō|Raikage|Kage Summit)|kill Danzō|assassinat|"
        r"Raikage|Mizukage|Tsuchikage|Land of Iron|Mifune|Darui|Samui|Kurotsuchi|Chōjūrō|Yugito|Rōshi|Roshi|Utakata|Isobu|"
        r"coma\b|comatose|Hokage garb|Hokage position|Sixth Hokage|Rokudaime|acting Hokage|"
        r"Naruto has had his turn|Kisame.{0,60}(?:died|killed|death|suicide|Guy)|Itachi.{0,60}(?:illness|disease|terminal)|"
        r"Uzushiogakure|Naruto Gaiden|Rinne Festival|destroy the world|Tailed Beast Bomb|"
        r"Kushina.{0,200}jinch|inevitably be deployed|Delta|shinobi-ware|Gale Palm|"
        r"Orochimaru.{0,80}(?:Kabuto|reviv|resurrect|rebirth|reappear)|later regain|enhanced DNA|enhanced-White|Hashirama cell|"
        r"File:|absorbed from B|Eight and Nine-Tails|Madara.{0,100}Rinnegan|Rinnegan.{0,100}Madara|Gaara's sand|war's start|the war progresses|"
        r"maliciously|Danzō countered|Danzō.{0,60}(?:apprentice|trained)|During the War|reincarnated|worthy of being a Kage|entirety of Part II|Jūgo.{0,60}senjutsu|adapting their DNA|"
        r"(?-i:Sai\b)(?=.{0,60}Root)|seven in its history|seven Hokage|Metal Lee|Duy\b|"
        r"make the world a better place|concerned for where things"
    ),
    characters=["Naruto Uzumaki", "Nagato", "Konan", "Tsunade", "Kakashi Hatake", "Sakura Haruno", "Shizune",
                "Shikamaru Nara", "Hinata Hyūga", "Konohamaru Sarutobi", "Chōji Akimichi", "Chōza Akimichi",
                "Ino Yamanaka", "Inoichi Yamanaka", "Tsume Inuzuka", "Kiba Inuzuka", "Shino Aburame", "Shikaku Nara",
                "Ibiki Morino", "Might Guy", "Neji Hyūga", "Iruka Umino", "Ebisu", "Sasuke Uchiha",
                "Fukasaku", "Shima", "Gamabunta", "Gamakichi", "Gamaken", "Katsuyu", "Yamato", "Sai", "Anko Mitarashi"],
    techniques=["Six Paths of Pain", "Deva Path", "Animal Path", "Preta Path", "Human Path", "Asura Path", "Naraka Path",
                "Rinnegan", "Shinra Tensei", "Banshō Ten'in", "Chibaku Tensei", "Samsara of Heavenly Life Technique",
                "Black Receiver", "King of Hell", "Summoning Rinnegan", "Sage Mode", "Natural Energy", "Senjutsu",
                "Frog Kata", "Wind Release: Rasenshuriken", "Rasengan", "Sage Art: Amphibian Technique",
                "Reverse Summoning Technique", "Katsuyu: Immense Network Healing", "Psycho Mind Transmission",
                "Mind Body Switch Technique", "Sealing Technique: Phantom Dragons Nine Consuming Seals",
                "Shadow Clone Technique", "Multiple Shadow Clone Technique", "Creation Rebirth",
                "Strength of a Hundred Seal", "Mystical Palm Technique", "Partial Multi-Size Technique",
                "Human Boulder", "Dance of the Shikigami", "Summoning Technique", "Version 2"],
    places=["Konohagakure", "Amegakure", "Mount Myōboku", "Akatsuki", "Demonic Statue of the Outer Path",
            "Ame Orphans", "Konoha Cryptanalysis Team", "Konoha Barrier Team", "Konoha Torture and Interrogation Force",
            "Great Toad Sage", "Two Great Sage Toads", "Sannin"],
)
