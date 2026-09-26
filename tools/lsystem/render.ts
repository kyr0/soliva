// Vorschau für Spielwiese und Galerie: WebGL2 mit Tiefentest, Beleuchtung im
// Fragment-Shader, Blatt-Fotos mit Alphatest und kachelnder Rinde (Mipmaps).
// Browser erlauben nur wenige WebGL-Kontexte, die Galerie hat aber 58 Canvases:
// gerendert wird deshalb auf einem gemeinsamen, unsichtbaren Canvas, das Bild
// dann per drawImage in das sichtbare Canvas kopiert.
import type { Vec3 } from './lsystem.ts';

type Rgb = readonly [number, number, number];

/** Foto-Textur: fertig geladenes Bild, Einfärbung (1,1,1 = unverändert), tile = kacheln (Rinde). */
export interface Texture {
  readonly image: HTMLImageElement;
  readonly tint: Rgb;
  readonly tile: boolean;
}

/** Wie ein Material aussieht: Farbe oder Foto-Textur. */
export type Look = { readonly color: Rgb } | { readonly texture: Texture };

export interface View {
  /** Drehung um die Hochachse, Radiant. */
  yaw: number;
  /** Blick von oben, Radiant. */
  pitch: number;
  zoom: number;
}

/** Dreiecke je Look, als Soup mit flachen Normalen - fertig für den Upload. */
export interface Batch {
  readonly look: Look;
  /** Name des Materials im OBJ - für den glTF-Export. */
  readonly name: string;
  /** Erster Eckpunkt und Anzahl im gemeinsamen Buffer. */
  readonly first: number;
  readonly count: number;
}

/** Ein Objekt (`o` im OBJ) innerhalb eines Batches - für den glTF-Export. */
export interface Part {
  /** Name im OBJ (Trunk, Trunk.Stump, Branch ...) und Nummer des Objekts. */
  readonly name: string;
  readonly object: number;
  /** Index in Scene.batches. */
  readonly batch: number;
  readonly first: number;
  readonly count: number;
}

export interface Scene {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly uvs: Float32Array;
  readonly batches: readonly Batch[];
  readonly parts: readonly Part[];
  readonly triangles: number;
  /** Höchster Punkt und Kronenradius in Metern - für Bildausschnitt und Boden. */
  readonly top: number;
  readonly radius: number;
}

const BACKGROUND: Rgb = [0.106, 0.114, 0.102]; // #1b1d1a
const GROUND: Rgb = [0.173, 0.2, 0.149]; // #2c3326
const FALLBACK: Rgb = [0.6, 0.6, 0.6];
/** Boden: Scheibe um den Stamm, etwas größer als die Krone. */
const GROUND_SCALE = 1.2;

