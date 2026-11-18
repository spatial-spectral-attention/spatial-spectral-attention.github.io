// cortex.js v2 - shared cortex-mesh toolkit for the talk demos (three.js r169, no build step).
// See ../README.md for the API and the data contract. Import via the importmap mapping "three" -> ../vendor/three/three.module.js
//
//   MeshData     shared per (mesh name): manifest, level buffers, normals, gathered attributes.  Cortex instances of the same mesh
//                share ALL geometry buffers (position/normal/index/sulc); only colour layers (aTint, aScal, ...) are per instance.
//   Cortex       one displayed instance: material (built-in layers + extension API), LOD, layers, picking.
//   createMultiViewer / createViewer   one WebGL context, N scissored viewports, linked or independent cameras, render on demand.
//   createMarker / makeShadowPlane / createPatchPalette   small helpers.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export { THREE };
const MESH_BASE = new URL('../assets/mesh/', import.meta.url).href;

// ----------------------------------------------------------------------------------------------
// Looks. Colours are LINEAR rgb. 'blender' is tuned against the Blender clip (cortex-teaser.mp4); 'flat' is the old v1 look.
export const LOOKS = {
  blender: { gyri: [0.70, 0.70, 0.70], sulci: [0.30, 0.31, 0.35], sulcRange: [-0.9, 0.7], ramp: 'linear',
             hemi: 0.8, key: 2.0, fill: 0.3, ao: false, bakedAO: 0.55, ground: 0xe6e4e0 },
  flat:    { gyri: [0.78, 0.76, 0.73], sulci: [0.22, 0.23, 0.26], sulcRange: [-0.85, 0.05], ramp: 'smooth',
             hemi: 1.55, key: 1.5 * Math.PI * 0.55, fill: 0.35 * Math.PI * 0.5, ao: false, bakedAO: 0, ground: 0xe6e4e0 },
};
export const LOOK = LOOKS.blender;                       // back-compat alias
/** name | partial object (merged over 'blender') -> full look */
export function resolveLook(l) {
  if (!l) return LOOKS.blender;
  if (typeof l === 'string') { if (!LOOKS[l]) throw new Error('unknown look ' + l); return LOOKS[l]; }
  return { ...LOOKS.blender, ...l };
}

// Colour maps (linear rgb). mode 'div': symmetric about the range mid, neg-mid-pos. mode 'seq': neg -> mid -> pos over [lo,hi].
export const CMAPS = {
  diverging:  { mode: 'div', neg: [0.17, 0.35, 0.78], mid: [0.97, 0.97, 0.97], pos: [0.78, 0.12, 0.12] },
  sequential: { mode: 'seq', neg: [0.99, 0.96, 0.80], mid: [0.93, 0.45, 0.25], pos: [0.30, 0.08, 0.38] },
  teal:       { mode: 'div', neg: [0.0, 0.462, 0.418], mid: [0.97, 0.97, 0.97], pos: [0.73, 0.323, 0.033] },   // talk palette: teal - white - orange
};

// ----------------------------------------------------------------------------------------------
// Native attributes
/** Fetch a per-native-vertex attribute. type: f32|u8|rgb8|rgb32|f32x2|f32x3 (see write_attr.py).
 *  Returns {array: Float32Array(n*itemSize), itemSize, n}. rgb8 is returned as 0..1 floats (sRGB-encoded colour). */
export async function fetchNativeAttr(url, type = 'f32') {
  const buf = await (await ok(await fetch(url), url)).arrayBuffer();
  let array, itemSize = 1;
  switch (type) {
    case 'f32': array = new Float32Array(buf); break;
    case 'u8': array = Float32Array.from(new Uint8Array(buf)); break;
    case 'rgb8': array = Float32Array.from(new Uint8Array(buf), (x) => x / 255); itemSize = 3; break;
    case 'rgb32': case 'f32x3': array = new Float32Array(buf); itemSize = 3; break;
    case 'f32x2': array = new Float32Array(buf); itemSize = 2; break;
    default: {
      const m = /^u8x(\d+)$/.exec(type);                               // u8x8: N bytes per vertex, returned normalised to 0..1
      if (!m) throw new Error('unknown attr type ' + type);
      itemSize = +m[1]; array = Float32Array.from(new Uint8Array(buf), (x) => x / 255);
    }
  }
  return { array, itemSize, n: array.length / itemSize };
}
/** Wrap an in-memory Float32Array (n*itemSize) as a native attribute (e.g. computed in JS). The array is NOT copied if it is a Float32Array. */
export function nativeAttr(array, itemSize = 1) {
  return { array: array instanceof Float32Array ? array : Float32Array.from(array), itemSize, n: array.length / itemSize };
}
/** attr[nat[i]] for every level vertex; nat==null means identity (returns the native array itself, no copy). */
export function gather(attr, nat) {
  if (!nat) return attr.array;
  const out = new Float32Array(nat.length * attr.itemSize); gatherInto(out, attr, nat); return out;
}
function gatherInto(out, attr, nat) {
  const k = attr.itemSize, a = attr.array;
  if (!nat) { if (out !== a) out.set(a); return out; }
  if (k === 1) for (let i = 0; i < nat.length; i++) out[i] = a[nat[i]];
  else for (let i = 0; i < nat.length; i++) for (let c = 0; c < k; c++) out[i * k + c] = a[nat[i] * k + c];
  return out;
}
async function ok(r, url) { if (!r.ok) throw new Error(`fetch ${url}: ${r.status}`); return r; }
const getJSON = async (u) => (await ok(await fetch(u), u)).json();
const getBuf = async (u, T) => new T(await (await ok(await fetch(u), u)).arrayBuffer());
const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };

// ----------------------------------------------------------------------------------------------
// MeshData: everything that can be shared between Cortex instances of one mesh
const MESHES = new Map();
class MeshData {
  constructor(name, manifest, base) {
    this.name = name; this.manifest = manifest; this.base = base + name + '/';
    this.loaded = new Map();            // level -> {idx, nat, pos:{surf}, normals:{surf}}   (filled as buffers arrive)
    this._lv = {}; this._sf = {};       // promises
    this._attrs = {}; this._attrIndex = null;
    this._cache = new Map();            // shared BufferAttributes
  }
  /** index + nat of a level */
  level(li) {
    return this._lv[li] ??= (async () => {
      const L = this.manifest.levels[li];
      const idx = await getBuf(this.base + L.indices, L.indexType === 'u16' ? Uint16Array : Uint32Array);
      const nat = L.nat ? await getBuf(this.base + L.nat, Uint32Array) : null;
      const e = this.loaded.get(li) ?? { pos: {}, normals: {} }; e.idx = idx; e.nat = nat; this.loaded.set(li, e);
      return e;
    })();
  }
  /** positions + vertex normals of a level on one surface */
  surface(li, s) {
    const key = li + '|' + s;
    return this._sf[key] ??= (async () => {
      const e = await this.level(li), L = this.manifest.levels[li];
      const pos = await getBuf(this.base + L.pos[s], Float32Array);
      const g = new THREE.BufferGeometry();
      g.setIndex(new THREE.BufferAttribute(e.idx, 1)); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.computeVertexNormals(); e.normals[s] = g.getAttribute('normal').array; g.dispose();
      e.pos[s] = pos; return e;
    })();
  }
  ready(li, surfs) { const e = this.loaded.get(li); return !!e && !!e.idx && surfs.every((s) => e.pos[s] && e.normals[s]); }
  attr(name) {
    return this._attrs[name] ??= (async () => {
      this._attrIndex ??= await getJSON(this.base + 'attrs.json');
      const a = this._attrIndex[name]; if (!a) throw new Error(`no attribute '${name}' for ${this.name}`);
      return fetchNativeAttr(this.base + a.file, a.type);
    })();
  }
  labels() { return this._labels ??= getJSON(this.base + 'labels.json'); }
  /** baked per-vertex AO (assets/ao/<mesh>_<surface>.u8, 255 = open) or null when not available */
  ao(surf) {
    return this._ao ??= {}, this._ao[surf] ??= fetchNativeAttr(this.base + `../../ao/${this.name}_${surf}.u8`, 'u8').then((a) => ({ ...a, array: a.array.map((x) => x / 255) }))   // 0 occluded .. 255 open.catch(() => null);
  }
  /** shared BufferAttribute (cached): the native attribute `native` gathered to level li */
  shared(key, make) { let a = this._cache.get(key); if (!a) { a = make(); this._cache.set(key, a); } return a; }
}
async function getMeshData(name, base) {
  const key = base + name;
  if (!MESHES.has(key)) MESHES.set(key, getJSON(base + name + '/manifest.json').then((m) => new MeshData(name, m, base)));
  return MESHES.get(key);
}

