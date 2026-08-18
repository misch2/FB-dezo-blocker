# Facebook Reaction Blocker

Tampermonkey skript, který načte profily z vybrané reakce u příspěvku na Facebooku a postupně je zablokuje.

<img width="472" height="1051" alt="image" src="https://github.com/user-attachments/assets/b93d47b1-758c-43dd-b75b-75f9a8ceece6" />

## Instalace

1. Nainstaluj [Tampermonkey](https://www.tampermonkey.net/).
2. V nastavení rozšíření zapni **Allow User Scripts / Povolit uživatelské skripty**.
3. V Tampermonkey zvol **Create a new script / Vytvořit nový skript**.
4. Vlož obsah souboru [`facebook-reaction-blocker.user.js`](./facebook-reaction-blocker.user.js) a ulož ho pomocí `Ctrl+S`.
5. Obnov Facebook pomocí `Ctrl+R`. Vpravo se zobrazí panel **Reaction Blocker**.

Pokud panel chybí, zkontroluj, že je Tampermonkey i skript zapnutý, rozšíření má přístup k Facebooku a volba **Allow User Scripts** je povolená.

## Použití

1. Otevři konkrétní příspěvek.
2. Otevři seznam reakcí a ručně vyber požadovaný typ reakce.
3. V panelu klikni na **Načíst otevřenou reakci**.
4. Zkontroluj počet, jména a ikonky reakcí načtených profilů.
5. Nejprve spusť režim **Nanečisto**.
6. Pokud seznam souhlasí, načti reakci znovu a použij **Asistovaný** nebo **Automatický** režim.

### Režimy

- **Nanečisto** – zobrazí, které profily by skript zpracoval, ale nic nezmění.
- **Asistovaný** – před zablokováním každého profilu požádá o potvrzení.
- **Automatický** – zpracuje načtené profily bez jednotlivých potvrzení.

Pro první ostrý test nastav maximum na jeden profil a použij asistovaný režim.

## Ovládání

- **Pauza** – pozastaví zpracování.
- **Pokračovat** – zopakuje aktuální krok po pozastavení nebo chybě.
- **Přeskočit** – přeskočí aktuální profil.
- **Stop** – ukončí běh a ponechá načtenou frontu.
- **Zpět na příspěvek** – vrátí se k původnímu příspěvku.
- **Vymazat frontu** – smaže načtené profily a protokol.

## Omezení

- Facebook může své rozhraní změnit. Pokud skript potřebný prvek nerozpozná, pozastaví se.
- Blokování se vztahuje pouze na konkrétní profil. Další profily stejného člověka Facebook pouze částečně omezí a skript je nedokáže spolehlivě dohledat.
- Fronta a protokol zůstávají uložené pouze v Tampermonkey a neposílají se na externí server.
