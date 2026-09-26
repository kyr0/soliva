// Baut aus einer Szene (render.ts) eine .glb-Datei (glTF 2.0, binär): eine
// Datei mit eingebetteten Texturen, die Blender direkt importiert
// (File > Import > glTF 2.0). Meter und y nach oben wie im Modell; je Objekt
// (Trunk, Trunk.Stump, Branch ...) ein Knoten mit seinem Namen - das Spiel
// erkennt die Teile daran (doppelte Namen mit "#2" ..., tools/models/glb.mjs) -,
// darin je Material ein Primitive.
import type { Scene, Texture } from './render.ts';

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const FLOAT = 5126;
const WRAP_REPEAT = 10497;
const WRAP_CLAMP = 33071;
const TRIANGLES = 4;

/** sRGB -> linear: glTF-Farbfaktoren sind linear, unsere Farben sRGB. */
const linear = (c: readonly number[]) => c.map((v) => v ** 2.2);

interface GltfBufferView { buffer: 0; byteOffset: number; byteLength: number }
interface GltfAccessor {
  bufferView: number;
  componentType: number;
  count: number;
  type: 'VEC3' | 'VEC2';
  min?: number[];
  max?: number[];
}
interface GltfSampler { wrapS: number; wrapT: number }
interface GltfPbr {
  baseColorFactor: number[];
  baseColorTexture?: { index: number };
  metallicFactor: number;
  roughnessFactor: number;
}
interface GltfMaterial {
  name: string;
  doubleSided: true;
  pbrMetallicRoughness: GltfPbr;
  alphaMode?: 'MASK';
  alphaCutoff?: number;
}

export async function buildGlb(scene: Scene, name: string): Promise<Blob> {
  const binParts: Uint8Array[] = [];
  let binLength = 0;
  const bufferViews: GltfBufferView[] = [];
  const addView = (bytes: Uint8Array): number => {
    const pad = (4 - (binLength % 4)) % 4;
    if (pad) {
      binParts.push(new Uint8Array(pad));
      binLength += pad;
    }
    bufferViews.push({ buffer: 0, byteOffset: binLength, byteLength: bytes.byteLength });
    binParts.push(bytes);
    binLength += bytes.byteLength;
    return bufferViews.length - 1;
  };

  const accessors: GltfAccessor[] = [];
  const addAccessor = (data: Float32Array, type: 'VEC3' | 'VEC2', withBounds: boolean): number => {
    const size = type === 'VEC3' ? 3 : 2;
    const accessor: GltfAccessor = {
      bufferView: addView(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)),
      componentType: FLOAT,
      count: data.length / size,
      type,
    };
    if (withBounds) {
      const min = [...data.subarray(0, size)], max = [...min];
      for (let i = size; i < data.length; i += size) {
        for (let k = 0; k < size; k++) {
          min[k] = Math.min(min[k], data[i + k]);
          max[k] = Math.max(max[k], data[i + k]);
        }
      }
      accessor.min = min;
      accessor.max = max;
    }
    accessors.push(accessor);
    return accessors.length - 1;
  };

  // Je Textur einmal einbetten; die Bilddaten kommen von den geladenen Bildern.
  const samplers: GltfSampler[] = [];
  const images: { bufferView: number; mimeType: string }[] = [];
  const textures: { sampler: number; source: number }[] = [];
  const textureIndex = new Map<Texture, number>();
  const addTexture = async (texture: Texture): Promise<number> => {
    let index = textureIndex.get(texture);
    if (index !== undefined) return index;
    const src = texture.image.src;
    const bytes = new Uint8Array(await (await fetch(src)).arrayBuffer());
    const wrap = texture.tile ? WRAP_REPEAT : WRAP_CLAMP;
    let sampler = samplers.findIndex((s) => s.wrapS === wrap);
    if (sampler < 0) sampler = samplers.push({ wrapS: wrap, wrapT: wrap }) - 1;
    images.push({
      bufferView: addView(bytes),
      mimeType: src.split('?')[0].endsWith('.jpg') ? 'image/jpeg' : 'image/png',
    });
    index = textures.push({ sampler, source: images.length - 1 }) - 1;
    textureIndex.set(texture, index);
    return index;
  };

  const materials: GltfMaterial[] = [];
  for (const batch of scene.batches) {
    const { look } = batch;
    let material: GltfMaterial;
    if ('texture' in look) {
      material = {
        name: batch.name,
        doubleSided: true,
        pbrMetallicRoughness: {
          baseColorFactor: [...linear(look.texture.tint), 1],
          baseColorTexture: { index: await addTexture(look.texture) },
          metallicFactor: 0,
          roughnessFactor: 0.9,
        },
        // Blätter: harte Kante über den Alphatest; die kachelnde Rinde ist deckend.
        ...(look.texture.tile ? {} : { alphaMode: 'MASK' as const, alphaCutoff: 0.35 }),
      };
    } else {
      material = {
        name: batch.name,
        doubleSided: true,
        pbrMetallicRoughness: { baseColorFactor: [...linear(look.color), 1], metallicFactor: 0, roughnessFactor: 0.9 },
      };
    }
    materials.push(material);
  }

  type Primitive = { attributes: Record<string, number>; mode: number; material: number };
  const objects = new Map<number, { name: string; primitives: Primitive[] }>();
  for (const { name: objectName, object, batch, first, count } of scene.parts) {
    // glTF: Textur-Ursprung oben links, OBJ: v = 0 unten - v spiegeln.
    const uvs = scene.uvs.slice(first * 2, (first + count) * 2);
    for (let i = 1; i < uvs.length; i += 2) uvs[i] = 1 - uvs[i];
    let entry = objects.get(object);
    if (!entry) objects.set(object, (entry = { name: objectName, primitives: [] }));
    entry.primitives.push({
      attributes: {
        POSITION: addAccessor(scene.positions.slice(first * 3, (first + count) * 3), 'VEC3', true),
        NORMAL: addAccessor(normalized(scene.normals, first, count), 'VEC3', false),
        TEXCOORD_0: addAccessor(uvs, 'VEC2', false),
      },
      mode: TRIANGLES,
      material: batch,
    });
  }
  const meshes: { name: string; primitives: Primitive[] }[] = [];
  const nodes: { name: string; mesh?: number; children?: number[] }[] = [];
  const seen = new Map<string, number>();
  for (const { name: objectName, primitives } of [...objects.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1])) {
    const n = (seen.get(objectName) ?? 0) + 1;
    seen.set(objectName, n);
    const nodeName = n === 1 ? objectName : `${objectName}#${n}`;
    nodes.push({ name: nodeName, mesh: meshes.push({ name: nodeName, primitives }) - 1 });
  }
  // Ein Wurzelknoten mit dem Namen des Baums hält die Teile zusammen.
  nodes.push({ name, children: nodes.map((_, i) => i) });

  const json = {
    asset: { version: '2.0', generator: 'procedurally-generated-map tools/lsystem' },
    buffers: [{ byteLength: binLength }],
    bufferViews,
    accessors,
    ...(samplers.length ? { samplers, images, textures } : {}),
    materials,
    meshes,
    nodes,
    scenes: [{ nodes: [nodes.length - 1] }],
    scene: 0,
  };
  return new Blob([glb(json, binParts, binLength)], { type: 'model/gltf-binary' });
}

