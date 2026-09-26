# Vorschläge - und was daraus wurde

Stand 25.09.2026. Diese Datei sammelt, was in einer langen Arbeitssitzung
gemacht wurde (Modelle nach glTF, Landschaft, Leistung) und welche
Vorschläge dabei aufkamen - erledigt, offen oder verworfen. Die übrigen
offenen Punkte des Projekts stehen in docs/OFFEN.md.

Übersicht:

| Thema | Stand |
|---|---|
| Modelle als `.glb` statt `.blend` + OBJ | erledigt, in `main` |
| Clip-Bibliotheken ohne `.blend`, kein Python mehr | erledigt, in `main` |
| Jeder Wald trägt Holz | erledigt, Branch |
| Beeren in dichten Gruppen, halb so viele | erledigt, Branch |
| Flachland weniger wellig | erledigt, Branch |
| Feste Puffer für Bäume, Felsen, Sträucher | erledigt, Branch |
| Bäume als Bild (Billboards), im Menü unter Grafik | erledigt, Branch |
| Tiere weit draußen ausblenden, je Art einstellbar | erledigt, Branch |
| Fünf Zoomstufen (Zoom 1-5), angezeigt an der Minimap | erledigt, Branch |
| Geringere Pixeldichte beim Herauszoomen | verworfen (zu pixelig) |
| Baumenü im Stil der Minimap | verworfen |
| Weit draußen Wald nur vom Boden malen | offen - der nächste Schritt |
| Herauszoomen begrenzen, Nebel | offen |
| Waldrand zwischen Shader und Logik angleichen | offen |
| Beeren-Gruppen natürlicher verteilen | offen |
| Berghänge ruhiger | offen |
| Clips über Blender bearbeiten (Export-Einstellungen) | offen |

„Branch“ heißt: `feat/landscape-reshape`, Worktree unter `.agents/landscape`,
noch nicht gepusht und nicht in `main`.

---

# Was wir gemacht haben

## 1. Modelle als glTF (`.glb`) - in `main`

**Ausgangslage:** Jedes Modell war eine `.blend`-Datei unter
`assets/blender/models/`. `npm run gen:models` startete Blender im
Hintergrund und exportierte mit Python-Skripten (`blend_to_obj.py`) OBJ und
MTL nach `src/models/`, die das Spiel las. Nur Blender kann `.blend` lesen -
das Format ist nicht dokumentiert und ändert sich mit jeder Version.

**Der Umweg:** Zuerst wurde `src/models/` aus Git genommen und ein
`prebuild` eingerichtet, der die Modelle vor jedem Build aus Blender neu
erzeugt (`e16189f`, `22c0a4e`). Vercel hat aber kein Blender - der Deploy
schlug fehl. Das war der Anlass für die glTF-Lösung.

**Die Lösung (`2f107fc`):** Jedes Modell ist jetzt `src/models/<name>.glb`
und eingecheckt. glTF ist ein offener Standard; Blender öffnet und
speichert ihn ohne Zusatz (Datei → Import / Export → glTF 2.0).

- `tools/models/glb.mjs` liest und schreibt `.glb` ohne Bibliothek:
  `glbToObj()` macht daraus OBJ- und MTL-Text, `objToGlb()` den Weg zurück.
- Ein Vite-Plugin (`vite.config.ts`) wandelt beim Bauen:
  `import house from '../models/house.glb?model'` liefert `{ obj, mtl }`.
  So arbeiten Spiel, Felder und Symbole unverändert mit OBJ-Text weiter,
  und zur Laufzeit kostet es nichts.
- **Namen:** Blender duldet keine doppelten Objektnamen und nummeriert sie
  beim Import um - das Spiel braucht aber doppelte (viele `Window.Bar`,
  `Berry.100`). Darum heißt ab dem zweiten gleichen Namen ein Objekt
  `Name#2`, `#3` ...; das Spiel liest bis zum `#`. Eine Kopie in Blender
  (`Window.Bar.001`) zählt als das Original. Ersetzt die frühere Custom
  Property `obj_name`.
- **Farben:** `baseColorFactor` ist genau der frühere Kd-Wert. Achsen: glTF
  und OBJ haben beide Y oben.
