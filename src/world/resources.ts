// resources.ts
// Die Vorkommen als Objekte in der Landschaft: Bäume auf Holz, Felsen auf
// Stein und Gold, Sträucher auf Beeren. Welche Tiles etwas tragen, ist eine
// reine Funktion des Geländes - es wird in Stücken von 16x16 Tiles einmal
// ausgerechnet und gemerkt, verteilt über mehrere Bilder. Ein Wald hat
// Tausende Tiles; je Bild neu zu rechnen wäre viel zu teuer.

import type { EntityInstance, StaticBatch } from '../gl/entityRenderer';
import { BILLBOARD_HEADINGS, SHAPE, TREES, modelSize } from '../gl/entityRenderer';
import type { Terrain } from '../map';
import { reliefZ, type MapGenerator } from '../noise';
import type { DepositType } from './catalog';
import type { ViewRect, World } from './world';

/** Klein genug, dass ein Stück das Zeitbudget eines Bildes nicht sprengt. */
export const CHUNK = 16;
/** So viele Stücke bleiben im Speicher - grob das Zehnfache eines Bildschirms. */
const MAX_CHUNKS = 6400;

/**
 * Modell und Grundgröße (Tiles) je Ressource. `variants`: stattdessen eine
 * dieser Formen, fest je Tile gewählt - nicht jeder Strauch sieht gleich aus.
 */
const LOOK: Record<DepositType, { shape: number; size: number; color: [number, number, number]; variants?: number[] }> = {
  wood: { shape: SHAPE.tree, size: 0.6, color: [42, 97, 52] },
  stone: {
    shape: SHAPE.stoneRock, size: 0.6, color: [158, 158, 164],
    variants: [SHAPE.stoneRock, SHAPE.stoneRock2, SHAPE.stoneRock3],
  },
  gold: {
    shape: SHAPE.goldRock, size: 0.56, color: [242, 194, 51],
    variants: [SHAPE.goldRock, SHAPE.goldRock2, SHAPE.goldRock3],
  },
  berries: {
    shape: SHAPE.berryBush, size: 0.55, color: [62, 115, 52],
    variants: [SHAPE.berryBush, SHAPE.berryBush2, SHAPE.berryBush3, SHAPE.berryBush4],
  },
};

/** Nadelbäume wachsen lieber oben, Laubbäume weiter unten. */
const CONIFERS = [SHAPE.tree, SHAPE.treePine];
/** Laubbäume, jeder so oft, wie er hier steht - Eichen am häufigsten. */
const BROADLEAF = [
  SHAPE.treeOak, SHAPE.treeOak, SHAPE.treeOak, SHAPE.treeOak, SHAPE.treeBirch, SHAPE.treeBirch2, SHAPE.treeBirch3,
  SHAPE.treeMaple, SHAPE.treePoplar,
];
/**
 * In einem Eichenhain stehen junge, ausgewachsene und alte Eichen gemischt -
 * je Tile eine davon, alte am seltensten.
 */
const OAKS = [
  SHAPE.treeOak, SHAPE.treeOak, SHAPE.treeOak, SHAPE.treeOak, SHAPE.treeOak,
  SHAPE.treeOakYoung, SHAPE.treeOakYoung, SHAPE.treeOakYoung, SHAPE.treeOakOld, SHAPE.treeOakOld,
];

/** Kantenlänge eines Hains in Tiles: darin wächst meist dieselbe Art. */
const GROVE = 7;

/**
 * Welche Baumart auf Tile (x, y) wächst: meist die des Hains, jeder vierte
 * Baum eine zufällige. Hoch gelegen mehr Nadelbäume.
 */
function treeAt(x: number, y: number, height: number): number {
  const own = hash(x, y, 7) < 0.25;
  const gx = own ? x : Math.floor(x / GROVE);
  const gy = own ? y : Math.floor(y / GROVE);
  // Waldtiles liegen etwa zwischen -0.3 und 0.5 hoch.
  const conifer = Math.min(1, Math.max(0, (height + 0.1) / 0.45));
  const kinds = hash(gx, gy, 8) < 0.25 + 0.6 * conifer ? CONIFERS : BROADLEAF;
  const kind = kinds[Math.floor(hash(gx, gy, 9) * kinds.length)];
  return kind === SHAPE.treeOak ? OAKS[Math.floor(hash(x, y, 10) * OAKS.length)] : kind;
}

