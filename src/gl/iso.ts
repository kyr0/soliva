// iso.ts
// Isometrische Projektion wie in AoE2: Blick schräg von oben, 30° über dem
// Horizont, Tiles werden zu Rauten im Verhältnis 2:1.
//
// Zwischen Welt und Bildschirm liegen die "Boden-Koordinaten":
//   u = x - y         -> waagerecht auf dem Bildschirm
//   v = (x + y) / 2   -> senkrecht, nach unten
// Ein Tile ist damit 2*tileSize breit und tileSize hoch - dieselbe Fläche wie
// das Quadrat der Draufsicht. Höhe z (in Tiles) schiebt einen Punkt um
// Z_SCREEN * z nach oben.
//
// CPU-Fassung (Mauszeiger, Kamera) und GLSL-Fassung (PROJECT_GLSL) müssen
// dieselbe Abbildung beschreiben.

import { TERRAIN_PARAMS } from '../noise';

/**
 * Bildhöhe einer senkrechten Tile-Länge, in Einheiten von v. Bei 30°
 * Blickwinkel ist das cos(30°) / sin(30°) * (1/√2) = √6 / 2.
 */
export const Z_SCREEN = Math.sqrt(6) / 2;

/**
 * Blickwinkel über dem Horizont (Radiant). Im Spiel anfangs 30° wie in AoE2;
 * mit Alt und rechter Maustaste bzw. Alt und Pfeiltasten lässt er sich
 * zwischen TILT_MIN und TILT_MAX neigen. Die Galerie neigt die Kamera
 * weiter, um Modelle auch von oben oder flach von der Seite zu zeigen.
 * Daraus folgen zwei Maße: wie stark der Boden senkrecht gestaucht wird
 * (groundV, bei 30° genau 1/2) und wie hoch eine senkrechte Tile-Länge im
 * Bild ist (zScreen, bei 30° genau Z_SCREEN).
 */
let elevation = Math.PI / 6;
let groundV = 0.5;
let zScreen = Z_SCREEN;

export function viewElevation(): number {
  return elevation;
}

/** Senkrechte Stauchung des Bodens beim jetzigen Blickwinkel (sin(elevation)). */
export function viewGroundV(): number {
  return groundV;
}

/** Bildhöhe einer senkrechten Tile-Länge beim jetzigen Blickwinkel, in Einheiten von v. */
export function viewZScreen(): number {
  return zScreen;
}

/** Blickwinkel im Spiel: Vorgabe wie in AoE2 und wie weit man neigen kann. */
export const TILT_DEFAULT = Math.PI / 6;
export const TILT_MIN = (20 * Math.PI) / 180;
export const TILT_MAX = (70 * Math.PI) / 180;
/**
 * zScreen beim flachsten Blickwinkel im Spiel - das Höchste, was die Gipfel
 * von unten ins Bild ragen können. Der Gelände-Cache richtet seine Größe
 * danach, damit er beim Neigen nicht neu angelegt werden muss.
 */
export const Z_SCREEN_MAX = Math.SQRT2 * Math.cos(TILT_MIN);

/** Blickwinkel setzen - zwischen fast waagerecht und fast senkrecht. */
export function setViewElevation(rad: number) {
  elevation = Math.min(Math.PI / 2 - 0.02, Math.max(0.05, rad));
  groundV = Math.sin(elevation);
  zScreen = Math.SQRT2 * Math.cos(elevation);
}

/** Höchster möglicher Punkt des Geländes in Tiles. */
export const MAX_RELIEF = TERRAIN_PARAMS.reliefHeight;

