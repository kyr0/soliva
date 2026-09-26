// deposits.ts
// Die Vorkommen auf der Karte - Bäume, Felsen, Beerensträucher: was schon
// entnommen ist, was leer ist, welche Bäume liegen und welche Sträucher
// nachwachsen. Wie viel ein Vorkommen anfangs hat, sagt das Gelände (Terrain);
// hier steht nur, was sich seitdem geändert hat - so bleibt der Spielstand
// klein und übersteht eine Änderung am Generator.

import { FALL_LYING } from '../gl/entityRenderer';
import type { Terrain } from '../map';
import type { DepositType } from './catalog';

/**
 * Beerensträucher: nach dem letzten Pflücken BERRY_REST Sekunden Pause, dann
 * wachsen sie in BERRY_REGROW_TIME Sekunden von leer auf voll nach.
 */
const BERRY_REST = 90 * 60;
const BERRY_REGROW_TIME = 5 * 60;

/** Ablauf des Umfallens: beschleunigen, einmal nachfedern, liegen. */
const FALL_SECONDS = 1.1;
const BOUNCE_SECONDS = 0.35;

const key = (x: number, y: number) => `${x},${y}`;

/** Ein Vorkommen für die Anzeige. */
export interface DepositInfo {
  type: DepositType;
  remaining: number;
  total: number;
  /** Beerenstrauch: Sekunden, bis er wieder voll ist. */
  regrowIn?: number;
}

export class Deposits {
  /** "x,y" -> bereits entnommene Menge. */
  readonly harvested = new Map<string, number>();
  /** Leer - dort liegt nichts mehr (Beerensträucher, bis sie nachwachsen). */
  private exhausted = new Set<string>();
  /** Angepflückte Beerensträucher: volle Menge und wann zuletzt gepflückt (Weltzeit). */
  private berryBushes = new Map<string, { total: number; picked: number }>();
  /** Gefällte Bäume: wann (Weltzeit) und wohin sie fielen. */
  private felled = new Map<string, { at: number; dir: number }>();
  /**
   * Zählt hoch, sobald ein Tile angefasst wird (angebaut, gefällt) oder wieder
   * ganz frei ist - die Anzeige baut dann ihre festen Puffer neu (resources.ts).
   */
  revision = 0;

  constructor(private terrain: Terrain) {}

  /** Was an einem Tile noch liegt - Art null, wenn nichts (mehr). */
  remainingAt(x: number, y: number): { type: DepositType | null; amount: number } {
    const k = key(x, y);
    if (this.exhausted.has(k)) return { type: null, amount: 0 };
    const tile = this.terrain.getTile(x, y);
    if (tile.resource === 'none' || tile.resourceAmount <= 0) return { type: null, amount: 0 };
    return { type: tile.resource as DepositType, amount: tile.resourceAmount - (this.harvested.get(k) ?? 0) };
  }

  /** Anteil, der noch übrig ist (0..1) - `total` kennt der Aufrufer schon, das Gelände bleibt unberechnet. */
  remainingShare(x: number, y: number, total: number): number {
    const k = key(x, y);
    if (this.exhausted.has(k)) return 0;
    const taken = this.harvested.get(k);
    return taken === undefined ? 1 : Math.max(0, 1 - taken / total);
  }

  isExhausted(x: number, y: number): boolean {
    return this.exhausted.has(key(x, y));
  }

  isFelled(x: number, y: number): boolean {
    return this.felled.has(key(x, y));
  }

  /** In welche Richtung (Radiant) ein gefällter Baum liegt - undefined, wenn er steht. */
  fellDirection(x: number, y: number): number | undefined {
    return this.felled.get(key(x, y))?.dir;
  }

  /** Alles für die Anzeige - null, wenn dort nichts ist. Leere Beerensträucher bleiben, sie wachsen nach. */
  info(x: number, y: number, now: number): DepositInfo | null {
    const k = key(x, y);
    const bush = this.berryBushes.get(k);
    const found = this.remainingAt(x, y);
    if (!bush && (!found.type || found.amount <= 0)) return null;
    if (!bush) return { type: found.type!, remaining: found.amount, total: this.terrain.getTile(x, y).resourceAmount };
    const remaining = Math.max(0, bush.total - (this.harvested.get(k) ?? 0));
    return {
      type: 'berries',
      remaining,
      total: bush.total,
      // Rest der Pause plus Nachwachsen.
      regrowIn: Math.max(0, BERRY_REST - (now - bush.picked)) + (bush.total - remaining) / (bush.total / BERRY_REGROW_TIME),
    };
  }