- **Geprüft:** Alle 59 Modelle kamen Dreieck für Dreieck, Name für Name und
  Farbe für Farbe gleich heraus. 8 davon gingen zur Probe durch Blender
  (Import und Export mit den Vorgaben) - ebenfalls ohne Unterschied.
- Entfallen: die 59 `.blend`-Modelle, `gen:models`, `prebuild` und die
  Python-Skripte für die Modelle. Vercel baut seitdem wieder.

## 2. Clip-Bibliotheken ohne `.blend`, kein Python - in `main` (`58793b5`)

Die Bewegungen lagen als `.blend` in `assets/blender/clips/` und wurden mit
`npm run gen:anim` (Blender + Python) nach `src/models/*_clips.glb` + `.json`
exportiert. Auf Wunsch entfernt: die vier `.blend`-Dateien, `gen:anim` und
alle Python-Skripte. Seitdem enthält das Projekt kein Python mehr.

- Die `*_clips.glb` sind jetzt selbst die Quelle; die Angaben je Clip
  (`props`, `pose`, `strike`, `species` ...) stehen von Hand gepflegt in
  `*_clips.json`. Die eingecheckten Clips blieben unverändert
  (`check:anim` weiter 0,01 cm).
- **Bekannte Grenze:** Ein Clip, der mit den vorgegebenen Einstellungen
  durch Blender geht, verändert sich - Blender rechnet die Bilder neu ab.
  Probe: Hände beim Hacken bis 7 cm daneben (vorher 0,5 cm), Tiere bis
  0,9 cm. Siehe „Clips über Blender bearbeiten“ unten.
- Verloren sind die IK-Ziele der Hände aus der früheren `humanoid.blend` -
  ihr Ergebnis steckt in den gebackenen Clips. Die Dateien liegen in der
  Git-Geschichte.

## 3. Jeder Wald trägt Holz - Branch (`a7452f2`)

**Problem:** Bäume wuchsen nur, wo ein zweites Rauschen (das
Ressourcen-Rauschen) über 0,15 lag. Die Hälfte des Waldes blieb leer: Auf
der Welt `Soliva` trugen um den Start nur 4416 von 8679 Wald-Tiles Bäume.

**Lösung:** In `RESOURCE_RULES` (`src/map.ts`) hat Holz keine Schwelle mehr
(`threshold: -Infinity`) - jedes Wald-Tile trägt einen Baum, 8679 von 8679.
Die Menge je Tile bleibt im bisherigen Bereich: Wo das Rauschen unter 0
liegt, zählt es wie 0, also mindestens 50 Holz. Ohne diese Untergrenze
stünden Bäume mit fast nichts darin.

## 4. Beeren in dichten Gruppen - Branch (`de40b37`, `d3a3c40`)

**Problem:** Beeren lagen, wo ein Häufchen-Rauschen über 0,7 lag - das
ergab gebogene Streifen und lockere Flecken bis 13 x 13 Tiles mit einem
Drittel Sträuchern, und zunächst nur in einer Gegend der Wiese.

**Lösung in drei Schritten:**
1. Die Gegend-Schwelle fiel weg - Beeren auf der ganzen Wiese.
2. Statt Rauschen: runde Gruppen wie in AoE2 (`clump` in `RESOURCE_RULES`).
   Die Welt ist in Zellen von 12 x 12 Tiles geteilt; in manchen Zellen
   liegt eine Gruppe mit Radius 1,5 - meist 7-9 Sträucher auf 3 x 3 Tiles,
   ganz innerhalb der Zelle, damit zwischen den Gruppen Wege frei bleiben.
   Im Bild rückt jeder Strauch ein Stück zur Mitte seiner Gruppe
   (`towardGroup()` in `world/resources.ts`) und ist etwas größer
   (0,55 statt 0,45 Tiles) - die Gruppe wirkt wie ein Gebüsch.
3. Halb so viele Gruppen: `chance` 0,6 → 0,3. Um den Start von `Soliva`
   sind es 82 Gruppen.

## 5. Flachland weniger wellig - Branch (`701eb2a`)

**Problem:** Die Wiesen wirkten hügelig, mit dunklen Wellen.

**Lösung - nur an der Darstellung**, Küsten, Biome und Ressourcen bleiben
gleich (die Höhe selbst bestimmt, wo Wasser, Wiese und Wald liegen):
- `LOWLAND_RELIEF` 4 → 2 (`src/noise.ts`): Das Flachland steigt von der
  Küste bis zum Gebirgsfuß nur noch 2 Tiles, seine Buckel sind halb so hoch.
