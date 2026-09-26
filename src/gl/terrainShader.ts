// terrainShader.ts
// GLSL-Portierung der Geländeerzeugung aus noise.ts und der Einfärbung aus
// map.ts. Der Shader ist die Bildquelle; die TypeScript-Fassung bleibt für die
// Tile-Anzeige unter dem Mauszeiger bestehen. Beide lesen dieselben Regler
// (TERRAIN_PARAMS) und dieselben Permutationstabellen, damit sie dieselbe Welt
// beschreiben.

import { PROJECT_GLSL } from './iso';
import { FLATTEN_GLSL } from '../world/flatten';

/**
 * Rauschen und Höhenfunktion. Steht im Vertex-Shader (Relief) und im
 * Fragment-Shader (Farbe) - dieselben Uniforms, dasselbe Gelände.
 * Auch der EntityRenderer bindet es ein, um Gebäude aufs Gelände zu setzen.
 */
export const TERRAIN_COMMON = `
// Fertige Gradienten-Indizes je Gitterzelle, eine Ebene je Rauschquelle.
uniform highp usampler2DArray uGrad;

uniform float uMapScale;
uniform float uWarpStrength;
uniform float uDetailFrequency;
uniform float uDetailStrength;
uniform float uMicroFrequency;
uniform float uMicroStrength;
uniform float uMicroPersistence;
uniform int   uMicroOctaves;
uniform float uMicroMinSamples;
uniform float uFringeFrequency;
uniform float uFringeStrength;
uniform float uRidgeStart;
uniform float uRidgeStrength;
uniform float uShadeGain;
uniform float uLapseRate;
uniform float uDeepWaterLevel;
uniform float uSeaLevel;
uniform float uShoreLevel;
uniform float uHillLevel;
uniform float uPeakLevel;
uniform float uSnowTemperature;
uniform float uTundraTemperature;
uniform float uReliefHeight;
uniform float uReliefExponent;
uniform float uLowlandRelief;
uniform float uLowlandShade;
uniform float uMountainFoot;

// Ebenen in der Permutations-Textur (Reihenfolge = NOISE_LAYERS)
const int L_HEIGHT = 0;
const int L_RELIEF = 1;
const int L_MICRO = 2;
const int L_FRINGE = 3;
const int L_MOIST = 4;
const int L_TEMP = 5;
const int L_WARP = 6;
const int L_RIDGE = 7;
const int L_DETAIL = 8;


const float F2 = 0.3660254037844386;
const float G2 = 0.21132486540518713;
const float SIMPLEX_SD = 0.44;

const float GRAD_X[12] = float[12](1., -1., 1., -1., 1., -1., 1., -1., 0., 0., 0., 0.);
const float GRAD_Y[12] = float[12](1., 1., -1., -1., 0., 0., 0., 0., 1., -1., 1., -1.);

int gradIndex(int layer, int ii, int jj) {
  return int(texelFetch(uGrad, ivec3(ii & 255, jj & 255, layer), 0).r);
}

// 1:1 die noise2D aus noise.ts
float snoise(int layer, vec2 v) {
  float s = (v.x + v.y) * F2;
  float fi = floor(v.x + s);
  float fj = floor(v.y + s);
  float t = (fi + fj) * G2;
  float x0 = v.x - (fi - t);
  float y0 = v.y - (fj - t);

  float i1 = x0 > y0 ? 1.0 : 0.0;
  float j1 = x0 > y0 ? 0.0 : 1.0;

  float x1 = x0 - i1 + G2;
  float y1 = y0 - j1 + G2;
  float x2 = x0 - 1.0 + 2.0 * G2;
  float y2 = y0 - 1.0 + 2.0 * G2;

  int ii = int(fi) & 255;
  int jj = int(fj) & 255;
  int gi0 = gradIndex(layer, ii, jj);
  int gi1 = gradIndex(layer, ii + int(i1), jj + int(j1));
  int gi2 = gradIndex(layer, ii + 1, jj + 1);

  float n = 0.0;
  float t0 = 0.5 - x0 * x0 - y0 * y0;
  if (t0 >= 0.0) { t0 *= t0; n += t0 * t0 * (GRAD_X[gi0] * x0 + GRAD_Y[gi0] * y0); }
  float t1 = 0.5 - x1 * x1 - y1 * y1;
  if (t1 >= 0.0) { t1 *= t1; n += t1 * t1 * (GRAD_X[gi1] * x1 + GRAD_Y[gi1] * y1); }
  float t2 = 0.5 - x2 * x2 - y2 * y2;
  if (t2 >= 0.0) { t2 *= t2; n += t2 * t2 * (GRAD_X[gi2] * x2 + GRAD_Y[gi2] * y2); }
  return 70.0 * n;
}

// FractalNoise.raw: auf Standardabweichung 1 normiert
float fbmRaw(int layer, vec2 p, int octaves, float persistence) {
  float total = 0.0;
  float amplitude = 1.0;
  float frequency = 1.0;
  float sumSq = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    total += snoise(layer, p * frequency) * amplitude;
    sumSq += amplitude * amplitude;
    amplitude *= persistence;
    frequency *= 2.0;
  }
  return total / (SIMPLEX_SD * sqrt(sumSq));
}

// FractalNoise.noise2D: weich auf -1..1 begrenzt
float fbm(int layer, vec2 p, int octaves, float persistence) {
  return tanh(fbmRaw(layer, p, octaves, persistence) * 0.85);
}

// RidgedNoise.noise2D, 0..1
float ridgedNoise(vec2 p, int octaves, float persistence) {
  float total = 0.0;
  float amplitude = 1.0;
  float frequency = 1.0;
  float maxValue = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    float n = 1.0 - abs(snoise(L_RIDGE, p * frequency));
    total += n * n * amplitude;
    maxValue += amplitude;
    amplitude *= persistence;
    frequency *= 2.0;
  }
  return total / maxValue;
}

float microDetail(vec2 n, float step) {
  float total = 0.0;
  float frequency = uMicroFrequency;
  float amplitude = uMicroStrength;
  for (int i = 0; i < 8; i++) {
    if (i >= uMicroOctaves) break;
    float samples = 1.0 / (frequency * uMapScale * step);
    if (samples < uMicroMinSamples) break;
    float fade = min(1.0, (samples - uMicroMinSamples) / uMicroMinSamples);
    total += snoise(L_MICRO, n * frequency) * amplitude * fade;
    frequency *= 2.0;
    amplitude *= uMicroPersistence;
  }
  return total;
}

float elevation(vec2 n, float step) {
  float wx = fbmRaw(L_WARP, n + vec2(5.2, 1.3), 2, 0.5);
  float wy = fbmRaw(L_WARP, n + vec2(-3.7, 8.1), 2, 0.5);
  vec2 w = n + vec2(wx, wy) * uWarpStrength;

  float base = fbmRaw(L_HEIGHT, w, 4, 0.5);
  float coarse = tanh(base * 0.85);

  // Unter Wasser wird das Feindetail ausgeblendet (smoothstep == s*s*(3-2s))
  float weight = smoothstep(0.0, 1.0,
      (coarse - uDeepWaterLevel) / (uShoreLevel - uDeepWaterLevel));

  float fine = fbmRaw(L_RELIEF, n * uDetailFrequency, 4, 0.5) * uDetailStrength;
  fine += microDetail(n, step);

  float land = tanh((base + fine * weight) * 0.85);
  if (land <= uRidgeStart) return land;

  float t = (land - uRidgeStart) / (1.0 - uRidgeStart);
  float ridge = ridgedNoise(w * 2.2, 4, 0.5);
  return min(1.0, land + t * t * (ridge - 0.35) * uRidgeStrength);
}

// Hoehe ueber dem Meer in Tiles - Gegenstueck zu reliefZ() in noise.ts.
// Wasser ist flach.
float reliefZ(float h) {
  if (h <= uSeaLevel) return 0.0;
  float low = min(1.0, (h - uSeaLevel) / (uMountainFoot - uSeaLevel));
  float high = max(0.0, (h - uMountainFoot) / (1.0 - uMountainFoot));
  return uLowlandRelief * low + (uReliefHeight - uLowlandRelief) * pow(high, uReliefExponent);
}
`;

