# Facebook Reaction Blocker

Tampermonkey skript, který načte profily z vybrané reakce u příspěvku na Facebooku a postupně je zablokuje.

Původní nápad: [@Ro_Kolar2](https://x.com/Ro_Kolar2)

<img width="472" height="1051" alt="image" src="https://github.com/user-attachments/assets/b93d47b1-758c-43dd-b75b-75f9a8ceece6" />

## Instalace

1. Nainstaluj [Tampermonkey](https://www.tampermonkey.net/).
2. V nastavení rozšíření zapni **Allow User Scripts / Povolit uživatelské skripty**.
3. Otevři [instalační odkaz](https://raw.githubusercontent.com/misch2/FB-dezo-blocker/main/facebook-reaction-blocker.user.js) a v Tampermonkey potvrď instalaci.
4. Obnov Facebook pomocí `Ctrl+R`. Vpravo se zobrazí panel **Reaction Blocker**.

Pokud panel chybí, zkontroluj, že je Tampermonkey i skript zapnutý, rozšíření má přístup k Facebooku a volba **Allow User Scripts** je povolená.
Tampermonkey bude podle svého nastavení automaticky vyhledávat a instalovat nové verze skriptu.

## Použití

1. Otevři konkrétní příspěvek.
2. Otevři seznam reakcí a ručně vyber požadovaný typ reakce.
3. V panelu klikni na **Načíst otevřenou reakci**.
4. Zkontroluj počet, jména a ikonky reakcí načtených profilů.
5. Nejprve spusť režim **Nanečisto**.
6. Pokud seznam souhlasí, načti reakci znovu a použij **Asistovaný** nebo **Automatický** režim.
7. Celá načtená fronta je vidět ve vlastním posuvném seznamu. Aktuální profil se při běhu automaticky zobrazí.

### Režimy

- **Nanečisto** – zobrazí, které profily by skript zpracoval, ale nic nezmění.
- **Asistovaný** – před zablokováním každého profilu požádá o potvrzení.
- **Automatický** – zpracuje načtené profily bez jednotlivých potvrzení.

Pro první ostrý test nastav maximum na jeden profil a použij asistovaný režim.

## Ovládání

- **▶ Spustit** – zahájí zpracování fronty.
- **⏸ Pauza** – pozastaví zpracování. Stejné kontextové tlačítko se po pozastavení změní na **▶ Pokračovat**.
- **↻ Spustit znovu** – po dokončení zpracuje jen přeskočené a chybové profily; již zablokované profily se nikdy neopakují.
- **⏭ Přeskočit** – přeskočí aktuální profil. Při přeskočení posledního profilu se běh také dokončí.
- **■ Stop** – ukončí běh a ponechá načtenou frontu. Po dokončení už není aktivní.
- **Zpět na příspěvek** – vrátí se k původnímu příspěvku; během běhu je tlačítko zablokované.
- **Vymazat frontu** – smaže načtené profily a protokol. Během běhu je nutné nejprve použít **Stop**.

Po úspěšném dokončení ostrého běhu se zobrazí oznámení „Blokování doběhlo úspěšně do konce.“. Facebookový dialog s výsledkem zůstává otevřený, aby jej bylo možné ručně zavřít.

## Omezení

- Facebook může své rozhraní změnit. Pokud skript potřebný prvek nerozpozná, pozastaví se.
- Blokování se vztahuje pouze na konkrétní profil. Další profily stejného člověka Facebook pouze částečně omezí a skript je nedokáže spolehlivě dohledat.
- Fronta, stav běhu a protokol jsou uložené jen pro aktuální kartu/okno Facebooku. Při přechodech mezi profily v tomto okně zůstanou zachované; další facebookové okno nezačne stejný běh.
- Data se neposílají na externí server.
