// Hud.tsx
// Die ganze Spielseite: das Canvas fürs Spielfeld und darüber das Grundgerüst
// der Oberfläche - Tastenhilfe, Legende und Entwickler-Infos, die Plätze für
// Rohstoffleiste, Auswahl, Hinweise und Baumenü, Minimap, Ton-Knopf, Kompass
// und das Pause-Schild. main.ts rendert es einmal vor allem anderen und findet
// die Teile dann über ihre IDs; was sich ändert, setzt es gezielt (Texte,
// hidden, Klassen) oder rendert die jeweilige Komponente hinein.

import { render, type Props } from 'defuss';
import './Hud.css';
import { TILE_TYPE_COLOR, TILE_TYPE_LABEL } from '../map';
import type { TileType } from '../noise';
import { MenuButton } from './MenuButton';
import { SaveButton } from './SaveButton';
import { ShortcutLine } from './Shortcuts';

/** Tastenhilfe oben rechts - dieselben Kürzel wie im Menü, knapp; × blendet sie aus (main.ts). */
function HelpPanel() {
  return (
    <div id="ui" class="panel">
      <button type="button" id="help-close" class="panel-close" title="Tastenhilfe ausblenden">×</button>
      <ShortcutLine />
    </div>
  );
}

/** Legende der Geländearten - nur die Farben, der Name als Tooltip. Aus der Palette, damit sie nicht aus dem Tritt gerät. */
function Legend() {
  return (
    <div id="legend">
      {(Object.keys(TILE_TYPE_LABEL) as TileType[]).map((type) => (
        <i class="legend-item" title={TILE_TYPE_LABEL[type]}
          style={`background:${TILE_TYPE_COLOR[type].toRgbString()}`} />
      ))}
    </div>
  );
}

/** Legende und Entwickler-Infos oben links - dazu Position, Abtastung und Zoom. */
function DebugPanel() {
  return (
    <div id="debug" class="panel">
      {/* Schließt das Panel - wie der Schalter im Menü (main.ts). */}
      <button type="button" id="debug-close" class="panel-close" title="Entwickler-Infos ausblenden">×</button>
      <div>
        Pos <b id="pos">0, 0</b><span class="sep">|</span>
        Tiles/Px <b id="sampling">-</b><span class="sep">|</span>
        Zoom <b id="zoom">8px</b>
      </div>
      <Legend />
      <div>Tile <b id="tile-info">-</b></div>
      {/* "Gebäude" oder "Ressource" - je nachdem, was unter dem Zeiger steht (main.ts). */}
      <div><span id="object-label">Ressource</span> <b id="resource-info">-</b></div>
      <div>
        Cursor <b id="cursor-coords">-, -</b><span class="sep">|</span>
        Kamera <b id="cam-coords">-, -</b><span class="sep">|</span>
        MiniMap <b id="hover-coords">-, -</b>
      </div>
      <div>
        FPS <b id="fps">0</b><span class="sep">|</span>
        Minimap <b id="minimap-fps">0</b><span class="sep">|</span>
        {/* Bild = Billboards (Menü → Grafik → Bäume als Bild), 3D = Modelle. */}
        Bäume <b id="billboards">3D</b>
      </div>
    </div>
  );
}

/** Ton an/aus - das Lautsprecher-Symbol, durchgestrichen, wenn aus (Klasse muted). */
function SoundButton() {
  return (
    <button id="sound" type="button">
      <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"
        stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 8h3l4-3.5v11L6 12H3z" fill="currentColor" stroke="none" />
        <path class="on" d="M13 7.5a3.5 3.5 0 0 1 0 5M15.5 5a7 7 0 0 1 0 10" />
        <path class="off" d="M13.5 7.5l4 5M17.5 7.5l-4 5" />
      </svg>
    </button>
  );
}

/**
 * Eine Spitze der Windrose: zeigt von der Mitte nach außen, halb dunkel, halb
 * hell, hinten eingekerbt. Oben und unten liegt die dunkle Hälfte links bzw.
 * rechts, seitlich unten bzw. oben - wie auf einer gezeichneten Karte.
 */
function RoseArrow({ angle }: { angle: number }) {
  const mirror = angle % 180 === 0 ? 1 : -1;
  // Maße ab der Mitte: Spitze außen, Fuß auf dem Ring, Kerbe dazwischen.
  const tip = 145, base = 119, notch = 124, half = 10;
  return (
    <g transform={`translate(166 166) rotate(${angle}) scale(${mirror} 1)`}>
      <polygon class="rose-dark" points={`0,${-tip} ${-half},${-base} 0,${-notch}`} />
      <polygon class="rose-light" points={`0,${-tip} 0,${-notch} ${half},${-base}`} />
    </g>
  );
}

/**
 * Windrose auf dem Ring um die Minimap: vier Spitzen, die immer nach oben,
 * rechts, unten und links zeigen, und davor die Himmelsrichtungen - main.ts
 * stellt die Buchstaben je nach Blickrichtung (game/Compass.ts). Ein Klick
 * auf einen Buchstaben dreht die Richtung nach oben.
 */
function Compass() {
  return (
    <div id="compass" title="Blickrichtung - klicke auf eine Himmelsrichtung">
      <svg class="rose" viewBox="0 0 332 332" width="332" height="332">
        {[0, 90, 180, 270].map((angle) => <RoseArrow angle={angle} />)}
      </svg>
      <button type="button" data-dir="N">N</button>
      <button type="button" data-dir="E">O</button>
      <button type="button" data-dir="S">S</button>
      <button type="button" data-dir="W">W</button>
    </div>
  );
}