/**
 * Lage des Farb-Caches. Er liegt in Boden-Koordinaten (u, v), ein Texel je
 * Geraete-Pixel, und ist ein Ringpuffer: das Fenster wandert mit der Kamera,
 * Texel werden reihum wiederverwendet.
 */
const CACHE_GLSL = `
uniform vec2 uWindowStart;  // (u, v) der Fenster-Ecke
uniform vec2 uWindowMod;    // wo diese Ecke in der Textur liegt, in Texeln
uniform vec2 uCacheSize;    // Texturgroesse in Texeln
`;

/**
 * Nur beim Zeichnen: Texel je u/v-Einheit - beim weichen Zoomen ungleich
 * uPixelsPerTile. Dazu der alte Cache, der beim Wechsel der Zoomstufe
 * stehen bleibt, bis der neue fertig ist (siehe TerrainRenderer.previous).
 */
const CACHE_SCALE_GLSL = `
uniform float uCacheScale;
uniform float uCacheStretch;     // Bodenstauchung des Caches / jetzige (Neigen)
uniform vec2  uPrevWindowStart;  // (u, v) der Fenster-Ecke des alten Caches
uniform float uPrevCacheScale;   // seine Texel je u/v-Einheit
uniform float uPrevStretch;      // seine Bodenstauchung / jetzige
`;

/**
 * Das Gelände ist ein Gitter, das auf dem Bildschirm gleichmäßig liegt (in
 * Boden-Koordinaten u/v, siehe iso.ts). Jeder Eckpunkt wird ins Weltsystem
 * zurückgerechnet und um seine Höhe angehoben. Die Eckpunkte hängen am
 * Weltraster, nicht am Bildschirm - sonst würde das Relief beim Verschieben
 * der Kamera schwimmen.
 */
export const VERTEX_SOURCE = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2DArray;

${TERRAIN_COMMON}
${PROJECT_GLSL}
${FLATTEN_GLSL}

uniform vec2  uGridOrigin;  // (u, v) des ersten Eckpunkts
uniform float uGridCell;    // Zellgroesse in u/v-Einheiten
uniform int   uGridColumns;
${CACHE_GLSL}
${CACHE_SCALE_GLSL}

out vec2 vWorld;
out vec2 vCache;            // normierte Koordinate im Farb-Cache
out vec2 vPrevTexel;        // Texel im alten Cache ab seiner Fenster-Ecke

void main() {
  int col = gl_VertexID % uGridColumns;
  int row = gl_VertexID / uGridColumns;
  vec2 g = uGridOrigin + vec2(float(col), float(row)) * uGridCell;
  vec2 world = groundToWorld(g);

  float z = 0.0;
  if (uReliefScale > 0.0) {
    // Mit der Zellgroesse als Abtastschritt: Feinoktaven, die das Gitter
    // nicht aufloesen kann, bleiben aus dem Relief heraus.
    z = reliefZ(elevation(world * uMapScale, uGridCell)) * uReliefScale;
    // Unter Gebäuden eben (siehe world/flatten.ts).
    z = flattenZ(world, z);
  }
  vWorld = world;
  // Ringpuffer: Texturkoordinaten laufen ueber den Rand hinaus, REPEAT
  // faltet sie zurueck.
  // Beim Neigen liegt der Cache in seiner eigenen Stauchung: nur v streckt sich.
  vCache = ((vec2(g.x, g.y * uCacheStretch) - uWindowStart) * uCacheScale + uWindowMod) / uCacheSize;
  vPrevTexel = (vec2(g.x, g.y * uPrevStretch) - uPrevWindowStart) * uPrevCacheScale;
  gl_Position = project(world, z);
}
`;

/** Vollbild-Dreieck für das Befüllen des Caches - begrenzt wird per Scissor. */
export const FILL_VERTEX_SOURCE = `#version 300 es
in vec2 aPosition;
void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

/**
 * Die eigentliche Geländeerzeugung. Läuft nicht mehr je Bild, sondern nur für
 * Texel, die neu ins Fenster kommen - beim Verschieben ein schmaler Streifen,
 * beim Zoomen einmal das ganze Fenster.
 */
export const FILL_FRAGMENT_SOURCE = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2DArray;

out vec4 fragColor;

${TERRAIN_COMMON}
${PROJECT_GLSL}
${CACHE_GLSL}

/**
 * Bezugsgröße für Feindetail und Farbtextur, in Geräte-Pixeln. Abgetastet wird
 * je Pixel, aber Mikro-Oktaven und Farbrauschen richten sich bewusst nach einer
 * etwas gröberen Marke - sonst werden sie mit steigender Pixeldichte immer
 * feiner und die Biom-Ränder fangen an zu grieseln.
 */
uniform float uDetailPixels;
// Ab so vielen Geräte-Pixeln je Tile stehen die Blumen als 3D-Objekte in der
// Wiese (world/flowers.ts) - dann malt das Gelände sie nicht mehr.
uniform float uFlowerObjectPixels;
// Nur für den Abgleich mit der CPU-Fassung: 1 = Höhe, 2 = Hangneigung,
// jeweils als 16-Bit-Wert über R und G gepackt.
uniform int uDebug;

uniform vec3 uBiomeLo[8];
uniform vec3 uBiomeHi[8];
uniform vec3 uWaterRamp[4];
uniform vec3 uSurf;


// Biome (Reihenfolge = TILE_TYPE_GRADIENT)
const int B_DEEP_WATER = 0;
const int B_WATER = 1;
const int B_BEACH = 2;
const int B_DESERT = 3;
const int B_GRASS = 4;
const int B_FOREST = 5;
const int B_MOUNTAIN = 6;
const int B_SNOW = 7;


void climate(vec2 n, float height, out float moisture, out float temperature) {
  float fringeX = fbmRaw(L_FRINGE, n * uFringeFrequency, 2, 0.5);
  float fringeY = fbmRaw(L_FRINGE, n * uFringeFrequency + vec2(31.7, -12.4), 2, 0.5);

  moisture = fbm(L_MOIST, n * 0.6 + 1000.0, 4, 0.55) + fringeX * uFringeStrength;
  float raw = fbm(L_TEMP, n * 0.35 - 1000.0, 3, 0.5) + fringeY * uFringeStrength;
  temperature = raw - max(0.0, height) * uLapseRate;
}

int classify(float height, float moisture, float temperature) {
  if (height < uDeepWaterLevel) return B_DEEP_WATER;
  if (height < uSeaLevel) return B_WATER;
  if (height < uShoreLevel) return B_BEACH;
  if (height > uPeakLevel) return temperature < uSnowTemperature ? B_SNOW : B_MOUNTAIN;
  if (height > uHillLevel) return B_MOUNTAIN;
  if (temperature < uTundraTemperature) return B_SNOW;
  if (temperature > 0.25 && moisture < -0.1) return B_DESERT;
  if (moisture > 0.1) return B_FOREST;
  return B_GRASS;
}

// Höhen-Band eines Bioms - Gegenstück zu heightBand() in map.ts
vec2 heightBand(int biome) {
  if (biome == B_DEEP_WATER) return vec2(-1.0, uDeepWaterLevel);
  if (biome == B_WATER) return vec2(uDeepWaterLevel, uSeaLevel);
  if (biome == B_BEACH) return vec2(uSeaLevel, uShoreLevel);
  if (biome == B_MOUNTAIN) return vec2(uHillLevel, 1.0);
  if (biome == B_SNOW) return vec2(uPeakLevel, 1.0);
  return vec2(uShoreLevel, uHillLevel);
}

// Zufall je Zelle, 0..1 - für verstreute Blumen und Blätter.
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
vec2 hash22(vec2 p) {
  float h = hash21(p);
  return vec2(h, hash21(p + h + 17.0));
}

// Abstand zur nächsten Zellgrenze eines unregelmäßigen Zellmusters (Voronoi):
// Differenz der Abstände zum nächsten und zweitnächsten Zellpunkt.
float cellEdge(vec2 p) {
  vec2 cell = floor(p);
  float d1 = 9.0, d2 = 9.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 c = cell + vec2(float(x), float(y));
      float d = length(p - c - hash22(c));
      if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
    }
  }
  return d2 - d1;
}

