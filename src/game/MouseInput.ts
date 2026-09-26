// MouseInput.ts
// Die Maus über dem Spielfeld, übersetzt in Absichten: Linksklick (mit
// Umschalt, Doppelklick), Auswahlrechteck, Rechtsklick, Karte mit rechter
// Taste ziehen, zoomen mit Mausrad oder Trackpad, Zeiger bewegt/verlassen.
// Was eine Absicht im Spiel bedeutet, entscheiden die MouseHandlers.

/** Eine Stelle auf dem Canvas in CSS-Pixeln. */
export interface CanvasPoint {
  x: number;
  y: number;
}

export interface MouseHandlers {
  /** Linke Taste gedrückt - true, wenn damit etwas passiert ist (Baumodus); dann kein Rechteck. */
  press(p: CanvasPoint): boolean;
  /** Linke Taste losgelassen - ob mit oder ohne Klick. */
  release(): void;
  /** Linksklick ohne Ziehen. `double`: zweiter Klick kurz hintereinander. */
  click(p: CanvasPoint, add: boolean, double: boolean): void;
  /** Rechteck aufgezogen (von a nach b). */
  box(a: CanvasPoint, b: CanvasPoint, add: boolean): void;
  /** Rechtsklick ohne Ziehen. */
  rightClick(p: CanvasPoint): void;
  /** Karte mit der rechten Taste gezogen: um (dx, dy) Pixel verschieben. */
  pan(dx: number, dy: number): void;
  /** Ziehen mit der rechten Taste beendet. */
  panEnd(): void;
  /** Um `steps` Zoomstufen hinein (> 0) oder hinaus (< 0), um die Stelle p - auch Bruchteile. */
  zoom(steps: number, p: CanvasPoint): void;
  /** Mit Alt gezogen, senkrecht: um `dy` Pixel neigen (nach unten gezogen: steiler). */
  tilt(dy: number): void;
  /** Mit Alt gezogen, waagerecht weit genug: eine Vierteldrehung (1 = nach rechts, -1 = nach links). */
  turn(direction: 1 | -1): void;
  /** Zeiger bewegt; `buttons` wie MouseEvent.buttons. */
  move(p: CanvasPoint, buttons: number): void;
  /** Zeiger hat das Canvas verlassen. */
  leave(): void;
}

/** Ab so vielen Pixeln Bewegung wird aus dem Klick ein Rechteck bzw. ein Ziehen. */
const DRAG_THRESHOLD = 5;
/**
 * Mausrad und Trackpad: jede Zoomstufe verdoppelt den Maßstab. Ein Mausrad
 * schickt je Raste ein Ereignis (~100 px) - das ist eine Stufe. Ein Trackpad
 * schickt Dutzende kleine; die zoomen anteilig, die Kamera gleitet weich
 * hinterher und rastet danach auf einer Stufe ein (Camera.stepZoom).
 * Zusammenziehen/Spreizen (Pinch, kommt als Rad mit Strg) zählt stärker.
 */
const WHEEL_STEP = 100;
const PINCH_STEP = 40;
/** So weit (Pixel) muss man mit Alt waagerecht ziehen für eine Vierteldrehung. */
const TURN_DRAG = 120;

/**
 * Alt, Option (Mac) oder AltGr gehalten? AltGr meldet sich unter Windows als
 * Strg+Alt, anderswo nur über getModifierState.
 */
export function altHeld(e: MouseEvent | KeyboardEvent): boolean {
  return e.altKey || e.getModifierState('AltGraph');
}

export class MouseInput {
  private drag: { x: number; y: number; active: boolean } | null = null;
  /**
   * Rechte Taste: gedrückt halten und ziehen verschiebt die Karte (wie WASD),
   * kurz klicken ist ein Befehl. Entschieden wird erst beim Loslassen - das
   * Kontextmenü-Ereignis kommt auf dem Mac schon beim Drücken.
   */
  /**
   * Mit Alt (auch erst beim Ziehen gedrückt) wird aus dem Ziehen ein Winkel:
   * senkrecht neigen, waagerecht in Vierteln drehen - `turned` sammelt die
   * waagerechte Strecke bis TURN_DRAG.
   */
  private rightDrag: { x: number; y: number; moved: boolean; turned: number } | null = null;

