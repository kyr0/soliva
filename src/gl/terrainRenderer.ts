// terrainRenderer.ts
// WebGL2-Aufbau für den Gelände-Shader: Programme, Permutations-Textur, die
// Uniforms aus TERRAIN_PARAMS und der Farb-Cache. Gezeichnet wird ein Gitter
// in isometrischer Ansicht; der Vertex-Shader hebt es auf die Geländehöhe, die
// Farbe kommt aus dem Cache.

import { MAX_FLAT_ZONES } from '../world/flatten';
import { NOISE_LAYERS, SimplexNoise, TERRAIN_PARAMS } from '../noise';
import {
  DISPLAY_FRAGMENT_SOURCE,
  FILL_FRAGMENT_SOURCE,
  FILL_VERTEX_SOURCE,
  VERTEX_SOURCE,
} from './terrainShader';
import {
  MAX_RELIEF,
  Z_SCREEN_MAX,
  setCameraUniforms,
  setViewUniforms,
  viewGroundV,
  viewRotation,
  viewZScreen,
  worldToGround,
  type GpuCamera,
} from './iso';
import type { Color } from '../functions/Color';

/** Reihenfolge muss zu den B_*-Konstanten im Shader passen. */
export interface TerrainPalette {
  biomeLo: Color[];
  biomeHi: Color[];
  waterRamp: [number, number, number][];
  surf: [number, number, number];
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader lässt sich nicht übersetzen:\n${log}`);
  }
  return shader;
}

/**
 * Regler der Geländeerzeugung als Uniforms. Braucht jedes Programm, das
 * TERRAIN_COMMON einbindet - also auch der EntityRenderer, der Gebäude auf die
 * Geländehöhe setzt. Die Permutations-Textur liegt auf Einheit 0.
 */
export function uploadTerrainParams(
    gl: WebGL2RenderingContext,
    location: (name: string) => WebGLUniformLocation | null,
) {
  const p = TERRAIN_PARAMS;
  const f = (name: string, value: number) => gl.uniform1f(location(name), value);

  gl.uniform1i(location('uGrad'), 0);
  f('uMapScale', p.mapScale);
  f('uWarpStrength', p.warpStrength);
  f('uDetailFrequency', p.detailFrequency);
  f('uDetailStrength', p.detailStrength);
  f('uMicroFrequency', p.microFrequency);
  f('uMicroStrength', p.microStrength);
  f('uMicroPersistence', p.microPersistence);
  f('uMicroMinSamples', p.microMinSamples);
  f('uFringeFrequency', p.fringeFrequency);
  f('uFringeStrength', p.fringeStrength);
  f('uRidgeStart', p.ridgeStart);
  f('uRidgeStrength', p.ridgeStrength);
  f('uShadeGain', p.shadeGain);
  f('uLapseRate', p.lapseRate);
  f('uDeepWaterLevel', p.deepWaterLevel);
  f('uSeaLevel', p.seaLevel);
  f('uShoreLevel', p.shoreLevel);
  f('uHillLevel', p.hillLevel);
  f('uPeakLevel', p.peakLevel);
  f('uSnowTemperature', p.snowTemperature);
  f('uTundraTemperature', p.tundraTemperature);
  f('uReliefHeight', p.reliefHeight);
  f('uReliefExponent', p.reliefExponent);
  f('uLowlandRelief', p.lowlandRelief);
  f('uLowlandShade', p.lowlandShade);
  f('uMountainFoot', p.mountainFoot);
  gl.uniform1i(location('uMicroOctaves'), p.microOctaves);
}

/** Ein Rechteck in absoluten Cache-Texeln (Boden-Koordinaten * pixelsPerTile). */
interface TexelRect {
  u: number;
  v: number;
  width: number;
  height: number;
}

/**
 * So viele Texel darf das Befüllen je Bild höchstens kosten. Ein Bild voll
 * Geländeerzeugung (~4 Mio. Pixel) kostete auf einem M1 rund 180 ms - ein
 * Viertel davon hält die Bildrate beim Zoomen noch flüssig genug, und das
 * Fenster ist nach wenigen Bildern vollständig.
 */
const FILL_BUDGET = 1_000_000;
/**
 * Budget für alles außerhalb des Bildes - Vorrat-Blase und der Bereich unter
 * dem Bildrand -, solange im Bild noch etwas fehlt. Klein, damit es das
 * Verschieben nicht ausbremst. Ist das Bild vollständig, bekommt der
 * Hintergrund das volle Budget.
 */
const BACKGROUND_BUDGET = 250_000;


/**
 * Gemeinsames Budget je Bild, sobald etwas Vollständiges im Bild ist (der
 * fertige Cache oder beim Stufenwechsel der alte, gestreckte): dann eilt
 * nichts mehr, und jedes Bild soll gleich wenig kosten - sonst ruckelt es.
 * Reihenfolge: was im Bild fehlt, dann das Vorberechnen, dann die Blase.
 */
const SMOOTH_BUDGET = 250_000;
/**
 * Höchstens so viele Caches: der aktive, der alte beim Überblenden und die
 * vorberechneten (Zielstufe beim Hineinzoomen, zwei kleinere). Reicht der
 * Pool nicht, fällt der letzte Wunsch weg - die kleinste Stufe.
 */
const MAX_CACHES = 4;

/** So lange (ms) blendet ein neu berechneter Cache über den alten, gestreckten. */
const CACHE_FADE_MS = 200;

/**
 * Ab so vielen Geräte-Pixeln je Tile (Stufe des Gelände-Caches) stehen die
 * Blumen als 3D-Objekte in der Wiese - darunter sind sie nur wenige Pixel
 * groß und das Gelände malt sie als Tupfen. Bei 32 wären es auf Retina schon
 * bei 16 px je Tile ~12.000 Blumen im Bild, das kostete merklich Bildrate.
 */
export const FLOWER_OBJECT_PIXELS = 64;

/** Rand um den Bildschirm, damit beim Verschieben nichts Ungefülltes ins Bild rutscht. */
const CACHE_MARGIN = 64;

function link(gl: WebGL2RenderingContext, vertexSource: string, fragmentSource: string): WebGLProgram {
  const vertex = compile(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram()!;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`Shader-Programm lässt sich nicht linken:\n${gl.getProgramInfoLog(program)}`);
  }
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  return program;
}

const mod = (a: number, n: number) => ((a % n) + n) % n;

/**
 * Zwei Durchgänge:
 *
 * 1. Befüllen: Die teure Geländeerzeugung schreibt Farben in einen Cache -
 *    eine Textur in Boden-Koordinaten, ein Texel je Geräte-Pixel. Das Fenster
 *    wandert mit der Kamera als Ringpuffer; neu berechnet werden nur Texel,
 *    die hineinkommen. Beim Zoomen gilt der Cache nicht mehr (Detailstufe und
 *    Auflösung hängen am Zoom) und wird über ein paar Bilder neu befüllt.
 * 2. Anzeigen: Das Gitter wird auf Geländehöhe gehoben und liest nur noch aus
 *    dem Cache. Dazu kommen die Overlays, die sich je Bild ändern.
 */
/** Kantenlänge (Tiles) des Ausschnitts, in dem Äcker gezeichnet werden - um die Kamera. */
export const FIELD_WINDOW = 256;

export class TerrainRenderer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private fillProgram: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private fillVao: WebGLVertexArrayObject;
  private indexBuffer: WebGLBuffer;
  /** Abmessungen des Gitters, für das der Index-Puffer gerade gebaut ist. */
  private gridColumns = 0;
  private gridRows = 0;
  private uniforms = new Map<string, WebGLUniformLocation | null>();
  private fillUniforms = new Map<string, WebGLUniformLocation | null>();

  /**
   * Gelände-Caches: in `active` wird berechnet. Wechselt der Maßstab
   * (Zoomstufe), bleibt der letzte vollständige als `previous` stehen und wird
   * gestreckt gezeigt, bis der neue fertig ist - dann blendet er über. So ist
   * nie ein halb befüllter Cache im Bild. In `prefetch` werden die kleineren
   * Zoomstufen für denselben Ausschnitt vorab berechnet - beim Herauszoomen
   * liegen sie dann schon fertig bereit.
   */
  private buffers: CacheBuffer[];
  private active: CacheBuffer;
  private previous: CacheBuffer | null = null;
  private prefetch: CacheBuffer[] = [];
  /** Seit wann der neue Cache über den alten blendet (performance.now), oder null. */
  private fadeStart: number | null = null;
  /** Größte Texturkante dieses Geräts - einmal abgefragt, getParameter bremst. */
  private maxTextureSize: number;

  constructor(canvas: HTMLCanvasElement, seed: string, palette: TerrainPalette) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: true,
      stencil: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL2 wird von diesem Browser nicht unterstützt');
    this.gl = gl;
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;

    this.program = link(gl, VERTEX_SOURCE, DISPLAY_FRAGMENT_SOURCE);
    this.fillProgram = link(gl, FILL_VERTEX_SOURCE, FILL_FRAGMENT_SOURCE);

    // Die Eckpunkte des Gitters kommen aus gl_VertexID, es gibt also keinen
    // Vertex-Puffer - nur die Indizes. Der eigene VAO hält die Index-Bindung
    // getrennt vom EntityRenderer, der auf demselben Context zeichnet.
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    this.indexBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);

    // Ein Dreieck, das über die ganze Textur hinausragt - der Scissor
    // schneidet den Bereich aus, der gerade befüllt wird.
    this.fillVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.fillVao);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(this.fillProgram, 'aPosition');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.buffers = [createCacheBuffer(gl)];
    this.active = this.buffers[0];
    this.fields = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.fields);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, FIELD_WINDOW, FIELD_WINDOW, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.activeTexture(gl.TEXTURE0);

    this.uploadPermutations(seed);

    gl.useProgram(this.program);
    uploadTerrainParams(gl, (name) => this.location(name));
    gl.uniform1i(this.location('uCache'), 1);
    gl.uniform1i(this.location('uCachePrev'), 3);
    gl.uniform1i(this.location('uFields'), 2);
    gl.uniform1f(this.location('uFieldSize'), FIELD_WINDOW);

    gl.useProgram(this.fillProgram);
    uploadTerrainParams(gl, (name) => this.fillLocation(name));
    // Zwei Geräte-Pixel: entspricht der Zellgröße, gegen die Mikro-Detail und
    // Farbtextur ursprünglich abgestimmt wurden.
    gl.uniform1f(this.fillLocation('uDetailPixels'), 2);
    gl.uniform1f(this.fillLocation('uFlowerObjectPixels'), FLOWER_OBJECT_PIXELS);
    this.uploadPalette(palette);
  }

  private location(name: string): WebGLUniformLocation | null {
    if (!this.uniforms.has(name)) {
      this.uniforms.set(name, this.gl.getUniformLocation(this.program, name));
    }
    return this.uniforms.get(name)!;
  }

  private fillLocation(name: string): WebGLUniformLocation | null {
    if (!this.fillUniforms.has(name)) {
      this.fillUniforms.set(name, this.gl.getUniformLocation(this.fillProgram, name));
    }
    return this.fillUniforms.get(name)!;
  }

  /**
   * Lädt genau die Permutationstabellen, die die TypeScript-Fassung benutzt.
   * Damit beschreiben Shader und CPU dieselbe Welt - sonst würde die Anzeige
   * unter dem Mauszeiger etwas anderes behaupten als das Bild zeigt.
   */
  private uploadPermutations(seed: string) {
    const gl = this.gl;
    const layers = NOISE_LAYERS.length;
    const data = new Uint8Array(256 * 256 * layers);
    NOISE_LAYERS.forEach((suffix, layer) => {
      data.set(new SimplexNoise(seed + suffix).gradientTable(), layer * 256 * 256);
    });

    const texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.R8UI, 256, 256, layers, 0,
        gl.RED_INTEGER, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  private uploadPalette(palette: TerrainPalette) {
    const gl = this.gl;
    const flat = (rgb: [number, number, number][]) =>
      new Float32Array(rgb.flatMap(([r, g, b]) => [r / 255, g / 255, b / 255]));

    gl.uniform3fv(this.fillLocation('uBiomeLo[0]'), flat(palette.biomeLo.map((c) => c.toRGB())));
    gl.uniform3fv(this.fillLocation('uBiomeHi[0]'), flat(palette.biomeHi.map((c) => c.toRGB())));
    gl.uniform3fv(this.fillLocation('uWaterRamp[0]'), flat(palette.waterRamp));
    gl.uniform3fv(this.fillLocation('uSurf'), flat([palette.surf]));
  }

  /**
   * Zellgröße des Geländegitters beim letzten Zeichnen (Tiles) - die Figuren
   * rechnen ihre Bodenhöhe mit derselben Feinheit, sonst stehen sie am Hang
   * im oder über dem Boden.
   */
  gridCell = 1;
  /** Eingeebnete Flächen unter Gebäuden (siehe world/flatten.ts). */
  flatZones = new Float32Array(MAX_FLAT_ZONES * 4);
  flatCount = 0;

  /** Nur für Tests: 0 = Bild, 1 = Höhe, 2 = Hangneigung. */
  debugMode = 0;

  /** Äcker (siehe setFields): Textur, ihre linke obere Ecke in Tiles, ob welche da sind. */
  private fields: WebGLTexture;
  private fieldOrigin = { x: 0, y: 0 };
  private fieldActive = false;

  /**
   * Umgepflügte Äcker: je Tile ab (x, y) vier Bytes, FIELD_WINDOW x
   * FIELD_WINDOW Tiles (siehe World.fieldSoil) - oder null, wenn keine da sind.
   */
  setFields(x: number, y: number, data: Uint8Array | null) {
    this.fieldActive = data !== null;
    if (!data) return;
    const gl = this.gl;
    this.fieldOrigin = { x, y };
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.fields);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, FIELD_WINDOW, FIELD_WINDOW, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.activeTexture(gl.TEXTURE0);
  }

  /** Markiertes Tile in Weltkoordinaten, oder null. */
  hoverTile: { x: number; y: number } | null = null;
  /** Ausschnitt der Hauptansicht in Geräte-Pixeln dieses Canvas - nur für die Minimap. */
  viewRect: { x: number; y: number; width: number; height: number } | null = null;
  /** Kantenlänge einer Gitterzelle in Geräte-Pixeln. Flach reicht ein grobes Gitter. */
  cellPixels = 4;
  /**
   * Vorrat-Blase um den Bildschirm, in Geräte-Pixeln je Seite. Sie wird im
   * Hintergrund vorausberechnet, damit beim Verschieben fertiges Gelände ins
   * Bild rückt statt frisch zu berechnendes. 512 Pixel reichen bei normalem
   * Scrolltempo für eine gute halbe Sekunde; größer ginge schnell in den
   * Speicher, weil die Textur in beide Richtungen wächst.
   */
  bubblePixels = 512;

  /**
   * Zellgröße in u/v-Einheiten. Nie feiner als ein Achtel Tile: so kleine
   * Formen hat das Relief nicht, und bei starkem Zoom würden aus vier Pixeln
   * sonst fast eine Million Eckpunkte. Aber auch nie gröber als 16 Pixel -
   * bei der stärksten Zoomstufe sähe man sonst die Kanten der Dreiecke.
   */
  private cellSize(camera: GpuCamera): number {
    const ppt = camera.pixelsPerTile;
    const cell = Math.min(Math.max(this.cellPixels / ppt, 1 / 4), Math.max(16, this.cellPixels) / ppt);
    // Auf eine Zweierpotenz gerundet - auf den Zoomstufen ist sie das ohnehin.
    // Beim weichen Zoomen bleiben die Eckpunkte so an derselben Weltstelle,
    // statt mit jedem Bild zu verrutschen (das Relief würde schwimmen), und
    // das Gitter muss nicht je Bild neu gebaut werden.
    return 2 ** Math.round(Math.log2(cell));
  }

  /** Derselbe Context wird vom EntityRenderer mitbenutzt. */
  get context(): WebGL2RenderingContext {
    return this.gl;
  }

  /** Zwei Dreiecke je Zelle, zeilenweise - passt zu gl_VertexID im Vertex-Shader. */
  /**
   * Sorgt für einen Index-Puffer mit mindestens `columns` x `rows` Eckpunkten
   * und gibt seine Spaltenzahl zurück - die ist der Zeilenabstand im Shader.
   * Ein größerer vorhandener wird weiterbenutzt (gezeichnet werden nur die
   * nötigen Zeilen, überzählige Spalten liegen rechts außerhalb des Bildes):
   * Neu bauen heißt, einige MB hochzuladen - beim Zoomen je Stufe ein Ruckler.
   */
  private ensureGrid(columns: number, rows: number): number {
    if (columns <= this.gridColumns && rows <= this.gridRows && this.gridColumns <= columns * 2.5) return this.gridColumns;
    // Etwas Luft, damit kleine Änderungen (Fenstergröße) nicht neu bauen.
    columns = Math.ceil(columns * 1.1);
    rows = Math.ceil(rows * 1.1);
    const gl = this.gl;
    const indices = new Uint32Array((columns - 1) * (rows - 1) * 6);
    let o = 0;
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < columns - 1; c++) {
        const i = r * columns + c;
        indices[o++] = i;
        indices[o++] = i + 1;
        indices[o++] = i + columns;
        indices[o++] = i + 1;
        indices[o++] = i + columns + 1;
        indices[o++] = i + columns;
      }
    }
    gl.bindVertexArray(this.vao);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.gridColumns = columns;
    this.gridRows = rows;
    return columns;
  }

  /** Legt die Textur eines Caches in neuer Größe an. Der Inhalt ist danach ungültig. */
  private allocateCache(b: CacheBuffer, width: number, height: number) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, b.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.activeTexture(gl.TEXTURE0);

    gl.bindFramebuffer(gl.FRAMEBUFFER, b.framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, b.texture, 0);
    // Noch nicht befüllte Texel in der Hintergrundfarbe statt Speicherresten.
    gl.clearColor(0.05, 0.08, 0.14, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    b.width = width;
    b.height = height;
  }

  /**
   * Wählt den Cache für diese Kamera. Ändert sich der Maßstab, wird der
   * letzte vollständige Cache zum `previous`; der neue kommt aus dem Vorrat,
   * wenn er dort schon (vor)berechnet ist, sonst wird ein freier neu befüllt.
   * Blickrichtung oder Debug-Modus lassen sich nicht überblenden - dann gibt
   * es keinen alten.
   */
  private selectCache(camera: GpuCamera) {
    const relief = camera.reliefScale > 0 ? 1 : 0;
    const view = `${this.debugMode}|${viewRotation()}`;
    // Die Bodenstauchung gehört zum Inhalt: ein Texel zeigt je nach ihr eine
    // andere Weltstelle. Überblenden lässt sich trotzdem - gestreckt.
    const groundV = camera.cacheGroundV ?? viewGroundV();
    const keyOf = (scale: number) => `${scale}|${groundV.toFixed(5)}|${relief}|${view}`;
    const scale = cacheScale(camera);
    const key = keyOf(scale);
    if (key !== this.active.key) {
      this.fadeStart = null;
      const found = this.buffers.find((b) => b !== this.active && b.key === key) ?? null;
      const keep = isReady(this.active) ? this.active : this.previous;
      this.previous = keep && keep !== found && keep.view === view ? keep : null;
      this.active = found ?? this.resetCache(this.freeBuffer([this.previous]), key, scale, view, groundV);
    }

    // Vorberechnen: die gewünschten Stufen, die schon einen Cache haben,
    // behalten ihn - auch der alte beim Überblenden rechnet so gleich als
    // Vorrat weiter. Die übrigen bekommen einen freien, solange der Pool reicht.
    const wanted = (camera.prefetchPixelsPerTile ?? []).map((s) => ({ scale: s, key: keyOf(s) }));
    const taken: (CacheBuffer | null)[] = [this.active];
    const chosen = wanted.map((w) => {
      const b = this.buffers.find((x) => x.key === w.key && !taken.includes(x)) ?? null;
      if (b) taken.push(b);
      return b;
    });
    this.prefetch = [];
    wanted.forEach((w, i) => {
      let b = chosen[i];
      if (!b) {
        const busy = [...taken, this.previous];
        if (this.buffers.length >= MAX_CACHES && !this.buffers.some((x) => !busy.includes(x))) return;
        b = this.resetCache(this.freeBuffer(busy), w.key, w.scale, view, groundV);
        taken.push(b);
      }
      this.prefetch.push(b);
    });
  }

  /**
   * Ein Cache, der keine der Rollen in `taken` hat - lieber einer, der auch
   * nicht vorberechnet, und notfalls ein neuer.
   */
  private freeBuffer(taken: (CacheBuffer | null)[]): CacheBuffer {
    const free = this.buffers.find((b) => !taken.includes(b) && !this.prefetch.includes(b))
        ?? this.buffers.find((b) => !taken.includes(b));
    if (free) return free;
    const b = createCacheBuffer(this.gl);
    this.buffers.push(b);
    return b;
  }

  /** Macht `b` zum leeren Cache für den Maßstab `scale`. */
  private resetCache(b: CacheBuffer, key: string, scale: number, view: string, groundV: number): CacheBuffer {
    b.key = key;
    b.scale = scale;
    b.view = view;
    b.groundV = groundV;
    b.window = null;
    b.pending = [];
    b.background = [];
    b.needed = null;
    // Debug-Werte sind gepackte Zahlen - die dürfen nicht interpoliert werden.
    const gl = this.gl;
    const filter = this.debugMode ? gl.NEAREST : gl.LINEAR;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, b.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.activeTexture(gl.TEXTURE0);
    return b;
  }

  /**
   * Schiebt das Cache-Fenster zur Kamera und merkt vor, was neu hineinkommt.
   * Beim Verschieben sind das zwei schmale Streifen an den Rändern.
   */
  private updateCache(b: CacheBuffer, camera: GpuCamera, prefetch = false) {
    const gl = this.gl;
    const { width, height } = gl.canvas;
    const ppt = b.scale;
    const max = this.maxTextureSize;

    // Unten ragt Gelände um den höchsten Gipfel ins Bild, dessen Fuß noch
    // unter dem Bildrand liegt - das muss mit in den Cache.
    // Der Cache hängt nur daran, ob es überhaupt Relief gibt - nicht an der
    // Stärke: beim Flachlegen (Leertaste) läuft die von 1 auf 0, und ein
    // Neubefüllen je Bild wäre viel zu teuer. Die Farben behalten dabei die
    // Schattierung des vollen Reliefs; man erkennt die Berge so auch flach.
    const relief = camera.reliefScale > 0 ? 1 : 0;
    // Beim Neigen wird der Cache senkrecht um `stretch` gestreckt: flacher
    // gesehen deckt das Bild mehr Cache-Zeilen ab, steiler weniger.
    const stretch = b.groundV / viewGroundV();
    const viewHeight = Math.ceil(height * stretch);
    // Die Größe der Textur richtet sich nach dem flachsten Blickwinkel - so
    // bleibt sie beim Neigen dieselbe. Was wirklich hereinragt, hängt vom
    // jetzigen ab.
    const reachSize = Math.ceil(relief * Z_SCREEN_MAX * MAX_RELIEF * ppt);
    const reach = Math.ceil(relief * viewZScreen() * MAX_RELIEF * ppt * stretch);
    // Mit der Zellgröße der Cache-Stufe: beim weichen Zoomen bleibt die Textur
    // so gleich groß - eine neue müsste ganz neu befüllt werden.
    const margin = CACHE_MARGIN + Math.ceil(this.cellSize({ ...camera, pixelsPerTile: ppt }) * ppt);
    // Unten überlappen Blase und Gipfel-Reichweite - es zählt die größere.
    let cacheWidth = Math.min(width + 2 * (margin + this.bubblePixels), max);
    let cacheHeight = Math.min(height + 2 * margin + this.bubblePixels + Math.max(this.bubblePixels, reachSize), max);
    // Reicht die vorhandene Textur und ist sie nicht viel zu groß, bleibt sie:
    // Neu anlegen und leeren kostet bei solchen Größen spürbar ein Bild. Der
    // Überschuss macht nur die Blase größer.
    if (b.width >= cacheWidth && b.height >= cacheHeight && b.width * b.height <= 2 * cacheWidth * cacheHeight) {
      cacheWidth = b.width;
      cacheHeight = b.height;
    }
    // Bei sehr großem Bildschirm kann die Texturgrenze die Blase auffressen.
    const bubbleU = Math.max(0, Math.floor((cacheWidth - width) / 2) - margin);
    const bubbleV = Math.max(0, Math.min(this.bubblePixels, cacheHeight - viewHeight - 2 * margin));

    if (cacheWidth !== b.width || cacheHeight !== b.height) {
      this.allocateCache(b, cacheWidth, cacheHeight);
      b.window = null;
    }

    // Kameramitte in den Boden-Koordinaten des Caches (seine Stauchung).
    const cam = worldToGround(camera.centerX, camera.centerY);
    const u = Math.floor(cam.u * ppt - width / 2 - margin - bubbleU);
    const v = Math.floor(cam.v * stretch * ppt - viewHeight / 2 - margin - bubbleV);
    const next: TexelRect = { u, v, width: cacheWidth, height: cacheHeight };

    // Dringend ist nur, was im Bild liegt (plus schmaler Rand). Alles andere -
    // die Blase und der Bereich unter dem Bildrand, der nur für von unten
    // hereinragende Gipfel da ist - läuft im Hintergrund, nächstgelegenes zuerst.
    const visible = {
      u: u + bubbleU,
      v: v + bubbleV,
      width: width + 2 * margin,
      height: Math.min(viewHeight + 2 * margin, cacheHeight - bubbleV),
    };
    // Was fertig sein muss, damit der Cache ein vollständiges Bild ergibt:
    // das Sichtbare samt der Gipfel, die von unten hereinragen - aber höchstens
    // eine Bildhöhe tief. Stark herangezoomt reichte die volle Gipfelhöhe
    // sonst viele Bildhöhen hinab, und das Vorberechnen würde nie fertig;
    // was darunter liegt, kommt wie bisher im Hintergrund nach.
    b.needed = { ...visible, height: Math.min(visible.height + Math.min(reach, viewHeight), cacheHeight - bubbleV) };
    // Beim Vorberechnen zählt nur das vollständige Bild - die Blase nicht.
    const focus = prefetch ? b.needed : visible;
    const split = (rects: TexelRect[]) => {
      const urgent: TexelRect[] = [];
      const rest: TexelRect[] = [];
      for (const r of rects) {
        const inside = intersect(r, focus);
        if (inside) urgent.push(inside);
        rest.push(...subtract(r, focus));
      }
      return { urgent, rest };
    };
    const byDistance = (rects: TexelRect[]) =>
      rects.sort((a, b) => distance(a, visible) - distance(b, visible));

    const old = b.window;
    b.moved = !!old && (old.u !== u || old.v !== v);
    if (!old) {
      // Alles neu - von oben nach unten, der sichtbare Teil zuerst.
      const { urgent, rest } = split([next]);
      b.pending = urgent;
      b.background = byDistance(rest);
    } else if (old.u !== u || old.v !== v) {
      const strips: TexelRect[] = [];
      const du = u - old.u;
      const dv = v - old.v;
      if (du !== 0) {
        const w = Math.min(Math.abs(du), cacheWidth);
        strips.push({ u: du > 0 ? u + cacheWidth - w : u, v, width: w, height: cacheHeight });
      }
      if (dv !== 0) {
        const h = Math.min(Math.abs(dv), cacheHeight);
        strips.push({ u, v: dv > 0 ? v + cacheHeight - h : v, width: cacheWidth, height: h });
      }
      // Was aus dem Fenster gefallen ist, braucht niemand mehr. Was noch
      // nicht berechnet ist und jetzt ins Bild rückt, wird dringend.
      const waiting = [...strips, ...b.pending, ...b.background]
          .map((r) => intersect(r, next))
          .filter((r): r is TexelRect => r !== null);
      const { urgent, rest } = split(waiting);
      b.pending = urgent;
      b.background = byDistance(rest);
    }
    b.window = { u, v };
  }

  /**
   * Arbeitet die Warteliste ab, bis das Budget für dieses Bild aufgebraucht ist.
   * @param boost Vielfaches des Budgets - wenn das Bild ohnehin steht.
   */
  private fillPending(b: CacheBuffer, camera: GpuCamera, budget: number, backgroundBudget?: number): number {
    if ((b.pending.length === 0 && b.background.length === 0) || !b.window) return 0;
    const gl = this.gl;
    const win = b.window;
    const ppt = b.scale;
    const W = b.width;
    const H = b.height;

    gl.bindFramebuffer(gl.FRAMEBUFFER, b.framebuffer);
    gl.viewport(0, 0, W, H);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.SCISSOR_TEST);
    gl.useProgram(this.fillProgram);
    gl.bindVertexArray(this.fillVao);

    const f = (name: string) => this.fillLocation(name);
    gl.uniform1f(f('uPixelsPerTile'), ppt);
    gl.uniform1f(f('uReliefScale'), camera.reliefScale > 0 ? 1 : 0);
    setViewUniforms(gl, f);
    // Berechnet wird für die Stauchung des Caches, nicht für den jetzigen Blickwinkel.
    gl.uniform1f(f('uGroundV'), b.groundV);
    gl.uniform1i(f('uDebug'), this.debugMode);
    gl.uniform2f(f('uWindowStart'), win.u / ppt, win.v / ppt);
    gl.uniform2f(f('uWindowMod'), mod(win.u, W), mod(win.v, H));
    gl.uniform2f(f('uCacheSize'), W, H);

    const spent = this.drain(b, b.pending, budget);
    // Steht die Kamera und ist das Bild fertig, füllt der Rest des Budgets die
    // Blase auf. Beim Scrollen nicht: dann kämen sichtbarer Rand und Blase im
    // selben Bild zusammen, und bei starkem Zoom bricht die Bildrate ein.
    const idle = !b.moved && b.pending.length === 0;
    const rest = backgroundBudget ?? (idle ? Math.max(BACKGROUND_BUDGET, budget - spent) : BACKGROUND_BUDGET);
    const spentRest = this.drain(b, b.background, rest);

    gl.disable(gl.SCISSOR_TEST);
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return spent + spentRest;
  }

  /** Befüllt Bereiche vom Anfang der Liste, bis das Budget aufgebraucht ist. */
  private drain(b: CacheBuffer, queue: TexelRect[], budget: number): number {
    const initial = budget;
    while (budget > 0 && queue.length > 0) {
      const rect = queue[0];
      // Zu groß fürs Restbudget: nur die oberen Zeilen, der Rest bleibt stehen.
      const rows = Math.min(rect.height, Math.max(1, Math.floor(budget / rect.width)));
      this.fillRect(b, { ...rect, height: rows });
      budget -= rows * rect.width;
      if (rows === rect.height) queue.shift();
      else queue[0] = { ...rect, v: rect.v + rows, height: rect.height - rows };
    }
    return initial - budget;
  }

  /** Zeichnet ein absolutes Rechteck in den Ringpuffer - über den Rand hinweg in bis zu vier Teilen. */
  private fillRect(b: CacheBuffer, rect: TexelRect) {
    const gl = this.gl;
    const W = b.width;
    const H = b.height;
    const pieces = (start: number, length: number, size: number): [number, number][] => {
      const s = mod(start, size);
      const first = Math.min(length, size - s);
      return first < length ? [[s, first], [0, length - first]] : [[s, first]];
    };
    for (const [x, w] of pieces(rect.u, rect.width, W)) {
      for (const [y, h] of pieces(rect.v, rect.height, H)) {
        gl.scissor(x, y, w, h);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
    }
  }

  /**
   * Ob `b` das ganze Bild dieser Kamera fertig abdeckt (samt Gipfeln von
   * unten, höchstens eine Bildhöhe tief): der Bereich liegt im Fenster, und
   * nichts davon wartet noch aufs Befüllen. Auch die Blase zählt, soweit sie
   * gefüllt ist - beim Flacherneigen rückt sie ins Bild.
   */
  private covers(b: CacheBuffer, camera: GpuCamera): boolean {
    if (!b.window) return false;
    const { width, height } = this.gl.canvas;
    const s = b.scale;
    const stretch = b.groundV / viewGroundV();
    const halfU = width / 2 / camera.pixelsPerTile;
    const halfV = height / 2 / camera.pixelsPerTile;
    const reach = Math.min(camera.reliefScale * viewZScreen() * MAX_RELIEF, 2 * halfV);
    const c = worldToGround(camera.centerX, camera.centerY);
    const u0 = Math.floor((c.u - halfU) * s);
    const v0 = Math.floor((c.v - halfV) * stretch * s);
    const need: TexelRect = {
      u: u0,
      v: v0,
      width: Math.ceil((c.u + halfU) * s) - u0,
      height: Math.ceil((c.v + halfV + reach) * stretch * s) - v0,
    };
    const win = b.window;
    const inside = need.u >= win.u && need.v >= win.v
        && need.u + need.width <= win.u + b.width && need.v + need.height <= win.v + b.height;
    return inside && ![...b.pending, ...b.background].some((r) => intersect(r, need) !== null);
  }

  /**
   * Zeichnet das Gelände. false, wenn in diesem Bild nichts gezeichnet wurde:
   * der neue Cache ist noch nicht fertig und der alte deckt das Bild nicht
   * ab - dann bleibt das letzte Bild stehen, statt Lücken zu zeigen.
   */
  render(camera: GpuCamera, now = performance.now()): boolean {
    const gl = this.gl;

    this.selectCache(camera);
    const active = this.active;
    this.updateCache(active, camera);
    const prevCovers = this.previous !== null && this.covers(this.previous, camera);
    const frozen = this.previous !== null && !isReady(active) && !prevCovers;
    // Ist etwas Vollständiges im Bild, wird gleichmäßig wenig je Bild befüllt.
    // Sonst (Laden, Bild steht) zählt nur, schnell fertig zu werden - steht
    // das Bild ohnehin, darf es noch mehr kosten.
    const smooth = !frozen && (isReady(active) || this.previous !== null);
    let left = 0;
    if (smooth) left = SMOOTH_BUDGET - this.fillPending(active, camera, SMOOTH_BUDGET, 0);
    else this.fillPending(active, camera, FILL_BUDGET * (frozen ? 2 : 1));
    const ready = isReady(active);
    // Vorrat: erst, wenn das Bild selbst vollständig ist. Beim Scrollen nur
    // die Zielstufe beim Hineinzoomen (größerer Maßstab) - das Zoomen um den
    // Mauszeiger verschiebt das Bild ja auch -, sonst braucht die Blase das
    // Budget. Die Fenster wandern trotzdem jedes Bild mit der Kamera.
    for (const b of this.prefetch) {
      this.updateCache(b, camera, true);
      if (ready && left > 0 && (!active.moved || b.scale > active.scale)) left -= this.fillPending(b, camera, left, 0);
    }
    if (smooth && left > 0) this.fillPending(active, camera, 0, left);
    if (frozen && !ready) return false;

    // Wie viel vom alten Cache zu sehen ist: ganz, solange der neue fehlt,
    // dann weich ausgeblendet.
    let prevMix = 0;
    if (this.previous) {
      if (!ready) {
        prevMix = 1;
      } else {
        this.fadeStart ??= now;
        const t = (now - this.fadeStart) / CACHE_FADE_MS;
        if (t >= 1) {
          this.previous = null;
          this.fadeStart = null;
        } else {
          prevMix = 1 - t * t * (3 - 2 * t);
        }
      }
    }
    const prev = this.previous ?? active;

    const { width, height } = gl.canvas;

    // Gitter in Boden-Koordinaten (u, v), einmal über den ganzen Bildschirm.
    // Unten ragt es um den höchsten Gipfel hinaus: Gelände, dessen Fuß unter
    // dem Bildrand liegt, kann bis ins Bild hineinragen.
    const cell = this.cellSize(camera);
    this.gridCell = cell;
    const halfU = width / 2 / camera.pixelsPerTile;
    const halfV = height / 2 / camera.pixelsPerTile;
    const reach = camera.reliefScale * viewZScreen() * MAX_RELIEF;
    const { u: camU, v: camV } = worldToGround(camera.centerX, camera.centerY);

    // Am Weltraster ausgerichtet, damit die Eckpunkte beim Verschieben an
    // derselben Weltstelle bleiben.
    const u0 = Math.floor((camU - halfU) / cell) * cell;
    const v0 = Math.floor((camV - halfV) / cell) * cell;
    const columns = Math.ceil(2 * halfU / cell) + 2;
    const rows = Math.ceil((2 * halfV + reach) / cell) + 2;
    const stride = this.ensureGrid(columns, rows);

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.viewport(0, 0, width, height);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.depthMask(true);
    gl.clearColor(0.05, 0.08, 0.14, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, active.texture);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, prev.texture);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.fields);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1f(this.location('uFieldActive'), this.fieldActive ? 1 : 0);
    gl.uniform2f(this.location('uFieldOrigin'), this.fieldOrigin.x, this.fieldOrigin.y);

    const ppt = active.scale;
    const win = active.window!;
    setCameraUniforms(gl, (name) => this.location(name), camera);
    gl.uniform1f(this.location('uCacheScale'), ppt);
    // Beim Neigen senkrecht gestreckt: v des Bildes -> v des Caches.
    gl.uniform1f(this.location('uCacheStretch'), active.groundV / viewGroundV());
    gl.uniform4fv(this.location('uFlat[0]'), this.flatZones);
    gl.uniform1i(this.location('uFlatCount'), this.flatCount);
    gl.uniform2f(this.location('uWindowStart'), win.u / ppt, win.v / ppt);
    gl.uniform2f(this.location('uWindowMod'), mod(win.u, active.width), mod(win.v, active.height));
    gl.uniform2f(this.location('uCacheSize'), active.width, active.height);
    // Der alte Cache: eigenes Fenster, eigener Maßstab, und nur der fertige Teil zählt.
    const pwin = prev.window ?? win;
    // Deckt er das Bild ab, zählt sein ganzes Fenster (auch die gefüllte
    // Blase, siehe covers) - sonst nur, was für ein Bild nötig war.
    const done = prevCovers && prev === this.previous
      ? { ...pwin, width: prev.width, height: prev.height }
      : prev.needed ?? { u: 0, v: 0, width: 0, height: 0 };
    gl.uniform1f(this.location('uPrevStretch'), prev.groundV / viewGroundV());
    gl.uniform1f(this.location('uPrevMix'), prevMix);
    gl.uniform2f(this.location('uPrevWindowStart'), pwin.u / prev.scale, pwin.v / prev.scale);
    gl.uniform1f(this.location('uPrevCacheScale'), prev.scale);
    gl.uniform2f(this.location('uPrevWindowMod'), mod(pwin.u, prev.width), mod(pwin.v, prev.height));
    gl.uniform2f(this.location('uPrevCacheSize'), prev.width, prev.height);
    gl.uniform4f(this.location('uPrevReady'),
        done.u - pwin.u, done.v - pwin.v, done.u - pwin.u + done.width, done.v - pwin.v + done.height);
    gl.uniform2f(this.location('uGridOrigin'), u0, v0);
    gl.uniform1f(this.location('uGridCell'), cell);
    gl.uniform1i(this.location('uGridColumns'), stride);

    gl.uniform1f(this.location('uHoverActive'), this.hoverTile ? 1 : 0);
    if (this.hoverTile) {
      gl.uniform2f(this.location('uHoverTile'), this.hoverTile.x, this.hoverTile.y);
    }
    const rect = this.viewRect;
    gl.uniform1f(this.location('uViewRectActive'), rect ? 1 : 0);
    if (rect) {
      gl.uniform4f(this.location('uViewRect'), rect.x, rect.y, rect.width, rect.height);
    }

    // Nur die nötigen Zeilen - die Indizes liegen zeilenweise hintereinander.
    gl.drawElements(gl.TRIANGLES, (rows - 1) * (stride - 1) * 6, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
    return true;
  }
}

/** Ein Gelände-Cache: Textur, Fenster im Ringpuffer und was darin noch fehlt. */
interface CacheBuffer {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
  width: number;
  height: number;
  /** Wofür der Inhalt gilt. Ändert sich das, ist alles ungültig. */
  key: string;
  /** Texel je u/v-Einheit, in denen der Inhalt berechnet ist. */
  scale: number;
  /** Bodenstauchung (groundV), für die der Inhalt berechnet ist - siehe GpuCamera.cacheGroundV. */
  groundV: number;
  /** Debug-Modus und Blickrichtung - nur bei gleichen lässt sich überblenden. */
  view: string;
  /** Absolute Texel-Ecke des Fensters, oder null wenn leer. */
  window: { u: number; v: number } | null;
  /** Noch zu befüllende Bereiche im Bild, dringendste zuerst. */
  pending: TexelRect[];
  /** Noch zu befüllende Bereiche außerhalb des Bildes. */
  background: TexelRect[];
  /** Ob sich das Fenster in diesem Bild verschoben hat - dann wird gescrollt. */
  moved: boolean;
  /** Was fertig sein muss für ein vollständiges Bild (absolute Texel), oder null. */
  needed: TexelRect | null;
}

function createCacheBuffer(gl: WebGL2RenderingContext): CacheBuffer {
  return {
    texture: gl.createTexture()!,
    framebuffer: gl.createFramebuffer()!,
    width: 0,
    height: 0,
    key: '',
    scale: 1,
    groundV: 0.5,
    view: '',
    window: null,
    pending: [],
    background: [],
    moved: false,
    needed: null,
  };
}

/** Ob der Cache ein vollständiges Bild ergibt - das Sichtbare samt Gipfeln von unten ist befüllt. */
function isReady(b: CacheBuffer): boolean {
  const needed = b.needed;
  return b.window !== null && needed !== null && b.pending.length === 0
      && !b.background.some((r) => intersect(r, needed) !== null);
}

/** Texel des Gelände-Caches je u/v-Einheit (siehe GpuCamera.cachePixelsPerTile). */
function cacheScale(camera: GpuCamera): number {
  return camera.cachePixelsPerTile ?? camera.pixelsPerTile;
}

/** a ohne b - bis zu vier Rechtecke: Streifen oben und unten, dazwischen links und rechts. */
function subtract(a: TexelRect, b: TexelRect): TexelRect[] {
  const cut = intersect(a, b);
  if (!cut) return [a];
  const out: TexelRect[] = [];
  const aBottom = a.v + a.height;
  const cutBottom = cut.v + cut.height;
  if (cut.v > a.v) out.push({ u: a.u, v: a.v, width: a.width, height: cut.v - a.v });
  if (cutBottom < aBottom) out.push({ u: a.u, v: cutBottom, width: a.width, height: aBottom - cutBottom });
  if (cut.u > a.u) out.push({ u: a.u, v: cut.v, width: cut.u - a.u, height: cut.height });
  const aRight = a.u + a.width;
  const cutRight = cut.u + cut.width;
  if (cutRight < aRight) out.push({ u: cutRight, v: cut.v, width: aRight - cutRight, height: cut.height });
  return out;
}

/** Abstand in Texeln zwischen zwei Rechtecken, 0 wenn sie sich berühren. */
function distance(a: TexelRect, b: TexelRect): number {
  const du = Math.max(0, b.u - (a.u + a.width), a.u - (b.u + b.width));
  const dv = Math.max(0, b.v - (a.v + a.height), a.v - (b.v + b.height));
  return Math.max(du, dv);
}

function intersect(a: TexelRect, b: TexelRect): TexelRect | null {
  const u = Math.max(a.u, b.u);
  const v = Math.max(a.v, b.v);
  const width = Math.min(a.u + a.width, b.u + b.width) - u;
  const height = Math.min(a.v + a.height, b.v + b.height) - v;
  return width > 0 && height > 0 ? { u, v, width, height } : null;
}