// Wie viel von einem Muster der Größe size (Tiles) bei dieser Auflösung
// noch zu sehen ist: unter etwa zwei Detail-Schritten blendet es aus, sonst
// flimmert es beim Herauszoomen.
float detailFade(float size, float ds) {
  return clamp(size / ds * 0.5 - 0.5, 0.0, 1.0);
}

// Verstreute runde Tupfen: je Zelle (Kantenlänge 1/density Tiles) mit
// Wahrscheinlichkeit chance einer, Radius etwa radius. Liefert Deckung
// 0..1 und in pick eine Zufallszahl des Tupfens (für seine Farbe).
float speckle(vec2 tile, float density, float chance, float radius, out float pick) {
  vec2 cell = floor(tile * density);
  vec2 rnd = hash22(cell);
  pick = rnd.y;
  if (rnd.x >= chance) return 0.0;
  vec2 center = (cell + 0.2 + 0.6 * hash22(cell + 3.1)) / density;
  float r = radius * (0.7 + 0.6 * rnd.y);
  return smoothstep(r, r * 0.5, length(tile - center));
}

// Eine Blume je Zelle (1/4 Tile), wenn der Zufall es will: grüne Blätter,
// Blütenblätter und eine Mitte in Kontrastfarbe. Blumen wachsen in Gruppen,
// meist derselben Art; in manchen Wiesen mehr. Arten: Gänseblümchen (weiß,
// gelbe Mitte), Butterblume (gelb), Mohn (rot, schwarze Mitte), Kornblume
// (blau), Klee (rosa Köpfchen). Liefert Farbe und Deckung.
// Wie stark an diesem Pixel eine Blume, ein Stein oder eine Muschel liegt
// (0..1). Die Texturen tragen es ein, das Feinrelief spart diese Stellen aus
// - sonst liegt das Körnungsrauschen von Gras und Sand auch auf ihnen.
float gPropMask = 0.0;

// Richtung zur Sonne in der Bodenebene - wie SUN beim Relief (links oben).
const vec2 SUN_XY = vec2(-0.45, 0.35);

vec4 flower(vec2 tile, float ds, float bloom, out float shadow) {
  shadow = 0.0;
  float fade = detailFade(0.08, ds);
  if (fade <= 0.0) return vec4(0.0);
  float meadow = smoothstep(0.1, 0.6, snoise(L_DETAIL, tile * 0.04 + vec2(70.0, -30.0)));
  float group = smoothstep(0.15, 0.65, snoise(L_DETAIL, tile * 0.9 + vec2(5.0, -17.0)));
  vec2 cell = floor(tile * 4.0);
  vec2 rnd = hash22(cell);
  float chance = (0.01 + meadow * 0.05 + group * (0.12 + meadow * 0.16)) * bloom;
  if (rnd.x >= chance) return vec4(0.0);

  vec2 center = (cell + 0.25 + 0.5 * hash22(cell + 3.1)) / 4.0;
  float r = 0.05 * (0.8 + 0.45 * rnd.y);
  vec2 q = (tile - center) / r;
  float d = length(q);
  if (d > 1.7) return vec4(0.0);
  float a = atan(q.y, q.x) + rnd.y * 6.2832;
  // Wie deutlich die Form ist - weit draußen nur ein runder Tupfen.
  float sharp = detailFade(r * 0.6, ds);

  // Art: meist die der Gruppe, jede fünfte Blume eine andere.
  float kindRnd = hash21(floor(tile * 0.7) + 9.0);
  if (hash21(cell + 7.7) < 0.2) kindRnd = hash21(cell + 1.3);
  int kind = int(kindRnd * 5.0);
  vec3 petal, heart;
  float petals, heartSize;
  if (kind == 0) { petal = vec3(0.97, 0.97, 0.94); heart = vec3(0.98, 0.78, 0.15); petals = 10.0; heartSize = 0.32; }
  else if (kind == 1) { petal = vec3(1.0, 0.86, 0.12); heart = vec3(0.85, 0.62, 0.08); petals = 5.0; heartSize = 0.22; }
  else if (kind == 2) { petal = vec3(0.9, 0.16, 0.12); heart = vec3(0.12, 0.08, 0.08); petals = 4.0; heartSize = 0.26; }
  else if (kind == 3) { petal = vec3(0.3, 0.45, 0.95); heart = vec3(0.2, 0.2, 0.55); petals = 8.0; heartSize = 0.2; }
  else { petal = vec3(0.92, 0.5, 0.72); heart = vec3(0.8, 0.35, 0.58); petals = 0.0; heartSize = 0.0; }

  // Blätter: drei längliche Blätter unter der Blüte, dunkler als das Gras.
  vec2 toSun = normalize(SUN_XY);
  // Wölbung: die sonnenzugewandte Seite heller, die abgewandte dunkler.
  float facing = dot(q, toSun) / max(d, 1e-3);
  float leafRim = 1.6 * pow(abs(cos(a * 1.5 + 0.7)), 0.7);
  float leaf = smoothstep(leafRim, leafRim - 0.25, d) * sharp;
  // Mittelrippe als dunklere Linie.
  float rib = 1.0 - smoothstep(0.0, 0.12, abs(sin(a * 1.5 + 0.7)) * d);
  vec3 col = vec3(0.2, 0.38, 0.12) * (0.85 + 0.25 * facing * min(d, 1.0)) * (1.0 - rib * 0.25);
  float alpha = leaf * 0.9;
  // Schatten der Blüte, von der Sonne weg versetzt.
  vec2 qs = q + toSun * 0.45;
  shadow = smoothstep(1.0, 0.55, length(qs)) * sharp * fade;

  // Blüte: Blütenblätter als Zacken um die Mitte, Klee als rundes Köpfchen
  // aus kleinen Tupfen.
  float rim = petals > 0.0 ? mix(0.85, 0.5 + 0.5 * pow(abs(cos(a * petals * 0.5)), 0.6), sharp) : 0.8;
  float blossom = smoothstep(rim, rim - 0.12, d);
  // Blütenblätter: zur Mitte hin tiefer (dunkler), außen heller, dazu die
  // Wölbung zur Sonne und dunkle Fugen zwischen den Blättern.
  vec3 pc = petal * (0.72 + 0.3 * d) * (0.9 + 0.22 * facing * min(d, 1.0));
  if (petals > 0.0) pc *= 0.82 + 0.18 * smoothstep(0.0, 0.35, abs(cos(a * petals * 0.5)));
  if (petals == 0.0) pc *= 0.85 + 0.3 * step(0.5, fract((q.x + q.y) * 3.0) * fract((q.x - q.y) * 3.0) * 4.0);
  col = mix(col, pc, blossom);
  alpha = max(alpha, blossom);
  float h = smoothstep(heartSize, heartSize - 0.08, d) * sharp;
  // Die Mitte als kleine Kuppel mit Glanzpunkt.
  vec3 hc = heart * (0.75 + 0.45 * clamp(1.0 - length(q / max(heartSize, 1e-3) - toSun * 0.4), 0.0, 1.0));
  col = mix(col, hc, h);
  float gloss = smoothstep(0.22, 0.0, length(q - toSun * max(heartSize, 0.35) * 0.9)) * sharp;
  col = mix(col, vec3(1.0), gloss * 0.35);
  return vec4(col, alpha * fade);
}

// Wiese: große hellere und dunklere Flächen, trockene Stellen, Grasbüschel,
// einzelne Halme, ausgetretene Erde und Blumen. bloom (0..1): wie viele
// Blumen - zu Strand, Wüste, Wald und Fels hin keine.
vec3 grassTexture(vec3 c, vec2 tile, float ds, float moisture, float bloom) {
  c *= 1.0 + snoise(L_DETAIL, tile * 0.07 + vec2(11.3, 5.1)) * 0.09;
  float dry = smoothstep(0.2, 0.9, snoise(L_MICRO, tile * 0.05 + vec2(-40.0, 12.0)) - moisture * 0.8);
  c = mix(c, vec3(0.63, 0.62, 0.35), dry * 0.35);
  c *= 1.0 + snoise(L_MICRO, tile * 0.8 + vec2(3.7, -9.1)) * 0.07 * detailFade(1.2, ds);
  float blades = snoise(L_DETAIL, tile * 14.0 + vec2(-21.0, 7.0)) * detailFade(0.08, ds);
  c = mix(c, c * vec3(0.84, 0.92, 0.78), max(-blades, 0.0) * 0.35);
  c *= 1.0 + max(blades, 0.0) * 0.06;
  float worn = smoothstep(0.62, 0.8, snoise(L_MICRO, tile * 0.18 + vec2(55.0, 91.0)));
  c = mix(c, vec3(0.48, 0.40, 0.28) * (0.92 + 0.16 * blades), worn * 0.5);
  if (bloom > 0.0 && uPixelsPerTile < uFlowerObjectPixels) {
    float shadow;
    vec4 f = flower(tile, ds, bloom, shadow);
    c *= 1.0 - shadow * 0.35;
    c = mix(c, f.rgb, f.a);
    gPropMask = max(gPropMask, f.a);
  }
  return c;
}

