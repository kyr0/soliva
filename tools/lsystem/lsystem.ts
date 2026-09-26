// L-System-Bäume in 3D (https://en.wikipedia.org/wiki/L-system): Ersetzungs-
// regeln erzeugen eine Zeichenkette, eine Schildkröte im Raum liest sie und
// zeichnet Äste und Laub. Läuft im Browser (index.html) und in Node
// (export.ts) - daher nur primitives.mjs, kein node:fs.
//
// Zeichen der Schildkröte (wie in "The Algorithmic Beauty of Plants"); jedes
// darf ein Zahl-Argument in Klammern haben, z. B. F(2) oder +(30):
//   F    Ast zeichnen (aktuelle Länge oder Argument)   f    nur bewegen
//   + -  gieren um die Hochachse U                      & ^  nicken um die Querachse L
//   \ /  rollen um die Blickrichtung H                  |    umdrehen (180°)
//   [ ]  Zustand merken / zurückholen (Verzweigung)
//   "    Länge mal lengthFactor (oder Argument)
//   ~    Tropismus ab hier für diesen Ast (Argument; ohne: wieder der des Rezepts)
//   L    Laub; ebenso alle Zeichen in `leaves`
//   Zeichen in `organs` werden als Organ gezeichnet (Blatt, Ähre, Kolben ...);
//   ein Argument vergrößert es, z. B. B(0.7)
// Andere Zeichen (A, B, ...) sind nur Platzhalter für die Regeln.
//
// Die Astdicke folgt dem Pipe-Modell (da Vinci): der Querschnitt eines Astes
// trägt alle Spitzen darüber - r = tip * spitzen^(1/pipe).
import { model, type Model } from '../models/primitives.mjs';
import { barkFor, barkMeters, type BarkName } from './bark/data.ts';
import { hasCard, leafMaterial, placeLeaf, type LeafMaterialInfo, type LeafMode } from './foliage.ts';
import type { LeafName } from './leaves/data.ts';
import type { Material } from './materials.ts';

export type { LeafMode } from './foliage.ts';

export type Vec3 = readonly [number, number, number];

/** Ein Pflanzenteil, das an einem Zeichen sitzt. Maße in Metern, mal dem Argument des Zeichens. */
export interface Organ {
  /**
   * clump: Laubbüschel, needle: Nadelbüschel entlang des Zweigs,
   * blade: flaches, spitzes Blatt, das sich zum Boden biegt (Gras, Mais),
   * spindle: Spindel entlang der Blickrichtung (Ähre, Kolben, Rispe)
   */
  readonly shape: 'clump' | 'needle' | 'blade' | 'spindle';
  /** Größe bzw. Länge. */
  readonly size: number;
  /** Breite im Verhältnis zur Länge (blade, spindle). */
  readonly width?: number;
  /** Wie weit sich ein Blatt zum Boden biegt, in Grad über die ganze Länge. */
  readonly droop?: number;
  /** Der Reihe nach vergeben. */
  readonly materials: readonly Material[];
  /** Mehrere rund um die Blickrichtung - Rosette, Büschel, Rispe (Standard 1). */
  readonly count?: number;
  /** Neigung der Rosetten-Teile gegen die Blickrichtung, in Grad. */
  readonly spread?: number;
  /** Wahrscheinlichkeit, dass es an einem Zeichen wirklich sitzt (Standard 1), z. B. Früchte. */
  readonly chance?: number;
  /** clump und needle: statt der einfachen Form echte Blätter dieses Fotos (leaves/). */
  readonly leaf?: LeafName;
  /** Blätter je Büschel (clump, Standard 6). */
  readonly leafCount?: number;
}

export interface Token {
  readonly symbol: string;
  readonly arg: number | null;
}

interface Production {
  readonly weight: number;
  readonly successor: readonly Token[];
}

export type Rules = ReadonlyMap<string, readonly Production[]>;