/** Die Beerensträucher - leer gepflückt bleiben sie stehen. */
const BUSHES: number[] = [SHAPE.berryBush, SHAPE.berryBush2, SHAPE.berryBush3, SHAPE.berryBush4];

/** Welche Form eines Vorkommens mit mehreren Varianten auf Tile (x, y) steht - fest je Tile. */
function variantAt(x: number, y: number, kinds: number[]): number {
  return kinds[Math.floor(hash(x, y, 6) * kinds.length)];
}

/** Namen der Baum- und Straucharten für die Anzeige. */
const KIND_LABEL: Record<number, string> = {
  [SHAPE.tree]: 'Fichte',
  [SHAPE.treePine]: 'Kiefer',
  [SHAPE.treeOak]: 'Eiche',
  [SHAPE.treeBirch]: 'Birke',
  [SHAPE.treeBirch2]: 'Hängebirke',
  [SHAPE.treeBirch3]: 'Trauerbirke',
  [SHAPE.treePoplar]: 'Pappel',
  [SHAPE.treeMaple]: 'Ahorn',
  [SHAPE.treeOakOld]: 'Alte Eiche',
  [SHAPE.treeOakYoung]: 'Junge Eiche',
  [SHAPE.berryBush]: 'Johannisbeere',
  [SHAPE.berryBush2]: 'Brombeere',
  [SHAPE.berryBush3]: 'Heidelbeere',
  [SHAPE.berryBush4]: 'Himbeere',
};

/** Form des Vorkommens auf einem Tile - dieselbe Wahl für Bild und Anzeige. */
function shapeAt(x: number, y: number, type: DepositType, height: number): number {
  if (type === 'wood') return treeAt(x, y, height);
  const look = LOOK[type];
  return look.variants ? variantAt(x, y, look.variants) : look.shape;
}

interface ResourceNode {
  x: number;
  y: number;
  shape: number;
  total: number;
  /** Größe, wenn noch nichts abgebaut ist. */
  size: number;
  /** Höhe des Objekts in Tiles - für die Sichtprüfung (OnScreen). */
  top: number;
  /** Wird je Bild nur angepasst, nicht neu angelegt. */
  instance: EntityInstance;
}

/**
 * Steht ein Objekt im Bild? Fuß in der Mitte (x, y) auf Geländehöhe `ground`,
 * `height` Tiles hoch. Genauer als das Rechteck um die Bildraute
 * (visibleWorldRect), siehe onScreenTest in main.ts.
 */
export type OnScreen = (x: number, y: number, ground: number, height: number) => boolean;

