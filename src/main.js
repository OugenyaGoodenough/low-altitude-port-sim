/**
 * 应用入口：场景装配、播放循环、UI 绑定，以及录屏专用接口 window.__sim。
 *
 * window.__sim 的关键约定：
 *   - renderAt(t) 为同步、确定性渲染（不推进时钟、不依赖真实时间/随机数），
 *     同一 t 连续调用得到完全一致的画面与面板内容；
 *   - setRecordMode(true) 后内部时钟停止，只有 renderAt 会重绘；
 *   - setMode(policyId) 会重跑离散事件仿真并重建场景，返回 Promise（await 它即可继续）。
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { Sim } from './sim/engine.js?v=20261010b';
import { computeMetrics } from './sim/metrics.js?v=20261010b';
import { POLICY_IDS } from './sim/config.js?v=20261010b';
import { Replay } from './anim/replay.js?v=20261010b';
import { World } from './scene/world.js?v=20261010b';
import { DroneFleet } from './scene/drones.js?v=20261010b';
import { Effects } from './scene/effects.js?v=20261010b';
import { ViewRig } from './scene/views.js?v=20261010b';
import { UI } from './ui/panel.js?v=20261010b';

const params = new URLSearchParams(location.search);
const num = (v, d) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

const DEFAULT_DURATION = 7200;

/** 页面可切换的充电设施与供电方案（对应 src/sim/energy.js 的模型参数） */
const CHARGING_OPTIONS = {
  off: { label: '无充电', enabled: false },
  slow: { label: '慢充 3kW', enabled: true, mode: 'slow' },
  fast: { label: '快充 30kW', enabled: true, mode: 'fast' },
  swap: { label: '换电 2min', enabled: true, mode: 'swap' },
};
const SUPPLY_OPTIONS = {
  grid: { label: '纯市电', supply: {} },
  pv: { label: '光伏', supply: { pv_kWp: 10, storage_kWh: 0, pvAmort_yuanPerKwh: 0.08 } },
  pv_storage: { label: '光伏+储能', supply: { pv_kWp: 10, storage_kWh: 10, pvAmort_yuanPerKwh: 0.08, storageAmort_yuanPerKwh: 0.25 } },
};

// ───────────────────────────── 渲染器与场景 ─────────────────────────────
const stage = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: 'high-performance',
  preserveDrawingBuffer: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xcfdae2);
scene.fog = new THREE.Fog(0xc8d6e2, 2400, 9000);

const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.6, 11000);
camera.position.set(-420, 520, 620);

const composer = new EffectComposer(renderer);
const renderPass = new RenderPass(scene, camera);
const bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.55, 0.6, 0.82);
composer.addPass(renderPass);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

const world = new World(scene);
const fleet = new DroneFleet(scene);
const effects = new Effects(scene);
const views = new ViewRig(camera, renderer.domElement);

// ───────────────────────────── 运行状态 ─────────────────────────────
const meta = {
  duration: DEFAULT_DURATION,
  policyId: 'graded',
  load: 1.2,
  seed: 20260930,
  metrics: null,
  scenarioName: '',
};

const state = {
  policy: POLICY_IDS.includes(params.get('policy')) ? params.get('policy') : 'graded',
  load: num(params.get('load'), 2), // 默认负荷 2.0：冲突与充电排队更丰富，且与充电因子实验表默认 tab 一致
  seed: Math.round(num(params.get('seed'), 20260930)),
  quality: params.get('quality') === 'low' ? 'low' : 'high',
  playing: false,
  recordMode: params.get('record') === '1',
  speed: 2,
  t: 0,
  // 充电设施 / 供电方案（URL 参数 charge / chargers / supply）
  // 默认快充 4 台 + 纯市电：一打开即可看到充电桩与能耗成本指标；
  // 要回到"无充电"原始演示：控制台切"无充电"，或 URL 加 &charge=off
  chargingMode: CHARGING_OPTIONS[params.get('charge')] ? params.get('charge') : 'fast',
  chargersN: Math.round(num(params.get('chargers'), 4)),
  supply: SUPPLY_OPTIONS[params.get('supply')] ? params.get('supply') : 'grid',
};

let sim = null;
let replay = null;
let ready = false;

function applyQuality(quality) {
  state.quality = quality;
  const high = quality === 'high';
  renderer.shadowMap.enabled = high;
  world.sun.castShadow = high;
  bloomPass.enabled = high;
  scene.traverse((o) => {
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) m.needsUpdate = true;
    }
  });
  const tg = document.getElementById('tg-shadows');
  const tb = document.getElementById('tg-bloom');
  if (tg) tg.checked = high;
  if (tb) tb.checked = high;
}

