// entityRenderer.ts
// Zweiter Zeichendurchgang über dem Gelände: alles, was der Gelände-Shader
// nicht erzeugen kann, weil der Spieler es verändert - Gebäude, das Bauvorschau-
// Feld und die Markierung erschöpfter Vorkommen.
//
// Gebäude sind instanzierte Klötze mit Dach, die Form bestimmt Proportionen
// und Dachneigung. Flächige Overlays sind ein feines Gitter, das sich über das
// Relief legt. Beide lesen die Geländehöhe direkt aus TERRAIN_COMMON - so
// stehen sie genau auf dem Boden, den der Gelände-Shader zeichnet.

import type { RGB } from '../functions/Color';
import {
  PROJECT_GLSL, cameraDirection, groundToWorld, setCameraUniforms, viewGroundV, viewRotation, viewZScreen, worldToGround, type GpuCamera,
} from './iso';
import { uploadTerrainParams } from './terrainRenderer';
import humanoidClipsGlb from '../models/humanoid_clips.glb?inline';
import humanoidClipsManifest from '../models/humanoid_clips.json';
import quadrupedClipsGlb from '../models/quadruped_clips.glb?inline';
import quadrupedClipsManifest from '../models/quadruped_clips.json';
import millClipsGlb from '../models/mill_clips.glb?inline';
import millClipsManifest from '../models/mill_clips.json';
import flagClipsGlb from '../models/flag_clips.glb?inline';
import flagClipsManifest from '../models/flag_clips.json';
import {
  BONE, FLAG, FLAG_SEGMENTS, HUMANOID, KNEEL_BIT, MAX_BONES, MILL, PROP_BITS, QUADRUPED, QUADRUPED_BONE, TEXELS_PER_BONE, bakeClip, loadClips,
  type Clip, type Rig,
} from './clips';
import { TERRAIN_COMMON } from './terrainShader';
import { FLATTEN_GLSL, MAX_FLAT_ZONES } from '../world/flatten';
import { parseMtl, parseMtlImages, parseObj, type ObjTriangle, type RGB01 } from './obj';
import villagerMaleModel from '../models/villager_male.glb?model';
import villagerFemaleModel from '../models/villager_female.glb?model';
import propAxeModel from '../models/prop_axe.glb?model';
import propKnifeModel from '../models/prop_knife.glb?model';
import propScytheMaleModel from '../models/prop_scythe_male.glb?model';
import propScytheFemaleModel from '../models/prop_scythe_female.glb?model';
import millModel from '../models/mill.glb?model';
import mill2Model from '../models/mill_2.glb?model';
import mill3Model from '../models/mill_3.glb?model';
import mill4Model from '../models/mill_4.glb?model';
import lumberCampModel from '../models/lumber_camp.glb?model';
import lumberCamp2Model from '../models/lumber_camp_2.glb?model';
import lumberCamp3Model from '../models/lumber_camp_3.glb?model';
import lumberCamp4Model from '../models/lumber_camp_4.glb?model';
import houseModel from '../models/house.glb?model';
import house2Model from '../models/house_2.glb?model';
import house3Model from '../models/house_3.glb?model';
import house4Model from '../models/house_4.glb?model';
import townCenterModel from '../models/town_center.glb?model';
import miningCampModel from '../models/mining_camp.glb?model';
import treeSpruceModel from '../models/tree_spruce.glb?model';
import treePineModel from '../models/tree_pine.glb?model';
import treeOakModel from '../models/tree_oak.glb?model';
import treeBirchModel from '../models/tree_birch.glb?model';
import treeBirch2Model from '../models/tree_birch_2.glb?model';
import treeBirch3Model from '../models/tree_birch_3.glb?model';
import treePoplarModel from '../models/tree_poplar.glb?model';
import treeMapleModel from '../models/tree_maple.glb?model';
import treeOakOldModel from '../models/tree_oak_old.glb?model';
import treeOakYoungModel from '../models/tree_oak_young.glb?model';
import stone1Model from '../models/stone_1.glb?model';
import stone2Model from '../models/stone_2.glb?model';
import stone3Model from '../models/stone_3.glb?model';
import gold1Model from '../models/gold_1.glb?model';
import gold2Model from '../models/gold_2.glb?model';
import gold3Model from '../models/gold_3.glb?model';
import berryBush1Model from '../models/berry_bush_1.glb?model';
import { FLOWER_KINDS, flowerModel } from './flowerModel';
import berryBush2Model from '../models/berry_bush_2.glb?model';
import berryBush3Model from '../models/berry_bush_3.glb?model';
import berryBush4Model from '../models/berry_bush_4.glb?model';
import { FARM_KINDS, FIELD_PARTS, farmModel } from '../../tools/models/farmsGen.mjs';

/** Teile der Felder (src/models/field_*.glb, docs/BLENDER.md). */
const FIELD_PART_FILES = import.meta.glob('../models/field_*.glb', { eager: true, query: '?model', import: 'default' }) as Record<string, { obj: string; mtl: string }>;
const FIELD_PART_MODELS = Object.fromEntries(FIELD_PARTS.map((n) => [n, FIELD_PART_FILES[`../models/field_${n}.glb`]]));
import deerModel from '../models/deer.glb?model';
import hareModel from '../models/hare.glb?model';
import cowModel from '../models/cow.glb?model';
import sheepModel from '../models/sheep.glb?model';
import goatModel from '../models/goat.glb?model';
import boarModel from '../models/boar.glb?model';
import birchLeafUrl from '../textures/birch_leaf.png';
import rallyFlagModel from '../models/rally_flag.glb?model';
import bowyerModel from '../models/bowyer.glb?model';
import armoryModel from '../models/armory.glb?model';
import markerArrowModel from '../models/marker_arrow.glb?model';
import bowModel from '../models/bow.glb?model';

/** Materialien der Dorfbewohner und ihrer Werkzeuge - jedes Modell bringt seine mit. */
const villagerMtl = [villagerMaleModel, villagerFemaleModel, propAxeModel, propKnifeModel, propScytheMaleModel, propScytheFemaleModel]
  .map((m) => m.mtl).join('\n');

/** Formen für aParams.x - die Zahlen stehen so auch im Shader. */
export const SHAPE = {
  square: 0,
  circle: 1,
  triangle: 2,
  diamond: 3,
  /** Flächig, ohne Rand - für Overlays wie erschöpfte Vorkommen. */
  flat: 4,
  /** Mensch mit Armen und Beinen, läuft und arbeitet - Dorfbewohner (models/villager_male.obj). */
  villager: 5,
  /** Windmühle mit drehenden Flügeln (models/mill.obj). */
  mill: 6,
  /** Offener Holzschuppen mit Stammstapel (models/lumber_camp.obj). */
  lumberCamp: 7,
  /** Fachwerkhaus mit Satteldach (models/house.obj). */
  house: 8,
  /** Halle mit Turm, Vorhalle und Fahne (models/town_center.obj). */
  townCenter: 9,
  /** Nur intern: Lebensbalken über einer Instanz mit `health`. */
  healthBar: 10,
  /** Schuppen mit Steinen, Gold und Erzwagen (models/mining_camp.obj). */
  miningCamp: 11,
  // Vorkommen in der Landschaft - ab hier "natürliche" Objekte: eigene
  // Drehung je Instanz, keine Mindestgröße, keine Sortierung (undurchsichtig).
  /** Fichte auf Holz-Tiles (models/tree_spruce.obj) - weitere Bäume ab 22. */
  tree: 12,
  /** Felsbrocken auf Stein-Tiles (models/stone_1.obj) - weitere ab 29. */
  stoneRock: 13,
  /** Erzfels mit Goldadern und Nuggets (models/gold_1.obj) - weitere ab 31. */
  goldRock: 14,
  /** Johannisbeerstrauch (models/berry_bush_1.obj) - weitere Sträucher ab 19. */
  berryBush: 15,
  /** Fahne am Sammelpunkt eines Gebäudes (models/rally_flag.obj). */
  rallyFlag: 16,
  /**
   * Staubwolke: runder, weicher Fleck, der zur Kamera zeigt - verankert in
   * der Welt (motion[0] = Höhe über Grund), Größe in Tiles.
   */
  dust: 17,
  /** Wie `villager`, als Frau (models/villager_female.obj). */
  villagerFemale: 18,
  /** Brombeere mit Ranken (models/berry_bush_2.obj). */
  berryBush2: 19,
  /** Heidelbeeren, mehrere kleine Büsche (models/berry_bush_3.obj). */
  berryBush3: 20,
  /** Hoher Himbeerstrauch (models/berry_bush_4.obj). */
  berryBush4: 21,
  /** Kiefer mit hohem, rötlichem Stamm (models/tree_pine.obj). */
  treePine: 22,
  /** Eiche mit breiter Krone (models/tree_oak.obj). */
  treeOak: 23,
  /** Birke mit zwei weißen Stämmen (models/tree_birch.obj). */
  treeBirch: 24,
  /** Schmale, hohe Pappel (models/tree_poplar.obj). */
  treePoplar: 25,
  /** Ahorn mit runder, dichter Krone (models/tree_maple.obj). */
  treeMaple: 26,
  /** Alte Eiche: knorriger Stamm mit Höhle, weit ausladend (models/tree_oak_old.obj). */
  treeOakOld: 27,
  /** Junge Eiche mit schlankem Stamm (models/tree_oak_young.obj). */
  treeOakYoung: 28,
  /** Flacher Haufen Felsbrocken (models/stone_2.obj). */
  stoneRock2: 29,
  /** Zwei hohe, gespaltene Felsen (models/stone_3.obj). */
  stoneRock3: 30,
  /** Erzhaufen mit Goldadern (models/gold_2.obj). */
  goldRock2: 31,
  /** Hoher Erzfels mit Goldadern (models/gold_3.obj). */
  goldRock3: 32,
  /** Auswahlring unter einer Figur: flach aufs Gelände gelegt wie `flat`. */
  ring: 33,
  /** Weitere Häuser (models/house_2..4.obj) - je Bauplatz fest eines davon. */
  house2: 34,
  house3: 35,
  house4: 36,
  /** Weitere Mühlen (models/mill_2..4.obj) - je Bauplatz fest eine davon. */
  mill2: 37,
  mill3: 38,
  mill4: 39,
  /** Weitere Holzlager (models/lumber_camp_2..4.obj) - je Bauplatz fest eines davon. */
  lumberCamp2: 40,
  lumberCamp3: 41,
  lumberCamp4: 42,
  /**
   * Felder, 3x3 Tiles (tools/models/farmsGen.mjs). Je Furche eine eigene
   * Form - die hier, plus Furche 0..8 - und eine Instanz: motion = [Furche,
   * Stand, verbleibender Ertrag 0..1, Tiles] - siehe P_CROP im Shader.
   */
  farmWheat: 50,
  farmCorn: 59,
  /**
   * Wild zum Jagen (models/deer.obj, hare.obj, cow.obj, sheep.obj, goat.obj, boar.obj): motion = [Blickrichtung,
   * Phase, Pose (ANIMAL_POSE), 0] - siehe "beast" im Shader.
   */
  deer: 90,
  hare: 91,
  /** Hängebirke: ein Stamm, volle Krone aus hängenden Zweigen (models/tree_birch_2.obj). */
  treeBirch2: 92,
  /** Trauerbirke: gegabelter Stamm, Etagen aus Bögen mit langen Zweig-Vorhängen (models/tree_birch_3.obj). */
  treeBirch3: 93,
  cow: 94,
  sheep: 95,
  goat: 96,
  boar: 97,
  /** Bognerei: Werkstatt mit Werkbank, Bogenstäben und Zielscheibe (models/bowyer.obj). */
  bowyer: 98,
  /** Ein Bogen - Symbol für den Vorrat an Bögen (models/bow.obj). */
  bow: 99,
  /** Waffenkammer: Steinhaus mit Waffengestell, Schilden und Pfeilfässern (models/armory.obj). */
  armory: 100,
  /**
   * Hinweispfeil nach unten über einem Gebäude, dem ein Arbeiter fehlt
   * (models/marker_arrow.obj). motion[1] hebt ihn in Tiles übers Dach, im
   * Shader wippt er.
   */
  markerArrow: 101,
  /**
   * Werkzeuge als Anhänge (models/prop_*.obj): je Werkzeug und Körper eine
   * Form - sie leiht sich beim Zeichnen Gelenke und Clips des Körpers und
   * hängt an seiner rechten Hand (figureProps, docs/ANIMATION.md).
   */
  propAxe: 102,
  propAxeFemale: 103,
  propScythe: 104,
  propScytheFemale: 105,
  propKnife: 106,
  propKnifeFemale: 107,
  /**
   * Blumen auf der Wiese (gl/flowerModel.ts, world/flowers.ts): Stiel, Blüte,
   * Blätter - je Art eine Form, in FLOWER_KINDS-Reihenfolge ab 108.
   */
  flowerDaisy: 108,
  flowerButtercup: 109,
  flowerPoppy: 110,
  flowerCornflower: 111,
  flowerClover: 112,
} as const;

/** Die Blumen-Formen, in der Reihenfolge von FLOWER_KINDS. */
export const FLOWERS: readonly number[] = [
  SHAPE.flowerDaisy, SHAPE.flowerButtercup, SHAPE.flowerPoppy, SHAPE.flowerCornflower, SHAPE.flowerClover,
];

/**
 * Mittlere Drehzahl der Mühlenflügel (Radiant je Sekunde) und wie schnell die
 * Böen wechseln - so ist der Clip "sails" gebacken (tools/export/props.mjs).
 * Hier nur, um jede Mühle an eine passende Stelle der Schleife zu setzen.
 */
const SAIL_SPEED = 0.8;
const GUST_RATE = 0.35;

/**
 * Wie millMotion, aber die Flügel stehen still - in der Stellung, die sie
 * zur Zeit `t` (Sekunden, wie uTime im Shader) hatten. Für eingestürzte Mühlen:
 * motion[2] < 0, der Clip "sails" liest die Mühlenzeit -motion[2] - 1.
 */
export function frozenMillMotion(x: number, y: number, t: number): [number, number, number, number] {
  const [heading, phase, speed] = millMotion(x, y);
  return [heading, phase, -1 - (t * speed + millClipOffset(phase)), 0];
}

/**
 * Wo in der Schleife des Clips "sails" eine Mühle mit dieser Startstellung
 * steht - wie millClipOffset im Shader: die Böen im Takt ihrer Startstellung,
 * die Drehung bis auf eine Vierteldrehung (die Flügel sehen dann gleich aus)
 * und höchstens 6.4 Grad.
 */
function millClipOffset(phase: number): number {
  let best = 0;
  let err = Infinity;
  for (let k = 0; k < 7; k++) {
    const o = (3.1 * phase + 2 * Math.PI * k) / GUST_RATE;
    const quarter = Math.PI / 2;
    const e = Math.abs(((((SAIL_SPEED * o - phase + quarter / 2) % quarter) + quarter) % quarter) - quarter / 2);
    if (e < err) {
      err = e;
      best = o;
    }
  }
  return best;
}

/**
 * Drehung einer Mühle für `motion`: [Blickrichtung, Startstellung, Drehzahl, 0].
 * Jede Mühle dreht so in ihrem eigenen Takt (Clip "sails", Shader P_SAILS).
 */
export function millMotion(x: number, y: number): [number, number, number, number] {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  const r = ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  return [BUILDING_HEADING, r * Math.PI * 2, 0.8 + 0.4 * ((r * 7.13) % 1), 0];
}

const SHAPE_RING = SHAPE.ring;

/** Figuren: verdeckt zeigen sie ihren Umriss. */
/** Anhänge der Dorfbewohner (Werkzeuge) - gezeichnet wie Figuren, mit deren Gelenken und Clips. */
const PROP_SHAPES: number[] = [
  SHAPE.propAxe, SHAPE.propAxeFemale, SHAPE.propScythe, SHAPE.propScytheFemale, SHAPE.propKnife, SHAPE.propKnifeFemale,
];
const FIGURES: number[] = [SHAPE.villager, SHAPE.villagerFemale, ...PROP_SHAPES];
/** Im Shader: ist die Form eine Figur (Dorfbewohner oder ihr Anhang)? */
const FIGURE_TEST = `(shape == ${SHAPE.villager} || shape == ${SHAPE.villagerFemale} || (shape >= ${SHAPE.propAxe} && shape <= ${SHAPE.propKnifeFemale}))`;

/** Alle Bäume - sie werden gefällt und kippen um. */
export const TREES: number[] = [
  SHAPE.tree, SHAPE.treePine, SHAPE.treeOak, SHAPE.treeBirch, SHAPE.treePoplar, SHAPE.treeMaple,
  SHAPE.treeOakOld, SHAPE.treeOakYoung, SHAPE.treeBirch2, SHAPE.treeBirch3,
];

/** Rolle des Laubs (außer Paint) - es wird im Shader weich schattiert. */
/** Muster der Dorfbewohner (vTex) - nur auf Figuren, das Schaf hat auch "Wool". */
const FIGURE_TEX = { cloth: 15, leather: 16, hair: 17, skin: 18 } as const;
const FOLIAGE_ROLE = 12;
/** Textur-Einheit der Blatt-Textur - 0..2 belegt das Gelände. */
const LEAF_TEXTURE_UNIT = 3;
/** Knochen-Matrizen der Clips aus Blender (uClipTex, siehe clips.ts). */
const CLIP_TEXTURE_UNIT = 5;
/** Bilder der Bäume für weit draußen (uBillboardTex, siehe ensureBillboards). */
const BILLBOARD_TEXTURE_UNIT = 6;
/** Bildtexturen aus den .glb-Modellen (uModelImages, siehe MODEL_IMAGES). */
const IMAGE_TEXTURE_UNIT = 7;
/** Kantenlänge jeder Bildtextur in uModelImages - alle Bilder werden darauf gebracht. */
const IMAGE_SIZE = 512;
/** Rolle der Flächen mit Bildtextur: statt der Farbe (u, v, Schicht in uModelImages). */
const IMAGE_ROLE = 20;
/**
 * Bildtexturen aller Modelle (map_Kd, tools/models/glb.mjs) mit der
 * Materialfarbe, die sie einfärbt - je Eintrag eine Schicht in uModelImages.
 */
const MODEL_IMAGES: { url: string; tint: RGB01 }[] = [];
function imageLayer(url: string, tint: RGB01): number {
  const i = MODEL_IMAGES.findIndex((m) => m.url === url && m.tint.every((c, k) => c === tint[k]));
  return i >= 0 ? i : MODEL_IMAGES.push({ url, tint }) - 1;
}
/**
 * So viele Drehungen je Baumart hat ein Billboard - das Bild liegt höchstens
 * eine halbe Stufe (22,5°) neben der Drehung des Baums.
 */
export const BILLBOARD_HEADINGS = 8;

/**
 * Wie viele Clips jede Bibliothek geladen hat - auch als
 * `window.__clipLibraries`, damit der Rauchtest (tools/ui/smoke.mjs) prüfen
 * kann, dass keine leer ist.
 */
export const CLIP_LIBRARIES_LOADED: Record<string, number> = {};
(globalThis as { __clipLibraries?: Record<string, number> }).__clipLibraries = CLIP_LIBRARIES_LOADED;

/**
 * Clips aus Blender (docs/ANIMATION.md, src/models/humanoid_clips.glb). Lässt
 * sich eine Bibliothek nicht lesen, stehen ihre Figuren still (Ruhelage) - und
 * der Rauchtest schlägt an (CLIP_LIBRARIES_LOADED).
 */
export const CLIPS: Clip[] = readClips('humanoid', () => loadClips(humanoidClipsGlb, humanoidClipsManifest, HUMANOID));
/** Clips der Tiere (src/models/quadruped_clips.glb). */
export const ANIMAL_CLIPS: Clip[] = readClips('quadruped', () => loadClips(quadrupedClipsGlb, quadrupedClipsManifest, QUADRUPED));
const FLAG_CLIPS: Clip[] = readClips('flag', () => loadClips(flagClipsGlb, flagClipsManifest, FLAG));

function readClips(name: string, load: () => Clip[]): Clip[] {
  let clips: Clip[] = [];
  try {
    clips = load();
  } catch (error) {
    console.warn(`Clips "${name}" aus Blender nicht geladen - die Figuren stehen still`, error);
  }
  CLIP_LIBRARIES_LOADED[name] = clips.length;
  return clips;
}

/**
 * Clip-Bibliotheken und welche Modelle sie nutzen - je Bibliothek ein Skelett.
 * Tiere, Mühle und Fahne kommen hier mit ihrem Rig dazu (docs/ANIMATION.md).
 */
const CLIP_LIBRARIES: {
  rig: Rig<any>; clips: Clip[]; shapes: readonly number[];
  /** Maße fürs Backen je Modell, wenn nicht die des Modells selbst (Model). */
  joints?: (model: Model, byShape: (shape: number) => Model | undefined) => unknown;
  /** Art je Modell (Form) - Clips mit Custom Property "species" gelten nur für ihre Arten. */
  species?: Readonly<Record<number, string>>;
}[] = [
  { rig: HUMANOID, clips: CLIPS, shapes: [SHAPE.villager, SHAPE.villagerFemale] },
  {
    rig: QUADRUPED, clips: ANIMAL_CLIPS,
    shapes: [SHAPE.deer, SHAPE.hare, SHAPE.cow, SHAPE.sheep, SHAPE.goat, SHAPE.boar],
    species: {
      [SHAPE.deer]: 'deer', [SHAPE.hare]: 'hare', [SHAPE.cow]: 'cow',
      [SHAPE.sheep]: 'sheep', [SHAPE.goat]: 'goat', [SHAPE.boar]: 'boar',
    },
  },
  // Mühlenflügel (src/models/mill_clips.glb): ein Clip "sails" für alle vier Mühlen.
  { rig: MILL, clips: readClips('mill', () => loadClips(millClipsGlb, millClipsManifest, MILL)),
    shapes: [SHAPE.mill, SHAPE.mill2, SHAPE.mill3, SHAPE.mill4] },
  // Fahne am Sammelpunkt und auf dem Hauptgebäude (src/models/flag_clips.glb):
  // Clip "wave". Gemacht ist er für das Tuch am Sammelpunkt - ein längeres
  // (in Modell-Einheiten) schlägt entsprechend weiter aus.
  {
    rig: FLAG, clips: FLAG_CLIPS, shapes: [SHAPE.rallyFlag, SHAPE.townCenter],
    joints: (model, byShape) => {
      const own = model.cloth[1] - model.cloth[0];
      const ref = byShape(SHAPE.rallyFlag)!.cloth;
      return { cloth: model.cloth, stretch: own / (ref[1] - ref[0]) };
    },
  },
];

/** Höchstens so viele Clips je Figur (Uniform-Arrays im Shader). */
const MAX_CLIPS = 8;
/**
 * Bilder je Spalte der Clip-Textur. Alle Clips aller Figuren ergeben mehr
 * Bilder, als eine Textur hoch sein darf (WebGL2 garantiert nur 2048) - sie
 * liegen darum in Spalten nebeneinander: Bild g in Spalte g / CLIP_COLUMN_ROWS,
 * Zeile g % CLIP_COLUMN_ROWS.
 */
const CLIP_COLUMN_ROWS = 1024;

/**
 * Pose (motion[2]) >= CLIP_POSE: spielt Clip Nummer pose - CLIP_POSE ab, die
 * Phase (motion[1]) ist dann die Clip-Zeit in Sekunden - für die Galerie.
 */
