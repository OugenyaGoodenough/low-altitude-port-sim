/**
 * 演示视频录制脚本
 *
 *   npm run record                 录制 1080p30 完整演示视频
 *   npm run record -- --dry 60     只录前 60 帧（快速自检）
 *
 * 原理：Playwright 驱动 Edge（headless + 硬件加速 ANGLE/D3D11）打开仿真页面，
 * 逐帧调用 window.__sim.renderAtNextFrame(t) 把场景确定性地渲染到仿真时刻 t，
 * 截图（JPEG）经管道直接喂给 ffmpeg 编码为 MP4（帧不落盘，避免占用磁盘）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import ffmpegPath from 'ffmpeg-static';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const FPS = 30;
const W = 1920;
const H = 1080;
const PORT = Number(process.env.PORT ?? 4173);
const SEED = Number(process.env.SEED ?? 20260930);
const LOAD = Number(process.env.LOAD ?? 1.2);
const BASE = `http://127.0.0.1:${PORT}`;

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry');
const dryFrames = dryRun ? Number(argv[argv.indexOf('--dry') + 1] || 60) : 0;
const outFile = resolve(root, process.env.OUT ?? 'public/demo/low-altitude-port-demo.mp4');

/** 分镜表：view ∈ orbit|top|station|follow，rate = 每个视频秒推进的仿真秒数
 *  可选字段：charge（充电模式 off/slow/fast/swap）、chargers（桩数）、supply（供电 grid/pv/pv_storage） */
const SEGMENTS = [
  {
    id: '01-open', policy: 'graded', load: LOAD, view: 'orbit', t0: 1500, rate: 3, dur: 11,
    charge: 'fast', chargers: 4, supply: 'pv_storage',
    caption: {
      title: '低空港 · 面向节能减排的运行仿真',
      subtitle: 'eVTOL / 无人机垂直起降场：机型级能耗模型 · 停机坪充电设施 · 光伏储能供电',
    },
  },
  {
    id: '02-graded-ops', policy: 'graded', load: LOAD, view: 'top', t0: 2400, rate: 4, dur: 13,
    charge: 'fast', chargers: 4, supply: 'pv_storage',
    caption: {
      title: '分级运行：三类无人机并行起降与航线运行',
      subtitle: '微型机高频次垂直起降 · 重型机大间隔运行 · 货运机滑跑起降（货运跑道 420 m）',
    },
  },
  {
    id: '03-energy-model', policy: 'graded', load: LOAD, view: 'follow', followCls: 'micro', t0: 3200, rate: 2, dur: 12,
    charge: 'fast', chargers: 4, supply: 'pv_storage',
    caption: {
      title: '机型级能耗模型',
      subtitle: '任务电耗 ∝ 重量 × 速度剖面 × 爬升率，按机型分模型，取代"统一平均电耗"假设',
      metrics: [
        ['微型机 M 系列', '任务能耗 10.8 kWh/h · 含起降爬升与巡航段'],
        ['重型机 H 系列', '能耗权重随载重与爬升率上浮'],
      ],
    },
  },
  {
    id: '04-charging-apron', policy: 'graded', load: LOAD, view: 'station', t0: 4200, rate: 3, dur: 12,
    charge: 'fast', chargers: 4, supply: 'grid',
    caption: {
      title: '停机坪充电设施',
      subtitle: '4 × 快充 30 kW 桩：SOC 与充电排队耦合进周转时间，决定可用机队规模',
    },
  },
  {
    id: '05-soc-queue', policy: 'graded', load: LOAD, view: 'follow', followCls: 'micro', t0: 4800, rate: 2, dur: 10,
    charge: 'fast', chargers: 4, supply: 'pv_storage',
    caption: {
      title: '充电时间耦合进周转时间',
      subtitle: '任务回港 → 充电 → 再出港：快充 30 kW 充电时长显著短于慢充 3 kW（约 10 倍）',
    },
  },
  {
    id: '06-supply-switch', policy: 'graded', load: LOAD, view: 'orbit', t0: 5200, rate: 3, dur: 12,
    charge: 'fast', chargers: 4, supply: 'pv_storage',
    caption: {
      title: '供电方案：光伏 + 储能削峰填谷',
      subtitle: '用电成本：纯市电 39.15 → 光伏 28.48 → 光伏+储能 24.96 元/h（购电降 36%）',
      metrics: [
        ['纯市电', '39.15 元/h · 全部购自电网'],
        ['光伏 10 kWp', '28.48 元/h · 自发自用'],
        ['光伏 + 储能 10 kWh', '24.96 元/h · 削峰填谷'],
      ],
    },
  },
  {
    id: '07-experiment', policy: 'graded', load: LOAD, view: 'orbit', t0: 5600, rate: 5, dur: 12,
    charge: 'fast', chargers: 4, supply: 'pv_storage',
    caption: {
      title: '因子实验结论：桩数 × 补能策略 × 供电（56 组）',
      subtitle: '吞吐保持率 ≥ 99% 约束下：快充 4 台即最优，慢充 / 换电 8 台仍保不住吞吐',
      metrics: [
        ['快充 30kW × 4 台', '吞吐 550.9/h · 保持率 99.0%'],
        ['慢充 3kW × 8 台', '吞吐 451.4/h · 保持率 81.1%'],
        ['换电 2min × 8 台', '吞吐 239.4/h · 保持率 43.0%'],
      ],
    },
  },
  {
    id: '08-end', policy: 'graded', load: LOAD, view: 'orbit', t0: 6200, rate: 4, dur: 10,
    charge: 'fast', chargers: 4, supply: 'pv_storage',
    caption: {
      title: '结论：快充 30 kW × 4 台 + 光伏 10 kWp + 储能 10 kWh',
      subtitle: '吞吐保持 99%，电网购电降低 36%，避免过度建设（桩利用率 13.6% 即封顶）',
    },
  },
];

