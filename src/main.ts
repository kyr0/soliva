
import { MapGenerator } from './noise';
import {
  TILT_DEFAULT,
  TILT_MAX,
  TILT_MIN,
  centerFor,
  pickWorld,
  setViewElevation,
  type IsoView,
  viewElevation,
  viewRotation,
  viewZScreen,
  visibleWorldRect,
  worldToGround,
} from './gl/iso';
import {
  MapRenderer,
  MiniMap,
  Terrain,
} from './map';
import type { EntityInstance, StaticBatch } from './gl/entityRenderer';
import { setAnimationSpeed, setAnimationsPaused } from './gl/entityRenderer';
import {
  player,
  PLAYER_COLORS,
} from './world/catalog';
import { World } from './world/world';
import { worldInstances } from './world/render';
import { Selection } from './game/Selection';
import { Camera } from './game/Camera';
import { GameUi } from './game/ui';
import { steerCamera } from './game/cameraControl';
import { startPoint } from './game/startPoint';
import { FixedStep, Interval } from './game/timing';
import { Pointer } from './game/Pointer';
import { DevPanel } from './game/DevPanel';
import { Keyboard } from './game/keyboard';
import { MouseInput, type CanvasPoint } from './game/MouseInput';
import { PlayerActions } from './game/actions';
import { Placement } from './game/Placement';
import { Picker, RESOURCE_OBJECTS_MIN_ZOOM } from './game/Picker';
import { hoverDescription, type HoverTarget } from './game/hoverInfo';
import { Compass, directionAt, isDirection, northAngle, rotateToFace } from './game/Compass';
import { TurnAnimation } from './game/TurnAnimation';
import { Ground } from './game/Ground';
import { worldSounds } from './game/worldSounds';
import { minimapDots, placementOverlay, selectionOverlay } from './game/overlay';
import { mountGame } from './components/Hud';
import { SettingsMenu } from './components/SettingsMenu';
import { StartScreen } from './components/StartScreen';
import { ANIMALS_BELOW_DEFAULT, loadSettings, saveSettings } from './settings';
import { ResourceField, type OnScreen } from './world/resources';
import { FlowerField } from './world/flowers';
import { Sound } from './audio';
import { Music } from './music';
import { currentSeed, deleteSave, switchWorld, takeStartRequest } from './worlds';

// Erst Spielfeld-Canvas und Oberfläche (components/Hud.tsx) - danach werden
// ihre Teile hier über ihre IDs gefunden.
mountGame(document.getElementById('app')!);

const canvas = document.getElementById('game') as HTMLCanvasElement;
const minimapCanvas = document.getElementById('minimap') as HTMLCanvasElement;
const boxEl = document.getElementById('select-box')!;
/** Entwickler-Infos oben links (game/DevPanel.ts). */
const devPanel = new DevPanel();
/** Wo der Mauszeiger auf dem Spielfeld steht (game/Pointer.ts). */
const pointer = new Pointer();

/** Zoom beim Start: CSS-Pixel je Tile. */
const DEFAULT_ZOOM = 32;
/** Kamera: Bildmitte, Zoomstufe, Sichtfläche (game/Camera.ts). */
const camera = new Camera(DEFAULT_ZOOM);

function applyCanvasSize() {
  camera.fitWindow();

  // Gezeichnet wird in echten Bildschirmpixeln, angezeigt in CSS-Pixeln.
  // Sonst rendert der Browser das Canvas klein und skaliert es hoch.
  canvas.width = Math.round(camera.width * camera.pixelRatio);
  canvas.height = Math.round(camera.height * camera.pixelRatio);
  canvas.style.width = `${camera.width}px`;
  canvas.style.height = `${camera.height}px`;
}

function resize() {
  // Die Kamera beschreibt die Bildmitte - die bleibt beim Größenwechsel stehen.
  applyCanvasSize();

  renderer.pixelRatio = camera.pixelRatio;
  minimap.setPixelRatio(camera.pixelRatio);
}

applyCanvasSize();

// Die Adresse bleibt "/": Welt und Stelle stehen nicht mehr darin. Alte Links
// (/<seed>/<x>-<y>?zoom=) werden aufgeräumt; die Welt wählt man im Hauptmenü.
if (window.location.pathname !== '/' || window.location.search) window.history.replaceState(null, '', '/');

const seed = currentSeed();
const mapGen = new MapGenerator(seed);
const terrain = new Terrain(mapGen, seed);
const world = new World(terrain, seed);

const { x: startX, y: startY } = startPoint(world, terrain, seed);
// Holzfäller arbeiten am liegenden Stamm - wie lang der ist, weiß die Darstellung.
world.treeLength = (x, y) => resources.treeLengthAt(x, y);
const resources = new ResourceField(terrain, mapGen);
/** Blumen als 3D-Objekte, nah heran (world/flowers.ts). */
const flowers = new FlowerField(terrain, mapGen);
const sound = new Sound();
/** Hintergrundmusik aus assets/music/ - der Ton-Schalter (M) gilt auch für sie. */
const music = new Music();
music.mute = !sound.enabled;


