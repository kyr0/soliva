import { MAX_FLAT_ZONES, packZones, type FlatZone } from './world/flatten';
import { Color, type RGB } from './functions/Color';
import { EntityRenderer, type EntityInstance, type StaticBatch } from './gl/entityRenderer';
import { FLOWER_OBJECT_PIXELS, TerrainRenderer } from './gl/terrainRenderer';
import {
  screenToGround,
  setViewElevation,
  snapCamera,
  viewElevation,
  viewGroundV,
  visibleWorldRect,
  type IsoView,
} from './gl/iso';
import {
  FractalNoise,
  MapGenerator,
  type MapTile,
  SimplexNoise,
  TERRAIN_LEVELS,
  type TileType,
} from './noise';

export type ResourceType = "none" | "wood" | "gold" | "stone" | "berries";

/**
 * Pro Biom ein Farbverlauf [tief/matt, hoch/hell]. Innerhalb eines Bioms wird
 * zwischen beiden interpoliert - nach Höhe und einem feinen Rauschen. Dadurch
 * wird aus einer einfarbigen Fläche eine Textur.
 */
export const TILE_TYPE_GRADIENT: Record<TileType, [Color, Color]> = {
  deep_water: [Color.rgb(10, 26, 62), Color.rgb(24, 56, 108)],
  water: [Color.rgb(30, 74, 134), Color.rgb(66, 134, 180)],
  beach: [Color.rgb(206, 188, 140), Color.rgb(238, 224, 182)],
  desert: [Color.rgb(186, 146, 82), Color.rgb(222, 190, 124)],
  grass: [Color.rgb(82, 122, 56), Color.rgb(138, 174, 86)],
  forest: [Color.rgb(30, 70, 42), Color.rgb(62, 108, 60)],
  mountain: [Color.rgb(84, 78, 74), Color.rgb(178, 172, 166)],
  snow: [Color.rgb(200, 214, 226), Color.rgb(250, 253, 255)],
};

/** Repräsentative Einzelfarbe pro Biom - für Legenden und Fallbacks. */
export const TILE_TYPE_COLOR: Record<TileType, Color> = Object.fromEntries(
  (Object.keys(TILE_TYPE_GRADIENT) as TileType[]).map((type) => {
    const [lo, hi] = TILE_TYPE_GRADIENT[type];
    const a = lo.toRGB();
    const b = hi.toRGB();
    return [type, Color.rgb((a[0] + b[0]) >> 1, (a[1] + b[1]) >> 1, (a[2] + b[2]) >> 1)];
  }),
) as Record<TileType, Color>;

export const TILE_TYPE_LABEL: Record<TileType, string> = {
  deep_water: "Tiefsee",
  water: "Wasser",
  beach: "Strand",
  desert: "Wüste",
  grass: "Wiese",
  forest: "Wald",
  mountain: "Gebirge",
  snow: "Schnee",
};

export const RESOURCE_TYPE_LABEL: Record<ResourceType, string> = {
  none: "-",
  wood: "Holz",
  gold: "Gold",
  stone: "Stein",
  berries: "Beeren",
};

export const RESOURCE_TYPE_COLORS: Record<ResourceType, Color> = {
  none: Color.rgb(0, 0, 0),
  wood: Color.rgb(72, 52, 28),
  gold: Color.rgb(198, 162, 48),
  stone: Color.rgb(124, 126, 134),
  berries: Color.rgb(168, 52, 62),
} as const;

/**
 * Eine Regel: auf `biome` entsteht `type`, sobald das Ressourcen-Rauschen über
 * `threshold` liegt und das feinere Häufchen-Rauschen über `cluster`. Das
 * erste legt grob fest, in welcher Gegend etwas vorkommt, das zweite teilt die
 * Gegend in kleine Vorkommen von einigen Tiles - wie in AoE2 ein paar
 * Beerensträucher oder ein Häufchen Stein statt einer ganzen Wiese voll.
 * `threshold: -Infinity` heißt: in jeder Gegend - jeder Wald trägt Holz, und
 * Beeren gibt es auf der ganzen Wiese. Die Menge ist (r + 1) * yield,
 * abgerundet, mindestens yield (r unter 0 zählt wie 0).
 *
 * Mit `clump` statt Häufchen-Rauschen: runde Gruppen dicht an dicht, je eine
 * in manchen Zellen eines Rasters (siehe ResourceClump) - Beerensträucher
 * stehen so zusammen wie in AoE2, statt als lange Streifen.
 *
 * Die Reihenfolge ist Teil der Regel - die erste passende gewinnt. Gold steht
 * deshalb vor Stein: beide liegen im Gebirge, Gold nur in der oberen Spitze
 * der Verteilung, der Rest wird Stein.
 *
 * Diese Tabelle ist die einzige Quelle für die Schwellen; resourceFromNoise()
 * liest sie.
 */
