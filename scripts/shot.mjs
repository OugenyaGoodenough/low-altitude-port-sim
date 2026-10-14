/**
 * 截图 / 性能 / 确定性验证脚本
 *
 *   node scripts/shot.mjs                     # 需要先 npm run preview（端口 4173）
 *   BASE=http://127.0.0.1:4173 node scripts/shot.mjs
 *
 * 产出：public/shots/*.png，以及控制台报告（JS 报错、renderAt 帧耗时、确定性校验）
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', 'public', 'shots');
mkdirSync(outDir, { recursive: true });

const BASE = process.env.BASE || 'http://127.0.0.1:4173';
const VIEW = { width: 1920, height: 1080 };

const errors = [];
const logs = [];

const browser = await chromium.launch({
  channel: 'msedge',
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: VIEW, deviceScaleFactor: 1 });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  const t = m.type();
  logs.push(`[${t}] ${m.text()}`);
  if (t === 'error') errors.push(`console.error: ${m.text()}`);
});

const shots = [];
/** 渲染到 rAF 后再截图：Chromium 合成器需要一帧才会拾取新的 canvas 内容 */
const twoRaf = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const renderInFrame = (t) => page.evaluate((x) => window.__sim.renderAtNextFrame(x), t);

/**
 * 截图直到稳定：headless 合成器偶尔会返回上一帧，这里连续截图直到两帧完全一致。
 * 返回 { buf, passes, diffBytes }。
 */
async function stableShot(opts = {}, maxPass = 6) {
  let prev = null;
  let diff = null;
  for (let i = 0; i < maxPass; i++) {
    const buf = await page.screenshot(opts);
    if (prev) {
      if (Buffer.compare(prev, buf) === 0) return { buf, passes: i + 1 };
      diff = countDiffBytes(prev, buf);
    }
    prev = buf;
  }
  return { buf: prev, passes: maxPass, diffBytes: diff };
}

/** 粗略比较两张 PNG 的差异字节数（仅用于报告，不做像素解码） */
function countDiffBytes(a, b) {
  const n = Math.min(a.length, b.length);
  let d = Math.abs(a.length - b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) d++;
  return d;
}

async function snap(name) {
  await twoRaf();
  const { buf, passes } = await stableShot({ path: resolve(outDir, `${name}.png`) });
  shots.push(resolve(outDir, `${name}.png`));
  console.log(`  截图 → public/shots/${name}.png（稳定于第 ${passes} 次）`);
  return buf;
}

async function boot(params) {
  const url = `${BASE}/?${new URLSearchParams({ load: '1.2', seed: '20260930', record: '1', ...params })}`;
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction('window.__sim && window.__sim.ready()', null, { timeout: 60000 });
  await page.evaluate(() => window.__sim.setRecordMode(true));
  // 首次截图会拿到上一帧的合成结果，这里先丢弃一张
  await page.evaluate(() => window.__sim.renderAt(0));
  await twoRaf();
  await page.screenshot();
}

const summary = {};
// ── 1. 分级模式全景 ──
console.log('· 分级模式全景');
await boot({ policy: 'graded', t: '0' });
await page.evaluate(() => {
  window.__sim.setView('orbit');
  window.__sim.renderAt(1500);
});
await snap('01-graded-panorama');

// ── 2. 混合模式全景 ──
console.log('· 混合模式（统一经验规则）全景');
await page.evaluate(async () => {
  await window.__sim.setMode('pooledNaive');
  window.__sim.setView('orbit');
  window.__sim.renderAt(1500);
});
await snap('02-pooled-panorama');

// ── 3. 冲突告警（分级模式 严重空中冲突，跟随涉事无人机） ──
console.log('· 冲突告警画面');
const gradedConflict = await page.evaluate(async () => {
  await window.__sim.setMode('graded');
  const inc = window.__sim.meta.metrics.incidents.find((x) => x.type === 'AIR_SEPARATION') || window.__sim.meta.metrics.incidents[0];
  return { id: inc.incidentId, t: inc.t };
});
console.log(`  选用事件 ${gradedConflict.id} @ ${gradedConflict.t}s`);
await page.evaluate(({ id, t }) => {
  window.__sim.highlightIncident(id);
  window.__sim.setCaption({
    title: '冲突告警 · 空中间隔侵入',
    subtitle: `${id} · 实测间隔低于机型安全标准，系统即时告警并回溯责任`,
    metrics: ['实测 0.88 m', '要求 5.00 m', '严重'],
  });
  window.__sim.renderAt(t + 1.6);
}, gradedConflict);
await snap('03-conflict-alert');