/** Dreiecke aus OBJ-Zeilen; `look` liefert je `usemtl`-Name Farbe oder Textur. */
export function sceneFromObj(lines: readonly string[], look: (material: string) => Look | undefined): Scene {
  const vertices: Vec3[] = [];
  const uvList: [number, number][] = [];
  const normalList: Vec3[] = [];
  interface Face { look: Look; object: number; verts: Vec3[]; uvs: ([number, number] | undefined)[]; normals: (Vec3 | undefined)[] }
  const faces: Face[] = [];
  let current: Look = { color: FALLBACK };
  const names = new Map<Look, string>();
  const objects: string[] = [];
  let triangles = 0;
  for (const line of lines) {
    const [kind, ...rest] = line.split(' ');
    if (kind === 'v') vertices.push([Number(rest[0]), Number(rest[1]), Number(rest[2])]);
    else if (kind === 'vt') uvList.push([Number(rest[0]), Number(rest[1])]);
    else if (kind === 'vn') normalList.push([Number(rest[0]), Number(rest[1]), Number(rest[2])]);
    else if (kind === 'o') objects.push(rest.join(' '));
    else if (kind === 'usemtl') {
      current = look(rest[0]) ?? { color: FALLBACK };
      if (!names.has(current)) names.set(current, rest[0]);
    }
    else if (kind === 'f') {
      const refs = rest.map((ref) => ref.split('/'));
      faces.push({
        look: current,
        object: Math.max(0, objects.length - 1),
        verts: refs.map((r) => vertices[Number(r[0]) - 1]),
        uvs: refs.map((r) => uvList[Number(r[1]) - 1]),
        normals: refs.map((r) => normalList[Number(r[2]) - 1]),
      });
      triangles += refs.length - 2;
    }
  }

  // Ein Batch je Look: erst zählen, dann in einem Rutsch füllen (Fächer-Triangulierung).
  const counts = new Map<Look, number>();
  for (const f of faces) counts.set(f.look, (counts.get(f.look) ?? 0) + (f.verts.length - 2) * 3);
  const positions = new Float32Array(triangles * 9);
  const normals = new Float32Array(triangles * 9);
  const uvs = new Float32Array(triangles * 6);
  const batches: Batch[] = [];
  const cursor = new Map<Look, number>();
  let first = 0;
  for (const [batchLook, count] of counts) {
    batches.push({ look: batchLook, name: names.get(batchLook) ?? 'Material', first, count });
    cursor.set(batchLook, first);
    first += count;
  }
  // Innerhalb eines Batches liegen die Flächen eines Objekts beieinander.
  const order = [...counts.keys()];
  const sorted = faces.toSorted((a, b) => order.indexOf(a.look) - order.indexOf(b.look) || a.object - b.object);
  const parts: Part[] = [];
  let top = 0.1, radius = 0.1;
  for (const f of sorted) {
    let at = cursor.get(f.look) ?? 0;
    const batch = order.indexOf(f.look);
    const part = parts.at(-1);
    if (part && part.batch === batch && part.object === f.object) {
      parts[parts.length - 1] = { ...part, count: part.count + (f.verts.length - 2) * 3 };
    } else {
      parts.push({ name: objects[f.object] ?? 'Object', object: f.object, batch, first: at, count: (f.verts.length - 2) * 3 });
    }
    const [a, b, c] = [f.verts[0], f.verts[1], f.verts[2]];
    // Flache Normale der Fläche - die Seiten sind nicht einheitlich gewunden,
    // der Shader dreht sie zum Auge.
    const u: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const w: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n: Vec3 = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    for (const p of f.verts) {
      top = Math.max(top, p[1]);
      radius = Math.max(radius, Math.hypot(p[0], p[2]));
    }
    for (let i = 1; i + 1 < f.verts.length; i++) {
      for (const k of [0, i, i + 1]) {
        positions.set(f.verts[k], at * 3);
        // vn aus dem OBJ (runde Stämme), sonst die flache Flächennormale.
        normals.set(f.normals[k] ?? n, at * 3);
        uvs.set(f.uvs[k] ?? [0, 0], at * 2);
        at++;
      }
    }
    cursor.set(f.look, at);
  }
  return { positions, normals, uvs, batches, parts, triangles, top, radius };
}

// --- WebGL: ein gemeinsamer Kontext für alle Vorschauen ---------------------

const VERTEX_SOURCE = `#version 300 es
in vec3 aPos;
in vec3 aNormal;
in vec2 aUV;
uniform mat4 uMVP;
uniform mat3 uRot;      // Drehung der Ansicht - für die Normale
uniform float uScale;   // 1 für den Baum, Kronenradius für die Boden-Scheibe
out vec3 vNormal;
out vec2 vUV;
void main() {
  vNormal = uRot * aNormal;
  vUV = aUV;
  gl_Position = uMVP * vec4(aPos * uScale, 1.0);
}`;

