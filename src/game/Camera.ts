// Camera.ts
// Die Kamera: welches Welt-Tile in der Bildmitte liegt, wie weit gezoomt ist
// (Zoomstufen) und wie groß die Sichtfläche ist. Sichtfläche, Zoom und
// Mauskoordinaten rechnen in CSS-Pixeln; der Canvas-Speicher ist um
// `pixelRatio` größer.

import { centerFor, panDelta, type IsoView } from '../gl/iso';

/**
 * Zoom als Zweierlogarithmus der CSS-Pixel je Welt-Tile: 3 = 8 px, 7 = 128 px.
 * Ganze Zahlen sind die Zoomstufen - im Spiel "Zoom 1" (weit draußen) bis
 * "Zoom 5" (ganz nah), angezeigt unter der Minimap. Verdopplung je Stufe: die
 * Schrittweite der Abtastung ist dort immer eine Zweierpotenz. Dazwischen
 * gleitet der Zoom nur hindurch und kommt immer auf einer Stufe zur Ruhe.
 * Erst die letzte Stufe (128) zeigt die Dorfbewohner groß genug für ihre Details.
 */
const MIN_ZOOM = 3;
const MAX_ZOOM = 7;
/** Die Zoomstufen in CSS-Pixeln je Tile (Zoom 1 bis 5). */
export const ZOOM_LEVELS = Array.from({ length: MAX_ZOOM - MIN_ZOOM + 1 }, (_, i) => 2 ** (MIN_ZOOM + i));
/** Wie schnell der Zoom seinem Ziel folgt (je Sekunde) - nach 0,2 s ist er fast da. */
const ZOOM_RATE = 18;
/** So lange nach der letzten Eingabe (ms) rastet das Ziel auf eine Stufe ein. */
const ZOOM_SETTLE = 140;
/**
 * Ab diesem Bruchteil einer Stufe in Zoomrichtung geht es zur nächsten statt
 * zurück. Klein: schon ein kurzes Wischen auf dem Trackpad ist gewollt - bei
 * einem Viertel federte es zurück. Nur ein Zucken bleibt auf der Stufe.
 */
const ZOOM_COMMIT = 0.04;

export class Camera {
  /** Welt-Tile in der Bildmitte. */
  x = 0;
  y = 0;
  /** Sichtfläche in CSS-Pixeln. */
  width = 0;
  height = 0;
  /** Geräte-Pixel je CSS-Pixel. */
  pixelRatio = 1;
  /** Jetziger Zoom (siehe MIN_ZOOM) - gleitet mit jedem Bild zum Ziel. */
  zoom: number;
  /** Wohin der Zoom gleitet. */
  private targetZoom: number;
  /** Zeitpunkt der letzten Zoom-Eingabe (performance.now) und ihre Richtung. */
  private lastInput = 0;
  private lastDirection = 0;

  constructor(pixelsPerTile: number) {
    this.zoom = this.targetZoom = clampZoom(Math.round(Math.log2(pixelsPerTile)));
  }

  /** CSS-Pixel je Tile beim jetzigen Zoom. */
  get tileSize(): number {
    return 2 ** this.zoom;
  }

  /** CSS-Pixel je Tile am Zoomziel - dorthin gleitet die Kamera gerade. */
  get targetTileSize(): number {
    return 2 ** this.targetZoom;
  }

  /** Die Zoomstufe, wie das Spiel sie zeigt: 1 (weit draußen) bis 5 (ganz nah) - die, auf der der Zoom einrastet. */
  get zoomNumber(): number {
    return Math.round(this.targetZoom) - MIN_ZOOM + 1;
  }

  /**
   * Zoomziel um `steps` Stufen verschieben - auch Bruchteile (Trackpad). Die
   * Kamera gleitet mit stepZoom() dorthin.
   */
  zoomBy(steps: number) {
    if (steps === 0) return;
    this.targetZoom = clampZoom(this.targetZoom + steps);
    this.lastInput = performance.now();
    this.lastDirection = Math.sign(steps);
  }

  /**
   * Ein Bild weiter: der Zoom folgt dem Ziel weich (Lerp, unabhängig von der
   * Bildrate); nach der letzten Eingabe rastet das Ziel auf eine Stufe ein.
   * false, wenn sich nichts geändert hat.
   */
  stepZoom(dt: number, now: number): boolean {
    if (now - this.lastInput > ZOOM_SETTLE && !Number.isInteger(this.targetZoom)) {
      const t = this.targetZoom;
      this.targetZoom = clampZoom(this.lastDirection < 0 ? Math.floor(t + ZOOM_COMMIT) : Math.ceil(t - ZOOM_COMMIT));
    }
    if (this.zoom === this.targetZoom) return false;
    this.zoom += (this.targetZoom - this.zoom) * (1 - Math.exp(-ZOOM_RATE * dt));
    if (Math.abs(this.targetZoom - this.zoom) < 0.002) this.zoom = this.targetZoom;
    return true;
  }

  /** Die Ansicht für die Umrechnung Welt ↔ Bildschirm (gl/iso.ts). */
  view(): IsoView {
    return { centerX: this.x, centerY: this.y, tileSize: this.tileSize, width: this.width, height: this.height };
  }

  /** Mitte der Sichtfläche in CSS-Pixeln. */
  get centerX(): number {
    return this.width / 2;
  }

  get centerY(): number {
    return this.height / 2;
  }

  /** Nimmt die Größe des Fensters und die Pixeldichte des Geräts an. */
  fitWindow() {
    this.pixelRatio = window.devicePixelRatio || 1;
    this.width = window.innerWidth;
    this.height = window.innerHeight;
  }

  /** Verschiebt um (dx, dy) CSS-Pixel auf dem Bildschirm - nicht entlang der Weltachsen. */
  panPixels(dx: number, dy: number) {
    const d = panDelta(this.tileSize, dx, dy);
    this.x += d.x;
    this.y += d.y;
  }

  /**
   * Legt den Welt-Punkt (x, y, Höhe z) auf die Bildschirmstelle (px, py) -
   * ohne Angabe in die Bildmitte.
   */
  centerOn(x: number, y: number, z: number, px = this.centerX, py = this.centerY) {
    const center = centerFor(this.view(), x, y, z, px, py);
    this.x = center.x;
    this.y = center.y;
  }

  /** Springt auf das Tile (x, y) - ohne Rücksicht auf die Geländehöhe. */
  moveTo(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
}

function clampZoom(zoom: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
}