export interface ResourceRule {
  biome: TileType;
  type: Exclude<ResourceType, "none">;
  threshold: number;
  /**
   * Schwelle fürs Häufchen-Rauschen (-1..1); unter -1 zählt es nicht (Wälder).
   * Mit `clump` ist der Wert 1 in der Mitte einer Gruppe und 0 an ihrem Rand.
   */
  cluster: number;
  yield: number;
  clump?: ResourceClump;
}

/**
 * Gruppen statt Häufchen-Rauschen: Die Welt ist in Zellen von `cell` Tiles
 * geteilt; mit der Wahrscheinlichkeit `chance` liegt in einer Zelle eine
 * runde Gruppe mit Radius `radius` Tiles (bei 1,5 sind das 6-9 Tiles), ganz
 * innerhalb der Zelle - so bleiben zwischen den Gruppen Wege frei.
 */
export interface ResourceClump {
  cell: number;
  radius: number;
  chance: number;
}

export const RESOURCE_RULES: readonly ResourceRule[] = [
  { biome: "forest", type: "wood", threshold: -Infinity, cluster: -2, yield: 50 },
  { biome: "mountain", type: "gold", threshold: 0.4, cluster: 0.75, yield: 40 },
  { biome: "mountain", type: "stone", threshold: 0.1, cluster: 0.72, yield: 40 },
  {
    biome: "grass", type: "berries", threshold: -Infinity, cluster: 0, yield: 30,
    clump: { cell: 12, radius: 1.5, chance: 0.3 },
  },
];