export const CLIP_POSE = 10;
/** Clip-Uniforms eines Modells (je Modell gesetzt - jedes kann eine andere Bibliothek haben). */
interface ClipUniforms {
  rows: Int32Array;
  frames: Int32Array;
  fps: Float32Array;
  props: Int32Array;
  poseClip: Int32Array;
  poseRate: Float32Array;
  poseShift: Float32Array;
  /** Je Clip: Clip-Zeit = (Zeit - shift) * rate - für Clips ohne Pose (Mühle, Fahne). */
  rate: Float32Array;
  shift: Float32Array;
}
/** Für Modelle ohne Clips. */
const NO_CLIPS: ClipUniforms = {
  rows: new Int32Array(MAX_CLIPS).fill(-1), frames: new Int32Array(MAX_CLIPS).fill(2), fps: new Float32Array(MAX_CLIPS).fill(30),
  props: new Int32Array(MAX_CLIPS), poseClip: new Int32Array(8).fill(-1), poseRate: new Float32Array(8), poseShift: new Float32Array(8),
  rate: new Float32Array(MAX_CLIPS).fill(1), shift: new Float32Array(MAX_CLIPS),
};
/** Kantenlänge der Blatt-Textur in Pixeln (textures/birch_leaf.png). */
const LEAF_TEX_SIZE = 256;
/** Rolle der Blattkarten (Birke): der Shader malt Zweig und Blätter darauf. */
const LEAF_CARD_ROLE = 13;
/** Rolle der Astkarten (Birke): ein ganzer Ast mit hängenden Zweigen und kleinen Blättern. */
const BRANCH_CARD_ROLE = 14;
/** Rolle der Blütenkarten (Blumen): der Shader malt die Blüte darauf (blossomCard). */
const BLOSSOM_CARD_ROLE = 19;
/** Rolle der Schattenkarten (Blumen): ein weicher dunkler Fleck unter der Blüte. */
const FLOWER_SHADOW_ROLE = 21;
/** Materialien der Karten, auf die der Shader malt - sie tragen (u, v, Zufall) statt einer Farbe. */
const CARD_MATERIALS = new Set(['LeafCard', 'BranchCard', 'BlossomCard', 'FlowerShadow']);

/** Die Arten als GLSL-Tabelle, aus FLOWER_KINDS - Index = Form - SHAPE.flowerDaisy. */
const glslList = (type: string, values: string[]) => `${type}[${values.length}](${values.join(', ')})`;
const glslVec3 = ([r, g, b]: readonly number[]) => `vec3(${r.toFixed(3)}, ${g.toFixed(3)}, ${b.toFixed(3)})`;
const FLOWER_GLSL = `
const float FLOWER_PETALS[${FLOWER_KINDS.length}] = ${glslList('float', FLOWER_KINDS.map((k) => k.petals.toFixed(1)))};
const vec3 FLOWER_PETAL[${FLOWER_KINDS.length}] = ${glslList('vec3', FLOWER_KINDS.map((k) => glslVec3(k.petal)))};
const vec3 FLOWER_HEART[${FLOWER_KINDS.length}] = ${glslList('vec3', FLOWER_KINDS.map((k) => glslVec3(k.heart)))};
const float FLOWER_HEART_SIZE[${FLOWER_KINDS.length}] = ${glslList('float', FLOWER_KINDS.map((k) => k.heartSize.toFixed(3)))};
`;
/** Materialien, aus denen eine Krone besteht - daraus Mitte und Ausdehnung (Model.canopy). */
const FOLIAGE_MATERIALS = new Set(['Paint', 'LeafDark', 'LeafLight', 'Needle', 'NeedleDark', 'LeafCard', 'BranchCard']);

/** Bäume und Sträucher - ihr Laub wird weich schattiert (siehe vFoliage). */
const FOLIAGE_SHAPES: number[] = [
  ...TREES, SHAPE.berryBush, SHAPE.berryBush2, SHAPE.berryBush3, SHAPE.berryBush4,
];

/** Diese Formen sind Vorkommen, keine Gebäude oder Figuren. */
/** Tiere - Beine und Kopf bewegt der Shader ("beast"). */
const BEASTS: number[] = [SHAPE.deer, SHAPE.hare, SHAPE.cow, SHAPE.sheep, SHAPE.goat, SHAPE.boar];

export const NATURAL: number[] = [
  ...TREES, ...FLOWERS,
  SHAPE.stoneRock, SHAPE.stoneRock2, SHAPE.stoneRock3, SHAPE.goldRock, SHAPE.goldRock2, SHAPE.goldRock3,
  SHAPE.berryBush, SHAPE.berryBush2, SHAPE.berryBush3, SHAPE.berryBush4,
];

/** Gebäude schauen schräg zur Kamera (die steht bei +x +y). */
export const BUILDING_HEADING = 0.5;

/** Wo die Pflanzen ansetzen, in Metern (SOIL in tools/models/farmsGen.mjs). */
const FIELD_SOIL_METERS = '0.02';

/**
 * Stufen des Werkstücks auf der Werkbank der Bognerei (Objekte "Craft.0" bis
 * "Craft.2" in src/models/bowyer.glb): grob behauen, ausgearbeitet,
 * gespannter Bogen.
 */
export const CRAFT_STAGES = 3;

/** Waffenkammer offen: so hoch (Meter) bleiben die Wände stehen (siehe P_CUT_WALL). */
const ARMORY_CUT_METERS = '1.1';

/** Furchen je Feld (FIELD_ROWS in world/catalog.ts, ROWS in farmsGen.mjs). */
const FIELD_FURROWS = 9;
const FIELD_BASES = [SHAPE.farmWheat, SHAPE.farmCorn];

/** Alle Formen der Felder - sie liegen genau auf ihren Tiles, schräg ragten die Ecken hinaus. */
export const FIELDS: number[] = FIELD_BASES.flatMap((base) => Array.from({ length: FIELD_FURROWS }, (_, row) => base + row));

/** Blickrichtung eines Gebäudemodells. */
export function buildingHeading(shape: number): number {
  return FIELDS.includes(shape) ? 0 : BUILDING_HEADING;
}

/**
 * Uhr für alles, was sich von selbst bewegt (Mühlenflügel, Fahnen). Sie steht,
 * solange das Spiel angehalten ist, und läuft mit der Spielgeschwindigkeit -
 * Hauptansicht und Minimap teilen sie.
 */
let animationClock = 0;
let animationLast = performance.now() / 1000;
let animationPaused = false;
let animationSpeed = 1;

export function setAnimationsPaused(paused: boolean) {
  animationPaused = paused;
}

/** Spielgeschwindigkeit: 1 = normal, 2 = doppelt so schnell. */
export function setAnimationSpeed(speed: number) {
  animationSpeed = speed;
}

/** Stand dieser Uhr (Sekunden) - wie uTime im Shader. Für eingestürzte Mühlen (frozenMillMotion). */
export function animationTime(): number {
  const now = performance.now() / 1000;
  if (!animationPaused) animationClock += (now - animationLast) * animationSpeed;
  animationLast = now;
  return animationClock;
}

/**
 * Winkel eines umgefallenen Baums auf ebenem Boden: nicht ganz flach - Äste
 * und Stumpf halten den Stamm etwas hoch. Am Hang kippt der Shader um das
 * Gefälle weiter oder weniger weit (siehe "falling").
 */
export const FALL_LYING = Math.PI / 2 - 0.1;

/** Was ein Tier gerade tut - steuert seine Animation (motion[2]). */
export const ANIMAL_POSE = {
  /** Steht und äst, hebt ab und zu den Kopf. */
  graze: 0,
  walk: 1,
  /** Flucht: weite Sprünge. */
  flee: 5,
  /** Erlegt: liegt auf der Seite. */
  dead: 6,
} as const;

/** Was eine Figur gerade tut - steuert die Animation. */
export const POSE = {
  stand: 0,
  walk: 1,
  work: 2,
  /** Kniend Beeren pflücken - ohne Beil. */
  pick: 3,
  /** Mit der Sense mähen: der Oberkörper schwingt die Sense flach über den Boden. */
  scythe: 4,
  /** An der Werkbank einen Bogenstab schnitzen: beide Hände ziehen das Zugmesser heran. */
  carve: 5,
} as const;

export interface EntityInstance {
  /** Welt-Tile, linke obere Ecke. Gezeichnet wird um die Tile-Mitte. */
  x: number;
  y: number;
  /** Kantenlänge in Welt-Tiles. */
  size: number;
  color: RGB;
  shape: number;
  alpha: number;
  /**
   * Nur für Figuren: Blickrichtung (Radiant in Weltkoordinaten), Phase der
   * Animation (Radiant), Pose (POSE) und Ladung 0..1.
   */
  motion?: [number, number, number, number];
  /** Nur für Figuren: Farbe der Last auf dem Rücken. */
  accent?: RGB;
  /**
   * Geländehöhe unter der Instanz in Tiles, falls schon bekannt. Sonst rechnet
   * der Shader sie aus - für ein paar Gebäude billig, für Tausende Bäume nicht.
   */
  ground?: number;
  /**
   * Trefferpunkte 0..1 - gesetzt, wird darüber ein Lebensbalken gezeichnet.
   * Die Welt setzt es nur für Ausgewähltes, wie in AoE2.
   */
  health?: number;
}

/** Oberkante der Klotz-Formen in Kantenlängen (Wand + Dach, wie `dims` im Shader). */
const BOX_TOP: Record<number, number> = { 0: 0.55, 1: 1.6, 2: 0.9, 3: 0.42 };

/** Float-Werte je Instanz: aTile(2) + aColor(3) + aParams(3) + aMotion(4) + aAccent(3) + aGround(1). */
const STRIDE = 16;
/** aGround-Wert für "unbekannt, im Shader ausrechnen". */
const GROUND_UNKNOWN = -1e4;

/** Unterteilung flacher Overlays je Kante, damit sie sich an Hänge anschmiegen. */
const FLAT_SEGMENTS = 4;

const VERTEX_SOURCE = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2DArray;

${TERRAIN_COMMON}
${PROJECT_GLSL}
${FLATTEN_GLSL}

// xy = Lage in der Grundfläche 0..1
// z  = 0 Fuß (im Boden versenkt), 1 Traufe, 2 Dachfirst
// w  = 1 für Dachflächen
layout(location = 0) in vec4 aCorner;
layout(location = 1) in vec2 aTile;     // Welt-Tile
layout(location = 2) in vec3 aColor;
layout(location = 3) in vec3 aParams;   // x = Form, y = Alpha, z = Größe in Tiles
layout(location = 4) in vec4 aMotion;   // Figuren: Blickrichtung, Phase, Pose, Ladung
layout(location = 5) in vec3 aAccent;   // Figuren: Farbe der Last
layout(location = 6) in vec4 aMaterial; // Modelle: Materialfarbe, w = Rolle (MATERIAL_ROLE)
layout(location = 7) in float aGround;  // Geländehöhe in Tiles, oder ${GROUND_UNKNOWN} = ausrechnen

/** Untergrenze für die Größe, damit Gebäude beim Herauszoomen sichtbar bleiben. */
uniform float uMinSizeTiles;
// Maße der Figur in Koerperhoehen - aus dem Modell abgelesen: Hüfte (Rock,
// Knochen des Rumpfs), Knie (wie tief sie kniet), Abstand der Unterarme von
// der Mitte (Zugmesser zwischen beiden Händen). Bewegt wird sie von den Clips.
uniform float uHip;
uniform float uKnee;
uniform float uArm;
// Anhänge (Werkzeuge): Mitte der rechten Hand des Körpers in Ruhelage
// (Modell-Einheiten) und wie weit das Zugmesser auf seinen Handabstand
// gestreckt wird.
uniform vec3  uSocket;
uniform float uKnifeScale;
uniform vec3  uLoadAnchor;   // Befestigung der Last am Ruecken
// Modelle: Groesse je Tile der Instanzgroesse und die Zeit fuer alles, was
// sich von selbst bewegt.
uniform float uModelScale;
uniform float uModelTop;     // Höhe des Modells in Modell-Einheiten (Bäume: Absägen)
uniform float uStump;        // Bäume: Höhe des Stumpfs in Modell-Einheiten
uniform float uStumpRadius;  // Bäume: Halbmesser des Stumpfs in Modell-Einheiten
// Bäume: diese Ecke liegt auf der Schnittfläche eines abgesägten Stamms.
float gSawn = 0.0;
// Bäume: Höhe des Schnitts beim Absägen (Modell-Einheiten) - der Stamm wird
// darüber im Fragment-Shader abgeschnitten (vCut). 1e9: kein Schnitt.
float gCut = 1e9;
// Bäume: Richtung der Stammachse in der Welt (gekippt, wenn gefällt) - die
// Normale der Schnittfläche (vCapNormal).
vec3 gCapNormal = vec3(0.0, 0.0, 1.0);
// Lage in Ruhelage (Modell-Einheiten des Körpers) - für die Texturen (vLocal).
// Anhänge liegen in Metern im Rahmen der Hand und werden erst auf den Körper gebracht.
vec3 gRest = vec3(0.0);
// Feldpflanzen: 1 = frisch gesät und grün, 0 = reif in ihrer eigenen Farbe.
float gUnripe = 0.0;
uniform float uTime;
// Clips aus Blender (clips.ts): je Bild eine Zeile, je Knochen drei Texel
// (Zeilen einer 3x4-Matrix). uClipRow: erste Zeile des Clips für diese Figur,
// -1 = nicht gebacken. uPoseClip: welcher Clip eine Pose spielt (-1: keiner,
// die Figur steht still), Clip-Zeit = (Phase - uPoseShift) * uPoseRate. uClipProps: Bits
// Beil 1, Sense 2, Zugmesser 4 (PROP_BITS), kniend ${KNEEL_BIT} (KNEEL_BIT).
uniform highp sampler2D uClipTex;
uniform int   uClipRow[${MAX_CLIPS}];
uniform int   uClipFrames[${MAX_CLIPS}];
uniform float uClipFps[${MAX_CLIPS}];
uniform int   uClipProps[${MAX_CLIPS}];
// Clips ohne Pose (Mühle, Fahne): Clip-Zeit = (Zeit - uClipShift) * uClipRate.
uniform float uClipRate[${MAX_CLIPS}];
uniform float uClipShift[${MAX_CLIPS}];
// Fahnentuch: vom Mast (x) bis zum Ende (y) in Modell-y, Höhe (z) - die Knochen
// cloth.0-${FLAG_SEGMENTS} liegen gleichmäßig darauf (FLAG in clips.ts).
uniform vec3  uCloth;
uniform int   uPoseClip[8];
uniform float uPoseRate[8];
uniform float uPoseShift[8];


out vec3 vWorld;
out vec3 vColor;
flat out vec3 vParams;
flat out vec3 vTeam;     // Instanzfarbe (Spielerfarbe) - für den Umriss verdeckter Figuren
// Bäume: welche Textur (0 keine, 3 Rinde, 4 Birkenrinde, 5 Schnittfläche)
// und die Lage im Modell in Metern - die Textur haftet am Stamm, auch wenn
// er umfällt.
flat out int vTex;
// Bäume beim Absägen: Schnitthöhe in Metern (Ruhelage wie vLocal), Normale der Schnittfläche.
flat out float vCut;
flat out vec3 vCapNormal;
// Gesägt (1) - bei Bildtexturen je Eckpunkt, ihre Farbe ist ja (u, v, Schicht).
out float vSawn;
out vec3 vLocal;
// Laub von Bäumen und Sträuchern (siehe BUSH_AND_TREE_FOLIAGE): Normale von
// der Kronenmitte nach außen und wie tief innen bzw. unten es sitzt (0 Mitte,
// 1 Rand; < 0: kein Laub).
out vec3 vBent;
out float vFoliage;
uniform float uMeters;       // Breite des Modells in Metern (Modell-Einheit)
uniform vec3  uPlayerColor;  // Spielerfarbe - für Felder, deren aColor das Gefälle trägt
uniform float uSkirt;        // 1: Gebäude reichen in den Boden (Spiel), 0: ohne Sockel (Galerie ohne Gelände)
uniform vec3  uCanopy;       // Bäume, Sträucher: Mitte der Krone (Modell-Einheiten)
uniform vec3  uCanopyHalf;   // ... und ihre halbe Ausdehnung
flat out float vRoof;   // Gebäude: 1 = Dachfläche. Figuren: Körperteil.
// Baum als Bild (Billboard, siehe ensureBillboards): je Achtel-Drehung der
// Ausschnitt im Bild (u0, v0, u1, v1) und die Lage des Rechtecks zum Fuß
// (x0, y0 = oben links, Breite, Höhe) in Tiles je Größe 1, auf dem Bildschirm.
uniform int  uBillboard;
uniform vec4 uBillboardRect[${BILLBOARD_HEADINGS}];
uniform vec4 uBillboardBox[${BILLBOARD_HEADINGS}];
out vec2 vBillboardUV;

// Körperteile der Figur - aCorner.w im Menschen-Mesh.
const int P_TORSO = 0;
const int P_LEG_L = 1;
const int P_LEG_R = 2;
const int P_ARM_L = 3;
const int P_ARM_R = 4;
const int P_HEAD = 5;
const int P_LOAD = 6;
const int P_SAILS = 7;
const int P_CLOTH = 8;
const int P_SHIN_L = 9;
const int P_SHIN_R = 10;
const int P_FOREARM_L = 11;
const int P_FOREARM_R = 12;
const int P_TOOL = 13;       // Beil in der rechten Hand, schwingt mit dem Unterarm
const int P_SCYTHE = 23;     // Sense in der rechten Hand - nur beim Mähen zu sehen
const int P_KNIFE = 31;      // Zugmesser in beiden Händen - nur beim Schnitzen zu sehen
// Beere am Strauch. aCorner.w = 14 + Zufall * 0.45 je Beere: sie ist zu
// sehen, solange der Rest des Vorkommens (aMotion.w) über dem Zufall liegt.
const int P_BERRY = 14;
// Baum außer dem Stamm (Laub, Äste, Zapfen, Wurzeln). aCorner.w = 15 + Höhe
// des Teils (0..1 der Baumhöhe) * 0.45 - beim Absägen verschwindet es ganz,
// sobald der Schnitt darunter liegt.
const int P_CROWN = 15;
// Bäume: der Stumpf bleibt beim Fällen stehen (16), sein Deckel wird dabei zur
// hellen Schnittfläche (17), ebenso der Boden des Stamms (18).
const int P_STUMP = 16;
const int P_STUMP_TOP = 17;
const int P_LOG_END = 18;
const int P_TRUNK = 19;
// Felder: Pflanze (20) und Stück gepflügter Erde (21). aCorner.w = Teil +
// Furche * 0.04 + Lage in der Furche (0..1) * 0.039. Gezeichnet wird je Furche
// eine Instanz: aMotion.x = Furche (< 0: alle, Bauvorschau), aMotion.y = Stand
// (0..1 gepflügt, 1..2 gesät, 2..3 gewachsen), aMotion.z = Rest der Ernte,
// aMotion.w = welche der 3x3 Tiles zum Feld gehören (Bit x * 3 + y), dazu
// ab Bit 9 die Tiles ringsum, auf denen ein anderes Feld liegt; die der 3x3
// mit einem anderen Feld kommen als Bits in aAccent.r (* 255).
const int P_CROP = 20;
const int P_SOIL = 21;
// Schnur mit Pflöcken an einer Kante eines Tiles: aCorner.w = 22 + Tile * 0.04
// + Seite * 0.009 (0/1: Tile davor/dahinter entlang x, 2/3: entlang y).
const int P_EDGE = 22;
// Waffenkammer: das Dach (verschwindet, wenn der Zeiger darauf steht), die
// Wände (werden dann niedrig) und die Bögen im Vorrat - je Bogen seine
// Reihenfolge im Nachkomma-Teil (Anteil * 0.45), er erscheint, sobald der
// Füllstand (aMotion.y) darüber liegt. Offen: aMotion.z = 1.
const int P_CUT_ROOF = 28;
const int P_STOCK = 29;
const int P_CUT_WALL = 30;
// Bognerei: was auf der Werkbank entsteht, in ${CRAFT_STAGES} Stufen (Objekte
// "Craft.<n>") - je Stufe ihre Nummer im Nachkomma-Teil. Zu sehen ist die
// zum Fortschritt (aMotion.y, 0..1) passende; aMotion.y < 0: die Bank ist leer.
const int P_CRAFT = 32;


// Abtastschritt wie beim Geländegitter (TerrainRenderer.gridCell) - sonst
// fehlen hier die Feinwellen, die das Gelände nah herangezoomt hat.
uniform float uGroundStep;

float groundZ(vec2 world) {
  return uReliefScale > 0.0
      ? flattenZ(world, reliefZ(elevation(world * uMapScale, uGroundStep)) * uReliefScale)
      : 0.0;
}

// Knochen eines Eckpunkts der Figur - Reihenfolge wie HUMANOID_BONES in
// clips.ts. Der Rumpf gehört über der Hüfte zum Oberkörper, darunter zum
// Unterkörper. Werkzeuge hängen am rechten Unterarm.
int boneOf(int part, float z) {
  if (part == P_LEG_L) return ${BONE['thigh.L']};
  if (part == P_SHIN_L) return ${BONE['shin.L']};
  if (part == P_LEG_R) return ${BONE['thigh.R']};
  if (part == P_SHIN_R) return ${BONE['shin.R']};
  if (part == P_ARM_L) return ${BONE['upperArm.L']};
  if (part == P_FOREARM_L) return ${BONE['forearm.L']};
  if (part == P_ARM_R) return ${BONE['upperArm.R']};
  if (part == P_FOREARM_R || part == P_TOOL || part == P_SCYTHE) return ${BONE['forearm.R']};
  if (part == P_HEAD) return ${BONE.head};
  if (part == P_LOAD) return ${BONE.upperBody};
  return z > uHip ? ${BONE.upperBody} : ${BONE.lowerBody};
}

// Texel "i" (0..2: Zeile der 3x4-Matrix) eines Knochens in Bild "row" - die
// Bilder liegen in Spalten zu ${CLIP_COLUMN_ROWS} (CLIP_COLUMN_ROWS).
vec4 clipTexel(int row, int bone, int i) {
  int column = row / ${CLIP_COLUMN_ROWS};
  int x = column * ${MAX_BONES * TEXELS_PER_BONE} + bone * ${TEXELS_PER_BONE} + i;
  return texelFetch(uClipTex, ivec2(x, row - column * ${CLIP_COLUMN_ROWS}), 0);
}

// Punkt p mit der Matrix eines Knochens in Bild "row".
vec3 clipBone(vec3 p, int row, int bone) {
  vec4 h = vec4(p, 1.0);
  return vec3(dot(clipTexel(row, bone, 0), h), dot(clipTexel(row, bone, 1), h), dot(clipTexel(row, bone, 2), h));
}

// Drehung der Schultern gegen die Hüfte (Radiant) zur Zeit "time": aus der
// Matrix des Oberkörpers, dessen Vorwärts-Achse sie zur Seite dreht (Zeile 1,
// Spalte 0 = sin). Der Rock schwingt damit mit.
float clipTwist(int clip, float time) {
  int frames = uClipFrames[clip];
  float f = mod(time * uClipFps[clip], float(frames - 1));
  int row = uClipRow[clip] + int(floor(f));
  float s = mix(clipTexel(row, ${BONE.upperBody}, 1).x, clipTexel(row + 1, ${BONE.upperBody}, 1).x, fract(f));
  return asin(clamp(s, -1.0, 1.0));
}

// Punkt p mit einem Knochen des Clips zur Zeit "time" (Sekunden, Schleife),
// zwischen zwei Bildern gemischt.
vec3 clipSkin(vec3 p, int clip, float time, int bone) {
  int frames = uClipFrames[clip];
  // Das letzte Bild gleicht dem ersten - die Schleife ist ein Bild kürzer.
  float f = mod(time * uClipFps[clip], float(frames - 1));
  int f0 = int(floor(f));
  int row = uClipRow[clip] + f0;
  return mix(clipBone(p, row, bone), clipBone(p, row + 1, bone), f - float(f0));
}

// Mühlenzeit für den Clip "sails" (mill_clips.glb): wo in der Schleife eine
// Mühle mit Startstellung "phase" (millMotion) steht. Die Böen kommen im
// Takt der Startstellung (3.1 * phase); die Drehung passt bis auf
// höchstens 6.4 Grad - die vier Flügel sind nach einer Vierteldrehung gleich,
// gesucht wird die nächste von sieben Stellungen (millClipOffset in TS).
float millClipOffset(float phase) {
  float best = 0.0;
  float err = 10.0;
  for (int k = 0; k < 7; k++) {
    float o = (3.1 * phase + 6.2831853 * float(k)) / ${GUST_RATE.toFixed(3)};
    float e = abs(mod(${SAIL_SPEED.toFixed(3)} * o - phase + 0.7853982, 1.5707963) - 0.7853982);
    if (e < err) {
      err = e;
      best = o;
    }
  }
  return best;
}