/** Die flachen Normalen sind unnormiert (Kreuzprodukt) - glTF verlangt Einheitsvektoren. */
function normalized(normals: Float32Array, first: number, count: number): Float32Array {
  const out = normals.slice(first * 3, (first + count) * 3);
  for (let i = 0; i < out.length; i += 3) {
    const l = Math.hypot(out[i], out[i + 1], out[i + 2]) || 1;
    out[i] /= l;
    out[i + 1] /= l;
    out[i + 2] /= l;
  }
  return out;
}

/** GLB-Rahmen: Header, JSON-Chunk (mit Leerzeichen gefüllt), BIN-Chunk - eine zusammenhängende Datei. */
function glb(json: object, binParts: Uint8Array[], binLength: number): Uint8Array<ArrayBuffer> {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPadded = (jsonBytes.length + 3) & ~3;
  const binPadded = (binLength + 3) & ~3;
  const total = 12 + 8 + jsonPadded + 8 + binPadded;
  const out = new Uint8Array(new ArrayBuffer(total));
  const words = new DataView(out.buffer);
  words.setUint32(0, GLB_MAGIC, true);
  words.setUint32(4, 2, true);
  words.setUint32(8, total, true);
  words.setUint32(12, jsonPadded, true);
  words.setUint32(16, CHUNK_JSON, true);
  out.fill(0x20, 20, 20 + jsonPadded);
  out.set(jsonBytes, 20);
  const binStart = 20 + jsonPadded;
  words.setUint32(binStart, binPadded, true);
  words.setUint32(binStart + 4, CHUNK_BIN, true);
  let at = binStart + 8;
  for (const part of binParts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}