- `LOWLAND_SHADE` 0,35: Die Hangschattierung verstärkt jede Neigung 52-fach
  - das waren die dunklen Wellen. Unter dem Gebirgsfuß wirkt sie nur noch
  zu gut einem Drittel und wächst zum Fuß hin auf die volle Stärke
  (`terrainShader.ts`). Berge sehen aus wie bisher.

Zur Probe wurde die Dämpfung bis ins Gebirge ausgeweitet - das änderte an
den Berghängen kaum etwas (dort sind es echte Grate) und wurde
zurückgenommen.

## 6. Feste Puffer für Bäume, Felsen und Sträucher - Branch (`2b9473a`)

**Problem:** Beim Herauszoomen fielen die FPS. Jedes Bild ging jeden
sichtbaren Baum durch, schrieb ihn neu in die Instanzliste und lud sie
komplett auf die Grafikkarte - weit draußen Zehntausende. Dazu suchte der
Renderer für jede Instanz ihr Modell unter rund 60 per `find()`.

**Lösung:**
- Vorkommen, an denen niemand arbeitet, liegen je Region (4 x 4 Stücke =
  64 x 64 Tiles) in einem festen Puffer auf der Grafikkarte
  (`createBatch()` in `gl/entityRenderer.ts`), einmal gepackt und
  hochgeladen, danach nur gezeichnet - je Modell ein Aufruf je Region.
- Bild für Bild laufen nur noch angefasste Tiles (angebaut, gefällt,
  gepflückt) und das ausgewählte Vorkommen über den bisherigen Weg.
- Neu gebaut wird eine Region, wenn dort ein Tile angefasst oder wieder
  ganz frei wird (`Deposits.revision` zählt dann hoch) oder die Auswahl
  wechselt - sofort, sonst stünde ein Baum doppelt da. Kommen beim Scrollen
  neue Stücke dazu, wird höchstens 3 ms je Bild nachgebaut.
- Das Modell je Instanz kommt aus einer Tabelle (`modelByShape`).
- **Geprüft:** Startansicht Pixel für Pixel gleich; Tests, Build und
  Rauchtest (mit Demo, Speichern, Laden) laufen.
- **Nicht gemessen:** der FPS-Gewinn - der Test-Browser rendert per
  Software. Messen: `npm run dev` im Worktree, ganz herauszoomen, FPS im
  Entwickler-Panel oben links mit `main` vergleichen.

## 7. Bäume als Bild (Billboards) - Branch

**Problem:** Auch mit festen Puffern zeichnet die Grafikkarte weit draußen
jeden Baum als 3D-Modell mit Dutzenden Dreiecken - bei Zehntausenden
Bäumen die größte Last.

**Lösung:** Ein Billboard ist ein flaches Bild aus zwei Dreiecken, das zur
Kamera zeigt.
- Die Ansicht des Spiels ist parallel (ohne Perspektive) - ein Baum sieht
  überall auf dem Bildschirm gleich aus. Darum genügt je Baumart ein Bild,
  exakt so, wie das Modell gezeichnet würde.
- `EntityRenderer.ensureBillboards` rendert jede der 10 Baumarten in
  8 Drehungen direkt in eine Textur des Spiels (unsichtbarer Framebuffer mit
  Kantenglättung) - erst, wenn eine Zoomstufe die Bilder braucht, nichts im
  Voraus. Die Größe jedes Bilds wird vorher aus den Eckpunkten des Modells
  berechnet; kein Kopieren über den Arbeitsspeicher. Früher entstanden die
  Bilder auf der Bühne der Symbole und wurden per readPixels kopiert - langsam.
  Neu gerendert wird nach einem Drehen der Karte, beim Wechsel der Zoomstufe
  und einmal, sobald das Blattfoto geladen ist. Wäre die Textur zu groß für
  die Grafikkarte (Zoom 5 auf Retina), zeichnet das Spiel Modelle.
- Im Shader (`uBillboard` in `gl/entityRenderer.ts`) steht das Rechteck am
  Fuß des Baums, nach seiner Größe skaliert; die Tiefe wächst mit der Höhe
  wie beim Modell, Hügel verdecken es richtig. Die Drehung des Baums wählt
  das nächste der 4 Bilder.