export interface TreeSpec {
  readonly label: string;
  readonly axiom: string;
  /** Eine Regel je Zeile, siehe parseRules. */
  readonly rules: string;
  readonly iterations: number;
  readonly seed: number;
  /** Drehwinkel in Grad. */
  readonly angle: number;
  /** Länge eines F in Metern. */
  readonly length: number;
  /** Faktor für `"`. */
  readonly lengthFactor: number;
  /** Zufällige Abweichung von Winkeln und Längen, 0..1. */
  readonly jitter: number;
  /** Neigung zur Schwerkraft je Ast; negativ: nach oben. */
  readonly tropism: number;
  /** Zeichen außer L, an denen Laub sitzt (meist die unfertigen Knospen). */
  readonly leaves: string;
  readonly leafShape: 'clump' | 'needle';
  /** Halbe Größe eines Laubbüschels in Metern. */
  readonly leafSize: number;
  readonly leafMaterials: readonly Material[];
  /** Blattfoto für das Laub (leaves/); ohne: einfache Büschel. */
  readonly leaf?: LeafName;
  /** Blätter je Büschel, wenn `leaf` gesetzt ist (Standard 6). */
  readonly leafCount?: number;
  /** Weitere Organe je Zeichen, z. B. Blätter und Ähren beim Getreide. */
  readonly organs?: Readonly<Record<string, Organ>>;
  /** Material der Äste bzw. Halme. */
  readonly stemMaterial: Material;
  /** Rinden-Textur (bark/), sonst die Standard-Textur des Materials (MATERIAL_BARK). */
  readonly barkTexture?: BarkName;
  /** Radius einer Astspitze in Metern. */
  readonly tip: number;
  /** Exponent des Pipe-Modells: 2 = Fläche bleibt gleich, größer = schlankerer Stamm. */
  readonly pipe: number;
}

export interface Segment {
  readonly a: Vec3;
  readonly b: Vec3;
  /** Index des Astes, aus dem dieser wächst; -1 am Boden. */
  readonly parent: number;
}

export interface Leaf {
  readonly symbol: string;
  /** Größenfaktor aus dem Argument des Zeichens. */
  readonly scale: number;
  readonly p: Vec3;
  /** Blickrichtung und linke Seite der Schildkröte dort. */
  readonly heading: Vec3;
  readonly left: Vec3;
}

export interface Skeleton {
  readonly segments: readonly Segment[];
  /** Radius je Ast am Anfang und am Ende. */
  readonly radii: readonly (readonly [number, number])[];
  readonly leaves: readonly Leaf[];
}

export interface Tree {
  readonly model: Model;
  /** Materialien der Blätter (Name im Modell -> Foto und Farbe), für Vorschau und MTL. */
  readonly leafMaterials: ReadonlyMap<string, LeafMaterialInfo>;
  /** Rinde: Stamm-Material und seine Textur; null, wenn der Stamm einfarbig bleibt. */
  readonly bark: { readonly material: Material; readonly texture: BarkName } | null;
  readonly symbols: number;
  /** Ausgeführte Schritte - weniger als verlangt, wenn die Kette zu lang wurde. */
  readonly iterations: number;
  readonly capped: boolean;
  readonly segments: number;
  readonly leaves: number;
  readonly height: number;
}

/** Längste Zeichenkette, die noch ersetzt wird - danach hängt der Browser. */
const MAX_SYMBOLS = 400_000;
const DEG = Math.PI / 180;
const GRAVITY: Vec3 = [0, -1, 0];

/** Kleiner, schneller Zufallsgenerator mit Seed, gleiche Folge wie tools/models/trees.mjs. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 2246822519) + 0x9e3779b9) >>> 0;
    s = Math.imul(s ^ (s >>> 13), 3266489917) >>> 0;
    return ((s ^ (s >>> 16)) >>> 0) / 4294967296;
  };
}

/** 'F(2)+' -> [{F, 2}, {+, null}]; Leerzeichen zählen nicht. */
export function tokenize(str: string): Token[] {
  const tokens: Token[] = [];
  for (let i = 0; i < str.length; i++) {
    const symbol = str[i];
    if (/\s/.test(symbol)) continue;
    if (str[i + 1] !== '(') {
      tokens.push({ symbol, arg: null });
      continue;
    }
    const end = str.indexOf(')', i + 2);
    if (end < 0) throw new Error(`Fehlende ")" nach ${symbol}`);
    const arg = Number(str.slice(i + 2, end));
    if (!Number.isFinite(arg)) throw new Error(`Keine Zahl: ${str.slice(i, end + 1)}`);
    tokens.push({ symbol, arg });
    i = end;
  }
  return tokens;
}

/**
 * Regeln aus Text, eine je Zeile: `A -> F[+A]`, mit Gewicht `A 0.3 -> FA`.
 * Mehrere Zeilen für dasselbe Zeichen werden zufällig nach Gewicht gewählt.
 * `#` leitet einen Kommentar ein.
 */