/** Aktuell zum Bauen ausgewählter Typ, oder null im Ansichtsmodus. */
/** Baumodus: welche Art gebaut wird, Felder säen, Bauplatz-Prüfung (game/Placement.ts). */
const placement = new Placement(world);

// --- Auswahl ---------------------------------------------------------------

/** Was ausgewählt ist: Dorfbewohner, Gebäude oder ein Vorkommen (game/Selection.ts). */
const selection = new Selection(world);

/** Die Oberfläche im Spiel: Leisten, Baumenü, Auswahl-Panel, Hinweise, Mauszeiger (game/ui.ts). */
const ui = new GameUi({ world, selection, placement, pointer, resources, sound, canvas }, {
  toggleMenu: () => menu.toggle(),
  save: () => world.save(),
  selectIdle: (all) => actions.selectIdle(all),
  train: (count) => actions.trainVillagers(count),
  demolish: () => actions.demolishSelected(),
  setFieldCrop: (crop) => actions.setFieldCrop(crop),
}, player.color.toRGB());

// --- Einstellungen und Menü ------------------------------------------------

const settings = loadSettings();
// Blickwinkel wie beim letzten Mal - vor dem ersten Bild.
setViewElevation(clampTilt((settings.tilt * Math.PI) / 180));
/** Angehalten (F3 oder Menü): die Welt steht, Kamera und Auswahl gehen weiter. */
let paused = false;
const pausedEl = document.getElementById('paused')!;

function applySettings() {
  sound.volume = settings.volume;
  music.volume = settings.music;
  player.color = (PLAYER_COLORS[settings.playerColor] ?? PLAYER_COLORS.green).color;
  ui.setPlayerColor(player.color.toRGB());
  // Mühlenflügel und Fahnen laufen mit der Spielgeschwindigkeit.
  setAnimationSpeed(settings.speed);
  document.getElementById('ui')!.hidden = !settings.showHelp;
  document.getElementById('debug')!.hidden = !settings.showDebug;
}

// × an Tastenhilfe und Entwickler-Infos sowie die Tasten I und P: ein- und
// ausblenden wie im Menü - und so gespeichert.
function setPanels(patch: Partial<typeof settings>) {
  Object.assign(settings, patch);
  saveSettings(settings);
  applySettings();
  menu.refresh();
}
document.getElementById('help-close')!.addEventListener('click', () => setPanels({ showHelp: false }));
document.getElementById('debug-close')!.addEventListener('click', () => setPanels({ showDebug: false }));

function togglePause() {
  paused = !paused;
  pausedEl.hidden = !paused;
  // Beim Neuladen wieder angehalten, wenn es jetzt angehalten ist.
  settings.paused = paused;
  saveSettings(settings);
  // Auch Mühlenflügel und Fahnen halten an.
  setAnimationsPaused(paused);
  menu.refresh();
}

const menu = new SettingsMenu(settings, {
  apply: applySettings,
  soundEnabled: () => sound.enabled,
  toggleSound: () => toggleSound(),
  paused: () => paused,
  togglePause,
  musicTitle: () => music.title,
  nextTrack: () => {
    music.next();
    // Der Titel wechselt sofort - das Menü zeigt ihn gleich an.
    menu.refresh();
  },
  // Vorher speichern - im Hauptmenü steht der Stand dann unter Weiterspielen.
  mainMenu: () => {
    world.save();
    start.open();
  },
  save: () => world.save(),
});

function startNewGame() {
  world.reset();
  ui.clearSelection();
  if (paused) togglePause();
  ui.refreshResources();
  goToStart();
}

/** Kamera zurück an den Start - im Hauptmenü ist sie weitergezogen. */
function goToStart() {
  const home = startPoint(world, terrain, seed);
  camera.moveTo(home.x, home.y);
}

/** Hauptmenü beim Öffnen der Seite; bis man spielt, steht die Welt. */
const start = new StartScreen({
  hasSave: () => world.hasTownCenter() || world.villagers.length > 0,
  world: seed,
  continueGame: goToStart,
  // Dieselbe Welt beginnt hier von vorn, eine andere nach dem Neuladen.
  newGame: (s) => (s === seed ? startNewGame() : switchWorld(s, 'new')),
  loadGame: (s) => (s === seed ? goToStart() : switchWorld(s, 'continue')),
  // Die jetzige Welt steht im Speicher und würde sich neu speichern - also leeren.
  deleteGame: (s) => (s === seed ? startNewGame() : deleteSave(s)),
  save: () => world.save(),
  openSettings: () => menu.open(true),
});