void main() {
  int shape = int(aParams.x + 0.5);
  vec2 center = aTile + 0.5;
  vec3 world;
  vBent = vec3(0.0, 0.0, 1.0);
  vFoliage = -1.0;
  vBillboardUV = vec2(0.0);

  if (uBillboard == 1) {
    // Baum weit draußen: ein Rechteck zur Kamera mit dem vorab aus dem Modell
    // gerenderten Bild. Die Ansicht ist parallel, das Bild ist also überall
    // dasselbe - nur verschoben und nach der Größe skaliert. Die Tiefe wächst
    // mit der Höhe über dem Fuß wie beim Modell.
    int h = int(mod(floor(aMotion.x / ${((2 * Math.PI) / BILLBOARD_HEADINGS).toFixed(7)} + 0.5), ${BILLBOARD_HEADINGS}.0));
    vec4 box = uBillboardBox[h];
    vec2 off = (box.xy + aCorner.xy * box.zw) * aParams.z * uPixelsPerTile;
    float base = aGround > ${GROUND_UNKNOWN / 10}.0 ? aGround * uReliefScale : groundZ(center);
    vec4 foot = project(center, base);
    vec4 clip = project(center, base + max(0.0, -off.y) / (uPixelsPerTile * uZScreen));
    clip.xy = foot.xy + vec2(off.x, -off.y) * 2.0 / uResolution;
    gl_Position = clip;
    vec4 r = uBillboardRect[h];
    vBillboardUV = mix(r.xy, r.zw, aCorner.xy);
    vParams = aParams;
    vColor = aColor;
    return;
  }

  if (shape == 10) {
    // Lebensbalken: ein Rechteck fester Pixelgroesse ueber dem Kopf der
    // Instanz. Verankert wird er in der Welt, die Ausdehnung kommt in
    // Bildschirmpixeln dazu - so bleibt er auf jeder Zoomstufe lesbar.
    // aMotion: x = Anteil 0..1, y = Hoehe des Ankers ueber Grund (Tiles),
    //          z = Balkenhoehe (px), w = Abstand zum Anker (px).
    vec4 clip = project(center, groundZ(center) + aMotion.y);
    vec2 px = vec2((aCorner.x - 0.5) * aParams.z, aCorner.y * aMotion.z + aMotion.w);
    clip.xy += px * 2.0 / uResolution;
    clip.z = -1.0;  // vor allem anderen
    gl_Position = clip;
    vWorld = vec3(aCorner.xy, aMotion.z);
    vColor = aColor;
    vParams = aParams;
    vRoof = aMotion.x;
    return;
  }

  if (shape >= 5 && shape != 17 && shape != ${SHAPE_RING}) {  // 10 (Lebensbalken) ist oben schon abgefangen
    // Modell aus einer OBJ-Datei. Eckpunkte in Modell-Einheiten: x nach vorn,
    // y nach links, z nach oben, Boden bei 0. Figuren sind auf Koerperhoehe 1
    // gebracht, Gebaeude auf Breite 1 (siehe loadModel()).
    bool figure = ${FIGURE_TEST};
    bool prop = shape >= ${SHAPE.propAxe} && shape <= ${SHAPE.propKnifeFemale};
    bool beast = ${BEASTS.map((n) => `shape == ${n}`).join(' || ')};
    bool natural = ${NATURAL.map((n) => `shape == ${n}`).join(' || ')};
    bool field = shape >= ${SHAPE.farmWheat} && shape < ${SHAPE.farmCorn + FIELD_FURROWS};
    // Mindestgröße nur für Gebäude und Figuren: Bäume auf Mindestgröße
    // aufgeblasen würden herausgezoomt jeden Wald zu einem Brei machen.
    float size = natural ? aParams.z
        : figure ? max(aParams.z, uMinSizeTiles * 0.5)
        : beast ? max(aParams.z, uMinSizeTiles * 0.3) : max(aParams.z, uMinSizeTiles);
    float scale = size * uModelScale;
    int part = int(aCorner.w + 0.5);
    vec3 p = aCorner.xyz;
    if (prop) {
      // Anhang (Werkzeug): in Metern im Rahmen der rechten Hand - an die Hand
      // des Körpers, der es trägt, in dessen Einheiten. Das Zugmesser auf
      // seinen Handabstand gestreckt (gebaut ist es für den Mann).
      if (part == P_KNIFE) p.y *= uKnifeScale;
      p = uSocket + p / uMeters;
    }
    gRest = p;

    if (figure) {
      float phase = aMotion.y;
      int pose = int(aMotion.z + 0.5);
      // Clip aus Blender (src/models/humanoid_clips.glb): Pose >=
      // CLIP_POSE (Galerie) oder die Pose, die ein Clip ersetzt (uPoseClip).
      int clip = pose >= ${CLIP_POSE} ? pose - ${CLIP_POSE} : pose < 8 ? uPoseClip[pose] : -1;
      if (clip >= 0 && uClipRow[clip] < 0) clip = -1;
      if (clip >= 0) {
        float time = pose >= ${CLIP_POSE} ? phase : (phase - uPoseShift[pose]) * uPoseRate[pose];
        // Werkzeuge nur, wenn der Clip sie braucht (props in humanoid_clips.json).
        int props = uClipProps[clip];
        bool away = (part == P_TOOL && (props & 1) == 0) || (part == P_SCYTHE && (props & 2) == 0)
            || (part == P_KNIFE && (props & 4) == 0);
        if (away) {
          p = vec3(0.0, 0.0, uHip);
        } else {
          // Die Last waechst mit der Ladung aus dem Ruecken heraus.
          if (part == P_LOAD) p = uLoadAnchor + (p - uLoadAnchor) * aMotion.w;
          // Rock und Hosenboden schwingen etwas mit, wenn sich die Schultern
          // gegen die Hüfte drehen - vor dem Stauchen.
          if (part == P_TORSO && p.z <= uHip) p.y += clipTwist(clip, time) * 0.25 * (uHip - p.z);
          if ((props & ${KNEEL_BIT}) != 0 && part == P_TORSO && p.z <= uHip) {
            // Kniend: der Rock staucht sich bis zum Boden und legt sich vorn
            // über das aufgestellte Knie - so tief, wie die Knochen die Figur
            // senken (das Knie auf dem Boden: -(uKnee - 0.04)).
            float kneelBob = -(uKnee - 0.04);
            float below = (uHip - p.z) / uHip;
            p.z = uHip - (uHip - p.z) * (uHip + kneelBob) / (uHip - 0.02);
            p.x += below * 0.14;
          }
          if (part == P_KNIFE) {
            // Zweihändig: nach der Lage zwischen den Händen auf beide Unterarme verteilt.
            float k = clamp((p.y + uArm) / (2.0 * uArm), 0.0, 1.0);
            p = mix(clipSkin(p, clip, time, ${BONE['forearm.R']}), clipSkin(p, clip, time, ${BONE['forearm.L']}), k);
          } else {
            p = clipSkin(p, clip, time, boneOf(part, p.z));
          }
        }
      } else {
        // Ohne Clip (Bibliothek nicht geladen): Ruhelage, Werkzeuge weggesteckt.
        if (part == P_TOOL || part == P_SCYTHE || part == P_KNIFE) p = vec3(0.0, 0.0, uHip);
        if (part == P_LOAD) p = uLoadAnchor + (p - uLoadAnchor) * aMotion.w;
      }
    }

    if (beast) {
      // Tiere: Clip aus Blender (src/models/quadruped_clips.glb) - Pose
      // >= CLIP_POSE (Galerie) oder die Pose, die ein Clip dieser Art ersetzt.
      // Ohne Clip (Bibliothek nicht geladen) steht es still.
      float phase = aMotion.y;
      int pose = int(aMotion.z + 0.5);
      int clip = pose >= ${CLIP_POSE} ? pose - ${CLIP_POSE} : pose < 8 ? uPoseClip[pose] : -1;
      if (clip >= 0 && uClipRow[clip] >= 0) {
        float time = pose >= ${CLIP_POSE} ? phase : (phase - uPoseShift[pose]) * uPoseRate[pose];
        // Knochen je Teil (QUADRUPED in clips.ts): die vier Beine, der Kopf, sonst die Wurzel.
        int bone = part == 24 ? ${QUADRUPED_BONE['leg.FL']} : part == 25 ? ${QUADRUPED_BONE['leg.FR']}
            : part == 26 ? ${QUADRUPED_BONE['leg.BL']} : part == 27 ? ${QUADRUPED_BONE['leg.BR']}
            : part == P_HEAD ? ${QUADRUPED_BONE.head} : ${QUADRUPED_BONE.root};
        p = clipSkin(p, clip, time, bone);
      }
    }

    if (${TREES.map((n) => `shape == ${n}`).join(' || ')}) {
      // Holz wird verbraucht: der (gefällte) Baum wird von der Spitze her
      // abgesägt, statt zu schrumpfen - erst die Krone, dann der Stamm. Was
      // über dem Schnitt liegt, wird auf die Schnitthöhe gedrückt und bildet
      // die Schnittfläche. Ganz leer bleibt ein Stumpf stehen.
      float cut = mix(uStump, uModelTop, aMotion.w);
      // Gefällt (oder schon angesägt): die Schnittflächen sind hell.
      bool felled = aMotion.y > 0.0 || aMotion.w < 0.999;
      if (felled && (part == P_STUMP_TOP || part == P_LOG_END)) gSawn = 1.0;
      if (part == P_STUMP || part == P_STUMP_TOP) {
        // Der Stumpf bleibt, wie er ist.
      } else if (part == P_CROWN) {
        // Laub, Äste, Zapfen: weg, sobald der Schnitt unter ihrem Ansatz liegt.
        float from = (aCorner.w - 15.0) / 0.45 * uModelTop;
        if (from > cut) p = vec3(0.0);
      } else if (part == P_TRUNK && (aCorner.w - 19.0) / 0.45 * uModelTop > cut - 0.001 * uModelTop) {
        // Stammstück ganz über dem Schnitt (oder genau auf ihm, wie das
        // unterste auf dem Stumpf): weg. Flach gedrückt ergäbe ein schräger
        // Stamm eine lange Platte auf dem Stumpf.
        p = vec3(0.0);
      } else if (part == P_TRUNK && aMotion.w < 0.999) {
        // Das Stück, durch das gerade gesägt wird: der Fragment-Shader
        // schneidet es auf Schnitthöhe ab und malt, wo man in den offenen
        // Stamm hineinsieht, die Schnittfläche - rund, auch am schrägen Stamm.
        gCut = cut;
      }
    }

    if (part == P_STOCK && (aCorner.w - 29.0) / 0.45 >= aMotion.y) p = vec3(0.0);
    if (part == P_CRAFT) {
      float own = floor((aCorner.w - 32.0) / 0.45 * ${CRAFT_STAGES}.0);
      float now = floor(clamp(aMotion.y, 0.0, 0.999) * ${CRAFT_STAGES}.0);
      if (aMotion.y < 0.0 || own != now) p = vec3(0.0);
    }
    if (part == P_CUT_ROOF && aMotion.z > 0.5) p = vec3(0.0);
    // Offen: die Wände nur bis gut einen Meter hoch - man schaut hinein.
    if (part == P_CUT_WALL && aMotion.z > 0.5) p.z = min(p.z, ${ARMORY_CUT_METERS} / uMeters);

    if (part == P_BERRY) {
      // Abgeerntet: die Beeren verschwinden eine nach der anderen, der Strauch
      // bleibt stehen. Alle Ecken einer Beere auf einen Punkt - unsichtbar.
      float keep = (aCorner.w - 14.0) / 0.45;
      if (keep >= aMotion.w) p = vec3(0.0);
    }

    if (field) {
      int row = int(floor(aMotion.x + 0.5));
      float stage = aMotion.y;
      int tiles = int(aMotion.w + 0.5);
      bool hide = false;
      if (part == P_CROP || part == P_SOIL) {
        float v = aCorner.w - float(part);
        int own = int(floor(v / 0.04 + 0.001));
        float q = (v - float(own) * 0.04) / 0.039;
        // Drei Furchen und drei Stücke je Tile - so liegt jedes Teil in genau einem.
        int bit = (own / 3) * 3 + min(int(floor(q * 3.0 + 0.001)), 2);
        hide = (row >= 0 && own != row) || ((tiles >> bit) & 1) == 0;
        if (part == P_SOIL) {
          // Erde erscheint, wo schon gepflügt ist.
          hide = hide || (stage < 1.0 && q >= stage - 0.001);
        } else {
          // Pflanzen: gesät bis q, noch nicht geerntet ab dem Rest; sie
          // wachsen aus der Erde heraus und reifen von Grün zur eigenen Farbe.
          // Mit etwas Spielraum: q kommt gerundet aus aCorner.w zurück, die
          // erste Pflanze eines Tiles bliebe sonst abgeerntet stehen.
          hide = hide || stage < 1.0 || (stage < 2.0 && q >= stage - 1.004) || q >= aMotion.z - 0.004;
          float grown = clamp(stage - 2.0, 0.0, 1.0);
          float soil = ${FIELD_SOIL_METERS} / uMeters;
          p.z = soil + (p.z - soil) * mix(0.15, 1.0, grown);
          gUnripe = 1.0 - smoothstep(0.5, 1.0, grown);
        }
      } else if (part == P_EDGE) {
        // Abgesteckt: nur die Kanten am Umriss des Felds - das Tile gehört
        // dazu, sein Nachbar auf dieser Seite nicht.
        float v = aCorner.w - 22.0;
        int cell = int(floor(v / 0.04 + 0.001));
        int side = int(floor((v - float(cell) * 0.04) / 0.009 + 0.5));
        int ci = cell / 3;
        int cj = cell - ci * 3;
        int ni = ci + (side == 0 ? -1 : side == 1 ? 1 : 0);
        int nj = cj + (side == 2 ? -1 : side == 3 ? 1 : 0);
        // Außerhalb der 3x3: Bit 9 + Seite * 3 + Lage - dort liegt ein anderes
        // Feld, und die beiden gehen ohne Schnur ineinander über.
        int outer = 9 + side * 3 + (side < 2 ? cj : ci);
        bool inGrid = ni >= 0 && ni < 3 && nj >= 0 && nj < 3;
        // In den 3x3: eigenes Tile, oder ein anderes Feld dort (aAccent.r * 255
        // als Bits je Tile - Felder haben keine Last, die die Farbe bräuchte).
        int others = int(aAccent.r * 255.0 + 0.5);
        bool neighbour = inGrid
            ? ((tiles >> (ni * 3 + nj)) & 1) == 1 || ((others >> (ni * 3 + nj)) & 1) == 1
            : ((tiles >> outer) & 1) == 1;
        hide = row > 0 || ((tiles >> cell) & 1) == 0 || neighbour;
      } else {
        // Sonstiges (die Breiten-Marken): nur einmal je Feld.
        hide = row > 0;
      }
      if (hide) {
        // Ganz außerhalb des Bildes - die Dreiecke fallen weg, und die
        // Bodenhöhe muss für sie nicht gerechnet werden.
        gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
        return;
      }
    }

    if (part == P_CLOTH && !figure && uClipRow[0] >= 0) {
      // Fahnentuch (Sammelpunkt, Hauptgebäude): Clip "wave" aus Blender. Die
      // Knochen cloth.0-N liegen gleichmäßig längs des Tuchs; dazwischen die
      // beiden Nachbarn nach der Lage gemischt (an den Eckpunkten genau einer).
      float time = (uTime - uClipShift[0]) * uClipRate[0];
      float s = clamp((p.y - uCloth.x) / (uCloth.y - uCloth.x), 0.0, 1.0) * ${FLAG_SEGMENTS}.0;
      int j = min(int(floor(s)), ${FLAG_SEGMENTS - 1});
      p = mix(clipSkin(p, 0, time, 1 + j), clipSkin(p, 0, time, 2 + j), s - float(j));
    }

    if (part == P_SAILS && uClipRow[0] >= 0) {
      // Mühlenflügel: Clip "sails" aus Blender, in Mühlenzeit (Spielzeit *
      // Drehzahl + Stellung der Mühle). aMotion.z < 0: eingestürzt, die Zeit
      // steht bei -aMotion.z - 1 (frozenMillMotion).
      float speed = aMotion.z > 0.0 ? aMotion.z : 1.0;
      float t = aMotion.z < 0.0 ? -aMotion.z - 1.0 : uTime * speed + millClipOffset(aMotion.y);
      p = clipSkin(p, 0, (t - uClipShift[0]) * uClipRate[0], 1);
    }

    // Blickrichtung je Instanz (Gebäude bekommen sie vom Renderer).
    // Einsturz (Gebäude, aMotion.w = Fortschritt 0..1): jeder Eckpunkt sackt
    // unterschiedlich weit ab - aus dem Gebäude wird ein Schutthaufen, der
    // unten etwas breiter läuft. Erst nach dem Drehen der Mühlenflügel: sonst
    // würden die zusammengedrückten Flügel um die Nabe gedreht und schnellten
    // verzerrt nach oben.
    if (!figure && !natural && !field && aMotion.w > 0.0) {
      float c = aMotion.w;
      float h = fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
      p.z *= mix(1.0, 0.12 + 0.4 * h, c);
      p.xy *= 1.0 + c * 0.35 * (0.4 + h);
      // Der Haufen sackt schief zusammen.
      p.z += c * 0.12 * (p.x - 0.4 * p.y);
    }

    // Hinweispfeil: aMotion.y Tiles über dem Boden (übers Dach), wippt.
    if (shape == ${SHAPE.markerArrow}) p.z += (aMotion.y + 0.05 * sin(uTime * 3.0)) / scale;

    // Felder liegen auf ihren Tiles; aMotion.x ist bei ihnen die Furche.
    float heading = field ? 0.0 : aMotion.x;
    vec2 forward = vec2(cos(heading), sin(heading));
    vec2 left = vec2(-forward.y, forward.x);
    vec2 offset = (forward * p.x + left * p.y) * scale;

    // Laub wie eine weiche Kugel beleuchten statt Fläche für Fläche: die
    // Normale zeigt von der Kronenmitte weg ("bent normals"), und was tief
    // in der Krone oder an ihrer Unterseite sitzt, liegt im Schatten.
    int matRole = int(aMaterial.w + 0.5);
    if (${FOLIAGE_SHAPES.map((n) => `shape == ${n}`).join(' || ')}) {
      if (matRole == 1 || matRole == ${FOLIAGE_ROLE} || matRole == ${LEAF_CARD_ROLE} || matRole == ${BRANCH_CARD_ROLE}) {
        vec3 nb = (aCorner.xyz - uCanopy) / max(uCanopyHalf, vec3(0.01));
        vFoliage = clamp(length(nb), 0.0, 1.2) * mix(0.65, 1.0, smoothstep(-1.0, 0.7, nb.z));
        vBent = vec3(forward * nb.x + left * nb.y, nb.z);
      }
    }
    float up = p.z * scale;

    // Umfallen (Vorkommen): um den Fuss kippen, aMotion.y = Winkel,
    // aMotion.z = Richtung in Weltkoordinaten. Der Anteil in Fallrichtung
    // und die Hoehe drehen sich, der Anteil quer dazu bleibt.
    bool falling = natural && aMotion.y > 0.0;
    // Der Stumpf und alles am Boden (Wurzeln, Gras, Laub) bleiben stehen;
    // der Stamm darüber kippt um die Oberkante des Stumpfs.
    bool grounded = part == P_STUMP || part == P_STUMP_TOP
        || (part == P_CROWN && aCorner.w - 15.0 < 0.002);
    if (falling && !grounded) {
      vec2 dir = vec2(cos(aMotion.z), sin(aMotion.z));
      float hinge = uStump * scale;
      // Am Hang: so weit kippen, dass die Spitze auf dem Gelände liegt - der
      // Baum bleibt dabei starr. Das Gefälle vom Fuß bis zur Spitze kommt zum
      // Winkel auf ebenem Boden hinzu (bergab weiter, bergauf weniger weit).
      float reach = (uModelTop - uStump) * scale * 0.85;
      float drop = groundZ(center) - groundZ(center + dir * reach);
      float rest = clamp(${FALL_LYING.toFixed(4)} + atan(drop, reach), 0.7, 2.3);
      float angle = aMotion.y * rest / ${FALL_LYING.toFixed(4)};
      float along = dot(offset, dir);
      vec2 across = offset - dir * along;
      float c = cos(angle);
      float s = sin(angle);
      float lift = up - hinge;
      offset = across + dir * (along * c + lift * s);
      up = hinge - along * s + lift * c;
      gCapNormal = vec3(dir * s, c);
      // Gegen Ende rutscht der Stamm vom Stumpf: sein abgesägtes Ende liegt
      // dann neben dem Stumpf auf dem Boden, nicht obendrauf.
      float slide = smoothstep(0.75, 1.0, aMotion.y / ${FALL_LYING.toFixed(4)});
      float logRadius = uStumpRadius * scale;
      offset += dir * (logRadius * 2.2) * slide;
      up -= (hinge - logRadius * 0.9) * slide;
    }

    vec2 xy = center + offset;
    float base = aGround > ${GROUND_UNKNOWN / 10}.0 ? aGround * uReliefScale : groundZ(center);
    // Felder werden nicht eingeebnet: jede Pflanze steht auf dem Gelände darunter.
    if (field) {
      // Felder folgen dem Gelände. Gemessen ist es je Furche an drei Stellen
      // entlang der Furche (Anfang, Mitte, Ende): die Höhe (aAccent.g,
      // aGround, aAccent.b) und das Gefälle quer dazu (aColor) - dazwischen
      // eine Parabel, quer dazu eine Gerade, so schließen die Furchen am Hang
      // ohne Stufen aneinander. Das Gelände hier je Eckpunkt zu rechnen
      // kostete bei Tausenden Halmen zu viel. Ohne Messung (Bauvorschau) doch
      // je Eckpunkt.
      // Pflöcke und Schnur (wenige Eckpunkte, über das ganze Feld verteilt)
      // aber genau je Eckpunkt.
      if (aGround > ${GROUND_UNKNOWN / 10}.0 && part != P_EDGE) {
        float q = clamp((xy.y - center.y + 1.5) / 3.0, 0.0, 1.0);
        vec3 w = vec3((2.0 * q - 1.0) * (q - 1.0), 4.0 * q * (1.0 - q), q * (2.0 * q - 1.0));
        float h = dot(w, vec3(aAccent.g, aGround, aAccent.b));
        float across = xy.x - (center.x + (float(int(floor(aMotion.x + 0.5))) + 0.5) * ${(3 / FIELD_FURROWS).toFixed(6)} - 1.5);
        base = (h + dot(w, aColor) * across) * uReliefScale;
      } else {
        base = groundZ(xy);
      }
    }
    float z = base + up;
    // Gebaeude stehen waagerecht; ihr Sockel reicht in den Boden, damit am
    // Hang keine Luecke darunter aufgeht. Ein kippender Baum nicht - sein
    // Sockel wuerde sonst als Stange aus dem Boden ragen.
    // Vorkommen stehen schon auf dem tiefsten Punkt ihres Fußes (und Schutt
    // fliegt durch die Luft) - die brauchen keinen Sockel.
    // Felder liegen einfach auf dem Gelände - ein Sockel stünde am Hang als
    // Wand unter der Erde heraus.
    if (uSkirt > 0.5 && !figure && !natural && !field && !beast && p.z < 0.001) z = base - 1.0;
    world = vec3(xy, z);
  } else if (shape == 17) {
    // Staub: ein zur Kamera gedrehter Fleck. Mitte in der Welt, Ausdehnung
    // in Bildschirmpixeln - so wirkt die Wolke von jeder Seite rund.
    vec4 clip = project(center, groundZ(center) + aMotion.x);
    clip.xy += (aCorner.xy - 0.5) * aParams.z * uPixelsPerTile * 2.0 / uResolution;
    gl_Position = clip;
    vWorld = vec3(aCorner.xy, 0.0);
    vColor = aColor;
    vParams = aParams;
    vRoof = 0.0;
    return;
  } else if (shape == 4 || shape == ${SHAPE_RING}) {
    // Overlays behalten ihre Tile-Größe - sie sollen genau ihr Feld abdecken.
    // Jede Ecke sitzt auf ihrer eigenen Geländehöhe, leicht angehoben, damit
    // sie nicht im Boden verschwindet.
    vec2 p = center + (aCorner.xy - 0.5) * aParams.z;
    // Der Auswahlring liegt fast am Boden - angehoben rutschte er in der
    // Schrägansicht nach oben und säße hinter der Figur statt unter ihr.
    // Mit mitgegebener Bodenhöhe (Mitte) liegt er waagerecht darauf.
    float ground = aGround > ${GROUND_UNKNOWN / 10}.0 ? aGround * uReliefScale : groundZ(p);
    world = vec3(p, ground + (shape == ${SHAPE_RING} ? 0.012 : 0.15));
  } else {
    float size = max(aParams.z, uMinSizeTiles);
    // x = Anteil der Grundfläche, y = Wandhöhe, z = Dachhöhe (je Kantenlänge)
    vec3 dims = vec3(0.86, 0.55, 0.0);                    // Quader, Flachdach
    if (shape == 1) dims = vec3(0.56, 1.25, 0.35);        // Turm
    else if (shape == 2) dims = vec3(0.82, 0.45, 0.45);   // Haus mit Spitzdach
    else if (shape == 3) dims = vec3(0.9, 0.22, 0.2);     // flaches Lager

    vec2 p = center + (aCorner.xy - 0.5) * size * dims.x;
    // Ein Gebäude steht waagerecht: Höhe aus der Mitte, nicht je Ecke. Der Fuß
    // reicht in den Boden, damit am Hang keine Lücke darunter aufgeht.
    float base = groundZ(center);
    float z = aCorner.z < 0.5 ? base - 2.0
            : aCorner.z < 1.5 ? base + size * dims.y
            : base + size * (dims.y + dims.z);
    world = vec3(p, z);
  }

  vWorld = world;
  // Auswahlring: der Fragment-Shader braucht die Lage im Quadrat (0..1).
  if (shape == ${SHAPE_RING}) vWorld = vec3(aCorner.xy, world.z);
  vColor = aColor;
  vTeam = aColor;
  vTex = 0;
  vSawn = gSawn;
  vCut = 1e9;
  vCapNormal = gCapNormal;
  vLocal = vec3(0.0);
  if (shape >= 5 && shape != ${SHAPE_RING}) {
    // Modelle färben nach Material: Kittel bzw. Anstrich in der Instanzfarbe,
    // die Last in der Farbe der Ressource, alles andere wie in der MTL-Datei.
    int role = int(aMaterial.w + 0.5);
    // Felder: aColor trägt das Gefälle, der Anstrich (Pfosten) kommt als Uniform.
    bool fieldShape = shape >= ${SHAPE.farmWheat} && shape < ${SHAPE.farmCorn + FIELD_FURROWS};
    vec3 paint = fieldShape ? uPlayerColor : aColor;
    vColor = role == 1 ? paint : role == 2 ? aAccent : aMaterial.rgb;
    if (gSawn > 0.5 && role != ${IMAGE_ROLE}) vColor = vec3(0.86, 0.71, 0.48);
    vColor = mix(vColor, vec3(0.34, 0.56, 0.2), gUnripe * 0.85);
    bool tree = ${TREES.map((n) => `shape == ${n}`).join(' || ')};
    bool villager = ${FIGURE_TEST};
    bool figureTex = role >= ${FIGURE_TEX.cloth} && role <= ${FIGURE_TEX.skin};
    vTex = role == ${IMAGE_ROLE} ? role
      : figureTex ? (villager ? role : 0)
      : villager && (role == 1 || role == 2) ? ${FIGURE_TEX.cloth}
      : role >= 6 && role != ${FOLIAGE_ROLE} ? role : !tree ? 0 : gSawn > 0.5 ? 5 : (role == 3 || role == 4) ? role : 0;
    vLocal = gRest * uMeters;
    if (gCut < 1e8) vCut = gCut * uMeters;
    // Bauvorschau: halbdurchsichtig ganz in der Vorschaufarbe - rot, wenn
    // der Platz nicht geht.
    if (!${FIGURE_TEST} && aParams.y < 0.99 && aMotion.w == 0.0) vColor = aColor;
  }
  vParams = aParams;
  vRoof = aCorner.w;
  gl_Position = project(world.xy, world.z);
  // Figuren und Auswahlring stehen auf der berechneten Geländehöhe; das
  // Geländenetz nähert sie nur mit Dreiecken an und liegt in Mulden etwas
  // höher - es schnitte Füße und Ring ab. Ihre Tiefe wird deshalb um etwa
  // einen halben Tile zur Kamera gezogen; auf dem Bildschirm bleibt alles,
  // wo es ist (siehe project: näher = kleinere Tiefe).
  if (${FIGURE_TEST} || shape == ${SHAPE_RING} || ${BEASTS.map((n) => `shape == ${n}`).join(' || ')}) gl_Position.z -= 0.5 / uDepthRange;
  // Felder ebenso ein Stück: ihre Erde liegt nur wenige Zentimeter über dem
  // Gelände, das zwischen ihren Eckpunkten sonst hier und da durchsticht.
  if (shape >= ${SHAPE.farmWheat} && shape < ${SHAPE.farmCorn + FIELD_FURROWS}) gl_Position.z -= 0.2 / uDepthRange;
}
`;

const FRAGMENT_SOURCE = `#version 300 es
precision highp float;