/** Was die Shader über die Kamera wissen müssen. */
export interface GpuCamera {
  /** Welt-Tile in der Bildmitte. */
  centerX: number;
  centerY: number;
  /** Geräte-Pixel je Einheit von u bzw. v. */
  pixelsPerTile: number;
  /**
   * Maßstab des Gelände-Caches, falls er vom Bild abweicht: beim weichen
   * Zoomen bleibt der Cache auf der nächstkleineren Zoomstufe und wird nur
   * gestreckt, statt je Bild neu berechnet zu werden. Ohne Angabe wie
   * pixelsPerTile.
   */
  cachePixelsPerTile?: number;
  /** Maßstäbe, für die der Gelände-Cache im Hintergrund vorberechnet wird (kleinere Zoomstufen). */
  prefetchPixelsPerTile?: number[];
  /**
   * Bodenstauchung (groundV), für die der Gelände-Cache berechnet ist, falls
   * sie vom jetzigen Blickwinkel abweicht: beim Neigen bleibt der Cache stehen
   * und wird nur senkrecht gestreckt. Ohne Angabe der jetzige Blickwinkel.
   */
  cacheGroundV?: number;
  /** 1 = volles Relief, 0 = flach (Minimap). */
  reliefScale: number;
}

/** Sichtbarer Ausschnitt in CSS-Pixeln - für alles, was mit der Maus zu tun hat. */
export interface IsoView {
  centerX: number;
  centerY: number;
  /** CSS-Pixel je Einheit von u bzw. v. */
  tileSize: number;
  width: number;
  height: number;
}

/**
 * Blickrichtung in Vierteldrehungen (0..3). Die Welt wird vor der Projektion
 * um k * 90° gedreht - Kamera, Mausabfrage und Shader lesen alle diesen Wert.
 * Gebäude und Bäume behalten ihre Ausrichtung in der Welt; nach dem Drehen
 * sieht man sie von einer anderen Seite.
 */
let rotation = 0;

export function viewRotation(): number {
  return rotation;
}

export function setViewRotation(k: number) {
  rotation = ((k % 4) + 4) % 4;
}

/** Dreht einen Welt-Vektor um k Vierteldrehungen gegen den Uhrzeigersinn. */
function rotate(x: number, y: number, k: number): [number, number] {
  switch (k) {
    case 1: return [-y, x];
    case 2: return [-x, -y];
    case 3: return [y, -x];
    default: return [x, y];
  }
}

/** Welt -> Boden-Koordinaten (u, v) in der aktuellen Blickrichtung. */
export function worldToGround(x: number, y: number): { u: number; v: number } {
  const [a, b] = rotate(x, y, rotation);
  return { u: a - b, v: (a + b) * groundV };
}

export function groundToWorld(u: number, v: number): { x: number; y: number } {
  const s = v / groundV;
  const [x, y] = rotate((s + u) / 2, (s - u) / 2, (4 - rotation) % 4);
  return { x, y };
}

/**
 * Richtung zur Kamera in Weltkoordinaten - in der Grundstellung (1, 1, 1/Z).
 * Die Modelle drehen damit ihre Flächennormalen zur Kamera.
 */
export function cameraDirection(): [number, number, number] {
  const [x, y] = rotate(1, 1, (4 - rotation) % 4);
  return [x, y, Math.SQRT2 * Math.tan(elevation)];
}

/** Welt -> Bildschirm (CSS-Pixel ab links oben). */
export function worldToScreen(view: IsoView, x: number, y: number, z: number) {
  const p = worldToGround(x, y);
  const c = worldToGround(view.centerX, view.centerY);
  const du = p.u - c.u;
  const dv = p.v - c.v;
  return {
    x: view.width / 2 + du * view.tileSize,
    y: view.height / 2 + (dv - zScreen * z) * view.tileSize,
  };
}

/** Bildschirmpunkt auf Meereshöhe - ohne Relief, für Minimap und Kamera. */
export function screenToGround(view: IsoView, px: number, py: number) {
  const du = (px - view.width / 2) / view.tileSize;
  const dv = (py - view.height / 2) / view.tileSize;
  const d = groundToWorld(du, dv);
  return { x: view.centerX + d.x, y: view.centerY + d.y };
}

