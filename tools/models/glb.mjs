// Die Modelle des Spiels als glTF (src/models/<name>.glb, docs/BLENDER.md):
// Blender öffnet und speichert sie ohne Zusatz (Datei > Import/Export >
// glTF 2.0). Das Spiel und die Werkzeuge lesen daraus weiter OBJ- und
// MTL-Text - einmal gewandelt, beim Bauen (vite.config.ts, `?model`) bzw. in
// Node (readModel).
//
// Namen: Das Spiel erkennt Teile am Objektnamen (Entry, Stock.42, Berry.100 ...),
// und Namen dürfen sich wiederholen. Blender duldet keine doppelten Namen und
// nummeriert sie beim Import um - darum steht ab dem zweiten gleichen Namen
// "#2", "#3" ... dahinter; das Spiel liest den Namen bis zum "#". Eine Kopie
// in Blender (Umschalt+D) heißt "Name.001" - gibt es "Name" im Modell, zählt
// sie als "Name".
//
// Farben: baseColorFactor ist genau der Kd-Wert aus der MTL (Blenders Farbwert,
// ohne Umrechnung). Achsen: glTF und OBJ haben beide Y oben, vorn +Z.
//
// Bildtexturen (baseColorTexture): das Bild steht als data:-URL in der MTL
// (`map_Kd`), die Texturkoordinaten als `vt` im OBJ (v = 0 unten, wie in OBJ).

import { readFileSync } from 'node:fs';

const models = new URL('../../src/models/', import.meta.url).pathname;

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

const fmt = (v, digits) => {
  const s = v.toFixed(digits).replace(/\.?0+$/, '');
  return s === '-0' || s === '' ? '0' : s;
};

/** Name im Spiel aus dem Knotennamen; `names` sind die Namen (bis "#") aller Knoten. */
export function gameName(name, names) {
  const plain = name.split('#')[0];
  const copy = /^(.*)\.\d{3}$/.exec(plain);
  return copy && names.has(copy[1]) ? copy[1] : plain;
}

// --- .glb lesen --------------------------------------------------------------

function parseGlb(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error('keine .glb-Datei');
  let json = null;
  let bin = null;
  for (let at = 12; at < bytes.byteLength;) {
    const length = view.getUint32(at, true);
    const type = view.getUint32(at + 4, true);
    const data = bytes.subarray(at + 8, at + 8 + length);
    if (type === CHUNK_JSON) json = JSON.parse(new TextDecoder().decode(data));
    else if (type === CHUNK_BIN && !bin) bin = data;
    at += 8 + length;
  }
  return { json, bin };
}

const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const READERS = {
  5121: [1, (v, o) => v.getUint8(o)],
  5123: [2, (v, o) => v.getUint16(o, true)],
  5125: [4, (v, o) => v.getUint32(o, true)],
  5126: [4, (v, o) => v.getFloat32(o, true)],
};

function readAccessor(gltf, bin, index) {
  const a = gltf.accessors[index];
  const size = COMPONENTS[a.type];
  const [bytesPer, get] = READERS[a.componentType];
  const out = new Array(a.count * size);
  if (a.bufferView === undefined) return out.fill(0);
  const bv = gltf.bufferViews[a.bufferView];
  const view = new DataView(bin.buffer, bin.byteOffset + (bv.byteOffset ?? 0) + (a.byteOffset ?? 0));
  const stride = bv.byteStride ?? size * bytesPer;
  for (let i = 0; i < a.count; i++) {
    for (let c = 0; c < size; c++) out[i * size + c] = get(view, i * stride + c * bytesPer);
  }
  return out;
}

/** 4x4, Spalten zuerst (wie glTF). */
function multiply(a, b) {
  const m = new Array(16);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      m[c * 4 + r] = s;
    }
  }
  return m;
}

