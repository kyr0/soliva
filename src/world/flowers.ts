// flowers.ts
// Blumen auf der Wiese als kleine 3D-Objekte (gl/flowerModel.ts) - erst nah
// genug heran (MapRenderer.flowerObjects), weiter draußen malt das Gelände
// sie als Tupfen. Verteilt wie dort: je Viertel-Tile höchstens eine, in
// Gruppen und manchen Wiesen dichter, meist eine Art je Gruppe, zu Wald,
// Strand, Wüste und Fels hin keine (MapGenerator.bloomAt). Wie die Vorkommen
// in Stücken einmal ausgerechnet und gemerkt (fillChunks in resources.ts).

import { FLOWERS, type EntityInstance } from '../gl/entityRenderer';
import { FLOWER_KINDS } from '../gl/flowerModel';
import type { Terrain } from '../map';
import { reliefZ, type MapGenerator } from '../noise';
import { CHUNK, fillChunks, hash } from './resources';
import type { ViewRect, World } from './world';

/** Zellen je Tile-Kante: je Zelle höchstens eine Blume. */
const CELLS = 4;
/** Nah heran ist der Bildschirm klein - so viele Stücke reichen weit darüber hinaus. */
const MAX_CHUNKS = 1200;
/**
 * Anteil der gemalten Blumen, der als 3D-Objekt wächst: weniger, dafür mit
 * allen Einzelheiten (Blütenkarte, siehe flowerModel.ts).
 */
const DENSITY = 0.35;
/** Höchste Wahrscheinlichkeit einer Zelle (dichte Gruppe in dichter Wiese). */
const MAX_CHANCE = 0.34 * DENSITY;

const smoothstep = (a: number, b: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class FlowerField {
  /** Je Stück die Blumen. */
  private chunks = new Map<string, EntityInstance[]>();

  constructor(private terrain: Terrain, private mapGen: MapGenerator) {}

  update(view: ViewRect, centerX: number, centerY: number, budgetMs = 3) {
    fillChunks(this.chunks, view, centerX, centerY, budgetMs, MAX_CHUNKS, (cx, cy) => this.generate(cx, cy));
  }

  /** Die Blumen im Rechteck - nicht auf Gebäuden und Feldern. */
  instances(view: ViewRect, world: World, out: EntityInstance[]) {
    const x1 = view.x + view.width;
    const y1 = view.y + view.height;
    for (let cy = Math.floor(view.y / CHUNK); cy <= Math.floor(y1 / CHUNK); cy++) {
      for (let cx = Math.floor(view.x / CHUNK); cx <= Math.floor(x1 / CHUNK); cx++) {
        const list = this.chunks.get(`${cx},${cy}`);
        if (!list) continue;
        for (const plant of list) {
          // Instanzen liegen mit der linken oberen Ecke; die Blume steht in der Mitte.
          const x = plant.x + 0.5;
          const y = plant.y + 0.5;
          if (x < view.x || x > x1 || y < view.y || y > y1) continue;
          if (world.at(Math.floor(x), Math.floor(y))) continue;
          out.push(plant);
        }
      }
    }
  }

  private generate(cx: number, cy: number): EntityInstance[] {
    const out: EntityInstance[] = [];
    for (let ty = cy * CHUNK; ty < (cy + 1) * CHUNK; ty++) {
      for (let tx = cx * CHUNK; tx < (cx + 1) * CHUNK; tx++) {
        // Blumendichte des Tiles - teuer, darum erst bei Bedarf und einmal je Tile.
        let bloom = -1;
        for (let j = 0; j < CELLS; j++) {
          for (let i = 0; i < CELLS; i++) {
            const gx = tx * CELLS + i;
            const gy = ty * CELLS + j;
            const rnd = hash(gx, gy, 20);
            if (rnd >= MAX_CHANCE) continue;
            const mx = (gx + 0.5) / CELLS;
            const my = (gy + 0.5) / CELLS;
            const meadow = smoothstep(0.1, 0.6, this.mapGen.detail(mx * 0.04 + 70, my * 0.04 - 30));
            const group = smoothstep(0.15, 0.65, this.mapGen.detail(mx * 0.9 + 5, my * 0.9 - 17));
            const chance = (0.01 + meadow * 0.05 + group * (0.12 + meadow * 0.16)) * DENSITY;
            if (rnd >= chance) continue;
            // Kein Platz zwischen Bäumen, Felsen und Sträuchern.
            if (bloom < 0) bloom = this.terrain.resourceAt(tx, ty).type !== 'none' ? 0 : this.mapGen.bloomAt(tx + 0.5, ty + 0.5);
            if (rnd >= chance * bloom) continue;
            this.plant(out, gx, gy);
          }
        }
      }
    }
    return out;
  }

  /** Die Blume der Zelle (gx, gy) - der Schatten gehört zum Modell. */
  private plant(out: EntityInstance[], gx: number, gy: number) {
    const x = (gx + 0.25 + 0.5 * hash(gx, gy, 21)) / CELLS;
    const y = (gy + 0.25 + 0.5 * hash(gx, gy, 22)) / CELLS;
    // Art: meist die der Gruppe (Flecken von gut einem Tile), jede fünfte eine andere.
    const own = hash(gx, gy, 23) < 0.2;
    const kindRnd = own ? hash(gx, gy, 24) : hash(Math.floor(x * 0.7), Math.floor(y * 0.7), 25);
    const kind = Math.min(FLOWER_KINDS.length - 1, Math.floor(kindRnd * FLOWER_KINDS.length));
    // Breite über die Blätter - die Blüte ist etwa ein Drittel davon.
    const size = 0.16 * (0.8 + 0.45 * hash(gx, gy, 26));
    const ground = reliefZ(this.mapGen.heightAt(x, y));
    const petal = FLOWER_KINDS[kind].petal;
    out.push({
      x: x - 0.5,
      y: y - 0.5,
      size,
      color: [Math.round(petal[0] * 255), Math.round(petal[1] * 255), Math.round(petal[2] * 255)],
      shape: FLOWERS[kind],
      alpha: 1,
      motion: [hash(gx, gy, 27) * Math.PI * 2, 0, 0, 1],
      ground,
    });
  }
}
