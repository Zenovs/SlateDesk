# SlateDesk – Fernsteuerung

Die Fernsteuerung ist die Web-Oberfläche von SlateDesk. Die Kiosk-App stellt sie selbst bereit; sie läuft
in jedem aktuellen Browser auf Handy, Tablet oder PC im selben Netzwerk. Alles, was dort geändert wird,
erscheint sofort auf dem Bildschirm – und umgekehrt.

## Verbinden und anmelden

**Adresse und PIN finden** – am Kiosk in der oberen Leiste **Bearbeiten** antippen, dann **Fernsteuerung**.
Der Dialog zeigt

- die Adresse(n), z. B. `http://192.168.19.42:7380`, und dazu einen QR-Code,
- den PIN (mit dem Augen-Symbol einblenden).

Mit der Handy-Kamera den QR-Code scannen oder die Adresse im Browser eintippen. Das Handy muss im
Büro-WLAN bzw. im selben Netzwerk wie der Kiosk sein.

Weitere Wege zur Adresse:

- Das Widget **Kiosk-Status** zeigt Adresse und QR-Code dauerhaft am Bildschirm (nie den PIN).
- Per SSH auf dem Kiosk: `hostname -I`; `setup.sh` gibt die Adresse am Ende aus.

Ist die obere Leiste ausgeblendet, die Ecke oben rechts antippen – sie erscheint für 30 Sekunden. Fehlt
«Bearbeiten», ist «Bearbeiten am Kiosk erlauben» ausgeschaltet; dann eine bereits angemeldete
Fernsteuerung nehmen (Übersicht → **Bearbeiten am Kiosk: Ein**) oder den PIN per SSH lesen:
`sudo grep '"pin"' /home/slatedesk/.config/com.slatedesk.app/remote.json`.

**Anmelden** – den PIN auf dem Ziffernblock eingeben (oder mit der Tastatur) und mit dem Pfeil bestätigen.

- Der PIN hat 6 bis 12 Ziffern; beim ersten Start erzeugt der Kiosk einen zufälligen 6-stelligen PIN. Ein
  älterer 4- oder 5-stelliger PIN funktioniert weiter, bis er unter **System → PIN ändern** ersetzt wird.
- Nach 5 falschen Versuchen innert 5 Minuten wartet die Anmeldung, bis der Zeitraum abgelaufen ist; die
  Seite zählt die Sekunden herunter. Diese Sperre gilt pro Gerät (IP-Adresse).
- Kommen innert 5 Minuten 20 falsche Versuche zusammen, egal von welchen Geräten, ist die Anmeldung für alle
  15 Minuten gesperrt (bei Wiederholung länger, höchstens 4 Stunden). Bereits angemeldete Browser sind davon
  nicht betroffen; ein Neustart der App hebt die Sperre auf.
