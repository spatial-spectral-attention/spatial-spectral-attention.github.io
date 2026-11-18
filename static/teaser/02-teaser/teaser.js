import { loadCortex, createViewer, fetchNativeAttr, makeShadowPlane, THREE } from '../lib/cortex.js';
const { Vector3: V3 } = THREE;
const Q = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const stage = $('stage');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const D2R = Math.PI / 180, clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const smooth = (x) => { x = clamp(x); return x * x * (3 - 2 * x); };
const ramp = (t, a, b) => smooth((t - a) / (b - a));
const ease = (x) => x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
const sine = (x) => -(Math.cos(Math.PI * x) - 1) / 2;
const speed = +(Q.get('speed') || 1);

// ---------------------------------------------------------------- look: lib preset 'blender' (tuned against cortex-teaser.mp4); only demo-specific bits here
const LK = { tintMul: [0.94, 1.16, 1.42],        // SRC_TINT (0.80,0.88,0.96 sRGB) / grey * grey, as in make_cortex_material
             labelDark: 0.80 };
const AOMODE = Q.get('ao') ?? 'baked';             // ?ao=baked (default) | gtao | 0
const view = $('view');
const viewer = createViewer(view, { camera: [430, 0, 0], fov: 22.9, near: 2, far: 2500, ao: AOMODE === 'gtao' });
const { camera, controls, renderer } = viewer;
controls.addEventListener('change', () => { ovDirty = true; });
for (const k of ['hemi', 'key', 'fill']) if (Q.get(k)) viewer.lights[k].intensity = +Q.get(k);
controls.minDistance = 6; controls.maxDistance = 1200; controls.rotateSpeed = 0.6;
// keep the horizontal field of view of the Blender camera (50 mm lens / 36 mm sensor) at any aspect ratio
const HFOV_T = 18 / 50;
let VW = 1, VH = 1, ovDirty = true;               // cached view size (avoids a layout read per frame)
function fixFov() {
  VW = view.clientWidth; VH = view.clientHeight; ovDirty = true;
  const a = VW / Math.max(1, VH);
  camera.fov = Math.min(60, 2 * Math.atan(HFOV_T / a) / D2R); camera.updateProjectionMatrix();
  stage.style.setProperty('--u', VH / 1080 + 'px'); viewer.invalidate();
}
new ResizeObserver(fixFov).observe(view); fixFov();

// ---------------------------------------------------------------- data
const DATA = new URL('./data/', import.meta.url).href;
async function fetchData(file) {
  const response = await fetch(DATA + file);
  if (!response.ok) throw new Error(`Could not load ${file}: ${response.status}`);
  return response;
}
const [lines, srcC, tgtC, srcRGB, tgtRGB, srcSw, tgtSw, t2sBuf] = await Promise.all([
  fetchData('lines.json').then((r) => r.json()),
  loadCortex('source', { surface: 'pial', levels: [0, 1, 2], bakedAO: AOMODE === 'baked' ? undefined : 0 }), loadCortex('target', { surface: 'pial', levels: [0, 1, 2], bakedAO: AOMODE === 'baked' ? undefined : 0 }),
  fetchNativeAttr(DATA + 'src_rgb.rgb8.bin', 'rgb8'), fetchNativeAttr(DATA + 'tgt_rgb.rgb8.bin', 'rgb8'),
  fetchNativeAttr(DATA + 'src_sweep.f32.bin', 'f32'), fetchNativeAttr(DATA + 'tgt_sweep.f32.bin', 'f32'),
  fetchData('t2s.u32.bin').then((r) => r.arrayBuffer()),
]);
const t2s = new Uint32Array(t2sBuf);
$('nM').textContent = lines.n_src.toLocaleString('en-US'); $('nN').textContent = lines.n_tgt.toLocaleString('en-US');
$('tris').textContent = lines.tris_src.toLocaleString('en-US');
const GAP = 205, RISE0 = -25;

