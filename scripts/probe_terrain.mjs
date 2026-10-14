/**
 * 地形遮挡 / 构图核验工具
 *
 *   node scripts/probe_terrain.mjs            # 环绕视角（默认视角参数）
 *   node scripts/probe_terrain.mjs top        # 俯视视角
 *   POL=0.5 DIST=900 node scripts/probe_terrain.mjs
 *
 * 方法：对每个方位角、沿相机视场自上而下取 32 条视线，逐 6 m 步进求与地形高程场的交点，
 * 统计三类结果：
 *   BLOCKED —— 交点在运行区（距场区中心 < 400 m）且高程 > 3 m：山体挡住场区/跑道/停机坪/任务环（必须为 0）
 *   mtn     —— 交点高程 > 60 m：该行画面是山体
 *   flat    —— 交点落在运行区平地：该行画面是场区
 * 同时报告相机正下方地形高度与相机高度的差值（防止相机埋进山体）。
 */
import { heightAt } from '../src/scene/world.js';

const FOV = (Number(process.env.FOV || 42) * Math.PI) / 180;
const ROWS = Number(process.env.ROWS || 32);
const PITCH_UP = Number(process.env.PITCH || 0.026); // 与 views.js 的 COMPOSE_PITCH 保持一致
const FIELD = { x: 10, z: 20 };
const APRON = { x: -120, z: 40 };
const RING = { x: 300, z: 40 };
// 与 main.js 的 views.setCenter(...) 一致
const CENTER = { x: APRON.x * 0.45 + RING.x * 0.55, y: 8, z: (APRON.z + RING.z) / 2 };

function camFrames(view) {
  if (view === 'top') {
    const pol = 1.45;
    const D = Number(process.env.TOPD || 1500);
    const az = 0.35;
    return [{ az, pol, D, cam: position(CENTER, az, pol, D) }];
  }
  const pol = Number(process.env.POL || 0.44);
  const D = Number(process.env.DIST || 950);
  const out = [];
  for (let a = 0; a < 360; a += 10) {
    const az = (a * Math.PI) / 180;
    out.push({ az, pol, D, cam: position(CENTER, az, pol, D) });
  }
  return out;
}

function position(target, az, pol, D) {
  return {
    x: target.x + Math.sin(az) * Math.cos(pol) * D,
    y: target.y + Math.sin(pol) * D,
    z: target.z + Math.cos(az) * Math.cos(pol) * D,
  };
}

/** 视线基（含构图抬头偏移） */
function basis(cam, target) {
  const f = { x: target.x - cam.x, y: target.y - cam.y, z: target.z - cam.z };
  const fl = Math.hypot(f.x, f.y, f.z);
  f.x /= fl; f.y /= fl; f.z /= fl;
  const r = { x: -f.z, y: 0, z: f.x };
  const rl = Math.hypot(r.x, r.z);
  r.x /= rl; r.z /= rl;
  const u = { x: f.y * r.z - f.z * r.y, y: f.z * r.x - f.x * r.z, z: f.x * r.y - f.y * r.x };
  const c = Math.cos(PITCH_UP);
  const s = Math.sin(PITCH_UP);
  return {
    f: { x: f.x * c + u.x * s, y: f.y * c + u.y * s, z: f.z * c + u.z * s },
    r,
    u: { x: u.x * c - f.x * s, y: u.y * c - f.y * s, z: u.z * c - f.z * s },
  };
}

function cast(cam, b, sy) {
  const dir = { x: b.f.x + b.u.x * sy, y: b.f.y + b.u.y * sy, z: b.f.z + b.u.z * sy };
  for (let s = 4; s < 9000; s += 6) {
    const x = cam.x + dir.x * s;
    const y = cam.y + dir.y * s;
    const z = cam.z + dir.z * s;
    const h = heightAt(x, z);
    if (y < h) return { h, d: Math.hypot(x - FIELD.x, z - FIELD.z) };
  }
  return null;
}

const view = process.argv[2] || 'orbit';
const verbose = process.env.QUIET !== '1';
let blockedTotal = 0;
let hillTotal = 0;
let fieldTotal = 0;
let rowsTotal = 0;
let worstHills = 0;
let minClearance = Infinity;

