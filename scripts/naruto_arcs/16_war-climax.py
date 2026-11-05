from naruto_arcs import PART2, bad

ARC = dict(
    **PART2,
    title="Naruto Shippūden (Parte II) - Arco do Clímax da Quarta Guerra Ninja",
    name="Fourth Shinobi World War: Climax",
    arc_page="Fourth Shinobi World War: Climax",
    eps=(322, 375),  # 349-361 (Kakashi's Anbu Arc) não estão na tabela do arco, ficam de fora sozinhos
    chapters="560-639",
    part_sections=["Fourth Shinobi World War: Climax"],
    # o que só se revela depois deste arco (capítulos 640+): Madara jinchūriki, Obito morrendo/redimido, Hagoromo/Indra/Asura/Kaguya,
    # Ninshū, Poderes do Sábio dos Seis Caminhos, Verdade-Buscando, Limbo, Infinite Tsukuyomi lançado, Naruto x Sasuke final, Sexto Hokage...
    bad=bad(
        r"Kaguya|Ōtsutsuki|Otsutsuki|Hagoromo|Hamura|Indra|(?-i:Asura(?! Path))|Ninshū|Ninshu|God Tree|Shinju|Divine Tree|"
        r"Rabbit Goddess|Pure Land|Land of Ancestors|Stone Tablet.{0,40}(?:Kaguya|revis|rewrit)|"
        r"Madara.{0,80}(?:jinchūriki|jinchuriki)|(?:jinchūriki|jinchuriki).{0,40}Madara|"
        r"Madara.{0,60}(?:death|died|dies|killed|stabbed|sealed)|Obito.{0,60}(?:death|died|dies|killed|sacrific|redeem|repent|redemption)|"
        r"(?:his|her) death|had (?:he|she) lived|lived longer|"
        r"Six Paths Sage|Six Paths Yin|Six Paths Yang|Yin.Yang Release|Truth-Seeking|Limbo|Rinne.?Sharingan|Treasured Tools|"
        r"Tailed Beast Transfer|Night Guy|Evening Elephant|Eight Gates Released|Kamui Lightning|Amenotejikara|Mayfly|"
        r"Sasuke.{0,60}Rinnegan|Rinnegan.{0,60}Sasuke|Rinne Festival|Chibaku Tensei.{0,60}(?:moon|Sasuke)|"
        r"Birth of the Ten-Tails|Kaguya Ōtsutsuki Strikes|Isshiki|Toneri|"
        r"cast the Infinite Tsukuyomi|Infinite Tsukuyomi.{0,50}(?:cast|activat|complet|success|trapped|caught|fades?)|"
        r"(?:caught|trapped|under) (?:in )?the Infinite Tsukuyomi|"
        r"final battle|Naruto and Sasuke.{0,50}(?:reconcil|final)|Sasuke.{0,60}(?:become Hokage|revolution)|"
        r"Sixth Hokage|Rokudaime|Hokage garb|Hokage position|role as Hokage|seven Hokage|seven in its history|"
        r"end of the Fourth|As the Ten-Tails.{0,20}Jinchūriki|overwhelm both Naruto|exceeded that of even Hashirama|"
        r"years after|peaceful era|surviv(?:ing|ed) the Fourth|forced him to retire|wheelchair|"
        r"war ended|end of the war|after the war|following the war|post-war|Naruto Gaiden|Naruto has had his turn|"
        r"Decades later|destroy the world|single-handedly defeated|different individuals|make the world a better place"
    ),
    characters=["Naruto Uzumaki", "Sasuke Uchiha", "Sakura Haruno", "Kakashi Hatake", "Madara Uchiha", "Obito Uchiha",
                "Hashirama Senju", "Tobirama Senju", "Minato Namikaze", "Hiruzen Sarutobi", "Kabuto Yakushi", "Orochimaru",
                "Itachi Uchiha", "Killer B", "Gaara", "Ōnoki", "Tsunade", "Might Guy", "Shikamaru Nara", "Shikaku Nara",
                "Kurama", "Gyūki", "Mei Terumī", "Fourth Raikage", "Neji Hyūga"],
    techniques=["Summoning: Impure World Reincarnation", "Susanoo", "Kamui", "Tailed Beast Ball", "Nine-Tails Chakra Mode",
                "Tailed Beast Mode", "Demonic Statue of the Outer Path", "Eye of the Moon Plan", "Izanami",
                "Mangekyō Sharingan", "Eternal Mangekyō Sharingan", "Sharingan", "Rinnegan", "Ten-Tails",
                "Wood Release", "Wood Release: Cutting Technique", "Wood Release Secret Technique: Nativity of a World of Trees",
                "Sage Mode", "Wind Release: Rasenshuriken", "Lightning Blade", "Kirin", "Amaterasu", "Flying Thunder God Technique",
                "Earth Release: Light-Weight Rock Technique", "Eight Gates",
                "Curse of Hatred", "White Zetsu Army", 
                "Mind Body Transmission Technique", "Susanoo Sword"],
    places=["Allied Shinobi Forces", "Akatsuki", "Konohagakure", "Uchiha clan", "Senju clan", "Naka Shrine", "Taka"],
)