// ---------------------------------------------------------------- per-cortex layers (lib features: body tint + label wipe)
for (const [c, sweep, rgb] of [[srcC, srcSw, srcRGB], [tgtC, tgtSw, tgtRGB]]) { c.setBodyTint(LK.tintMul, 0); c.setPaint(rgb, sweep, { dark: LK.labelDark, soft: 0.10 }); }
srcC.root.position.set(0, 0, 0); tgtC.root.position.set(0, GAP, RISE0);
viewer.add(srcC); viewer.add(tgtC);
tgtC.material.transparent = true; tgtC.root.visible = false;
srcC.wireframe = true; srcC.wireMesh.visible = false; srcC.wireMesh.material.color.set(0x1d1f21);
const dbg = $('dbg'); if (Q.get('debug')) dbg.style.display = 'block';

// soft contact shadows (the Blender clip has a shadow-catcher ground)
const shS = makeShadowPlane({ position: [-4, -4, -66] }), shT = makeShadowPlane({ position: [-4, GAP - 4, -66] }); viewer.add(shS); viewer.add(shT);

// ---------------------------------------------------------------- correspondence lines (ribbons, staggered grow)
const nL = lines.tgt.length, SEG = 24, DUR = 28 / 90;
const srcPos = await Promise.all(lines.src.map((i) => srcC.nativePosition(i)));
const tgtPos = await Promise.all(lines.tgt.map((i) => tgtC.nativePosition(i)));
const RES = new THREE.Vector2(), LU = { uGrow: { value: 0 }, uPaint: { value: -0.15 }, uOut: { value: 1 }, uRes: { value: RES }, uWidth: { value: 1.7 }, uDur: { value: DUR }, uPx: { value: 7 }, uFix: { value: 0 }, uFixCol: { value: new THREE.Color(0xde9a33) } };
const SH = {
  common: `uniform float uGrow,uPaint,uOut,uDur,uFix; uniform vec3 uFixCol;
    float progOf(float st){ return uFix>0.5 ? 1. : smoothstep(0.,1.,(uGrow-st)/uDur); }
    vec3 colOf(vec3 c,float sw,out float cf){ cf = uFix>0.5 ? 1. : smoothstep(0.,.12,uPaint-sw); vec3 g=vec3(95.,98.,102.)/255.; return uFix>0.5 ? uFixCol : mix(g,c,cf); }`,
};
function ribbon(n, fix) {
  const nv = n * SEG * 4, pos = new Float32Array(nv * 3), oth = new Float32Array(nv * 3), side = new Float32Array(nv), tt = new Float32Array(nv), st = new Float32Array(nv),
        col = new Float32Array(nv * 3), sw = new Float32Array(nv), idx = new Uint32Array(n * SEG * 6);
  for (let k = 0; k < n * SEG; k++) { const b = k * 4; idx.set([b, b + 1, b + 2, b + 2, b + 1, b + 3], k * 6); }
  const g = new THREE.BufferGeometry();
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('aOther', new THREE.BufferAttribute(oth, 3));
  g.setAttribute('aSide', new THREE.BufferAttribute(side, 1)); g.setAttribute('aT', new THREE.BufferAttribute(tt, 1));
  g.setAttribute('aStart', new THREE.BufferAttribute(st, 1)); g.setAttribute('aCol', new THREE.BufferAttribute(col, 3)); g.setAttribute('aSweep', new THREE.BufferAttribute(sw, 1));
  const uni = fix ? { ...LU, uFix: { value: 1 }, uWidth: { value: 2.6 }, uOut: { value: 1 } } : LU;
  const m = new THREE.ShaderMaterial({
    uniforms: uni, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    vertexShader: `${SH.common} uniform vec2 uRes; uniform float uWidth;
      attribute vec3 aOther; attribute float aSide,aT,aStart,aSweep; attribute vec3 aCol;
      varying vec3 vC; varying float vA,vT,vP,vS;
      void main(){ vec4 c0=projectionMatrix*viewMatrix*vec4(position,1.), c1=projectionMatrix*viewMatrix*vec4(aOther,1.);
        vec2 a=c0.xy/c0.w*uRes*.5, b=c1.xy/c1.w*uRes*.5; vec2 d=normalize(b-a+1e-6); vec2 nr=vec2(-d.y,d.x);
        gl_Position=c0; gl_Position.xy += nr*aSide*uWidth*.5/(uRes*.5)*c0.w;
        float cf; vC=colOf(aCol,aSweep,cf); vA=(uFix>.5?.95:.42+.38*cf)*uOut; vT=aT; vP=progOf(aStart); vS=aSide; }`,
    fragmentShader: `varying vec3 vC; varying float vA,vT,vP,vS;
      void main(){ if(vT>vP) discard; float e=1.-smoothstep(.55,1.,abs(vS)); gl_FragColor=vec4(vC,vA*e); }`,
  });
  const mesh = new THREE.Mesh(g, m); mesh.frustumCulled = false; mesh.renderOrder = 10;
  const P = new V3(), A = new V3(), B = new V3(), C = new V3();
  mesh.setLine = (k, a, b, start, c3, sweep) => {
    A.copy(a); B.copy(b); const L = A.distanceTo(B); C.copy(A).add(B).multiplyScalar(.5); C.z += L * 0.16;
    const pts = []; for (let i = 0; i <= SEG; i++) { const t = i / SEG, u = 1 - t; pts.push(new V3(u * u * A.x + 2 * u * t * C.x + t * t * B.x, u * u * A.y + 2 * u * t * C.y + t * t * B.y, u * u * A.z + 2 * u * t * C.z + t * t * B.z)); }
    for (let s = 0; s < SEG; s++) for (let q = 0; q < 4; q++) {
      const v = (k * SEG + s) * 4 + q, end = q >> 1, sd = (q & 1) ? 1 : -1, p = pts[s + end], o = pts[s + 1 - end];
      pos.set([p.x, p.y, p.z], v * 3); oth.set([o.x, o.y, o.z], v * 3); side[v] = sd; tt[v] = (s + end) / SEG; st[v] = start; col.set(c3, v * 3); sw[v] = sweep;
    }
    for (const a of ['position', 'aOther', 'aSide', 'aT', 'aStart', 'aCol', 'aSweep']) g.getAttribute(a).needsUpdate = true;
  };
  return mesh;
}
const world = (p, root) => p.clone().add(root.position);
const rib = ribbon(nL);
lines.order.forEach((k, rank) => rib.setLine(k, world(srcPos[k], srcC.root), world(tgtPos[k], new THREE.Object3D()).add(new V3(0, GAP, 0)), rank / (nL - 1) * (1 - DUR), lines.col[k], lines.sweep[k]));
// dots at both ends
const dotMat = (fix) => new THREE.ShaderMaterial({
  uniforms: fix ? { ...LU, uFix: { value: 1 } } : LU, transparent: true, depthTest: false, depthWrite: false,
  vertexShader: `${SH.common} uniform float uPx; attribute vec3 aCol; attribute float aSweep,aStart,aEnd; varying vec3 vC; varying float vA;
    void main(){ gl_Position=projectionMatrix*viewMatrix*vec4(position,1.); gl_PointSize=uPx; float cf; vC=colOf(aCol,aSweep,cf);
      float p=progOf(aStart); float on=aEnd<.5 ? step(.001,p) : step(.999,p); vA=on*(uFix>.5?1.:(.55+.4*cf)*uOut); }`,
  fragmentShader: `varying vec3 vC; varying float vA; void main(){ float d=length(gl_PointCoord-.5)*2.; if(d>1.) discard;
    vec3 c = d>.68 ? vec3(1.) : vC; gl_FragColor=vec4(c, vA*(1.-smoothstep(.92,1.,d))); }`,
});
const dg = new THREE.BufferGeometry(); {
  const p = new Float32Array(nL * 6), c = new Float32Array(nL * 6), s = new Float32Array(nL * 2), a = new Float32Array(nL * 2), e = new Float32Array(nL * 2);
  const rank = new Array(nL); lines.order.forEach((k, r) => rank[k] = r);
  for (let k = 0; k < nL; k++) {
    const w = [world(srcPos[k], srcC.root), world(tgtPos[k], { position: new V3(0, GAP, 0) })];
    for (let j = 0; j < 2; j++) { p.set([w[j].x, w[j].y, w[j].z], (k * 2 + j) * 3); c.set(lines.col[k], (k * 2 + j) * 3); s[k * 2 + j] = lines.sweep[k]; a[k * 2 + j] = rank[k] / (nL - 1) * (1 - DUR); e[k * 2 + j] = j; }
  }
  dg.setAttribute('position', new THREE.BufferAttribute(p, 3)); dg.setAttribute('aCol', new THREE.BufferAttribute(c, 3));
  dg.setAttribute('aSweep', new THREE.BufferAttribute(s, 1)); dg.setAttribute('aStart', new THREE.BufferAttribute(a, 1)); dg.setAttribute('aEnd', new THREE.BufferAttribute(e, 1));
}
const dots = new THREE.Points(dg, dotMat(false)); dots.frustumCulled = false; dots.renderOrder = 11;
const lineGroup = new THREE.Group(); lineGroup.add(rib, dots); lineGroup.visible = false; viewer.add(lineGroup);
// hover bonus objects
const hov = new THREE.Group(); hov.visible = false; viewer.add(hov);
const hovRib = ribbon(1, true); hovRib.material.uniforms.uWidth.value = 2.6; hov.add(hovRib);
const hg = new THREE.BufferGeometry(); hg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
for (const [n, d] of [['aCol', 3], ['aSweep', 1], ['aStart', 1], ['aEnd', 1]]) hg.setAttribute(n, new THREE.BufferAttribute(new Float32Array(2 * d), d));
hg.getAttribute('aEnd').array.set([0, 1]);
const hovDots = new THREE.Points(hg, dotMat(true)); hovDots.material.uniforms.uPx = { value: 13 }; hovDots.frustumCulled = false; hovDots.renderOrder = 12; hov.add(hovDots);