const ui = new UI({
  onPlayToggle: () => (state.playing ? pause() : play()),
  onSpeed: (v) => {
    state.speed = v;
    ui.setSpeed(v);
  },
  onMode: (id) => setMode(id),
  onChargingMode: (mode) => setCharging({ chargingMode: mode }),
  onChargers: (n) => setCharging({ chargersN: Number(n) }),
  onSupply: (id) => setCharging({ supply: id }),
  onView: (name) => setView(name),
  onFollow: (id) => followAircraft(id),
  onToggle: (key, on) => {
    if (key === 'lines') effects.setCommandLinesVisible(on);
    if (key === 'trails') fleet.setTrailsVisible(on);
    if (key === 'labels') {
      fleet.setLabelsVisible(on);
      world.setLabelsVisible(on);
    }
    if (key === 'shadows') {
      renderer.shadowMap.enabled = on;
      world.sun.castShadow = on;
      applyNeedsUpdate();
    }
    if (key === 'bloom') bloomPass.enabled = on;
  },
  onSeek: (t) => seekTo(t),
  onIncidentSelect: (id) => highlightIncident(id),
});

function applyNeedsUpdate() {
  scene.traverse((o) => {
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) m.needsUpdate = true;
    }
  });
}

// ───────────────────────────── 仿真与场景重建 ─────────────────────────────
async function buildSim() {
  ui.showLoading(`正在运行离散事件仿真 · ${state.policy} · 负荷 ${state.load.toFixed(1)}`);
  await nextTick();
  const s = new Sim({
    policy: state.policy,
    load: state.load,
    seed: state.seed,
    horizon: DEFAULT_DURATION,
    warmup: 900,
    charging: CHARGING_OPTIONS[state.chargingMode],
    supply: { ...SUPPLY_OPTIONS[state.supply].supply },
  }).run();
  const rp = new Replay(s);
  sim = s;
  replay = rp;
  state.t = 0;

  const m = computeMetrics(s);
  Object.assign(meta, {
    duration: s.horizon,
    policyId: s.scn.policyId,
    load: s.scn.load,
    seed: s.seed,
    metrics: m,
    scenarioName: s.scn.name,
    scenarioShort: s.scn.short,
    warmup_s: s.warmup,
    horizon_s: s.horizon,
    sorties: m.totals.sorties,
    conflicts: m.totals.conflicts,
    chargingMode: state.chargingMode,
    chargersN: state.chargersN,
    supplyId: state.supply,
    supplyLabel: SUPPLY_OPTIONS[state.supply].label,
    /** 冲突事件清单（录屏脚本定位分镜用）：{id,t,endT,type,severity,category} */
    conflictList: s.conflicts.map((c) => ({
      id: c.id, t: c.t, endT: c.endT ?? c.t + 6, type: c.type,
      severity: c.severity, category: c.autopsy?.category ?? null, ac: c.pair.map((p) => p.ac),
    })),
    /** 可回放到的最晚时刻（超出 duration 的部分是热机尾段，不计入指标窗口） */
    replayEnd: s.horizon + 1800,
  });

  world.rebuildField(s);
  fleet.rebuild(s);
  effects.rebuild(s, rp);
  const apron = s.scn.layout.apronCenter;
  const ring = s.scn.layout.missionRing;
  // 注视点偏向远端任务区：停机坪（西）与任务环（东）都落在两侧面板之间的可视区内
  views.setCenter(apron[0] * 0.45 + ring.x * 0.55, (apron[1] + ring.z) / 2);
  if (!ui.selectedId) ui.selectedId = s.aircraft[0].id;
  const selected = s.aircraft.some((a) => a.id === ui.selectedId) ? ui.selectedId : s.aircraft[0].id;
  ui.selectedId = selected;
  views.followId = selected;
  fleet.select(selected);

  ui.bindSim(s, rp, meta);
  ui.setScenarioInfo({
    ...meta,
    fleetText: Object.entries(s.scn.fleet).map(([k, v]) => `${k === 'micro' ? '微' : k === 'heavy' ? '重' : '货'}${v}`).join(' '),
  });
  ui.hideLoading();
  applyQuality(state.quality);
  return s;
}

const nextTick = () => new Promise((res) => setTimeout(res, 0));

// ───────────────────────────── 渲染 ─────────────────────────────
function renderFrame() {
  composer.render();
}

/** 相机 → 机队位姿/标牌缩放 → 场地动效 → 特效，顺序固定 */
function updateScene(t) {
  views.update(t, replay, fleet);
  fleet.update(t, replay, camera);
  world.update(t, camera);
  effects.update(t);
}