export function parseRules(text: string): Rules {
  const rules = new Map<string, Production[]>();
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const m = /^(\S)\s*(\d*\.?\d+)?\s*->\s*(.*)$/.exec(line);
    if (!m) throw new Error(`Regel nicht lesbar: ${line}`);
    const [, symbol, weight, successor] = m;
    const list = rules.get(symbol) ?? [];
    list.push({ weight: weight ? Number(weight) : 1, successor: tokenize(successor) });
    rules.set(symbol, list);
  }
  return rules;
}

function choose(options: readonly Production[], rnd: () => number): Production {
  if (options.length === 1) return options[0];
  let r = rnd() * options.reduce((sum, o) => sum + o.weight, 0);
  for (const o of options) if ((r -= o.weight) <= 0) return o;
  return options[options.length - 1];
}

/** `iterations` Ersetzungsschritte, parallel über die ganze Kette. */
export function rewrite(axiom: readonly Token[], rules: Rules, iterations: number, rnd: () => number) {
  let current = axiom;
  for (let step = 0; step < iterations; step++) {
    const next: Token[] = [];
    for (const t of current) {
      const options = rules.get(t.symbol);
      if (options) next.push(...choose(options, rnd).successor);
      else next.push(t);
    }
    if (next.length > MAX_SYMBOLS) return { tokens: current, iterations: step, capped: true };
    current = next;
  }
  return { tokens: current, iterations, capped: false };
}

const add = (a: Vec3, b: Vec3, k = 1): Vec3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const length = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const normalize = (a: Vec3): Vec3 => add([0, 0, 0], a, 1 / (length(a) || 1));

/** v um die Einheitsachse k drehen (Rodrigues). */
function rotate(v: Vec3, k: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle), s = Math.sin(angle);
  return add(add(add([0, 0, 0], v, c), cross(k, v), s), k, dot(k, v) * (1 - c));
}

/** Blickrichtung H, links L, oben U - rechtshändig, H × L = U. */
interface Frame {
  readonly h: Vec3;
  readonly l: Vec3;
  readonly u: Vec3;
}

const turnFrame = (f: Frame, axis: Vec3, angle: number): Frame =>
  ({ h: rotate(f.h, axis, angle), l: rotate(f.l, axis, angle), u: rotate(f.u, axis, angle) });

interface Turtle {
  readonly p: Vec3;
  readonly frame: Frame;
  readonly step: number;
  /** Zuletzt gezeichneter Ast auf diesem Weg. */
  readonly segment: number;
  readonly tropism: number;
}

/** Die Schildkröte liest die Zeichen und liefert das Gerüst. Maße in Metern, y oben. */
export function interpret(tokens: readonly Token[], spec: TreeSpec, rnd: () => number): Skeleton {
  const jitter = (v: number) => v * (1 + (rnd() * 2 - 1) * spec.jitter);
  const leafSymbols = new Set(['L', ...spec.leaves, ...Object.keys(spec.organs ?? {})]);
  const segments: Segment[] = [];
  const leaves: Leaf[] = [];
  const stack: Turtle[] = [];
  let t: Turtle = { p: [0, 0, 0], frame: { h: [0, 1, 0], l: [-1, 0, 0], u: [0, 0, 1] }, step: spec.length, segment: -1, tropism: spec.tropism };

  const turn = (axis: keyof Frame, degrees: number) => {
    t = { ...t, frame: turnFrame(t.frame, t.frame[axis], jitter(degrees * DEG)) };
  };

  for (const { symbol, arg } of tokens) {
    const angle = arg ?? spec.angle;
    switch (symbol) {
      case 'F':
      case 'f': {
        const p = add(t.p, t.frame.h, jitter(arg ?? t.step));
        let segment = t.segment;
        if (symbol === 'F') segment = segments.push({ a: t.p, b: p, parent: t.segment }) - 1;
        t = { ...t, p, segment, frame: bend(t.frame, t.tropism) };
        break;
      }
      case '+': turn('u', angle); break;
      case '-': turn('u', -angle); break;
      case '&': turn('l', angle); break;
      case '^': turn('l', -angle); break;
      case '\\': turn('h', angle); break;
      case '/': turn('h', -angle); break;
      case '|': t = { ...t, frame: turnFrame(t.frame, t.frame.u, Math.PI) }; break;
      case '"': t = { ...t, step: t.step * (arg ?? spec.lengthFactor) }; break;
      case '~': t = { ...t, tropism: arg ?? spec.tropism }; break;
      case '[': stack.push(t); break;
      case ']': t = stack.pop() ?? t; break;
      default:
        if (leafSymbols.has(symbol)) leaves.push({ symbol, scale: arg ?? 1, p: t.p, heading: t.frame.h, left: t.frame.l });
    }
  }
  return { segments, radii: pipeRadii(segments, spec), leaves };
}