// ---------------------------------------------------------------- camera rig
const [sourceMin, sourceMax] = lines.bbox_src;
const sourceCenter = new V3(...sourceMin).lerp(new V3(...sourceMax), 0.5);
const WIDE_C = new V3(0, GAP / 2, 0), P3 = new V3(...lines.P);
const pose = (c, az, el, d) => ({ c: c.clone(), az, el, d });
const surfacePose = pose(sourceCenter, 0, 0, 430);
const PA = pose(P3, lines.p_az, lines.p_el, 56), PB = pose(P3, lines.p_az + 4, lines.p_el - 2, 50);
const W1 = pose(WIDE_C, 0, 10, 650), W2 = pose(WIDE_C, -0.5, 9, 635), W3 = pose(WIDE_C, -2, 8, 600);
const dirOf = (az, el) => new V3(Math.cos(el * D2R) * Math.cos(az * D2R), Math.cos(el * D2R) * Math.sin(az * D2R), Math.sin(el * D2R));
const readPose = () => { const o = camera.position.clone().sub(controls.target), d = o.length(); return { c: controls.target.clone(), az: Math.atan2(o.y, o.x) / D2R, el: Math.asin(o.z / d) / D2R, d }; };
const applyPose = (p) => { camera.position.copy(p.c).addScaledVector(dirOf(p.az, p.el), p.d); controls.target.copy(p.c); controls.update(); viewer.invalidate(); };
const rig = { pose: readPose(), q: [], seg: null };
function setSegs(list, instant) {
  rig.pose = readPose(); rig.q = list.slice(); rig.seg = null;
  if (instant && list.length) { rig.pose = { ...list[list.length - 1].to, c: list[list.length - 1].to.c.clone() }; rig.q = []; applyPose(rig.pose); }
}
controls.addEventListener('start', () => { rig.q = []; rig.seg = null; stopIntroBounce(); });
controls.addEventListener('end', () => { rig.pose = readPose(); });
function stepRig(dt) {
  if (!rig.seg && rig.q.length) {
    const s = rig.q.shift(), f = rig.pose; let to = { ...s.to }, da = ((to.az - f.az + 540) % 360) - 180; to.az = f.az + da;
    rig.seg = { from: { ...f, c: f.c.clone() }, to, dur: s.dur, e: s.e || ease, t: 0 };
  }
  if (rig.seg) {
    const s = rig.seg; s.t += dt; const u = clamp(s.t / s.dur), k = s.e(u);
    rig.pose = { c: s.from.c.clone().lerp(s.to.c, k), az: s.from.az + (s.to.az - s.from.az) * k, el: s.from.el + (s.to.el - s.from.el) * k, d: Math.exp(Math.log(s.from.d) + (Math.log(s.to.d) - Math.log(s.from.d)) * k) };
    applyPose(rig.pose); if (u >= 1) rig.seg = null;
  }
}