// ----------------------------------------------------------------------------------------------
// Material. MeshStandardMaterial + injected: sulc two-tone ramp, tint A/B (+crossfade), scalar colormap, body tint, label wipe, A/B morph.
// All of it is composed from GLSL chunks (no string matching on user side). Extension API: Cortex.extend(spec), see README.
const GLSL_VERT_HEAD = /* glsl */`
attribute float aSulc; attribute float aAO; attribute vec3 aTint; attribute vec3 aTintB; attribute float aScal; attribute float aSweep; attribute vec3 aLab;
varying float vSulc; varying float vAO; varying vec3 vTint; varying vec3 vTintB; varying float vScal; varying float vSweep; varying vec3 vLab;`;
const GLSL_VERT_MAIN = 'vSulc = aSulc; vAO = aAO; vTint = aTint; vTintB = aTintB; vScal = aScal; vSweep = aSweep; vLab = aLab;';
const GLSL_FRAG_HEAD = /* glsl */`
varying float vSulc; varying float vAO; varying vec3 vTint; varying vec3 vTintB; varying float vScal; varying float vSweep; varying vec3 vLab;
uniform float uAO, uMorph;
uniform vec3 uGyri, uSulci, uBodyTint, uCmapNeg, uCmapMid, uCmapPos;
uniform vec2 uSulcRange, uScalRange;
uniform float uRamp, uShadeAmt, uTint, uTintB, uTintMix, uTintMode, uScalMix, uCmapSeq, uBodyMix, uPaint, uPaintSoft, uPaintDark;
vec3 cxCmap(float v){
  if (uCmapSeq > .5) { float t = clamp((v-uScalRange.x)/(uScalRange.y-uScalRange.x), 0., 1.); return t < .5 ? mix(uCmapNeg, uCmapMid, t*2.) : mix(uCmapMid, uCmapPos, t*2.-1.); }
  float s = clamp((v*2. - (uScalRange.x+uScalRange.y)) / (uScalRange.y-uScalRange.x), -1., 1.);
  return s < 0. ? mix(uCmapMid, uCmapNeg, -s) : mix(uCmapMid, uCmapPos, s);
}
vec3 cxTint(vec3 t, float amt, vec3 baseC, vec3 shadeK){        // tint attribute is sRGB; mode 0 multiply on grey, mode 1 shaded flat colour
  vec3 tl = pow(clamp(t, 0., 1.), vec3(2.2));
  vec3 m = baseC * mix(vec3(1.), tl, amt * (1. - uTintMode));
  return mix(m, tl * shadeK * 0.95, amt * uTintMode);
}`;
const GLSL_FRAG_MAIN = /* glsl */`
float cxT = clamp((vSulc - uSulcRange.x) / (uSulcRange.y - uSulcRange.x), 0., 1.);
float sT = mix(cxT*cxT*(3. - 2.*cxT), cxT, uRamp) * uShadeAmt;     // cavity darkness 0..1 (smoothstep or linear ramp)
vec3 baseC = mix(uGyri, uSulci, sT);                                // two-tone sulc shading
vec3 shadeK = baseC / uGyri;                                        // relative cavity darkening (for flat colours)
vec3 col = baseC;
if (uTint > 0. || uTintB > 0.) {
  col = cxTint(vTint, uTint, baseC, shadeK);
  if (uTintMix > 0.) col = mix(col, cxTint(vTintB, uTintB, baseC, shadeK), uTintMix);
}
if (uScalMix > 0.) col = mix(col, cxCmap(vScal) * mix(vec3(1.), shadeK, 0.85), uScalMix);
col *= mix(vec3(1.), uBodyTint, uBodyMix);
col *= mix(1., pow(clamp(vAO, 0., 1.), 0.6), uAO * (1. - uMorph));                              // baked per-vertex ambient occlusion (fades out while morphing)
if (uPaint > -1.) col = mix(col, pow(clamp(vLab, 0., 1.), vec3(2.2)) * mix(1., uPaintDark, sT), smoothstep(0., uPaintSoft, uPaint - vSweep));`;

const _col = (a) => new THREE.Color().setRGB(a[0], a[1], a[2], THREE.LinearSRGBColorSpace);
function makeUniforms(look) {
  return {
    uMorph: { value: 0 }, uGyri: { value: _col(look.gyri) }, uSulci: { value: _col(look.sulci) },
    uSulcRange: { value: new THREE.Vector2(...look.sulcRange) }, uRamp: { value: look.ramp === 'linear' ? 1 : 0 }, uShadeAmt: { value: 1 },
    uTint: { value: 0 }, uTintB: { value: 0 }, uTintMix: { value: 0 }, uTintMode: { value: 0 },
    uScalMix: { value: 0 }, uScalRange: { value: new THREE.Vector2(-1, 1) }, uCmapSeq: { value: 0 },
    uCmapNeg: { value: _col(CMAPS.diverging.neg) }, uCmapMid: { value: _col(CMAPS.diverging.mid) }, uCmapPos: { value: _col(CMAPS.diverging.pos) },
    uBodyTint: { value: new THREE.Vector3(1, 1, 1) }, uBodyMix: { value: 0 },
    uAO: { value: 0 }, uPaint: { value: -2 }, uPaintSoft: { value: 0.10 }, uPaintDark: { value: 0.8 },
  };
}
function patchMorph(shader, U) {
  Object.assign(shader.uniforms, U);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec3 positionB; attribute vec3 normalB; uniform float uMorph;')
    .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nobjectNormal = normalize(mix(normal, normalB, uMorph));')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed = mix(position, positionB, uMorph);');
}
const glslType = (v) => {
  if (typeof v === 'number') return 'float';
  if (v?.isColor || v?.isVector3) return 'vec3'; if (v?.isVector2) return 'vec2'; if (v?.isVector4) return 'vec4';
  if (v?.isMatrix3) return 'mat3'; if (v?.isMatrix4) return 'mat4';
  if (Array.isArray(v) || ArrayBuffer.isView(v)) return `${Array.isArray(v) && v.length ? glslType(v[0]) : 'float'}[${v.length}]`;
  throw new Error('cannot infer GLSL type of uniform; pass {type}');
};
const declU = (name, type) => { const m = /^(\w+)\[(\d+)\]$/.exec(type); return m ? `uniform ${m[1]} ${name}[${m[2]}];` : `uniform ${type} ${name};`; };
/** compose the GLSL for the built-ins + extensions. Returns {vHead, vMain, fHead, fMain, uniforms, key} */
function compose(exts) {
  let vHead = GLSL_VERT_HEAD, vMain = GLSL_VERT_MAIN, fHead = GLSL_FRAG_HEAD, fMain = GLSL_FRAG_MAIN; const uniforms = {};
  for (const e of exts) {
    for (const [n, u] of Object.entries(e.uniforms ?? {})) { uniforms[n] = u; const d = declU(n, u.type ?? glslType(u.value)); vHead += '\n' + d; fHead += '\n' + d; }
    for (const [n, a] of Object.entries(e.attributes ?? {})) {
      const t = typeof a === 'string' ? a : a.type, flat = typeof a === 'object' && a.flat, vn = /^a[A-Z]/.test(n) ? 'v' + n.slice(1) : 'v_' + n;
      vHead += `\nattribute ${t} ${n}; ${flat ? 'flat ' : ''}varying ${t} ${vn};`; fHead += `\n${flat ? 'flat ' : ''}varying ${t} ${vn};`; vMain += `\n${vn} = ${n};`;
    }
    if (e.vertexHead) vHead += '\n' + e.vertexHead; if (e.fragmentHead) fHead += '\n' + e.fragmentHead;
    if (e.vertex) vMain += '\n' + e.vertex; if (e.fragment) fMain += `\n{\n${e.fragment}\n}`;
  }
  return { vHead, vMain, fHead, fMain, uniforms, key: 'cortex2:' + hash(vHead + vMain + fHead + fMain) };
}
function makeMaterial(owner) {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0 });
  m.onBeforeCompile = (shader) => {
    const P = owner._parts; Object.assign(shader.uniforms, owner.uniforms, P.uniforms);
    patchMorph(shader, {});
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\n' + P.vHead)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + P.vMain);
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\n' + P.fHead)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${P.fMain}\ndiffuseColor.rgb = col;`);
  };
  m.customProgramCacheKey = () => owner._parts.key;
  return m;
}