/** Tropismus: die Blickrichtung neigt sich zur Schwerkraft, umso mehr, je quer sie steht. */
function bend(frame: Frame, tropism: number): Frame {
  if (!tropism) return frame;
  const axis = cross(frame.h, GRAVITY);
  const mag = length(axis);
  if (mag < 1e-6) return frame;
  return turnFrame(frame, normalize(axis), tropism * mag);
}

/** Pipe-Modell: Spitzen über jedem Ast zählen, daraus die Radien. */
function pipeRadii(segments: readonly Segment[], spec: TreeSpec): [number, number][] {
  const children = segments.map((): number[] => []);
  segments.forEach((s, i) => { if (s.parent >= 0) children[s.parent].push(i); });
  // Kinder stehen immer hinter ihrem Elternast - rückwärts aufsummieren.
  const tips = new Array<number>(segments.length).fill(1);
  for (let i = segments.length - 1; i >= 0; i--) {
    if (children[i].length) tips[i] = children[i].reduce((sum, k) => sum + tips[k], 0);
  }
  const radius = (i: number) => spec.tip * tips[i] ** (1 / spec.pipe);
  return segments.map((_, i) => {
    const r = radius(i);
    const end = children[i].length ? Math.max(...children[i].map(radius)) : r * 0.6;
    return [r, end];
  });
}

/** Eckenzahl eines Astes: dicke rund, dünne fast dreieckig. */
const sides = (r: number) => (r > 0.24 ? 16 : r > 0.14 ? 12 : r > 0.07 ? 9 : r > 0.03 ? 6 : 4);

/**
 * Eine Kette von Aststücken als durchgehender Schlauch mit Texturkoordinaten:
 * der Mantel abgewickelt (u um den Stamm herum, v der Weg vom Boden, beides in
 * Kacheln der Rinden-Textur). An jedem Gelenk sitzt ein gemeinsamer Ring
 * senkrecht zur gemittelten Richtung, und der Querschnitt wird ohne Verdrehen
 * mitgeführt (Parallel-Transport) - so knickt der Stamm an den Nahtstellen
 * nicht mehr sichtbar und die Rinde läuft glatt durch.
 */