// Move the surface vertically without turning the opening camera.
const BOUNCE_DELAY = 2.5;
const BOUNCE_PERIOD = 0.8;
let introBounceTime = null;
function stopIntroBounce() {
  if (introBounceTime === null) return;
  introBounceTime = null;
  srcC.root.position.z = 0;
  viewer.invalidate();
}

function stepIntroBounce(dt) {
  if (introBounceTime === null) return false;
  introBounceTime += dt;
  const bounceTime = introBounceTime - BOUNCE_DELAY;
  if (bounceTime < 0) return false;
  if (bounceTime >= 3 * BOUNCE_PERIOD) stopIntroBounce();
  else srcC.root.position.z = 5 * Math.sin(Math.PI * bounceTime / BOUNCE_PERIOD) ** 2;
  return true;
}

// ---------------------------------------------------------------- channels (animated scalars)
const V = { wire: 0, tint: 0, tgt: 0, rise: 0, cap1: 0, counter: 0, cnt: 0, lbl: 0, hint: 0 };
const anim = {}; let clock = 0;
function set(name, to, dur = 0.8, delay = 0, instant = false) {
  if (instant || dur <= 0 && delay <= 0) { V[name] = to; delete anim[name]; return; }
  anim[name] = { from: V[name], to, t0: clock + delay, dur: Math.max(dur, 1e-3) };
}
function stepAnims() {
  for (const [k, a] of Object.entries(anim)) {
    const u = (clock - a.t0) / a.dur; if (u < 0) continue;
    V[k] = a.from + (a.to - a.from) * smooth(u); if (u >= 1) { V[k] = a.to; delete anim[k]; }
  }
}
// The correspondence arcs and label transfer run on the fourth stage’s clock.
const T_END = 9.8;
let t4 = 0;
const tlines = (t) => ({
  grow: clamp((t - 0.1) / 3.0), sp: -0.15 + 1.3 * smooth((t - 2.3) / 2.2), tp: -0.15 + 1.3 * smooth((t - 4.5) / 2.6),
  out: 1 - ramp(t, 7.6, 8.8), cap2: ramp(t, 0.6, 1.3) * (1 - ramp(t, 4.4, 5.0)), cap3: ramp(t, 5.4, 6.2),
});