// --- Ton -------------------------------------------------------------------

const soundButton = document.getElementById('sound')!;

function updateSoundButton() {
  soundButton.classList.toggle('muted', !sound.enabled);
  soundButton.title = sound.enabled ? 'Ton aus (M)' : 'Ton an (M)';
}

function toggleSound() {
  sound.toggle();
  music.mute = !sound.enabled;
  updateSoundButton();
  menu.refresh();
}

soundButton.addEventListener('click', toggleSound);
updateSoundButton();
applySettings();

// Geräusche aus der Welt - nur, was man sieht (game/worldSounds.ts).
world.onEvent = worldSounds(sound, camera, (x, y) => ground.heightAt(x, y));

// --- Kompass ---------------------------------------------------------------

/** Windrose um die Minimap (game/Compass.ts) - die Buchstaben außen vor den Spitzen (Hud.tsx). */
const compass = new Compass(document.getElementById('compass')!, 155, (dir) => faceDirection(dir));
// Die Pfeile unter der Minimap drehen um eine Vierteldrehung: was rechts bzw. links liegt, kommt nach oben.
document.getElementById('turn-left')!.addEventListener('click', () => faceDirection(directionAt(1)));
document.getElementById('turn-right')!.addEventListener('click', () => faceDirection(directionAt(-1)));

/** Übergang beim Drehen (game/TurnAnimation.ts). */
const turnAnimation = new TurnAnimation(
  canvas,
  document.getElementById('turn-snapshot') as HTMLCanvasElement,
  document.querySelector<HTMLElement>('#minimap-frame .minimap-spin')!,
  document.getElementById('compass')!,
);
/**
 * Gewünschte Blickrichtung - gedreht wird erst in loop(), direkt nach dem
 * Zeichnen: dann steht das alte Bild noch im Puffer und lässt sich für den
 * Übergang festhalten.
 */
let pendingFacing: string | null = null;

function faceDirection(dir: string) {
  pendingFacing = dir;
}

/** Dreht die Ansicht so, dass die Richtung `dir` nach oben zeigt. */
function applyFacing(dir: string) {
  // Gedreht wird um die Stelle, die man in der Bildmitte sieht - mit ihrer
  // Geländehöhe. Um den Punkt auf Meereshöhe gedreht, wanderte ein Dorf auf
  // einem Hügel beim Drehen aus dem Bild.
  const pivot = focusPoint();
  rotateToFace(dir);
  keepFocus(pivot);
  autoFlat = hiddenAtCenter(pivot.x, pivot.y);
  compass.update();
  // Die Blickrichtung bleibt beim Neuladen.
  settings.facing = dir;
  saveSettings(settings);
  // Unter dem Zeiger liegt jetzt eine andere Stelle.
  pointer.tile = null;
  refreshPointer();
  placement.invalidate();
}



// Der Speicherstand liegt im localStorage, je Welt einer.
window.addEventListener('beforeunload', () => world.save());

const renderer = new MapRenderer(canvas, seed, camera.tileSize, camera.pixelRatio);
const minimap = new MiniMap(minimapCanvas, seed, camera.pixelRatio);

camera.moveTo(startX, startY);


/** Gelände, wie man es sieht, und sein Abgleich mit dem Shader (game/Ground.ts). */
const ground = new Ground(mapGen, world, renderer, camera);
world.groundAt = (x, y) => ground.groundAt(x, y);

/** Was unter dem Zeiger liegt: Welt-Punkt, Tile, Dorfbewohner, Vorkommen (game/Picker.ts). */
const picker = new Picker(world, resources, camera, ground, () => simulation.blend);

/** Was der Spieler tut: auswählen, Befehle, bauen, ausbilden, abreißen (game/actions.ts). */
const actions = new PlayerActions({ world, camera, selection, placement, picker, ground, sound }, {
  hint: (text) => ui.hint(text),
  refreshSelection: () => ui.refreshSelection(),
  refreshResources: () => ui.refreshResources(),
  refreshPointer,
  setPlacing: (type) => ui.setPlacing(type),
});