// Feine Körnungen (etwa -1..1), scharf wie die Grashalme.
// Waldboden: Nadeln als kurze Striche in zwei Richtungen, Laub als Krümel.
float forestGrain(vec2 p, float ds, float conifer) {
  mat2 r1 = mat2(0.76, 0.64, -0.64, 0.76);
  mat2 r2 = mat2(0.62, -0.78, 0.78, 0.62);
  float needles = max(snoise(L_DETAIL, (r1 * p) * vec2(38.0, 8.0) + vec2(3.0, 1.0)),
                      snoise(L_MICRO, (r2 * p) * vec2(34.0, 7.0) + vec2(-9.0, 4.0)));
  float crumbs = snoise(L_DETAIL, p * 32.0 + vec2(13.0, 61.0)) * 0.7
      + snoise(L_MICRO, p * 14.0 + vec2(2.0, 8.0)) * 0.3;
  return mix(crumbs, needles, conifer) * detailFade(0.035, ds);
}
// Fels: feiner Grus.
float rockGrit(vec2 p, float ds) {
  return (snoise(L_DETAIL, p * 40.0 + vec2(17.0, -3.0)) * 0.55
      + snoise(L_MICRO, p * 17.0 + vec2(-8.0, 5.0)) * 0.45) * detailFade(0.03, ds);
}
// Schnee: sehr feine Körnung.
float snowGrain(vec2 p, float ds) {
  return (snoise(L_DETAIL, p * 30.0 + vec2(-2.0, 12.0)) * 0.7
      + snoise(L_MICRO, p * 12.0 + vec2(4.0, -6.0)) * 0.3) * detailFade(0.03, ds);
}

// Ein zufälliges Objekt je Zelle (Kantenlänge 1/density Tiles), wenn
// hash < chance. Liefert Mitte, Radius (aus rMin..rMax) und Zufallszahlen.
bool propCell(vec2 tile, float density, float chance, float rMin, float rMax,
              out vec2 q, out float r, out vec2 cellId) {
  cellId = floor(tile * density);
  vec2 rnd = hash22(cellId);
  if (rnd.x >= chance) return false;
  vec2 center = (cellId + 0.2 + 0.6 * hash22(cellId + 3.1)) / density;
  r = rMin + (rMax - rMin) * rnd.y;
  q = (tile - center) / r;
  return length(q) < 1.8;
}

// Waldboden: Laubblätter mit Mittelrippe, Zapfen mit Schuppen, Zweige, selten
// ein Fliegenpilz.
vec4 forestProp(vec2 tile, float ds, float conifer, out float shadow) {
  shadow = 0.0;
  float fade = detailFade(0.06, ds);
  vec2 q; float r; vec2 id;
  if (fade <= 0.0 || !propCell(tile, 3.0, 0.1, 0.035, 0.06, q, r, id)) return vec4(0.0);
  vec2 toSun = normalize(SUN_XY);
  float sharp = detailFade(r * 0.5, ds);
  float kind = hash21(id + 5.3);
  float rot = hash21(id + 6.1) * 6.2832;
  vec2 p = mat2(cos(rot), sin(rot), -sin(rot), cos(rot)) * q;
  float lit = 0.85 + 0.25 * dot(q, toSun) * 0.6;
  vec3 col; float mask;
  float mushroom = kind < 0.06 ? 1.0 : 0.0;
  bool cone = conifer > 0.4 ? kind < 0.55 : false;
  bool twig = conifer > 0.4 ? kind > 0.82 : kind > 0.78;
  if (mushroom > 0.0) {
    float d = length(q) * 1.6;
    mask = smoothstep(1.0, 0.85, d);
    col = vec3(0.85, 0.12, 0.1) * clamp(0.6 + 0.6 * dot(q * 1.6, toSun) * 0.8 + 0.3 * (1.0 - d), 0.4, 1.3);
    float dots = speckle(q * 1.6 + id, 3.0, 0.5, 0.12, rot);
    col = mix(col, vec3(0.97), dots * sharp);
    shadow = smoothstep(1.0, 0.5, length(q * 1.6 + toSun * 0.4)) * sharp * fade;
  } else if (twig) {
    mask = smoothstep(0.1, 0.05, abs(p.y + 0.08 * sin(p.x * 2.0))) * smoothstep(1.6, 1.4, abs(p.x));
    col = vec3(0.36, 0.26, 0.16) * (0.8 + 0.4 * step(0.0, p.y));
    shadow = smoothstep(0.14, 0.04, abs(p.y + 0.12 + 0.08 * sin(p.x * 2.0))) * smoothstep(1.6, 1.3, abs(p.x)) * sharp * fade;
  } else if (cone) {
    float d = length(vec2(p.x * 0.7, p.y * 1.25));
    mask = smoothstep(1.0, 0.88, d);
    float scales = 0.78 + 0.22 * step(0.45, fract(p.x * 2.5 + abs(p.y) * 1.8));
    col = vec3(0.48, 0.31, 0.17) * scales * clamp(0.6 + 0.5 * dot(q, toSun) * 0.8 + 0.3 * (1.0 - d), 0.4, 1.3);
    shadow = smoothstep(1.0, 0.5, length(vec2(p.x * 0.7, p.y * 1.25) + toSun * 0.35)) * sharp * fade;
  } else {
    // Blatt: spitz zulaufend, Mittelrippe, eine Hälfte etwas heller (gewölbt).
    float d = length(vec2(p.x, p.y * 2.1)) + abs(p.x) * 0.15;
    mask = smoothstep(1.0, 0.9, d);
    float pick = hash21(id + 8.8);
    vec3 base = pick < 0.3 ? vec3(0.78, 0.42, 0.12) : pick < 0.55 ? vec3(0.55, 0.36, 0.18)
        : pick < 0.8 ? vec3(0.82, 0.65, 0.22) : vec3(0.62, 0.22, 0.12);
    col = base * lit * (p.y > 0.0 ? 1.08 : 0.9);
    col *= 1.0 - smoothstep(0.07, 0.0, abs(p.y)) * 0.3 * sharp;
    shadow = smoothstep(1.0, 0.6, length(vec2(p.x, p.y * 2.1) + toSun * 0.25)) * sharp * fade * 0.7;
  }
  return vec4(col, mask * fade);
}

// Waldboden: dunkel und erdig, Laubstreu oder Nadeln (dort, wo Nadelbäume
// wachsen - dieselbe Höhenregel wie treeAt in resources.ts), Moos, feine
// Streu mit einzelnen Blättern und Zapfen, dunkle Mulden.
vec3 forestTexture(vec3 c, vec2 tile, float ds, float height) {
  float conifer = clamp((height + 0.1) / 0.45, 0.0, 1.0);
  c *= vec3(0.85, 0.82, 0.72);
  float litter = smoothstep(-0.2, 0.6, snoise(L_DETAIL, tile * 0.22 + vec2(101.0, 7.0)));
  c = mix(c, mix(vec3(0.42, 0.31, 0.17), vec3(0.38, 0.25, 0.16), conifer), litter * 0.55);
  float mossy = smoothstep(0.2, 0.7, snoise(L_MICRO, tile * 0.35 + vec2(-77.0, 33.0)));
  c = mix(c, vec3(0.30, 0.45, 0.18), mossy * 0.45 * (1.0 - conifer * 0.5));
  c *= 1.0 + forestGrain(tile, ds, conifer) * 0.14;
  float shadow;
  vec4 prop = forestProp(tile, ds, conifer, shadow);
  c *= 1.0 - shadow * 0.3;
  c = mix(c, prop.rgb, prop.a);
  gPropMask = max(gPropMask, prop.a);
  return c;
}

