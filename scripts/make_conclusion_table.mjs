/**
 * 第一批对照数据表生成脚本（结论导向，负荷 2.0）
 * 输入：public/results/energy_experiment.csv（56 组因子扫描，种子 20260930）
 * 输出：
 *   - public/results/energy_conclusion_load2.csv  对照数据表（含派生列：吞吐保持率 / 成本较市电降幅）
 *   - public/results/energy_chart_data.json       桩数-吞吐-成本 曲线图数据（供报告图表复用）
 * 口径：无充电满电基线（负荷2）= 吞吐 556.6 架次/h、延误 26.5s；保持率=配置吞吐/基线吞吐。
 * 运行：node scripts/make_conclusion_table.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inCsv = path.join(root, 'public/results/energy_experiment.csv');
const outCsv = path.join(root, 'public/results/energy_conclusion_load2.csv');
const outJson = path.join(root, 'public/results/energy_chart_data.json');

const text = fs.readFileSync(inCsv, 'utf8');
const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim());
const headers = lines[0].split(',');
const rows = lines.slice(1).map((l) => {
  const v = l.split(',');
  const o = {};
  headers.forEach((h, i) => (o[h] = v[i]));
  return o;
});

const BASE = 556.6; // 无充电满电基线（负荷2）吞吐量
const MODE_KEY = '充电模式';
const N_KEY = '充电桩数';
const SUP_KEY = '供电方案';
const THR_KEY = '吞吐量_架次每小时';
const DELAY_KEY = '平均延误_s';
const COST_KEY = '用电成本_元_每小时';
const QUEUE_KEY = '平均充电排队_s';
const UTIL_KEY = '充电桩利用率_pct';

const load2 = rows.filter((r) => Number(r['负荷']) === 2);
const byModeN = new Map(); // `${mode}|${n}` -> {grid, pv, pv_storage}
for (const r of load2) {
  if (r[MODE_KEY] === '无充电（满电基线）') continue;
  const key = `${r[MODE_KEY]}|${r[N_KEY]}`;
  if (!byModeN.has(key)) byModeN.set(key, {});
  byModeN.get(key)[r[SUP_KEY]] = r;
}

// ── 对照数据表 CSV ──
const outHeaders = [
  '补能策略', '充电桩数', '供电方案', '吞吐量_架次每小时', '吞吐保持率_pct',
  '平均延误_s', '平均充电排队_s', '用电成本_元_每小时', '成本较市电降幅_pct', '充电桩利用率_pct',
];
const linesOut = [outHeaders.join(',')];
const modeOrder = ['慢充 3 kW', '快充 30 kW', '换电 2 min'];
const nOrder = ['2', '4', '8'];
const supOrder = ['纯市电', '光伏', '光伏+储能'];
for (const m of modeOrder) {
  for (const n of nOrder) {
    const rec = byModeN.get(`${m}|${n}`);
    if (!rec) continue;
    const gridCost = rec['纯市电'] ? Number(rec['纯市电'][COST_KEY]) : null;
    for (const s of supOrder) {
      const r = rec[s];
      if (!r) continue;
      const thr = Number(r[THR_KEY]);
      const cost = Number(r[COST_KEY]);
      const keep = (thr / BASE) * 100;
      const save = gridCost && gridCost > 0 ? ((1 - cost / gridCost) * 100).toFixed(1) : '0.0';
      linesOut.push([
        m, n, s,
        thr.toFixed(1), keep.toFixed(1),
        Number(r[DELAY_KEY]).toFixed(1), Number(r[QUEUE_KEY]).toFixed(1),
        cost.toFixed(2), save, Number(r[UTIL_KEY]).toFixed(1),
      ].join(','));
    }
  }
}
// 基线行
linesOut.push(`无充电（满电基线）,0,grid,${BASE.toFixed(1)},100.0,26.5,0,0,0.0,0`);
fs.writeFileSync(outCsv, `\ufeff${linesOut.join('\n')}\n`, 'utf8');

// ── 曲线图数据 JSON ──
const series = {};
for (const m of modeOrder) {
  const arr = [];
  for (const n of nOrder) {
    const rec = byModeN.get(`${m}|${n}`);
    arr.push(rec && rec['纯市电'] ? Number(rec['纯市电'][THR_KEY]).toFixed(1) : null);
  }
  series[m] = arr;
}
const costBySupply = {};
for (const s of ['纯市电', '光伏', '光伏+储能']) {
  const arr = [];
  for (const n of nOrder) {
    const rec = byModeN.get(`快充 30 kW|${n}`);
    arr.push(rec && rec[s] ? Number(rec[s][COST_KEY]).toFixed(2) : null);
  }
  costBySupply[s] = arr;
}
const chart = {
  seed: 20260930,
  load: 2,
  base: BASE,
  x: nOrder.map(Number),
  throughput: series,
  costBySupply: { note: '成本取快充 30 kW 配置（成本随桩数与供电方案变化，与补能策略关联小）', ...costBySupply },
};
fs.writeFileSync(outJson, JSON.stringify(chart, null, 2), 'utf8');

console.log('对照表行数（不含表头）:', linesOut.length - 1);
console.log('快充吞吐:', JSON.stringify(series['快充 30 kW']));
console.log('慢充吞吐:', JSON.stringify(series['慢充 3 kW']));
console.log('换电吞吐:', JSON.stringify(series['换电 2 min']));
console.log('成本·市电:', JSON.stringify(costBySupply['纯市电']));
console.log('成本·光伏:', JSON.stringify(costBySupply['光伏']));
console.log('成本·光伏+储能:', JSON.stringify(costBySupply['光伏+储能']));
console.log('输出:');
console.log(' ', outCsv);
console.log(' ', outJson);