// ----------------------------------------------------------------------------------------------
const BUILTIN_LAYERS = { aTint: 3, aTintB: 3, aScal: 1, aSweep: 1, aLab: 3 };
const ease3 = (t) => t * t * (3 - 2 * t);
export class Cortex {
  constructor(data, opts) {
    this.data = data; this.name = data.name; this.manifest = data.manifest; this.opts = opts;
    this.levelsAvail = opts.levels ?? data.manifest.levels.map((_, i) => i);
    this.surfA = opts.surface ?? 'pial'; this.surfB = this.surfA;
    this.look = resolveLook(opts.look);
    this.uniforms = makeUniforms(this.look);
    this._exts = new Map(); this._parts = compose([]);
    this.material = makeMaterial(this);
    this.root = new THREE.Group(); this.root.name = 'cortex-' + this.name;
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.mesh.frustumCulled = false;                    // morph changes extent; bounding sphere is approximate
    this.root.add(this.mesh);
    this.wireMesh = null;
    this.level = -1; this.geoms = new Map();            // per-instance geometries (share buffers with MeshData)
    this.layers = new Map();                            // geometry attr name -> {native, version}
    this.onLevelChange = null; this.onChange = null; this._ls = new Set();
    this.pxPerTri = opts.pxPerTri ?? 2.0;               // CSS px^2 per front-facing triangle above which we go finer (coarser below /2.2); DPR-independent
    this.forceLevel = null;                             // set to an int to disable auto LOD
    this.sulcName = opts.sulc ?? 'sulc';
    this._hasTint = false; this._tintStrength = 1; this._fade = null;
    this.radius = 1; this.center = new THREE.Vector3(); this.bbox = null;
  }
  get nNative() { return this.manifest.nNative; }
  get info() { const L = this.manifest.levels[this.level]; return L ? { level: this.level, tris: L.tris, verts: L.verts } : null; }
  get nat() { return this.data.loaded.get(this.level)?.nat ?? null; }
  get loaded() { return this.data.loaded; }
  /** Notify the viewers showing this cortex that it needs a redraw. */
  invalidate() { this.onChange?.(); for (const f of this._ls) f(); }

  // ---- loading ---------------------------------------------------------------------------
  /** Resolves when the coarsest requested level is displayable. Starts background loading of the finer ones. */
  async init() {
    const first = this.levelsAvail[0], D = this.data;
    await Promise.all([D.surface(first, this.surfA), D.surface(first, this.surfB)]);
    this.sulc = await D.attr(this.sulcName);
    const bak = this.opts.bakedAO ?? this.look.bakedAO;
    if (bak) { const ao = await D.ao(this.surfA); if (ao) { this.layers.set('aAO', { native: ao, version: 1 }); this.uniforms.uAO.value = bak === true ? 1 : bak; this.hasAO = true; } }
    const p = D.loaded.get(first).pos[this.surfA], n = p.length / 3, c = this.center.set(0, 0, 0);
    const mn = new THREE.Vector3(1e9, 1e9, 1e9), mx = new THREE.Vector3(-1e9, -1e9, -1e9);
    for (let i = 0; i < p.length; i += 3) { c.x += p[i] / n; c.y += p[i + 1] / n; c.z += p[i + 2] / n;
      mn.x = Math.min(mn.x, p[i]); mx.x = Math.max(mx.x, p[i]); mn.y = Math.min(mn.y, p[i + 1]); mx.y = Math.max(mx.y, p[i + 1]); mn.z = Math.min(mn.z, p[i + 2]); mx.z = Math.max(mx.z, p[i + 2]); }
    this.radius = 0; for (let i = 0; i < p.length; i += 3) this.radius = Math.max(this.radius, Math.hypot(p[i] - c.x, p[i + 1] - c.y, p[i + 2] - c.z));
    /** axis-aligned bounds of the first level on surface A: {min,max,center,half} */
    this.bbox = { min: mn, max: mx, center: mn.clone().add(mx).multiplyScalar(0.5), half: mx.clone().sub(mn).multiplyScalar(0.5) };
    this._setLevel(first);
    if (this.opts.prefetch !== false) (async () => { for (const li of this.levelsAvail.slice(1)) { await Promise.all([D.surface(li, this.surfA), D.surface(li, this.surfB)]); this.invalidate(); } })();
    return this;
  }
  /** Named per-native-vertex attribute from attrs.json (cached, shared between instances) */
  attr(name) { return this.data.attr(name); }
  labels() { return this.data.labels(); }

  // ---- geometry per level (buffers shared via MeshData) ---------------------------------------
  _geometry(li) {
    const key = li + '|' + this.surfA + '|' + this.surfB;
    let g = this.geoms.get(key);
    const D = this.data, e = D.loaded.get(li), A = this.surfA, B = this.surfB;
    if (!g) {
      g = new THREE.BufferGeometry();
      g.setIndex(D.shared('idx' + li, () => new THREE.BufferAttribute(e.idx, 1)));
      g.setAttribute('position', D.shared(`pos${li}|${A}`, () => new THREE.BufferAttribute(e.pos[A], 3)));
      g.setAttribute('normal', D.shared(`nrm${li}|${A}`, () => new THREE.BufferAttribute(e.normals[A], 3)));
      g.setAttribute('positionB', D.shared(`pos${li}|${B}`, () => new THREE.BufferAttribute(e.pos[B], 3)));
      g.setAttribute('normalB', D.shared(`nrm${li}|${B}`, () => new THREE.BufferAttribute(e.normals[B], 3)));
      g.setAttribute('aSulc', D.shared(`sulc${li}|${this.sulcName}`, () => new THREE.BufferAttribute(gather(this.sulc, e.nat), 1)));
      g.boundingSphere = new THREE.Sphere(this.center.clone(), this.radius * 1.6);
      g.userData.ver = {}; this.geoms.set(key, g);
    }
    this._syncLayers(g, e);
    return g;
  }
  _syncLayers(g, e) {
    for (const [name, L] of this.layers) if (g.userData.ver[name] !== L.version) this._syncLayer(g, name, L, e);
    for (const name of Object.keys(g.userData.ver)) if (!this.layers.has(name)) { g.deleteAttribute(name); delete g.userData.ver[name]; }
  }
  _syncLayer(g, name, L, e) {
    const w = L.native, nat = e.nat; let a = g.getAttribute(name);
    if (!nat) { if (!a || a.array !== w.array || a.itemSize !== w.itemSize) g.setAttribute(name, new THREE.BufferAttribute(w.array, w.itemSize)); else a.needsUpdate = true; }
    else {
      if (!a || a.itemSize !== w.itemSize || a.count !== nat.length) { a = new THREE.BufferAttribute(new Float32Array(nat.length * w.itemSize), w.itemSize); g.setAttribute(name, a); }
      gatherInto(a.array, w, nat); a.needsUpdate = true;
    }
    g.userData.ver[name] = L.version;
  }
  _setLevel(li, force = false) {
    if (!force && li === this.level && this.mesh.geometry.getAttribute('position')) return;
    this.level = li;
    const g = this._geometry(li);
    this.mesh.geometry = g; if (this.wireMesh) this.wireMesh.geometry = g;
    this.onLevelChange?.(this.info, this);
    this.invalidate();
  }
  _resync() { if (this.level >= 0) { this._syncLayers(this.mesh.geometry, this.data.loaded.get(this.level)); this.invalidate(); } }

  // ---- surfaces / morph --------------------------------------------------------------------
  /** Choose the two position sets that `morph` blends between. e.g. await c.setSurfaces('pial','inflated'); c.morph = 0.5 */
  async setSurfaces(a, b = a) {
    this.surfA = a; this.surfB = b;
    await Promise.all([...this.data.loaded.keys()].flatMap((li) => [this.data.surface(li, a), this.data.surface(li, b)]));
    this.geoms.clear();                                  // regenerate (buffers stay shared)
    this._setLevel(this.level, true);
  }
  get morph() { return this.uniforms.uMorph.value; }
  set morph(t) { this.uniforms.uMorph.value = t; this.invalidate(); }

  // ---- look ------------------------------------------------------------------------------------
  /** Apply a look ('blender' | 'flat' | partial object): gyri/sulci colours, sulc range, ramp ('linear'|'smooth'). */
  setLook(look) {
    const L = this.look = resolveLook(look), U = this.uniforms;
    U.uGyri.value.copy(_col(L.gyri)); U.uSulci.value.copy(_col(L.sulci)); U.uSulcRange.value.set(...L.sulcRange); U.uRamp.value = L.ramp === 'linear' ? 1 : 0;
    this.invalidate();
  }
  /** 0 = no sulcal two-tone shading (flat grey), 1 = full. */
  set sulcShading(a) { this.uniforms.uShadeAmt.value = a; this.invalidate(); }
  get sulcShading() { return this.uniforms.uShadeAmt.value; }