in vec3 vWorld;
in vec3 vColor;
flat in vec3 vTeam;
flat in int vTex;
flat in float vCut;
flat in vec3 vCapNormal;
in float vSawn;
in vec3 vLocal;
in vec3 vBent;
in float vFoliage;

float texHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float texNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(texHash(i), texHash(i + vec2(1, 0)), u.x),
             mix(texHash(i + vec2(0, 1)), texHash(i + vec2(1, 1)), u.x), u.y);
}
// Abstand zur nächsten Zellgrenze (Voronoi) - die Furchen zwischen Borkenplatten.
float texCells(vec2 p, out float id) {
  vec2 cell = floor(p);
  float d1 = 9.0, d2 = 9.0;
  id = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 c = cell + vec2(x, y);
    vec2 o = vec2(texHash(c), texHash(c + 7.1));
    float d = length(p - c - o);
    if (d < d1) { d2 = d1; d1 = d; id = texHash(c + 3.3); } else if (d < d2) d2 = d;
  }
  return d2 - d1;
}

// 1, solange ein Muster mit freq Wiederholungen je Meter noch größer als
// ein Pixel (px Meter) ist, 0, wenn es darunter fällt.
float texDetail(float freq, float px) {
  return 1.0 - smoothstep(0.25, 0.6, freq * px);
}

uniform highp sampler2DArray uModelImages; // Bildtexturen der Modelle (IMAGE_ROLE)
uniform sampler2D uLeafTex;  // Foto eines Birkenblatts (Blatt- und Astkarten)

// Birkenrinde wie am Stamm (treeTexture, vTex 4), für gemalte Äste und Zweige:
// uv = (um den Ast herum, entlang des Asts) in Metern, s = Lage quer zum Ast
// (-1..1, für die Rundung), brown = 0 weiße Rinde mit schwarzen Querstrichen
// und Rissen, 1 die dünne rotbraune Rinde junger Zweige.
vec3 birchBark(vec2 uv, float s, float brown) {
  float dash = smoothstep(0.72, 0.8, texNoise(uv * vec2(4.0, 26.0)));
  float crack = smoothstep(0.86, 0.9, texNoise(uv * vec2(9.0, 2.2)));
  vec3 white = vec3(0.9, 0.89, 0.84) * (0.9 + 0.1 * texNoise(uv * vec2(30.0, 10.0)));
  vec3 c = mix(white, vec3(0.12, 0.11, 0.1), max(dash * 0.85, crack));
  vec3 young = vec3(0.38, 0.22, 0.15) * (0.85 + 0.3 * texNoise(uv * vec2(20.0, 60.0)));
  c = mix(c, young, brown);
  // Rund: zu den Rändern hin im Schatten.
  return c * (0.6 + 0.4 * sqrt(max(0.0, 1.0 - s * s)));
}

// Birkenblatt an einem Stiel: d = Punkt relativ zum Ansatz am Zweig, dir =
// Richtung des Blatts, len = Länge samt Stiel (Meter), h = Zufall je Blatt,
// px = Meter je Bildschirmpixel. Gemalt wird ein Foto eines Birkenblatts
// (uLeafTex: Spitze oben, Stiel unten in der Mitte), sein Umriss kommt aus
// der Transparenz. true, wenn der Punkt darauf liegt; col = seine Farbe.
bool birchLeaf(vec2 d, vec2 dir, float len, float h, float px, out vec3 col) {
  float along = dot(d, dir) / len;
  float across = dot(d, vec2(-dir.y, dir.x)) / len;
  if (along < 0.0 || along > 1.0 || abs(across) > 0.5) return false;
  // Feste Mipmap-Stufe: in Schleifen und Verzweigungen gibt es keine
  // verlässlichen Ableitungen für die automatische.
  float lod = log2(max(px / len * ${LEAF_TEX_SIZE}.0, 1.0));
  vec2 uv = vec2(0.5 + across, 1.0 - along);
  // Der Umriss aus einer feinen Stufe - in den groben mittelt sich die
  // Transparenz weg, und weit draußen verschwänden die Blätter. Die Farbe
  // aus der passenden Stufe, damit sie nicht flimmert.
  if (textureLod(uLeafTex, uv, min(lod, 2.0)).a < 0.5) return false;
  vec4 t = textureLod(uLeafTex, uv, lod);
  // Das Foto ist recht dunkel - heller und etwas gelbgrüner, wie im Sommer
  // mit Sonne. Jedes Blatt etwas anders: heller oder dunkler, mal gelblicher.
  vec3 c = t.rgb / max(t.a, 0.2) * vec3(1.35, 1.4, 1.05) * (0.85 + 0.35 * h);
  c = mix(c, c * vec3(1.15, 1.1, 0.7), smoothstep(0.7, 1.0, h) * 0.5);
  if (h > 0.97) c = mix(c, vec3(0.82, 0.72, 0.26), 0.7);
  col = c;
  return true;
}

// Dorfbewohner: Muster in Metern am unbewegten Modell (vLocal: x vorn, y
// links, z oben) - sie wandern also nicht über die Figur, wenn sie sich
// bewegt. Was feiner als ein Pixel ist, geht in den Mittelwert über.
vec3 figureTexture(vec3 base) {
  float px = max(length(fwidth(vLocal)), 1e-4);
  vec3 p = vLocal;
  // Waagerecht um die Figur herum - x + y deckt vorn und die Seiten ab.
  vec2 q = vec2(p.x + p.y, p.z);
  if (vTex == ${FIGURE_TEX.cloth}) {
    // Leinen: Kett- und Schussfäden im Wechsel, längs fallende Falten und
    // leicht fleckig vom Tragen.
    float weave = 0.5 + 0.5 * sin(q.x * 420.0) * sin(q.y * 420.0);
    float thread = texNoise(q * vec2(160.0, 40.0));
    float fold = 0.5 + 0.5 * sin((p.x - p.y) * 28.0 + texNoise(q * vec2(3.0, 1.5)) * 5.0);
    float mottle = texNoise(q * 5.0 + 1.3);
    vec3 c = base * (0.9 + 0.2 * mix(0.5, weave * 0.7 + thread * 0.3, texDetail(67.0, px)));
    c *= 0.88 + 0.16 * mix(0.5, fold, texDetail(5.0, px));
    return c * (0.93 + 0.12 * mottle);
  }
  if (vTex == ${FIGURE_TEX.leather}) {
    // Leder: feine Narbung, dunkle Knitterfalten, hell abgewetzte Stellen.
    float id;
    float e = texCells(q * vec2(16.0, 28.0), id);
    float crease = (1.0 - smoothstep(0.02, 0.07, e)) * texDetail(28.0, px);
    float grain = mix(0.5, texNoise(q * 90.0), texDetail(90.0, px));
    float worn = smoothstep(0.62, 0.85, texNoise(q * 7.0 + 4.1));
    vec3 c = base * (0.92 + 0.08 * id) * (0.88 + 0.24 * grain);
    c = mix(c, base * 1.3 + vec3(0.03), worn * 0.3);
    return mix(c, base * 0.6, crease * 0.35);
  }
  if (vTex == ${FIGURE_TEX.hair}) {
    // Haar: Strähnen, die um den Kopf herum senkrecht fallen, mit hellen
    // Glanzlichtern auf einzelnen Strähnen.
    float around = atan(p.y, p.x) * 0.13;
    float strands = texNoise(vec2(around * 140.0, p.z * 7.0)) * 0.6 + texNoise(vec2(around * 330.0, p.z * 16.0)) * 0.4;
    float shine = smoothstep(0.7, 0.95, texNoise(vec2(around * 60.0, p.z * 3.0) + 7.3));
    vec3 c = base * (0.72 + 0.56 * mix(0.5, strands, texDetail(50.0, px)));
    return mix(c, base * 1.6 + vec3(0.06), shine * 0.3);
  }
  // Haut: kaum sichtbar fleckig, stellenweise etwas röter.
  float mottle = texNoise(q * 18.0);
  float flush = smoothstep(0.55, 0.9, texNoise(q * 4.0 + 2.2));
  vec3 c = base * (0.95 + 0.1 * mix(0.5, mottle, texDetail(18.0, px)));
  return mix(c, c * vec3(1.06, 0.93, 0.9), flush * 0.4);
}

// Bildtextur aus der .glb: base = (u, v, Schicht); v = 0 ist unten im Bild.
// Durchsichtiges (Umriss der Blattkarten) wird verworfen.
vec3 imageTexture(vec3 base) {
  vec4 t = texture(uModelImages, vec3(base.x, 1.0 - base.y, floor(base.z + 0.5)));
  if (t.a < 0.5) discard;
  return t.rgb;
}

// Rinde als Textur: Stamm abgewickelt (Umfang, Höhe) in Metern.
vec3 treeTexture(vec3 base) {
  float r = max(length(vLocal.xy), 0.05);
  vec2 uv = vec2(atan(vLocal.y, vLocal.x) * r, vLocal.z);
  if (vTex == 3) {
    // Borke: längliche Platten, dazwischen tiefe dunkle Furchen, feine
    // Längsmaserung auf den Platten, jede Platte etwas anders getönt.
    float id;
    float e = texCells(uv * vec2(7.0, 1.6), id);
    float furrow = 1.0 - smoothstep(0.03, 0.16, e);
    float grain = texNoise(uv * vec2(38.0, 3.0)) * 0.5 + texNoise(uv * vec2(90.0, 8.0)) * 0.5;
    vec3 c = base * (0.82 + 0.36 * id) * (0.85 + 0.3 * grain);
    return mix(c, base * 0.32, furrow);
  }
  if (vTex == 4) {
    // Birke: weiß mit waagerechten dunklen Strichen (Lentizellen) und
    // vereinzelten schwarzen Rissen.
    float dash = smoothstep(0.72, 0.8, texNoise(uv * vec2(4.0, 26.0)));
    float crack = smoothstep(0.86, 0.9, texNoise(uv * vec2(9.0, 2.2)));
    vec3 c = base * (0.9 + 0.1 * texNoise(uv * vec2(30.0, 10.0)));
    return mix(c, vec3(0.12, 0.11, 0.1), max(dash * 0.85, crack));
  }
  if (vTex == 6) {
    // Holzschindeln: versetzte Reihen (Reihe = Höhe), jede Schindel etwas
    // anders getönt, dunkle Fugen dazwischen, die untere Kante unregelmäßig
    // und im Schatten der Reihe darüber. Waagerecht zählt die Richtung, in
    // der das Dach verläuft - x + y deckt beide ab.
    vec2 q = vec2((vLocal.x + vLocal.y) * 3.2, vLocal.z * 5.0);
    float row = floor(q.y);
    q.x += mod(row, 2.0) * 0.5;
    vec2 cell = vec2(floor(q.x), row);
    vec2 f = fract(q);
    float tone = texHash(cell);
    float ragged = texHash(cell + 11.0) * 0.18;
    float gapX = smoothstep(0.0, 0.06, f.x) * smoothstep(1.0, 0.94, f.x);
    float shade = smoothstep(0.0, 0.3 + ragged, f.y);
    vec3 c = base * (0.78 + 0.4 * tone) * (0.62 + 0.38 * shade);
    c *= 0.9 + 0.2 * texNoise(vec2(q.x * 7.0, q.y * 1.5));
    return mix(base * 0.35, c, gapX);
  }
  // Felder: Muster in Metern. Was feiner ist als etwa ein Pixel, wird zum
  // Mittelwert ausgeblendet - sonst flimmert es als Rauschen.
  float px = max(length(fwidth(vLocal)), 1e-4);
  if (vTex == 7) {
    // Getreide: Halme als feine senkrechte Streifen, unten im Bestand
    // dunkel, oben hell; helle Ähren und dunkle Grannen als Sprenkel.
    vec2 h = vec2(vLocal.x * 0.8 + vLocal.y * 0.6, vLocal.y * 0.8 - vLocal.x * 0.6);
    float stalks = mix(0.5, texNoise(vec2(h.x * 40.0, vLocal.z * 3.0)) * 0.6 + texNoise(vec2(h.y * 55.0, vLocal.z * 4.0)) * 0.4, texDetail(55.0, px));
    float ears = smoothstep(0.62, 0.8, texNoise(vec2(h.x * 22.0, vLocal.z * 16.0) + h.y * 9.0)) * texDetail(22.0, px);
    float depth = smoothstep(0.2, 1.1, vLocal.z);
    vec3 c = base * (0.78 + 0.4 * stalks);
    c = mix(c, base * 1.2 + vec3(0.05), ears * 0.45);
    return c * (0.6 + 0.45 * depth);
  }
  if (vTex == 8) {
    // Blätter (Mais): feine Längsadern, dazu sanft fleckig.
    float mottle = texNoise(vLocal.xy * 4.0 + vLocal.z * 3.0);
    float lines = 0.5 + 0.5 * sin((vLocal.x - vLocal.y) * 90.0 + vLocal.z * 25.0);
    vec3 c = base * (0.82 + 0.3 * mottle);
    return c * (1.0 + 0.12 * (lines - 0.5) * texDetail(15.0, px));
  }
  if (vTex == 9) {
    // Umgepflügte Erde: Pflugspuren entlang der Furchen, darin Schollen mit
    // dunklen Spalten, Krümel, feuchtere dunkle Stellen und helle Steinchen.
    float id;
    float e = texCells(vLocal.xy * vec2(3.0, 6.0), id);
    float crack = (1.0 - smoothstep(0.02, 0.12, e)) * texDetail(6.0, px);
    float streak = 0.5 + 0.5 * sin(vLocal.x * 14.0 + texNoise(vLocal.xy * vec2(2.0, 0.5)) * 3.0);
    float crumbs = mix(0.5, texNoise(vLocal.xy * 30.0), texDetail(30.0, px));
    float damp = smoothstep(0.35, 0.75, texNoise(vLocal.xy * 0.6));
    float pebble = smoothstep(0.9, 0.95, texNoise(vLocal.xy * 12.0 + 3.7)) * texDetail(12.0, px);
    vec3 c = base * (0.85 + 0.25 * id) * (0.88 + 0.22 * crumbs) * (0.9 + 0.2 * streak * texDetail(14.0, px));
    c *= 1.0 - 0.18 * damp;
    c = mix(c, base * 0.5, crack * 0.7);
    return mix(c, vec3(0.6, 0.57, 0.52), pebble * 0.6);
  }
  if (vTex == 11) {
    // Maiskolben: Körner in Reihen.
    vec2 q = vec2((vLocal.x + vLocal.y) * 55.0, vLocal.z * 50.0);
    vec2 f = fract(q);
    float kernel = smoothstep(0.0, 0.3, f.x) * smoothstep(1.0, 0.7, f.x) * smoothstep(0.0, 0.3, f.y) * smoothstep(1.0, 0.7, f.y);
    return base * (0.85 + 0.25 * mix(0.45, kernel, texDetail(55.0, px)));
  }
  if (vTex == ${BRANCH_CARD_ROLE}) {
    // Astkarte (Birke): vom Stamm (links, u = 0) ein geschwungener Ast nach
    // außen, von ihm hängen Zweige herab, an denen viele kleine Blätter
    // wechselständig sitzen. Gerechnet in Metern der Karte (2 m x 2.2 m).
    // Je Pixel nur die nächsten Zweige und darin die nächsten Blätter.
    vec2 q = vec2(base.x * 2.0, base.y * 2.2);
    float qpx = max(length(fwidth(q)), 1e-5);
    float seed = base.z;
    vec3 col = vec3(0.0);
    bool hit = false;
    // Der Ast: steigt vom Stamm an, hängt zur Spitze hin durch.
    float branchY = 0.32 - 0.16 * sin(3.1416 * min(q.x, 1.6) / 1.6) + 0.14 * smoothstep(1.1, 2.0, q.x);
    float thick = mix(0.035, 0.008, q.x / 2.0);
    if (abs(q.y - branchY) < thick && q.x < 1.95) {
      float across = (q.y - branchY) / thick;
      col = birchBark(vec2(across * thick * 3.1416, q.x), across, smoothstep(0.2, 1.2, q.x));
      hit = true;
    }
    float spacing = 0.12;
    float nearest = floor((q.x - 0.18) / spacing + 0.5);
    for (int di = -1; di <= 1; di++) {
      float fi = nearest + float(di);
      if (fi < 0.0 || fi > 14.0) continue;
      float h = fract(sin(fi * 91.7 + seed * 311.3) * 43758.5453);
      float x0 = 0.18 + fi * spacing + (h - 0.5) * 0.05;
      float y0 = 0.32 - 0.16 * sin(3.1416 * min(x0, 1.6) / 1.6) + 0.14 * smoothstep(1.1, 2.0, x0);
      float len = 1.0 + h * 0.8 - fi * 0.03;
      float along = q.y - y0;
      if (along < -0.04 || along > len + 0.06) continue;
      float sway = h * 6.2832;
      // Der Zweig selbst.
      float tx = x0 + sin(along * 2.2 + sway) * 0.03;
      if (along > 0.0 && along < len && abs(q.x - tx) < 0.0045) {
        float across = (q.x - tx) / 0.0045;
        col = birchBark(vec2(across * 0.014, along + fi * 1.7), across, 1.0);
        hit = true;
      }
      // Die Blätter daran, klein: die zwei nächsten.
      float leafGap = 0.05;
      float k0 = floor((along - 0.03) / leafGap);
      for (int dk = 0; dk <= 1; dk++) {
        float k = k0 + float(dk);
        float ly = 0.03 + k * leafGap;
        if (k < 0.0 || ly > len) continue;
        float hk = fract(sin((fi * 37.0 + k) * 12.9898 + seed * 78.233) * 43758.5453);
        float side = mod(k, 2.0) < 1.0 ? -1.0 : 1.0;
        vec2 stem = vec2(x0 + sin(ly * 2.2 + sway) * 0.03, y0 + ly);
        // Birkenblätter hängen steil, die Spitze nach unten.
        float ang = side * (0.15 + hk * 0.35);
        vec3 leaf;
        if (birchLeaf(q - stem, vec2(sin(ang), cos(ang)), 0.08 + hk * 0.025, hk, qpx, leaf)) {
          // Tiefer im Vorhang etwas dunkler.
          col = leaf * (1.0 - 0.22 * smoothstep(0.3, 1.6, ly));
          hit = true;
        }
      }
      // Kätzchen: an manchen Zweigen hängt am Ende eine gelbbraune, geschuppte Ähre.
      if (h > 0.72) {
        float cy = along - len;
        float cx = q.x - (x0 + sin(len * 2.2 + sway) * 0.03);
        if (cy > 0.0 && cy < 0.09 && abs(cx) < 0.009 * (1.0 - cy / 0.12)) {
          col = mix(vec3(0.72, 0.6, 0.3), vec3(0.45, 0.3, 0.16), step(0.5, fract(cy * 110.0)));
          hit = true;
        }
      }
    }
    if (!hit) discard;
    return col;
  }
  if (vTex == ${LEAF_CARD_ROLE}) {
    // Blattkarte (Birke): ein hängender Zweig, leicht geschwungen, mit
    // wechselständigen spitz-eiförmigen Blättern an kurzen Stielen. Was kein
    // Zweig und kein Blatt ist, wird verworfen - die Karte selbst sieht man
    // nicht. base = (u, v, Zufall); gerechnet in etwa Metern, damit die
    // Blätter auf der länglichen Karte nicht verzerrt sind.
    vec2 q = vec2(base.x * 0.47, base.y * 1.25);
    float qpx = max(length(fwidth(q)), 1e-5);
    float seed = base.z;
    float bend = seed * 6.2832;
    float twigX = 0.235 + sin(q.y * 2.4 + bend) * 0.035;
    vec3 col = vec3(0.0);
    bool hit = false;
    float twigW = 0.009 + 0.006 * (1.0 - base.y);
    if (abs(q.x - twigX) < twigW && base.y < 0.97) {
      float across = (q.x - twigX) / twigW;
      col = birchBark(vec2(across * twigW * 3.1416, q.y + seed * 5.0), across, 0.85);
      hit = true;
    }
    for (int i = 0; i < 12; i++) {
      float fi = float(i);
      float h = fract(sin((fi + 1.0) * 12.9898 + seed * 78.233) * 43758.5453);
      float t = 0.07 + fi * 0.098 + (h - 0.5) * 0.03;
      float side = mod(fi, 2.0) < 1.0 ? -1.0 : 1.0;
      vec2 stem = vec2(0.235 + sin(t * 2.4 + bend) * 0.035, t);
      // Schräg nach unten und zur Seite, jedes etwas anders.
      float ang = side * (0.2 + h * 0.4);
      vec3 leaf;
      if (birchLeaf(q - stem, vec2(sin(ang), cos(ang)), 0.17 + h * 0.05, h, qpx, leaf)) {
        col = leaf;
        hit = true;
      }
    }
    if (!hit) discard;
    return col;
  }
  // Schnittfläche: helles Holz mit Jahresringen, zum Rand dunkler.
  float rings = 0.5 + 0.5 * sin(r * 70.0 + texNoise(vLocal.xy * 6.0) * 3.0);
  return base * (0.86 + 0.14 * rings);
}
// 1: Umriss-Durchgang - nur die verdeckten Teile einer Figur, in Spielerfarbe.
uniform int uSilhouette;
flat in vec3 vParams;
flat in float vRoof;
out vec4 fragColor;
uniform highp int uBillboard;  // wie im Vertex-Shader, sonst lässt sich das Programm nicht linken
uniform sampler2D uBillboardTex;
in vec2 vBillboardUV;

