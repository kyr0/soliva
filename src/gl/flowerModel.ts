// flowerModel.ts
// Blumen als kleine 3D-Modelle, gebaut wie eine OBJ/MTL-Datei (Text): ein
// weicher Schatten und drei Blätter am Boden, ein Stiel mit einem Kelch und darauf die
// Blüte als Karte (BlossomCard) - auf sie malt der Shader Blütenblätter mit
// Fugen und Wölbung, die gewölbte Mitte und einen Glanzpunkt, wie die
// gemalten Blumen im Gelände (flower() in terrainShader.ts), die weit draußen
// weiter gemalt werden. So hat die Blüte alle Einzelheiten bei nur zwei
// Dreiecken; die Arten (FLOWER_KINDS) unterscheidet der Shader an der Form.
//
// Maße in Modell-Einheiten: die Blätter spannen die Breite 1 auf - so ist die
// Instanzgröße direkt die Breite in Tiles.

type RGB01 = [number, number, number];

export interface FlowerKind {
  name: string;
  /** Zahl der Blütenblätter - 0: Klee, ein rundes Köpfchen. */
  petals: number;
  petal: RGB01;
  heart: RGB01;
  /** Radius der Mitte als Anteil der Blüte. */
  heartSize: number;
}

/** Gänseblümchen, Butterblume, Mohn, Kornblume, Klee - Reihenfolge und Farben wie im Gelände-Shader. */
export const FLOWER_KINDS: readonly FlowerKind[] = [
  { name: 'Gänseblümchen', petals: 10, petal: [0.97, 0.97, 0.94], heart: [0.98, 0.78, 0.15], heartSize: 0.32 },
  { name: 'Butterblume', petals: 5, petal: [1.0, 0.86, 0.12], heart: [0.85, 0.62, 0.08], heartSize: 0.22 },
  { name: 'Mohn', petals: 4, petal: [0.9, 0.16, 0.12], heart: [0.12, 0.08, 0.08], heartSize: 0.26 },
  { name: 'Kornblume', petals: 8, petal: [0.3, 0.45, 0.95], heart: [0.2, 0.2, 0.55], heartSize: 0.2 },
  { name: 'Klee', petals: 0, petal: [0.92, 0.5, 0.72], heart: [0.8, 0.35, 0.58], heartSize: 0 },
];

/** Höhe der Blüte über dem Boden (Modell-Einheiten, Breite der Blätter = 1). */
const STEM_HEIGHT = 0.62;
/** Halbe Kantenlänge der Blütenkarte. */
const BLOSSOM_CARD = 0.34;
/** Halbe Kantenlänge der Schattenkarte am Boden. */
const SHADOW_CARD = 0.42;
const STEM_WIDTH = 0.035;
const LEAF_LENGTH = 0.5;
const LEAF_WIDTH = 0.14;

export function flowerModel(): { obj: string; mtl: string } {
  const lines: string[] = [];
  let count = 0;
  /** Eckpunkt in Datei-Koordinaten (x links, y oben, z vorn); liefert seinen Index (1-basiert). */
  const v = (x: number, y: number, z: number) => {
    lines.push(`v ${x.toFixed(4)} ${y.toFixed(4)} ${z.toFixed(4)}`);
    return ++count;
  };
  const f = (...ids: number[]) => lines.push(`f ${ids.join(' ')}`);
  const object = (name: string, material: string) => lines.push(`o ${name}`, `usemtl ${material}`);

  // Schatten der Blüte: eine Karte knapp über dem Boden, auf die der Shader
  // einen weichen dunklen Fleck malt - er zeigt, dass die Blüte über dem Gras
  // steht. Rund und mittig, denn die Blume steht je Instanz anders gedreht.
  object('Shadow', 'FlowerShadow');
  const [sx0, sz0] = [SHADOW_CARD, SHADOW_CARD * 0.96];
  // Knapp unter den Blättern - tiefer versänke er im Feinrelief des Geländes.
  f(v(-sx0, 0.04, -sz0), v(sx0, 0.04, -sz0), v(sx0, 0.04, sz0), v(-sx0, 0.04, sz0));

  // Blätter: drei Rauten vom Fuß nach außen, zur Mitte hin leicht gewölbt.
  object('Leaf', 'FlowerLeaf');
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.4;
    const [dx, dz] = [Math.cos(a), Math.sin(a)];
    const [sx, sz] = [-dz, dx];
    const base = v(0, 0.02, 0);
    const left = v(dx * LEAF_LENGTH * 0.45 + sx * LEAF_WIDTH, 0.06, dz * LEAF_LENGTH * 0.45 + sz * LEAF_WIDTH);
    const tip = v(dx * LEAF_LENGTH, 0.03, dz * LEAF_LENGTH);
    const right = v(dx * LEAF_LENGTH * 0.45 - sx * LEAF_WIDTH, 0.06, dz * LEAF_LENGTH * 0.45 - sz * LEAF_WIDTH);
    f(base, left, tip);
    f(base, tip, right);
  }

  // Stiel: ein schmaler, vierkantiger Stab bis zur Blüte.
  object('Stem', 'FlowerStem');
  const w = STEM_WIDTH / 2;
  const corners = [[-w, -w], [w, -w], [w, w], [-w, w]];
  const low = corners.map(([x, z]) => v(x, 0, z));
  const high = corners.map(([x, z]) => v(x, STEM_HEIGHT, z));
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    f(low[i], low[j], high[j], high[i]);
  }

  // Kelch: ein kleiner grüner Trichter unter der Blüte - von der Seite hebt
  // er sie sichtbar vom Stiel ab.
  const sepal = v(0, STEM_HEIGHT - 0.07, 0);
  const cup: number[] = [];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    cup.push(v(Math.cos(a) * 0.07, STEM_HEIGHT - 0.005, Math.sin(a) * 0.07));
  }
  for (let i = 0; i < 5; i++) f(sepal, cup[i], cup[(i + 1) % 5]);

  // Blüte: eine waagerechte Karte über dem Kelch. Minimal rechteckig: so
  // liegen die Achsen der Karte fest (frameOf), bei einem Quadrat wären sie
  // beliebig und die gemalte Blüte je Lage verschieden groß.
  object('Blossom', 'BlossomCard');
  const [cx, cz] = [BLOSSOM_CARD, BLOSSOM_CARD * 0.96];
  f(v(-cx, STEM_HEIGHT, -cz), v(cx, STEM_HEIGHT, -cz), v(cx, STEM_HEIGHT, cz), v(-cx, STEM_HEIGHT, cz));

  const color = (name: string, [r, g, b]: RGB01) => `newmtl ${name}\nKd ${r} ${g} ${b}`;
  const mtl = [
    color('FlowerLeaf', [0.2, 0.38, 0.12]),
    color('FlowerStem', [0.24, 0.42, 0.14]),
    // Die Karte trägt (u, v, Zufall) statt einer Farbe - die Farben stehen im Shader.
    color('BlossomCard', [1, 1, 1]),
    color('FlowerShadow', [0, 0, 0]),
  ].join('\n');
  return { obj: lines.join('\n'), mtl };
}