  // ---- colour layers ------------------------------------------------------------------------
  /** Bind a native attribute to a geometry attribute (regathered lazily per level). native=null unbinds. Use with Cortex.extend(). */
  bind(geomName, native) {
    if (!native) this.layers.delete(geomName);
    else { const L = this.layers.get(geomName); if (L) { L.native = native; L.version++; } else this.layers.set(geomName, { native, version: 1 }); }
    this._resync();
  }
  /** After editing a bound native array IN PLACE (or replacing it with `native`), re-upload it for the current level; other levels
   *  regather lazily when they become current. */
  updateLayer(geomName, native) {
    const L = this.layers.get(geomName); if (!L) throw new Error('layer not bound: ' + geomName);
    if (native) L.native = native.array ? native : nativeAttr(native, L.native.itemSize);
    L.version++; this._resync();
  }
  /** In-place scalar update: c.updateScalar(float32Array[nNative]) (array becomes the bound scalar layer, no copy). */
  updateScalar(arr) { this.updateLayer('aScal', arr ? nativeAttr(arr, 1) : undefined); }
  /** RGB layer (nativeAttr with itemSize 3, sRGB 0..1) on the grey cortex. mode 'multiply' | 'shade' (flat colour with cavity shading). */
  setTint(native, { strength = 1, mode } = {}) {
    this._fade = null; this.uniforms.uTintMix.value = 0; this.uniforms.uTintB.value = 0; this.bind('aTintB', null);
    this._hasTint = !!native; this._tintStrength = strength;
    if (mode) this.uniforms.uTintMode.value = mode === 'shade' ? 1 : 0;
    this.bind('aTint', native); this._syncTint();
  }
  get tintStrength() { return this._tintStrength; }
  set tintStrength(s) { this._tintStrength = s; this._syncTint(); }
  _syncTint() { this.uniforms.uTint.value = this._hasTint ? this._tintStrength : 0; this.invalidate(); }
  /** Cross-fade from the current tint to `native` (null = untinted) over `ms` (driven by the viewer's frame loop; 0 = immediate).
   *  Uses a second tint attribute (aTintB) and `tintMix`; the fade is committed to the primary tint when done. */
  fadeTint(native, ms = 550, { mode = 'shade' } = {}) {
    if (this._fade) this._commitFade();
    if (!ms || ms <= 0) { this.setTint(native, { strength: 1, mode }); return; }
    this.uniforms.uTintMode.value = mode === 'shade' ? 1 : 0;
    this.bind('aTintB', native); this.uniforms.uTintB.value = native ? 1 : 0; this.uniforms.uTintMix.value = 0;
    this._fade = { t0: performance.now(), ms, native, mode }; this.invalidate();
  }
  _commitFade() { const f = this._fade; this._fade = null; this.setTint(f.native, { strength: 1, mode: f.mode }); }
  get tintMix() { return this.uniforms.uTintMix.value; }
  set tintMix(m) { this.uniforms.uTintMix.value = m; this.invalidate(); }
  /** called every viewer frame: advances fades. Returns true while animating. */
  tick(now) {
    const f = this._fade; if (!f) return false;
    const k = Math.min(1, (now - f.t0) / f.ms); this.uniforms.uTintMix.value = ease3(k);
    if (k >= 1) this._commitFade();
    return true;
  }
  /** Scalar layer rendered through a colormap. cmap: 'diverging' | 'sequential' | 'teal' | {mode:'div'|'seq', neg, mid, pos (linear rgb)}.
   *  'div' is symmetric about the range mid (neg < mid < pos); 'seq' runs neg -> mid -> pos over the range. */
  setScalar(native, { range = [-1, 1], cmap = 'diverging', mix = 1 } = {}) {
    const U = this.uniforms, M = typeof cmap === 'string' ? CMAPS[cmap] : cmap; if (!M) throw new Error('unknown cmap ' + cmap);
    U.uScalRange.value.set(range[0], range[1]); U.uCmapSeq.value = M.mode === 'seq' ? 1 : 0;
    U.uCmapNeg.value.copy(_col(M.neg)); U.uCmapMid.value.copy(_col(M.mid)); U.uCmapPos.value.copy(_col(M.pos));
    this.bind('aScal', native); this.scalarMix = native ? mix : 0;
  }
  get scalarMix() { return this.uniforms.uScalMix.value; }
  set scalarMix(m) { this.uniforms.uScalMix.value = m; this.invalidate(); }
  /** Multiplies the final colour by `rgb` (linear, e.g. [0.94,1.16,1.42]) with weight `bodyMix` (0..1). */
  setBodyTint(rgb, mix = 1) { this.uniforms.uBodyTint.value.set(...rgb); this.bodyMix = mix; }
  get bodyMix() { return this.uniforms.uBodyMix.value; }
  set bodyMix(m) { this.uniforms.uBodyMix.value = m; this.invalidate(); }
  /** Reveal wipe: colour `lab` (rgb sRGB 0..1) replaces the grey wherever `paint > sweep` (sweep = per-vertex reveal time/threshold).
   *  Animate `c.paint`; paint <= -1 disables. opts: soft (edge width, default .10), dark (sulcal darkening of the label colour, .8). */
  setPaint(lab, sweep, { soft = 0.10, dark = 0.8, paint } = {}) {
    this.uniforms.uPaintSoft.value = soft; this.uniforms.uPaintDark.value = dark;
    this.bind('aLab', lab); this.bind('aSweep', sweep); this.paint = paint ?? (lab ? -0.15 : -2);
  }
  get paint() { return this.uniforms.uPaint.value; }
  set paint(p) { this.uniforms.uPaint.value = p; this.invalidate(); }

  // ---- shader extension API ------------------------------------------------------------------------------
  /** Add (or replace, by name) a shader extension. spec = {
   *    name,                                   unique per cortex; re-extending with the same name replaces it
   *    uniforms:   { uFoo: {value, type?} },   GLSL type inferred from value (number, Color/Vector2-4, arrays -> 'vec3[8]'); the objects are used as-is
   *    attributes: { aPid: 'float' | {type:'float', flat:true} },   bind data with cortex.bind('aPid', nativeAttr); GLSL sees varying `vPid` (aXxx -> vXxx)
   *    vertexHead, fragmentHead:  GLSL declared at global scope (helper functions, extra varyings)
   *    vertex:     GLSL run in the vertex shader (after begin_vertex; `transformed`, `objectNormal` are available)
   *    fragment:   GLSL run after the built-in colour (own scope block). In scope: vec3 col (read/modify), baseC, shadeK, sT, vSulc, diffuseColor, + your varyings
   *  }
   *  Returns the spec's uniforms object. A unique customProgramCacheKey is derived automatically from the composed GLSL. */
  extend(spec) {
    const name = spec.name ?? 'ext' + this._exts.size;
    this._exts.set(name, spec); this._parts = compose([...this._exts.values()]);
    this.material.needsUpdate = true; this.invalidate();
    return spec.uniforms;
  }
  /** remove an extension by name */
  unextend(name) { if (this._exts.delete(name)) { this._parts = compose([...this._exts.values()]); this.material.needsUpdate = true; this.invalidate(); } }

  // ---- wireframe overlay ----------------------------------------------------------------------
  get wireframe() { return !!this.wireMesh?.visible; }
  set wireframe(on) {
    if (on && !this.wireMesh) {
      const m = new THREE.MeshBasicMaterial({ color: 0x20242a, wireframe: true, transparent: true, opacity: 0.35 });
      m.polygonOffset = true; m.polygonOffsetFactor = -1; m.polygonOffsetUnits = -1;
      m.onBeforeCompile = (s) => patchMorph(s, this.uniforms); m.customProgramCacheKey = () => 'cortex2-wire';
      this.wireMesh = new THREE.Mesh(this.mesh.geometry, m); this.wireMesh.frustumCulled = false;
      this.root.add(this.wireMesh);
    }
    if (this.wireMesh) this.wireMesh.visible = on;
    this.invalidate();
  }