/** Die Maus über dem Spielfeld (game/MouseInput.ts) - hier, was sie im Spiel bedeutet. */
new MouseInput(canvas, boxEl, {
  // Im Baumodus setzt ein Klick das Gebäude; Felder weiter beim Ziehen (move).
  press: (p) => {
    if (!placement.isActive) return false;
    const { x, y } = picker.tile(p.x, p.y);
    placement.sowing = placement.placingType === 'farm';
    actions.placeAt(x, y);
    return true;
  },
  release: () => {
    placement.sowing = false;
  },
  click: (p, add, double) => actions.clickSelect(p.x, p.y, add, double),
  box: (a, b, add) => actions.boxSelect(a.x, a.y, b.x, b.y, add),
  rightClick: (p) => actions.rightClick(p),
  pan: (dx, dy) => camera.panPixels(dx, dy),
  panEnd: () => ui.updateCursor(),
  zoom: (steps, p) => zoomBy(steps, p.x, p.y),
  tilt: (dy) => tiltBy(dy * TILT_PER_PIXEL),
  turn: (direction) => faceDirection(directionAt(direction === 1 ? -1 : 1)),
  move: (p, buttons) => {
    const tileChanged = updateHoveredTile(p.x, p.y);
    // Felder markieren: jedes überstrichene Tile, auf dem gesät werden kann.
    const tile = pointer.tile;
    if (tileChanged && tile && placement.sowing && placement.placingType === 'farm' && (buttons & 1) && world.sowable(tile.x, tile.y)) {
      actions.placeAt(tile.x, tile.y, true);
    }
  },
  leave: () => {
    pointer.clear();
    devPanel.showTile();
    updateHoverInfo();
  },
});

window.addEventListener('resize', resize);



// --- Neigung ---------------------------------------------------------------

/**
 * Der Punkt, auf den man schaut (Welt, mit Geländehöhe bei vollem Relief):
 * beim Neigen, Drehen und Flachlegen bleibt er genau in der Bildmitte.
 * Bestimmt wird er einmal und gilt, bis die Kamera anders bewegt wird
 * (Verschieben, Zoomen, Minimap). Je Bild neu gepickt, wanderte er mit jedem
 * kleinen Rechenfehler weiter - und flacher geneigt verdeckt ein Berg im
 * Vordergrund die Stelle, dann spränge er auf dessen Hang.
 */
let focus: { x: number; y: number; height: number; cameraX: number; cameraY: number } | null = null;

/** Der festgehaltene Punkt, wenn die Kamera seitdem nicht anders bewegt wurde - sonst null. */
function heldFocus() {
  return focus && focus.cameraX === camera.x && focus.cameraY === camera.y ? focus : null;
}

function focusPoint() {
  if (!heldFocus()) {
    const p = picker.point(camera.centerX, camera.centerY);
    focus = { x: p.x, y: p.y, height: ground.groundAt(p.x, p.y), cameraX: camera.x, cameraY: camera.y };
  }
  return focus!;
}

/** Legt den Punkt wieder genau in die Bildmitte (bei der jetzigen Reliefstärke) - und merkt sich, dass die Kamera nun so steht. */
function keepFocus(f: NonNullable<typeof focus>) {
  camera.centerOn(f.x, f.y, f.height * renderer.relief);
  f.cameraX = camera.x;
  f.cameraY = camera.y;
}

// --- Gelände im Weg --------------------------------------------------------

/**
 * Gelände automatisch flachlegen, wie mit gehaltener Leertaste: wenn nach dem
 * Neigen oder Drehen ein Berg den angeschauten Punkt verdeckt - etwa das
 * Haupthaus hinter einem Hang. Der Punkt bleibt dabei in der Bildmitte.
 * Aufgerichtet wird wieder, sobald die Bildmitte auch bei vollem Relief frei
 * ist (verschoben, zurückgedreht, steiler geneigt).
 */
let autoFlat = false;
/** Ab so viel Abstand (Tiles) zwischen Punkt und erstem Treffer des Sichtstrahls gilt er als verdeckt. */
const HIDDEN_TILES = 1;
/** Kamera-Stand, für den autoFlat zuletzt geprüft wurde. */
let autoFlatView = '';

/**
 * Wäre der Punkt (x, y) bei vollem Relief verdeckt, wenn er in der Bildmitte
 * läge? Der Sichtstrahl durch die Mitte trifft dann vorher einen Hang.
 */
function hiddenAtCenter(x: number, y: number): boolean {
  const view = camera.view();
  const center = centerFor(view, x, y, ground.groundAt(x, y), camera.centerX, camera.centerY);
  const hit = pickWorld({ ...view, centerX: center.x, centerY: center.y }, camera.centerX, camera.centerY,
    (a, b) => ground.groundAt(a, b));
  return Math.hypot(hit.x - x, hit.y - y) > HIDDEN_TILES;
}

/** Neigen mit Alt und rechter Maustaste: Radiant je Pixel (wie in der Galerie). */
const TILT_PER_PIXEL = 0.006;
/** Neigen mit Alt und Pfeil hoch/runter: ein Schritt (7,5°). */
const TILT_STEP = Math.PI / 24;
/** Wie schnell der Blickwinkel seinem Ziel folgt (je Sekunde) - wie beim Zoom. */
const TILT_RATE = 18;
/** So lange nach der letzten Eingabe (ms) gilt noch als "wird geneigt". */
const TILT_SETTLE = 200;