function barkTube(m: Model, mtl: Material, skeleton: Skeleton, chain: readonly number[],
  dist0: number, uOff: number, tile: number, caps: { readonly bottom: boolean; readonly top: boolean },
  cut: { readonly from?: StumpCut; readonly to?: StumpCut; readonly name?: string } = {}) {
  const segs = chain.map((i) => skeleton.segments[i]);
  const pts: Vec3[] = [cut.from?.p ?? segs[0].a, ...segs.map((s) => s.b)];
  const radii = [cut.from?.r ?? skeleton.radii[chain[0]][0], ...chain.map((i) => skeleton.radii[i][1])];
  // Nur ein Stück am Anfang (der Stumpf): bis zum Schnitt statt bis zum Segmentende.
  if (cut.to) {
    pts[pts.length - 1] = cut.to.p;
    radii[radii.length - 1] = cut.to.r;
  }
  const dirs = segs.map((s) => normalize(add(s.b, s.a, -1)));
  const joints = pts.map((_, j): Vec3 =>
    (j === 0 ? dirs[0] : j === dirs.length ? dirs[j - 1] : normalize(add(dirs[j - 1], dirs[j], 1))));
  // Am Schnitt liegt der Ring waagerecht - das Spiel erkennt die Schnittfläche
  // daran, dass sie genau in der Höhe des Stumpfs liegt.
  if (cut.from) joints[0] = [0, 1, 0];
  if (cut.to) joints[joints.length - 1] = [0, 1, 0];
  const n = sides(radii[0]);

  // Startrahmen wie bei beam(), danach je Gelenk mitgedreht.
  const up: Vec3 = Math.abs(joints[0][1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let s1 = normalize(cross(joints[0], up));
  let s2 = cross(s1, joints[0]);

  const vertices: Vec3[] = [];
  const normals: Vec3[] = [];
  const uvs: [number, number][] = [];
  const faces: number[][] = [];
  let dist = dist0;
  for (let j = 0; j < pts.length; j++) {
    if (j > 0) {
      dist += length(add(pts[j], pts[j - 1], -1));
      const axis = cross(joints[j - 1], joints[j]);
      const mag = length(axis);
      if (mag > 1e-6) {
        const angle = Math.atan2(mag, dot(joints[j - 1], joints[j]));
        const k: Vec3 = [axis[0] / mag, axis[1] / mag, axis[2] / mag];
        s1 = rotate(s1, k, angle);
        s2 = rotate(s2, k, angle);
      }
    }
    for (let k = 0; k <= n; k++) { // k = n schließt den Mantel (gleicher Punkt, volles u)
      const t = Math.PI / n + ((k % n) * 2 * Math.PI) / n;
      const radial = add(add([0, 0, 0], s1, Math.cos(t)), s2, Math.sin(t));
      vertices.push(add(pts[j], radial, radii[j]));
      normals.push(radial); // rund schattiert
      uvs.push([uOff + (k / n) * ((2 * Math.PI * radii[j]) / tile), dist / tile]);
    }
  }
  for (let j = 0; j + 1 < pts.length; j++) {
    const a0 = j * (n + 1), b0 = (j + 1) * (n + 1);
    for (let k = 0; k < n; k++) faces.push([a0 + k, a0 + k + 1, b0 + k + 1, b0 + k]);
  }
  // Deckel nur, wo man sie sehen kann: am Boden und an Astspitzen ohne Kinder -
  // mit eigener, flacher Normale entlang des Astes.
  const cap = (ring: number, normal: Vec3, flip: boolean) => {
    const start = vertices.length;
    for (let k = 0; k < n; k++) {
      vertices.push(vertices[ring + k]);
      normals.push(normal);
      uvs.push([0, 0]);
    }
    faces.push(Array.from({ length: n }, (_, k) => start + (flip ? n - 1 - k : k)));
  };
  if (caps.bottom) cap(0, [-joints[0][0], -joints[0][1], -joints[0][2]], true);
  if (caps.top) cap((pts.length - 1) * (n + 1), joints[pts.length - 1], false);
  m.mesh(cut.name ?? (radii[0] > 0.12 ? 'Trunk' : 'Branch'), mtl, vertices, faces, uvs, normals);
}

/** Höhe des Baumstumpfs über dem Boden in Metern - dort sägen die Dorfbewohner ab. */
const STUMP_HEIGHT = 0.5;
/** Dünner am Boden (Halbmesser, Meter) ist kein Stamm, sondern ein Halm - kein Stumpf. */
const STUMP_MIN_RADIUS = 0.05;

/** Punkt und Halbmesser am Schnitt zwischen Stumpf und Stamm. */
interface StumpCut {
  readonly p: Vec3;
  readonly r: number;
}

/**
 * Der Baumstumpf: Vom Fuß des Stamms (das dickste Stück, das am Boden
 * beginnt) geht es jeweils ins dickste Kind nach oben, bis ein Stück
 * STUMP_HEIGHT erreicht - dort wird geschnitten. `below`: die Stücke ganz
 * unter dem Schnitt, `seg`: das Stück mit dem Schnitt. null, wenn der Stamm
 * nicht deutlich höher reicht oder zu dünn ist (Getreide, Gräser). Das Spiel
 * erkennt den Stumpf am Namen `Trunk.Stump`.
 */
function findStump(skeleton: Skeleton): { below: Set<number>; seg: number; cut: StumpCut } | null {
  const { segments, radii } = skeleton;
  let i = -1;
  segments.forEach((s, k) => {
    if (s.parent < 0 && Math.abs(s.a[1]) < 1e-6 && (i < 0 || radii[k][0] > radii[i][0])) i = k;
  });
  if (i < 0 || radii[i][0] < STUMP_MIN_RADIUS) return null;
  const below = new Set<number>();
  while (i >= 0) {
    const s = segments[i];
    if (s.b[1] >= STUMP_HEIGHT) {
      // Deutlich höher als der Stumpf, sonst lohnt kein Schnitt.
      let top = s.b[1];
      for (let k = 0; k < segments.length; k++) top = Math.max(top, segments[k].b[1]);
      if (top < STUMP_HEIGHT * 1.5 || s.b[1] - s.a[1] <= 1e-6) return null;
      const t = (STUMP_HEIGHT - s.a[1]) / (s.b[1] - s.a[1]);
      const [r0, r1] = radii[i];
      return { below, seg: i, cut: { p: add(s.a, add(s.b, s.a, -1), t), r: r0 + (r1 - r0) * t } };
    }
    below.add(i);
    let next = -1;
    segments.forEach((c, k) => {
      if (c.parent === i && (next < 0 || radii[k][0] > radii[next][0])) next = k;
    });
    i = next;
  }
  return null;
}

/** Wie das Laub gebaut wird. */
export interface GrowOptions {
  /** Blätter als Form nach dem Umriss (Standard) oder als Foto-Textur. */
  readonly leaves?: LeafMode;
  /** Blattebenen (ein Zweig mit mehreren Blättern je Fläche) statt einzelner Blätter - Standard ja. */
  readonly cards?: boolean;
}

/** Zeichnet in ein Modell; sammelt die benutzten Blatt-Materialien. */
interface Drawing {
  readonly m: Model;
  readonly mode: LeafMode;
  readonly cards: boolean;
  readonly rnd: () => number;
  readonly leafMaterials: Map<string, LeafMaterialInfo>;
}

/** Das Gerüst als Modell: Äste als Balken, dazu Laub und Organe. */
export function build(skeleton: Skeleton, spec: TreeSpec, rnd: () => number, { leaves = 'shape', cards = true }: GrowOptions = {}) {
  const m = model();
  const drawing: Drawing = { m, mode: leaves, cards, rnd, leafMaterials: new Map() };
  const texture = barkFor(spec.stemMaterial, spec.barkTexture);
  const bark = texture ? { material: spec.stemMaterial, texture } : null;
  const { segments } = skeleton;
  const stump = findStump(skeleton);
  if (!bark) {
    segments.forEach((s, i) => {
      const [r0, r1] = skeleton.radii[i];
      const name = r0 > 0.12 ? 'Trunk' : 'Branch';
      if (stump?.below.has(i)) {
        m.beam('Trunk.Stump', spec.stemMaterial, s.a, s.b, r0 * 2, { w1: r1 * 2, n: sides(r0) });
      } else if (stump?.seg === i) {
        const { cut } = stump;
        m.beam('Trunk.Stump', spec.stemMaterial, s.a, cut.p, r0 * 2, { w1: cut.r * 2, n: sides(r0) });
        m.beam(name, spec.stemMaterial, cut.p, s.b, cut.r * 2, { w1: r1 * 2, n: sides(r0) });
      } else {
        m.beam(name, spec.stemMaterial, s.a, s.b, r0 * 2, { w1: r1 * 2, n: sides(r0) });
      }
    });
  } else {
    // Weg vom Boden und u-Versatz je Ast: Kinder setzen die Abwicklung des
    // Elternastes fort, damit die Textur den Stamm hinaufläuft statt je
    // Stück neu anzusetzen.
    const tile = barkMeters(bark.texture);
    const len = segments.map((s) => length(add(s.b, s.a, -1)));
    const dist = new Array<number>(segments.length).fill(0);
    const uOff = new Array<number>(segments.length).fill(0);
    const hasChild = new Array<boolean>(segments.length).fill(false);
    segments.forEach((s, i) => {
      if (s.parent < 0) { uOff[i] = (i * 0.618) % 1; return; }
      dist[i] = dist[s.parent] + len[s.parent];
      uOff[i] = uOff[s.parent];
      hasChild[s.parent] = true;
    });
    // Hauptfortsetzung je Ast: das dickste Kind am Astende. Es bildet mit dem
    // Elternstück einen durchgehenden Schlauch, solange die Seitenzahl gleich
    // bleibt; die übrigen Kinder beginnen eigene Schläuche.
    const mainChild = new Array<number>(segments.length).fill(-1);
    segments.forEach((s, i) => {
      if (s.parent < 0) return;
      const c = mainChild[s.parent];
      if (c < 0 || skeleton.radii[i][0] > skeleton.radii[c][0]) mainChild[s.parent] = i;
    });
    const continues = (i: number): boolean => {
      const p = segments[i].parent;
      return p >= 0 && mainChild[p] === i && sides(skeleton.radii[i][0]) === sides(skeleton.radii[p][0]);
    };
    segments.forEach((s, i) => {
      if (continues(i)) return; // Teil eines Schlauchs, der weiter unten beginnt
      const chain = [i];
      for (let j = mainChild[i]; j >= 0 && continues(j); j = mainChild[j]) chain.push(j);
      const last = chain[chain.length - 1];
      const k = stump ? chain.indexOf(stump.seg) : -1;
      if (stump && k >= 0) {
        // Der Stumpf: bis zum Schnitt, oben zu. Darüber der Stamm mit eigener
        // Unterseite am Schnitt; die Rinde läuft durch.
        const { cut } = stump;
        const up = chain.slice(k);
        const cutDist = dist[stump.seg] + length(add(cut.p, segments[stump.seg].a, -1));
        barkTube(m, spec.stemMaterial, skeleton, chain.slice(0, k + 1), dist[i], uOff[i], tile,
          { bottom: s.parent < 0, top: true }, { to: cut, name: 'Trunk.Stump' });
        barkTube(m, spec.stemMaterial, skeleton, up, cutDist, uOff[i], tile,
          { bottom: true, top: !hasChild[last] }, { from: cut });
        return;
      }
      barkTube(m, spec.stemMaterial, skeleton, chain, dist[i], uOff[i], tile,
        { bottom: s.parent < 0, top: !hasChild[last] }, stump?.below.has(i) ? { name: 'Trunk.Stump' } : {});
    });
  }
  const foliage: Organ = {
    shape: spec.leafShape, size: spec.leafSize, materials: spec.leafMaterials, leaf: spec.leaf, leafCount: spec.leafCount,
  };
  const count = new Map<Organ, number>();
  for (const leaf of skeleton.leaves) {
    const organ = spec.organs?.[leaf.symbol] ?? foliage;
    if (organ.size <= 0 || rnd() >= (organ.chance ?? 1)) continue;
    const n = count.get(organ) ?? 0;
    count.set(organ, n + 1);
    const mtl = organ.materials[n % organ.materials.length];
    for (const part of rosette(leaf, organ, rnd)) drawOrgan(drawing, organ, mtl, part);
  }
  return { model: m, leafMaterials: drawing.leafMaterials, bark };
}

/** Die Teile eines Organs: bei count > 1 rund um die Blickrichtung verteilt und um spread geneigt. */
function rosette(leaf: Leaf, organ: Organ, rnd: () => number): Leaf[] {
  const count = organ.count ?? 1;
  if (count <= 1) return [leaf];
  const tilt = (organ.spread ?? 45) * DEG;
  const offset = rnd() * Math.PI * 2;
  return Array.from({ length: count }, (_, i) => {
    const around = offset + (i / count) * Math.PI * 2 + (rnd() - 0.5) * 0.4;
    const left = rotate(leaf.left, leaf.heading, around);
    return { ...leaf, heading: rotate(leaf.heading, left, tilt * (0.8 + rnd() * 0.4)), left };
  });
}

/** Zufällige Richtung, gleich verteilt auf der Kugel. */
function randomUnit(rnd: () => number): Vec3 {
  for (;;) {
    const v: Vec3 = [rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1];
    const l = length(v);
    if (l > 0.05 && l <= 1) return normalize(v);
  }
}

/** Blätter auf einer Blattebene im Mittel (4 bis 6) - so viele Einzelblätter ersetzt eine Ebene. */
const LEAVES_PER_CARD = 3;

/**
 * Echte Blätter statt der einfachen Form: ein Büschel (clump) aus leafCount
 * Blättern bzw. entsprechend weniger Blattebenen, die vom Punkt aus nach außen
 * und etwas nach oben zeigen, oder ein Zweigstück (needle) entlang der
 * Astrichtung - flach wie ein Nadelzweig.
 */
function drawLeaves(drawing: Drawing, organ: Organ, leaf: LeafName, material: Material, { p, heading, left }: Leaf, size: number) {
  const { m, mode, rnd } = drawing;
  const card = drawing.cards && organ.shape === 'clump' && hasCard(leaf);
  const { name, info } = leafMaterial(leaf, material, card);
  drawing.leafMaterials.set(name, info);
  if (organ.shape === 'needle') {
    const dir = normalize(add(heading, randomUnit(rnd), 0.15));
    const side = normalize(add(left, dir, -dot(left, dir)));
    placeLeaf(m, mode, leaf, false, name, add(p, dir, -size), dir, side, size * (3 + rnd() * 0.8));
    return;
  }
  const leaves = organ.leafCount ?? 6;
  const count = card ? Math.max(1, Math.round(leaves / LEAVES_PER_CARD)) : leaves;
  // Eine Ebene reicht weiter als ein Blatt: ihr Fuß sitzt näher am Ast, sie ist länger.
  const reach = card ? 2 : 1;
  // Büschel als Fächer: alle setzen am Astende an und führen die Astrichtung
  // schräg nach außen fort - keines zeigt zurück in die Krone oder durch den Ast.
  const start = rnd() * Math.PI * 2;
  for (let i = 0; i < count; i++) {
    const around = start + (i / count) * Math.PI * 2 + (rnd() - 0.5) * 0.8;
    const axis = rotate(left, heading, around);
    // 20°..70° von der Astrichtung weg, dazu ein leichter Zug zum Licht.
    const tilted = rotate(heading, axis, 0.35 + rnd() * 0.85);
    const dir = normalize(add(tilted, GRAVITY, -0.2));
    // axis steht senkrecht auf dir - als Blattfläche zufällig um dir gerollt.
    const side = rotate(axis, dir, (rnd() - 0.5) * 1.6);
    placeLeaf(m, mode, leaf, card, name, add(p, dir, -size * 0.1), dir, side, size * reach * (0.75 + rnd() * 0.4));
  }
}

function drawOrgan(drawing: Drawing, organ: Organ, mtl: Material, part: Leaf) {
  const { m, rnd } = drawing;
  const { p, heading, left, scale } = part;
  const size = organ.size * scale;
  const width = size * (organ.width ?? 0.1);
  if (organ.leaf && (organ.shape === 'clump' || organ.shape === 'needle')) {
    drawLeaves(drawing, organ, organ.leaf, mtl, part, size);
    return;
  }
  switch (organ.shape) {
    case 'clump': {
      const r = size * (0.7 + rnd() * 0.6);
      m.box('Leaves', mtl, [p[0] - r, p[0] + r], [p[1] - r * 0.6, p[1] + r * 0.7], [p[2] - r, p[2] + r],
        { n: 5, rot: rnd() * 3, x: [p[0] - r * 0.4, p[0] + r * 0.4], z: [p[2] - r * 0.4, p[2] + r * 0.4] });
      break;
    }
    case 'needle': {
      // Nadelbüschel: länglich entlang des Zweigs, zur Spitze schmaler.
      const r = size * (0.7 + rnd() * 0.6);
      m.beam('Needles', mtl, add(p, heading, -r * 0.6), add(p, heading, r * 0.6), r * 1.4, { w1: r * 0.5, n: 4 });
      break;
    }
    case 'spindle': {
      // Dick in der Mitte, spitz am Ende.
      const mid = add(p, heading, size * 0.45), end = add(p, heading, size);
      m.beam('Organ', mtl, p, mid, width * 0.7, { w1: width, n: 6 });
      m.beam('Organ', mtl, mid, end, width, { w1: width * 0.25, n: 6 });
      break;
    }
    case 'blade':
      blade(m, mtl, p, heading, left, size, width, (organ.droop ?? 60) * DEG);
      break;
  }
}

/** Breite eines Blattes entlang der Länge, 0..1: schmal am Ansatz, spitz am Ende. */
const BLADE_PROFILE = [0.5, 1, 0.95, 0.75, 0.45, 0.05];

/**
 * Flaches Blatt in einigen Stücken, jedes etwas weiter zum Boden gebogen.
 * Die Fläche liegt quer zur linken Seite der Schildkröte.
 */
function blade(m: Model, mtl: Material, p: Vec3, heading: Vec3, left: Vec3, bladeLength: number, width: number, droop: number) {
  const pieces = BLADE_PROFILE.length - 1;
  const thick = Math.max(0.002, width * 0.08);
  let dir = heading, at = p;
  for (let i = 0; i < pieces; i++) {
    // Seite und Dicke senkrecht zur aktuellen Richtung.
    const side = normalize(add(left, dir, -dot(left, dir)));
    const up = cross(dir, side);
    const ring = (c: Vec3, w: number) => [
      add(add(c, side, w / 2), up, thick), add(add(c, side, -w / 2), up, thick),
      add(add(c, side, -w / 2), up, -thick), add(add(c, side, w / 2), up, -thick),
    ];
    const next = add(at, dir, bladeLength / pieces);
    m.emit('Blade', mtl, ring(at, width * BLADE_PROFILE[i]), ring(next, width * BLADE_PROFILE[i + 1]));
    at = next;
    const axis = cross(dir, GRAVITY);
    if (length(axis) > 1e-6) dir = rotate(dir, normalize(axis), droop / pieces);
  }
}

/** Vom Rezept zum Modell. Wirft bei unlesbaren Regeln. */
export function grow(spec: TreeSpec, options: GrowOptions = {}): Tree {
  const rnd = rng(spec.seed);
  const { tokens, iterations, capped } = rewrite(tokenize(spec.axiom), parseRules(spec.rules), spec.iterations, rnd);
  const skeleton = interpret(tokens, spec, rnd);
  return {
    ...build(skeleton, spec, rnd, options),
    symbols: tokens.length,
    iterations,
    capped,
    segments: skeleton.segments.length,
    leaves: skeleton.leaves.length,
    height: skeleton.segments.reduce((top, s) => Math.max(top, s.b[1]), 0),
  };
}