/**
 * Welt-Punkt unter einem Bildschirmpunkt, mit Relief. Der Sehstrahl wird von
 * oben (höchstmöglicher Gipfel) nach unten abgelaufen; der erste Punkt, an dem
 * das Gelände über dem Strahl liegt, ist der sichtbare. Danach Bisektion.
 *
 * @param zAt Geländehöhe in Tiles an einer Welt-Position
 */
export function pickWorld(
    view: IsoView, px: number, py: number,
    zAt: (x: number, y: number) => number,
): { x: number; y: number; z: number } {
  const du = (px - view.width / 2) / view.tileSize;
  const dv = (py - view.height / 2) / view.tileSize;
  const at = (z: number) => {
    const d = groundToWorld(du, dv + zScreen * z);
    return { x: view.centerX + d.x, y: view.centerY + d.y };
  };
  const above = (z: number) => {
    const p = at(z);
    return zAt(p.x, p.y) >= z;
  };

  // Schrittweite ~ ein Viertel Tile entlang des Strahls
  const step = 0.2;
  let hi: number = MAX_RELIEF;
  let lo = hi;
  let hit = false;
  for (let z = MAX_RELIEF; z >= 0; z -= step) {
    if (above(z)) {
      lo = z;
      hit = true;
      break;
    }
    hi = z;
  }
  if (!hit) return { ...at(0), z: 0 };

  for (let i = 0; i < 8; i++) {
    const mid = (lo + hi) / 2;
    if (above(mid)) lo = mid;
    else hi = mid;
  }
  return { ...at(lo), z: lo };
}

/**
 * Kamera so setzen, dass der Welt-Punkt (x, y, z) am Bildschirmpunkt (px, py)
 * erscheint. Liefert die neue Bildmitte.
 */
export function centerFor(view: IsoView, x: number, y: number, z: number, px: number, py: number) {
  const du = (px - view.width / 2) / view.tileSize;
  const dv = (py - view.height / 2) / view.tileSize + zScreen * z;
  const d = groundToWorld(du, dv);
  return { x: x - d.x, y: y - d.y };
}

/** Umschließendes Welt-Rechteck des Bildschirms, inkl. Gelände, das von unten hereinragt. */
export function visibleWorldRect(view: IsoView) {
  const hu = view.width / 2 / view.tileSize;
  const hv = view.height / 2 / view.tileSize;
  const corners = [
    groundToWorld(-hu, -hv),
    groundToWorld(hu, -hv),
    groundToWorld(-hu, hv + zScreen * MAX_RELIEF),
    groundToWorld(hu, hv + zScreen * MAX_RELIEF),
  ];
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  return {
    x: view.centerX + x0,
    y: view.centerY + y0,
    width: Math.max(...xs) - x0,
    height: Math.max(...ys) - y0,
  };
}

/** Bildschirm-Verschiebung (CSS-Pixel) -> Welt-Verschiebung auf Meereshöhe. */
export function panDelta(tileSize: number, dx: number, dy: number) {
  return groundToWorld(dx / tileSize, dy / tileSize);
}

/**
 * Tiefenbereich in v-Einheiten. Muss alles zwischen dem obersten Bildrand und
 * dem Gipfel am unteren Rand abdecken - sonst schneidet die Clipping-Ebene
 * Gelände ab.
 */
export function depthRange(camera: GpuCamera, heightPx: number): number {
  return heightPx / 2 / camera.pixelsPerTile + 3 * zScreen * MAX_RELIEF + 8;
}

/**
 * Rastet die Kamera auf das Texelraster des Gelände-Caches ein. Dann fällt auf
 * ebenem Boden jede Pixelmitte genau auf eine Texelmitte, und die Karte bleibt
 * so scharf wie ohne Cache - sonst mittelt die Texturfilterung je nach
 * Kameralage bis zu vier Texel zusammen. Der Versatz ist kleiner als ein Pixel.
 */