/**
 * Platz für einen Knopf außen am Reif - `deg` im Uhrzeigersinn ab rechts,
 * die Mitte des Knopfs liegt dort (Hud.css, .ring-slot).
 */
function RingSlot({ deg, id, children }: Props & { deg: number; id?: string }) {
  const a = (deg * Math.PI) / 180;
  const r = 143;
  return (
    <div class="ring-slot" id={id} style={`left:${166 + Math.cos(a) * r}px;top:${166 + Math.sin(a) * r}px`}>
      {children}
    </div>
  );
}

/** Pfeil im Halbkreis - `flip` spiegelt ihn für die Drehung im Uhrzeigersinn. */
function TurnIcon({ flip }: { flip?: boolean }) {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2"
      stroke-linecap="round" stroke-linejoin="round" style={flip ? 'transform:scaleX(-1)' : ''}>
      <path d="M15 16V10a5 5 0 0 0-5-5H5" />
      <path d="M8 2 5 5l3 3" />
    </svg>
  );
}

/**
 * Minimap wie in AoE4, ohne Kasten: die runde Karte in einem Holzreif mit
 * Nägeln, drumherum die Windrose - frei über dem Spielfeld. Außen am Reif
 * hängen kleine runde Holzknöpfe auf den Diagonalen: oben Speichern und Menü
 * (mountMinimapMenu), unten links der Ton, unten rechts das Drehen.
 */
function Minimap() {
  // Maße wie in Hud.css: Rahmen 332 px, Karte 244 px, Mitte bei 166. Außen
  // um den Ring bleibt Platz für die Windrose.
  const c = 166;
  const ring = 127;
  // Nägel im Ring, zwischen den Himmelsrichtungen - wie auf den Planken oben.
  const nails = [22.5, 67.5, 112.5, 157.5, 202.5, 247.5, 292.5, 337.5].map((deg) => {
    const a = (deg * Math.PI) / 180;
    return { x: c + Math.cos(a) * ring, y: c + Math.sin(a) * ring };
  });
  return (
    <div id="minimap-frame">
      <svg class="minimap-ring" viewBox="0 0 332 332" width="332" height="332">
        <defs>
          <radialGradient id="minimap-disc" cx="50%" cy="45%" r="55%">
            <stop offset="0" stop-color="#3e2614" />
            <stop offset="1" stop-color="#1c1009" />
          </radialGradient>
          <radialGradient id="minimap-nail" cx="40%" cy="35%" r="65%">
            <stop offset="0" stop-color="#b9b2a4" />
            <stop offset="0.6" stop-color="#5d574c" />
            <stop offset="1" stop-color="#2a2620" />
          </radialGradient>
        </defs>
        {/* Eingelassene Scheibe: dunkles Holz, außen ein Reif aus Kantholz. */}
        <circle cx={c} cy={c} r={ring + 3} class="disc" />
        <circle cx={c} cy={c} r={ring} class="ring-wood" />
        <circle cx={c} cy={c} r={ring - 4.5} class="ring-light" />
        <circle cx={c} cy={c} r={ring + 5} class="ring-light" />
        {nails.map((n) => <circle cx={n.x} cy={n.y} r="3" class="nail" />)}
      </svg>
      {/* Die Karte dreht sich beim Drehen der Ansicht (game/TurnAnimation.ts). */}
      <div class="minimap-spin">
        <canvas id="minimap" />
      </div>
      {/* Schatten des Reifs auf der Karte - sie liegt eingelassen darunter. */}
      <div class="minimap-shade" />
      <Compass />
      <RingSlot deg={225} id="minimap-save" />
      <RingSlot deg={315} id="minimap-menu" />
      <RingSlot deg={135}><SoundButton /></RingSlot>
      <RingSlot deg={112}>
        <div id="zoom-level" class="minimap-zoom" title="Zoomstufe - Mausrad oder Q / E">Zoom 3</div>
      </RingSlot>
      <RingSlot deg={55}>
        <button type="button" id="turn-left" title="Ansicht gegen den Uhrzeigersinn drehen"><TurnIcon /></button>
      </RingSlot>
      <RingSlot deg={35}>
        <button type="button" id="turn-right" title="Ansicht im Uhrzeigersinn drehen"><TurnIcon flip /></button>
      </RingSlot>
    </div>
  );
}

function Hud() {
  return (
    <>
      <HelpPanel />
      <DebugPanel />
      <div id="stock" />

      <div id="select-box" hidden />
      <div id="hint" />
      {/* Befehlsleiste wie in AoE2: Steintafel mit Baumenü oder Befehlen, Pergament mit der Auswahl. */}
      <div id="command-bar">
        <div class="cmd-stone">
          <div id="build" class="cmd-grid" />
          <div id="actions" class="cmd-grid" hidden />
        </div>
        <div id="selection" />
      </div>
      <Minimap />
      <div id="paused" hidden>Pause</div>
    </>
  );
}

/** Speichern und Menü oben links und rechts am Reif der Minimap - game/ui.ts kennt die Aktionen. */
export function mountMinimapMenu(onSave: () => void, onMenu: () => void) {
  render(<SaveButton onClick={onSave} />, document.getElementById('minimap-save')!);
  render(<MenuButton onClick={onMenu} />, document.getElementById('minimap-menu')!);
}

/** Rendert Spielfeld-Canvas und Grundgerüst in `root` - einmal, bevor main.ts seine Teile sucht. */
export function mountGame(root: HTMLElement) {
  render(
    <>
      <canvas id="game" />
      {/* Das letzte Bild vor dem Drehen, für den Übergang (game/TurnAnimation.ts). */}
      <canvas id="turn-snapshot" hidden />
      <Hud />
    </>,
    root,
  );
}
