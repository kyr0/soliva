// cameraControl.ts
// Die Kamera je Bild: mit WASD bzw. den Pfeiltasten scrollen, mit gehaltener
// Leertaste das Relief flachlegen, und hinter dem Hauptmenü zieht die Welt
// langsam vorbei.

import type { MapRenderer } from '../map';
import type { Camera } from './Camera';
import type { Keyboard } from './keyboard';

/** Relief bei gehaltener Leertaste - nie ganz 0, siehe MapRenderer.relief. */
const FLAT_RELIEF = 0.02;
/** So schnell zieht die Welt hinter dem Hauptmenü vorbei (Pixel je Sekunde). */
const TITLE_DRIFT = 24;

/**
 * Ein Bild weiter. true, wenn sich die Ansicht bewegt hat - dann liegt unter
 * dem stehenden Zeiger anderes Gelände.
 * @param scrollSpeed Kamera-Tempo aus den Einstellungen (1 = normal)
 * @param flatten Gelände flachlegen wie mit gehaltener Leertaste
 */
export function steerCamera(camera: Camera, renderer: MapRenderer, keyboard: Keyboard, dt: number, scrollSpeed: number, onTitle: boolean,
                            flatten = false): boolean {
  // Gescrollt wird in Bildschirmrichtung, nicht entlang der Weltachsen - die
  // liegen in der Rautenansicht diagonal. Das Tempo ist in Tiles je Sekunde
  // gleich, aber auf 3200 Pixel je Sekunde gedeckelt: ganz nah heran zoomt
  // man, um genau hinzusehen - dort flöge die Karte sonst in einem
  // Zehntel einer Sekunde vorbei.
  const speed = Math.min(400 * (camera.tileSize / 4), 3200) * dt * scrollSpeed;
  let dx = 0;
  let dy = 0;
  if (keyboard.isDown('w', 'arrowup')) dy -= speed;
  if (keyboard.isDown('s', 'arrowdown')) dy += speed;
  if (keyboard.isDown('a', 'arrowleft')) dx -= speed;
  if (keyboard.isDown('d', 'arrowright')) dx += speed;
  if (onTitle) dx += TITLE_DRIFT * dt;

  // Leertaste halten: Relief sinkt flach, um hinter Berge zu sehen. Weich
  // überblendet, damit man sieht, was wohin gehört. `flatten`: dasselbe von
  // selbst, wenn Gelände den angeschauten Punkt verdeckt (main.ts, autoFlat).
  const target = keyboard.isDown(' ') || flatten ? FLAT_RELIEF : 1;
  const before = renderer.relief;
  renderer.relief += (target - renderer.relief) * Math.min(1, dt * 10);
  if (Math.abs(target - renderer.relief) < 0.002) renderer.relief = target;

  if (dx === 0 && dy === 0 && renderer.relief === before) return false;
  camera.panPixels(dx, dy);
  return true;
}