function applyStateToScene(t) {
  updateScene(t);
  ui.airborne = fleet.airborneCount(replay, t);
  ui.updateAt(t);
}

function seekTo(t, keepPlay = false) {
  if (!replay) return;
  state.t = Math.max(0, Math.min(t, meta.replayEnd ?? meta.duration));
  if (!keepPlay) {
    state.playing = false;
    ui.setPlaying(false);
  }
  applyStateToScene(state.t);
  renderFrame();
}

function play() {
  if (!replay) return;
  state.playing = true;
  state.recordMode = false;
  last = performance.now();
  ui.setPlaying(true);
}

function pause() {
  state.playing = false;
  ui.setPlaying(false);
}

let last = performance.now();
let frameStats = { count: 0, ms: 0 };

function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.max(0, Math.min(0.3, (now - last) / 1000));
  last = now;
  if (!replay || state.recordMode) return;
  if (state.playing) {
    const s0 = performance.now();
    state.t = Math.min(state.t + dt * state.speed, meta.duration);
    applyStateToScene(state.t);
    renderFrame();
    frameStats.ms += performance.now() - s0;
    frameStats.count++;
    if (state.t >= meta.duration) {
      state.playing = false;
      ui.setPlaying(false);
    }
  } else {
    updateScene(state.t);
    renderFrame();
  }
}
requestAnimationFrame(loop);

// ───────────────────────────── 录屏 / 调试接口 ─────────────────────────────
function renderAt(t) {
  if (!replay) return false;
  state.playing = false;
  ui.setPlaying(false);
  seekTo(num(t, state.t));
  return true;
}

async function setMode(policyId) {
  if (!POLICY_IDS.includes(policyId)) throw new Error(`未知管理策略: ${policyId}`);
  if (policyId === state.policy && replay) return true;
  state.policy = policyId;
  const keepT = state.t;
  await buildSim();
  updateUrl();
  seekTo(Math.min(keepT, meta.duration));
  return true;
}

/** 切换充电设施 / 供电方案（重建仿真，保留当前播放时刻） */
async function setCharging(patch) {
  Object.assign(state, patch);
  if (state.chargingMode !== 'off') {
    state.chargersN = Math.max(1, Math.min(16, Math.round(state.chargersN)));
  }
  const keepT = state.t;
  await buildSim();
  updateUrl();
  seekTo(Math.min(keepT, meta.duration));
  return true;
}

function setView(name) {
  const ok = views.setView(name);
  ui.setView(name);
  return ok;
}

function followAircraft(id) {
  // id 为空时复位为默认选中机（不切换视角）
  const ac = id == null ? sim?.aircraft[0] : sim?.aircraft.find((a) => a.id === id);
  if (!ac) return false;
  ui.selectedId = ac.id;
  fleet.select(ac.id);
  views.followId = ac.id;
  ui.setFollowId(ac.id);
  if (id != null) {
    views.followAircraft(ac.id);
    ui.setView('follow');
  }
  return true;
}

function highlightIncident(id) {
  effects.setHighlight(id ?? null);
  ui.highlightIncident(id ?? null);
  return true;
}

function updateUrl() {
  const q = new URLSearchParams({ policy: state.policy, load: String(state.load), seed: String(state.seed) });
  q.set('charge', state.chargingMode);
  q.set('chargers', String(state.chargersN));
  q.set('supply', state.supply);
  if (state.recordMode) q.set('record', '1');
  history.replaceState(null, '', `${location.pathname}?${q}`);
}