const FRAGMENT_SOURCE = `#version 300 es
precision mediump float;
uniform int uMode;      // 0 Farbe, 1 Foto, 2 unbeleuchtet (Boden)
uniform vec3 uColor;    // Farbe bzw. Einfärbung des Fotos
uniform sampler2D uTex;
in vec3 vNormal;
in vec2 vUV;
out vec4 outColor;
const vec3 LIGHT = normalize(vec3(0.45, 0.75, 0.5));
void main() {
  if (uMode == 2) { outColor = vec4(uColor, 1.0); return; }
  vec3 n = normalize(vNormal);
  if (n.z < 0.0) n = -n; // immer die dem Auge zugewandte Seite
  float light = max(0.0, dot(n, LIGHT));
  if (uMode == 1) {
    // Vormultipliziert hochgeladen, damit die Mipmaps an den Blatträndern
    // nicht ins Durchsichtige (Schwarz) mitteln - hier wieder herausteilen.
    vec4 t = texture(uTex, vUV);
    if (t.a < 0.05) discard;
    vec3 photo = t.rgb / max(t.a, 0.01);
    // In groben Mipmap-Stufen sinkt das Alpha der Blattmassen - steil auf
    // deckend ziehen, sonst dünnen die Kronen von Weitem aus und werden dunkel
    // (die MSAA-Abdeckung wiederholt je Stufe dasselbe Muster, Lücken bleiben Lücken).
    float a = clamp((t.a - 0.12) / 0.2, 0.0, 1.0);
    // Fotos sind schon "beleuchtet" - nur abdunkeln, nie aufhellen. Die
    // Ausgabe vormultipliziert, so mischt das Kopieren auf die Seite richtig.
    outColor = vec4(photo * uColor * ((0.45 + 0.75 * light) / 1.2) * a, a);
  } else {
    outColor = vec4(min(vec3(1.0), uColor * (0.45 + 0.75 * light)), 1.0);
  }
}`;

interface SceneBuffers { vao: WebGLVertexArrayObject; count: number }

interface Renderer {
  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGL2RenderingContext;
  readonly locations: Record<'uMVP' | 'uRot' | 'uScale' | 'uMode' | 'uColor' | 'uTex', WebGLUniformLocation | null>;
  readonly ground: SceneBuffers;
  readonly scenes: WeakMap<Scene, SceneBuffers>;
  readonly textures: WeakMap<Texture, WebGLTexture>;
}

let shared: Renderer | null | undefined;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'Shader-Fehler');
  return shader;
}

function upload(gl: WebGL2RenderingContext, positions: Float32Array, normals: Float32Array, uvs: Float32Array): SceneBuffers {
  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  for (const [index, data, size] of [[0, positions, 3], [1, normals, 3], [2, uvs, 2]] as const) {
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(index);
    gl.vertexAttribPointer(index, size, gl.FLOAT, false, 0, 0);
  }
  gl.bindVertexArray(null);
  return { vao, count: positions.length / 3 };
}

/** Boden: Einheitsscheibe auf y = 0, uScale macht daraus den Kronenradius. */
function groundDisc(gl: WebGL2RenderingContext): SceneBuffers {
  const n = 64;
  const positions = new Float32Array(n * 9);
  const at = (k: number): [number, number] => [Math.cos((k / n) * 2 * Math.PI), Math.sin((k / n) * 2 * Math.PI)];
  for (let k = 0; k < n; k++) {
    const [x0, z0] = at(k), [x1, z1] = at(k + 1);
    positions.set([0, 0, 0, x0, 0, z0, x1, 0, z1], k * 9);
  }
  const normals = new Float32Array(n * 9);
  for (let k = 0; k < n * 3; k++) normals[k * 3 + 1] = 1;
  return upload(gl, positions, normals, new Float32Array(n * 6));
}

function renderer(): Renderer | null {
  if (shared !== undefined) return shared;
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2', { antialias: true });
  if (!gl) return (shared = null);
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SOURCE));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SOURCE));
  for (const [index, name] of [[0, 'aPos'], [1, 'aNormal'], [2, 'aUV']] as const) gl.bindAttribLocation(program, index, name);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'Link-Fehler');
  gl.useProgram(program);
  const locations = Object.fromEntries((['uMVP', 'uRot', 'uScale', 'uMode', 'uColor', 'uTex'] as const)
    .map((name) => [name, gl.getUniformLocation(program, name)])) as Renderer['locations'];
  gl.enable(gl.DEPTH_TEST);
  // Weiche Blattränder trotz Tiefentest: Alpha steuert die MSAA-Abdeckung.
  gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  shared = { canvas, gl, locations, ground: groundDisc(gl), scenes: new WeakMap(), textures: new WeakMap() };
  return shared;
}