const STEPS = [
  { poses: [{ to: surfacePose }], ch: { cap1: [1], tgt: [0], rise: [RISE0], wire: [0], tint: [0], counter: [0], cnt: [0], lbl: [0] } },
  { poses: [{ to: PA, dur: 4.2 }, { to: PB, dur: 1.6, e: sine }], ch: { cap1: [0, .5], tgt: [0, .4], rise: [RISE0, .4], wire: [1, 1.6, 2.4], tint: [1, 1.5, 1.8], counter: [1, .8, 3.0], cnt: [1, 1.7, 3.0], lbl: [0, .4] } },
  { poses: [{ to: W1, dur: 3.8 }, { to: W2, dur: 1, e: sine }], ch: { cap1: [0, .4], tgt: [1, 1.8, .9], rise: [0, 2.2, .7], wire: [0, 1.4, .3], tint: [0, 1.8, .3], counter: [0, .6], cnt: [1, .1], lbl: [1, 1, 2.1] } },
  { poses: [{ to: W3, dur: 9.8, e: sine }], ch: { cap1: [0, .4], tgt: [1, .1], rise: [0, .1], wire: [0, .4], tint: [0, .4], counter: [0, .3], cnt: [1, .1], lbl: [1, .4] } },
];
const durations = [0, 5.8, 4.8, T_END];
let cur = 0, chapterStart = 0, playback = 'ready';
const play = $('play');
const chapterButtons = ['Surface', 'Mesh', 'Pair', 'Transfer'].map((label, index) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.hidden = true;
  button.addEventListener('click', () => selectChapter(index));
  $('chapters').appendChild(button);
  return button;
});