// Kleine Dinge auf dem Boden (Steine, Büsche, Muscheln): plastisch
// schattiert und mit Schatten, wie die Blumen.

// Unregelmäßiger, kantiger Stein wie die Steinmodelle: welliger Umriss,
// helle flache Oberseite, Seitenfacetten je nach Lage zur Sonne hell oder
// dunkel, feine Körnung. q in Steinradien, seed 0..1.
vec4 stoneShape(vec2 q, float seed, vec3 base, vec2 toSun, float sharp) {
  float a = atan(q.y, q.x);
  float R = 0.8 + 0.13 * sin(a * 3.0 + seed * 6.3) + 0.08 * sin(a * 5.0 + seed * 17.0);
  R = mix(0.9, R, sharp);
  float d = length(q);
  float mask = smoothstep(R, R - 0.08, d);
  float k = 6.0 + floor(seed * 3.0);
  float off = seed * 3.0;
  float fa = (floor((a + off) / 6.2832 * k) + 0.5) / k * 6.2832 - off;
  float side = 0.6 + 0.42 * dot(vec2(cos(fa), sin(fa)), toSun);
  float top = smoothstep(R * 0.52, R * 0.42, d) * sharp;
  vec3 col = base * mix(mix(0.9, side, sharp), 1.12, top);
  col *= 0.92 + 0.16 * hash21(floor(q * 5.0) + seed * 31.0);
  // Glanz an der Kante der Oberseite zur Sonne.
  float edge = smoothstep(0.1, 0.0, abs(d - R * 0.47)) * max(dot(q / max(d, 1e-3), toSun), 0.0) * sharp;
  return vec4(mix(col, vec3(1.0), edge * 0.25), mask);
}

// Feine Sandkörnung (etwa -1..1): viele kleine Körner, scharf wie die
// Grashalme. Für Farbe und Feinrelief.
float sandGrain(vec2 p, float ds) {
  return (snoise(L_DETAIL, p * 46.0 + vec2(-5.0, 23.0)) * 0.6
      + snoise(L_MICRO, p * 21.0 + vec2(11.0, -4.0)) * 0.4) * detailFade(0.03, ds);
}

// Sand: sanfte warme Farbverläufe, feine Körnung, glitzernde Körner.
vec3 sandSurface(vec3 c, vec2 tile, float ds) {
  c *= 1.0 + snoise(L_MICRO, tile * 0.3 + vec2(8.0, 1.0)) * 0.04;
  c = mix(c, c * vec3(1.05, 1.0, 0.9), smoothstep(-0.2, 0.6, snoise(L_DETAIL, tile * 0.12 + vec2(3.0, 3.0))) * 0.5);
  c *= 1.0 + sandGrain(tile, ds) * 0.07;
  float pick;
  float grain = speckle(tile, 10.0, 0.12, 0.015, pick) * detailFade(0.02, ds);
  c = mix(c, pick < 0.7 ? vec3(1.0, 0.97, 0.9) : c * 0.75, grain * 0.6);
  return c;
}

// Wüste: Dornbüsche aus Zweigen, Steine, gelbe Grasbüschel.
vec4 desertProp(vec2 tile, float ds, out float shadow) {
  shadow = 0.0;
  float fade = detailFade(0.08, ds);
  if (fade <= 0.0) return vec4(0.0);
  vec2 cell = floor(tile * 1.5);
  vec2 rnd = hash22(cell);
  if (rnd.x >= 0.1) return vec4(0.0);
  float kind = hash21(cell + 5.3);
  float r = kind < 0.45 ? 0.1 + 0.07 * rnd.y : kind < 0.75 ? 0.08 + 0.08 * rnd.y : 0.07 + 0.04 * rnd.y;
  vec2 center = (cell + 0.2 + 0.6 * hash22(cell + 3.1)) / 1.5;
  vec2 q = (tile - center) / r;
  float d = length(q);
  if (d > 1.8) return vec4(0.0);
  vec2 toSun = normalize(SUN_XY);
  float a = atan(q.y, q.x) + rnd.y * 6.2832;
  float sharp = detailFade(r * 0.5, ds);
  float facing = dot(q, toSun) / max(d, 1e-3);
  vec3 col;
  float mask;
  if (kind < 0.75 && kind >= 0.45) {
    // Stein: Sandstein oder grau, gewölbt.
    shadow = smoothstep(1.0, 0.5, length(q + toSun * 0.4)) * sharp * fade;
    vec3 base = hash21(cell + 2.2) < 0.5 ? vec3(0.66, 0.52, 0.38) : vec3(0.58, 0.56, 0.52);
    vec4 st = stoneShape(q, hash21(cell + 4.4), base, toSun, sharp);
    col = st.rgb;
    mask = st.a;
  } else {
    // Zweige als dünne Strahlen: Dornbusch dunkel-olivgrün, Grasbüschel gelb.
    // Zwei Lagen Zweige (lang und kurz, gegeneinander verdreht) um einen
    // dichten Kern - buschig statt dünn und spinnenartig.
    bool shrub = kind < 0.45;
    float n1 = shrub ? 6.0 : 8.0;
    float n2 = shrub ? 9.0 : 11.0;
    float ray1 = pow(abs(cos(a * n1 * 0.5)), shrub ? 3.0 : 6.0);
    float ray2 = pow(abs(cos(a * n2 * 0.5 + 1.3)), shrub ? 4.0 : 8.0);
    float len1 = 0.7 + 0.3 * hash21(vec2(floor(a * n1 / 6.2832), cell.x));
    float rim = max(ray1 * len1, ray2 * 0.72);
    rim = mix(0.8, (shrub ? 0.45 : 0.2) + (shrub ? 0.55 : 0.8) * rim, sharp);
    float core = smoothstep(shrub ? 0.55 : 0.3, shrub ? 0.42 : 0.2, d);
    mask = max(smoothstep(rim, rim - 0.1, d), core);
    shadow = smoothstep(1.0, 0.45, length(q + toSun * 0.5)) * sharp * fade * (shrub ? 0.85 : 0.45);
    float tip = clamp(d / max(rim, 0.3), 0.0, 1.0);
    col = shrub ? mix(vec3(0.36, 0.36, 0.2), vec3(0.62, 0.6, 0.36), tip)
                : mix(vec3(0.7, 0.62, 0.34), vec3(0.9, 0.82, 0.52), tip);
    col *= 0.85 + 0.3 * facing * min(d, 1.0);
  }
  return vec4(col, mask * fade);
}

// Strand: gewölbte Kiesel und gerippte Muscheln.
vec4 beachProp(vec2 tile, float ds, out float shadow) {
  shadow = 0.0;
  float fade = detailFade(0.06, ds);
  if (fade <= 0.0) return vec4(0.0);
  vec2 cell = floor(tile * 3.0);
  vec2 rnd = hash22(cell);
  if (rnd.x >= 0.05) return vec4(0.0);
  bool shell = hash21(cell + 5.3) < 0.35;
  float r = shell ? 0.04 + 0.025 * rnd.y : 0.045 + 0.05 * rnd.y;
  vec2 center = (cell + 0.2 + 0.6 * hash22(cell + 3.1)) / 3.0;
  vec2 q = (tile - center) / r;
  float d = length(q);
  if (d > 1.7) return vec4(0.0);
  vec2 toSun = normalize(SUN_XY);
  float sharp = detailFade(r * 0.5, ds);
  shadow = smoothstep(1.0, 0.5, length(q + toSun * 0.35)) * sharp * fade;
  vec3 col;
  float mask;
  if (shell) {
    // Muschel: Fächer mit Rippen, weiß, rosa oder beige.
    float rot = rnd.y * 6.2832;
    vec2 p = mat2(cos(rot), sin(rot), -sin(rot), cos(rot)) * q;
    float a = atan(p.x, p.y + 0.6);
    float fan = step(abs(a), 1.1) * smoothstep(1.3, 1.15, length(p + vec2(0.0, 0.6)));
    mask = mix(smoothstep(1.0, 0.8, d), fan, sharp);
    float pick = hash21(cell + 8.8);
    vec3 base = pick < 0.4 ? vec3(0.97, 0.95, 0.9) : pick < 0.7 ? vec3(0.95, 0.72, 0.68) : vec3(0.9, 0.8, 0.62);
    float ribs = 0.8 + 0.2 * abs(cos(a * 7.0));
    col = base * ribs * (0.85 + 0.25 * dot(q, toSun) * 0.5);
  } else {
    float pick = hash21(cell + 2.2);
    vec3 base = pick < 0.45 ? vec3(0.55, 0.53, 0.5) : pick < 0.75 ? vec3(0.8, 0.77, 0.72) : vec3(0.62, 0.5, 0.42);
    vec4 st = stoneShape(q, hash21(cell + 4.4), base, toSun, sharp);
    col = st.rgb;
    mask = st.a;
  }
  return vec4(col, mask * fade);
}