  /**
   * Wie weit ein Baum umgefallen ist: Winkel (Radiant, 0 = steht) und
   * Richtung - null, wenn er steht. Der Fall beschleunigt wie unter
   * Schwerkraft, federt beim Aufschlag einmal nach und bleibt dann liegen.
   */
  fall(x: number, y: number, now: number): { angle: number; dir: number } | null {
    const f = this.felled.get(key(x, y));
    if (!f) return null;
    const t = now - f.at;
    const angle = t < FALL_SECONDS ? FALL_LYING * (t / FALL_SECONDS) ** 2
      : t < FALL_SECONDS + BOUNCE_SECONDS ? FALL_LYING - 0.14 * Math.sin((Math.PI * (t - FALL_SECONDS)) / BOUNCE_SECONDS)
      : FALL_LYING;
    return { angle, dir: f.dir };
  }

  /** Fällt den Baum auf (x, y) in Richtung `dir`. false, wenn er schon liegt. */
  fell(x: number, y: number, dir: number, now: number): boolean {
    const k = key(x, y);
    if (this.felled.has(k)) return false;
    this.felled.set(k, { at: now, dir });
    this.revision++;
    return true;
  }

  /** Alle angefassten Tiles: angebaut, gepflückt oder gefällt. */
  *touched(): Iterable<string> {
    yield* this.harvested.keys();
    for (const k of this.felled.keys()) if (!this.harvested.has(k)) yield k;
  }

  /**
   * Entnimmt `amount` (höchstens, was noch da ist) und gibt zurück, wie viel
   * es war. Beerensträucher merken sich, wann gepflückt wurde - danach wachsen sie nach.
   */
  take(x: number, y: number, amount: number, now: number): number {
    const found = this.remainingAt(x, y);
    if (!found.type) return 0;
    const take = Math.min(amount, found.amount);
    const k = key(x, y);
    const before = this.harvested.get(k);
    if (before === undefined) this.revision++;
    const taken = (before ?? 0) + take;
    this.harvested.set(k, taken);
    if (found.type === 'berries') {
      const total = this.berryBushes.get(k)?.total ?? found.amount + taken - take;
      this.berryBushes.set(k, { total, picked: now });
    }
    if (found.amount - take <= 1e-6) this.exhausted.add(k);
    return take;
  }

  /**
   * Beerensträucher wachsen nach: erst BERRY_REST Sekunden nach dem letzten
   * Pflücken, dann in BERRY_REGROW_TIME Sekunden von leer auf voll. Sobald
   * wieder etwas daran hängt, kann man sie erneut abernten. true, wenn etwas nachwuchs.
   */
  regrow(dt: number, now: number): boolean {
    let grew = false;
    for (const [k, { total, picked }] of this.berryBushes) {
      if (now - picked < BERRY_REST) continue;
      const taken = (this.harvested.get(k) ?? 0) - (total / BERRY_REGROW_TIME) * dt;
      if (taken <= 0) {
        this.harvested.delete(k);
        this.berryBushes.delete(k);
        this.exhausted.delete(k);
        this.revision++;
      } else {
        this.harvested.set(k, taken);
        if (taken < total - 1) this.exhausted.delete(k);
      }
      grew = true;
    }
    return grew;
  }

  /**
   * Aus dem Speicherstand: entnommene Mengen. Wann zuletzt gepflückt wurde,
   * steht nicht darin - die Pause beginnt von vorn. Angefangene Bäume liegen
   * schon, ohne noch einmal umzufallen; die Richtung ergibt sich aus der Lage.
   */
  restore(harvested: Record<string, number>) {
    this.revision++;
    for (const [k, amount] of Object.entries(harvested)) {
      this.harvested.set(k, amount);
      const comma = k.indexOf(',');
      const [x, y] = [Number(k.slice(0, comma)), Number(k.slice(comma + 1))];
      const tile = this.terrain.getTile(x, y);
      if (amount >= tile.resourceAmount) this.exhausted.add(k);
      if (tile.resource === 'berries') this.berryBushes.set(k, { total: tile.resourceAmount, picked: 0 });
      if (tile.resource === 'wood') this.felled.set(k, { at: -Infinity, dir: ((x * 7 + y * 13) % 8) * (Math.PI / 4) });
    }
  }

  clear() {
    this.harvested.clear();
    this.exhausted.clear();
    this.berryBushes.clear();
    this.felled.clear();
  }
}