  /** @param box das Auswahlrechteck (ein absolut platziertes Element) */
  constructor(private canvas: HTMLCanvasElement, private box: HTMLElement, private handlers: MouseHandlers) {
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('mousedown', (e) => this.down(e));
    // Auf window statt canvas: Rechteck und Ziehen dürfen über Panels und den
    // Rand hinaus gehen, ohne hängen zu bleiben.
    window.addEventListener('mousemove', (e) => this.windowMove(e));
    window.addEventListener('mouseup', (e) => this.up(e));
    canvas.addEventListener('mousemove', (e) => handlers.move(this.point(e), e.buttons));
    canvas.addEventListener('mouseleave', () => handlers.leave());
    canvas.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
  }

  /** Stelle des Ereignisses auf dem Canvas in CSS-Pixeln. */
  point(e: MouseEvent): CanvasPoint {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private down(e: MouseEvent) {
    if (e.button === 2) {
      this.rightDrag = { x: e.clientX, y: e.clientY, moved: false, turned: 0 };
      return;
    }
    if (e.button !== 0) return;
    const p = this.point(e);
    if (this.handlers.press(p)) return;
    this.drag = { x: p.x, y: p.y, active: false };
  }

  private windowMove(e: MouseEvent) {
    if (this.drag) {
      const p = this.point(e);
      const drag = this.drag;
      if (!drag.active && Math.hypot(p.x - drag.x, p.y - drag.y) < DRAG_THRESHOLD) return;
      drag.active = true;
      const style = this.box.style;
      this.box.hidden = false;
      style.left = `${Math.min(p.x, drag.x)}px`;
      style.top = `${Math.min(p.y, drag.y)}px`;
      style.width = `${Math.abs(p.x - drag.x)}px`;
      style.height = `${Math.abs(p.y - drag.y)}px`;
    }
    const right = this.rightDrag;
    if (right && e.buttons & 2 && altHeld(e)) {
      const dx = e.clientX - right.x;
      const dy = e.clientY - right.y;
      right.x = e.clientX;
      right.y = e.clientY;
      // Mit Alt gezogen, wird beim Loslassen kein Befehl daraus.
      right.moved = true;
      this.canvas.style.cursor = 'ns-resize';
      if (dy !== 0) this.handlers.tilt(dy);
      // Waagerecht: je TURN_DRAG Pixel in einer Richtung eine Vierteldrehung.
      // Kleines Zucken zurück zieht nur ab, statt von vorn zu zählen.
      right.turned += dx;
      if (Math.abs(right.turned) >= TURN_DRAG) {
        this.handlers.turn(right.turned > 0 ? 1 : -1);
        right.turned = 0;
      }
      return;
    }
    if (right && e.buttons & 2) {
      const dx = e.clientX - right.x;
      const dy = e.clientY - right.y;
      if (!right.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      right.moved = true;
      this.canvas.style.cursor = 'grabbing';
      // Die Karte folgt der Maus: die Kamera geht in die Gegenrichtung.
      this.handlers.pan(-dx, -dy);
      right.x = e.clientX;
      right.y = e.clientY;
    }
  }

  private up(e: MouseEvent) {
    if (e.button === 2 && this.rightDrag) {
      const moved = this.rightDrag.moved;
      this.rightDrag = null;
      if (moved) this.handlers.panEnd();
      else if (e.target === this.canvas) this.handlers.rightClick(this.point(e));
      return;
    }
    if (e.button !== 0) return;
    this.handlers.release();
    if (!this.drag) return;
    const p = this.point(e);
    if (this.drag.active) this.handlers.box(this.drag, p, e.shiftKey);
    // e.detail zählt die Klicks kurz hintereinander - 2 ist ein Doppelklick.
    else this.handlers.click(p, e.shiftKey, e.detail >= 2);
    this.drag = null;
    this.box.hidden = true;
  }

  private wheel(e: WheelEvent) {
    e.preventDefault();
    // Zeilen bzw. Seiten (Firefox mit Mausrad) in Pixel umrechnen.
    const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 400 : 1;
    const steps = (-e.deltaY * unit) / (e.ctrlKey ? PINCH_STEP : WHEEL_STEP);
    // Höchstens eine Stufe je Ereignis - manche Mäuse melden riesige Rasten.
    this.handlers.zoom(Math.max(-1, Math.min(1, steps)), this.point(e));
  }
}