/** 俯视视角是平面构图，用面网格采样统计各类面积占比 */
function gridScan(fr) {
  const b = basis(fr.cam, { x: CENTER.x, y: 0, z: CENTER.z });
  const cols = 40;
  const lines = 24;
  const stats = { field: 0, mtn: 0, near: 0, sky: 0, blocked: 0, total: 0 };
  const tanHalf = Math.tan(FOV / 2);
  for (let iy = 0; iy < lines; iy++) {
    const sy = tanHalf * (1 - (2 * iy) / (lines - 1));
    for (let ix = 0; ix < cols; ix++) {
      const sx = tanHalf * ((2 * ix) / (cols - 1) - 1) * (16 / 9);
      const cam = fr.cam;
      const dir = {
        x: b.f.x + b.r.x * sx + b.u.x * sy,
        y: b.f.y + b.r.y * sx + b.u.y * sy,
        z: b.f.z + b.r.z * sx + b.u.z * sy,
      };
      let hit = null;
      for (let s = 4; s < 9000; s += 8) {
        const x = cam.x + dir.x * s;
        const y = cam.y + dir.y * s;
        const z = cam.z + dir.z * s;
        const h = heightAt(x, z);
        if (y < h) { hit = { h, d: Math.hypot(x - FIELD.x, z - FIELD.z) }; break; }
      }
      stats.total++;
      if (!hit) stats.sky++;
      else if (hit.d < 400 && hit.h > 3) stats.blocked++;
      else if (hit.h > 60) stats.mtn++;
      else if (hit.d < 400) stats.field++;
      else stats.near++;
    }
  }
  return stats;
}

if (view === 'top') {
  const stats = gridScan(camFrames('top')[0]);
  const p = (n) => `${((n / stats.total) * 100).toFixed(0)}%`;
  console.log('\n================ 核验结论（俯视 · 40×24 面网格采样）================');
  console.log(`采样点 ${stats.total}`);
  console.log(`遮挡场区：${stats.blocked}（必须为 0）${stats.blocked === 0 ? ' ✓' : ' ✗'}`);
  console.log(`场地面积占比：${p(stats.field)}　山体面积占比：${p(stats.mtn)}　场区外缓坡：${p(stats.near)}`);
  const camGround = heightAt(camFrames('top')[0].cam.x, camFrames('top')[0].cam.z);
  console.log(`相机离地高度：${Math.round(camFrames('top')[0].cam.y - camGround)} m ✓`);
  if (stats.blocked > 0) process.exitCode = 1;
  process.exit(process.exitCode || 0);
}

for (const fr of camFrames(view)) {
  const b = basis(fr.cam, { x: CENTER.x, y: 0, z: CENTER.z });
  const camGround = heightAt(fr.cam.x, fr.cam.z);
  minClearance = Math.min(minClearance, fr.cam.y - camGround);
  const marks = [];
  let blocked = 0;
  let hills = 0;
  let field = 0;
  for (let i = 0; i < ROWS; i++) {
    const sy = Math.tan(FOV / 2) * (1 - (2 * i) / (ROWS - 1));
    const hit = cast(fr.cam, b, sy);
    rowsTotal++;
    if (!hit) { marks.push('sky'); continue; }
    if (hit.d < 400 && hit.h > 3) { blocked++; blockedTotal++; marks.push('BLOCKED'); }
    else if (hit.h > 60) { hills++; hillTotal++; marks.push('mtn'); }
    else if (hit.d < 400) { field++; fieldTotal++; marks.push('flat'); }
    else marks.push('near');
  }
  if (hills > worstHills) worstHills = hills;
  if (verbose) {
    console.log(
      `方位${String(Math.round((fr.az * 180) / Math.PI)).padStart(3)} 相机高${Math.round(fr.cam.y)} 离地${String(Math.round(fr.cam.y - camGround)).padStart(4)}` +
        ` | 山体行 ${String(hills).padStart(2)}/${ROWS}  遮挡行 ${blocked} | ${marks.join(',')}`,
    );
  }
}

const pct = (n) => `${((n / rowsTotal) * 100).toFixed(0)}%`;
console.log('\n================ 核验结论 ================');
console.log(`视线总数 ${rowsTotal}（${view}）`);
console.log(`遮挡场区的视线：${blockedTotal}（必须为 0）${blockedTotal === 0 ? ' ✓' : ' ✗'}`);
console.log(`山体视线占比：${pct(hillTotal)}（单方位最多 ${worstHills}/${ROWS}）`);
console.log(`场区平地视线占比：${pct(fieldTotal)}`);
console.log(`相机最小离地高度：${Math.round(minClearance)} m ${minClearance > 60 ? '✓' : '✗ 相机可能埋入山体'}`);
if (blockedTotal > 0 || minClearance <= 60) process.exitCode = 1;