- Die Fernsteuerung über die IP-Adresse oder den Namen des Kiosks öffnen. Unter einem fremden DNS-Namen meldet
  sie «Unbekannte Adresse» – einen eigenen Namen trägt man in `SLATEDESK_REMOTE_HOSTS` ein
  ([BETRIEB.md](BETRIEB.md#dienste-und-timer)).
- Die Anmeldung bleibt bis zu 30 Tage im Browser gespeichert, endet aber mit jedem Neustart der App: jede
  Nacht um 04:00, nach einem Update und nach «App neu starten». Danach meldet die Seite «Sitzung abgelaufen –
  bitte erneut anmelden».

**Tipp fürs Handy:** Die Seite über das Teilen-Menü «Zum Home-Bildschirm» hinzufügen – dann öffnet sie sich
wie eine App. Der Browser darf den PIN als Passwort speichern.

## Aufbau

Oben stehen der Name des Kiosks und der Verbindungsstatus:

| Anzeige | Bedeutung |
|---|---|
| **Live** | Änderungen erscheinen in beide Richtungen sofort |
| **Verbinde…** | die Live-Verbindung wird wiederhergestellt (z. B. nach WLAN-Wechsel) |
| **Offline** | der Kiosk antwortet nicht (ausgeschaltet, Neustart, anderes Netzwerk) |

Navigation:

- **Handy:** Leiste unten mit Übersicht, Layout, Widgets, Inhalte und **Mehr**. Unter «Mehr» liegen lagra,
  planbar, Kiosk, System, die Darstellung der Fernsteuerung und «Abmelden».
- **Tablet und PC** (ab 900 px Breite): alle Bereiche in der Seitenleiste links, unten Darstellung und
  Abmelden.

Die **Darstellung** (Automatisch, Hell, Dunkel) gilt nur für den eigenen Browser. Das Design des Kiosks wird
unter **Kiosk** eingestellt.

## Übersicht

- **Kiosk-Status** – Hostname, Version, Laufzeit von System und App, CPU-Temperatur, Last, Bildschirmgrösse,
  Sitzung (z. B. Wayland · GNOME), Arbeitsspeicher, Speicherplatz und IP-Adressen; alle 15 Sekunden
  aktualisiert.
- **Schnellaktionen**
  - *Neu laden* – lädt die Anzeige des Kiosks neu (nicht das Programm).
  - *Identifizieren* – der Kiosk zeigt 10 Sekunden lang Name und Adresse gross an. Praktisch bei mehreren
    Bildschirmen.
  - *Bildschirm Aus / An* – schaltet den Monitor sofort; die Meldung nennt den verwendeten Weg (z. B.
    `gnome-mutter`).
  - *Bearbeiten am Kiosk Ein / Aus* – schaltet den Bearbeiten-Modus am Bildschirm.
  - *Kiosk-Design* – Dunkel oder Hell.
- **Bildschirm** – Live-Vorschau des Rasters. Ein Tipp auf ein Widget öffnet dessen Einstellungen.

## Layout

Zeigt das Raster des Kiosks in seinem Seitenverhältnis. Die Linie «Bildschirmende Kiosk» markiert, was auf
dem Bildschirm noch sichtbar ist.

- **Widget hinzufügen** – Katalog nach Kategorien, mit Suche. Gesichtserkennung und Ruhemodus gibt es nur
  einmal pro Dashboard.
- **Verschieben** – am Griff eines Widgets ziehen. **Grösse** – an der Ecke unten rechts ziehen.
- **Antippen** wählt ein Widget aus; darunter erscheinen Pfeile zum Verschieben, Breite und Höhe in
  Rasterschritten, **Einstellungen**, **Duplizieren** und **Entfernen** (mit Rückfrage; die Einstellungen
  des Widgets werden mitgelöscht).
- **Zoom** vergrössert die Vorschau auf kleinen Bildschirmen.

Alle Änderungen gelten sofort am Kiosk. Spaltenzahl und Zeilenhöhe stehen unter **Kiosk → Raster**.

## Widgets

Liste aller Widgets auf dem Kiosk in Lesereihenfolge (mehrfach vorhandene sind nummeriert, z. B. «Uhr 2»).
Kennzeichen: **Angepasst** (eigene Einstellungen gespeichert), **Keine Einstellungen**, **Unbekannt** (diese
Version kennt den Widget-Typ nicht).

Die Detailseite zeigt dasselbe Einstellungsformular wie der Kiosk. Jede Änderung wird sofort gespeichert;
Texte und Zahlen nach einer kurzen Pause oder beim Verlassen des Felds, Adressen erst beim Verlassen des
Felds oder mit der Eingabetaste.

- **Zugangsdaten** (Passwörter, Tokens, API-Schlüssel) werden nie angezeigt. «gesetzt» heisst, dass ein Wert
  gespeichert ist; zum Ändern einfach den neuen Wert eingeben.
- **Adresse geändert → Zugang weg:** Ändert man über die Fernsteuerung eine Adresse (URL oder Host), löscht
  der Kiosk die zugehörigen Passwörter bzw. Schlüssel (daneben und darunter, bei planbar die aller
  Unternehmen). Deshalb zuerst die Adresse ändern, danach den Zugang neu eingeben.
- **Nur am Kiosk:** Kamera-Auswahl, Verbindungstests, die Modell-Liste des KI-Assistenten und ähnliche
  Zusatzbereiche gibt es nur im Einstellungsdialog am Kiosk (Bearbeiten → Zahnrad am Widget).
- **lagra- und planbar-Widgets** melden oben, wenn die Verbindung noch nicht eingerichtet ist, mit Link zur
  passenden Seite. Die Auswahl von Personen und Projekten (planbar) lädt erst, wenn die Verbindung steht, und
  folgt der Auswahl **Unternehmen** darüber.
- **Darstellung → Schriftgrösse** (jedes Widget, 60–300 %): zoomt Text und Inhalt dieses Widgets, die Änderung
  erscheint sofort am Kiosk. Bei grösserer Schrift zeigen Listen entsprechend weniger Einträge. Uhr und
  QR-Code füllen ihre Fläche schon ganz und lassen sich nur verkleinern – grösser werden sie, wenn man das
  Widget im Layout grösser zieht.
- **Verwalten:** *Auf Standard zurücksetzen* löscht alle Einstellungen des Widgets inklusive gespeicherter
  Zugangsdaten; *Widget entfernen* nimmt es vom Kiosk.

## Inhalte

Zwei Register für Inhalte, die Widgets am Kiosk anzeigen. Ein Hinweis erscheint, solange kein passendes
Widget auf dem Kiosk liegt.

**Pinnwand** (Widget «Pinnwand») – Mitteilungen mit Titel, optionalem Text, Art (Info, Wichtig, Erfolg),
«Verfasst von», «Anheften» und Sichtbarkeit *Sichtbar ab* (sofort oder ab Zeitpunkt) bzw. *Sichtbar bis*
(ohne Ende oder bis Zeitpunkt). Mitteilungen lassen sich bearbeiten, duplizieren und löschen.

**Aufgaben** (Widget «Aufgaben») – Aufgaben mit Liste (z. B. «Allgemein», «Einkauf»), Fälligkeit, Priorität und
Zuständigkeit. Filter nach Liste, «Erledigte anzeigen» und Erledigte einer Liste entfernen. Am Kiosk lassen
sich Aufgaben je nach Widget-Einstellung abhaken und neu erfassen.

## lagra und planbar

Je eine Seite pro Integration.

**lagra**

1. **Verbindung** – «lagra verwenden» einschalten, Adresse (leer = Standardadresse) und API-Token eintragen,
   **Verbindung testen**. Der Test meldet z. B. «Verbindung hergestellt», ein ungültiges Token oder «Update
   nötig», wenn lagra die Endpunkte für SlateDesk noch nicht kennt.
2. **Vorschau** – Übersicht (Server, Aufgaben, Virenscanner, DAM, NAS) und Hintergrundaufgaben. So sieht man,
   was die Widgets anzeigen.

**planbar** – ein API-Schlüssel gehört in planbar zu genau einem Unternehmen, deshalb gibt es pro Unternehmen
einen Eintrag:

1. **Verbindung** – «planbar verwenden» einschalten und die Adresse (leer = Standardadresse) eintragen; sie
   gilt für alle Unternehmen. Eine neue Adresse löscht die Schlüssel **aller** Unternehmen – zuerst die
   Adresse, dann die Schlüssel.
2. **Unternehmen** – mit **Unternehmen hinzufügen** eine Karte pro Unternehmen anlegen: Name (z. B. «wireon»)
   und API-Schlüssel. Der Schlüssel erscheint danach nur als «gesetzt»; ein neuer Wert ersetzt ihn, das ×
   entfernt ihn. **Verbindung testen** prüft genau dieses Unternehmen und zeigt die Anzahl Personen, die Rechte
   des Schlüssels oder «planbar-Update nötig». **Entfernen** (mit Rückfrage) löscht das Unternehmen samt
   Schlüssel.
3. **Vorschau** – ein Unternehmen oder «Alle Unternehmen» und eine Person wählen: ihre Arbeitsliste über alle
   gewählten Unternehmen (mit Unternehmen-Etikett) und die neusten News. Antwortet ein Unternehmen nicht,
   steht das als Hinweis dabei, die Daten der anderen bleiben sichtbar.

In den Einstellungen der planbar-Widgets kommt zuerst die Auswahl **Unternehmen** (leer = alle
eingerichteten); die Personen- und Projektlisten darunter zeigen dann die Personen und Projekte der gewählten
Unternehmen.

Token und Schlüssel bleiben auf dem Kiosk; die Vorschau holt die Daten über den Kiosk. Wie Token und
Schlüssel erstellt werden: [API_SETUP.md](../API_SETUP.md).

## Kiosk

- **Allgemein** – *Name* (erscheint in der Fernsteuerung und beim Identifizieren), *Obere Leiste anzeigen*,
  *Bearbeiten am Kiosk erlauben* (aus: Layout und Widgets nur noch über die Fernsteuerung), *Bearbeiten
  automatisch beenden nach* (Minuten ohne Eingabe, 0 = nie), *Mauszeiger ausblenden nach* (Sekunden,
  0 = nie).
- **Bildschirmzeiten** – Bildschirm nach Zeitplan ein- und ausschalten: Einschalt- und Ausschaltzeit, Tage.
  Eine Zusammenfassung zeigt, wann er an ist (auch über Mitternacht). Ausserhalb der Zeiten weckt eine
  Berührung den Bildschirm für 5 Minuten.
- **Design** – Modus Dunkel/Hell, Akzentfarbe aus Vorlagen oder frei wählbar, «Standardfarbe» setzt sie zurück.
- **Raster** – *Spalten* (6–24; beim Ändern werden alle Widgets proportional angepasst), *Zeilen auf
  Bildschirmhöhe einpassen* (0 = aus, sonst füllt genau diese Anzahl Zeilen den Bildschirm) oder feste
  *Zeilenhöhe* (40–200 px). Darunter steht, wie viele Zeilen auf den Bildschirm des Kiosks passen.

## System

- **Gerät** – Version (mit Commit), IP-Adressen, Adressen der Fernsteuerung, Sitzung, Bildschirm, Prozessor,
  Temperatur, Laufzeit, Arbeitsspeicher und Speicherplatz.
- **Update** – *Nach Updates suchen* vergleicht mit dem Stand auf GitHub. Ist ein Update da, startet
  *Installieren* es nach Rückfrage. Der Fortschritt läuft live mit (Laden, Bauen, Installieren, Neustart,
  Prüfung). Der Kiosk zeigt bis zum Neustart normal weiter an; danach ist eine neue Anmeldung nötig.
  Startet die neue Version nicht, kehrt der Kiosk von selbst zur vorherigen zurück und meldet
  «Update fehlgeschlagen». Das Ergebnis des letzten Laufs (auch des nächtlichen) steht ebenfalls hier.
- **Aktionen** – Neu laden, Identifizieren, Bildschirm aus/an und **App neu starten** (der Bildschirm ist
  einige Sekunden leer, alle Anmeldungen enden).
- **PIN ändern** – aktueller PIN, neuer PIN (6–12 Ziffern), Wiederholung. Andere angemeldete Browser werden
  dabei abgemeldet, der eigene bleibt angemeldet. Falsche Eingaben des aktuellen PINs zählen wie
  Fehlversuche bei der Anmeldung.
- **Sicherung**
  - *Sicherung herunterladen* speichert `slatedesk-state.json`: Layout, Widget-Einstellungen, Inhalte,
    Kiosk-Einstellungen, Design, lagra und planbar. Zugangsdaten stehen darin nur als «gesetzt» –
    ICS-Links und andere Adressen dagegen im Klartext.
  - *Sicherung wiederherstellen* zeigt zuerst, was die Datei enthält, und ersetzt dann den **gesamten**
    Zustand. Auf demselben Kiosk bleiben gespeicherte Zugangsdaten erhalten; auf einem neuen Gerät müssen
    sie neu eingegeben werden.
- **Sitzung** – meldet diesen Browser ab.

## Sicherheit

- Die Fernsteuerung ist für das **vertrauenswürdige Büro-LAN** gedacht. Die Verbindung ist unverschlüsseltes
  HTTP: im Gäste-WLAN oder unterwegs nicht verwenden, im Router **kein Port-Forwarding** einrichten, von
  ausserhalb nur über VPN.
- Wer den PIN kennt, kann alles ändern, was die Fernsteuerung kann – auch die App neu starten, ein Update
  auslösen oder die Sicherung überschreiben. PIN nicht weitergeben und bei Verdacht unter **System** ändern.
- Auf geteilten Geräten nach Gebrauch **Abmelden** (System → Sitzung bzw. Mehr → Sitzung).
- Zugangsdaten sind über die Fernsteuerung nicht auslesbar; eine geänderte Adresse löscht das zugehörige
  Geheimnis.
- Der Administrator kann den Port per Firewall auf das Büro-Subnetz beschränken oder die Fernsteuerung ganz
  abschalten – siehe [BETRIEB.md](BETRIEB.md#fernsteuerung).

## Probleme

| Problem | Abhilfe |
|---|---|
| Seite lädt nicht | Gleiches Netzwerk wie der Kiosk? Adresse und Port 7380 prüfen; der Kiosk muss laufen. Am Kiosk prüft der Administrator `curl http://127.0.0.1:7380/api/health` und die Firewall (BETRIEB.md, Fehlersuche). |
| «Falscher PIN» | PIN am Kiosk unter Bearbeiten → Fernsteuerung nachsehen. |
| «Zu viele Versuche» | Warten, bis der Zähler abgelaufen ist (höchstens 5 Minuten). |
| «Sitzung abgelaufen» | Die App wurde neu gestartet (nachts, Update) oder der PIN geändert – neu anmelden. |
| Anzeige «Offline» | Kiosk ausgeschaltet, startet gerade neu oder Netzwerk getrennt; die Seite verbindet sich von selbst wieder. |
| Änderung erscheint nicht am Kiosk | Verbindungsstatus oben prüfen; unter Übersicht «Neu laden» antippen. |
| Widget zeigt «… ist nicht eingerichtet» | Verbindung auf der Seite lagra bzw. planbar einrichten. |