- **Je Zoomstufe eigene Bilder**, in genau der Pixelgröße, in der ein Baum
  mittlerer Größe dort steht (mit der Pixeldichte des Bildschirms), und mit
  der vereinfachten Fassung, die das Modell dort zeigt. Zuerst gab es nur
  ein großes Bild, das die Grafikkarte verkleinerte: Das war dichter als die
  vereinfachten Modelle, und feine Birkenblätter wurden zu Rauschen. Ragt
  ein Baum über die Bühne, wird sie größer statt die Auflösung kleiner.
  Gemerkt werden die Bilder je Blickrichtung und Zoomstufe.
- Die Bilder sind vormultipliziert abgelegt; halb deckende Ränder und dünne
  Stämme werden weich eingeblendet wie beim Modell.
- **Größter Baum, 8 Drehungen:** Gerendert wird der größte Baum (0,72);
  kleinere werden nur verkleinert, der Shader bleibt bei der scharfen
  Mipmap-Stufe. Je Baumart 8 Drehungen - ein Bild liegt höchstens 22,5°
  neben dem Baum (mit 4 waren es 45°, bei Zoom 5 deutlich zu sehen).
- **Nur bis Zoom 3:** Auf Retina wäre das Bild bei Zoom 4 67 MB groß, bei
  Zoom 5 262 MB (2048 × 31 988 Pixel) - größer als die Grafikkarte eine
  Textur nimmt. Das Hochladen schlug fehl, und das Spiel zeigte die Bilder
  einer kleineren Stufe hochskaliert: unscharfe Bäume bei Zoom 5. Jetzt
  bietet das Menü Aus, 1, 2, 3 (`BILLBOARD_MAX`), und ein zu großes Bild
  wird nie hochgeladen - dann zeichnet das Spiel Modelle.
- Als Bild gezeichnet werden nur die Bäume der festen Puffer; gefällte,
  angefangene und ausgewählte Bäume bleiben Modelle.
- **Einstellbar** im Menü unter **Grafik → Bäume als Bild**:
  *Nie*, *Weit* (Vorgabe: unter 16 CSS-Pixeln je Tile, also ab zwei
  Zoomstufen unter der Standardansicht - dort sind Bäume nur wenige Pixel
  groß), *Mittel* (sobald man herauszoomt), *Immer* (auch in der
  Standardansicht).
- **Geprüft:** Gleiche Ansicht, im Spiel umgeschaltet: bei Zoom 2 kein
  Unterschied, bei Zoom 1 sind nur Birken etwas weicher (ein Bild liegt nie
  genau auf dem Pixelraster - Bäume streuen in der Größe um ±20 %).
  Drehen der Karte ohne Fehler; Tests, Build, Rauchtest.

## 8. Tiere weit draußen ausblenden - Branch

Weit draußen sind Tiere nur noch Punkte, kosten aber je Tier ein
animiertes Modell. Jetzt werden sie ab 8 px je Tile nicht mehr gezeichnet -
sie leben, grasen und fliehen trotzdem weiter.

- **Je Tierart einstellbar** im Menü unter **Grafik → Tiere ausblenden**
  (aufklappbar): Reh, Hase, Kuh, Schaf, Ziege, Wildschwein - je *Nie*,
  *Weit* (Vorgabe, ab 8 px je Tile) oder *Mittel* (sobald man herauszoomt).
- Gespeichert in `settings.animalsBelow` je Art; fehlt eine, gilt die
  Vorgabe (`ANIMALS_BELOW_DEFAULT`).
- `worldInstances()` (`world/render.ts`) überspringt die ausgeblendeten
  Arten; die Minimap zeigt weiter alle.
- Neben den FPS zeigen die Entwickler-Infos (Taste P), ob Bäume gerade als
  Bild gezeichnet werden: „Bäume Bild“ bzw. „Bäume 3D“.

## 9. Fünf Zoomstufen, angezeigt an der Minimap - Branch

Die Zoomstufen sind jetzt 8, 16, 32, 64 und 128 CSS-Pixel je Tile - im Spiel
**Zoom 1** (weit draußen) bis **Zoom 5** (ganz nah), Standard ist Zoom 3.
Die drei weitesten Stufen (1, 2, 4 px) sind weggefallen; dort war ohnehin
fast nichts mehr zu erkennen, und sie kosteten am meisten.