function clampTilt(rad: number): number {
  return Math.min(TILT_MAX, Math.max(TILT_MIN, Number.isFinite(rad) ? rad : TILT_DEFAULT));
}

/** Wohin der Blickwinkel gleitet (Radiant) - geneigt wird weich in updateTilt(). */
let tiltTarget = viewElevation();
let lastTiltInput = 0;

/** Zielwinkel verschieben (positiv: steiler, mehr von oben). */
function tiltBy(rad: number) {
  tiltTarget = clampTilt(tiltTarget + rad);
  lastTiltInput = performance.now();
}

/**
 * Ein Bild Neigung: der Blickwinkel folgt dem Ziel weich (Lerp). Gekippt
 * wird um die Stelle in der Bildmitte mit ihrer Geländehöhe - wie beim
 * Drehen, sonst wanderte ein Dorf auf einem Hügel aus dem Bild.
 * true, wenn sich die Ansicht geändert hat.
 */
function updateTilt(dt: number, now: number): boolean {
  // Solange noch gezogen wird, bleibt der Gelände-Cache gestreckt stehen.
  const current = viewElevation();
  renderer.tilting = current !== tiltTarget || now - lastTiltInput < TILT_SETTLE;
  if (current === tiltTarget) return false;
  let next = current + (tiltTarget - current) * (1 - Math.exp(-TILT_RATE * dt));
  if (Math.abs(tiltTarget - next) < 0.0005) next = tiltTarget;
  const pivot = focusPoint();
  setViewElevation(next);
  keepFocus(pivot);
  autoFlat = hiddenAtCenter(pivot.x, pivot.y);
  if (next === tiltTarget) {
    // Der Blickwinkel bleibt beim Neuladen - wie die Blickrichtung.
    settings.tilt = Math.round((next * 180) / Math.PI * 10) / 10;
    saveSettings(settings);
  }
  return true;
}

/** Bildschirmstelle, um die gezoomt wird - bleibt bis zur nächsten Zoom-Eingabe. */
let zoomAnchor: CanvasPoint | null = null;

/**
 * Zoomziel verschieben (game/Camera.ts); gezoomt wird weich in updateZoom().
 * Anker ist der Mauszeiger, solange er über der Karte ist, sonst die Bildmitte.
 */
function zoomBy(steps: number, anchorX?: number, anchorY?: number) {
  zoomAnchor = {
    x: anchorX ?? pointer.pixel?.x ?? camera.centerX,
    y: anchorY ?? pointer.pixel?.y ?? camera.centerY,
  };
  camera.zoomBy(steps);
}

/**
 * Ein Bild Zoom: so, dass das Welt-Tile unter dem Anker dort stehen bleibt.
 * true, wenn sich die Ansicht geändert hat.
 */
function updateZoom(dt: number, now: number): boolean {
  const ax = zoomAnchor?.x ?? camera.centerX;
  const ay = zoomAnchor?.y ?? camera.centerY;
  // Das Ziel kennt der Renderer schon, bevor der Zoom dort ist - er bereitet
  // den Gelände-Cache der Zielstufe im Hintergrund vor.
  renderer.targetTileSize = camera.targetTileSize;
  // Welt-Punkt unter dem Anker vor dem Zoom ...
  const anchor = picker.point(ax, ay);
  if (!camera.stepZoom(dt, now)) return false;
  renderer.tileSize = camera.tileSize;
  // ... und danach wieder genau unter den Anker legen.
  camera.centerOn(anchor.x, anchor.y, anchor.z, ax, ay);
  showZoom();
  return true;
}

/** Zoomstufe unter der Minimap ("Zoom 1" bis "Zoom 5") und in den Entwickler-Infos. */
function showZoom() {
  document.getElementById('zoom-level')!.textContent = `Zoom ${camera.zoomNumber}`;
  devPanel.showZoom(camera);
}

/** Tastatur: gehaltene Tasten und die Belegung (game/keyboard.ts) - hier, was sie im Spiel tut. */
const keyboard = new Keyboard({
  isMenuOpen: () => menu.isOpen(),
  isTitleOpen: () => start.isOpen(),
  // Im Hauptmenü ohne die Knöpfe, die nur im Spiel Sinn haben.
  toggleMenu: () => (menu.isOpen() ? menu.close() : menu.open(start.isOpen())),
  closeMenu: () => menu.close(),
  togglePause,
  toggleSound,
  zoom: (step) => zoomBy(step),
  tiltStep: (step) => tiltBy(step * TILT_STEP),
  // Wie die Pfeile unter der Minimap: rechts = was rechts liegt, kommt nach oben.
  turn: (direction) => faceDirection(directionAt(direction === 1 ? -1 : 1)),
  cancel: () => ui.cancel(),
  demolish: () => actions.demolishSelected(),
  home: () => actions.cycleTownCenter(),
  toggleHelp: () => setPanels({ showHelp: !settings.showHelp }),
  toggleDebug: () => setPanels({ showDebug: !settings.showDebug }),
  selectIdle: (all) => actions.selectIdle(all),
  train: (count) => actions.trainVillagers(count),
  farmsOpen: () => ui.farmsOpen,
  chooseCrop: (index) => ui.chooseCrop(index),
  // Das Feld öffnet das Untermenü (Weizen, Mais); sonst Baumodus an oder aus.
  build: (type) => {
    if (type === 'farm') ui.openFarms();
    else ui.setPlacing(placement.placingType === type ? null : type);
  },
});