  // ---- LOD -------------------------------------------------------------------------------------
  /** Zoom-aware level choice for one view. Estimates the screen px covered by the whole mesh (projected ellipsoid of the bbox, so it
   *  is NOT capped by the viewport: zooming in keeps raising px per triangle) divided by its front-facing triangles, with hysteresis.
   *  vw/vh = viewport size in CSS px. `moving`: drop one level (not below the 2nd) while the camera/animation is moving fast.
   *  Returns the wanted level (does not switch). */
  lodFor(camera, vw, vh, moving = false) {
    if (this.level < 0) return this.level;
    if (this.forceLevel != null) return this.forceLevel;
    const lv = this.manifest.levels, order = this.levelsAvail; let pos = Math.max(0, order.indexOf(this.level));
    const root = this.root; root.updateWorldMatrix(true, false);
    const wp = _v1.copy(this.bbox.center).applyMatrix4(root.matrixWorld), cp = camera.getWorldPosition(_v2);
    const sc = root.matrixWorld.getMaxScaleOnAxis();
    const d = Math.max(1e-3, wp.distanceTo(cp));
    const dir = _v2.sub(wp).normalize().applyQuaternion(root.getWorldQuaternion(_q).invert());          // view direction in cortex space
    const h = this.bbox.half, a = h.x * sc, b = h.y * sc, c = h.z * sc;
    const areaMm = Math.PI * Math.sqrt(b * b * c * c * dir.x * dir.x + a * a * c * c * dir.y * dir.y + a * a * b * b * dir.z * dir.z);
    const pxPerMm = camera.isPerspectiveCamera ? vh / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * d) : vh / ((camera.top - camera.bottom) / camera.zoom);
    const area = areaMm * pxPerMm * pxPerMm;
    const ppt = (li) => area / (lv[li].tris / 2);                    // px per front-facing triangle
    const hi = this.pxPerTri, lo = hi / 2.2;
    while (pos < order.length - 1 && ppt(order[pos]) > hi) pos++;                       // triangles too big on screen -> finer
    while (pos > 0 && ppt(order[pos - 1]) < lo) pos--;                                  // coarser level would still be dense enough
    this.lodPx = ppt(order[pos]);
    if (moving && pos > 1 && pos === order.length - 1) pos--;                          // motion: finest level -> one coarser, re-refined when idle
    return order[pos];
  }
  /** switch to `want` if its buffers are loaded (otherwise start loading it). */
  applyLevel(want) {
    if (want === this.level || want < 0) return;
    const D = this.data, need = [this.surfA, this.surfB];
    if (D.ready(want, need)) this._setLevel(want);
    else Promise.all(need.map((s) => D.surface(want, s))).then(() => this.invalidate());
  }
  /** single-view convenience (back-compat): choose and apply */
  updateLOD(camera, vw, vh) { this.applyLevel(this.lodFor(camera, vw, vh)); }  // vw/vh in CSS px

  // ---- picking -----------------------------------------------------------------------------------
  /** Raycast the current level; returns {native, levelVertex, point, position, distance, normal(local)} for the nearest triangle corner, or null. */
  pick(raycaster) {
    this.root.updateWorldMatrix(true, true);
    const h = raycaster.intersectObject(this.mesh, false)[0]; if (!h) return null;
    const g = this.mesh.geometry, P = g.getAttribute('position'), tmp = new THREE.Vector3();
    let best = h.face.a, bd = Infinity;
    const local = this.mesh.worldToLocal(h.point.clone());
    for (const v of [h.face.a, h.face.b, h.face.c]) { const d = tmp.fromBufferAttribute(P, v).distanceToSquared(local); if (d < bd) { bd = d; best = v; } }
    const nat = this.nat;
    return { native: nat ? nat[best] : best, levelVertex: best, point: h.point, position: tmp.fromBufferAttribute(P, best).clone(), distance: h.distance, cortex: this };
  }
  /** Position of a native vertex on surface `surf` (default current A) - works at any level via the native level L(last). */
  async nativePosition(i, surf = this.surfA) {
    const li = this.manifest.levels.length - 1, e = await this.data.surface(li, surf), p = e.pos[surf];
    return new THREE.Vector3(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
  }
  /** Unit vertex normal (cortex-local) of a native vertex on surface `surf`. */
  async nativeNormal(i, surf = this.surfA) {
    const li = this.manifest.levels.length - 1, e = await this.data.surface(li, surf), p = e.normals[surf];
    return new THREE.Vector3(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
  }
}
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q = new THREE.Quaternion();

/** loadCortex('source'|'target'|..., {surface:'pial'|'white'|'inflated', levels:[0,1,2], pxPerTri, prefetch, look, sulc, base})
 *  Instances of the same mesh share all geometry buffers and loaded data. Resolves (after the coarsest level is displayable) with a
 *  Cortex; finer levels stream in and swap automatically once the cortex is added to a viewer / view. */
export async function loadCortex(name, opts = {}) {
  const base = opts.base ?? MESH_BASE;
  const c = new Cortex(await getMeshData(name, base), { ...opts, base });
  await c.init();
  return c;
}

// ----------------------------------------------------------------------------------------------
// Helpers: sphere marker, shadow plane, per-patch palette

/** Screen-space disc markers (THREE.Points, constant pixel size, flat fill + anti-aliased stroke, like the 2D slides' dots).
 *  createMarkers(n, {radiusPx:5, strokePx:3, stroke:'#1d1f21', onTop:false, bias:1.5, faceFade:true, order:0}) -> Points with
 *    .set(i, {position:Vector3 (parent space, e.g. cortex.root), normal?:Vector3 (surface normal, for facing fade), color, radius (px), stroke (colour), alpha})
 *    .hide(i) .hideAll() .count
 *  Occlusion: depth-tested against the cortex with a small pull toward the camera (`bias`, mm) so dots on visible surface show and dots
 *  behind the brain hide; with a normal given, faceFade also fades dots by the facing of the surface (so dots on silhouettes/behind fade
 *  instead of popping). onTop:true ignores depth (always visible). Add to cortex.root. */
export function createMarkers(n, { radiusPx = 5, strokePx = 3, stroke = '#1d1f21', onTop = false, bias = 1.5, faceFade = true, order = 5 } = {}) {
  const g = new THREE.BufferGeometry(), A = (name, k) => { const a = new THREE.BufferAttribute(new Float32Array(n * k), k); g.setAttribute(name, a); return a; };
  const pos = A('position', 3), nrm = A('aNormal', 3), col = A('aColor', 3), strokeC = A('aStroke', 3), rad = A('aRadius', 1), alp = A('aAlpha', 1);
  const U = { uPR: { value: 1 }, uStroke: { value: strokePx }, uBias: { value: bias }, uFace: { value: faceFade ? 1 : 0 } };
  const m = new THREE.ShaderMaterial({
    uniforms: U, transparent: true, depthWrite: false, depthTest: !onTop,
    vertexShader: `uniform float uPR, uStroke, uBias, uFace; attribute vec3 aNormal, aColor, aStroke; attribute float aRadius, aAlpha;
      varying vec3 vC, vS; varying float vA, vSize, vR;
      void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.); vec3 toCam = normalize(-mv.xyz);
        float facing = dot(normalize(normalMatrix * aNormal), toCam);
        float fade = (uFace > .5 && dot(aNormal, aNormal) > .1) ? smoothstep(-0.05, 0.3, facing) : 1.;
        mv.xyz += toCam * uBias; gl_Position = projectionMatrix * mv;
        float R = aRadius + uStroke; vSize = (R + 1.) * 2. * uPR; vR = R * uPR; gl_PointSize = vSize; vC = aColor; vS = aStroke; vA = aAlpha * fade; }`,
    fragmentShader: `uniform float uPR, uStroke; varying vec3 vC, vS; varying float vA, vSize, vR;
      void main(){ float d = length(gl_PointCoord - .5) * vSize;           // px from centre
        float aa = 1.0, sw = uStroke * uPR;
        float outer = 1. - smoothstep(vR - aa, vR, d), inner = 1. - smoothstep(vR - sw - aa, vR - sw, d);
        vec3 c = mix(vS, vC, inner); float a = outer * vA; if (a < .003) discard;
        gl_FragColor = vec4(c, a);
        #include <colorspace_fragment>
      }`,
  });
  const P = new THREE.Points(g, m); P.frustumCulled = false; P.renderOrder = onTop ? 1000 + order : order; P.visible = true;
  P.onBeforeRender = (renderer) => { U.uPR.value = renderer.getPixelRatio(); };
  const c3 = new THREE.Color(), s3 = new THREE.Color();
  P.count = n;
  P.set = (i, { position, normal, color = '#ffffff', radius = radiusPx, stroke: sc = stroke, alpha = 1 } = {}) => {
    if (position) pos.setXYZ(i, position.x, position.y, position.z);
    if (normal) nrm.setXYZ(i, normal.x, normal.y, normal.z);
    c3.set(color); s3.set(sc);                                                      // inputs are sRGB hex/css; the shader outputs through colorspace_fragment
    col.setXYZ(i, c3.r, c3.g, c3.b); strokeC.setXYZ(i, s3.r, s3.g, s3.b); rad.setX(i, radius); alp.setX(i, alpha);
    for (const a of [pos, nrm, col, strokeC, rad, alp]) a.needsUpdate = true; return P;
  };
  P.hide = (i) => { alp.setX(i, 0); alp.needsUpdate = true; return P; };
  P.hideAll = () => { alp.array.fill(0); alp.needsUpdate = true; return P; };
  P.setAlpha = (i, a) => { alp.setX(i, a); alp.needsUpdate = true; return P; };
  P.strokePx = (px) => { U.uStroke.value = px; };
  for (let i = 0; i < n; i++) P.set(i, {}), P.hide(i);
  return P;
}
/** single disc marker (createMarkers(1)); same API with i = 0 */
export const createMarker = (opts = {}) => createMarkers(1, opts);

/** Soft contact-shadow plane (the Blender clip has a shadow-catcher ground). Horizontal (z-up scene), faint radial gradient.
 *  opts: size [w,h] (150x250), position [x,y,z] (default [-4,-4,-66]), opacity (1), strength (peak alpha .55). Add with view.add(). */
export function makeShadowPlane({ size = [150, 250], position = [-4, -4, -66], opacity = 1, strength = 0.55 } = {}) {
  const cv = document.createElement('canvas'); cv.width = cv.height = 256; const g = cv.getContext('2d');
  const gr = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  gr.addColorStop(0, `rgba(50,52,58,${strength})`); gr.addColorStop(0.45, `rgba(50,52,58,${strength * 0.545})`); gr.addColorStop(1, 'rgba(50,52,58,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(cv);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(size[0], size[1]), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity }));
  m.position.set(...position); m.renderOrder = -1; m.name = 'shadow-plane'; return m;
}

/** Patch palette extension (reusable for any partition: patches, Voronoi cells, parcellations; up to 4*groups classes).
 *  Per-vertex membership WEIGHTS (one-hot, lightly smoothed over the mesh, so boundaries are smooth iso-lines instead of following triangle
 *  edges) are stored as vec4 attributes aW0..aW{g-1}. The fragment shader takes the argmax class for the colour, and draws the boundary
 *  from the gap between the two largest weights, anti-aliased with fwidth() at a constant pixel width (borderPx), darkening by borderDark.
 *    const pal = createPatchPalette(8, {borderPx: 1.75, borderDark: .58}); c.extend(pal.spec); pal.bind(c, weightsNativeAttr (itemSize 8));
 *    pal.set(a, '#00b5ad', .6); pal.step(dt)   (smooth colour/strength transitions, returns true while moving)
 *  Data: python tools/patch_weights.py-style: one-hot (n x N) -> k Laplacian smoothing -> u8xN file; load with fetchNativeAttr(url, 'u8x8'). */
export function createPatchPalette(n = 8, { borderDark = 0.58, borderPx = 1.75, rate = 11 } = {}) {
  const G = Math.ceil(n / 4), C = Array.from({ length: n }, () => new THREE.Vector3(1, 1, 1)), A = new Array(n).fill(0);
  const P = { n, groups: G, col: Array.from({ length: n }, () => [1, 1, 1]), tcol: Array.from({ length: n }, () => [1, 1, 1]), al: new Float32Array(n), tal: new Float32Array(n) };
  const comp = ['x', 'y', 'z', 'w'], attrs = {}; for (let g = 0; g < G; g++) attrs['aW' + g] = 'vec4';
  let fr = ''; for (let k = 0; k < n; k++) fr += `w = vW${k >> 2}.${comp[k & 3]}; fwm = max(fwm, fwidth(w)); if (w > m1) { m2 = m1; m1 = w; i1 = ${k}; } else if (w > m2) m2 = w;\n`;
  P.spec = {
    name: 'patches',
    uniforms: { uPatchC: { value: C, type: `vec3[${n}]` }, uPatchA: { value: A, type: `float[${n}]` }, uBorderDark: { value: borderDark }, uBorderPx: { value: borderPx } },
    attributes: attrs,
    fragment: `float w, m1 = -1., m2 = -1., fwm = 0.; int i1 = 0;
      ${fr}
      float gap = m1 - m2, dpx = gap / (2. * fwm + 1e-5);                       // ~distance to the boundary iso-line in px (gap grows ~2x the class gradient)
      float edge = 1. - smoothstep(uBorderPx * .5 - .5, uBorderPx * .5 + .5, dpx);
      vec3 pt = pow(mix(vec3(1.), uPatchC[i1], uPatchA[i1]), vec3(2.2));
      col *= pt * (1. - uBorderDark * edge);`,
  };
  /** bind an itemSize-n native weights attribute (split into the vec4 groups) to a cortex */
  P.bind = (cortex, w) => {
    for (let g = 0; g < G; g++) {
      const out = new Float32Array(w.n * 4); for (let i = 0; i < w.n; i++) for (let c = 0; c < 4; c++) { const k = g * 4 + c; out[i * 4 + c] = k < w.itemSize ? w.array[i * w.itemSize + k] : 0; }
      cortex.bind('aW' + g, { array: out, itemSize: 4, n: w.n });
    }
  };
  const rgb = (c) => [1, 3, 5].map((o) => parseInt(c.slice(o, o + 2), 16) / 255);
  P.set = (a, color, alpha) => { P.tcol[a] = typeof color === 'string' ? rgb(color) : color; P.tal[a] = alpha; };
  P.setAll = (color, alpha) => { for (let a = 0; a < n; a++) P.set(a, color, alpha); };
  P.step = (dt) => {
    const k = 1 - Math.exp(-dt * rate); let moving = false;
    for (let a = 0; a < n; a++) {
      const da = P.tal[a] - P.al[a]; if (Math.abs(da) > 0.003) { P.al[a] += da * k; moving = true; } else P.al[a] = P.tal[a];
      for (let i = 0; i < 3; i++) { const dc = P.tcol[a][i] - P.col[a][i]; if (Math.abs(dc) > 0.003) { P.col[a][i] += dc * k; moving = true; } else P.col[a][i] = P.tcol[a][i]; }
      C[a].set(...P.col[a]); A[a] = P.al[a];
    }
    return moving;
  };
  return P;
}

// ----------------------------------------------------------------------------------------------
// Multi-view renderer

/** createMultiViewer(container, opts) -> M
 *  One WebGLRenderer / canvas, any number of scissored views. Each view has a DOM element that defines its rectangle (re-read every frame,
 *  so CSS layouts and animations just work), its own scene (or a shared one), and either follows the shared rig camera (`link:true`,
 *  with a per-view world `offset` and `fovScale`) or has its own camera/target (`link:false`). One OrbitControls drives whichever camera
 *  is under the pointer. Render on demand across all views; LOD runs per view; pointer events are routed to the view under the cursor.
 *  opts: background (0xffffff), dpr (2), fov (30), near/far, camera:[x,y,z] (430,0,0), up:[0,0,1], target:[0,0,0], look ('blender'),
 *        controls:{...OrbitControls props}, wheel: 'brain' (default: zoom only while over a brain) | 'view' | 'off', canvas (existing <canvas>),
 *        antialias, preserveDrawingBuffer, continuous.
 *  M: renderer canvas camera controls views addView() removeView() add() remove() fit() addTicker() invalidate() renderOnce() setAO()
 *     on(type, fn) viewAt(x,y) stats onRender dispose() */
export function createMultiViewer(container, opts = {}) {
  const look = resolveLook(opts.look), dprCap = opts.dpr ?? 1.5, Q = new URLSearchParams(location.search);
  const renderer = new THREE.WebGLRenderer({ canvas: opts.canvas, antialias: opts.antialias ?? true, alpha: false, preserveDrawingBuffer: opts.preserveDrawingBuffer ?? false, powerPreference: 'high-performance' });
  const dprFull = Math.min(window.devicePixelRatio || 1, +Q.get('dpr') || dprCap), dprMove = Math.min(dprFull, opts.dprMoving ?? 1);
  renderer.setPixelRatio(dprFull);
  renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.NoToneMapping;
  renderer.setClearColor(opts.background ?? 0xffffff, 1); renderer.info.autoReset = false;
  const canvas = renderer.domElement;
  if (!opts.canvas) { canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none'; container.appendChild(canvas); }
  const rigCam = new THREE.PerspectiveCamera(opts.fov ?? 30, 1, opts.near ?? 1, opts.far ?? 2000);
  rigCam.up.set(...(opts.up ?? [0, 0, 1]));              // FreeSurfer RAS: +z up, +y anterior; default view = lateral of a right hemisphere
  rigCam.position.set(...(opts.camera ?? [430, 0, 0]));
  const controls = new OrbitControls(rigCam, canvas), rigTarget = controls.target;
  Object.assign(controls, { enableDamping: true, dampingFactor: 0.08, rotateSpeed: 0.7, zoomSpeed: 0.9 }, opts.controls ?? {});
  rigTarget.set(...(opts.target ?? [0, 0, 0])); controls.enabled = opts.controls?.enabled !== false; controls.update();

  const M = { renderer, canvas, container, camera: rigCam, controls, views: [], tickers: [], look, wheel: opts.wheel ?? 'brain',
              stats: { fps: 0, ms: 0, frames: 0, tris: 0, calls: 0, dpr: 1 }, adaptive: opts.adaptive !== false, continuous: !!opts.continuous, paused: false, onRender: null, composer: null, ao: false, listeners: {} };
  let moving = false, lastBusy = 0, layoutDirty = true, rafN = 0, rafT = performance.now(), rafFps = 0;
  let dirty = true, raf = 0, visible = true, lastT = performance.now(), lastRaf = lastT, fpsN = 0, fpsT = lastT, W = 0, H = 0;
  M.invalidate = () => { dirty = true; };
  controls.addEventListener('change', M.invalidate);
  const csize = () => { const w = Math.max(1, canvas.clientWidth), h = Math.max(1, canvas.clientHeight); return [w, h]; };
  const ro = new ResizeObserver(() => { dirty = true; layoutDirty = true; }); ro.observe(container); addEventListener('resize', () => { layoutDirty = true; dirty = true; });
  const io = new IntersectionObserver((es) => { visible = es[es.length - 1].isIntersecting; if (visible) dirty = true; }); io.observe(container);

  // ---- views ----------------------------------------------------------------------------------
  class View {
    constructor(o) {
      this.M = M; this.id = o.id ?? 'view' + M.views.length; this.el = o.el ?? container; this.link = o.link !== false;
      this.offset = o.offset ?? new THREE.Vector3(); this.fovScale = o.fovScale ?? 1; this.fov = o.fov ?? null;
      this.static = !!o.static;                 // static: rectangle only re-measured on window/container resize (saves a layout read per frame)
      this.visible = o.visible !== false; this.interactive = o.interactive !== false; this.cortices = [];
      this.camera = new THREE.PerspectiveCamera(rigCam.fov, 1, rigCam.near, rigCam.far); this.camera.up.copy(rigCam.up);
      this.target = new THREE.Vector3(...(o.target ?? [0, 0, 0])); this.targetPt = new THREE.Vector3();
      if (!this.link) { this.camera.position.set(...(o.camera ?? [430, 0, 0])); this.camera.lookAt(this.target); }
      this.look = resolveLook(o.look ?? look);
      this.scene = o.scene ?? new THREE.Scene(); this.ownScene = !o.scene;
      const bg = o.background === undefined ? (opts.background ?? 0xffffff) : o.background;
      if (this.ownScene) this.scene.background = bg == null ? null : new THREE.Color(bg);
      this.lights = this.scene.userData.cxLights ?? null;
      if (o.lights !== false && !this.lights) {
        const L = this.look, hemi = new THREE.HemisphereLight(0xffffff, L.ground, L.hemi), key = new THREE.DirectionalLight(0xffffff, L.key), fill = new THREE.DirectionalLight(0xf0f4ff, L.fill);
        this.scene.add(hemi, key, fill); this.lights = this.scene.userData.cxLights = { hemi, key, fill };
      }
      this.rect = { x: 0, y: 0, w: 1, h: 1 };
    }
    /** css-px rectangle in canvas coordinates (re-measured) */
    measure() {
      const cr = canvas.getBoundingClientRect(), r = this.el.getBoundingClientRect(), sx = canvas.clientWidth / Math.max(1, cr.width), sy = canvas.clientHeight / Math.max(1, cr.height);
      const x = (r.left - cr.left) * sx, y = (r.top - cr.top) * sy, w = r.width * sx, h = r.height * sy, o = this.rect;
      const ch = Math.abs(x - o.x) + Math.abs(y - o.y) + Math.abs(w - o.w) + Math.abs(h - o.h) > 0.25;
      o.x = x; o.y = y; o.w = w; o.h = h; return ch;
    }
    add(obj) {
      if (obj instanceof Cortex) { this.cortices.push(obj); this.scene.add(obj.root); obj._ls.add(M.invalidate); }
      else this.scene.add(obj);
      M.invalidate(); return obj;
    }
    remove(obj) {
      if (obj instanceof Cortex) { this.cortices = this.cortices.filter((c) => c !== obj); obj._ls.delete(M.invalidate); this.scene.remove(obj.root); } else this.scene.remove(obj);
      M.invalidate();
    }
    /** Raycaster through client coordinates (px) */
    raycaster(clientX, clientY, ray = new THREE.Raycaster()) {
      const r = this.el.getBoundingClientRect();
      this.camera.updateMatrixWorld(); ray.setFromCamera(new THREE.Vector2((clientX - r.left) / r.width * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), this.camera);
      return ray;
    }
    /** Nearest hit over this view's visible cortices -> {cortex, native, point, position, distance, ...} | null */
    pick(clientX, clientY) {
      const ray = this.raycaster(clientX, clientY); let best = null;
      for (const c of this.cortices) { if (!isVisible(c.root)) continue; const h = c.pick(ray); if (h && (!best || h.distance < best.distance)) best = h; }
      return best && { ...best, view: this };
    }
    /** is the client point within a projected bounding sphere of one of the visible cortices? */
    overBrain(clientX, clientY) {
      const r = this.el.getBoundingClientRect(); this.camera.updateMatrixWorld();
      for (const c of this.cortices) {
        if (!isVisible(c.root) || !c.bbox) continue;
        const wc = c.bbox.center.clone().applyMatrix4(c.root.matrixWorld), d = wc.distanceTo(this.camera.position);
        const rw = Math.max(c.bbox.half.x, c.bbox.half.y, c.bbox.half.z) * c.root.matrixWorld.getMaxScaleOnAxis();
        const pxw = r.height / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) * d), p = wc.project(this.camera);
        const sx = r.left + (p.x + 1) / 2 * r.width, sy = r.top + (1 - p.y) / 2 * r.height;
        if (Math.hypot(clientX - sx, clientY - sy) <= rw * pxw * 1.05) return true;
      }
      return false;
    }
    /** project a world point to css px relative to this view's element (z = ndc depth) */
    project(world, out = new THREE.Vector3()) {
      this.camera.updateMatrixWorld(); out.copy(world).project(this.camera); const r = this.rect;
      return out.set((out.x + 1) / 2 * r.w, (1 - out.y) / 2 * r.h, out.z);
    }
  }
  const isVisible = (o) => { for (let p = o; p; p = p.parent) if (!p.visible) return false; return true; };
  M.addView = (o = {}) => { const v = new View(o); v.measure(); M.views.push(v); dirty = true; return v; };
  M.removeView = (v) => { M.views = M.views.filter((x) => x !== v); dirty = true; };
  M.add = (obj) => (M.views[0] ?? M.addView()).add(obj);
  M.remove = (obj) => M.views[0]?.remove(obj);
  /** fn(dtSeconds, tSeconds) is called every frame while the viewer is visible (before cameras sync); return true to keep rendering. */
  M.addTicker = (fn) => { M.tickers.push(fn); M.invalidate(); return () => { M.tickers = M.tickers.filter((f) => f !== fn); }; };
  /** Frame a box of half-width halfW x half-height halfH (world units, facing the camera) around `center` for `view` (default: first). */
  M.fit = (center = new THREE.Vector3(), halfW = 100, halfH = halfW, margin = 1.1, view = M.views[0]) => {
    view?.measure();
    const dir = rigCam.position.clone().sub(rigTarget).normalize(), asp = view ? Math.max(0.01, view.rect.w / Math.max(1, view.rect.h)) : rigCam.aspect;
    const half = Math.atan(Math.tan(THREE.MathUtils.degToRad(rigCam.fov / 2)) * (view?.fovScale ?? 1)), halfX = Math.atan(Math.tan(half) * asp);
    const dist = margin * Math.max(halfH / Math.tan(half), halfW / Math.tan(halfX));
    rigTarget.copy(center); rigCam.position.copy(center).addScaledVector(dir, dist); controls.update(); M.invalidate();
  };

  // ---- AO (single full-canvas view only; GTAO per viewport is too expensive, multi-view relies on the sulc cavity shading) -----------
  M.setAO = async (on, params = {}) => {
    M.ao = on;
    if (on && !M.composer) {
      const [{ EffectComposer }, { RenderPass }, { GTAOPass }, { OutputPass }] = await Promise.all([
        import('three/addons/postprocessing/EffectComposer.js'), import('three/addons/postprocessing/RenderPass.js'),
        import('three/addons/postprocessing/GTAOPass.js'), import('three/addons/postprocessing/OutputPass.js')]);
      const v = M.views[0], size = renderer.getSize(new THREE.Vector2());
      const c = new EffectComposer(renderer); c.setPixelRatio(renderer.getPixelRatio()); c.setSize(size.x, size.y);
      c.addPass(new RenderPass(v.scene, v.camera));
      const gtao = new GTAOPass(v.scene, v.camera, size.x, size.y);
      gtao.output = GTAOPass.OUTPUT.Default;
      gtao.updateGtaoMaterial({ radius: 6, distanceExponent: 1.5, thickness: 4, scale: 1, samples: 12, distanceFallOff: 1, screenSpaceRadius: false });
      gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
      gtao.blendIntensity = params.intensity ?? 0.9;
      c.addPass(gtao); c.addPass(new OutputPass()); M.composer = c; M.gtao = gtao; W = 0;
    }
    M.invalidate();
  };

  // ---- pointer routing ----------------------------------------------------------------------------------------
  const inRect = (v, x, y) => { const r = v.el.getBoundingClientRect(); return v.visible && r.width > 4 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; };
  /** topmost interactive view under client coordinates, or null */
  M.viewAt = (x, y) => { for (let i = M.views.length - 1; i >= 0; i--) { const v = M.views[i]; if (v.interactive && inRect(v, x, y)) return v; } return null; };
  const activate = (v) => { if (v.link) { controls.object = rigCam; controls.target = rigTarget; } else { controls.object = v.camera; controls.target = v.target; } };
  container.addEventListener('pointerdown', (e) => { if (e.target !== canvas) return; const v = M.viewAt(e.clientX, e.clientY); if (!v) { e.stopPropagation(); return; } activate(v); }, { capture: true });
  container.addEventListener('wheel', (e) => {
    if (e.target !== canvas) return;
    const v = M.wheel === 'off' ? null : M.viewAt(e.clientX, e.clientY);
    if (!v || (M.wheel === 'brain' && !v.overBrain(e.clientX, e.clientY))) { e.stopPropagation(); return; }   // not ours: let the page scroll
    activate(v);
  }, { capture: true, passive: false });
  /** M.on('pointermove'|'pointerdown'|'pointerup'|'click'|'pointerleave', fn({type, view, event, x, y, view-local css px, ray()})) -> off() */
  M.on = (type, fn) => { (M.listeners[type] ??= new Set()).add(fn); return () => M.listeners[type].delete(fn); };
  for (const type of ['pointermove', 'pointerdown', 'pointerup', 'click', 'pointerleave']) {
    canvas.addEventListener(type, (e) => {
      const fns = M.listeners[type]; if (!fns?.size) return;
      const v = type === 'pointerleave' ? null : M.viewAt(e.clientX, e.clientY), r = v?.el.getBoundingClientRect();
      const ev = { type, view: v, event: e, clientX: e.clientX, clientY: e.clientY, x: v ? e.clientX - r.left : 0, y: v ? e.clientY - r.top : 0, ray: () => v?.raycaster(e.clientX, e.clientY) };
      for (const f of fns) f(ev);
    });
  }

  // ---- frame ----------------------------------------------------------------------------------------------------
  const tmpL = new THREE.Vector3();
  function updateLights(v) {
    const L = v.lights; if (!L) return; const cam = v.camera;
    L.key.position.set(0.35, 0.9, 0.9).applyQuaternion(cam.quaternion).add(cam.position);       // lights ride on the camera frame
    L.fill.position.set(-0.8, -0.2, 0.6).applyQuaternion(cam.quaternion).add(cam.position);
  }
  function syncCamera(v) {
    const r = v.rect;
    if (v.link) {
      v.camera.position.copy(rigCam.position).add(v.offset); v.camera.quaternion.copy(rigCam.quaternion); v.camera.up.copy(rigCam.up);
      v.targetPt.copy(rigTarget).add(v.offset);
    } else v.targetPt.copy(v.target);
    const asp = Math.max(0.01, r.w / Math.max(1, r.h)), fov0 = v.fov ?? rigCam.fov;
    const fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(fov0) / 2) * (v.link ? v.fovScale : 1)));
    const c = v.camera;
    if (c.aspect !== asp || c.fov !== fov || c.near !== rigCam.near || c.far !== rigCam.far) { c.aspect = asp; c.fov = fov; c.near = rigCam.near; c.far = rigCam.far; c.updateProjectionMatrix(); }
    c.updateMatrixWorld();
  }
  function frame(now, force = false) {
    const dt = Math.max(0, Math.min(0.25, (now - lastT) / 1000)); lastT = now;
    const anyDyn = M.views.some((v) => !v.static);
    if (layoutDirty || anyDyn) {
      const [cw, ch] = csize();
      if (cw !== W || ch !== H) { W = cw; H = ch; renderer.setSize(W, H, false); M.composer?.setSize(W, H); dirty = true; }
      for (const v of M.views) if ((layoutDirty || !v.static) && v.measure()) dirty = true;
      layoutDirty = false;
    }
    const pv = M.views[0];
    if (pv) { const a = Math.max(0.01, pv.rect.w / Math.max(1, pv.rect.h)); if (rigCam.aspect !== a) { rigCam.aspect = a; rigCam.updateProjectionMatrix(); } }
    let busy = false;
    if (controls.enabled && controls.update()) { dirty = true; busy = true; }
    for (const f of M.tickers) if (f(dt, now / 1000)) { dirty = true; busy = true; }
    const seen = new Set();
    for (const v of M.views) for (const c of v.cortices) if (!seen.has(c)) { seen.add(c); if (c.tick(now)) { dirty = true; busy = true; } }
    // adaptive resolution: while the camera / an animation is moving render at a lower pixel ratio; restore full DPR ~200 ms after it stops
    if (busy) lastBusy = performance.now();
    const wantMoving = M.adaptive && (busy || performance.now() - lastBusy < 200) && dprMove < dprFull;
    if (wantMoving !== moving) { moving = wantMoving; renderer.setPixelRatio(moving ? dprMove : dprFull); renderer.setSize(W, H, false); M.composer?.setPixelRatio(renderer.getPixelRatio()); dirty = true; layoutDirty = false; }
    if (M.adaptive && !moving && dprMove < dprFull) { /* idle */ }
    if (moving && !busy && performance.now() - lastBusy >= 200) dirty = true;
    // camera sync + per-view LOD (a cortex shown in several views takes the finest level any of them wants)
    const busyRecent = busy, want = new Map();
    for (const v of M.views) {
      if (!v.visible || v.rect.w < 8 || v.rect.h < 8) continue;
      syncCamera(v);
      for (const c of v.cortices) if (isVisible(c.root)) want.set(c, Math.max(want.get(c) ?? -1, c.lodFor(v.camera, v.rect.w, v.rect.h, moving && busyRecent)));
    }
    for (const [c, w] of want) c.applyLevel(w);
    if (!dirty && !M.continuous && !force) return;
    dirty = false;
    const t0 = performance.now(), single = M.views.length === 1;
    renderer.info.reset();
    renderer.setScissorTest(false); renderer.setViewport(0, 0, W, H); renderer.clear();
    for (const v of M.views) {
      if (!v.visible || v.rect.w < 8 || v.rect.h < 8) continue;
      const r = v.rect, y = H - r.y - r.h;
      updateLights(v);
      const morphing = v.cortices.some((c) => c.morph > 1e-4);         // GTAO's depth/normal pass ignores the A/B morph attribute
      if (single && M.ao && M.composer && !morphing) { renderer.setScissorTest(false); renderer.setViewport(0, 0, W, H); M.composer.render(); }
      else { renderer.setViewport(r.x, y, r.w, r.h); renderer.setScissor(r.x, y, r.w, r.h); renderer.setScissorTest(true); renderer.render(v.scene, v.camera); }
    }
    renderer.setScissorTest(false);
    if (M.continuous) renderer.getContext().finish();
    const S = M.stats; S.ms = performance.now() - t0; S.frames++; fpsN++;
    if (now - fpsT > 500) { S.fps = fpsN * 1000 / (now - fpsT); fpsN = 0; fpsT = now; }
    S.tris = renderer.info.render.triangles; S.calls = renderer.info.render.calls; S.dpr = renderer.getPixelRatio(); S.raf = rafFps;
    M.onRender?.(S);
  }
  function loop(now) { raf = requestAnimationFrame(loop); lastRaf = performance.now(); rafN++; if (now - rafT > 500) { rafFps = rafN * 1000 / (now - rafT); rafN = 0; rafT = now; } if (M.paused || !visible) return; frame(now); }
  raf = requestAnimationFrame(loop);
  // watchdog: headless Chrome (screenshots) starves requestAnimationFrame; keep the frame loop alive from a timer in that case
  const wd = setInterval(() => { if (!M.paused && performance.now() - lastRaf > 500) frame(performance.now()); }, 250);
  /** Synchronously run one full frame (layout, tickers, LOD, render) regardless of dirty/visibility: for deterministic headless screenshots. */
  M.renderOnce = () => frame(performance.now(), true);
  if (Q.has('perf')) {                                                     // ?perf=1 HUD: render fps / ms per frame / DPR / triangles / draw calls
    const hud = document.createElement('div');
    hud.style.cssText = 'position:fixed;left:6px;bottom:6px;z-index:99999;font:11px/1.35 ui-monospace,monospace;color:#fff;background:rgba(0,0,0,.65);padding:4px 7px;border-radius:4px;white-space:pre;pointer-events:none';
    document.body.appendChild(hud); let lt = 0, lf = 0, rfps = 0;
    setInterval(() => { const S = M.stats, t = performance.now(); rfps = (S.frames - lf) * 1000 / Math.max(1, t - lt); lt = t; lf = S.frames;
      hud.textContent = `render ${rfps.toFixed(0)} fps  ${S.ms.toFixed(1)} ms/frame\nraf ${S.raf.toFixed(0)} Hz  DPR ${S.dpr}${moving ? ' (moving)' : ''}\n${(S.tris / 1e3).toFixed(0)}k tris  ${S.calls} draws  canvas ${canvas.width}x${canvas.height}`; }, 500);
  }
  M.dispose = () => { cancelAnimationFrame(raf); clearInterval(wd); ro.disconnect(); io.disconnect(); controls.dispose(); renderer.dispose(); if (!opts.canvas) canvas.remove(); };
  return M;
}

/** createViewer(container, {background, fov, ao, continuous, dpr, antialias, camera:[x,y,z], target, look, controls, wheel}) - the single-view case
 *  of createMultiViewer: one view filling `container`. Adds viewer.scene, viewer.lights, viewer.view. `ao` defaults to the look's setting
 *  (on for 'blender'). Render-on-demand: re-renders only when invalidate() was called, controls moved, a ticker asked for it, or a cortex changed. */
export function createViewer(container, opts = {}) {
  const M = createMultiViewer(container, opts);
  const view = M.addView({ el: container, look: opts.look, static: true });
  Object.defineProperties(M, { scene: { get: () => view.scene }, lights: { get: () => view.lights }, cortices: { get: () => view.cortices } });
  M.view = view;
  if (opts.ao ?? resolveLook(opts.look).ao) M.setAO(true);
  return M;
}