- Unter der Minimap steht mittig die jetzige Stufe („Zoom 3“), in den
  Entwickler-Infos „3 (32px)“ (`ZOOM_LEVELS` in `game/Camera.ts`).
- Die Tooltips unter Grafik nennen die Stufen: Bäume als Bild *Weit* = Zoom 1,
  *Mittel* = Zoom 1-2, *Immer* = Zoom 1-3; Tiere ausblenden *Weit* = Zoom 1,
  *Mittel* = Zoom 1-2.

## Verworfen

### Geringere Pixeldichte beim Herauszoomen (`2b9473a`, zurück in `da58935`)

Ab 16 px je Tile wurde das Spielfeld mit höchstens einem Pixel je
CSS-Pixel gerendert, ab 8 px mit 0,75, und der Browser skalierte hoch - der
Gelände-Shader rechnet je Pixel, auf Retina-Bildschirmen wären das ein
Viertel bis ein Siebtel der Pixel gewesen. Ergebnis: zu pixelig, wieder
entfernt.

### Baumenü im Stil der Minimap

Die Steintafel des Baumenüs in Anthrazit mit Bronze- und Goldkanten wie die
neue AoE4-Minimap. Auf Wunsch vor dem Commit rückgängig gemacht.

---

# Offene Vorschläge

## Herauszoomen: weit draußen den Wald nur vom Boden malen

**Das bringt am meisten, bei wenig Aufwand - der nächste Schritt.**

Der Gelände-Shader hat schon einen eigenen Waldboden mit gemalten Kronen
und Schatten (`forestTexture()` und `forestProp()` in `terrainShader.ts`).
Weit draußen ist ein Baum nur wenige Pixel groß; die 3D-Modelle kosten
dann viel und zeigen kaum mehr als der gemalte Wald.

**Umsetzung:**
- Unterhalb einer Zoomstufe (etwa 8-12 CSS-Pixel je Tile) die Baum-Modelle
  nicht mehr zeichnen - in `ResourceField.instances()` bzw. beim Zeichnen
  der festen Puffer die Baum-Formen überspringen. Felsen und Sträucher
  bleiben (es sind wenige).
- Im Gelände-Shader den gemalten Wald dort voll einblenden, im Übergang
  weich überblenden (zwei Zoomstufen), damit nichts aufpoppt.
- Gefällte oder angefangene Bäume nah am Dorf eventuell weiter als Modell
  zeigen.

**Vorteil:** Die teuerste Last - Zehntausende Baum-Modelle - fällt weit
draußen ganz weg. So machen es viele Strategiespiele.
**Nachteil:** Der Wald sieht aus der Ferne etwas flacher aus; einzelne
Bäume am Waldrand verschwinden.
**Aufwand:** klein.

## Herauszoomen: Billboards weiter ausbauen

Die Billboards (oben, Punkt 7) gelten bisher nur für Bäume. Möglich wären:
- **Sträucher und Felsen** ebenso als Bild - es sind aber wenige, der
  Gewinn ist klein.
- **Mehr als 4 Drehungen** je Baumart, falls man aus der Nähe (*Immer*)
  sieht, dass sich Bäume wiederholen.
- **Wind:** Die 3D-Bäume wiegen sich, die Bilder stehen still - weit draußen
  nicht zu sehen, bei *Immer* vielleicht schon.

## Herauszoomen: begrenzen oder Nebel am Rand

- Die weiteste Zoomstufe (1 CSS-Pixel je Tile) weglassen oder erst später
  freigeben (`ZOOM_LEVELS` in `game/Camera.ts`).
- Oder wie in AoE: am Bildrand Nebel bzw. Wolken, sodass die sichtbare
  Fläche begrenzt bleibt.

**Vorteil:** sofort weniger Last, fast kein Code.
**Nachteil:** Es ändert, wie das Spiel sich anfühlt - man sieht weniger von
der Welt.
**Aufwand:** sehr klein.

## Herauszoomen: nur das Gelände in geringerer Auflösung

Die verworfene Idee, feiner: Nur der Gelände-Shader rechnet weit draußen
mit weniger Pixeln, Bäume, Gebäude und Figuren bleiben scharf.