/** Deterministischer Zufall 0..1 je Tile und Kanal - gleiche Welt, gleiche Bäume. */
export function hash(x: number, y: number, channel: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(channel, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Legt feste Puffer auf der Grafikkarte an (MapRenderer.createBatch). */
export interface Batcher {
  createBatch(instances: readonly EntityInstance[]): StaticBatch;
  deleteBatch(batch: StaticBatch): void;
}

/** Kantenlänge einer Region in Stücken - ihre Vorkommen teilen sich einen festen Puffer. */
const REGION = 4;
const REGION_TILES = REGION * CHUNK;
/** Zeitbudget je Bild für Regionen, die nur neue Stücke dazubekommen haben. */
const REGION_BUDGET_MS = 3;

interface Region {
  batch: StaticBatch | null;
  /** Stücke kamen hinzu - der Puffer ist unvollständig, zeigt aber nichts Falsches. */
  stale: boolean;
  /** Ein Tile wurde angefasst oder frei, oder die Auswahl wechselte - der Puffer zeigt Falsches. */
  wrong: boolean;
}

export class ResourceField {
  private chunks = new Map<string, ResourceNode[]>();
  private regions = new Map<string, Region>();
  private batcher?: Batcher;
  /** Angefasste Tiles ("x,y") - sie laufen Bild für Bild einzeln, nicht im festen Puffer. */
  private touchedKeys = new Set<string>();
  /** Dieselben je Region. */
  private touched = new Map<string, { x: number; y: number }[]>();
  private seenDeposits: unknown = null;
  private seenRevision = -1;
  private selectedKey: string | null = null;

  constructor(private terrain: Terrain, private mapGen: MapGenerator) {}

  /**
   * Vorkommen, deren Objekt am Bildschirmpunkt liegt: `hit` bekommt je
   * sichtbarem Objekt Tile, Lage (Mitte am Boden) und Instanz und liefert die
   * Tiefe des Treffers oder undefined. Gewinnt der vorderste Treffer.
   */
  pick(view: ViewRect, hit: (inst: EntityInstance, x: number, y: number) => number | undefined): { x: number; y: number } | undefined {
    const x1 = view.x + view.width;
    const y1 = view.y + view.height;
    let best: { x: number; y: number } | undefined;
    let bestDepth = -Infinity;
    for (let cy = Math.floor(view.y / CHUNK); cy <= Math.floor(y1 / CHUNK); cy++) {
      for (let cx = Math.floor(view.x / CHUNK); cx <= Math.floor(x1 / CHUNK); cx++) {
        for (const node of this.chunks.get(`${cx},${cy}`) ?? []) {
          if (node.x < view.x || node.x > x1 || node.y < view.y || node.y > y1) continue;
          const depth = hit(node.instance, node.x, node.y);
          if (depth !== undefined && depth > bestDepth) {
            bestDepth = depth;
            best = { x: node.x, y: node.y };
          }
        }
      }
    }
    return best;
  }

  /** Länge des Baums auf Tile (x, y) in Tiles - für die Holzfäller am liegenden Stamm. */
  treeLengthAt(x: number, y: number): number | undefined {
    const node = this.chunks.get(`${Math.floor(x / CHUNK)},${Math.floor(y / CHUNK)}`)?.find((n) => n.x === x && n.y === y);
    if (!node || !TREES.includes(node.shape)) return undefined;
    const dims = modelSize(node.shape);
    return dims && dims.height * node.size;
  }

  /** Baum- oder Strauchart auf Tile (x, y), z. B. "Eiche" - sonst undefined. */
  kindAt(x: number, y: number): string | undefined {
    const found = this.terrain.resourceAt(x, y);
    if (found.type === 'none') return undefined;
    return KIND_LABEL[shapeAt(x, y, found.type as DepositType, found.height)];
  }

  /**
   * Rechnet fehlende Stücke im Rechteck aus, die der Mitte nächsten zuerst,
   * bis das Zeitbudget dieses Bildes aufgebraucht ist.
   */
  update(view: ViewRect, centerX: number, centerY: number, budgetMs = 4) {
    fillChunks(this.chunks, view, centerX, centerY, budgetMs, MAX_CHUNKS, (cx, cy) => this.generate(cx, cy), {
      // Neue Stücke: ihre Region muss neu gebündelt werden; weggefallene räumen sie ab.
      added: (cx, cy) => {
        const region = this.regions.get(`${Math.floor(cx / REGION)},${Math.floor(cy / REGION)}`);
        if (region) region.stale = true;
      },
      dropped: (cx, cy) => this.dropRegion(cx, cy),
    });
  }

  private generate(cx: number, cy: number): ResourceNode[] {
    const nodes: ResourceNode[] = [];
    for (let y = cy * CHUNK; y < (cy + 1) * CHUNK; y++) {
      for (let x = cx * CHUNK; x < (cx + 1) * CHUNK; x++) {
        const found = this.terrain.resourceAt(x, y);
        if (found.type === 'none' || found.amount <= 0) continue;
        const look = LOOK[found.type as DepositType];
        // Etwas Streuung, damit ein Wald nicht aus lauter gleichen Bäumen
        // besteht: Größe, Drehung, Farbton und Lage im Tile.
        const size = look.size * (0.8 + 0.4 * hash(x, y, 1));
        const shade = 0.82 + 0.3 * hash(x, y, 2);
        const [px, py] = found.type === 'berries' ? this.towardGroup(x, y) : [0, 0];
        const ox = x + px + (hash(x, y, 3) - 0.5) * 0.35;
        const oy = y + py + (hash(x, y, 4) - 0.5) * 0.35;
        const shape = shapeAt(x, y, found.type as DepositType, found.height);
        nodes.push({
          x,
          y,
          shape,
          total: found.amount,
          size,
          top: (modelSize(shape)?.height ?? 1) * size,
          instance: {
            x: ox,
            y: oy,
            size,
            color: look.color.map((c) => Math.min(255, Math.round(c * shade))) as [number, number, number],
            shape,
            alpha: 1,
            // Bäume nur in den Richtungen ihrer Bilder (BILLBOARD_HEADINGS) -
            // sonst drehte sich ein Baum beim Wechsel zwischen Bild und Modell.
            motion: [TREES.includes(shape)
              ? (Math.floor(hash(x, y, 5) * BILLBOARD_HEADINGS) * Math.PI * 2) / BILLBOARD_HEADINGS
              : hash(x, y, 5) * Math.PI * 2, 0, 0, 0],
            ground: this.groundUnder(ox + 0.5, oy + 0.5, size / 2),
          },
        });
      }
    }
    return nodes;
  }

  /**
   * Verschiebung eines Beerenstrauchs zur Mitte seiner Gruppe (Tiles): ein
   * Stück hin zum Schwerpunkt der Beeren-Tiles ringsum. Die Sträucher am Rand
   * rücken so an die inneren heran, und eine Gruppe steht dicht wie ein Busch.
   */
  private towardGroup(x: number, y: number): [number, number] {
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (this.terrain.resourceAt(x + dx, y + dy).type !== 'berries') continue;
        sx += dx;
        sy += dy;
        n++;
      }
    }
    return [(sx / n) * 0.45, (sy / n) * 0.45];
  }

  /**
   * Tiefster Punkt des Geländes unter einem Objekt (Mitte und vier Punkte am
   * Rand). Am Hang steht es so mit der Talseite auf dem Boden und mit der
   * Bergseite im Hang - auf der Mitte oder gar der Tile-Ecke abgestellt
   * schwebte es talseitig über dem Boden.
   */
  private groundUnder(x: number, y: number, radius: number): number {
    let lowest = this.mapGen.heightAt(x, y);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      lowest = Math.min(lowest, this.mapGen.heightAt(x + dx * radius, y + dy * radius));
    }
    return reliefZ(lowest);
  }

  /**
   * Die Objekte im Rechteck. Was abgebaut wird, schrumpft, was leer ist,
   * verschwindet. Das ausgewählte Vorkommen bekommt einen Balken mit dem Rest.
   *
   * Mit `statics`: Alles, woran niemand arbeitet, liegt je Region in einem
   * festen Puffer auf der Grafikkarte (statics.out) - einmal gebaut, danach
   * nur gezeichnet. Nach `out` kommen dann nur die angefassten Tiles und die
   * Auswahl. Weit herausgezoomt sind das Zehntausende Bäume weniger je Bild.
   */
  instances(view: ViewRect, world: World, out: EntityInstance[],
            selected: { x: number; y: number } | null = null, blend = 1,
            statics?: { batcher: Batcher; out: StaticBatch[] }, onScreen?: OnScreen) {
    const x1 = view.x + view.width;
    const y1 = view.y + view.height;
    const inView = (n: ResourceNode) => n.x >= view.x && n.x <= x1 && n.y >= view.y && n.y <= y1
      && (!onScreen || onScreen(n.instance.x + 0.5, n.instance.y + 0.5, n.instance.ground ?? 0, n.top));
    if (!statics) {
      for (let cy = Math.floor(view.y / CHUNK); cy <= Math.floor(y1 / CHUNK); cy++) {
        for (let cx = Math.floor(view.x / CHUNK); cx <= Math.floor(x1 / CHUNK); cx++) {
          for (const node of this.chunks.get(`${cx},${cy}`) ?? []) {
            if (inView(node)) this.pushNode(node, world, out, selected, blend);
          }
        }
      }
      return;
    }

    this.batcher = statics.batcher;
    this.syncTouched(world, selected);
    const start = performance.now();
    for (let ry = Math.floor(view.y / REGION_TILES); ry <= Math.floor(y1 / REGION_TILES); ry++) {
      for (let rx = Math.floor(view.x / REGION_TILES); rx <= Math.floor(x1 / REGION_TILES); rx++) {
        const key = `${rx},${ry}`;
        let region = this.regions.get(key);
        if (!region) this.regions.set(key, (region = { batch: null, stale: true, wrong: false }));
        // Falsch (angefasst, Auswahl) muss sofort neu - sonst stünde ein Baum
        // doppelt da. Nur unvollständig (neue Stücke) darf warten.
        if (region.wrong || (region.stale && (!region.batch || performance.now() - start < REGION_BUDGET_MS))) {
          this.rebuild(rx, ry, region, statics.batcher);
        }
        if (region.batch) statics.out.push(region.batch);
        for (const t of this.touched.get(key) ?? []) {
          const node = this.nodeAt(t.x, t.y);
          if (node && inView(node)) this.pushNode(node, world, out, selected, blend);
        }
      }
    }
    if (selected && !this.touchedKeys.has(`${selected.x},${selected.y}`)) {
      const node = this.nodeAt(selected.x, selected.y);
      if (node && inView(node)) this.pushNode(node, world, out, selected, blend);
    }
  }

  /** Ein Vorkommen so, wie es gerade ist - abgebaut, gefällt, ausgewählt. */
  private pushNode(node: ResourceNode, world: World, out: EntityInstance[],
                   selected: { x: number; y: number } | null, blend: number) {
    const share = world.remainingShare(node.x, node.y, node.total);
    // Beerensträucher bleiben stehen und verlieren nur ihre Beeren
    // (motion[3] = Rest, siehe P_BERRY im Shader). Felsen schrumpfen
    // und verschwinden, wenn sie leer sind.
    const bush = BUSHES.includes(node.shape);
    // Bäume behalten ihre Größe: sie werden im Shader von der Spitze her
    // abgesägt (motion[3] = Rest), leer bleibt ein Stumpf stehen.
    const tree = TREES.includes(node.shape);
    if (share <= 0 && !bush && !tree) return;
    // Liegt auf dem Tile ein Feld, ist der Stumpf ausgegraben - Felder
    // gibt es nur auf abgebauten Vorkommen, gefragt wird also nur dort.
    if (share <= 0 && world.at(node.x, node.y)?.isFarm()) return;
    node.instance.size = bush || tree ? node.size : node.size * (0.45 + 0.55 * share);
    // Gefällte Bäume kippen um bzw. liegen: Winkel und Richtung des
    // Falls stecken in motion[1] und motion[2].
    const motion = node.instance.motion!;
    const fall = tree ? world.fall(node.x, node.y, blend) : null;
    // Ganz verbraucht steht der Stumpf wieder aufrecht - der liegende
    // Stamm ist abgesägt und weggetragen.
    motion[1] = fall && share > 0 ? fall.angle : 0;
    motion[2] = fall ? fall.dir : 0;
    motion[3] = share;
    // Die Instanzen werden wiederverwendet - der Balken muss also auch
    // wieder weg, wenn die Auswahl wechselt.
    node.instance.health =
      selected && selected.x === node.x && selected.y === node.y ? share : undefined;
    out.push(node.instance);
  }

  private nodeAt(x: number, y: number): ResourceNode | undefined {
    return this.chunks.get(`${Math.floor(x / CHUNK)},${Math.floor(y / CHUNK)}`)?.find((n) => n.x === x && n.y === y);
  }

  private regionKeyOfTile(x: number, y: number): string {
    return `${Math.floor(x / REGION_TILES)},${Math.floor(y / REGION_TILES)}`;
  }

  /**
   * Liest die angefassten Tiles neu, wenn sich an den Vorkommen etwas geändert
   * hat, und markiert die Regionen, deren Puffer dadurch falsch sind - ebenso
   * beim Wechsel der Auswahl.
   */
  private syncTouched(world: World, selected: { x: number; y: number } | null) {
    const wrong = (k: string) => {
      const comma = k.indexOf(',');
      const region = this.regions.get(this.regionKeyOfTile(Number(k.slice(0, comma)), Number(k.slice(comma + 1))));
      if (region) region.wrong = true;
    };
    const selectedKey = selected ? `${selected.x},${selected.y}` : null;
    if (selectedKey !== this.selectedKey) {
      if (this.selectedKey) wrong(this.selectedKey);
      if (selectedKey) wrong(selectedKey);
      this.selectedKey = selectedKey;
    }
    const deposits = world.deposits;
    if (deposits === this.seenDeposits && deposits.revision === this.seenRevision) return;
    this.seenDeposits = deposits;
    this.seenRevision = deposits.revision;
    const next = new Set(deposits.touched());
    for (const k of next) if (!this.touchedKeys.has(k)) wrong(k);
    for (const k of this.touchedKeys) if (!next.has(k)) wrong(k);
    this.touchedKeys = next;
    this.touched.clear();
    for (const k of next) {
      const comma = k.indexOf(',');
      const x = Number(k.slice(0, comma));
      const y = Number(k.slice(comma + 1));
      const region = this.regionKeyOfTile(x, y);
      let list = this.touched.get(region);
      if (!list) this.touched.set(region, (list = []));
      list.push({ x, y });
    }
  }

  /** Baut den festen Puffer einer Region: alle Vorkommen ihrer Stücke, an denen niemand arbeitet. */
  private rebuild(rx: number, ry: number, region: Region, batcher: Batcher) {
    const list: EntityInstance[] = [];
    for (let cy = ry * REGION; cy < (ry + 1) * REGION; cy++) {
      for (let cx = rx * REGION; cx < (rx + 1) * REGION; cx++) {
        for (const node of this.chunks.get(`${cx},${cy}`) ?? []) {
          const key = `${node.x},${node.y}`;
          if (this.touchedKeys.has(key) || key === this.selectedKey) continue;
          // So, wie pushNode() ein unberührtes Vorkommen zeigt: volle Größe,
          // steht, voller Rest, kein Balken.
          list.push({ ...node.instance, size: node.size, motion: [node.instance.motion![0], 0, 0, 1], health: undefined });
        }
      }
    }
    if (region.batch) batcher.deleteBatch(region.batch);
    region.batch = list.length > 0 ? batcher.createBatch(list) : null;
    region.stale = false;
    region.wrong = false;
  }

  /** Fallen Stücke weg, wird die Region beim nächsten Zeigen neu gebaut; ihr Puffer ist frei. */
  private dropRegion(cx: number, cy: number) {
    const key = `${Math.floor(cx / REGION)},${Math.floor(cy / REGION)}`;
    const region = this.regions.get(key);
    if (!region) return;
    if (region.batch) this.batcher?.deleteBatch(region.batch);
    this.regions.delete(key);
  }
}