function textureOf(r: Renderer, texture: Texture): WebGLTexture {
  let t = r.textures.get(texture);
  if (!t) {
    const { gl } = r;
    t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    // OBJ-Konvention: v = 0 ist unten im Bild - Bilder darum gespiegelt hochladen.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, texture.image);
    gl.generateMipmap(gl.TEXTURE_2D);
    const wrap = texture.tile ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    r.textures.set(texture, t);
  }
  return t;
}

export function render(canvas: HTMLCanvasElement, scene: Scene | null, view: View): void {
  const target = canvas.getContext('2d');
  if (!target) return;
  const W = (canvas.width = canvas.clientWidth * devicePixelRatio);
  const H = (canvas.height = canvas.clientHeight * devicePixelRatio);
  const r = renderer();
  if (!r) {
    target.fillStyle = '#1b1d1a';
    target.fillRect(0, 0, W, H);
    target.fillStyle = '#9a9c94';
    target.font = `${13 * devicePixelRatio}px system-ui`;
    target.fillText('WebGL2 nicht verfügbar', 12, 24);
    return;
  }
  const { gl, locations } = r;
  if (r.canvas.width !== W || r.canvas.height !== H) {
    r.canvas.width = W;
    r.canvas.height = H;
  }
  gl.viewport(0, 0, W, H);
  gl.clearColor(...BACKGROUND, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  if (scene) {
    // Bildausschnitt wie bisher: die ganze Pflanze samt Boden-Scheibe im Bild.
    const { top, radius } = scene;
    const scale = view.zoom * 0.85 * Math.min(H / (top + radius * 0.5), W / (2 * radius + 1));
    const ox = W / 2, oy = H / 2 + (top * scale) / 2;
    const cy = Math.cos(view.yaw), sy = Math.sin(view.yaw), cp = Math.cos(view.pitch), sp = Math.sin(view.pitch);
    // Ansicht: erst um die Hochachse drehen, dann kippen - Zeilen der 3x3-Matrix.
    const rot = [cy, 0, sy, sy * sp, cp, -cy * sp, -sy * cp, sp, cy * cp];
    const ax = (2 * scale) / W, ay = (2 * scale) / H, az = -1 / (top + 2 * radius + 1);
    const mvp = [
      ax * rot[0], ay * rot[3], az * rot[6], 0,
      ax * rot[1], ay * rot[4], az * rot[7], 0,
      ax * rot[2], ay * rot[5], az * rot[8], 0,
      (2 * ox) / W - 1, 1 - (2 * oy) / H, 0, 1,
    ];
    gl.uniformMatrix4fv(locations.uMVP, false, mvp);
    // uRot ist spaltenweise - die Drehung oben zeilenweise, also transponieren.
    gl.uniformMatrix3fv(locations.uRot, true, rot);
    gl.uniform1i(locations.uTex, 0);

    gl.uniform1i(locations.uMode, 2);
    gl.uniform3fv(locations.uColor, GROUND);
    gl.uniform1f(locations.uScale, radius * GROUND_SCALE);
    gl.bindVertexArray(r.ground.vao);
    gl.drawArrays(gl.TRIANGLES, 0, r.ground.count);

    let buffers = r.scenes.get(scene);
    if (!buffers) {
      buffers = upload(gl, scene.positions, scene.normals, scene.uvs);
      r.scenes.set(scene, buffers);
    }
    gl.uniform1f(locations.uScale, 1);
    gl.bindVertexArray(buffers.vao);
    for (const { look, first, count } of scene.batches) {
      if ('texture' in look) {
        gl.uniform1i(locations.uMode, 1);
        gl.uniform3fv(locations.uColor, look.texture.tint);
        gl.bindTexture(gl.TEXTURE_2D, textureOf(r, look.texture));
      } else {
        gl.uniform1i(locations.uMode, 0);
        gl.uniform3fv(locations.uColor, look.color);
      }
      gl.drawArrays(gl.TRIANGLES, first, count);
    }
    gl.bindVertexArray(null);
  }
  target.clearRect(0, 0, W, H);
  target.drawImage(r.canvas, 0, 0);
}