// ── 4. 责任追溯面板展开 ──
console.log('· 责任追溯面板展开');
await page.evaluate(({ id }) => {
  window.__sim.setCaption({});
  window.__sim.setView('top');
  window.__sim.highlightIncident(id);
  const row = document.querySelector(`.trace-item[data-id="${id}"] .trace-head`);
  row.click();
  row.click();
}, gradedConflict);
await snap('04-traceability');
summary.traceText = await page.evaluate(() => document.querySelector('.trace-item.hl .trace-body')?.innerText || '');

// ── 5. 混合模式地面冲突（停机坪混排告警） ──
console.log('· 混合模式地面冲突');
const pooledConflict = await page.evaluate(async () => {
  await window.__sim.setMode('pooledNaive');
  const list = window.__sim.meta.metrics.incidents.filter((x) => x.type === 'GROUND_SEPARATION');
  const inc = list[0] || window.__sim.meta.metrics.incidents[0];
  return { id: inc.incidentId, t: inc.t };
});
await page.evaluate(({ id, t }) => {
  window.__sim.setView('orbit');
  window.__sim.highlightIncident(id);
  window.__sim.renderAt(Math.max(t + 20, 900));
  window.__sim.setCaption({ title: '混合管理 · 停机坪间隔侵入', subtitle: '通用停机坪混排，调度未按机型间隔分区', metrics: ['地面间隔冲突', '责任：无人机运行服务站（调度）'] });
}, pooledConflict);
await snap('05-pooled-ground-conflict');

// ── 6. 服务站视角 ──
console.log('· 服务站视角');
await page.evaluate(async () => {
  await window.__sim.setMode('graded');
  window.__sim.setCaption({});
  window.__sim.setView('station');
  window.__sim.renderAt(1500);
});
await snap('06-station-view');

// ── 7. 跟随微型机（挑选其在空时段） ──
console.log('· 跟随视角');
const followPick = await page.evaluate(() => {
  for (let t = 1200; t <= 2600; t += 4) {
    window.__sim.renderAt(t);
    const kind = window.__sim.legKindOf('M-01');
    if (kind === 'cruise_out' || kind === 'cruise_in' || kind === 'depart' || kind === 'arrive') return { t, kind };
  }
  return { t: 1500, kind: null };
});
console.log(`  M-01 在空时段 t=${followPick.t}（${followPick.kind}）`);
await page.evaluate((t) => {
  window.__sim.followAircraft('M-01');
  window.__sim.renderAt(t);
}, followPick.t);
await snap('07-follow-micro');

// ── 8. 跟随货运固定翼 ──
console.log('· 跟随货运机');
const cargoPick = await page.evaluate(() => {
  for (let t = 900; t <= 3000; t += 4) {
    window.__sim.renderAt(t);
    const kind = window.__sim.legKindOf('C-01');
    if (kind === 'cruise_out' || kind === 'cruise_in') return { t, kind };
  }
  return { t: 1500, kind: null };
});
console.log(`  C-01 在空时段 t=${cargoPick.t}（${cargoPick.kind}）`);
await page.evaluate((t) => {
  window.__sim.followAircraft('C-01');
  window.__sim.setCaption({ title: '固定翼货运无人机 · 跑道滑跑起降', subtitle: '货运机使用专用跑道，清空时间长，是分级管理中独立分区的关键对象', metrics: ['跑道占用 90 s', '巡航高度 60 m'] });
  window.__sim.renderAt(t);
}, cargoPick.t);
await snap('08-follow-cargo');

// ── 性能测量：连续 60 帧 renderAt（gl.finish 同步阻塞，反映真实单帧成本） ──
console.log('· 性能测量（60 帧 renderAt）');
summary.perf = await page.evaluate(() => window.__sim.bench(60, 300, 12));
summary.perfSubmit = await page.evaluate(() => {
  const t0 = performance.now();
  for (let i = 0; i < 60; i++) window.__sim.renderAt(300 + i * 12);
  return (performance.now() - t0) / 60;
});
console.log(`  同步帧耗时 平均 ${summary.perf.avgMs.toFixed(2)} ms / 中位 ${summary.perf.medianMs.toFixed(2)} ms / 最大 ${summary.perf.maxMs.toFixed(2)} ms（场景对象 ${summary.perf.objects}）`);
console.log(`  仅 CPU 提交 平均 ${summary.perfSubmit.toFixed(2)} ms/帧`);