/**
 * Die Ansicht, um die sich die Minimap legt: mittig auf der Stelle, die man in
 * der Bildmitte wirklich sieht - mit ihrer Geländehöhe. camera.x/y ist der
 * Punkt auf Meereshöhe; auf einem Gebirge liegt der weit hinter dem, was im
 * Bild ist, und die flache Minimap zeigte dann die falsche Gegend.
 */
function minimapView(): IsoView {
  const seen = picker.point(camera.centerX, camera.centerY);
  return { ...camera.view(), centerX: seen.x, centerY: seen.y };
}

minimapCanvas.addEventListener('click', (e) => {
  const rect = minimapCanvas.getBoundingClientRect();
  // Nur die Scheibe ist Karte - die Ecken des Canvas gehören zum Rahmen.
  if (!minimap.inside(e.clientX - rect.left, e.clientY - rect.top)) return;
  const target = minimap.toWorld(e.clientX - rect.left, e.clientY - rect.top, minimapView());
  // Die angeklickte Stelle mit ihrer Höhe in die Bildmitte - nicht den Punkt auf Meereshöhe.
  camera.centerOn(target.x, target.y, ground.heightAt(target.x, target.y));
  refreshPointer();
});

minimapCanvas.addEventListener('mousemove', (e) => {
  const rect = minimapCanvas.getBoundingClientRect();
  devPanel.showMinimapPointer(minimap.toWorld(e.clientX - rect.left, e.clientY - rect.top, minimapView()));
});
minimapCanvas.addEventListener('mouseleave', () => devPanel.showMinimapPointer());

/**
 * Zeiger auf die Canvas-Stelle (mouseX, mouseY) setzen: Objekt und Tile
 * darunter, Mauszeiger und Entwickler-Infos. true, wenn das Tile wechselte.
 */
function updateHoveredTile(mouseX: number, mouseY: number): boolean {
  pointer.pixel = { x: mouseX, y: mouseY };
  // Nur mit ausgewählten Dorfbewohnern zählt, worauf der Zeiger zeigt.
  const object = selection.villagers.size > 0 ? picker.resourceObject(mouseX, mouseY) : undefined;
  if (pointer.setObject(object)) ui.updateCursor();
  const tile = picker.tile(mouseX, mouseY);
  if (!pointer.setTile(tile)) return false;
  ui.updateCursor();
  devPanel.showTile({ ...terrain.getTile(tile.x, tile.y), x: tile.x, y: tile.y });
  updateHoverInfo();
  return true;
}

/** Die Kamera hat sich bewegt: unter dem stehenden Zeiger liegt jetzt anderes. */
function refreshPointer() {
  if (pointer.pixel) updateHoveredTile(pointer.pixel.x, pointer.pixel.y);
}

/**
 * Was unter dem Zeiger steht, in den Entwickler-Infos (game/hoverInfo.ts).
 * Läuft auch getaktet mit, weil sich Figuren bewegen und Sammler leeren,
 * während der Zeiger stillsteht.
 */
function updateHoverInfo() {
  const { pixel, tile } = pointer;
  let target: HoverTarget = {};
  if (pixel && tile) {
    const villager = picker.villager(pixel.x, pixel.y);
    const at = picker.point(pixel.x, pixel.y);
    target = villager ? { villager } : { animal: world.animalNear(at.x, at.y, 0.6), tile };
  }
  const { label, text } = hoverDescription(world, resources, target);
  devPanel.showObject(label, text);
}

let lastTime = performance.now();

/**
 * Steht die Kamera (verschieben, zoomen, drehen) so lange still, zeichnet das
 * Spiel nur noch IDLE_FPS Bilder je Sekunde - schont Akku und Lüfter. Die
 * Welt läuft gleich schnell weiter, nur seltener gezeichnet.
 */