/**
 * Rechnet fehlende Stücke (CHUNK x CHUNK Tiles) im Rechteck aus, die der
 * Mitte nächsten zuerst, bis das Zeitbudget dieses Bildes aufgebraucht ist.
 * Sind mehr als `maxChunks` gemerkt, fallen die am weitesten entfernten weg.
 * `hooks` erfahren von neuen und weggefallenen Stücken.
 */
export function fillChunks<T>(
    chunks: Map<string, T>, view: ViewRect, centerX: number, centerY: number,
    budgetMs: number, maxChunks: number, generate: (cx: number, cy: number) => T,
    hooks: { added?: (cx: number, cy: number) => void; dropped?: (cx: number, cy: number) => void } = {},
) {
  const missing: [number, number][] = [];
  const cx0 = Math.floor(view.x / CHUNK);
  const cy0 = Math.floor(view.y / CHUNK);
  const cx1 = Math.floor((view.x + view.width) / CHUNK);
  const cy1 = Math.floor((view.y + view.height) / CHUNK);
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      if (!chunks.has(`${cx},${cy}`)) missing.push([cx, cy]);
    }
  }
  if (missing.length === 0) return;

  const distance = ([cx, cy]: [number, number]) =>
    Math.hypot((cx + 0.5) * CHUNK - centerX, (cy + 0.5) * CHUNK - centerY);
  missing.sort((a, b) => distance(a) - distance(b));

  const start = performance.now();
  for (const [cx, cy] of missing) {
    chunks.set(`${cx},${cy}`, generate(cx, cy));
    hooks.added?.(cx, cy);
    if (performance.now() - start > budgetMs) break;
  }

  // Zu viele gemerkt: die am weitesten entfernten fallen weg.
  if (chunks.size > maxChunks) {
    const keys = [...chunks.keys()].map((k) => {
      const [cx, cy] = k.split(',').map(Number);
      return { k, d: distance([cx, cy]) };
    });
    keys.sort((a, b) => b.d - a.d);
    const drop = chunks.size - maxChunks;
    for (let i = 0; i < drop; i++) {
      chunks.delete(keys[i].k);
      const [cx, cy] = keys[i].k.split(',').map(Number);
      hooks.dropped?.(cx, cy);
    }
  }
}