// ────────────────────────── 本地预览服务 ──────────────────────────
async function probe() {
  try {
    const r = await fetch(BASE, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

async function ensureServer() {
  if (await probe()) return { proc: null };
  const proc = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: root, shell: true, stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await probe()) return { proc };
  }
  proc.kill();
  throw new Error('无法启动 vite preview');
}

// ────────────────────────── ffmpeg 管道 ──────────────────────────
function startEncoder() {
  mkdirSync(dirname(outFile), { recursive: true });
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'image2pipe', '-vcodec', 'mjpeg', '-framerate', String(FPS), '-i', '-',
    '-vf', `scale=${W}:${H}:flags=bicubic,format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-g', String(FPS * 2),
    '-movflags', '+faststart', outFile,
  ];
  const proc = spawn(ffmpegPath, args, { stdio: ['pipe', 'inherit', 'inherit'] });
  let chain = Promise.resolve();
  let count = 0;
  const write = (buf) =>
    new Promise((res, rej) => {
      if (proc.stdin.write(buf)) res();
      else proc.stdin.once('drain', res);
      proc.stdin.once('error', rej);
    });
  return {
    push(buf) {
      count += 1;
      chain = chain.then(() => write(buf));
      return chain;
    },
    async finish() {
      await chain;
      await new Promise((res) => proc.stdin.end(res));
      return new Promise((res) => proc.on('exit', (code) => res({ code, count })));
    },
  };
}

// ────────────────────────── 主流程 ──────────────────────────
const { proc: server } = await ensureServer();
const encoder = startEncoder();
const browser = await chromium.launch({
  channel: 'msedge',
  headless: true,
  args: ['--force-device-scale-factor=1', '--hide-scrollbars', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

async function openSegment(seg) {
  const q = new URLSearchParams({
    policy: seg.policy, load: String(seg.load), seed: String(SEED), record: '1', t: '0',
  });
  if (seg.charge) q.set('charge', seg.charge);
  if (seg.chargers) q.set('chargers', String(seg.chargers));
  if (seg.supply) q.set('supply', seg.supply);
  const url = `${BASE}/?${q}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__sim && window.__sim.ready()', null, { timeout: 60000 });
  await page.evaluate(() => window.__sim.setRecordMode(true));
  if (seg.view) await page.evaluate((v) => window.__sim.setView(v), seg.view);
  if (seg.followCls) {
    const id = await page.evaluate((cls) => {
      const list = window.__sim.airborneAircrafts?.() ?? [];
      const want = cls === 'micro' ? 'M-' : cls === 'heavy' ? 'H-' : 'C-';
      return list.find((x) => x.startsWith(want)) ?? list[0] ?? null;
    }, seg.followCls);
    if (id) await page.evaluate((v) => window.__sim.followAircraft(v), id);
  }
  return page.evaluate(() => ({
    conflicts: (window.__sim.meta.conflictList ?? window.__sim.meta.metrics?.incidents ?? []).map((c) => ({
      id: c.id, t: c.t, type: c.type, severity: c.severity ?? '一般',
    })),
    replayEnd: window.__sim.meta.replayEnd ?? window.__sim.meta.duration ?? 7200,
  }));
}

function pickAnchor(seg, info) {
  const want = seg.anchor === 'conflict_ground' ? 'GROUND_SEPARATION' : 'AIR_SEPARATION';
  const list = info.conflicts.filter((c) => c.type === want && c.t > 1000);
  const pool = list.filter((c) => c.severity === '严重');
  const chosen = (pool.length ? pool : list)[0] ?? info.conflicts[0];
  if (!chosen) return { t0: 2000, id: null };
  return { t0: chosen.t + (seg.offset ?? -6), id: chosen.id };
}

let rendered = 0;
let aborted = false;
for (const seg of SEGMENTS) {
  if (aborted) break;
  const info = await openSegment(seg);
  const anchor = seg.anchor ? pickAnchor(seg, info) : { t0: seg.t0, id: null };
  if (anchor.id && seg.highlight) await page.evaluate((id) => window.__sim.highlightIncident(id), anchor.id);
  if (seg.caption) {
    await page.evaluate((c) => window.__sim.setCaption(c), {
      ...seg.caption,
      metrics: seg.caption.metrics ?? undefined,
    });
  }
  const frames = Math.round(seg.dur * FPS);
  for (let f = 0; f < frames; f++) {
    const t = Math.max(0, anchor.t0 + (f / FPS) * seg.rate);
    await page.evaluate(async (tt) => {
      if (window.__sim.renderAtNextFrame) await window.__sim.renderAtNextFrame(tt);
      else window.__sim.renderAt(tt);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }, t);
    const buf = await page.screenshot({ type: 'jpeg', quality: 92 });
    await encoder.push(buf);
    rendered += 1;
    if (dryRun && rendered >= dryFrames) { aborted = true; break; }
    if (rendered % 150 === 0) process.stdout.write(`\r  已渲染 ${rendered} 帧 (${(rendered / FPS).toFixed(1)}s)`);
  }
  console.log(`\r  ✓ 分镜 ${seg.id.padEnd(22)} ${frames} 帧  anchor=${anchor.id ?? '-'} t0=${anchor.t0.toFixed(1)}s`);
}

await browser.close();
const { code, count } = await encoder.finish();
if (server) server.kill();

const size = existsSync(outFile) ? (await import('node:fs')).statSync(outFile).size : 0;
const probeOut = spawnSync(ffmpegPath, ['-hide_banner', '-i', outFile], { encoding: 'utf8' });
const durLine = (probeOut.stderr || '').split('\n').find((l) => l.includes('Duration'));
console.log(`\n输出：${outFile}`);
console.log(`  帧数 ${count} · 时长 ≈ ${(count / FPS).toFixed(1)}s · 体积 ${(size / 1048576).toFixed(1)} MB · ffmpeg 退出码 ${code}`);
console.log(`  ${durLine?.trim() ?? ''}`);
if (errors.length) {
  console.log(`  ⚠ 页面报错 ${errors.length} 条：`);
  errors.slice(0, 5).forEach((e) => console.log(`    ${e}`));
  process.exitCode = 1;
} else {
  console.log('  页面无 JS 报错');
}
