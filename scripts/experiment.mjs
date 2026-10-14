/**
 * 对照实验脚本（Node 直接运行，无浏览器依赖）
 *
 *   npm run experiment
 *
 * 输出：
 *   public/results/experiment.json   —— 完整指标（供网页指标面板与计划书引用）
 *   public/results/experiment.csv    —— 汇总表（可直接贴进计划书）
 *   public/results/incidents.json    —— 责任追溯案例（含日志链）
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Sim } from '../src/sim/engine.js';
import { computeMetrics, summaryRows } from '../src/sim/metrics.js';
import { LOAD_LEVELS, POLICY_IDS, POLICIES } from '../src/sim/config.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', 'public', 'results');
mkdirSync(outDir, { recursive: true });

const SEED = Number(process.env.SEED ?? 20260930);
const HORIZON = Number(process.env.HORIZON ?? 7200);
const WARMUP = Number(process.env.WARMUP ?? 900);

const results = [];
const incidentLog = {};

for (const policyId of POLICY_IDS) {
  for (const load of LOAD_LEVELS) {
    const t0 = Date.now();
    const sim = new Sim({ policy: policyId, load, seed: SEED, horizon: HORIZON, warmup: WARMUP });
    sim.run();
    const m = computeMetrics(sim);
    m.runtime_ms = Date.now() - t0;
    results.push(m);
    console.log(
      `${m.scenario.short.padEnd(8)} 负荷 ${String(load).padEnd(4)} ` +
        `吞吐 ${String(m.totals.throughput_per_h).padStart(6)}/h  ` +
        `延误 ${String(m.totals.avg_delay_s).padStart(7)}s  ` +
        `冲突 ${String(m.totals.conflicts).padStart(4)}（空中 ${m.totals.conflicts_air} / 地面 ${m.totals.conflicts_ground}）  ` +
        `坪利用率 ${String(m.totals.pad_utilization_pct).padStart(5)}%  ` +
        `[调度 ${m.totals.accountability['调度指令错误']} / 飞手 ${m.totals.accountability['飞手违规']}]  ${m.runtime_ms}ms`,
    );
    if (load === 1) {
      const byId = new Map();
      const take = (list, n) => list.slice(0, n).forEach((a) => byId.set(a.incidentId, a));
      take(sim.autopsies.filter((a) => a.type === 'AIR_SEPARATION'), 4);
      take(sim.autopsies.filter((a) => a.type === 'GROUND_SEPARATION'), 2);
      take(sim.autopsies.filter((a) => a.category === '飞手违规'), 2);
      incidentLog[policyId] = {
        scenario: m.scenario,
        logSummary: sim.logSummary(),
        incidents: [...byId.values()],
        logSample: sim.log.slice(0, 24),
        metrics: m,
      };
    }
  }
}

const payload = {
  generatedAt: new Date().toISOString(),
  seed: SEED,
  horizon_s: HORIZON,
  warmup_s: WARMUP,
  policies: Object.fromEntries(POLICY_IDS.map((p) => [p, { id: POLICIES[p].id, name: POLICIES[p].name, desc: POLICIES[p].desc, rule: POLICIES[p].rule }])),
  load_levels: LOAD_LEVELS,
  results,
  summary: summaryRows(results),
};
writeFileSync(resolve(outDir, 'experiment.json'), JSON.stringify(payload, null, 2), 'utf8');
writeFileSync(resolve(outDir, 'incidents.json'), JSON.stringify(incidentLog, null, 2), 'utf8');

const rows = payload.summary;
const headers = Object.keys(rows[0]);
const csv = [headers.join(','), ...rows.map((r) => headers.map((h) => r[h]).join(','))].join('\n');
writeFileSync(resolve(outDir, 'experiment.csv'), '\ufeff' + csv, 'utf8');

console.log(`\n已写出 ${outDir}`);
console.log(`  experiment.json / experiment.csv / incidents.json`);
console.log(`  共 ${results.length} 组实验，种子 ${SEED}`);