const IDLE_AFTER_MS = 1000;
const IDLE_FPS = 30;
let lastMove = performance.now();
let lastFrame = 0;
/** So oft je Sekunde wird die Minimap gezeichnet - sie bewegt sich langsam (Einstellung minimapFps). */
const MINIMAP_FPS = 10;
let lastMinimap = 0;
let lastView = '';
/** Die Simulation läuft in festen Schritten von 0.1 s (game/timing.ts). */
const simulation = new FixedStep(0.1);
/** Vorrat, Auswahl und Hover fünfmal je Sekunde - je Bild wäre es nur unruhig und teuer. */
const uiRefresh = new Interval(200);
/** Neue Stücke mit Wild nahe der Kamera nur ab und zu prüfen. */
const animalCheck = new Interval(500);
/**
 * Einmal je Minute speichern - der Spielstand wird mit der Welt immer
 * größer, ihn alle paar Sekunden zu schreiben kostet unnötig. Beim Verlassen
 * der Seite wird zusätzlich gespeichert (beforeunload).
 */
const autosave = new Interval(60_000);

/** Wird je Frame neu befüllt statt neu angelegt. */
const overlay: EntityInstance[] = [];
/** Feste Puffer der Vorkommen, an denen niemand arbeitet (world/resources.ts). */
const staticBatches: StaticBatch[] = [];
const minimapOverlay: EntityInstance[] = [];

/**
 * canPlace() sucht den ganzen Umkreis nach Vorkommen ab - bei Radius 4 sind
 * das 81 Geländeabfragen. Für die Vorschau wird das Ergebnis gemerkt, solange
 * Feld und Gebäudetyp gleich bleiben; sonst liefe die Suche je Bild neu.
 */

/**
 * Feste Puffer für die Vorkommen (Regionen von 64x64 Tiles) nur weit draußen,
 * unter so vielen CSS-Pixeln je Tile (Zoom 1, die Bäume als Bild): dort
 * stehen Tausende Bäume im Bild, und die Puffer sparen das Einsammeln. Näher
 * heran werden die Vorkommen einzeln eingesammelt, nur was im Bild steht
 * (onScreenTest) - ganze Regionen zu zeichnen hieß gemessen 18-28 Mio.
 * Eckpunkte je Bild, auch für nur 31 sichtbare Tiles; einzeln sind es bei
 * Zoom 2 bis 5 noch 6,3 / 4,2 / 2,1 / 1,0 Mio., bei gleichen Bildzeiten.
 */
const STATIC_BATCHES_BELOW = 16;

/**
 * Steht ein Objekt im Bild (OnScreen in world/resources.ts)? In
 * Bodenkoordinaten gegen den Bildausschnitt: im Bild rückt es um seine
 * Geländehöhe und seine eigene Höhe nach oben. visibleWorldRect ist das
 * achsenparallele Rechteck um die Bildraute - fast doppelt so groß, dazu der
 * Rand für die höchsten Gipfel. Ein Tile Rand, und seitlich eine Objekthöhe
 * (ein fallender Baum kippt zur Seite).
 */
function onScreenTest(): OnScreen {
  const c = worldToGround(camera.x, camera.y);
  const zs = viewZScreen();
  const relief = renderer.relief;
  const halfU = camera.width / 2 / camera.tileSize + 1;
  const halfV = camera.height / 2 / camera.tileSize + 1;
  return (x, y, ground, height) => {
    const g = worldToGround(x, y);
    if (Math.abs(g.u - c.u) > halfU + height) return false;
    const foot = g.v - c.v - zs * ground * relief;
    return foot > -halfV && foot - zs * height < halfV;
  };
}

/** Alles, was über dem Gelände gezeichnet wird: Vorkommen, Welt, Auswahl und - im Baumodus - die Vorschau. */
function collectOverlay(blend: number) {
  overlay.length = 0;
  staticBatches.length = 0;
  const visible = visibleWorldRect(camera.view());
  if (camera.tileSize >= RESOURCE_OBJECTS_MIN_ZOOM) {
    resources.update(visible, camera.x, camera.y);
    if (camera.tileSize < STATIC_BATCHES_BELOW) {
      resources.instances(visible, world, overlay, selection.resource, blend, { batcher: renderer, out: staticBatches });
    } else {
      resources.instances(visible, world, overlay, selection.resource, blend, undefined, onScreenTest());
    }
  }
  if (renderer.flowerObjects) {
    flowers.update(visible, camera.x, camera.y);
    flowers.instances(visible, world, overlay);
  }
  const hovered = pointer.tile ? world.at(pointer.tile.x, pointer.tile.y)?.anchor : undefined;
  worldInstances(world, visible, overlay, blend, selection, hovered,
    (kind) => camera.tileSize < (settings.animalsBelow[kind] ?? ANIMALS_BELOW_DEFAULT));
  selectionOverlay(world, selection, blend, overlay);
  const tile = pointer.tile;
  if (placement.placingType !== null && tile) {
    const blocked = placement.check(tile.x, tile.y, placement.placingType) !== null;
    placementOverlay(world, placement.placingType, tile.x, tile.y, blocked, overlay);
  }
}