${FLOWER_GLSL}
// Deckung der Blütenkarte am Rand der Blüte - geht ins Alpha (main).
float gCardAlpha = 1.0;

// Blütenkarte einer Blume: Blütenblätter mit Fugen und Wölbung, eine gewölbte
// Mitte mit Glanzpunkt, Klee als Köpfchen aus Tupfen - wie die gemalten Blumen
// im Gelände (flower() in terrainShader.ts). base = (u, v, Zufall); was
// außerhalb der Blüte liegt, wird verworfen.
vec3 blossomCard(vec3 base, int shape) {
  int k = clamp(shape - ${SHAPE.flowerDaisy}, 0, ${FLOWER_KINDS.length - 1});
  float petals = FLOWER_PETALS[k];
  float heartSize = FLOWER_HEART_SIZE[k];
  // Die Blüte füllt die Karte fast bis an den Rand.
  vec2 q = (base.xy - 0.5) * 2.0 / 0.95;
  float d = length(q);
  // Ein Pixel in Einheiten der Blüte - für weiche, aber scharfe Ränder.
  float px = max(fwidth(d), 1e-4);
  float a = atan(q.y, q.x) + base.z * 6.2832;
  float rim = petals > 0.0 ? 0.5 + 0.5 * pow(abs(cos(a * petals * 0.5)), 0.6) : 0.8;
  gCardAlpha = smoothstep(rim + px, rim - px, d);
  if (gCardAlpha < 0.02) discard;
  // Licht von einer festen Seite der Karte - sie steht je Blume anders gedreht.
  vec2 toSun = normalize(vec2(-0.45, 0.35));
  float facing = dot(q, toSun) / max(d, 1e-3);
  // Blütenblätter: zur Mitte hin tiefer (dunkler), außen heller, dazu die
  // Wölbung zur Sonne und dunkle Fugen zwischen den Blättern.
  vec3 col = FLOWER_PETAL[k] * (0.72 + 0.3 * d) * (0.9 + 0.22 * facing * min(d, 1.0));
  if (petals > 0.0) col *= 0.82 + 0.18 * smoothstep(0.0, 0.35, abs(cos(a * petals * 0.5)));
  else col *= 0.85 + 0.3 * step(0.5, fract((q.x + q.y) * 3.0) * fract((q.x - q.y) * 3.0) * 4.0);
  // Die Mitte als kleine Kuppel mit Glanzpunkt.
  float h = smoothstep(heartSize + px, heartSize - px, d);
  vec3 hc = FLOWER_HEART[k] * (0.75 + 0.45 * clamp(1.0 - length(q / max(heartSize, 1e-3) - toSun * 0.4), 0.0, 1.0));
  col = mix(col, hc, h);
  float gloss = smoothstep(0.22, 0.0, length(q - toSun * max(heartSize, 0.35) * 0.9));
  return mix(col, vec3(1.0), gloss * 0.35);
}

// Zur Kamera, in Weltkoordinaten - hängt von der Blickrichtung ab.
uniform vec3 uToCamera;
// Licht von links oben im Bild - dieselbe Sonne wie im Gelände-Shader.
const vec3 SUN = vec3(-0.45, 0.35, 0.82);

void main() {
  if (uBillboard == 1) {
    // Die Bilder sind in der Größe der Zoomstufe gerendert: Ränder und dünne
    // Stämme sind halb deckend wie beim Modell und werden weich eingeblendet;
    // nur fast Durchsichtiges fällt weg (es schriebe sonst Tiefe). Die Farbe
    // ist vormultipliziert.
    // Die Bilder zeigen den größten Baum; kleinere werden nur verkleinert.
    // Die Verschiebung hält dabei die scharfe Stufe statt der nächstkleineren.
    vec4 t = texture(uBillboardTex, vBillboardUV, -0.7);
    if (t.a < 0.2) discard;
    fragColor = vec4(t.rgb / t.a, t.a);
    return;
  }
  int shape = int(vParams.x + 0.5);
  float alpha = vParams.y;

  if (shape == 4) {
    fragColor = vec4(vColor, alpha);
    return;
  }

  if (shape == ${SHAPE_RING}) {
    // Auswahlring: kräftiger Rand in der Auswahlfarbe, außen eine dünne
    // dunkle Kontur (hebt ihn vom Gelände ab), innen ganz leicht gefüllt.
    float r = length(vWorld.xy - 0.5) * 2.0;
    float edge = fwidth(r) * 1.5;
    float band = smoothstep(0.66 - edge, 0.66, r) * (1.0 - smoothstep(0.86, 0.86 + edge, r));
    float outline = smoothstep(0.86, 0.86 + edge, r) * (1.0 - smoothstep(0.96, 0.96 + edge, r));
    float fill = 1.0 - smoothstep(0.66 - edge, 0.66, r);
    vec3 color = mix(vColor, vec3(0.05), outline);
    float a = band * 0.95 + outline * 0.6 + fill * 0.12;
    if (a <= 0.01) discard;
    fragColor = vec4(color, a * alpha);
    return;
  }

  if (shape == 17) {
    // Staub: rund, zur Mitte dicht, zum Rand weich auslaufend, leicht fleckig.
    vec2 q = vWorld.xy - 0.5;
    float r = length(q) * 2.0;
    float clumps = 0.75 + 0.25 * sin(q.x * 23.0 + q.y * 17.0) * sin(q.y * 29.0 - q.x * 11.0);
    float a = alpha * (1.0 - smoothstep(0.35, 1.0, r)) * clumps;
    if (a <= 0.002) discard;
    fragColor = vec4(vColor, a);
    return;
  }

  if (shape == 10) {
    // Lebensbalken: dunkler Rahmen, gefuellt bis zum Anteil der Trefferpunkte,
    // Farbe von Gruen ueber Gelb nach Rot. vRoof traegt hier den Anteil,
    // vWorld die Lage im Balken (xy) und seine Hoehe in Pixeln (z).
    float health = vRoof;
    vec2 size = vec2(vParams.z, vWorld.z);
    vec2 px = vWorld.xy * size;
    float edge = min(min(px.x, size.x - px.x), min(px.y, size.y - px.y));
    float border = max(1.0, size.y * 0.2);
    vec3 fill = health > 0.5
        ? mix(vec3(0.95, 0.85, 0.2), vec3(0.3, 0.85, 0.35), (health - 0.5) * 2.0)
        : mix(vec3(0.9, 0.2, 0.15), vec3(0.95, 0.85, 0.2), health * 2.0);
    vec3 color = edge < border ? vec3(0.05) : vWorld.x <= health ? fill : vec3(0.12);
    fragColor = vec4(color, edge < border ? 0.9 : 1.0);
    return;
  }

  // Flächennormale aus den Bildschirm-Ableitungen - die Klötze sind eckig,
  // eine Normale je Fläche ist genau richtig und spart ein Attribut.
  vec3 normal = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  // Stamm beim Absägen: über dem Schnitt weg. Die Stammflächen zeigen nach
  // außen (loadModel) - sieht man ihre Rückseite, blickt man durch den
  // Schnitt in den Stamm und sieht dort die Schnittfläche.
  if (vLocal.z > vCut) discard;
  bool cutFace = vCut < 1e8 && gl_FrontFacing;
  if (cutFace) normal = normalize(vCapNormal);
  if (dot(normal, uToCamera) < 0.0) normal = -normal;

  if (uSilhouette == 1) {
    // Verdeckte Figur: halbdurchsichtig in der Spielerfarbe, Flächen, die zur
    // Seite zeigen, heller und deckender - so liest sie sich als Umriss.
    float rim = 1.0 - abs(dot(normal, normalize(uToCamera)));
    fragColor = vec4(mix(vTeam, vec3(1.0), 0.25 + rim * 0.5), 0.3 + rim * 0.55);
    return;
  }

  vec3 base = vColor;
  if (cutFace) base = vec3(0.86, 0.71, 0.48) * (0.9 + 0.1 * texNoise(vLocal.xy * 6.0));
  else if (vTex == ${IMAGE_ROLE}) base = vSawn > 0.5 ? treeTexture(vec3(0.86, 0.71, 0.48)) : imageTexture(base);
  else if (vTex >= ${FIGURE_TEX.cloth} && vTex <= ${FIGURE_TEX.skin}) base = figureTexture(base);
  else if (vTex == ${BLOSSOM_CARD_ROLE}) base = blossomCard(base, shape);
  else if (vTex == ${FLOWER_SHADOW_ROLE}) {
    // Schatten der Blüte auf dem Gras: rund und weich, zur Mitte am dunkelsten.
    gCardAlpha = 0.6 * (1.0 - smoothstep(0.3, 0.85, length(base.xy - 0.5) * 2.0));
    if (gCardAlpha < 0.004) discard;
    base = vec3(0.02, 0.05, 0.01);
  }
  else if (vTex != 0) base = treeTexture(base);
  if (vRoof > 0.5 && shape != 0 && shape < 5) {
    // Spitzdächer bekommen einen dunklen Ziegelton, damit man Dach und Wand
    // auseinanderhält. Flachdächer bleiben in der Gebäudefarbe.
    base = mix(vColor, vec3(0.42, 0.2, 0.14), 0.55);
  }

  if (vFoliage >= 0.0) {
    // Laub: überwiegend die Kugel-Normale der Krone, ein Rest der Fläche
    // für Struktur. Innen und unten dunkler (Umgebungsverdeckung); wo die
    // Sonne von hinten durch den Kronenrand scheint, leuchtet es gelbgrün
    // durch (Durchscheinen).
    vec3 n = normalize(mix(normal, normalize(vBent), 0.7));
    float sun = dot(n, normalize(SUN));
    float occlusion = mix(0.5, 1.05, smoothstep(0.15, 1.0, vFoliage));
    float lit = (0.42 + 0.72 * max(sun, 0.0)) * occlusion;
    float through = pow(max(-sun, 0.0), 1.5) * smoothstep(0.6, 1.0, vFoliage) * 0.35;
    fragColor = vec4(base * lit + base * vec3(0.9, 1.15, 0.45) * through, alpha);
    return;
  }

  float light = 0.45 + 0.75 * max(dot(normal, normalize(SUN)), 0.0);
  fragColor = vec4(base * light, alpha * gCardAlpha);
}
`;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Entity-Shader lässt sich nicht übersetzen:\n${log}`);
  }
  return shader;
}

/** Klotz mit Walmdach: vier Wände und vier Dachdreiecke zum First in der Mitte. */
function buildingMesh(): Float32Array {
  const corners = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const v: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = corners[i];
    const [bx, by] = corners[(i + 1) % 4];
    // Wand
    v.push(ax, ay, 0, 0, bx, by, 0, 0, ax, ay, 1, 0);
    v.push(bx, by, 0, 0, bx, by, 1, 0, ax, ay, 1, 0);
    // Dach
    v.push(ax, ay, 1, 1, bx, by, 1, 1, 0.5, 0.5, 2, 1);
  }
  return new Float32Array(v);
}

/** Feines Gitter für flache Overlays. */
function flatMesh(): Float32Array {
  const v: number[] = [];
  const n = FLAT_SEGMENTS;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x0 = i / n, x1 = (i + 1) / n, y0 = j / n, y1 = (j + 1) / n;
      v.push(x0, y0, 0, 0, x1, y0, 0, 0, x0, y1, 0, 0);
      v.push(x1, y0, 0, 0, x1, y1, 0, 0, x0, y1, 0, 0);
    }
  }
  return new Float32Array(v);
}

/**
 * Bewegliche Teile nach Objektname im Modell - die Nummern stehen so im
 * Shader (P_*). Alles andere steht still.
 */
const PARTS: [prefix: string, part: number][] = [
  // Unterschenkel und Unterarme vor den ganzen Gliedern - der erste passende
  // Anfang zählt.
  ['Leg.L.Lower', 9],
  ['Leg.R.Lower', 10],
  ['Arm.L.Lower', 11],
  // Das Beil vor dem Unterarm, sonst fiele es unter 'Arm.R.Lower'.
  ['Arm.R.Lower.Tool', 13],
  // Ebenso die Sense.
  ['Arm.R.Lower.Scythe', 23],
  ['Arm.R.Lower', 12],
  ['Berry', 14],
  // Tiere: die vier Beine (vor 'Leg.L'/'Leg.R' der Figuren - andere Namen).
  ['Leg.FL', 24],
  ['Leg.FR', 25],
  ['Leg.BL', 26],
  ['Leg.BR', 27],
  ['Crop', 20],
  ['Soil', 21],
  ['Edge', 22],
  ['Leg.L', 1],
  ['Leg.R', 2],
  ['Arm.L', 3],
  ['Arm.R', 4],
  ['Head', 5],
  ['Load', 6],
  ['Sails', 7],
  ['Cloth', 8],
  // Zugmesser der Figuren (siehe P_KNIFE).
  ['Knife', 31],
  // Waffenkammer (siehe P_CUT_ROOF).
  ['Cut.Roof', 28],
  ['Stock', 29],
  ['Cut.Wall', 30],
  // Werkstück der Bognerei (siehe P_CRAFT).
  ['Craft', 32],
];

/** Materialien, die zur Laufzeit gefärbt werden - aMaterial.w im Shader. */
const MATERIAL_ROLE: Record<string, number> = {
  Tunic: 1, // Instanzfarbe (Dorfbewohner)
  Paint: 1, // Instanzfarbe (Gebäude)
  Load: 2, // Farbe der getragenen Ressource
  // Bäume: Rinde als Textur im Fragment-Shader (treeTexture)
  Bark: 3,
  BarkDark: 3,
  PineBark: 3,
  Birch: 4,
  // Gebäude: Holzschindeln als Textur (siehe treeTexture, vTex 6)
  Shingle: 6,
  ShingleDark: 6,
  // Laub von Bäumen und Sträuchern: weich schattiert (FOLIAGE_ROLE). Das Laub
  // in der Instanzfarbe (Paint) zählt auch dazu.
  LeafDark: FOLIAGE_ROLE,
  LeafLight: FOLIAGE_ROLE,
  Needle: FOLIAGE_ROLE,
  NeedleDark: FOLIAGE_ROLE,
  LeafCard: LEAF_CARD_ROLE,
  BranchCard: BRANCH_CARD_ROLE,
  BlossomCard: BLOSSOM_CARD_ROLE,
  FlowerShadow: FLOWER_SHADOW_ROLE,
  // Felder (tools/models/farmsGen.mjs): Getreide, Blätter, Kolben.
  Wheat: 7,
  WheatDark: 7,
  WheatEar: 7,
  Tassel: 7,
  WheatStem: 8,
  CornStalk: 8,
  CornLeaf: 8,
  CornHusk: 8,
  Vine: 8,
  Soil: 9,
  SoilDark: 9,
  SoilLight: 9,
  CornCob: 11,
  // Dorfbewohner (nur Figuren, siehe figureTexture): Stoff, Leder, Haar, Haut.
  // Der Kittel (Tunic, Rolle 1) und die Last (Load, Rolle 2) sind auch Stoff.
  Wool: FIGURE_TEX.cloth,
  WoolShade: FIGURE_TEX.cloth,
  Apron: FIGURE_TEX.cloth,
  ApronShade: FIGURE_TEX.cloth,
  Patch: FIGURE_TEX.cloth,
  Band: FIGURE_TEX.cloth,
  Leather: FIGURE_TEX.leather,
  LeatherLight: FIGURE_TEX.leather,
  Boots: FIGURE_TEX.leather,
  BootsDark: FIGURE_TEX.leather,
  BootsLight: FIGURE_TEX.leather,
  Hair: FIGURE_TEX.hair,
  Skin: FIGURE_TEX.skin,
  SkinShade: FIGURE_TEX.skin,
};

interface Model {
  /** Je Eckpunkt: x vorn, y links, z oben (Modell-Einheiten), Teil, r, g, b, Rolle. */
  vertices: Float32Array;
  /**
   * Vereinfachte Fassungen fürs Herauszoomen (siehe LOD_PARTS): ohne die
   * kleinen Teile - Beeren, Blattbüschel, Rinde. Nur bei Vorkommen.
   */
  lods?: Float32Array[];
  hip: number;
  shoulder: number;
  knee: number;
  elbow: number;
  /** Figuren: Abstand der Unterarme von der Mitte (Modell-Einheiten). */
  arm: number;
  /** Bäume: Höhe des Stumpfs (Modell-Einheiten) - dort knickt der Stamm beim Fällen ab. */
  stump: number;
  /** Bäume: Halbmesser des Stumpfs (Modell-Einheiten) - so weit rutscht der Stamm daneben. */
  stumpRadius: number;
  loadAnchor: [number, number, number];
  /** Mitte der Flügel (links, oben). */
  hub: [number, number];
  /** Fahnentuch (Teil Cloth): vom Mast bis zum Ende in Modell-y, seine Höhe - für die Fahne (FLAG). */
  cloth: [number, number, number];
  /** Bäume, Sträucher: Mitte und halbe Ausdehnung der Krone (Modell-Einheiten). */
  canopy: [number, number, number];
  canopyHalf: [number, number, number];
  /** Tiere: Gelenke (vorn) der Vorder- und Hinterbeine, des Halses (vorn, oben), halbe Breite. */
  legs: [number, number];
  neck: [number, number];
  /** Tiere: so weit (Radiant) senkt sich der Kopf beim Äsen - bis das Maul am Boden ist. */
  graze: number;
  side: number;
  /** Höchster Punkt in Modell-Einheiten - dort sitzt der Lebensbalken. */
  top: number;
  /** Eingang (Modell-Einheiten: vorn, links), falls das Modell ihn markiert. */
  entry?: [number, number];
  /** Waffenkammer: so viele Bögen passen sichtbar hinein (Objekte "Stock.<n>"). */
  stockSlots: number;
  /** Werkstatt: wo der Arbeiter steht und wohin er schaut (Modell-Einheiten: vorn, links). */
  work?: { stand: [number, number]; aim: [number, number] };
  /** Figuren: Mitte der rechten Hand in Ruhelage (Modell-Einheiten) - dort hängen Werkzeuge. */
  hand: [number, number, number];
  /** Breite bzw. Höhe in Datei-Einheiten (Metern), auf die das Modell gebracht ist. */
  meters: number;
  /** Die Datei in src/models (house.glb) - für die Galerie. */
  file?: string;
}

/** Datei eines Modells aus seiner Zeile `mtllib house.mtl` (vite.config.ts). */
function modelFile(obj: string): string | undefined {
  const name = /^mtllib (.+)\.mtl$/m.exec(obj)?.[1];
  return name && name !== 'model' ? `${name}.glb` : undefined;
}

/** Nummer einer Beere aus ihrem Objektnamen ("Berry.12.Shine" -> 12). */
/** Stufe eines Werkstücks ("Craft.2.Grip": 2), siehe P_CRAFT. */
function craftStage(object: string): number {
  return Number(/^Craft\.(\d+)/.exec(object)?.[1] ?? 0);
}

/** Nummer eines Bogens im Vorrat ("Stock.7.Grip": 7), siehe P_STOCK. */
function stockNumber(object: string): number {
  return Number(/^Stock\.(\d+)/.exec(object)?.[1] ?? 0);
}

function berryNumber(object: string): number {
  return Number(/^Berry\.(\d+)/.exec(object)?.[1] ?? 0);
}

/**
 * Furche und Lage darin aus dem Objektnamen einer Feldpflanze oder eines
 * Stücks Erde ("Crop.3.5.14": Furche 3, Pflanze 5 von 14), siehe P_CROP.
 */
function furrowValue(object: string): number {
  const m = /^(?:Crop|Soil)\.(\d+)\.(\d+)\.(\d+)/.exec(object);
  return m ? Number(m[1]) * 0.04 + (Number(m[2]) / Number(m[3])) * 0.039 : 0;
}

/** Tile und Seite einer Schnur am Feldrand ("Edge.4.2": Tile 4, Seite 2), siehe P_EDGE. */
function edgeValue(object: string): number {
  const m = /^Edge\.(\d+)\.(\d+)/.exec(object);
  return m ? Number(m[1]) * 0.04 + Number(m[2]) * 0.009 : 0;
}

/**
 * Achsen einer Blattkarte aus ihren Eckpunkten: Mitte, Längsachse a (zeigt
 * nach unten, v = 0 am oberen Ende), Querachse b, Wertebereiche und ein Zufall.
 */
function frameOf(points: number[][], index: number) {
  const n = points.length;
  const c = [0, 1, 2].map((i) => points.reduce((sum, p) => sum + p[i], 0) / n);
  const cov = [0, 1, 2].map((i) => [0, 1, 2].map((j) => points.reduce((sum, p) => sum + (p[i] - c[i]) * (p[j] - c[j]), 0)));
  const mul = (v: number[]) => cov.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
  const norm = (v: number[]) => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return v.map((x) => x / l);
  };
  // Größte Hauptachse durch wiederholtes Multiplizieren, die zweite ebenso
  // nach Abzug der ersten.
  let a = norm([0.3, 0.1, 1]);
  for (let i = 0; i < 30; i++) a = norm(mul(a));
  let b = norm([1, 0.2, 0.1]);
  for (let i = 0; i < 30; i++) {
    const m = mul(b);
    const d = m[0] * a[0] + m[1] * a[1] + m[2] * a[2];
    b = norm([m[0] - d * a[0], m[1] - d * a[1], m[2] - d * a[2]]);
  }
  // v ist die senkrechtere der beiden Achsen und wächst nach unten; u zeigt
  // vom Stamm weg (Astkarten beginnen am Stamm, bei x = y = 0).
  if (Math.abs(b[2]) > Math.abs(a[2])) [a, b] = [b, a];
  if (a[2] > 0) a = a.map((x) => -x);
  if (b[0] * c[0] + b[1] * c[1] < 0) b = b.map((x) => -x);
  const proj = (axis: number[]) => points.map((p) => (p[0] - c[0]) * axis[0] + (p[1] - c[1]) * axis[1] + (p[2] - c[2]) * axis[2]);
  const pa = proj(a), pb = proj(b);
  const a0 = Math.min(...pa), b0 = Math.min(...pb);
  return {
    c, a, b, a0, b0,
    aLen: Math.max(1e-6, Math.max(...pa) - a0),
    bLen: Math.max(1e-6, Math.max(...pb) - b0),
    seed: berryRandom(index + 1000),
  };
}