/** Deterministischer Zufall 0..1 je Zelle, Kanal und Welt. */
function cellHash(x: number, y: number, channel: number, seed: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(channel, 2246822519) ^ seed;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Wert der Gruppe am Tile (x, y): 1 in der Mitte, 0 am Rand, darunter außerhalb. */
export function clumpValue(x: number, y: number, clump: ResourceClump, seed: number): number {
  const cx = Math.floor(x / clump.cell);
  const cy = Math.floor(y / clump.cell);
  if (cellHash(cx, cy, 0, seed) >= clump.chance) return -1;
  // Mitte so, dass die ganze Gruppe in der Zelle liegt.
  const margin = clump.radius + 1;
  const span = clump.cell - 2 * margin;
  const mx = cx * clump.cell + margin + cellHash(cx, cy, 1, seed) * span;
  const my = cy * clump.cell + margin + cellHash(cx, cy, 2, seed) * span;
  return 1 - Math.hypot(x + 0.5 - mx, y + 0.5 - my) / clump.radius;
}

/** Zahl aus dem Namen der Welt - für clumpValue(). */
function seedNumber(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return h;
}

/**
 * Maßstab des Häufchen-Rauschens: ein Vorkommen misst einige Tiles. Jede
 * Regel liest es an einer eigenen Stelle (RESOURCE_CLUSTER_OFFSET * Index),
 * damit Stein und Gold nicht in denselben Häufchen liegen.
 */
const RESOURCE_CLUSTER_SCALE = 0.075;
const RESOURCE_CLUSTER_OFFSET = [40, 68] as const;

/**
 * Wertet RESOURCE_RULES aus - erste passende Regel gewinnt. `cluster(i)` ist
 * das Häufchen-Rauschen (bzw. der Wert der Gruppe) für Regel i an diesem Tile.
 */
export function resourceFromNoise(
  tileType: TileType,
  r: number,
  cluster: (rule: number) => number,
): { type: ResourceType; amount: number } {
  for (let i = 0; i < RESOURCE_RULES.length; i++) {
    const rule = RESOURCE_RULES[i];
    if (rule.biome === tileType && r > rule.threshold && (rule.cluster < -1 || cluster(i) > rule.cluster)) {
      return { type: rule.type, amount: Math.floor((Math.max(r, 0) + 1) * rule.yield) };
    }
  }
  return { type: "none", amount: 0 };
}

export interface RenderTile extends MapTile {
  resource: ResourceType;
  resourceAmount: number; // 0-100
  /** Einmal bei der Chunk-Erzeugung berechnet. */
  rgb: RGB;
}

/**
 * Wasser bekommt eine durchgehende Tiefenrampe statt zweier Farbflächen -
 * sonst zeichnet die Grenze deep_water/water sichtbare Tintenkleckse ins Meer.
 */
const WATER_RAMP: RGB[] = [
  [96, 166, 202], // Uferlinie
  [44, 104, 162],
  [22, 58, 112],
  [8, 22, 56], // tiefste Stelle
];
/** Farbe der Brandung direkt am Ufer. */
const SURF: RGB = [178, 216, 224];

/** Weltmaßstab der Ressourcen-Vorkommen (1/RESOURCE_SCALE Tiles pro Einheit). */
const RESOURCE_SCALE = 0.009;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const byte = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/** Höhen-Band, in dem ein Biom liegt - für die Interpolation innerhalb des Bioms. */
function heightBand(type: TileType): [number, number] {
  switch (type) {
    case "deep_water":
      return [-1, TERRAIN_LEVELS.deepWater];
    case "water":
      return [TERRAIN_LEVELS.deepWater, TERRAIN_LEVELS.sea];
    case "beach":
      return [TERRAIN_LEVELS.sea, TERRAIN_LEVELS.shore];
    case "mountain":
      return [TERRAIN_LEVELS.hill, 1];
    case "snow":
      return [TERRAIN_LEVELS.peak, 1];
    default:
      return [TERRAIN_LEVELS.shore, TERRAIN_LEVELS.hill];
  }
}

/**
 * Endfarbe eines Tiles. Wasser bekommt eine Tiefen-Rampe und kaum Schattierung,
 * Land bekommt Hillshading aus der Hangneigung - das ist der eigentliche Grund,
 * warum die Karte nach Gelände aussieht und nicht nach Farbflecken.
 */
export function getTileRGB(tile: MapTile & { resource?: ResourceType; resourceAmount?: number }): RGB {
  const isWater = tile.tileType === "deep_water" || tile.tileType === "water";
  let r: number;
  let g: number;
  let bl: number;

  if (isWater) {
    // 0 = Uferlinie, 1 = tiefste Stelle. Die Wurzel zieht die Farbänderung an
    // die Küste, wo man sie sieht, statt sie im tiefen Meer zu verschenken.
    // Leichtes Dithern über das Detail-Rauschen, sonst sind die Stützstellen
    // der Rampe als konzentrische Streifen sichtbar (Mach-Banding).
    const depth = clamp01(
      (TERRAIN_LEVELS.sea - tile.height) / (TERRAIN_LEVELS.sea + 1) +
        (tile.variation - 0.5) * 0.03,
    );
    const pos = Math.pow(depth, 0.7) * (WATER_RAMP.length - 1);
    const i = Math.min(WATER_RAMP.length - 2, Math.floor(pos));
    const raw = pos - i;
    const f = raw * raw * (3 - 2 * raw);
    r = lerp(WATER_RAMP[i][0], WATER_RAMP[i + 1][0], f);
    g = lerp(WATER_RAMP[i][1], WATER_RAMP[i + 1][1], f);
    bl = lerp(WATER_RAMP[i][2], WATER_RAMP[i + 1][2], f);

    // Brandungssaum im ganz flachen Wasser
    const surf = Math.pow(clamp01(1 - depth / 0.16), 2) * 0.42;
    if (surf > 0) {
      r = lerp(r, SURF[0], surf);
      g = lerp(g, SURF[1], surf);
      bl = lerp(bl, SURF[2], surf);
    }
  } else {
    const [lo, hi] = TILE_TYPE_GRADIENT[tile.tileType];
    const [bandLo, bandHi] = heightBand(tile.tileType);

    const rel = clamp01((tile.height - bandLo) / (bandHi - bandLo || 1));
    const t = clamp01(0.2 + rel * 0.62 + (tile.variation - 0.5) * 0.3);

    const a = lo.toRGB();
    const b = hi.toRGB();
    r = lerp(a[0], b[0], t);
    g = lerp(a[1], b[1], t);
    bl = lerp(a[2], b[2], t);
  }

  const light = 1 + tile.shade * (isWater ? 0.08 : 0.42);
  r *= light;
  g *= light;
  bl *= light;

  return [byte(r), byte(g), byte(bl)];
}

/**
 * Farben und Skalen, die der WebGL-Shader als Uniforms bekommt. Die Reihenfolge
 * der Biome muss zu den B_*-Konstanten im Shader passen - das ist genau die
 * Deklarationsreihenfolge von TILE_TYPE_GRADIENT.
 */
export const TERRAIN_PALETTE = {
  biomeLo: (Object.keys(TILE_TYPE_GRADIENT) as TileType[]).map((t) => TILE_TYPE_GRADIENT[t][0]),
  biomeHi: (Object.keys(TILE_TYPE_GRADIENT) as TileType[]).map((t) => TILE_TYPE_GRADIENT[t][1]),
  waterRamp: WATER_RAMP,
  surf: SURF,
};

/**
 * Das Gelände für die Spiel-Logik: je Tile Geländeart, Höhe, Feuchte und das
 * Vorkommen, das der Generator dort hinlegt. Das Bild kommt aus dem Shader;
 * hier wird ein Tile bei Bedarf berechnet - ein paar Mikrosekunden, ohne Cache.
 */
export class Terrain {
  private resourceNoise: FractalNoise;
  private clusterNoise: SimplexNoise;
  private clumpSeed: number;

  constructor(private mapGen: MapGenerator, seed: string) {
    // Wenige Oktaven + niedrige Frequenz: Ressourcen sollen zusammenhängende
    // Vorkommen bilden, kein Konfetti über die ganze Karte.
    this.resourceNoise = new FractalNoise(new SimplexNoise(seed + "_resources"), 2, 0.5, 2);
    this.clusterNoise = new SimplexNoise(seed + "_resource_clusters");
    this.clumpSeed = seedNumber(seed + "_resource_clumps");
  }

  /** Häufchen-Rauschen bzw. Wert der Gruppe für Regel `rule` an Tile (x, y). */
  private cluster(x: number, y: number) {
    return (rule: number) => {
      const clump = RESOURCE_RULES[rule].clump;
      if (clump) return clumpValue(x, y, clump, this.clumpSeed + rule);
      return this.clusterNoise.noise2D(
          x * RESOURCE_CLUSTER_SCALE + rule * RESOURCE_CLUSTER_OFFSET[0],
          y * RESOURCE_CLUSTER_SCALE + rule * RESOURCE_CLUSTER_OFFSET[1]);
    };
  }

  private generateResources(tile: MapTile): { type: ResourceType; amount: number } {
    // Ressourcen spawnen nur auf passendem Terrain. Die Schwellen in
    // RESOURCE_RULES passen zur Verteilung von noise2D (sd ~0.6, -1..1).
    const r = this.resourceNoise.noise2D(tile.x * RESOURCE_SCALE, tile.y * RESOURCE_SCALE);
    return resourceFromNoise(tile.tileType, r, this.cluster(tile.x, tile.y));
  }

  /** Nur das Vorkommen und die Höhe eines Tiles - billiger als getTile(). */
  resourceAt(x: number, y: number): { height: number; type: ResourceType; amount: number; tileType: TileType } {
    const terrain = this.mapGen.terrainAt(x, y);
    const r = this.resourceNoise.noise2D(x * RESOURCE_SCALE, y * RESOURCE_SCALE);
    const res = resourceFromNoise(terrain.tileType, r, this.cluster(x, y));
    return { height: terrain.height, type: res.type, amount: res.amount, tileType: terrain.tileType };
  }

  getTile(worldX: number, worldY: number): RenderTile {
    const tile = this.mapGen.getTile(Math.floor(worldX), Math.floor(worldY));
    const res = this.generateResources(tile);
    const render = { ...tile, resource: res.type, resourceAmount: res.amount } as RenderTile;
    render.rgb = getTileRGB(render);
    return render;
  }
}

/** Kleinste Zoomstufe in CSS-Pixeln je Tile (siehe game/Camera.ts) - kleiner wird nichts vorberechnet. */
const MIN_TILE_SIZE = 1;

/**
 * Hauptansicht in isometrischer 3D-Sicht. Das Gelände entsteht komplett auf der
 * GPU, die Gebäude kommen als zweiter, instanzierter Durchgang darüber.
 */
export class MapRenderer {
  private terrain: TerrainRenderer;
  private entities: EntityRenderer;
  /**
   * Stärke des Reliefs, 1 = voll, gegen 0 flach. Zum Flachlegen, um hinter
   * Berge zu sehen. Nie ganz 0: das wäre für den Cache "kein Relief" und
   * würde ihn neu befüllen.
   */
  relief = 1;
  /**
   * CSS-Pixel je Tile, in denen der Gelände-Cache gerade berechnet ist. Beim
   * weichen Zoomen bleibt er stehen und wird nur gestreckt - neu berechnet
   * wird erst, wenn die Zoomstufe erreicht ist, oder beim Herauszoomen, sobald
   * der Cache das Bild nicht mehr abdeckt.
   */
  private cacheTileSize = 0;
  /**
   * CSS-Pixel je Tile am Zoomziel (siehe Camera.targetTileSize). Liegt es
   * über der Stufe des Caches, wird die Zielstufe schon vorberechnet, während
   * der Zoom noch hingleitet.
   */
  targetTileSize = 0;
  /**
   * Wird gerade geneigt? Dann bleibt der Gelände-Cache auf seiner
   * Bodenstauchung und wird nur gestreckt; neu berechnet wird, wenn der
   * Blickwinkel steht - oder wenn die Streckung zu groß wird.
   */
  tilting = false;
  /** Bodenstauchung, für die der Gelände-Cache gerade berechnet ist (0 = noch keine). */
  private cacheGroundV = 0;

  /**
   * Stehen die Blumen als 3D-Objekte in der Wiese? Hängt an der Stufe des
   * Gelände-Caches, nicht am Zoom: so malt er sie nie zugleich als Tupfen.
   */
  get flowerObjects(): boolean {
    return this.cacheTileSize * this.pixelRatio >= FLOWER_OBJECT_PIXELS;
  }

  constructor(
      canvas: HTMLCanvasElement,
      seed: string,
      public tileSize: number = 8,
      public pixelRatio: number = 1,
  ) {
    this.terrain = new TerrainRenderer(canvas, seed, TERRAIN_PALETTE);
    this.entities = new EntityRenderer(this.terrain.context);
  }

  /**
   * @param centerX Welt-Tile in der Bildmitte
   */
  /** Spielerfarbe für die Pfosten der Felder (0..255). */
  setPlayerColor(rgb: [number, number, number]) {
    this.entities.playerColor = rgb;
  }

  /** Feste Puffer für Instanzen, die sich nicht ändern (world/resources.ts). */
  createBatch(instances: readonly EntityInstance[]): StaticBatch {
    return this.entities.createBatch(instances);
  }

  deleteBatch(batch: StaticBatch) {
    this.entities.deleteBatch(batch);
  }

  /** Unter so vielen CSS-Pixeln je Tile zeichnen Bäume als Bild (0: nie) - Einstellung "Bäume als Bild". */
  set billboardBelow(cssPixelsPerTile: number) {
    this.entities.billboardBelow = cssPixelsPerTile;
  }

  /** Ob im letzten Bild Bäume als Bild gezeichnet wurden. */
  get billboardsActive(): boolean {
    return this.entities.billboardsActive;
  }

  /** Umgepflügte Äcker für den Gelände-Shader (siehe TerrainRenderer.setFields). */
  setFields(x: number, y: number, data: Uint8Array | null) {
    this.terrain.setFields(x, y, data);
  }

  /** Flächen, die unter Gebäuden eingeebnet werden - Gelände und Gebäude gleich. */
  setFlatZones(zones: readonly FlatZone[]) {
    const data = packZones(zones);
    const count = Math.min(zones.length, MAX_FLAT_ZONES);
    this.terrain.flatZones = data;
    this.terrain.flatCount = count;
    this.entities.flatZones = data;
    this.entities.flatCount = count;
  }

  /** false, wenn in diesem Bild nichts gezeichnet wurde - dann steht noch das letzte. */
  render(
      centerX: number,
      centerY: number,
      mouseTileX?: number,
      mouseTileY?: number,
      overlay: EntityInstance[] = [],
      batches: readonly StaticBatch[] = [],
  ): boolean {
    const canvas = this.terrain.context.canvas;
    // Auf einer Zoomstufe (Zweierpotenz) genau so fein wie das Bild; dazwischen
    // die bisherige Stufe, höchstens aber die nächstkleinere - deren Cache
    // deckt das ganze Bild ab.
    const level = 2 ** Math.floor(Math.log2(this.tileSize) + 1e-9);
    this.cacheTileSize = level === this.tileSize ? level : Math.min(this.cacheTileSize || level, level);
    // Beim Neigen: flacher gesehen deckt der gestreckte Cache nur so weit ab,
    // wie seine Blase reicht (bis 1,25), steiler wird er unscharf (ab 1/1,6).
    const groundV = viewGroundV();
    const stretch = this.cacheGroundV / groundV;
    if (!this.tilting || !this.cacheGroundV || stretch > 1.25 || stretch < 1 / 1.6) this.cacheGroundV = groundV;
    // Die Stufe, auf der der Zoom zur Ruhe kommen wird.
    const goal = 2 ** Math.ceil(Math.log2(this.targetTileSize || this.tileSize) - 1e-9);
    const camera = snapCamera({
      centerX,
      centerY,
      pixelsPerTile: this.tileSize * this.pixelRatio,
      cachePixelsPerTile: this.cacheTileSize * this.pixelRatio,
      cacheGroundV: this.cacheGroundV,
      // Beim Hineinzoomen zuerst die Zielstufe, damit sie beim Ankommen fertig
      // ist; die zwei nächstkleineren liegen so beim Herauszoomen bereit.
      prefetchPixelsPerTile: [...(goal > this.cacheTileSize ? [goal] : []), this.cacheTileSize / 2, this.cacheTileSize / 4]
          .filter((t) => t >= MIN_TILE_SIZE)
          .map((t) => t * this.pixelRatio),
      reliefScale: this.relief,
    }, canvas.width, canvas.height);

    this.terrain.hoverTile =
      mouseTileX !== undefined && mouseTileY !== undefined
        ? { x: mouseTileX, y: mouseTileY }
        : null;

    // Nichts gezeichnet: das letzte Bild bleibt stehen - ohne Figuren darüber.
    if (!this.terrain.render(camera)) return false;
    // Mindestens acht Geräte-Pixel: kleiner wird ein Gebäude auf der
    // herausgezoomten Karte zum Einzelpunkt und ist nicht mehr zu erkennen.
    this.entities.groundStep = this.terrain.gridCell;
    this.entities.render(overlay, camera, 8 / camera.pixelsPerTile, this.pixelRatio, true, batches);
    return true;
  }
}

/**
 * Übersichtskarte wie in AoE4: ein Quadrat der Welt rund um die Stelle, die
 * man gerade sieht, von oben, oben liegt die Blickrichtung. Das Canvas ist
 * quadratisch, Hud.css schneidet daraus die runde Scheibe im Holzring; der Ausschnitt der Hauptansicht ist darauf ein Rechteck.
 */
export class MiniMap {
  private terrain: TerrainRenderer;
  private entities: EntityRenderer;
  /** Kantenlänge des Canvas in CSS-Pixeln - der Kreis reicht von Rand zu Rand (Hud.css). */
  private cssSize = 244;

  /**
   * Wie viel breiter als die Hauptansicht die Minimap zeigt - bei jeder
   * Zoomstufe gleich: das Sichtrechteck ist immer etwa ein Fünftel davon, man
   * sieht die Umgebung und erkennt darin noch Gebäude und Felder.
   */
  private static readonly OVERVIEW = 5;
  /** Grenzen (u-Einheiten): ganz nah noch die Nachbarschaft, ganz weit nicht der halbe Kontinent. */
  private static readonly MIN_COVERAGE = 160;
  private static readonly MAX_COVERAGE = 6000;
  /** Senkrecht von oben: ein Quadrat der Welt ist dann auch im Bild quadratisch. */
  private static readonly TOP_DOWN = Math.PI / 2;

  constructor(
      private canvas: HTMLCanvasElement,
      seed: string,
      pixelRatio: number = 1,
  ) {
    this.terrain = new TerrainRenderer(canvas, seed, TERRAIN_PALETTE);
    this.entities = new EntityRenderer(this.terrain.context);
    // Ohne Relief gibt es nichts zu unterteilen.
    this.terrain.cellPixels = 64;
    // Die Minimap verschiebt sich nur mit der Hauptansicht und viel langsamer.
    this.terrain.bubblePixels = 64;
    this.setPixelRatio(pixelRatio);
  }

  setPixelRatio(pixelRatio: number) {
    this.canvas.width = Math.round(this.cssSize * pixelRatio);
    this.canvas.height = Math.round(this.cssSize * pixelRatio);
    this.canvas.style.width = `${this.cssSize}px`;
    this.canvas.style.height = `${this.cssSize}px`;
  }

  /**
   * Führt `fn` mit dem Blick senkrecht von oben aus - der Blickwinkel gilt für
   * alle Umrechnungen und Shader, die Hauptansicht bekommt danach ihren zurück.
   * `stretch`: wie viel höher ein Stück Boden hier ist als in der Hauptansicht.
   */
  private topDown<T>(fn: (stretch: number) => T): T {
    const main = viewElevation();
    setViewElevation(MiniMap.TOP_DOWN);
    try {
      return fn(Math.sin(viewElevation()) / Math.sin(main));
    } finally {
      setViewElevation(main);
    }
  }

  /** u-Einheiten, die die Minimap waagerecht abdeckt. */
  private coverage(view: IsoView): number {
    // Auf die nächste Zoomstufe gerundet: beim weichen Zoomen würde sich der
    // Maßstab sonst je Bild ändern und die Minimap jedes Mal neu berechnet.
    const tileSize = 2 ** Math.round(Math.log2(view.tileSize));
    return Math.min(Math.max((view.width / tileSize) * MiniMap.OVERVIEW, MiniMap.MIN_COVERAGE), MiniMap.MAX_COVERAGE);
  }

  /** Dieselbe Mitte wie die Hauptansicht, in CSS-Pixeln der Minimap. */
  private miniView(view: IsoView): IsoView {
    return {
      centerX: view.centerX,
      centerY: view.centerY,
      tileSize: this.cssSize / this.coverage(view),
      width: this.cssSize,
      height: this.cssSize,
    };
  }

  render(view: IsoView, overlay: EntityInstance[] = []) {
    this.topDown((stretch) => {
      const mini = this.miniView(view);
      const scale = this.canvas.width / this.cssSize;
      const camera = snapCamera({
        centerX: view.centerX,
        centerY: view.centerY,
        pixelsPerTile: mini.tileSize * scale,
        reliefScale: 0,
      }, this.canvas.width, this.canvas.height);

      const w = (view.width / view.tileSize) * mini.tileSize * scale;
      const h = (view.height / view.tileSize) * mini.tileSize * scale * stretch;
      this.terrain.viewRect = {
        x: (this.canvas.width - w) / 2,
        y: (this.canvas.height - h) / 2,
        width: w,
        height: h,
      };
      // Nichts gezeichnet: das letzte Bild bleibt stehen - ohne Figuren darüber.
      if (!this.terrain.render(camera)) return;
      // Auf der Minimap zählt nur, dass überhaupt etwas dasteht - vier Pixel
      // reichen dafür, die Form ist auf dieser Größe ohnehin nicht zu erkennen.
      this.entities.render(overlay, camera, 4 / camera.pixelsPerTile);
    });
  }

  /** CSS-Pixel der Minimap je Welt-Tile bei dieser Hauptansicht. */
  pixelsPerTile(view: IsoView): number {
    return this.miniView(view).tileSize;
  }

  /** Welt-Ausschnitt, den die Minimap zeigt - für das Einsammeln der Instanzen. */
  viewRectOf(view: IsoView) {
    return this.topDown(() => visibleWorldRect(this.miniView(view)));
  }

  /** Liegt die Stelle (CSS-Pixel im Canvas) auf der Scheibe? Die Ecken daneben sind Rahmen. */
  inside(x: number, y: number): boolean {
    const half = this.cssSize / 2;
    return Math.hypot(x - half, y - half) <= half;
  }

  /** Rechnet einen Klick (in CSS-Pixeln) auf die Minimap in Welt-Tiles um. */
  toWorld(clickX: number, clickY: number, view: IsoView): { x: number; y: number } {
    return this.topDown(() => screenToGround(this.miniView(view), clickX, clickY));
  }
}
