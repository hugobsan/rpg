from naruto_arcs import ARC_TEXT_BAD, PART2, bad

ARC = dict(
    **PART2,
    title="Naruto Shippūden (Parte II) - Arco do Nascimento dos Jinchūriki do Dez-Caudas",
    name="Birth of the Ten-Tails' Jinchūriki",
    arc_page="Birth of the Ten-Tails' Jinchūriki",
    # a tabela do arco já deixa de fora os fillers 389-390 (Hanabi), 394-413 (In Naruto's Footsteps) e 422-423 (Konohamaru)
    eps=(378, 431),
    chapters="640-677",
    part_sections=["Birth of the Ten-Tails' Jinchūriki"],
    # o que só se revela depois deste arco (capítulos 678+): Kaguya e sua história, Zetsu Negro de verdade, morte de Madara,
    # Hamura/Ninshū, Terra dos Ancestrais, Rinnegan de Sasuke, Naruto x Sasuke final, Sexto Hokage...
    bad=bad(
        r"Kaguya(?! Clan)|Hamura|Ninshū|Ninshu|Land of Ancestors|Pure Land|Rabbit Goddess|Shinju|"
        r"Black Zetsu.{0,80}(?:betray|stab|true|real|will of)|will of Kaguya|"
        r"Madara.{0,60}(?:death|died|dies|killed|stabbed)|"
        r"Infinite Tsukuyomi.{0,60}(?:dispel|fad|end(?:s|ed)\b|broken|wake|woke|undone|releas)|"
        r"(?:wake|woke|waking|escape) (?:up )?(?:from )?the Infinite Tsukuyomi|"
        r"Sasuke.{0,60}Rinnegan|Rinnegan.{0,60}Sasuke|"
        r"Gamamaru|Amenotejikara|Amenominaka|Yomotsu|Taizō|Kanna\b|Indra's Arrow|Honoikazuchi|Ash Bones|Momoshiki|Kinshiki|"
        r"Naruto and Sasuke.{0,60}(?:final|fought|fight each other|clash|reconcil)|final battle|lost (?:his|their) (?:arms?|hands?)|"
        r"Valley of the End.{0,60}(?:Naruto|final|Sasuke)|Sasuke.{0,60}(?:become Hokage|revolution)|"
        r"Kaguya Ōtsutsuki Strikes|Isshiki|Toneri|acquiring Six Paths|compared to the Sage of Six Paths|"
        r"Sixth Hokage|Rokudaime|Hokage garb|Hokage position|role as Hokage|seven Hokage|seven in its history|"
        r"(?:his|her) death|had (?:he|she) lived|lived longer|"
        r"years after|peaceful era|surviv(?:ing|ed) the Fourth|forced him to retire|wheelchair|end of the Fourth|"
        r"war ended|end of the war|after the war|following the war|post-war|Naruto Gaiden|Naruto has had his turn|"
        r"Decades later|single-handedly defeated|different individuals|make the world a better place"
    ),
    characters=["Naruto Uzumaki", "Sasuke Uchiha", "Sakura Haruno", "Kakashi Hatake", "Obito Uchiha", "Madara Uchiha",
                "Hashirama Senju", "Tobirama Senju", "Minato Namikaze", "Hiruzen Sarutobi", "Orochimaru", "Kabuto Yakushi", "Gaara",
                "Might Guy", "Killer B", "Kurama", "Gyūki", "Tsunade", "Hinata Hyūga", "Rock Lee", "Tenten",
                "Shikamaru Nara", "Karin", "Jūgo", "Suigetsu Hōzuki", "Sai", "Yamato", "Ōnoki", "Mei Terumī",
                "Fourth Raikage"],
    techniques=["Summoning: Impure World Reincarnation", "Tailed Beast Mode", "Tailed Beast Ball", "Nine-Tails Chakra Mode",
                "Truth-Seeking Ball", "Rinne Sharingan", "Rinnegan", "Susanoo", "Kamui", "Chibaku Tensei",
                "Limbo: Border Jail", "Six Paths Sage Mode", "Flying Thunder God Technique", "Eight Gates",
                "Night Guy", "Evening Elephant", "Wind Release: Rasenshuriken", "Tailed Beast Ball Rasenshuriken",
                "Yin–Yang Release", "Tailed Beast Transfer Technique", "Eternal Mangekyō Sharingan", "Infinite Tsukuyomi",
                "Eye of the Moon Plan", "Ten-Tails", "Sage Mode", "Wood Release: Cutting Technique",
                "Wood Release Secret Technique: Nativity of a World of Trees", "Creation Rebirth: Strength of a Hundred Technique",
                "Treasured Tools of the Sage of Six Paths", "Parent and Child Rasengan", "Four Red Yang Formation"],
    places=["Allied Shinobi Forces", "Konohagakure", "Kusagakure", "Team Minato", "Uchiha clan"],
)

# o sonho de Karin (ep. 431) chama Sasuke de Sexto Hokage: corta da sinopse para não parecer cânone do futuro
ARC["text_bad"] = ARC_TEXT_BAD + r"|Sixth Hokage"