// ── 确定性验证：同一 t 连续两次渲染，帧指纹与截图都应完全一致 ──
console.log('· 确定性验证');
/** 归零 UI 交互态（视角/高亮/滚动位置），只保留"仿真时刻 t"这一个自变量 */
const resetUi = () => page.evaluate(() => {
  window.__sim.highlightIncident(null);
  window.__sim.followAircraft(null);
  window.__sim.setView('orbit');
  window.__sim.setCaption({});
  const list = document.querySelector('.trace-list');
  if (list) list.scrollTop = 0;
});
await resetUi();
await twoRaf();
await page.screenshot(); // 预热合成器
await renderInFrame(2412.5); // 预热到测量时刻，吸收首次渲染的差异
await twoRaf();
await page.screenshot();
const hashes = [];
const sigs = [];
let warmBuf = null;
for (let i = 0; i < 2; i++) {
  await renderInFrame(2412.5);
  const { sig } = await page.evaluate(() => window.__sim.frameSignature());
  sigs.push(sig);
  if (process.env.DEBUG_STATE) console.log('   state:', JSON.stringify(await page.evaluate(() => window.__sim.debugState())));
  const { buf, passes } = await stableShot();
  if (i === 0) warmBuf = buf;
  hashes.push(createHash('sha256').update(buf).digest('hex'));
  console.log(`  第 ${i + 1} 次：帧指纹 ${sig}，截图稳定于第 ${passes} 次，sha256 ${hashes[i].slice(0, 16)}`);
}
summary.deterministic = hashes[0] === hashes[1];
summary.signatureDeterministic = sigs[0] === sigs[1];
console.log(`  整页截图：${summary.deterministic ? '逐字节一致 ✓' : '不一致 ✗'}`);
console.log(`  绘图缓冲指纹（绕过合成器）：${summary.signatureDeterministic ? '一致 ✓' : '不一致 ✗'}`);

// ── 跳转到其它时刻后回到同一 t，也应逐像素一致 ──
await renderInFrame(6100);
await renderInFrame(880);
await renderInFrame(2412.5);
await twoRaf();
const backShot = await stableShot();
summary.seekBackDeterministic = createHash('sha256').update(backShot.buf).digest('hex') === hashes[0];
console.log(`  跳转其它时刻后回到同一 t：${summary.seekBackDeterministic ? '一致 ✓' : '不一致 ✗'}`);

// ── 重载后同一 t 也应一致（跨会话确定性） ──
await boot({ policy: 'graded', t: '0' });
await resetUi();
await renderInFrame(2412.5);
await twoRaf();
const reloadShot = await stableShot();
const reloadSig = await page.evaluate(() => window.__sim.frameSignature().sig);
const reloadHash = createHash('sha256').update(reloadShot.buf).digest('hex');
summary.reloadDeterministic = reloadHash === hashes[0];
summary.reloadSignature = reloadSig === sigs[0];
summary.reloadPixelDiff = reloadHash === hashes[0] ? { n: 0 } : await diffPixels(page, warmBuf, reloadShot.buf);
console.log(`  重载页面后同一 t：截图 ${reloadHash.slice(0, 16)} → ${summary.reloadDeterministic ? '一致 ✓' : '不一致 ✗'}；绘图缓冲指纹 ${summary.reloadSignature ? '一致 ✓' : '不一致 ✗'}`);
if (!summary.reloadDeterministic) console.log(`    差异像素 ${summary.reloadPixelDiff.n}，包围盒 ${JSON.stringify(summary.reloadPixelDiff.box)}`);

