# Facebook Reaction Blocker

Bezpečnostně konzervativní prototyp userscriptu pro Tampermonkey. Z otevřeného dialogu reakcí u facebookového příspěvku načte profilové odkazy a umí je následně zpracovat v jednom ze tří režimů:

- **Nanečisto** – pouze ukáže, které profily by zpracoval. Nic na Facebooku nemění.
- **Asistovaný** – navštíví profily postupně a před konečným potvrzením každého blokování se zeptá.
- **Automatický** – potvrzuje blokování bez další otázky. Používej až po ověření předchozích režimů.

## Instalace

1. Do Chromu nainstaluj rozšíření [Tampermonkey](https://www.tampermonkey.net/).
2. V nabídce Tampermonkey povol **Allow User Scripts / Povolit uživatelské skripty**. Pokud se nahoře zobrazuje modré upozornění „Please enable the 'Allow User Scripts' extension setting“, klikni na odkaz v něm a příslušný přepínač zapni v nastavení rozšíření.
3. V Tampermonkey zvol **Create a new script / Vytvořit nový skript**.
4. Nahraď výchozí obsah souborem [`facebook-reaction-blocker.user.js`](./facebook-reaction-blocker.user.js) a ulož jej (`Ctrl+S`).
5. Otevři Facebook nebo již otevřenou stránku obnov pomocí `Ctrl+R`. Vpravo dole se zobrazí panel **Reaction Blocker**.

### Panel se nezobrazuje

Zkontroluj v nabídce Tampermonkey následující:

- Tampermonkey hlásí stav **Enabled**.
- Nezobrazuje se hlášení **Tampermonkey has no access to this page**.
- Volba **Allow User Scripts** je zapnutá.
- Skript **Facebook Reaction Blocker** je v přehledu Tampermonkey zapnutý.
- Po změně oprávnění byla stránka Facebooku obnovena pomocí `Ctrl+R`.

## Doporučený první test

1. Otevři konkrétní příspěvek na samostatné stránce.
2. Klikni na souhrn reakcí, aby se otevřel seznam reagujících.
3. V dialogu Facebooku ručně vyber reakci, kterou chceš zpracovat. Tento krok je záměrně ruční, aby skript nemohl zaměnit příspěvek nebo typ reakce.
4. V panelu klikni na **Načíst otevřenou reakci**. Skript dialog postupně posouvá a sbírá profilové odkazy.
5. Prohlédni si počet a názvy. Nastav rozumné maximum, poprvé například 2–3 profily.
6. Nech zvolený režim **Nanečisto** a klikni na **Spustit**.
7. Pokud náhled odpovídá očekávání, načti dialog znovu a vyzkoušej **Asistovaný** režim s jedním testovacím profilem.

## Ovládání a zotavení z chyby

- **Pauza** zastaví přechod na další profil. Kliknutí, které už proběhlo, nelze odvolat.
- **Pokračovat** opakuje aktuální krok po pozastavení.
- **Přeskočit** označí aktuální profil jako přeskočený a pokračuje dalším.
- **Stop** ukončí běh, ale nemaže frontu ani protokol.
- **Zpět na příspěvek** se vrátí na stránku, ze které byla fronta načtena.
- **Vymazat frontu** smaže uloženou frontu a místní protokol Tampermonkey.

Fronta je uložená pomocí úložiště Tampermonkey, takže přežije přechody mezi profilovými stránkami. Skript neposílá data na žádný externí server.

## Omezení

Facebook nemá pro tyto prvky stabilní veřejné selektory a jejich text se liší podle jazyka účtu. Prototyp rozpoznává běžné české a anglické popisky, ale po změně rozhraní se bezpečně pozastaví, pokud nabídku nebo potvrzení nerozezná. Nikdy nepovažuj náhodné prodlevy za záruku, že Facebook automatizaci neomezí.

Před použitím ostrého režimu vždy spusť režim nanečisto. Za výběr profilů a následky blokování odpovídá uživatel.