**Umsetzung:** Das Gelände in einen eigenen Framebuffer (halbe Auflösung,
mit Tiefenpuffer) rendern, hochskaliert auf das Bild legen, die Tiefe für
die Objekte übernehmen.
**Vorteil:** Der teure Shader rechnet weniger, die Objekte bleiben scharf.
**Nachteil:** Die Tiefe zwischen den Auflösungen zu übertragen ist
fehleranfällig (Kanten an Hängen); das Gelände wird trotzdem weicher.
**Aufwand:** mittel bis groß - erst nach dem gemalten Wald prüfen.

## Waldrand zwischen Shader und Logik angleichen

Der Shader blendet Waldboden schon ab Feuchte 0,02 ein
(`smoothstep(0.02, 0.18, moisture)`), die Spiel-Logik zählt ein Tile erst ab
0,1 als Wald (`classify()` in `noise.ts`). An jedem Waldrand liegt deshalb
ein schmaler Saum Waldboden ohne Bäume.

**Umsetzung:** Den Übergang im Shader enger um 0,1 legen, z. B.
`smoothstep(0.07, 0.13, ...)`, oder umgekehrt Bäume am Rand lichter setzen.
**Abwägung:** Der Saum wirkt heute wie ein natürlicher Waldrand. Nur ändern,
wenn er stört.
**Aufwand:** klein.

## Beeren-Gruppen natürlicher verteilen

Die Gruppen liegen in einem Raster aus Zellen von 12 Tiles; aus der Nähe
fällt das kaum auf, aus der Ferne wirkt die Verteilung recht gleichmäßig.

**Umsetzung:** In `clumpValue()` (`map.ts`) die Zellen versetzen (jede
zweite Zeile halb verschoben), die Mitte freier in der Zelle wählen oder die
Zellgröße je Gegend schwanken lassen. Menge und Dichte: `chance` (jetzt 0,3)
und `cell` (jetzt 12) in `RESOURCE_RULES`.
**Aufwand:** klein.

## Noch flachere Wiesen

Zwei Regler in `src/noise.ts`: `LOWLAND_RELIEF` (jetzt 2 Tiles) und
`LOWLAND_SHADE` (jetzt 0,35). Kleinere Werte machen das Flachland ebener;
bei 0 ist es ganz platt und ohne Schattierung.
**Aufwand:** sehr klein.

## Berghänge ruhiger

Die Streifen an den Hängen (z. B. in der Startansicht von `Soliva`) sind
echte Grate und Rinnen aus dem Warp- und Grat-Rauschen, keine Bodenwellen.
Glätten hieße, die Form der Berge zu ändern (`WARP_STRENGTH`,
`RIDGE_STRENGTH`, Feindetail in `elevation()`).
**Nachteil:** Das verschiebt Gelände und damit Küsten, Biome und
Ressourcen - Spielstände passen danach nicht mehr zur Welt.
**Aufwand:** klein im Code, groß in den Folgen.

## Clips über Blender bearbeiten

Seit die Clip-Bibliotheken nur noch `.glb` sind, geht Bearbeiten über
Import und Export in Blender. Mit den vorgegebenen Einstellungen verändert
das die Clips (Hände bis 7 cm, Tiere bis 0,9 cm).

**Umsetzung:** Export-Einstellungen suchen, bei denen `npm run check:anim`
gleich bleibt - Bildrate 30, Animation abtasten, keine Optimierung der
Keyframes - und in docs/ANIMATION.md festhalten. Bis dahin Clips nicht
über Blender speichern. Steht auch in docs/OFFEN.md.
**Aufwand:** klein bis mittel (ausprobieren).

## Sonst

- **Branch übernehmen:** `feat/landscape-reshape` (Wald, Beeren, flacheres
  Flachland, feste Puffer, diese Datei) ist nicht gepusht und nicht in
  `main`.
- **Rauchtest:** Seit den Gelände-Änderungen landen seine Klicks auf
  anderen Tiles - er steckt 2 statt 3 Feldstücke ab und baut 4 statt 5
  Gebäude. Er läuft weiter durch; wer feste Zahlen erwartet, passt ihn an.
- **Symbole neu zeichnen:** Die Bilder der Rohstoffleiste (`src/icons/`)
  sind älter als die jetzigen Modelle - `npm run gen:ui` (steht in
  docs/OFFEN.md).