function setPlayback(state) {
  playback = state;
  if (state === 'playing') play.textContent = 'Pause';
  else if (state === 'ready' && cur === STEPS.length - 1) play.textContent = 'Replay';
  else play.textContent = 'Continue';
  play.classList.toggle('continue-prompt', play.textContent === 'Continue');
}

function finishChapter() {
  setSegs([], false);
  setPlayback('ready');
}

function selectChapter(n) {
  stopIntroBounce();
  cur = Math.max(0, Math.min(STEPS.length - 1, n));
  $('explore-hint').hidden = cur !== 0;
  const step = STEPS[cur];
  const instant = reduceMotion || cur === 0;
  chapterStart = clock;
  setSegs(step.poses, instant);
  for (const [name, [value, duration, delay = 0]] of Object.entries(step.ch)) {
    set(name, value, duration, delay, instant);
  }
  t4 = cur === STEPS.length - 1 && reduceMotion ? T_END : 0;
  chapterButtons[cur].hidden = false;
  chapterButtons.forEach((button, index) => {
    if (index === cur) button.setAttribute('aria-current', 'step');
    else button.removeAttribute('aria-current');
  });
  if (instant) finishChapter();
  else setPlayback('playing');
  viewer.invalidate();
}

play.addEventListener('click', () => {
  if (playback === 'playing') {
    setPlayback('paused');
  } else if (playback === 'paused') {
    setPlayback('playing');
  } else {
    selectChapter((cur + 1) % STEPS.length);
  }
  viewer.invalidate();
});

// ---------------------------------------------------------------- overlay projection
const tmp = new V3();
function proj(v) { tmp.copy(v).project(camera); return [(tmp.x + 1) / 2 * VW, (1 - tmp.y) / 2 * VH]; }
function bbox2d(bb, off) {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const i of [0, 1]) for (const j of [0, 1]) for (const k of [0, 1]) {
    const [x, y] = proj(new V3(bb[i][0] + off.x, bb[j][1] + off.y, bb[k][2] + off.z)); x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  return [x0, y0, x1, y1];
}
function overlays() {
  const u = VH / 1080, pad = 10 * u;
  $('cap1').style.opacity = V.cap1; $('counter').style.opacity = V.counter; $('cnt').textContent = Math.round(lines.n_src * (1 - Math.pow(1 - V.cnt, 3))).toLocaleString('en-US');
  const tl = tlines(t4);
  $('cap2').style.opacity = tl.cap2; $('cap3').style.opacity = tl.cap3; $('foot').style.opacity = tl.cap3;
  $('hint').style.opacity = V.hint;
  camera.updateMatrixWorld();
  if (V.lbl > 0.001) {
    const rs = bbox2d(lines.bbox_src, srcC.root.position), rt = bbox2d(lines.bbox_tgt, tgtC.root.position);
    const grow = (r) => [r[0] - pad, r[1] - pad, r[2] + pad, r[3] + pad];
    for (const [id, r] of [['shM', grow(rs)], ['shN', grow(rt)]]) { const e = $(id); e.style.opacity = V.lbl; e.style.left = (r[0] + r[2]) / 2 + 'px'; e.style.top = r[1] - 6 * u + 'px'; }
  } else { for (const id of ['shM', 'shN']) $(id).style.opacity = 0; }
}