// Strand: feine Körnung, Rippel, nasser dunkler Saum zum Wasser, Kiesel
// und Muscheln, angespültes Treibgut.
vec3 beachTexture(vec3 c, vec2 tile, float ds, float height) {
  c = sandSurface(c, tile, ds);
  float wet = 1.0 - smoothstep(uSeaLevel, uSeaLevel + (uShoreLevel - uSeaLevel) * 0.45, height);
  c = mix(c, c * vec3(0.72, 0.7, 0.66), wet * 0.8);
  float pick;
  float shadow;
  vec4 prop = beachProp(tile, ds, shadow);
  c *= 1.0 - shadow * 0.3;
  c = mix(c, prop.rgb, prop.a);
  gPropMask = max(gPropMask, prop.a);
  float drift = speckle(tile + 40.0, 0.6, 0.12, 0.18, pick) * detailFade(0.3, ds) * (1.0 - wet);
  c = mix(c, vec3(0.45, 0.36, 0.25), drift * 0.6);
  return c;
}

// Wüste: Dünen mit Licht- und Schattenseite, windgekämmte Rippel, rissige
// Lehmflächen, verstreute trockene Büsche.
vec3 desertTexture(vec3 c, vec2 tile, float ds) {
  float dune = snoise(L_MICRO, tile * 0.09 + vec2(-13.0, 77.0));
  c *= 1.0 + dune * 0.1;
  c = sandSurface(c, tile, ds);
  float clay = smoothstep(0.35, 0.6, snoise(L_DETAIL, tile * 0.06 + vec2(31.0, -8.0)));
  if (clay > 0.0) {
    vec3 cl = c * vec3(0.9, 0.78, 0.66);
    // Risse: Grenzen unregelmäßiger Zellen wie bei getrocknetem Schlamm.
    float edge = cellEdge(tile * 1.2 + snoise(L_MICRO, tile * 0.5) * 0.15);
    cl *= 1.0 - (1.0 - smoothstep(0.0, 0.08, edge)) * 0.35 * detailFade(0.25, ds);
    c = mix(c, cl, clay);
  }
  float pick;
  float shadow;
  vec4 prop = desertProp(tile, ds, shadow);
  c *= 1.0 - shadow * 0.3;
  c = mix(c, prop.rgb, prop.a);
  gPropMask = max(gPropMask, prop.a);
  return c;
}

// Gebirge: Geröllbrocken, kantig.
vec4 rockProp(vec2 tile, float ds, out float shadow) {
  shadow = 0.0;
  float fade = detailFade(0.07, ds);
  vec2 q; float r; vec2 id;
  if (fade <= 0.0 || !propCell(tile, 2.5, 0.1, 0.06, 0.14, q, r, id)) return vec4(0.0);
  vec2 toSun = normalize(SUN_XY);
  float sharp = detailFade(r * 0.5, ds);
  shadow = smoothstep(1.0, 0.5, length(q + toSun * 0.4)) * sharp * fade;
  vec3 base = vec3(0.55, 0.53, 0.5) * (0.85 + 0.3 * hash21(id + 2.2));
  vec4 st = stoneShape(q, hash21(id + 4.4), base, toSun, sharp);
  return vec4(st.rgb, st.a * fade);
}

// Schnee: Felsbrocken, die mit einer Schneehaube herausschauen.
vec4 snowProp(vec2 tile, float ds, out float shadow) {
  shadow = 0.0;
  float fade = detailFade(0.07, ds);
  vec2 q; float r; vec2 id;
  if (fade <= 0.0 || !propCell(tile, 2.0, 0.05, 0.06, 0.13, q, r, id)) return vec4(0.0);
  vec2 toSun = normalize(SUN_XY);
  float sharp = detailFade(r * 0.5, ds);
  shadow = smoothstep(1.0, 0.5, length(q + toSun * 0.4)) * sharp * fade;
  vec4 st = stoneShape(q, hash21(id + 4.4), vec3(0.42, 0.41, 0.42), toSun, sharp);
  float cap = smoothstep(0.1, 0.5, dot(q, toSun) + 0.3) * smoothstep(0.85, 0.55, length(q));
  vec3 col = mix(st.rgb, vec3(0.95, 0.97, 1.0), cap * sharp);
  return vec4(col, st.a * fade);
}

// Fels: Schichtbänder, Risse, Flechten und Geröll.
vec3 rockTexture(vec3 c, vec2 tile, float ds, float height) {
  float strata = sin(height * 140.0 + snoise(L_MICRO, tile * 0.15) * 3.0);
  c *= 1.0 + strata * 0.06;
  c *= 1.0 + rockGrit(tile, ds) * 0.1;
  float crack = abs(snoise(L_DETAIL, tile * 0.9 + vec2(-60.0, 12.0)));
  c *= 1.0 - (1.0 - smoothstep(0.0, 0.04, crack)) * 0.3 * detailFade(0.4, ds);
  float lichen = smoothstep(0.45, 0.75, snoise(L_MICRO, tile * 0.6 + vec2(5.0, 50.0)));
  c = mix(c, vec3(0.55, 0.57, 0.38), lichen * 0.3);
  float shadow;
  vec4 prop = rockProp(tile, ds, shadow);
  c *= 1.0 - shadow * 0.3;
  c = mix(c, prop.rgb, prop.a);
  gPropMask = max(gPropMask, prop.a);
  return c;
}

// Schnee: weiche, weite Verwehungen, feine glitzernde Körnung, bläuliche
// Mulden, vereinzelt Felsbrocken mit Schneehaube.
vec3 snowTexture(vec3 c, vec2 tile, float ds) {
  float drift = snoise(L_MICRO, tile * 0.25 + vec2(-3.0, 17.0));
  c = mix(c, c * vec3(0.86, 0.92, 1.02), smoothstep(0.0, -0.6, drift) * 0.5);
  c *= 1.0 + snowGrain(tile, ds) * 0.04;
  float pick;
  float glitter = speckle(tile, 14.0, 0.1, 0.012, pick) * detailFade(0.02, ds);
  c = mix(c, vec3(1.0), glitter * 0.8);
  float shadow;
  vec4 prop = snowProp(tile, ds, shadow);
  c *= 1.0 - shadow * 0.2;
  c = mix(c, prop.rgb, prop.a);
  gPropMask = max(gPropMask, prop.a);
  return c;
}

// Feinrelief des Bodens (in Tiles, ohne Einheit): Grasbüschel, Laubhaufen,
// Sandrippel, Felsblöcke - je nach Anteil. Nur für die Beleuchtung, das
// Gelände selbst wird dadurch nicht höher.
float groundBump(vec2 p, float ds, float wood, float sand, float rock, float snow, float height) {
  // Gras: feine, längliche Halme, je Gegend etwas anders geneigt, dazu ganz
  // flache Wellen. Grob darf es hier nicht werden, sonst sieht es fleckig aus.
  float lean = snoise(L_MICRO, p * 0.3 + vec2(40.0, 2.0)) * 0.8;
  mat2 turn = mat2(cos(lean), sin(lean), -sin(lean), cos(lean));
  vec2 bp = turn * p;
  float grass = (snoise(L_DETAIL, bp * vec2(34.0, 10.0) + vec2(-21.0, 7.0)) * 0.45
      + snoise(L_MICRO, bp * vec2(20.0, 7.0) + vec2(5.0, 9.0)) * 0.25) * detailFade(0.04, ds)
      + snoise(L_MICRO, p * 1.6 + vec2(3.7, -9.1)) * 0.06;
  float conifer = clamp((height + 0.1) / 0.45, 0.0, 1.0);
  float litter = forestGrain(p, ds, conifer) * 0.5 + snoise(L_MICRO, p * 2.2 + vec2(9.0, -44.0)) * 0.12;
  float sandH = sandGrain(p, ds) * 0.5 + snoise(L_MICRO, p * 0.8 + vec2(6.0, 6.0)) * 0.08;
  float blocks = rockGrit(p, ds) * 0.45 + (1.0 - abs(snoise(L_DETAIL, p * 0.9 + vec2(-60.0, 12.0)))) * 0.5;
  float snowH = snowGrain(p, ds) * 0.4 + snoise(L_MICRO, p * 0.25 + vec2(-3.0, 17.0)) * 0.15;
  float h = mix(grass, litter, wood);
  h = mix(h, sandH, sand);
  h = mix(h, blocks, rock);
  return mix(h, snowH, snow);
}

