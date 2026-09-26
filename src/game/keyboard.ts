// keyboard.ts
// Die Tastatur: welche Tasten gehalten werden (WASD, Pfeile, Leertaste - die
// fragt die Spielschleife je Bild ab) und welche Taste was auslöst - nach der
// Tabelle in controls.ts. Was ein Befehl im Spiel tut, liefert main.ts als
// KeyCommands.
//
// Reihenfolge: F10 (Menü) geht immer; bei offenem Menü nur Esc und M, im
// Hauptmenü nur M; F3 hält an. Danach die Spieltasten.

import type { BuildingType } from '../world/catalog';
import { controlForKey } from './controls';
import { altHeld } from './MouseInput';

/** Was die Tasten im Spiel auslösen. */
export interface KeyCommands {
  isMenuOpen(): boolean;
  isTitleOpen(): boolean;
  /** Menü auf oder zu (F10). */
  toggleMenu(): void;
  closeMenu(): void;
  togglePause(): void;
  toggleSound(): void;
  /** Eine Zoomstufe hinein (+1) oder hinaus (-1). */
  zoom(step: 1 | -1): void;
  /** Alt + Pfeil hoch/runter: einen Schritt steiler (+1) oder flacher (-1) neigen. */
  tiltStep(step: 1 | -1): void;
  /** Alt + Pfeil rechts/links: eine Vierteldrehung (1 = nach rechts, -1 = nach links). */
  turn(direction: 1 | -1): void;
  /** Esc im Spiel: Untermenü zu, Baumodus aus, sonst Auswahl aufheben. */
  cancel(): void;
  demolish(): void;
  /** Zum (nächsten) Hauptgebäude springen. */
  home(): void;
  toggleHelp(): void;
  toggleDebug(): void;
  /** Untätige: alle oder einzeln reihum. */
  selectIdle(all: boolean): void;
  train(count: number): void;
  /** Ist das Untermenü der Felder offen? Dann wählen Ziffern die Frucht. */
  farmsOpen(): boolean;
  /** Frucht Nummer `index` (0, 1, ...) im Untermenü der Felder. */
  chooseCrop(index: number): void;
  /** Taste eines Gebäudes im Baumenü. */
  build(type: BuildingType): void;
}

/** Alt + Pfeiltasten. Drehen nur einmal je Druck, Neigen auch beim Gedrückthalten. */
const ANGLE_KEYS: Record<string, (c: KeyCommands) => void> = {
  arrowup: (c) => c.tiltStep(1),
  arrowdown: (c) => c.tiltStep(-1),
  arrowright: (c) => c.turn(1),
  arrowleft: (c) => c.turn(-1),
};

export class Keyboard {
  private held = new Set<string>();

  constructor(private commands: KeyCommands) {
    window.addEventListener('keydown', (e) => this.down(e));
    window.addEventListener('keyup', (e) => this.held.delete(e.key.toLowerCase()));
  }

  /** Wird die Taste gerade gehalten? Kleinbuchstaben bzw. KeyboardEvent.key in klein ('arrowup', ' '). */
  isDown(...keys: string[]): boolean {
    return keys.some((k) => this.held.has(k));
  }

  private down(e: KeyboardEvent) {
    const c = this.commands;
    const key = e.key.toLowerCase();
    // F10 wie in AoE2: Menü.
    if (e.key === 'F10') {
      e.preventDefault();
      c.toggleMenu();
      return;
    }
    // Menü offen: keine Spieltasten - nur Esc, und der Ton (M), dessen Schalter dort steht.
    if (c.isMenuOpen()) {
      if (e.key === 'Escape') c.closeMenu();
      if (key === 'm') c.toggleSound();
      return;
    }
    // Im Hauptmenü gibt es noch nichts zu steuern - nur den Ton.
    if (c.isTitleOpen()) {
      if (key === 'm') c.toggleSound();
      return;
    }
    // F3 wie in AoE2: Pause.
    if (e.key === 'F3') {
      e.preventDefault();
      c.togglePause();
      return;
    }
    // Alt (Option, AltGr) + Pfeil: neigen und in Vierteln drehen - die Karte
    // verschiebt sich dabei nicht, der Pfeil zählt darum nicht als gehalten.
    if (altHeld(e) && ANGLE_KEYS[key]) {
      e.preventDefault();
      if (!e.repeat || key === 'arrowup' || key === 'arrowdown') ANGLE_KEYS[key](c);
      return;
    }
    this.held.add(key);
    if (e.key === ' ') {
      // Leertaste gedrückt halten legt das Gelände flach (Spielschleife). Sonst
      // scrollt die Seite oder ein fokussierter Knopf wird ausgelöst - bei
      // Knöpfen erst beim Loslassen, darum auch der Fokus weg.
      e.preventDefault();
      (document.activeElement as HTMLElement | null)?.blur();
    }
    this.gameKey(e, key);
  }

  /** Die Spieltasten (controls.ts); im Untermenü der Felder wählen Ziffern die Frucht. */
  private gameKey(e: KeyboardEvent, key: string) {
    const c = this.commands;
    const digit = Number(e.key);
    if (c.farmsOpen() && digit >= 1) {
      c.chooseCrop(digit - 1);
      return;
    }
    controlForKey(key)?.run?.(c, e);
  }
}