/** Fester Zufall 0..1 je Beeren-Nummer - welche Beere zuerst gepflückt wird. */
function berryRandom(index: number): number {
  let h = Math.imul(index + 1, 2654435761);
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

/**
 * Baut ein Mesh aus einem OBJ, wie Blender es exportiert: Meter, Y oben,
 * Vorderseite nach +Z, links auf +X. Die Größe in der Datei spielt keine
 * Rolle: Figuren werden auf Körperhöhe 1 gebracht, Gebäude auf Breite 1 -
 * gemessen an den feststehenden Teilen, damit ausladende Flügel nicht
 * mitzählen. Der Boden liegt danach bei 0. Blender hängt beim Export manchmal
 * den Mesh-Namen an ("Leg.L_Cube.003"), darum zählt der Anfang des Namens.
 */
function loadModel(obj: string | ObjTriangle[], mtl: string, unit: 'height' | 'width' | 'meters', lod = false, sawable = false,
                   only?: ObjTriangle[]): Model {
  // Die Objekte "Entry" (Eingang) und "Work.*" (Platz an der Werkbank)
  // markieren nur Stellen - nicht zeichnen, nicht mitmessen.
  const all = typeof obj === 'string' ? parseObj(obj) : obj;
  const isMarker = (object: string) => object.startsWith('Entry') || object.startsWith('Work.');
  const markerPoints = (prefix: string) => all.filter((t) => t.object.startsWith(prefix)).flatMap((t) => t.points);
  const entryPoints = markerPoints('Entry');
  const triangles = all.filter((t) => !isMarker(t.object));
  const colors = parseMtl(mtl);
  const images = parseMtlImages(mtl);
  if (triangles.length === 0) throw new Error('Figuren-Modell ist leer');

  let minY = Infinity;
  let maxY = -Infinity;
  for (const t of triangles) {
    for (const p of t.points) {
      minY = Math.min(minY, p[1]);
      maxY = Math.max(maxY, p[1]);
    }
  }
  const partOf = (object: string) => PARTS.find(([prefix]) => object.startsWith(prefix))?.[1] ?? 0;
  // Plätze für Bögen im Vorrat (Waffenkammer): die höchste Nummer + 1.
  const stockSlots = triangles.reduce((n, t) => (t.object.startsWith('Stock') ? Math.max(n, stockNumber(t.object) + 1) : n), 0);

  let unitLength = maxY - minY;
  // Anhänge: in Metern, wie sie sind - der Shader bringt sie auf den Körper.
  if (unit === 'meters') {
    unitLength = 1;
    minY = 0;
  }
  if (unit === 'width') {
    let minX = Infinity;
    let maxX = -Infinity;
    for (const t of triangles) {
      // Dach und Wände der Waffenkammer stehen still und zählen mit.
      const part = partOf(t.object);
      if (part !== 0 && part !== 28 && part !== 30) continue;
      for (const p of t.points) {
        minX = Math.min(minX, p[0]);
        maxX = Math.max(maxX, p[0]);
      }
    }
    unitLength = maxX - minX;
  }

  // Datei (x links, y oben, z vorn) -> Modell (x vorn, y links, z oben)
  const local = (p: [number, number, number]) =>
    [p[2] / unitLength, p[0] / unitLength, (p[1] - minY) / unitLength] as const;

  // Figuren: Mitte der rechten Hand in Ruhelage - dort hängen Werkzeuge (uSocket).
  // Der Mittelwert der Eckpunkte des Objekts (so wurden die Werkzeuge an die Hand gesetzt).
  const handPoints = new Map<string, readonly [number, number, number]>();
  for (const t of triangles) {
    if (t.object.startsWith('Arm.R.Lower.Hand')) for (const p of t.points) handPoints.set(p.join(), local(p));
  }
  const hand = [...handPoints.values()].reduce<[number, number, number]>(
    (s, q) => [s[0] + q[0] / handPoints.size, s[1] + q[1] / handPoints.size, s[2] + q[2] / handPoints.size], [0, 0, 0]);

  // Größe jedes Teils (größte Ausdehnung in Modell-Einheiten) - für die
  // vereinfachten Fassungen.
  const extent = new Map<number, number>();
  // Bäume: wie hoch jedes Teil ansetzt (0 = Boden, 1 = Spitze), siehe P_CROWN.
  const bottom = new Map<number, number>();
  if (lod || sawable) {
    const box = new Map<number, number[]>();
    for (const t of triangles) {
      const b = box.get(t.index) ?? [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (const p of t.points) {
        for (let i = 0; i < 3; i++) {
          b[i] = Math.min(b[i], p[i]);
          b[i + 3] = Math.max(b[i + 3], p[i]);
        }
      }
      box.set(t.index, b);
    }
    for (const [i, b] of box) {
      extent.set(i, Math.max(b[3] - b[0], b[4] - b[1], b[5] - b[2]) / unitLength);
      bottom.set(i, (b[1] - minY) / (maxY - minY));
    }
  }
  const lods: number[][] = LOD_PARTS.map(() => []);

  const v: number[] = [];
  let hip = 0;
  let shoulder = 0;
  let knee = 0;
  let elbow = 0;
  const forearm = [Infinity, 0];
  let stump = 0;
  const load = { back: -Infinity, y: [Infinity, -Infinity], z: [Infinity, -Infinity] };
  const crown = { lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity] };
  const legSum = [0, 0];
  const legCount = [0, 0];
  let neck: [number, number] = [0, Infinity];
  /** Vorderster Punkt von Kopf und Hals - das Maul. */
  let mouth: [number, number] = [-Infinity, 0];
  let side = 0;
  const sails = { y: [Infinity, -Infinity], z: [Infinity, -Infinity] };
  const cloth = { y: [Infinity, -Infinity], z: [Infinity, -Infinity] };

  // Bäume: Oberkante des Stumpfs in Datei-Einheiten - dort liegen die beiden
  // Schnittflächen (Deckel des Stumpfs, Boden des Stamms), siehe P_STUMP.
  let stumpTop = -Infinity;
  let stumpRadius = 0;
  if (sawable) {
    for (const t of triangles) {
      if (!t.object.startsWith('Trunk.Stump')) continue;
      for (const q of t.points) {
        stumpTop = Math.max(stumpTop, q[1]);
        stumpRadius = Math.max(stumpRadius, Math.hypot(q[0], q[2]) / unitLength);
      }
    }
  }
  const onCut = (t: ObjTriangle) => t.points.every((q) => Math.abs(q[1] - stumpTop) < 1e-3);

  // Bäume: die Stammstücke (außer dem Stumpf) zeigen mit ihrer Vorderseite
  // nach außen - beim Absägen sieht man durch den Schnitt ihre Rückseite und
  // malt dort die Schnittfläche (siehe vCut). Je Stück: zeigen die Flächen im
  // Ganzen nach innen (Fluss durch die Hülle, von ihrer Mitte aus gemessen),
  // werden sie umgedreht.
  const isLog = (t: ObjTriangle) => sawable && t.object.startsWith('Trunk') && !t.object.startsWith('Trunk.Stump');
  const inward = new Set<number>();
  if (sawable) {
    const sums = new Map<number, number[]>();
    for (const t of triangles) {
      if (!isLog(t)) continue;
      const c = sums.get(t.index) ?? [0, 0, 0, 0];
      for (const q of t.points) for (let i = 0; i < 3; i++) c[i] += q[i];
      c[3] += 3;
      sums.set(t.index, c);
    }
    const flux = new Map<number, number>();
    for (const t of triangles) {
      if (!isLog(t)) continue;
      const c = sums.get(t.index)!;
      const [a, b, d] = t.points;
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const w = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
      const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      const m = [0, 1, 2].map((i) => (a[i] + b[i] + d[i]) / 3 - c[i] / c[3]);
      flux.set(t.index, (flux.get(t.index) ?? 0) + m[0] * n[0] + m[1] * n[1] + m[2] * n[2]);
    }
    for (const [index, f] of flux) if (f < 0) inward.add(index);
  }

  // Blattkarten: je Karte (Objekt) ihre Achsen - die längste Richtung ist v
  // (0 oben, wo sie am Ast hängt), die zweitlängste u. Gefunden über die
  // Hauptachsen ihrer Eckpunkte; die Karte liegt ja beliebig im Raum.
  const cardPoints = new Map<number, number[][]>();
  for (const t of triangles) {
    if (!CARD_MATERIALS.has(t.material)) continue;
    const list = cardPoints.get(t.index) ?? [];
    for (const p of t.points) list.push([...local(p)]);
    cardPoints.set(t.index, list);
  }
  const cardFrames = new Map<number, ReturnType<typeof frameOf>>();
  const cardFrame = (index: number) => {
    let f = cardFrames.get(index);
    if (!f) {
      f = frameOf(cardPoints.get(index) ?? [[0, 0, 0]], index);
      cardFrames.set(index, f);
    }
    return f;
  };

  // Nur ein Teil des Modells (eine Furche eines Felds) - gemessen am ganzen.
  for (const t of only ?? triangles) {
    const part = partOf(t.object);
    const color = colors.get(t.material) ?? [0.6, 0.6, 0.6];
    const role = MATERIAL_ROLE[t.material] ?? 0;
    // Blattkarte: statt einer Farbe ihre Lage auf der Karte (u, v) und ein
    // Zufall je Karte - der Shader malt Zweig und Blätter danach.
    const card = CARD_MATERIALS.has(t.material) ? cardFrame(t.index) : undefined;
    // Bildtextur: statt der Farbe (u, v, Schicht), eingefärbt wird beim Hochladen.
    const image = images.get(t.material);
    const layer = image && t.uvs ? imageLayer(image, color) : undefined;
    const vertexRole = layer === undefined ? role : IMAGE_ROLE;
    for (const k of inward.has(t.index) && isLog(t) ? [0, 2, 1] : [0, 1, 2]) {
      const p = t.points[k];
      const [x, y, z] = local(p);
      let rgb = color;
      if (layer !== undefined) rgb = [t.uvs![k][0], t.uvs![k][1], layer];
      if (card) {
        const d = [x - card.c[0], y - card.c[1], z - card.c[2]];
        const along = d[0] * card.a[0] + d[1] * card.a[1] + d[2] * card.a[2];
        const across = d[0] * card.b[0] + d[1] * card.b[1] + d[2] * card.b[2];
        rgb = [(across - card.b0) / card.bLen, (along - card.a0) / card.aLen, card.seed];
      }
      // Beeren: je Beere (Objekt) ein fester Zufall im Nachkomma-Teil, siehe P_BERRY.
      const partValue = part === 14 ? 14 + berryRandom(berryNumber(t.object)) * 0.45
        // Bögen im Vorrat: ihre Reihenfolge, die Mitte ihres Anteils.
        : part === 29 ? 29 + ((stockNumber(t.object) + 0.5) / stockSlots) * 0.45
        // Werkstück: seine Stufe, die Mitte ihres Anteils.
        : part === 32 ? 32 + ((craftStage(t.object) + 0.5) / CRAFT_STAGES) * 0.45
        // Feldpflanzen: ihre Reihenfolge beim Ernten, siehe P_CROP.
        : part === 20 || part === 21 ? part + furrowValue(t.object)
        // Schnur an einer Tile-Kante, siehe P_EDGE.
        : part === 22 ? 22 + edgeValue(t.object)
        // Bäume: alles außer dem Stamm verschwindet beim Absägen als Ganzes.
        : sawable && !t.object.startsWith('Trunk') ? 15 + (bottom.get(t.index) ?? 0) * 0.45
        // Stumpf (16), sein Deckel (17), der Boden des Stamms (18).
        : sawable && t.object.startsWith('Trunk.Stump') ? (onCut(t) ? 17 : 16)
        : sawable && onCut(t) ? 18
        // Stammstück (19 + Ansatzhöhe): über dem Schnitt verschwindet es ganz.
        : sawable ? 19 + (bottom.get(t.index) ?? 0) * 0.45
        : part;
      v.push(x, y, z, partValue, rgb[0], rgb[1], rgb[2], vertexRole);
      if (lod) {
        LOD_PARTS.forEach((min, i) => {
          // Stammstücke bleiben immer - sie sind kurz, der Stamm aber nicht.
          // Stammstücke bleiben immer - sie sind kurz, der Stamm aber nicht.
          // Blattkarten auch: ohne sie stünde die Birke weit draußen kahl da.
          if ((extent.get(t.index) ?? 1) >= min || t.object.startsWith('Trunk') || card) lods[i].push(x, y, z, partValue, rgb[0], rgb[1], rgb[2], vertexRole);
        });
      }
      // Hüfte und Schulter sitzen an der Oberkante von Beinen und Armen.
      if (part === 1 || part === 2 || (part >= 24 && part <= 27)) hip = Math.max(hip, z);
      if (part >= 24 && part <= 27) {
        const i = part <= 25 ? 0 : 1;
        legSum[i] += x;
        legCount[i]++;
      }
      // Halsansatz: der tiefste Punkt von Kopf und Hals, hinten.
      if (part === 5 && (z < neck[1] || (z === neck[1] && x < neck[0]))) neck = [x, z];
      if (part === 5 && (x > mouth[0] || (x === mouth[0] && z < mouth[1]))) mouth = [x, z];
      if (part === 0) side = Math.max(side, Math.abs(y));
      if (FOLIAGE_MATERIALS.has(t.material)) {
        [x, y, z].forEach((c, i) => {
          crown.lo[i] = Math.min(crown.lo[i], c);
          crown.hi[i] = Math.max(crown.hi[i], c);
        });
      }
      if (part === 3 || part === 4) shoulder = Math.max(shoulder, z);
      // Knie und Ellbogen an der Oberkante von Unterschenkel und Unterarm.
      if (part === 9 || part === 10) knee = Math.max(knee, z);
      if (part === 11 || part === 12) {
        elbow = Math.max(elbow, z);
        forearm[0] = Math.min(forearm[0], Math.abs(y));
        forearm[1] = Math.max(forearm[1], Math.abs(y));
      }
      if (t.object.startsWith('Trunk.Stump')) stump = Math.max(stump, z);
      if (part === 6) {
        // Die Last hängt mit ihrer Vorderseite am Rücken.
        load.back = Math.max(load.back, x);
        load.y = [Math.min(load.y[0], y), Math.max(load.y[1], y)];
        load.z = [Math.min(load.z[0], z), Math.max(load.z[1], z)];
      }
      if (part === 8) {
        cloth.y = [Math.min(cloth.y[0], y), Math.max(cloth.y[1], y)];
        cloth.z = [Math.min(cloth.z[0], z), Math.max(cloth.z[1], z)];
      }
      if (part === 7) {
        sails.y = [Math.min(sails.y[0], y), Math.max(sails.y[1], y)];
        sails.z = [Math.min(sails.z[0], z), Math.max(sails.z[1], z)];
      }
    }
  }

  // Mitte einer Markierung (Modell-Einheiten: vorn, links).
  const markerAt = (points: [number, number, number][]): [number, number] | undefined => {
    if (points.length === 0) return undefined;
    const c = local(points.reduce((a, p) => [a[0] + p[0], a[1] + p[1], a[2] + p[2]], [0, 0, 0])
      .map((v) => v / points.length) as [number, number, number]);
    return [c[0], c[1]];
  };
  const stand = markerAt(markerPoints('Work.Stand'));
  const aim = markerAt(markerPoints('Work.Aim'));
  return {
    file: typeof obj === 'string' ? modelFile(obj) : undefined,
    entry: markerAt(entryPoints),
    work: stand && aim && { stand, aim },
    stockSlots,
    vertices: new Float32Array(v),
    lods: lod ? lods.map((l) => new Float32Array(l)) : undefined,
    hip,
    shoulder,
    knee,
    elbow,
    arm: Number.isFinite(forearm[0]) ? (forearm[0] + forearm[1]) / 2 : 0,
    stump,
    stumpRadius,
    loadAnchor: Number.isFinite(load.back)
      ? [load.back, (load.y[0] + load.y[1]) / 2, (load.z[0] + load.z[1]) / 2]
      : [0, 0, 0],
    hub: [(sails.y[0] + sails.y[1]) / 2, (sails.z[0] + sails.z[1]) / 2],
    cloth: Number.isFinite(cloth.y[0]) ? [cloth.y[0], cloth.y[1], (cloth.z[0] + cloth.z[1]) / 2] : [0, 1, 0],
    canopy: Number.isFinite(crown.lo[0]) ? crown.lo.map((l, i) => (l + crown.hi[i]) / 2) as [number, number, number] : [0, 0, 0.5],
    canopyHalf: Number.isFinite(crown.lo[0]) ? crown.lo.map((l, i) => (crown.hi[i] - l) / 2) as [number, number, number] : [0.5, 0.5, 0.5],
    legs: [legSum[0] / Math.max(1, legCount[0]), legSum[1] / Math.max(1, legCount[1])],
    neck: Number.isFinite(neck[1]) ? neck : [0, 0],
    graze: Number.isFinite(neck[1]) && Number.isFinite(mouth[0]) ? grazeAngle(neck, mouth) : 0,
    side,
    top: (maxY - minY) / unitLength,
    meters: unitLength,
    hand,
  };
}

/**
 * Winkel, um den sich der Kopf um den Halsansatz drehen muss, damit das Maul
 * (knapp über) den Boden erreicht. Kurze Hälse (Wildschwein) brauchen weniger
 * als lange (Reh, Kuh) - ein fester Winkel ließe den Kopf sonst nach hinten
 * vor den Körper klappen. Höchstens 1.45 - so weit senken Reh und Kuh den Kopf.
 */
function grazeAngle(neck: [number, number], mouth: [number, number]): number {
  const dx = mouth[0] - neck[0];
  const dz = mouth[1] - neck[1];
  const length = Math.hypot(dx, dz);
  const ground = 0.03;
  const reach = (ground - neck[1]) / length;
  const angle = Math.atan2(dz, dx) - (reach <= -1 ? -Math.PI / 2 : Math.asin(reach));
  return Math.min(1.45, Math.max(0.2, angle));
}

/**
 * Vereinfachte Fassungen der Vorkommen: Teile kleiner als dieser Anteil der
 * Modellbreite fallen weg - unter LOD_ZOOM[0] CSS-Pixeln je Tile die erste,
 * unter LOD_ZOOM[1] die zweite. Ein Wald hat Tausende Bäume, und weit draußen
 * sind Beeren und Blattbüschel ohnehin kleiner als ein Pixel.
 */
const LOD_PARTS = [0.12, 0.45];
const LOD_ZOOM = [32, 12];
/**
 * Felder wechseln früher: Tausende Halme lohnen sich nur ganz nah; schon ab
 * 32 CSS-Pixeln je Tile reicht die Fassung mit weniger (FIELD_DETAIL).
 */
const FIELD_LOD_ZOOM = [48, 24];

/**
 * Bäume und Sträucher in Metern: so breit ist einer der Instanzgröße 1.
 * Eine schmale Pappel wird so nicht auf die Breite einer Eiche aufgeblasen.
 */
const TREE_METERS = 3;
const BUSH_METERS = 2.25;
const STONE_METERS = 3;
const GOLD_METERS = 2.8;

/**
 * Ein Feld als eine Form je Furche: jede enthält nur deren Pflanzen und Erde
 * (die Pflöcke gehören zur ersten). Gezeichnet wird so je Furche nur, was
 * zu ihr gehört - ein Weizenfeld hat Tausende Halme.
 */
function fieldModels(kind: (typeof FARM_KINDS)[number], base: number) {
  // Die volle Fassung und zwei einfachere fürs Herauszoomen (LOD_ZOOM) - mit
  // weniger Halmen, die man von weit weg ohnehin nicht einzeln sieht.
  // Je Fassung einmal nach Furchen aufgeteilt (Pflöcke und Schnur zur ersten).
  const versions = FIELD_DETAIL.map((detail) => {
    const { obj, mtl } = farmModel(kind, detail, FIELD_PART_MODELS);
    const triangles = parseObj(obj);
    const rows: ObjTriangle[][] = Array.from({ length: FIELD_FURROWS }, () => []);
    for (const t of triangles) {
      const m = /^(?:Crop|Soil)\.(\d+)\./.exec(t.object);
      rows[m ? Number(m[1]) : 0].push(t);
    }
    return { triangles, rows, mtl };
  });
  return Array.from({ length: FIELD_FURROWS }, (_, row) => {
    const [model, ...simpler] = versions.map((v) => loadModel(v.triangles, v.mtl, 'width', false, false, v.rows[row]));
    model.lods = simpler.map((m) => m.vertices);
    return { shape: base + row, model, scale: 1 };
  });
}

/** Wie viele Pflanzen die Fassungen eines Felds zeigen: voll, dann für die beiden LOD-Stufen. */
const FIELD_DETAIL = [1, 0.3, 0.1];

/** Ein Vorkommen: mit vereinfachten Fassungen, in seiner echten Breite. */
function natural(shape: number, obj: string, mtl: string, meters: number) {
  const all = parseObj(obj);
  // Gras und Laub am Fuß der Bäume zählen für die Breite mit (und damit für
  // die Größe), gezeichnet werden sie nicht - nur Stamm, Stumpf und Wurzeln.
  const drawn = TREES.includes(shape) ? all.filter((t) => !/^(Grass|Litter)(\.|$)/.test(t.object)) : undefined;
  const model = loadModel(all, mtl, 'width', true, TREES.includes(shape), drawn);
  model.file = modelFile(obj);
  return [{ shape, model, scale: model.meters / meters }];
}

/**
 * Formen, die aus Modell-Dateien kommen. `scale`: Tiles je Einheit der
 * Instanzgröße - eine Figur der Größe 0.55 ist 0.55 * 1.7 Tiles hoch.
 */
const PROP_AXE = loadModel(propAxeModel.obj, villagerMtl, 'meters');
const FLOWER_MODEL = (() => {
  const { obj, mtl } = flowerModel();
  return loadModel(obj, mtl, 'width', true);
})();
const PROP_KNIFE = loadModel(propKnifeModel.obj, villagerMtl, 'meters');

const MODELS: {
  shape: number; model: Model; scale: number; stride?: number;
  /** Anhang: der Körper, dessen Gelenke, Clips und Hand es beim Zeichnen nutzt. */
  body?: number;
}[] = [
  { shape: SHAPE.villager, model: loadModel(villagerMaleModel.obj, villagerMtl, 'height'), scale: 1.7 },
  // Kürzere Schritte, sonst treten die Beine hinten aus dem langen Rock.
  { shape: SHAPE.villagerFemale, model: loadModel(villagerFemaleModel.obj, villagerMtl, 'height'), scale: 1.7, stride: 0.6 },
  // Werkzeuge als Anhänge: Beil und Zugmesser einmal für beide Körper, die
  // Sense je Körper (ihr Stiel liegt in der Mäh-Haltung in beiden Händen).
  { shape: SHAPE.propAxe, model: PROP_AXE, scale: 1.7, body: SHAPE.villager },
  { shape: SHAPE.propAxeFemale, model: PROP_AXE, scale: 1.7, body: SHAPE.villagerFemale },
  { shape: SHAPE.propKnife, model: PROP_KNIFE, scale: 1.7, body: SHAPE.villager },
  { shape: SHAPE.propKnifeFemale, model: PROP_KNIFE, scale: 1.7, body: SHAPE.villagerFemale },
  { shape: SHAPE.propScythe, model: loadModel(propScytheMaleModel.obj, villagerMtl, 'meters'), scale: 1.7, body: SHAPE.villager },
  { shape: SHAPE.propScytheFemale, model: loadModel(propScytheFemaleModel.obj, villagerMtl, 'meters'), scale: 1.7, body: SHAPE.villagerFemale },
  { shape: SHAPE.mill, model: loadModel(millModel.obj, millModel.mtl, 'width'), scale: 1 },
  { shape: SHAPE.mill2, model: loadModel(mill2Model.obj, mill2Model.mtl, 'width'), scale: 1 },
  { shape: SHAPE.mill3, model: loadModel(mill3Model.obj, mill3Model.mtl, 'width'), scale: 1 },
  { shape: SHAPE.mill4, model: loadModel(mill4Model.obj, mill4Model.mtl, 'width'), scale: 1 },
  { shape: SHAPE.lumberCamp, model: loadModel(lumberCampModel.obj, lumberCampModel.mtl, 'width'), scale: 1 },
  { shape: SHAPE.lumberCamp2, model: loadModel(lumberCamp2Model.obj, lumberCamp2Model.mtl, 'width'), scale: 1 },
  { shape: SHAPE.lumberCamp3, model: loadModel(lumberCamp3Model.obj, lumberCamp3Model.mtl, 'width'), scale: 1 },
  { shape: SHAPE.lumberCamp4, model: loadModel(lumberCamp4Model.obj, lumberCamp4Model.mtl, 'width'), scale: 1 },
  { shape: SHAPE.house, model: loadModel(houseModel.obj, houseModel.mtl, 'width'), scale: 1 },
  { shape: SHAPE.house2, model: loadModel(house2Model.obj, house2Model.mtl, 'width'), scale: 1 },
  { shape: SHAPE.house3, model: loadModel(house3Model.obj, house3Model.mtl, 'width'), scale: 1 },
  { shape: SHAPE.house4, model: loadModel(house4Model.obj, house4Model.mtl, 'width'), scale: 1 },
  { shape: SHAPE.townCenter, model: loadModel(townCenterModel.obj, townCenterModel.mtl, 'width'), scale: 1 },
  { shape: SHAPE.miningCamp, model: loadModel(miningCampModel.obj, miningCampModel.mtl, 'width'), scale: 1 },
  { shape: SHAPE.bowyer, model: loadModel(bowyerModel.obj, bowyerModel.mtl, 'width'), scale: 1 },
  { shape: SHAPE.bow, model: loadModel(bowModel.obj, bowModel.mtl, 'height'), scale: 1 },
  { shape: SHAPE.armory, model: loadModel(armoryModel.obj, armoryModel.mtl, 'width'), scale: 1 },
  { shape: SHAPE.markerArrow, model: loadModel(markerArrowModel.obj, markerArrowModel.mtl, 'height'), scale: 1 },
  ...FARM_KINDS.flatMap((kind, i) => fieldModels(kind, FIELD_BASES[i])),
  ...natural(SHAPE.tree, treeSpruceModel.obj, treeSpruceModel.mtl, TREE_METERS),
  ...natural(SHAPE.treePine, treePineModel.obj, treePineModel.mtl, TREE_METERS),
  ...natural(SHAPE.treeOak, treeOakModel.obj, treeOakModel.mtl, TREE_METERS),
  ...natural(SHAPE.treeBirch, treeBirchModel.obj, treeBirchModel.mtl, TREE_METERS),
  ...natural(SHAPE.treeBirch2, treeBirch2Model.obj, treeBirch2Model.mtl, TREE_METERS),
  ...natural(SHAPE.treeBirch3, treeBirch3Model.obj, treeBirch3Model.mtl, TREE_METERS),
  ...natural(SHAPE.treePoplar, treePoplarModel.obj, treePoplarModel.mtl, TREE_METERS),
  ...natural(SHAPE.treeMaple, treeMapleModel.obj, treeMapleModel.mtl, TREE_METERS),
  ...natural(SHAPE.treeOakOld, treeOakOldModel.obj, treeOakOldModel.mtl, TREE_METERS),
  ...natural(SHAPE.treeOakYoung, treeOakYoungModel.obj, treeOakYoungModel.mtl, TREE_METERS),
  ...natural(SHAPE.stoneRock, stone1Model.obj, stone1Model.mtl, STONE_METERS),
  ...natural(SHAPE.stoneRock2, stone2Model.obj, stone2Model.mtl, STONE_METERS),
  ...natural(SHAPE.stoneRock3, stone3Model.obj, stone3Model.mtl, STONE_METERS),
  ...natural(SHAPE.goldRock, gold1Model.obj, gold1Model.mtl, GOLD_METERS),
  ...natural(SHAPE.goldRock2, gold2Model.obj, gold2Model.mtl, GOLD_METERS),
  ...natural(SHAPE.goldRock3, gold3Model.obj, gold3Model.mtl, GOLD_METERS),
  // Blumen: ein Modell für alle Arten, die Blüte malt der Shader je Form.
  // In Breite 1 gebaut - die Instanzgröße ist ihre Breite in Tiles.
  ...FLOWERS.map((shape) => ({ shape, model: FLOWER_MODEL, scale: 1 })),
  ...natural(SHAPE.berryBush, berryBush1Model.obj, berryBush1Model.mtl, BUSH_METERS),
  ...natural(SHAPE.berryBush2, berryBush2Model.obj, berryBush2Model.mtl, BUSH_METERS),
  ...natural(SHAPE.berryBush3, berryBush3Model.obj, berryBush3Model.mtl, BUSH_METERS),
  ...natural(SHAPE.berryBush4, berryBush4Model.obj, berryBush4Model.mtl, BUSH_METERS),
  // Nach Höhe gemessen: das Tuch bewegt sich und zählt nicht zur Breite,
  // der Mast allein wäre als Maßstab viel zu schmal.
  { shape: SHAPE.rallyFlag, model: loadModel(rallyFlagModel.obj, rallyFlagModel.mtl, 'height'), scale: 1 },
  // Tiere: auf Höhe 1 gebracht - die Instanzgröße ist ihre Höhe in Tiles.
  { shape: SHAPE.deer, model: loadModel(deerModel.obj, deerModel.mtl, 'height'), scale: 1 },
  { shape: SHAPE.hare, model: loadModel(hareModel.obj, hareModel.mtl, 'height'), scale: 1 },
  { shape: SHAPE.cow, model: loadModel(cowModel.obj, cowModel.mtl, 'height'), scale: 1 },
  { shape: SHAPE.sheep, model: loadModel(sheepModel.obj, sheepModel.mtl, 'height'), scale: 1 },
  { shape: SHAPE.goat, model: loadModel(goatModel.obj, goatModel.mtl, 'height'), scale: 1 },
  { shape: SHAPE.boar, model: loadModel(boarModel.obj, boarModel.mtl, 'height'), scale: 1 },
];

/**
 * Halber Handabstand (Meter), für den das Zugmesser gebaut ist - der des
 * Mannes (prop_knife.blend). Andere Körper strecken es auf ihren.
 */
const KNIFE_HALF_SPAN = (() => {
  const man = MODELS.find((m) => m.shape === SHAPE.villager)!.model;
  return Math.abs(man.hand[1]) * man.meters;
})();

/** Anhänge der Dorfbewohner: Bit in den props eines Clips (PROP_BITS) → Form je Körper. */
const FIGURE_PROPS: { bit: number; shapes: Record<number, number> }[] = [
  { bit: PROP_BITS.axe, shapes: { [SHAPE.villager]: SHAPE.propAxe, [SHAPE.villagerFemale]: SHAPE.propAxeFemale } },
  { bit: PROP_BITS.scythe, shapes: { [SHAPE.villager]: SHAPE.propScythe, [SHAPE.villagerFemale]: SHAPE.propScytheFemale } },
  { bit: PROP_BITS.knife, shapes: { [SHAPE.villager]: SHAPE.propKnife, [SHAPE.villagerFemale]: SHAPE.propKnifeFemale } },
];

/**
 * Was eine Figur in der Hand hat - Bits aus PROP_BITS: die props des Clips,
 * den ihre Pose spielt (humanoid_clips.json). Ohne Clip keine - die Figur
 * steht in Ruhelage und hat die Werkzeuge weggesteckt.
 */
function propsOfPose(pose: number): number {
  if (pose >= CLIP_POSE) return CLIPS[pose - CLIP_POSE]?.props ?? 0;
  const clip = CLIPS.find((c) => c.pose === pose);
  return clip?.props ?? 0;
}

/**
 * Die Anhänge (Werkzeuge) einer Figur als eigene Instanzen: gleiche Lage,
 * Größe und Bewegung wie die Figur - der Shader hängt sie an ihre Hand.
 * Leer für alles, was keine Figur ist. Wer Figuren zeichnet, zeichnet diese dazu.
 */
export function figureProps(figure: EntityInstance): EntityInstance[] {
  if (figure.shape !== SHAPE.villager && figure.shape !== SHAPE.villagerFemale) return [];
  const bits = propsOfPose(Math.round(figure.motion?.[2] ?? 0));
  return FIGURE_PROPS
    .filter((p) => (bits & p.bit) !== 0)
    .map((p) => ({ ...figure, shape: p.shapes[figure.shape], health: undefined }));
}

/**
 * Eingang eines Gebäudes in der Welt: Mitte (x, y wie EntityInstance, also
 * Tile-Anker), Größe und Blickrichtung wie beim Zeichnen. Undefined, wenn das
 * Modell keinen Eingang markiert.
 */
export function modelEntry(shape: number, x: number, y: number, size: number, heading: number): { x: number; y: number } | undefined {
  const m = MODELS.find((entry) => entry.shape === shape);
  return m?.model.entry && modelToWorld(m, m.model.entry, x, y, size, heading);
}

/**
 * Platz an der Werkbank einer Werkstatt in der Welt: wo der Arbeiter steht
 * und wohin er schaut. Undefined, wenn das Modell ihn nicht markiert.
 */
export function modelWorkSpot(shape: number, x: number, y: number, size: number, heading: number):
    { x: number; y: number; aimX: number; aimY: number } | undefined {
  const m = MODELS.find((entry) => entry.shape === shape);
  if (!m?.model.work) return undefined;
  const stand = modelToWorld(m, m.model.work.stand, x, y, size, heading);
  const aim = modelToWorld(m, m.model.work.aim, x, y, size, heading);
  return { ...stand, aimX: aim.x, aimY: aim.y };
}

/** Wie viele Bögen im Modell sichtbar gestapelt werden können (Waffenkammer), sonst 0. */
export function modelStockSlots(shape: number): number {
  return MODELS.find((entry) => entry.shape === shape)?.model.stockSlots ?? 0;
}

/** Punkt im Modell (vorn, links) in der Welt - wie beim Zeichnen gedreht und skaliert. */
function modelToWorld(m: { scale: number }, [f, l]: [number, number], x: number, y: number, size: number, heading: number) {
  const s = size * m.scale;
  const [fx, fy] = [Math.cos(heading), Math.sin(heading)];
  return { x: x + 0.5 + (fx * f - fy * l) * s, y: y + 0.5 + (fy * f + fx * l) * s };
}

/**
 * Größe eines Modells in Tiles je Einheit der Instanzgröße: Höhe und Breite.
 * Für das Anklicken von Bäumen und Felsen an ihrer Krone statt am Boden.
 */
export function modelSize(shape: number): { height: number; width: number } | undefined {
  const m = MODELS.find((entry) => entry.shape === shape);
  return m && { height: m.model.top * m.scale, width: m.scale };
}

interface Mesh {
  vao: WebGLVertexArrayObject;
  vertices: number;
}

/** Ein Modell auf der Grafikkarte und die Instanzen, die es in diesem Bild zeichnet. */
interface ModelSlot {
  shape: number; model: Model; scale: number; stride?: number; body?: number;
  mesh: Mesh; lodMeshes: Mesh[]; list: EntityInstance[];
}

/**
 * Instanzen, die sich nicht ändern - Bäume, Felsen und Sträucher einer
 * Gegend, an denen niemand arbeitet: einmal gepackt und hochgeladen, danach
 * Bild für Bild nur gezeichnet (world/resources.ts). Je Form ein Abschnitt.
 */
export interface StaticBatch {
  buffer: WebGLBuffer;
  ranges: Map<number, { first: number; count: number }>;
}

/**
 * Bilder der Bäume für weit draußen, je Baumart eine eigene Textur - so passt
 * auch die nächste Zoomstufe in die Grenzen der Grafikkarte. Gilt für eine
 * Blickrichtung und eine Zoomstufe (`key`); eine Baumart wird erst gerendert,
 * wenn sie im Bild vorkommt (BillboardBand.texture).
 */
interface BillboardSet {
  key: string;
  shapes: Map<number, BillboardBand>;
}

/** Bilder einer Baumart: je Drehung (BILLBOARD_HEADINGS) eines, reihenweise in ihrer Textur. */
interface BillboardBand {
  w: number;
  h: number;
  /** Erst gesetzt, wenn die Baumart gerendert ist. */
  texture: WebGLTexture | null;
  /**
   * Lage in der Textur (x, y von unten, w, h), Fuß im Bild (fx, fy von oben
   * links) und daraus Ausschnitt und Lage zum Fuß für den Shader
   * (uBillboardRect/uBillboardBox).
   */
  cells: {
    heading: number; x: number; y: number; w: number; h: number; fx: number; fy: number;
    rect: [number, number, number, number]; box: [number, number, number, number];
  }[];
}

/**
 * Die Bilder zeigen den größten Baum der Karte (world/resources.ts: LOOK.wood
 * 0,6, gestreut um ±20 %) - alle anderen werden daraus nur verkleinert.
 */
const BILLBOARD_TREE_SIZE = 0.6 * 1.2;
/** Farbe der Bäume wie auf der Karte (LOOK.wood). */
const BILLBOARD_TREE_COLOR: [number, number, number] = [42, 97, 52];
/** Breite der Textur mit den Baumbildern; Rand um jedes Bild in Pixeln. */
const BILLBOARD_ATLAS_WIDTH = 2048;
const BILLBOARD_PAD = 3;

/** Name jeder Form aus SHAPE, z. B. "treeOak" - für Dateinamen. */
const SHAPE_NAME: Record<number, string> = Object.fromEntries(Object.entries(SHAPE).map(([name, shape]) => [shape, name]));

/**
 * Nur im Entwicklermodus: die gerenderten Bilder einer Baumart (aus dem
 * gebundenen READ_FRAMEBUFFER) als PNG an den Dev-Server - er legt sie in
 * tools/export/out/billboards/ ab (vite.config.ts), z. B. treeOak_64px_r0.png.
 */
/** Baumbilder als PNG ablegen (vite.config.ts) - nur mit ?saveBillboards in der Adresse. */
const SAVE_BILLBOARDS = typeof location !== 'undefined' && new URLSearchParams(location.search).has('saveBillboards');

function saveBillboard(gl: WebGL2RenderingContext, shape: number, band: BillboardBand, ppt: number) {
  const raw = new Uint8Array(band.w * band.h * 4);
  gl.readPixels(0, 0, band.w, band.h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
  const canvas = document.createElement('canvas');
  canvas.width = band.w;
  canvas.height = band.h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const image = ctx.createImageData(band.w, band.h);
  for (let y = 0; y < band.h; y++) {
    // readPixels zählt von unten; die Farben sind vormultipliziert.
    const from = (band.h - 1 - y) * band.w * 4;
    for (let x = 0; x < band.w * 4; x += 4) {
      const a = raw[from + x + 3];
      for (let c = 0; c < 3; c++) image.data[y * band.w * 4 + x + c] = a ? Math.min(255, Math.round((raw[from + x + c] * 255) / a)) : 0;
      image.data[y * band.w * 4 + x + 3] = a;
    }
  }
  ctx.putImageData(image, 0, 0);
  const name = `${SHAPE_NAME[shape] ?? shape}_${ppt}px_r${viewRotation()}.png`;
  canvas.toBlob((blob) => {
    if (blob) void fetch(`/__billboards/${name}`, { method: 'POST', body: blob });
  });
}

/** Eine Instanz in den Puffer ab Float `o` - STRIDE Floats. */
function packInstance(d: Float32Array, o: number, e: EntityInstance) {
  d[o] = e.x;
  d[o + 1] = e.y;
  d[o + 2] = e.color[0] / 255;
  d[o + 3] = e.color[1] / 255;
  d[o + 4] = e.color[2] / 255;
  d[o + 5] = e.shape;
  d[o + 6] = e.alpha;
  d[o + 7] = e.size;
  const m = e.motion;
  // Ohne Angabe: Gebäude in ihrer Blickrichtung, Felder mit allen Furchen reif.
  const field = !m && FIELDS.includes(e.shape);
  d[o + 8] = m ? m[0] : field ? -1 : buildingHeading(e.shape);
  d[o + 9] = m ? m[1] : field ? 3 : 0;
  d[o + 10] = m ? m[2] : field ? 1 : 0;
  d[o + 11] = m ? m[3] : field ? 511 : 0;
  const a = e.accent ?? e.color;
  d[o + 12] = a[0] / 255;
  d[o + 13] = a[1] / 255;
  d[o + 14] = a[2] / 255;
  d[o + 15] = e.ground ?? GROUND_UNKNOWN;
}

export class EntityRenderer {
  private program: WebGLProgram;
  private building: Mesh;
  private flat: Mesh;
  /** Abtastschritt für die Bodenhöhe - MapRenderer setzt den des Geländegitters. */
  groundStep = 1;
  /** Eingeebnete Flächen unter Gebäuden (siehe world/flatten.ts). */
  flatZones = new Float32Array(MAX_FLAT_ZONES * 4);
  flatCount = 0;
  /** Gebäude mit Sockel in den Boden - ohne Gelände (Galerie) stünden sie auf Stelzen. */
  skirts = true;
  /** Spielerfarbe (0..255) - Felder bekommen sie als Uniform (siehe uPlayerColor). */
  playerColor: [number, number, number] = [64, 160, 72];
  private models: ModelSlot[];
  /** Dieselben Modelle nach Form - je Instanz und Bild einmal nachgeschlagen. */
  private modelByShape = new Map<number, ModelSlot>();
  private instanceBuffer: WebGLBuffer;
  /** Foto eines Birkenblatts für die Blatt- und Astkarten (uLeafTex). */
  private leafTexture: WebGLTexture;
  /** Knochen-Matrizen der Clips, für jede Figur gebacken (uClipTex, siehe clips.ts). */
  private clipTexture: WebGLTexture;
  /** true, sobald das Blattfoto geladen ist - vorher sind Birken nur grün. */
  leafReady = false;
  /** Bildtexturen der Modelle, eine Schicht je MODEL_IMAGES-Eintrag (uModelImages). */
  private imageTexture: WebGLTexture;
  /** So viele davon sind geladen - vorher ist ihre Schicht durchsichtig. */
  private imagesLoaded = 0;
  /**
   * Unter so vielen CSS-Pixeln je Tile zeichnen die Bäume der festen Puffer
   * als Bild statt als Modell (0: nie). Gefällte, angefangene und
   * ausgewählte Bäume bleiben Modelle.
   */
  billboardBelow = 0;
  /** Ob im letzten Bild Bäume als Bild gezeichnet wurden (Entwickler-Infos). */
  billboardsActive = false;
  /** Die Baumbilder der jetzigen Blickrichtung und Zoomstufe - erst gerendert, wenn sie gebraucht werden. */
  private billboardSet: BillboardSet | null = null;
  /** Zeichenfläche, wenn nicht ins Canvas gezeichnet wird (die Baumbilder). */
  private targetSize: { width: number; height: number } | null = null;
  /** Ein Rechteck aus zwei Dreiecken - die Fläche eines Billboards. */
  private quad: Mesh;
  /** Clip-Uniforms je Modell (Form): erste Zeile jedes Clips in clipTexture, Länge, Pose ... */
  private clipUniforms = new Map<number, ClipUniforms>();
  private uniforms = new Map<string, WebGLUniformLocation | null>();
  /** Wird nur vergrößert, nie neu belegt - eine Allokation je Frame wäre Müll. */
  private data = new Float32Array(STRIDE * 256);
  /** Sortierpuffer, ebenfalls wiederverwendet. */
  private flats: EntityInstance[] = [];
  private solids: EntityInstance[] = [];
  private puffs: EntityInstance[] = [];

  constructor(private gl: WebGL2RenderingContext) {
    const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SOURCE);
    const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SOURCE);
    this.program = gl.createProgram()!;
    gl.attachShader(this.program, vertex);
    gl.attachShader(this.program, fragment);
    gl.linkProgram(this.program);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      throw new Error(`Entity-Programm lässt sich nicht linken:\n${gl.getProgramInfoLog(this.program)}`);
    }
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);

    this.instanceBuffer = gl.createBuffer()!;
    this.building = this.createMesh(buildingMesh());
    this.flat = this.createMesh(flatMesh());
    this.quad = this.createMesh(new Float32Array([0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0, 0]));
    this.models = MODELS.map((m) => ({
      ...m,
      mesh: this.createMesh(m.model.vertices, 8),
      lodMeshes: (m.model.lods ?? []).map((l) => this.createMesh(l, 8)),
      list: [],
    }));
    for (const m of this.models) this.modelByShape.set(m.shape, m);

    gl.useProgram(this.program);
    uploadTerrainParams(gl, (name) => this.location(name));
    gl.uniform1i(this.location('uLeafTex'), LEAF_TEXTURE_UNIT);
    gl.uniform1i(this.location('uBillboardTex'), BILLBOARD_TEXTURE_UNIT);
    gl.uniform1i(this.location('uModelImages'), IMAGE_TEXTURE_UNIT);

    // Blatt-Textur: bis das Bild geladen ist, ein einzelnes grünes Pixel.
    this.leafTexture = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0 + LEAF_TEXTURE_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.leafTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([110, 160, 60, 255]));
    gl.activeTexture(gl.TEXTURE0);
    const image = new Image();
    image.onload = () => {
      this.leafReady = true;
      gl.activeTexture(gl.TEXTURE0 + LEAF_TEXTURE_UNIT);
      gl.bindTexture(gl.TEXTURE_2D, this.leafTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.activeTexture(gl.TEXTURE0);
    };
    image.src = birchLeafUrl;

    this.imageTexture = this.loadModelImages();

    this.clipTexture = this.bakeClips();
  }

  /**
   * Die Bildtexturen der Modelle (MODEL_IMAGES) als Schichten einer
   * Array-Textur, je IMAGE_SIZE² Pixel, kachelnd. Die Bilder laden danach;
   * bis dahin ist ihre Schicht leer (durchsichtig).
   */
  private loadModelImages(): WebGLTexture {
    const gl = this.gl;
    const texture = gl.createTexture()!;
    const levels = Math.log2(IMAGE_SIZE) + 1;
    gl.activeTexture(gl.TEXTURE0 + IMAGE_TEXTURE_UNIT);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, levels, gl.RGBA8, IMAGE_SIZE, IMAGE_SIZE, Math.max(1, MODEL_IMAGES.length));
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.activeTexture(gl.TEXTURE0);
    MODEL_IMAGES.forEach(({ url, tint }, layer) => {
      const image = new Image();
      image.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = IMAGE_SIZE;
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        ctx.drawImage(image, 0, 0, IMAGE_SIZE, IMAGE_SIZE);
        const pixels = ctx.getImageData(0, 0, IMAGE_SIZE, IMAGE_SIZE);
        const d = pixels.data;
        for (let i = 0; i < d.length; i += 4) {
          d[i] *= tint[0];
          d[i + 1] *= tint[1];
          d[i + 2] *= tint[2];
        }
        gl.activeTexture(gl.TEXTURE0 + IMAGE_TEXTURE_UNIT);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
        gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, IMAGE_SIZE, IMAGE_SIZE, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
        gl.activeTexture(gl.TEXTURE0);
        this.imagesLoaded++;
      };
      image.src = url;
    });
    return texture;
  }

  /**
   * Backt jeden Clip für jede Figur (Mann, Frau) mit ihren Gelenken in eine
   * Float-Textur: je Bild eine Zeile, je Knochen drei Texel. Setzt die
   * Uniforms, die für alle Figuren gleich sind.
   */
  private bakeClips(): WebGLTexture {
    const gl = this.gl;
    // Ein Bild ist MAX_BONES Knochen breit, gleich für jedes Skelett.
    const width = MAX_BONES * TEXELS_PER_BONE;
    const blocks: { data: Float32Array; bones: number }[] = [];
    let rows = 0;
    for (const library of CLIP_LIBRARIES) {
      const clips = library.clips.slice(0, MAX_CLIPS);
      if (clips.length === 0 || library.rig.bones.length > MAX_BONES) continue;
      for (const m of this.models) {
        if (!library.shapes.includes(m.shape)) continue;
        const u: ClipUniforms = {
          rows: new Int32Array(MAX_CLIPS).fill(-1),
          frames: Int32Array.from(NO_CLIPS.frames), fps: Float32Array.from(NO_CLIPS.fps), props: new Int32Array(MAX_CLIPS),
          poseClip: new Int32Array(8).fill(-1), poseRate: new Float32Array(8), poseShift: new Float32Array(8),
          rate: new Float32Array(MAX_CLIPS).fill(1), shift: new Float32Array(MAX_CLIPS),
        };
        const species = library.species?.[m.shape];
        clips.forEach((clip, i) => {
          // Clips anderer Arten (z. B. das Hoppeln des Hasen) nicht für dieses Tier.
          if (clip.species.length > 0 && (species === undefined || !clip.species.includes(species))) return;
          u.rows[i] = rows;
          u.frames[i] = clip.frames;
          u.fps[i] = clip.fps;
          u.props[i] = clip.props | (clip.kneel ? KNEEL_BIT : 0);
          u.rate[i] = clip.phaseRate;
          u.shift[i] = clip.phaseShift;
          // Welche Pose ein Clip ersetzt, steht im Clip selbst (Custom Property
          // "pose" der Action in Blender). Die Phase (motion[1]) wird zur
          // Clip-Zeit: (Phase - phaseShift) * phaseRate.
          if (clip.pose !== null && clip.pose >= 0 && clip.pose < 8) {
            u.poseClip[clip.pose] = i;
            u.poseRate[clip.pose] = clip.phaseRate;
            u.poseShift[clip.pose] = clip.phaseShift;
          }
          const joints = library.joints ? library.joints(m.model, (shape) => this.models.find((x) => x.shape === shape)?.model) : m.model;
          blocks.push({ data: bakeClip(clip, joints, { stride: m.stride }, library.rig), bones: library.rig.bones.length });
          rows += clip.frames;
        });
        this.clipUniforms.set(m.shape, u);
      }
    }
    // Bilder in Spalten zu CLIP_COLUMN_ROWS nebeneinander (siehe clipTexel im Shader).
    const columns = Math.max(1, Math.ceil(rows / CLIP_COLUMN_ROWS));
    const height = Math.max(1, Math.min(rows, CLIP_COLUMN_ROWS));
    if (columns * width > gl.getParameter(gl.MAX_TEXTURE_SIZE)) {
      console.warn(`Clips: ${rows} Bilder passen nicht in eine Textur - die Figuren stehen still`);
      for (const name of Object.keys(CLIP_LIBRARIES_LOADED)) CLIP_LIBRARIES_LOADED[name] = 0;
      this.clipUniforms.clear();
      rows = 0;
    }
    const data = new Float32Array(columns * width * height * 4);
    let frame = 0;
    for (const block of rows > 0 ? blocks : []) {
      const perFrame = block.bones * TEXELS_PER_BONE * 4;
      for (let f = 0; f < block.data.length / perFrame; f++, frame++) {
        const column = Math.floor(frame / CLIP_COLUMN_ROWS);
        const row = frame % CLIP_COLUMN_ROWS;
        data.set(block.data.subarray(f * perFrame, (f + 1) * perFrame), (row * columns * width + column * width) * 4);
      }
    }
    const texture = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0 + CLIP_TEXTURE_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, columns * width, height, 0, gl.RGBA, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(this.location('uClipTex'), CLIP_TEXTURE_UNIT);
    return texture;
  }

  /** @param components Floats je Eckpunkt: 4 (aCorner) oder 8 (aCorner + aMaterial). */
  private createMesh(vertices: Float32Array, components = 4): Mesh {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, components * 4, 0);
    if (components === 8) {
      gl.enableVertexAttribArray(6);
      gl.vertexAttribPointer(6, 4, gl.FLOAT, false, 32, 16);
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    for (const loc of [1, 2, 3, 4, 5, 7]) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribDivisor(loc, 1);
    }
    gl.bindVertexArray(null);
    return { vao, vertices: vertices.length / components };
  }

  /** Datei des Modells einer Form (tree_oak.glb) - oder keine (Felder, Klötze). */
  modelFile(shape: number): string | undefined {
    return this.modelByShape.get(shape)?.model.file;
  }

  private location(name: string): WebGLUniformLocation | null {
    if (!this.uniforms.has(name)) {
      this.uniforms.set(name, this.gl.getUniformLocation(this.program, name));
    }
    return this.uniforms.get(name)!;
  }

  /**
   * Packt Instanzen von Modellen (Bäume, Felsen, Sträucher ...) nach Form
   * sortiert in einen eigenen Puffer auf der Grafikkarte. Andere Formen
   * (Gebäude-Klötze, Flächen) gehören nicht hinein und werden übergangen.
   */
  createBatch(instances: readonly EntityInstance[]): StaticBatch {
    const byShape = new Map<number, EntityInstance[]>();
    for (const e of instances) {
      if (!this.modelByShape.has(e.shape)) continue;
      let list = byShape.get(e.shape);
      if (!list) byShape.set(e.shape, (list = []));
      list.push(e);
    }
    const d = new Float32Array(instances.length * STRIDE);
    const ranges = new Map<number, { first: number; count: number }>();
    let i = 0;
    for (const [shape, list] of byShape) {
      ranges.set(shape, { first: i, count: list.length });
      for (const e of list) packInstance(d, i++ * STRIDE, e);
    }
    const gl = this.gl;
    const buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, d.subarray(0, i * STRIDE), gl.STATIC_DRAW);
    return { buffer, ranges };
  }

  deleteBatch(batch: StaticBatch) {
    this.gl.deleteBuffer(batch.buffer);
  }

  /**
   * Plant die Baumbilder für die jetzige Blickrichtung und Zoomstufe: wie groß
   * jedes wird (aus den Eckpunkten des Modells, projiziert wie im Shader) und
   * wo es in der Textur seiner Baumart liegt. Gerendert wird hier noch nichts.
   * Eine Baumart, deren Textur zu groß für die Grafikkarte wäre, fehlt - sie
   * bleibt Modell.
   */
  private planBillboards(key: string, ppt: number): BillboardSet {
    const max = this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) as number;
    const zScreen = viewZScreen();
    const unit = ppt * BILLBOARD_TREE_SIZE;
    const set: BillboardSet = { key, shapes: new Map() };
    for (const shape of TREES) {
      const m = this.modelByShape.get(shape);
      if (!m) continue;
      const v = m.model.vertices;
      const s = m.scale * BILLBOARD_TREE_SIZE;
      const band: BillboardBand = { w: 0, h: 0, texture: null, cells: [] };
      let x = 0, y = 0, row = 0;
      for (let k = 0; k < BILLBOARD_HEADINGS; k++) {
        const heading = (k * 2 * Math.PI) / BILLBOARD_HEADINGS;
        const c = Math.cos(heading), sn = Math.sin(heading);
        let u0 = Infinity, u1 = -Infinity, g0 = Infinity, g1 = -Infinity;
        for (let i = 0; i < v.length; i += 8) {
          const g = worldToGround((c * v[i] - sn * v[i + 1]) * s, (sn * v[i] + c * v[i + 1]) * s);
          const gy = g.v - zScreen * v[i + 2] * s;
          u0 = Math.min(u0, g.u); u1 = Math.max(u1, g.u);
          g0 = Math.min(g0, gy); g1 = Math.max(g1, gy);
        }
        // Ein Rand für Laub, das sich im Wind bewegt.
        const pad = BILLBOARD_PAD + Math.ceil((u1 - u0) * ppt * 0.05);
        const w = Math.ceil((u1 - u0) * ppt) + 2 * pad;
        const h = Math.ceil((g1 - g0) * ppt) + 2 * pad;
        if (x + w > BILLBOARD_ATLAS_WIDTH && x > 0) {
          x = 0;
          y += row;
          row = 0;
        }
        band.cells.push({ heading, x, y, w, h, fx: -u0 * ppt + pad, fy: -g0 * ppt + pad, rect: [0, 0, 0, 0], box: [0, 0, 0, 0] });
        x += w;
        band.w = Math.max(band.w, x);
        row = Math.max(row, h);
      }
      band.h = y + row;
      if (band.w > max || band.h > max) continue;
      for (const cell of band.cells) {
        // Oben im Bild ist in der Textur das größere y.
        cell.rect = [cell.x / band.w, (cell.y + cell.h) / band.h, (cell.x + cell.w) / band.w, cell.y / band.h];
        cell.box = [-cell.fx / unit, -cell.fy / unit, cell.w / unit, cell.h / unit];
      }
      set.shapes.set(shape, band);
    }
    return set;
  }

  /**
   * Rendert die Bilder einer Baumart (alle Drehungen) in ihre Textur - in einen
   * Framebuffer mit Kantenglättung, dann übertragen. So zeichnet dasselbe
   * Programm den Baum wie als Modell; nichts geht über den Arbeitsspeicher.
   */
  private renderBillboardBand(shape: number, band: BillboardBand, ppt: number, pixelRatio: number) {
    const gl = this.gl;
    const samples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES) as number);
    const color = gl.createRenderbuffer()!;
    gl.bindRenderbuffer(gl.RENDERBUFFER, color);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, band.w, band.h);
    const depth = gl.createRenderbuffer()!;
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH_COMPONENT24, band.w, band.h);
    const msaa = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, msaa);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    gl.viewport(0, 0, band.w, band.h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    for (const cell of band.cells) {
      gl.viewport(cell.x, cell.y, cell.w, cell.h);
      this.targetSize = { width: cell.w, height: cell.h };
      // Kamera so, dass der Fuß (Welt 0, 0) im Bild bei (fx, fy) von oben links liegt.
      const center = groundToWorld((cell.w / 2 - cell.fx) / ppt, (cell.h / 2 - cell.fy) / ppt);
      const tree: EntityInstance = {
        x: -0.5, y: -0.5, size: BILLBOARD_TREE_SIZE, color: BILLBOARD_TREE_COLOR, shape, alpha: 1,
        motion: [cell.heading, 0, 0, 1],
      };
      this.render([tree], { centerX: center.x, centerY: center.y, pixelsPerTile: ppt, reliefScale: 0 }, 0, pixelRatio);
    }
    this.targetSize = null;

    const texture = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0 + BILLBOARD_TEXTURE_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, band.w, band.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const resolved = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, resolved);
    gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, msaa);
    gl.blitFramebuffer(0, 0, band.w, band.h, 0, 0, band.w, band.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    // Nur auf Wunsch (Adresse mit ?saveBillboards): das Auslesen hält die
    // Grafikkarte an und kostete beim Herauszoomen gemessen 180 ms am Stück.
    if (import.meta.env.DEV && SAVE_BILLBOARDS) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, resolved);
      saveBillboard(gl, shape, band, ppt);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.activeTexture(gl.TEXTURE0);
    gl.deleteFramebuffer(resolved);
    gl.deleteFramebuffer(msaa);
    gl.deleteRenderbuffer(color);
    gl.deleteRenderbuffer(depth);
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    band.texture = texture;
  }

  /**
   * Die Baumbilder für die jetzige Blickrichtung, Zoomstufe und Neigung - je
   * Baumart erst, wenn sie im Bild vorkommt (`shapes`), direkt in eine Textur
   * dieses Renderers. Nach dem Drehen, Zoomen oder Neigen wird neu gerendert.
   * Zoom und Neigung kommen als die des Gelände-Caches (GpuCamera.cache*):
   * die bleiben stehen, solange weich gezoomt oder geneigt wird - mit dem
   * jetzigen Zoom würde je Bild neu gerendert, das kostete jedes Mal
   * Dutzende Millisekunden. false, wenn es keine Bilder gibt.
   */
  private ensureBillboards(pixelsPerTile: number, groundV: number, pixelRatio: number, shapes: Iterable<number>): boolean {
    const key = `${viewRotation()}|${pixelsPerTile}|${groundV.toFixed(4)}|${pixelRatio}|${this.leafReady}|${this.imagesLoaded}`;
    if (this.billboardSet?.key !== key) {
      for (const band of this.billboardSet?.shapes.values() ?? []) if (band.texture) this.gl.deleteTexture(band.texture);
      this.billboardSet = this.planBillboards(key, pixelsPerTile);
    }
    const set = this.billboardSet;
    // Höchstens eine Baumart je Bild - alle auf einmal hielten das Bild spürbar
    // an. Bis ihr Bild da ist, steht eine Art als Modell da (siehe drawModel).
    for (const shape of shapes) {
      const band = set.shapes.get(shape);
      if (band && !band.texture) {
        this.renderBillboardBand(shape, band, pixelsPerTile, pixelRatio);
        break;
      }
    }
    return set.shapes.size > 0;
  }

  /**
   * Instanzen ab `first` in `buffer` (sonst dem Instanz-Puffer dieses Bildes).
   * Die Attribut-Zeiger zeigen auf diesen Abschnitt.
   */
  private draw(mesh: Mesh, first: number, count: number, buffer = this.instanceBuffer) {
    if (count === 0) return;
    const gl = this.gl;
    const bytes = STRIDE * 4;
    const offset = first * bytes;
    gl.bindVertexArray(mesh.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, bytes, offset);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, bytes, offset + 8);
    gl.vertexAttribPointer(3, 3, gl.FLOAT, false, bytes, offset + 20);
    gl.vertexAttribPointer(4, 4, gl.FLOAT, false, bytes, offset + 32);
    gl.vertexAttribPointer(5, 3, gl.FLOAT, false, bytes, offset + 48);
    gl.vertexAttribPointer(7, 1, gl.FLOAT, false, bytes, offset + 60);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, mesh.vertices, count);
  }

  /**
   * Zeichnet über ein bereits gezeichnetes Gelände - dessen Tiefenpuffer
   * verdeckt, was hinter Hügeln liegt.
   * @param minSizeTiles Mindestgröße, damit Gebäude beim Herauszoomen nicht verschwinden
   * @param pixelRatio Geräte-Pixel je CSS-Pixel - Lebensbalken haben feste CSS-Größe
   * @param healthBars Lebensbalken über allem mit `health` zeichnen
   * @param batches feste Puffer (createBatch), dazu gezeichnet
   */
  render(
      instances: EntityInstance[],
      camera: GpuCamera,
      minSizeTiles: number,
      pixelRatio = 1,
      healthBars = false,
      batches: readonly StaticBatch[] = [],
  ) {
    this.billboardsActive = false;
    if (instances.length === 0 && batches.length === 0) return;
    const gl = this.gl;
    // Baumbilder zuerst: ihr Rendern benutzt dieselben Listen und Puffer wie dieses Bild.
    const cssPixelsPerTile = camera.pixelsPerTile / pixelRatio;
    // Nur die Baumarten, die gerade im Bild stehen.
    const shown = new Set<number>();
    for (const batch of batches) for (const shape of batch.ranges.keys()) if (TREES.includes(shape)) shown.add(shape);
    const billboards = shown.size > 0 && cssPixelsPerTile < this.billboardBelow
      && this.ensureBillboards(camera.cachePixelsPerTile ?? camera.pixelsPerTile, camera.cacheGroundV ?? viewGroundV(), pixelRatio, shown);
    this.billboardsActive = billboards;

    // Overlays zuerst, dann die Gebäude von hinten nach vorn - halbtransparente
    // Vorschau-Klötze mischen sich sonst mit dem falschen Hintergrund.
    const flats = this.flats;
    const solids = this.solids;
    const puffs = this.puffs;
    flats.length = 0;
    solids.length = 0;
    puffs.length = 0;
    for (const m of this.models) m.list.length = 0;
    for (const e of instances) {
      if (e.shape === SHAPE.flat || e.shape === SHAPE.ring) flats.push(e);
      else if (e.shape === SHAPE.dust) puffs.push(e);
      else (this.modelByShape.get(e.shape)?.list ?? solids).push(e);
    }
    const backToFront = (a: EntityInstance, b: EntityInstance) => a.x + a.y - (b.x + b.y);
    solids.sort(backToFront);
    // Nur Halbdurchsichtiges braucht die Reihenfolge; Bäume und Felsen sind
    // undurchsichtig, der Tiefenpuffer reicht - und es sind Tausende.
    for (const m of this.models) {
      if (!NATURAL.includes(m.shape)) m.list.sort(backToFront);
    }

    const bars = healthBars ? instances.filter((e) => e.health !== undefined) : [];
    const total = instances.length + bars.length;
    if (this.data.length < total * STRIDE) {
      this.data = new Float32Array(total * STRIDE * 2);
    }
    const d = this.data;
    let i = 0;
    for (const list of [flats, solids, ...this.models.map((m) => m.list), puffs]) {
      for (const e of list) packInstance(d, i++ * STRIDE, e);
    }
    for (const e of bars) {
      const o = i++ * STRIDE;
      this.writeBar(d, o, e, camera.pixelsPerTile, minSizeTiles, pixelRatio);
    }

    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, d.subarray(0, total * STRIDE), gl.DYNAMIC_DRAW);

    setCameraUniforms(gl, (name) => this.location(name), camera, this.targetSize ?? gl.canvas);
    gl.uniform3fv(this.location('uToCamera'), cameraDirection());
    gl.uniform1f(this.location('uMinSizeTiles'), minSizeTiles);
    gl.uniform1i(this.location('uSilhouette'), 0);
    gl.uniform1f(this.location('uGroundStep'), this.groundStep);
    gl.uniform4fv(this.location('uFlat[0]'), this.flatZones);
    gl.uniform1i(this.location('uFlatCount'), this.flatCount);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);

    // Overlays schreiben keine Tiefe - sie liegen auf dem Boden und sollen
    // Gebäude auf demselben Feld nicht verdecken.
    gl.depthMask(false);
    this.draw(this.flat, 0, flats.length);
    gl.depthMask(true);
    this.draw(this.building, flats.length, solids.length);

    gl.uniform1f(this.location('uTime'), animationTime());
    gl.uniform3f(this.location('uPlayerColor'), this.playerColor[0] / 255, this.playerColor[1] / 255, this.playerColor[2] / 255);
    gl.uniform1f(this.location('uSkirt'), this.skirts ? 1 : 0);
    gl.activeTexture(gl.TEXTURE0 + LEAF_TEXTURE_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.leafTexture);
    gl.activeTexture(gl.TEXTURE0 + CLIP_TEXTURE_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.clipTexture);
    gl.activeTexture(gl.TEXTURE0 + IMAGE_TEXTURE_UNIT);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.imageTexture);
    gl.activeTexture(gl.TEXTURE0);
    // Herausgezoomt die vereinfachten Fassungen der Vorkommen.
    const lod = LOD_ZOOM.filter((z) => cssPixelsPerTile < z).length;
    const fieldLod = FIELD_LOD_ZOOM.filter((z) => cssPixelsPerTile < z).length;
    let first = flats.length + solids.length;
    const drawModel = (m: (typeof this.models)[number], offset: number) => {
      // Ein Anhang (Werkzeug) zeichnet sich mit Gelenken, Clips und Hand
      // seines Körpers - er bewegt sich genau mit dessen Unterarm.
      const b = m.body === undefined ? m : this.models.find((x) => x.shape === m.body) ?? m;
      gl.uniform1f(this.location('uModelScale'), m.scale);
      gl.uniform3fv(this.location('uSocket'), b.model.hand);
      gl.uniform1f(this.location('uKnifeScale'), Math.abs(b.model.hand[1]) * b.model.meters / KNIFE_HALF_SPAN);
      gl.uniform1f(this.location('uHip'), b.model.hip);
      gl.uniform1f(this.location('uKnee'), b.model.knee);
      gl.uniform1f(this.location('uArm'), b.model.arm);
      gl.uniform1f(this.location('uModelTop'), m.model.top);
      gl.uniform1f(this.location('uMeters'), b.model.meters);
      gl.uniform1f(this.location('uStump'), m.model.stump);
      gl.uniform1f(this.location('uStumpRadius'), m.model.stumpRadius);
      gl.uniform3fv(this.location('uLoadAnchor'), b.model.loadAnchor);
      gl.uniform3fv(this.location('uCanopy'), m.model.canopy);
      gl.uniform3fv(this.location('uCanopyHalf'), m.model.canopyHalf);
      const clips = this.clipUniforms.get(b.shape) ?? NO_CLIPS;
      gl.uniform1iv(this.location('uClipRow'), clips.rows);
      gl.uniform1iv(this.location('uClipFrames'), clips.frames);
      gl.uniform1fv(this.location('uClipFps'), clips.fps);
      gl.uniform1iv(this.location('uClipProps'), clips.props);
      gl.uniform1fv(this.location('uClipRate'), clips.rate);
      gl.uniform1fv(this.location('uClipShift'), clips.shift);
      gl.uniform3fv(this.location('uCloth'), m.model.cloth);
      gl.uniform1iv(this.location('uPoseClip'), clips.poseClip);
      gl.uniform1fv(this.location('uPoseRate'), clips.poseRate);
      gl.uniform1fv(this.location('uPoseShift'), clips.poseShift);
      const level = FIELDS.includes(m.shape) ? fieldLod : lod;
      // Hat ein Modell weniger Fassungen (Felder: zwei), gilt seine gröbste.
      const mesh = level > 0 && m.lodMeshes.length > 0 ? m.lodMeshes[Math.min(level, m.lodMeshes.length) - 1] : m.mesh;
      this.draw(mesh, offset, m.list.length);
      const band = billboards ? this.billboardSet!.shapes.get(m.shape) : undefined;
      const cells = band?.texture ? band.cells : undefined;
      if (cells) {
        gl.activeTexture(gl.TEXTURE0 + BILLBOARD_TEXTURE_UNIT);
        gl.bindTexture(gl.TEXTURE_2D, band!.texture);
        gl.activeTexture(gl.TEXTURE0);
        gl.uniform4fv(this.location('uBillboardRect[0]'), cells.flatMap((c) => c.rect));
        gl.uniform4fv(this.location('uBillboardBox[0]'), cells.flatMap((c) => c.box));
        gl.uniform1i(this.location('uBillboard'), 1);
      }
      for (const batch of batches) {
        const range = batch.ranges.get(m.shape);
        if (range) this.draw(cells ? this.quad : mesh, range.first, range.count, batch.buffer);
      }
      if (cells) gl.uniform1i(this.location('uBillboard'), 0);
    };
    const batched = new Set<number>();
    for (const batch of batches) for (const shape of batch.ranges.keys()) batched.add(shape);
    // Erst alles außer den Figuren, dann die Figuren - dazwischen ihr Umriss,
    // wo etwas vor ihnen steht (wie in AoE2). Die Figuren sind dann noch nicht
    // im Tiefenpuffer und verdecken sich nicht selbst.
    const figures: [ModelSlot, number][] = [];
    for (const m of this.models) {
      if (m.list.length > 0 || batched.has(m.shape)) {
        if (FIGURES.includes(m.shape)) figures.push([m, first]);
        else drawModel(m, first);
      }
      first += m.list.length;
    }
    if (figures.length > 0) {
      gl.depthMask(false);
      gl.depthFunc(gl.GREATER);
      gl.uniform1i(this.location('uSilhouette'), 1);
      for (const [m, offset] of figures) drawModel(m, offset);
      gl.uniform1i(this.location('uSilhouette'), 0);
      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(true);
      for (const [m, offset] of figures) drawModel(m, offset);
    }

    // Staub zuletzt: halbdurchsichtig über allem, was dahinter steht, ohne
    // selbst Tiefe zu schreiben.
    if (puffs.length > 0) {
      gl.depthMask(false);
      this.draw(this.flat, first, puffs.length);
      gl.depthMask(true);
    }

    // Lebensbalken zuletzt und ohne Tiefentest: sie liegen über allem, auch
    // wenn ein Hügel oder ein Gebäude davor steht.
    if (bars.length > 0) {
      gl.disable(gl.DEPTH_TEST);
      this.draw(this.flat, instances.length, bars.length);
      gl.enable(gl.DEPTH_TEST);
    }

    gl.disable(gl.BLEND);
    gl.depthFunc(gl.LESS);
    gl.bindVertexArray(null);
  }

  /** Ein Lebensbalken für Instanz `e`: verankert über ihrem höchsten Punkt. */
  private writeBar(
      d: Float32Array, o: number, e: EntityInstance,
      pixelsPerTile: number, minSizeTiles: number, pixelRatio: number,
  ) {
    const model = this.models.find((m) => m.shape === e.shape);
    const figure = e.shape === SHAPE.villager || e.shape === SHAPE.villagerFemale;
    // Dieselbe Mindestgröße wie im Vertex-Shader, sonst schwebt der Balken
    // herausgezoomt im Gebäude statt darüber.
    const size = Math.max(e.size, figure ? minSizeTiles * 0.5 : minSizeTiles);
    let top = model ? model.model.top * model.scale * size : (BOX_TOP[e.shape] ?? 1) * size;
    // Ein liegender Baum ist flach - der Balken gehört knapp darüber.
    if (TREES.includes(e.shape) && e.motion && e.motion[1] > 0.5) top = 0.3 * size;
    const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
    const width = figure
      ? clamp(pixelsPerTile * 0.6, 22 * pixelRatio, 36 * pixelRatio)
      : clamp(size * pixelsPerTile * 0.8, 40 * pixelRatio, 110 * pixelRatio);
    const height = (figure ? 4 : 6) * pixelRatio;

    d.fill(0, o, o + STRIDE);
    d[o] = e.x;
    d[o + 1] = e.y;
    d[o + 5] = SHAPE.healthBar;
    d[o + 6] = 1;
    d[o + 7] = width;
    d[o + 8] = Math.max(0, Math.min(1, e.health ?? 1));
    d[o + 9] = top;
    d[o + 10] = height;
    d[o + 11] = 5 * pixelRatio;
  }
}