window.__sim = {
  ready: () => ready,
  renderAt,
  stepTo: renderAt,
  setRecordMode(on) {
    state.recordMode = !!on;
    if (!on) last = performance.now();
    return state.recordMode;
  },
  setView,
  followAircraft,
  setMode,
  setChargingMode: (mode) => setCharging({ chargingMode: mode }),
  setChargers: (n) => setCharging({ chargersN: Number(n) }),
  setSupply: (id) => setCharging({ supply: id }),
  setCaption: (c) => ui.setCaption(c),
  highlightIncident,
  meta,
  // 以下为便于录屏脚本使用的扩展（非必需契约）
  play,
  pause,
  setSpeed: (v) => {
    state.speed = v;
    ui.setSpeed(v);
  },
  getTime: () => state.t,
  setTrailsVisible: (on) => {
    fleet.setTrailsVisible(on);
    document.getElementById('tg-trails').checked = on;
  },
  setCommandLinesVisible: (on) => {
    effects.setCommandLinesVisible(on);
    document.getElementById('tg-lines').checked = on;
  },
  setLabelsVisible: (on) => {
    fleet.setLabelsVisible(on);
    world.setLabelsVisible(on);
    document.getElementById('tg-labels').checked = on;
  },
  setQuality: (q) => applyQuality(q === 'low' ? 'low' : 'high'),
  /** 当前时刻在空的无人机 id 列表（录屏时便于挑选跟随目标） */
  airborneAircrafts: () => (replay ? fleet.items.filter((it) => replay.isAirborne(it.ac.id, state.t)).map((it) => it.ac.id) : []),
  legKindOf: (id) => (replay ? replay.legAt(id, state.t)?.kind ?? null : null),
  debugState: () => ({
    t: state.t,
    playing: state.playing,
    recordMode: state.recordMode,
    view: views.view,
    followId: views.followId,
    selected: fleet.selected,
    highlight: effects.highlightId,
    camera: camera.position.toArray().map((v) => Math.round(v * 1000) / 1000),
  }),
  setLoad(load) {
    state.load = Number(load);
    return buildSim().then(() => {
      updateUrl();
      seekTo(0);
      return true;
    });
  },
  /** 在浏览器帧回调内完成一次渲染（录制时可避免合成器读到上一帧） */
  renderAtNextFrame(t) {
    return new Promise((res) => {
      requestAnimationFrame(() => {
        renderAt(t);
        requestAnimationFrame(() => res(true));
      });
    });
  },

  /** 直接读回绘图缓冲（绕过浏览器合成器）计算帧指纹，用于确定性校验 */
  frameSignature() {
    composer.render();
    const gl = renderer.getContext();
    const w = renderer.domElement.width;
    const h = renderer.domElement.height;
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let sig = 2166136261 >>> 0;
    for (let i = 0; i < buf.length; i++) {
      sig ^= buf[i];
      sig = Math.imul(sig, 16777619) >>> 0;
    }
    return { sig, w, h };
  },

  perf: () => ({ frames: frameStats.count, avgMs: frameStats.count ? frameStats.ms / frameStats.count : 0 }),
  /** 同步测量的 renderAt 帧耗时（gl.finish 阻塞到 GPU 完成，反映真实单帧成本） */
  bench(n = 60, t0 = 300, dt = 12) {
    const gl = renderer.getContext();
    const times = [];
    for (let i = 0; i < n; i++) {
      const a = performance.now();
      renderAt(t0 + i * dt);
      gl.finish();
      times.push(performance.now() - a);
    }
    const sum = times.reduce((x, y) => x + y, 0);
    times.sort((a, b) => a - b);
    return {
      frames: n,
      avgMs: sum / n,
      medianMs: times[Math.floor(n / 2)],
      maxMs: times[n - 1],
      objects: this.objects(),
    };
  },
  objects: () => {
    let n = 0;
    scene.traverse(() => n++);
    return n;
  },
};

// ───────────────────────────── 启动 ─────────────────────────────
window.addEventListener('resize', () => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
});

window.addEventListener('keydown', (e) => {
  if (/input|select|textarea/i.test(e.target.tagName)) return;
  const k = e.key;
  if (k === ' ') {
    e.preventDefault();
    state.playing ? pause() : play();
  } else if (k === '1') setMode('graded');
  else if (k === '2') setMode('pooledConservative');
  else if (k === '3') setMode('pooledNaive');
  else if (k === 'q') setView('orbit');
  else if (k === 'w') setView('top');
  else if (k === 'e') setView('station');
  else if (k === 'r') setView('follow');
  else if (k === 'h') ui.toggleUI();
  else if (k === 'ArrowRight') seekTo(state.t + 10);
  else if (k === 'ArrowLeft') seekTo(state.t - 10);
  else if (k === 'Home') seekTo(0);
});

(async function boot() {
  ui.showLoading('正在构建高原机场场景…');
  await nextTick();
  world.buildBase();
  await buildSim();
  await ui.loadExperiment(); // 对照实验表就绪后才置 ready，保证首帧内容完整
  await ui.loadEnergyExperiment(); // 充电因子实验表（未生成时显示提示，不阻塞）
  const t0 = num(params.get('t'), 0);
  state.t = Math.max(0, Math.min(t0, meta.duration));
  applyStateToScene(state.t);
  ui.setSpeed(state.speed);
  ui.setView('orbit');
  if (params.get('ui') === '0') ui.toggleUI();
  ready = true;
  renderFrame();
  if (!state.recordMode) play();
  else ui.setPlaying(false);
})();