// Grundfarbe eines Land-Bioms ohne Textur: Verlauf nach Höhe im Biom.
vec3 biomeBase(int biome, float height, float variation) {
  vec2 band = heightBand(biome);
  float rel = clamp((height - band.x) / max(band.y - band.x, 1e-6), 0.0, 1.0);
  float t = clamp(0.2 + rel * 0.62 + (variation - 0.5) * 0.3, 0.0, 1.0);
  return mix(uBiomeLo[biome], uBiomeHi[biome], t);
}

void main() {
  // Welt-Tiles je Geraete-Pixel, waagerecht gemessen. Auf Haengen ist es
  // mehr, fuer Detailstufe und Schattierung reicht die Naeherung.
  float step = 1.0 / uPixelsPerTile;

  // Texel -> Boden -> Welt. Das Texel mit Index t steht fuer die absolute
  // Position, die im aktuellen Fenster auf t faellt.
  vec2 rel = mod(floor(gl_FragCoord.xy) - uWindowMod, uCacheSize);
  vec2 g = uWindowStart + (rel + 0.5) * step;
  vec2 tile = groundToWorld(g);
  vec2 n = tile * uMapScale;

  float detailStep = step * uDetailPixels;
  float height = elevation(n, detailStep);

  float moisture;
  float temperature;
  climate(n, height, moisture, temperature);

  int biome = classify(height, moisture, temperature);
  float variation = (snoise(L_DETAIL, tile * 0.35 / detailStep) + 1.0) * 0.5;

  bool isWater = biome == B_DEEP_WATER || biome == B_WATER;
  vec3 color;
  // Anteil Sand (Strand, Wüste) - dort wird die Hangschattierung sanfter,
  // sonst zieht das Höhenrauschen dunkle Schlieren durch den Sand.
  float sandy = 0.0;

  if (isWater) {
    float depth = clamp(
        (uSeaLevel - height) / (uSeaLevel + 1.0) + (variation - 0.5) * 0.03, 0.0, 1.0);
    float pos = pow(depth, 0.7) * 3.0;
    int idx = int(min(2.0, floor(pos)));
    float raw = pos - float(idx);
    color = mix(uWaterRamp[idx], uWaterRamp[idx + 1], raw * raw * (3.0 - 2.0 * raw));

    float surf = pow(clamp(1.0 - depth / 0.16, 0.0, 1.0), 2.0) * 0.42;
    color = mix(color, uSurf, surf);
  } else {
    // Weiche, ausgefranste Übergänge statt harter Biom-Kanten. Die Anteile
    // (Wald, Wüste, Strand, Fels) hängen nur stetig von Höhe, Feuchte und
    // Temperatur ab und werden auf beiden Seiten einer Grenze gleich
    // gerechnet - so springt die Farbe an der Grenze nicht. Welches Biom ein
    // Tile im Spiel hat, bleibt classify(). Jede Textur läuft nur, wo sie
    // mit Anteil > 0 vorkommt.
    float jitter = snoise(L_FRINGE, tile * 0.5 + vec2(3.0, 8.0));
    float wood = smoothstep(0.02, 0.18, moisture + jitter * 0.05);
    float desert = min(smoothstep(0.15, 0.35, temperature),
                       1.0 - smoothstep(-0.2, 0.0, moisture + jitter * 0.05));
    float shoreBand = (uShoreLevel - uSeaLevel) * 0.6;
    float beach = 1.0 - smoothstep(uShoreLevel - shoreBand, uShoreLevel + shoreBand,
                                   height + jitter * shoreBand * 0.8);
    float rock = smoothstep(uHillLevel - 0.05, uHillLevel + 0.05, height + jitter * 0.025);
    sandy = max(beach, desert) * (1.0 - rock);

    float snow = biome == B_SNOW ? 1.0 : 0.0;
    if (biome == B_SNOW) {
      color = snowTexture(biomeBase(biome, height, variation), tile, detailStep);
      wood = 0.0;
      rock = 0.0;
      beach = 0.0;
      desert = 0.0;
    } else {
      // Pflanzendecke: Wiese, Wald, Wüste.
      vec3 cover = vec3(0.0);
      if (beach < 1.0 && rock < 1.0) {
        // Blumen nur mitten in der Wiese, nicht im Saum zu anderen Böden.
        float bloom = (1.0 - smoothstep(0.0, 0.35, beach)) * (1.0 - smoothstep(0.0, 0.4, desert))
            * (1.0 - smoothstep(0.0, 0.6, wood)) * (1.0 - smoothstep(0.0, 0.4, rock));
        if (wood < 1.0) cover = grassTexture(biomeBase(B_GRASS, height, variation), tile, detailStep, moisture, bloom);
        if (wood > 0.0) cover = mix(cover, forestTexture(biomeBase(B_FOREST, height, variation), tile, detailStep, height), wood);
        if (desert > 0.0) cover = mix(cover, desertTexture(biomeBase(B_DESERT, height, variation), tile, detailStep), desert);
      }
      color = cover;
      if (beach > 0.0) {
        color = mix(color, beachTexture(biomeBase(B_BEACH, height, variation), tile, detailStep, height), beach);
      }
      if (rock > 0.0) {
        color = mix(color, rockTexture(biomeBase(B_MOUNTAIN, height, variation), tile, detailStep, height), rock);
      }
    }

    {
      // Feinrelief beleuchten: Normale aus dem Anstieg des Bump-Musters,
      // Licht wie beim Gelände von links oben. So wirkt der Boden körnig und
      // plastisch statt glatt bemalt. Weit draußen blendet es aus.
      float bumpFade = detailFade(0.12, detailStep) * (1.0 - gPropMask);
      if (bumpFade > 0.0) {
        float sandShare = max(beach, desert);
        float e = max(detailStep * 0.75, 0.004);
        float b0 = groundBump(tile, detailStep, wood, sandShare, rock, snow, height);
        float bx = groundBump(tile + vec2(e, 0.0), detailStep, wood, sandShare, rock, snow, height);
        float by = groundBump(tile + vec2(0.0, e), detailStep, wood, sandShare, rock, snow, height);
        // Gras und Schnee zart, Sand etwas mehr, Laub und Fels kräftiger.
        float k = mix(0.018, 0.04, wood);
        k = mix(k, 0.05, rock);
        k = mix(k, 0.02, sandShare * (1.0 - rock));
        k = mix(k, 0.022, snow);
        vec3 bn = normalize(vec3(-(bx - b0) / e * k, -(by - b0) / e * k, 1.0));
        vec3 sun = normalize(vec3(SUN_XY, 0.82));
        float light = dot(bn, sun) / sun.z;
        color *= mix(1.0, clamp(light, 0.55, 1.35), 0.8 * bumpFade);
        // Vertiefungen etwas dunkler - Umgebungsverdeckung zwischen Halmen.
        color *= 1.0 - clamp(-b0, 0.0, 1.0) * 0.12 * bumpFade;
      }
    }
  }

  // Hillshading. Die Nachbarhoehen werden bewusst eigens ausgewertet statt
  // ueber dFdx/dFdy: Bildschirm-Ableitungen gelten je 2x2-Block, die
  // Schattierung waere dann nur halb aufgeloest. Der GPU ist der dreifache
  // Aufwand egal, und so rechnet der Shader exakt dasselbe wie shadeFrom().
  float hRight = elevation((tile + vec2(step, 0.0)) * uMapScale, detailStep);
  float hDown = elevation((tile + vec2(0.0, step)) * uMapScale, detailStep);
  float shade = tanh(((height - hRight) + (height - hDown)) * uShadeGain / step);
  // Im Flachland gedämpft, sonst zeichnet sie jede kleine Welle der Wiese nach.
  float lowland = mix(uLowlandShade, 1.0, smoothstep(uMountainFoot - 0.15, uMountainFoot, height));
  color *= 1.0 + shade * (isWater ? 0.08 : mix(0.42, 0.18, sandy) * lowland);

  // Licht auf das Relief. Die Hangneigung oben ist nur ein Schattierungs-
  // effekt der Hoehenwerte; hier zaehlt die Neigung der tatsaechlich
  // angehobenen Flaeche, damit Sonnen- und Schattenseiten der Berge zur
  // Geometrie passen. Licht von links oben im Bild, wie in AoE2.
  if (uReliefScale > 0.0 && !isWater) {
    float z = reliefZ(height);
    vec3 normal = normalize(vec3(
        (z - reliefZ(hRight)) / step,
        (z - reliefZ(hDown)) / step,
        1.0 / uReliefScale));
    const vec3 SUN = vec3(-0.45, 0.35, 0.82);
    float lambert = dot(normal, normalize(SUN)) / normalize(SUN).z;
    color *= clamp(mix(1.0, lambert, 0.85), 0.45, 1.3);
  }

  if (uDebug != 0) {
    float value = height;
    if (uDebug == 2) value = shade;
    // Zwischenstufen zum Eingrenzen von Abweichungen
    if (uDebug == 3) value = snoise(L_HEIGHT, n);
    if (uDebug == 4) value = fbmRaw(L_HEIGHT, n, 4, 0.5) * 0.25;
    if (uDebug == 5) value = fbmRaw(L_WARP, n + vec2(5.2, 1.3), 2, 0.5) * 0.25;
    if (uDebug == 6) value = fbmRaw(L_RELIEF, n * uDetailFrequency, 4, 0.5) * 0.25;
    if (uDebug == 7) value = ridgedNoise(n * 2.2, 4, 0.5) * 2.0 - 1.0;
    float u = clamp((value + 1.0) * 0.5, 0.0, 1.0) * 255.0;
    fragColor = vec4(floor(u) / 255.0, fract(u), 0.0, 1.0);
    return;
  }

  fragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
`;

/** Bild aus dem Cache plus die Overlays, die sich je Bild ändern. */
export const DISPLAY_FRAGMENT_SOURCE = `#version 300 es
precision highp float;

in vec2 vWorld;
in vec2 vCache;
in vec2 vPrevTexel;
out vec4 fragColor;

uniform sampler2D uCache;
// Alter Cache beim Wechsel der Zoomstufe: Anteil (0 = aus), Lage im
// Ringpuffer und der fertige Bereich (Texel ab Fenster-Ecke: u0, v0, u1, v1).
uniform sampler2D uCachePrev;
uniform float uPrevMix;
uniform vec2  uPrevWindowMod;
uniform vec2  uPrevCacheSize;
uniform vec4  uPrevReady;
uniform vec2  uResolution;
uniform float uPixelsPerTile;

// Overlays. Das Tile in Welt-Tiles, das Rechteck in Geraete-Pixeln.
uniform vec2  uHoverTile;      // markiertes Tile, uHoverActive < 0.5 blendet aus
uniform float uHoverActive;
uniform vec4  uViewRect;       // Ausschnitt der Hauptansicht (x, y, Breite, Hoehe), Pixel ab links oben
uniform float uViewRectActive;

// Umgepflügte Äcker (siehe World.fieldSoil): je Tile ein Texel ab uFieldOrigin,
// rgb = wie weit die drei Furchen des Tiles entlang y gepflügt sind, a = Feld.
uniform sampler2D uFields;
uniform vec2  uFieldOrigin;
uniform float uFieldSize;
uniform float uFieldActive;

float soilHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float soilNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(soilHash(i), soilHash(i + vec2(1, 0)), u.x),
             mix(soilHash(i + vec2(0, 1)), soilHash(i + vec2(1, 1)), u.x), u.y);
}