function localMatrix(node) {
  if (node.matrix) return node.matrix;
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const isIdentity = (m) => m.every((v, i) => v === IDENTITY[i]);

/**
 * Das Modell einer .glb als OBJ- und MTL-Text, wie ihn das Spiel liest:
 * je Mesh-Knoten ein `o` mit dem Namen im Spiel, Eckpunkte in Modell-
 * Koordinaten (Lage, Drehung und Größe der Knoten eingerechnet), Dreiecke.
 */
export function glbToObj(bytes, mtllib = 'model.mtl') {
  const { json: gltf, bin } = parseGlb(bytes);
  const meshNodes = [];
  const visit = (index, parent) => {
    const node = gltf.nodes[index];
    const local = localMatrix(node);
    const world = isIdentity(parent) ? local : multiply(parent, local);
    if (node.mesh !== undefined) meshNodes.push({ node, world });
    for (const child of node.children ?? []) visit(child, world);
  };
  const scene = gltf.scenes?.[gltf.scene ?? 0];
  for (const root of scene?.nodes ?? []) visit(root, IDENTITY);

  const rawName = ({ node }, i) => node.name ?? gltf.meshes[node.mesh].name ?? `Object.${i}`;
  const plainNames = new Set(meshNodes.map((n, i) => rawName(n, i).split('#')[0]));
  const materialName = (i) => gltf.materials[i].name ?? `Material.${i}`;

  const lines = [`mtllib ${mtllib}`];
  const used = new Map();
  let base = 0;
  let uvBase = 0;
  const uvOffsets = new Map();
  const textureOf = (material) => material === undefined ? undefined : gltf.materials[material].pbrMetallicRoughness?.baseColorTexture;
  meshNodes.forEach((entry, i) => {
    const { node, world } = entry;
    lines.push(`o ${gameName(rawName(entry, i), plainNames)}`);
    const offsets = new Map();
    const faces = [];
    for (const primitive of gltf.meshes[node.mesh].primitives) {
      if ((primitive.mode ?? 4) !== 4) continue;
      const accessor = primitive.attributes.POSITION;
      if (!offsets.has(accessor)) {
        const p = readAccessor(gltf, bin, accessor);
        const plain = isIdentity(world);
        for (let v = 0; v < p.length; v += 3) {
          let [x, y, z] = [p[v], p[v + 1], p[v + 2]];
          if (!plain) {
            [x, y, z] = [0, 1, 2].map((r) => world[r] * p[v] + world[4 + r] * p[v + 1] + world[8 + r] * p[v + 2] + world[12 + r]);
          }
          lines.push(`v ${fmt(x, 4)} ${fmt(y, 4)} ${fmt(z, 4)}`);
        }
        offsets.set(accessor, base);
        base += p.length / 3;
      }
      const offset = offsets.get(accessor);
      const count = gltf.accessors[accessor].count;
      const indices = primitive.indices !== undefined ? readAccessor(gltf, bin, primitive.indices) : Array.from({ length: count }, (_, k) => k);
      // Texturkoordinaten nur für Flächen mit Bildtextur.
      const texture = textureOf(primitive.material);
      const uvAccessor = texture && primitive.attributes[`TEXCOORD_${texture.texCoord ?? 0}`];
      let uvOffset;
      if (uvAccessor !== undefined) {
        if (!uvOffsets.has(uvAccessor)) {
          const t = readAccessor(gltf, bin, uvAccessor);
          for (let k = 0; k < t.length; k += 2) lines.push(`vt ${fmt(t[k], 5)} ${fmt(1 - t[k + 1], 5)}`);
          uvOffsets.set(uvAccessor, uvBase);
          uvBase += t.length / 2;
        }
        uvOffset = uvOffsets.get(uvAccessor);
      }
      faces.push({
        material: primitive.material,
        indices: indices.map((k) => (uvOffset === undefined ? `${k + offset + 1}` : `${k + offset + 1}/${k + uvOffset + 1}`)),
      });
    }
    for (const { material, indices } of faces) {
      if (material !== undefined) {
        const name = materialName(material);
        used.set(name, gltf.materials[material]);
        lines.push(`usemtl ${name}`, 's off');
      }
      for (let k = 0; k + 2 < indices.length; k += 3) lines.push(`f ${indices[k]} ${indices[k + 1]} ${indices[k + 2]}`);
    }
  });

  const mtl = [`# ${mtllib}`];
  for (const [name, material] of used) {
    const [r, g, b] = material.pbrMetallicRoughness?.baseColorFactor ?? [1, 1, 1, 1];
    mtl.push('', `newmtl ${name}`, `Kd ${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)}`, 'Ka 0 0 0', 'Ks 0 0 0', 'd 1', 'illum 1');
    const texture = material.pbrMetallicRoughness?.baseColorTexture;
    const image = texture && gltf.images?.[gltf.textures[texture.index].source];
    if (image?.bufferView !== undefined) {
      const bv = gltf.bufferViews[image.bufferView];
      const data = bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
      mtl.push(`map_Kd data:${image.mimeType};base64,${Buffer.from(data).toString('base64')}`);
    }
  }
  return { obj: `${lines.join('\n')}\n`, mtl: `${mtl.join('\n')}\n` };
}

/** src/models/<name>.glb als OBJ- und MTL-Text (für die Werkzeuge in Node). */
export function readModel(name, dir = models) {
  return glbToObj(readFileSync(`${dir}/${name}.glb`), `${name}.mtl`);
}

// --- .glb schreiben ----------------------------------------------------------

/**
 * OBJ und MTL als .glb: je Objekt ein Knoten mit seinem Namen (doppelte mit
 * "#2" ...), je Folge von Flächen mit gleichem Material eine Primitive, die
 * Flächen als Fächer in Dreiecke zerlegt - wie das Spiel sie liest. Hat das
 * Material ein Bild (map_Kd als data:-URL), bekommt die Primitive eigene
 * Eckpunkte mit Texturkoordinaten und das Material das Bild.
 */
export function objToGlb(objText, mtlText) {
  const colors = new Map();
  const maps = new Map();
  let current = null;
  for (const raw of mtlText.split('\n')) {
    const [keyword, ...args] = raw.trim().split(/\s+/);
    if (keyword === 'newmtl') current = args.join(' ');
    if (keyword === 'Kd' && current) colors.set(current, args.slice(0, 3).map(Number));
    if (keyword === 'map_Kd' && current) maps.set(current, args.join(' '));
  }

  const positions = [];
  const uvs = [];
  const objects = [];
  let object = null;
  let material;
  for (const raw of objText.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const [keyword, ...args] = line.split(/\s+/);
    if (keyword === 'v') positions.push(args.slice(0, 3).map(Number));
    else if (keyword === 'vt') uvs.push(args.slice(0, 2).map(Number));
    else if (keyword === 'o' || keyword === 'g') {
      object = { name: args.join(' '), runs: [] };
      objects.push(object);
      material = undefined;
    } else if (keyword === 'usemtl') material = args.join(' ');
    else if (keyword === 'f') {
      if (!object) objects.push((object = { name: 'Object', runs: [] }));
      const corners = args.map((a) => {
        const i = Number(a.split('/')[0]);
        return i < 0 ? positions.length + i : i - 1;
      });
      const textured = maps.has(material) && args.every((a) => a.split('/')[1]);
      const uvCorners = textured ? args.map((a) => {
        const i = Number(a.split('/')[1]);
        return i < 0 ? uvs.length + i : i - 1;
      }) : [];
      let run = object.runs.at(-1);
      if (!run || run.material !== material || run.textured !== textured) {
        object.runs.push((run = { material, textured, triangles: [], uvTriangles: [] }));
      }
      for (let i = 1; i + 1 < corners.length; i++) {
        run.triangles.push(corners[0], corners[i], corners[i + 1]);
        if (textured) run.uvTriangles.push(uvCorners[0], uvCorners[i], uvCorners[i + 1]);
      }
    }
  }

  const gltf = {
    asset: { version: '2.0', generator: 'Soliva tools/models/glb.mjs' },
    scene: 0,
    scenes: [{ nodes: [] }],
    nodes: [],
    meshes: [],
    materials: [],
    accessors: [],
    bufferViews: [],
    buffers: [{ byteLength: 0 }],
  };
  const chunks = [];
  let byteLength = 0;
  const addView = (array, target) => {
    const data = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    gltf.bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: data.byteLength, target });
    chunks.push(data);
    byteLength += data.byteLength;
    const pad = (4 - (byteLength % 4)) % 4;
    if (pad) {
      chunks.push(new Uint8Array(pad));
      byteLength += pad;
    }
    return gltf.bufferViews.length - 1;
  };
  const materialIndex = new Map();
  const materialOf = (name) => {
    if (name === undefined) return undefined;
    if (!materialIndex.has(name)) {
      const [r, g, b] = colors.get(name) ?? [1, 1, 1];
      const material = { name, pbrMetallicRoughness: { baseColorFactor: [r, g, b, 1], metallicFactor: 0, roughnessFactor: 1 } };
      const image = /^data:([^;]+);base64,(.*)$/.exec(maps.get(name) ?? '');
      if (image) {
        gltf.images ??= [];
        gltf.textures ??= [];
        gltf.images.push({ bufferView: addView(Buffer.from(image[2], 'base64')), mimeType: image[1] });
        gltf.textures.push({ source: gltf.images.length - 1 });
        material.pbrMetallicRoughness.baseColorTexture = { index: gltf.textures.length - 1 };
      }
      gltf.materials.push(material);
      materialIndex.set(name, gltf.materials.length - 1);
    }
    return materialIndex.get(name);
  };

  const seen = new Map();
  for (const { name, runs } of objects) {
    if (runs.length === 0) continue;
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    const nodeName = n === 1 ? name : `${name}#${n}`;

    const used = [...new Set(runs.filter((r) => !r.textured).flatMap((r) => r.triangles))].sort((a, b) => a - b);
    const local = new Map(used.map((g, i) => [g, i]));
    const addPositions = (list) => {
      const points = new Float32Array(list.flatMap((g) => positions[g]));
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < points.length; i++) {
        min[i % 3] = Math.min(min[i % 3], points[i]);
        max[i % 3] = Math.max(max[i % 3], points[i]);
      }
      gltf.accessors.push({ bufferView: addView(points, 34962), componentType: 5126, count: list.length, type: 'VEC3', min, max });
      return gltf.accessors.length - 1;
    };
    const position = used.length ? addPositions(used) : undefined;
    const addIndices = (list, count) => {
      const Indices = count < 65536 ? Uint16Array : Uint32Array;
      const indices = Indices.from(list);
      gltf.accessors.push({
        bufferView: addView(indices, 34963), componentType: Indices === Uint16Array ? 5123 : 5125, count: indices.length, type: 'SCALAR',
      });
      return gltf.accessors.length - 1;
    };

    const primitives = runs.map((run) => {
      let primitive;
      if (run.textured) {
        // Eigene Eckpunkte je Paar aus Eckpunkt und Texturkoordinate (v = 0 oben in glTF).
        const keys = [...new Set(run.triangles.map((g, k) => `${g}/${run.uvTriangles[k]}`))]
          .map((key) => key.split('/').map(Number)).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        const slot = new Map(keys.map(([g, t], i) => [`${g}/${t}`, i]));
        const texcoords = new Float32Array(keys.flatMap(([, t]) => [uvs[t][0], 1 - uvs[t][1]]));
        gltf.accessors.push({ bufferView: addView(texcoords, 34962), componentType: 5126, count: keys.length, type: 'VEC2' });
        const texcoord = gltf.accessors.length - 1;
        const points = addPositions(keys.map(([g]) => g));
        const indices = addIndices(run.triangles.map((g, k) => slot.get(`${g}/${run.uvTriangles[k]}`)), keys.length);
        primitive = { attributes: { POSITION: points, TEXCOORD_0: texcoord }, indices, mode: 4 };
      } else {
        primitive = { attributes: { POSITION: position }, indices: addIndices(run.triangles.map((g) => local.get(g)), used.length), mode: 4 };
      }
      const m = materialOf(run.material);
      if (m !== undefined) primitive.material = m;
      return primitive;
    });
    gltf.meshes.push({ name: nodeName, primitives });
    gltf.nodes.push({ name: nodeName, mesh: gltf.meshes.length - 1 });
    gltf.scenes[0].nodes.push(gltf.nodes.length - 1);
  }
  if (gltf.materials.length === 0) delete gltf.materials;
  gltf.buffers[0].byteLength = byteLength;

  const encoder = new TextEncoder();
  let json = encoder.encode(JSON.stringify(gltf));
  const jsonPad = (4 - (json.byteLength % 4)) % 4;
  json = Uint8Array.from([...json, ...new Array(jsonPad).fill(0x20)]);
  const total = 12 + 8 + json.byteLength + 8 + byteLength;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, json.byteLength, true);
  view.setUint32(16, CHUNK_JSON, true);
  out.set(json, 20);
  let at = 20 + json.byteLength;
  view.setUint32(at, byteLength, true);
  view.setUint32(at + 4, CHUNK_BIN, true);
  at += 8;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}
