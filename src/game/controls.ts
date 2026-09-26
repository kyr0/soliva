// controls.ts
// Die Steuerung des Spiels an EINER Stelle: jede Taste und jeder Mausbefehl
// mit dem, was er tut. Daraus lösen die Tasten aus (keyboard.ts), und daraus
// zeigen Menü und Tastenhilfe die Liste (components/Shortcuts.tsx) - so können
// Belegung und Anzeige nicht auseinanderlaufen.

import { BUILDING_ORDER, BUILDINGS, VILLAGER } from '../world/catalog';
import type { KeyCommands } from './keyboard';

/** Anzeige für die linke bzw. rechte Maustaste (ein Maussymbol). */
export const MOUSE_LEFT = 'mouse:left';
export const MOUSE_RIGHT = 'mouse:right';

export interface Control {
  /** Was angezeigt wird, je eine Tastenkappe - MOUSE_LEFT/RIGHT als Maus, "~2×" als Text daneben. */
  label: string[];
  /** Zwischen den Kappen: "+" zusammen, "/" oder "-" eine davon, sonst nebeneinander (WASD). */
  sep?: string;
  /** Was es tut - ausführlich, fürs Menü. */
  what: string;
  /** Knapp, für die Tastenhilfe. */
  short: string;
  /** Tasten (KeyboardEvent.key in Kleinbuchstaben), die es auslösen - fehlt bei Maus und gehaltenen Tasten. */
  keys?: readonly string[];
  /** Was die Taste im Spiel tut. */
  run?: (c: KeyCommands, e: KeyboardEvent) => void;
}

/** Tasten der Gebäude im Baumenü (1 … 6). */
const BUILDING_KEYS = BUILDING_ORDER.map((type) => BUILDINGS[type].key);

export const CONTROLS: readonly Control[] = [
  // Gehalten, abgefragt je Bild (cameraControl.ts).
  { label: ['W', 'A', 'S', 'D'], what: 'Kamera bewegen (auch Pfeiltasten)', short: 'bewegen' },
  { label: [MOUSE_RIGHT, '~ziehen'], what: 'Karte verschieben', short: 'verschieben' },
  {
    label: ['Q', 'E'], sep: '/', what: 'Zoomen (auch Mausrad)', short: 'zoomen',
    keys: ['q', 'e'], run: (c, e) => c.zoom(e.key.toLowerCase() === 'e' ? 1 : -1),
  },
  { label: ['Leertaste'], what: 'Halten: Gelände flach', short: 'flach' },
  // Alt: auf dem Mac Option, unter Windows auch AltGr (keyboard.ts, MouseInput.ts).
  {
    label: ['Alt', MOUSE_RIGHT, '~ziehen'], sep: '+',
    what: 'Blickwinkel: hoch/runter neigen, links/rechts in Vierteln drehen (Mac: Option)', short: 'Winkel',
  },
  { label: ['Alt', '↑', '↓'], sep: '+', what: 'Steiler / flacher neigen', short: 'neigen' },
  { label: ['Alt', '←', '→'], sep: '+', what: 'Vierteldrehung nach links / rechts', short: 'drehen' },
  // H wie in AoE2 - "Home".
  { label: ['H'], what: 'Zum Hauptgebäude', short: 'Hauptgebäude', keys: ['h'], run: (c) => c.home() },
  { label: [MOUSE_LEFT], what: 'Auswählen (Ziehen: Rahmen)', short: 'auswählen' },
  { label: ['Umschalt', MOUSE_LEFT], sep: '+', what: 'Zur Auswahl hinzu', short: 'hinzu' },
  { label: [MOUSE_LEFT, '~2×'], what: 'Gleiche Gebäude in der Nähe', short: 'gleiche' },
  // Punkt wie in AoE2: alle untätigen Dorfbewohner (mit Umschalt: einzeln reihum).
  {
    label: ['.'], what: 'Untätige (Umschalt: einzeln)', short: 'untätige',
    keys: ['.', ':'], run: (c, e) => c.selectIdle(!e.shiftKey),
  },
  { label: [MOUSE_RIGHT], what: 'Befehl: sammeln, jagen, bauen, gehen', short: 'Befehl' },
  {
    label: [BUILDING_KEYS[0], BUILDING_KEYS[BUILDING_KEYS.length - 1]], sep: '-', what: 'Gebäude bauen', short: 'bauen',
    keys: BUILDING_KEYS, run: (c, e) => c.build(BUILDING_ORDER[BUILDING_KEYS.indexOf(e.key)]),
  },
  {
    label: [VILLAGER.key.toUpperCase()], what: 'Dorfbewohner ausbilden (Umschalt: 5)', short: 'Dorfbewohner',
    keys: [VILLAGER.key], run: (c, e) => c.train(e.shiftKey ? 5 : 1),
  },
  { label: ['Entf'], what: 'Abreißen', short: 'abreißen', keys: ['delete', 'backspace'], run: (c) => c.demolish() },
  { label: ['Esc'], what: 'Abbrechen, Auswahl aufheben', short: 'abbrechen', keys: ['escape'], run: (c) => c.cancel() },
  // F3 und F10 wie in AoE2 - sie behandelt keyboard.ts vorab, weil sie auch im Menü gelten.
  { label: ['F3'], what: 'Pause', short: 'Pause' },
  { label: ['F10'], what: 'Menü', short: 'Menü' },
  { label: ['M'], what: 'Ton an/aus', short: 'Ton', keys: ['m'], run: (c) => c.toggleSound() },
  // I: Tastenhilfe (Info), P: Entwickler-Infos (Programmierer).
  { label: ['I'], what: 'Tastenhilfe ein/aus', short: 'Tastenhilfe', keys: ['i'], run: (c) => c.toggleHelp() },
  { label: ['P'], what: 'Entwickler-Infos ein/aus', short: 'Entwickler', keys: ['p'], run: (c) => c.toggleDebug() },
];

/** Die Steuerung, die eine Taste auslöst - oder keine. */
export function controlForKey(key: string): Control | undefined {
  return CONTROLS.find((control) => control.keys?.includes(key));
}