// ---------------------------------------------------------------- hover bonus (target -> source)
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(); let hoverReq = null, pinned = false, hoverBusy = false;
view.addEventListener('pointermove', (e) => { if (e.buttons) return; hoverReq = e; });
view.addEventListener('pointerleave', () => { hoverReq = null; if (!pinned) hov.visible = false; $('tip').style.opacity = 0; viewer.invalidate(); });
view.addEventListener('click', (e) => { if (e.detail && hoverEnabled()) pinned = false; });
const hoverEnabled = () => cur === STEPS.length - 1 && t4 > 6.6;
const labelNames = (await srcC.labels()).names, srcLab = await srcC.attr('label'), tmpC = new V3();
async function doHover(e) {
  if (hoverBusy) return; hoverBusy = true;
  const r = view.getBoundingClientRect(); ndc.set((e.clientX - r.left) / r.width * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  tgtC.root.position.z = V.rise; camera.updateMatrixWorld(); ray.setFromCamera(ndc, camera);
  const h = tgtC.pick(ray); window.__h = h ? h.native : null;
  if (h) {
    const s = t2s[h.native], [pa, pb] = await Promise.all([tgtC.nativePosition(h.native), srcC.nativePosition(s)]);
    const a = pa.add(tgtC.root.position), b = pb.add(srcC.root.position);
    hovRib.setLine(0, a, b, 0, [0.87, 0.6, 0.2], 1);
    const p = hg.getAttribute('position'); p.set([a.x, a.y, a.z, b.x, b.y, b.z]); p.needsUpdate = true;
    hov.visible = true;
    const li = srcLab.array[s], nm = li === 255 ? 'unlabelled' : (labelNames[li] ?? '?');
    const tip = $('tip'); tip.innerHTML = `source vertex <b>${s.toLocaleString('en-US')}</b> · ${nm}`; tip.style.opacity = 1;
    tip.style.left = (e.clientX - r.left) + 'px'; tip.style.top = (e.clientY - r.top) + 'px';
  } else { hov.visible = false; $('tip').style.opacity = 0; }
  viewer.invalidate(); hoverBusy = false;
}

// ---------------------------------------------------------------- main ticker
viewer.addTicker((dt) => {
  let busy = stepIntroBounce(dt);
  if (playback === 'playing') {
    const duration = durations[cur];
    const elapsed = Math.min(duration, clock - chapterStart + dt * speed);
    const stepTime = chapterStart + elapsed - clock;
    clock = chapterStart + elapsed;
    stepAnims();
    stepRig(stepTime);
    if (cur === STEPS.length - 1) t4 = elapsed;
    if (elapsed >= duration) finishChapter();
    busy = true;
  }
  const tl = tlines(t4);
  srcC.bodyMix = V.tint; srcC.paint = tl.sp; tgtC.paint = tl.tp;
  const wm = srcC.wireMesh; wm.visible = V.wire > 0.002; wm.material.opacity = 0.5 * V.wire;
  tgtC.root.visible = V.tgt > 0.002; tgtC.material.opacity = V.tgt; tgtC.material.transparent = V.tgt < 0.999; tgtC.root.position.z = V.rise;
  shT.visible = V.tgt > 0.002; shT.material.opacity = V.tgt;
  LU.uGrow.value = tl.grow; LU.uPaint.value = tl.tp; LU.uOut.value = tl.out; lineGroup.visible = tl.grow > 0.001 && tl.out > 0.001;
  viewer.renderer.getDrawingBufferSize(RES); const pr = renderer.getPixelRatio(); LU.uWidth.value = 1.7 * pr; LU.uPx.value = 7.5 * pr;
  hovRib.material.uniforms.uWidth.value = 2.8 * pr; hovDots.material.uniforms.uPx.value = 13 * pr;
  const hint = hoverEnabled() ? Math.min(1, V.hint + dt / 0.8) : Math.max(0, V.hint - dt / 0.4);
  if (hint !== V.hint) { V.hint = hint; ovDirty = true; }
  if (!hoverEnabled()) { hov.visible = false; $('tip').style.opacity = 0; }
  if (hoverReq && hoverEnabled()) { const e = hoverReq; hoverReq = null; doHover(e); }
  if (ovDirty || busy) { overlays(); ovDirty = false; }
  if (dbg.style.display === 'block') dbg.textContent = `h=${window.__h} hov=${hov.visible} | src L${srcC.level} ${srcC.info?.tris.toLocaleString()} tris | tgt L${tgtC.level} | step ${cur} t4=${t4.toFixed(1)} | cam d=${camera.position.distanceTo(controls.target).toFixed(0)}`;
  return busy || (V.hint > 0 && V.hint < 1);
});

// Arrow keys can revisit stages that have already started.
addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
  event.preventDefault();
  const next = cur + (event.key === 'ArrowRight' ? 1 : -1);
  if (chapterButtons[next]?.hidden === false) selectChapter(next);
});

$('playback').hidden = false;
selectChapter(0);
viewer.renderOnce();
if (!reduceMotion) introBounceTime = 0;