function loop(now: number) {
  // Stufenloser Zoom und Neigung zählen mit - beides bewegt die Ansicht.
  const view = `${camera.x},${camera.y},${camera.zoom},${viewRotation()},${viewElevation()}`;
  if (view !== lastView) {
    lastView = view;
    lastMove = now;
  }
  // Etwas Spiel, damit bei 60 Hz jedes zweite Bild kommt und nicht jedes dritte.
  if (settings.idleFps && now - lastMove > IDLE_AFTER_MS && now - lastFrame < 1000 / IDLE_FPS - 4) {
    requestAnimationFrame(loop);
    return;
  }
  lastFrame = now;

  // Begrenzt, damit die Kamera nach einem Tab-Wechsel nicht quer über die Karte
  // springt (dt wäre dann die gesamte Zeit im Hintergrund).
  const dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;


  // WASD, Leertaste, hinter dem Hauptmenü langsam vorbeiziehen (game/cameraControl.ts).
  const zoomed = updateZoom(dt, now);
  const tilted = updateTilt(dt, now);
  // Beim Flachlegen und Aufrichten bleibt der angeschaute Punkt in der Mitte,
  // solange die Kamera nicht anders bewegt wurde.
  const held = heldFocus();
  const reliefBefore = renderer.relief;
  const [cameraX, cameraY] = [camera.x, camera.y];
  const steered = steerCamera(camera, renderer, keyboard, dt, settings.scroll, start.isOpen(), autoFlat);
  if (held && renderer.relief !== reliefBefore && camera.x === cameraX && camera.y === cameraY) keepFocus(held);
  if (steered || zoomed || tilted) refreshPointer();
  // Flachgelegt, weil Gelände im Weg war: aufrichten, sobald die Bildmitte
  // auch bei vollem Relief frei ist - geprüft, wenn sich die Ansicht ändert.
  if (autoFlat) {
    const seen = `${camera.x},${camera.y},${camera.zoom},${viewRotation()},${viewElevation()}`;
    if (seen !== autoFlatView) {
      autoFlatView = seen;
      const p = heldFocus() ?? picker.point(camera.centerX, camera.centerY);
      autoFlat = hiddenAtCenter(p.x, p.y);
    }
  }

  simulation.advance(paused || start.isOpen() ? 0 : dt * settings.speed, (step) => world.tick(step));

  ground.update(now);
  // Wild rund um die Kamera - neue Stücke nur ab und zu prüfen.
  if (animalCheck.due(now)) world.ensureAnimals(camera.x, camera.y);
  collectOverlay(simulation.blend);
  renderer.setPlayerColor(player.color.toRGB());
  renderer.billboardBelow = settings.billboards;
  const drawn = renderer.render(camera.x, camera.y, pointer.tile?.x, pointer.tile?.y, overlay, staticBatches);
  // Das Bild für den Dreh-Übergang nur, wenn gerade gezeichnet wurde - sonst
  // ist der WebGL-Puffer leer und der Übergang begänne schwarz.
  if (pendingFacing && drawn) {
    turnAnimation.capture();
    const before = northAngle();
    applyFacing(pendingFacing);
    pendingFacing = null;
    // Auf den kürzeren Weg: -180..180, eine halbe Drehung im Uhrzeigersinn.
    const turned = ((northAngle() - before + 540) % 360) - 180;
    turnAnimation.play(turned === -180 ? 180 : -turned);
  }

  if (!settings.minimapFps || now - lastMinimap >= 1000 / MINIMAP_FPS - 4) {
    lastMinimap = now;
    const seen = minimapView();
    minimapDots(world, minimap, seen, minimapOverlay);
    minimap.render(seen, minimapOverlay);
    devPanel.minimapFrame();
  }

  devPanel.frame(now, camera, renderer.billboardsActive);

  if (uiRefresh.due(now)) {
    ui.refreshResources();
    updateHoverInfo();
  }
  if (autosave.due(now)) world.save();

  requestAnimationFrame(loop);
}

showZoom();
// Blickrichtung und Pause wie beim letzten Mal. Die Kamera bleibt auf dem
// Feld aus der Adresse - gedreht wird nur die Ansicht.
if (isDirection(settings.facing)) rotateToFace(settings.facing);
if (settings.paused && !paused) togglePause();
compass.update();
ui.refreshResources();
// Wer die Seite aufmacht, landet im Hauptmenü - wie bei einem Spiel. Nach
// der Wahl einer anderen Welt geht es dort gleich los - neu oder geladen.
const request = takeStartRequest();
if (request === 'new') startNewGame();
else if (request !== 'continue') start.open();
requestAnimationFrame(loop);
document.title = `Soliva - ${seed}`;