// Acker an diesem Punkt: Furchen entlang y mit hellem Kamm und dunkler Rinne,
// Pflugspuren, Schollen und Krümel. Schattiert wie das Gelände darunter.
vec3 soilColor(vec2 world, vec3 ground, float step) {
  float across = fract(world.x * 3.0);
  float ridge = 0.5 + 0.5 * cos((across - 0.5) * 6.2832);
  float lines = 0.5 + 0.5 * sin(world.x * 3.0 * 6.2832 * 4.0 + soilNoise(world * vec2(2.0, 0.6)) * 2.0);
  float fineLines = 1.0 - smoothstep(0.02, 0.08, step * 12.0);
  float clods = soilNoise(world * vec2(9.0, 5.0));
  float crumbs = soilNoise(world * 40.0) * (1.0 - smoothstep(0.01, 0.03, step));
  float damp = smoothstep(0.4, 0.8, soilNoise(world * 0.35));
  vec3 dark = vec3(0.30, 0.21, 0.13);
  vec3 light = vec3(0.50, 0.37, 0.24);
  vec3 c = mix(dark, light, ridge * 0.75 + clods * 0.25);
  c *= 0.92 + 0.12 * (lines - 0.5) * fineLines + 0.16 * (crumbs - 0.5);
  c *= 1.0 - 0.15 * damp;
  // Licht und Schatten des Geländes übernehmen: Wiese ist im Mittel etwa so hell.
  float shade = clamp(dot(ground, vec3(0.3, 0.59, 0.11)) / 0.42, 0.55, 1.35);
  return c * shade;
}

void main() {
  float step = 1.0 / uPixelsPerTile;
  vec2 tile = vWorld;
  vec3 color = texture(uCache, vCache).rgb;
  if (uPrevMix > 0.0 && all(greaterThanEqual(vPrevTexel, uPrevReady.xy)) && all(lessThan(vPrevTexel, uPrevReady.zw))) {
    vec3 before = texture(uCachePrev, (vPrevTexel + uPrevWindowMod) / uPrevCacheSize).rgb;
    color = mix(color, before, uPrevMix);
  }

  if (uFieldActive > 0.5) {
    vec2 ft = floor(vWorld - uFieldOrigin);
    if (all(greaterThanEqual(ft, vec2(0.0))) && all(lessThan(ft, vec2(uFieldSize)))) {
      vec4 f = texelFetch(uFields, ivec2(ft), 0);
      if (f.a > 0.5) {
        vec2 inTile = fract(vWorld);
        int furrow = min(int(inTile.x * 3.0), 2);
        float ploughed = furrow == 0 ? f.r : furrow == 1 ? f.g : f.b;
        // Weicher Rand am Ende des Gepflügten - ein halber Pixel.
        float edge = clamp((ploughed - inTile.y) / max(step, 1e-4) + 0.5, 0.0, 1.0);
        if (ploughed >= 0.999) edge = 1.0;
        if (edge > 0.0) color = mix(color, soilColor(vWorld, color, step), edge);
      }
    }
  }

  // Markiertes Tile: heller Rahmen mit dunklem Saum nach innen
  if (uHoverActive > 0.5) {
    vec2 d = tile - uHoverTile;
    if (d.x >= 0.0 && d.x < 1.0 && d.y >= 0.0 && d.y < 1.0) {
      float edge = min(min(d.x, 1.0 - d.x), min(d.y, 1.0 - d.y));
      if (edge < step) color = mix(color, vec3(1.0), 0.85);
      else if (edge < 3.0 * step) color = mix(color, vec3(0.0), 0.35);
    }
  }

  // Viewport-Rechteck und Mittelpunkt der Minimap, in Geraete-Pixeln
  vec2 pixel = vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y);
  if (uViewRectActive > 0.5) {
    vec2 d = pixel - uViewRect.xy;
    vec2 size = uViewRect.zw;
    bool inside = d.x >= 0.0 && d.y >= 0.0 && d.x < size.x && d.y < size.y;
    if (inside) {
      float edge = min(min(d.x, size.x - d.x), min(d.y, size.y - d.y));
      if (edge < 1.0) color = mix(color, vec3(1.0), 0.9);
      else if (edge < 3.0) color = mix(color, vec3(0.0), 0.35);
    }
  }

  fragColor = vec4(color, 1.0);
}
`;