export function snapCamera(camera: GpuCamera, widthPx: number, heightPx: number): GpuCamera {
  const ppt = camera.pixelsPerTile;
  const snap = (texel: number, size: number) => (Math.round(texel - size / 2) + size / 2) / ppt;
  const g = worldToGround(camera.centerX, camera.centerY);
  const u = snap(g.u * ppt, widthPx);
  const v = snap(g.v * ppt, heightPx);
  const center = groundToWorld(u, v);
  return { ...camera, centerX: center.x, centerY: center.y };
}

/**
 * Blickrichtung und Blickwinkel für PROJECT_GLSL - auch für Durchgänge ohne
 * Kamera (der Gelände-Cache): ohne uGroundV teilte groundToWorld durch null.
 */
export function setViewUniforms(gl: WebGL2RenderingContext, location: (name: string) => WebGLUniformLocation | null) {
  gl.uniform1i(location('uRotation'), rotation);
  gl.uniform1f(location('uGroundV'), groundV);
  gl.uniform1f(location('uZScreen'), zScreen);
}

/**
 * Kamera-Uniforms für PROJECT_GLSL.
 * @param size Größe der Zeichenfläche - sonst das Canvas (z. B. ein Ausschnitt eines Framebuffers)
 */
export function setCameraUniforms(
    gl: WebGL2RenderingContext,
    location: (name: string) => WebGLUniformLocation | null,
    camera: GpuCamera,
    size: { width: number; height: number } = gl.canvas,
) {
  const { width, height } = size;
  gl.uniform2f(location('uResolution'), width, height);
  const g = worldToGround(camera.centerX, camera.centerY);
  gl.uniform2f(location('uCameraGround'), g.u, g.v);
  setViewUniforms(gl, location);
  gl.uniform1f(location('uPixelsPerTile'), camera.pixelsPerTile);
  gl.uniform1f(location('uReliefScale'), camera.reliefScale);
  gl.uniform1f(location('uDepthRange'), depthRange(camera, height));
}

/** Welt (x, y, z) -> Clip-Space. Gegenstück zu worldToScreen(). */
export const PROJECT_GLSL = `
uniform vec2  uResolution;
uniform vec2  uCameraGround;   // (u, v) der Bildmitte
uniform float uPixelsPerTile;  // Geraete-Pixel je u/v-Einheit
uniform float uDepthRange;
uniform float uReliefScale;    // 1 = volles Relief, 0 = flach
uniform int   uRotation;       // Blickrichtung in Vierteldrehungen, siehe viewRotation()
uniform float uGroundV;        // Stauchung des Bodens, bei 30° Blickwinkel 1/2 (viewElevation)
uniform float uZScreen;        // Bildhöhe einer senkrechten Tile-Länge, bei 30° Z_SCREEN

// Welt um k Vierteldrehungen drehen - wie rotate() in iso.ts.
vec2 rotateQuarter(vec2 p, int k) {
  if (k == 1) return vec2(-p.y, p.x);
  if (k == 2) return -p;
  if (k == 3) return vec2(p.y, -p.x);
  return p;
}

// Boden-Koordinaten (u, v) -> Welt, in der aktuellen Blickrichtung.
vec2 groundToWorld(vec2 g) {
  float s = g.y / uGroundV;
  return rotateQuarter(vec2((s + g.x) * 0.5, (s - g.x) * 0.5), (4 - uRotation) % 4);
}

vec4 project(vec2 world, float z) {
  vec2 r = rotateQuarter(world, uRotation);
  vec2 g = vec2(r.x - r.y, (r.x + r.y) * uGroundV) - uCameraGround;
  vec2 px = vec2(g.x, g.y - uZScreen * z) * uPixelsPerTile;
  // Naeher an der Kamera = weiter unten im Bild und hoeher.
  float depth = -(g.y + uZScreen * z) / uDepthRange;
  return vec4(px.x / (uResolution.x * 0.5), -px.y / (uResolution.y * 0.5), depth, 1.0);
}
`;