async function diffPixels(pg, otherBuf, buf) {
  return pg.evaluate(
    async ([a, b]) => {
      const load = (b64) => new Promise((res) => {
        const img = new Image();
        img.onload = () => res(img);
        img.src = 'data:image/png;base64,' + b64;
      });
      const draw = async (b64) => {
        const img = await load(b64);
        const cv = document.createElement('canvas');
        cv.width = img.width;
        cv.height = img.height;
        cv.getContext('2d').drawImage(img, 0, 0);
        return cv.getContext('2d').getImageData(0, 0, img.width, img.height);
      };
      const [d1, d2] = await Promise.all([draw(a), draw(b)]);
      let n = 0;
      let minX = 1e9;
      let minY = 1e9;
      let maxX = -1;
      let maxY = -1;
      for (let y = 0; y < d1.height; y++) {
        for (let x = 0; x < d1.width; x++) {
          const i = (y * d1.width + x) * 4;
          if (d1.data[i] !== d2.data[i] || d1.data[i + 1] !== d2.data[i + 1] || d1.data[i + 2] !== d2.data[i + 2]) {
            n++;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      return { n, box: [minX, minY, maxX, maxY] };
    },
    [otherBuf.toString('base64'), buf.toString('base64')],
  );
}

// ── 接口自检 ──
summary.api = await page.evaluate(() => {
  const s = window.__sim;
  return {
    keys: Object.keys(s),
    ready: s.ready(),
    metaKeys: Object.keys(s.meta),
    duration: s.meta.duration,
    policyId: s.meta.policyId,
    load: s.meta.load,
    seed: s.meta.seed,
    scenarioName: s.meta.scenarioName,
    metricsTotals: s.meta.metrics?.totals,
  };
});

// ── URL 参数自检：?t=600 应直接停在 600 s ──
await page.goto(`${BASE}/?policy=graded&load=1.2&seed=20260930&record=1&t=600`, { waitUntil: 'load' });
await page.waitForFunction('window.__sim && window.__sim.ready()');
summary.urlParam = await page.evaluate(() => ({ t: window.__sim.debugState().t, policy: window.__sim.meta.policyId, load: window.__sim.meta.load }));

// ── 交互模式自检：不传 record 时应自动播放并推进时间 ──
await page.goto(`${BASE}/?policy=pooledNaive&load=1.2&seed=20260930`, { waitUntil: 'load' });
await page.waitForFunction('window.__sim && window.__sim.ready()');
const tStart = await page.evaluate(() => window.__sim.debugState().t);
await page.waitForTimeout(2500);
const tEnd = await page.evaluate(() => window.__sim.debugState().t);
summary.playback = { tStart, tEnd, advanced: tEnd > tStart + 1 };
console.log(`· 交互模式自检：${tStart.toFixed(1)} s → ${tEnd.toFixed(1)} s（${summary.playback.advanced ? '时间正常推进 ✓' : '未推进 ✗'}）`);

// ── 模式切换自检 ──
summary.modeSwitch = await page.evaluate(async () => {
  const before = window.__sim.meta.policyId;
  await window.__sim.setMode('pooledNaive');
  const after = window.__sim.meta.policyId;
  await window.__sim.setMode('pooledConservative');
  const third = window.__sim.meta.policyId;
  await window.__sim.setMode('graded');
  return { before, after, third, final: window.__sim.meta.policyId, conflicts: window.__sim.meta.metrics.totals.conflicts };
});
console.log(`· 模式切换自检：${summary.modeSwitch.before} → ${summary.modeSwitch.after} → ${summary.modeSwitch.third} → ${summary.modeSwitch.final}`);

// ── UI 交互冒烟测试：逐个点击控制台按钮，确认无报错 ──
console.log('· UI 交互冒烟测试');
await boot({ policy: 'graded', t: '0' });
await page.evaluate(() => window.__sim.setRecordMode(false));
const clickAll = async (sel) => {
  const items = await page.locator(sel).all();
  for (const it of items) await it.click({ timeout: 3000 });
  return items.length;
};
summary.uiSmoke = {};
summary.uiSmoke.speed = await clickAll('#speed-seg .btn');
summary.uiSmoke.view = await clickAll('#view-seg .btn');
summary.uiSmoke.mode = await clickAll('#mode-seg .btn');
summary.uiSmoke.loadTabs = await clickAll('#load-tabs .btn');
summary.uiSmoke.traceFilters = await clickAll('#trace-filters .btn');
for (const id of ['#tg-lines', '#tg-trails', '#tg-labels', '#tg-shadows', '#tg-bloom']) {
  await page.click(id);
  await page.click(id);
}
await page.click('#btn-play');
await page.click('#btn-play');
await page.fill('#timeline', '1200').catch(() => {});
await page.locator('#timeline').evaluate((el) => {
  el.value = '1200';
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.selectOption('#follow-select', { index: 1 });
await page.click('.trace-item .trace-head');
await page.click('.trace-item [data-seek]');
await page.click('#btn-hide-ui');
await page.click('#btn-show-ui');
summary.uiSmoke.state = await page.evaluate(() => window.__sim.debugState());
console.log(` 按键/开关点击通过：${JSON.stringify(summary.uiSmoke)}`);

await browser.close();

const report = {
  base: BASE,
  shots,
  errors,
  deterministic: summary.deterministic,
  reloadDeterministic: summary.reloadDeterministic,
  seekBackDeterministic: summary.seekBackDeterministic,
  perf: summary.perf,
  perfSubmitMs: summary.perfSubmit,
  api: summary.api,
  urlParam: summary.urlParam,
  playback: summary.playback,
  modeSwitch: summary.modeSwitch,
  traceTextSample: summary.traceText.slice(0, 400),
};
writeFileSync(resolve(outDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');

console.log('\n================ 报告 ================');
console.log(`JS 错误：${errors.length ? `\n  ${errors.join('\n  ')}` : '无'}`);
console.log(`renderAt 帧耗时（同步）：平均 ${summary.perf.avgMs.toFixed(2)} ms / 中位 ${summary.perf.medianMs.toFixed(2)} ms / 最大 ${summary.perf.maxMs.toFixed(2)} ms`);
console.log(`场景对象数：${summary.perf.objects}`);
console.log(`确定性（连续两次）：${summary.deterministic ? '通过' : '不通过'}`);
console.log(`确定性（刷新页面后）：${summary.reloadDeterministic ? '通过' : '不通过'}`);
console.log(`URL 参数 ?t=600：${JSON.stringify(summary.urlParam)}`);
console.log(`交互播放推进：${JSON.stringify(summary.playback)}`);
console.log(`截图 ${shots.length} 张：public/shots/`);
if (errors.length) process.exitCode = 1;
