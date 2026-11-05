from naruto_arcs import ARC_TEXT_BAD, PART2, bad

ARC = dict(
    **PART2,
    title="Naruto Shippūden (Parte II) - Arco do Ataque de Kaguya Ōtsutsuki",
    name="Kaguya Ōtsutsuki Strikes",
    arc_page="Kaguya Ōtsutsuki Strikes",
    # a tabela do arco lista 451, 455 e 458 (episódios do Itachi Shinden que mostram a guerra, caps. 677-679) e pula o 469 (filler);
    # os demais episódios do Itachi Shinden (452-454, 456-457) não estão na tabela e ficam de fora sozinhos
    eps=(451, 478),  # o 479 (caps. 699-700) é só o epílogo (Sexto Hokage, prisão e partida de Sasuke): fora
    chapters="678-699",
    part_sections=["Kaguya Ōtsutsuki Strikes"],
    # último arco do mangá: só fica de fora o epílogo (cap. 699-700 e depois) e tudo que a base da Parte II já bane
    # (Blank Period, filmes, Boruto, filhos, casamentos, Sétimo Hokage...); aqui somam-se os títulos de Hokage e a Kara/Ōtsutsuki tardios
    bad=bad(
        r"Sixth Hokage|Rokudaime|Kakashi (?:became|becomes|succeed)|day Kakashi|later resealed|funeral|memorial service|"
        r"sent to prison|international celebrity|artificial arms?|prosthetic|Hashirama's cells|granted a pardon|seek (?:his )?redemption|Naruto Gaiden|"
        r"Momoshiki|Kinshiki|Isshiki|Toneri|Urashiki|Jigen|(?-i:Kara\b)|(?-i:Inner\b)|Sarada|"
        r"years after|peaceful era|surviv(?:ing|ed) the Fourth|forced him to retire|wheelchair|Sixteen years|"
        r"war ended|end of the war|after the war|following the war|post-war|Naruto has had his turn|"
        r"Decades later|different individuals|make the world a better place"
    ),
    characters=["Naruto Uzumaki", "Sasuke Uchiha", "Sakura Haruno", "Kakashi Hatake", "Obito Uchiha", "Madara Uchiha",
                "Black Zetsu", "Kaguya Ōtsutsuki", "Hagoromo Ōtsutsuki", "Rin Nohara", "Minato Namikaze",
                "Hashirama Senju", "Tobirama Senju", "Hiruzen Sarutobi", "Kurama", "Gyūki", "Killer B", "Gaara",
                "Hinata Hyūga", "Rock Lee", "Tenten", "Shikamaru Nara", "Tsunade", "Orochimaru", "Kabuto Yakushi",
                "Yamato", "Sai", "Ino Yamanaka", "Karin", "Jūgo", "Suigetsu Hōzuki", "Might Guy",
                "Gamamaru"],
    techniques=["Infinite Tsukuyomi", "Truth-Seeking Ball", "Rinnegan", "Rinne Sharingan", "Six Paths Sage Mode", "Susanoo",
                "Amenotejikara", "Kamui", "Chibaku Tensei", "Tailed Beast Ball Rasenshuriken", "Blaze Release: Kagutsuchi",
                "Indra's Arrow", "Yin–Yang Release", "Tailed Beast Mode", "Ten-Tails", "Ninshū", "God Tree",
                "Kaguya's Dimension", "Sage Art: Gate of the Great God", "Rasengan", "Chidori", "Amaterasu",
                "Mangekyō Sharingan", "Sharingan", "Byakugan", "Sage Mode", "Nine-Tails Chakra Mode", "Creation of All Things Technique",
                "Expansive Truth-Seeking Ball", "Wood Release: Cutting Technique", "Treasured Tools of the Sage of Six Paths"],
    places=["Allied Shinobi Forces", "Konohagakure", "Valley of the End", "Land of Ancestors", "Team Kakashi", "Mount Myōboku"],
)
# a sinopse do cap. 699 traz o epílogo (Sexto Hokage, prisão, perdão, partida de Sasuke): fora, junto com os descendentes de Kaguya (filmes)
ARC["text_bad"] = (ARC_TEXT_BAD + r"|Sixth Hokage|Rokudaime|funerals? (?:are|were) held|sent to prison|international celebrity|"
                   r"artificial arms?|granted a pardon|seek redemption|hands him over|Momoshiki|Kinshiki|Isshiki")
