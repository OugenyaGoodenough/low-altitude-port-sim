/**
 * 能耗 / 充电设施 / 供电方案 因子扫描实验（Node 直接运行，无浏览器依赖）
 *
 *   node scripts/experiment_energy.mjs
 *
 * 研究问题：充电桩数量、充电模式（慢充/快充/换电）、供电方案（纯市电/光伏/光伏+储能）
 * 对吞吐量、延误、能耗与用电成本的影响。
 *
 * 输出：
 *   public/results/energy_experiment.csv   —— 因子 × 指标汇总表（可直接贴进计划书）
 *   public/results/energy_experiment.json  —— 完整指标
 *
 * 环境变量：
 *   POLICIES=all   —— 同时扫描三种管理策略（默认仅 graded，聚焦充电设施研究）
 *   SEED           —— 随机种子（默认 20260930）
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Sim } from '../src/sim/engine.js';
import { computeMetrics } from '../src/sim/metrics.js';
import { POLICY_IDS, POLICIES } from '../src/sim/config.js';
import { CHARGING_MODES, SUPPLY_DEFAULT } from '../src/sim/energy.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', 'public', 'results');
mkdirSync(outDir, { recursive: true });

const SEED = Number(process.env.SEED ?? 20260930);
const HORIZON = Number(process.env.HORIZON ?? 7200);
const WARMUP = Number(process.env.WARMUP ?? 900);

/** 充电模式 × 桩数 */
const CHARGE_GRID = [
  { mode: 'slow', chargers_n: 2 },
  { mode: 'slow', chargers_n: 4 },
  { mode: 'slow', chargers_n: 8 },
  { mode: 'fast', chargers_n: 2 },
  { mode: 'fast', chargers_n: 4 },
  { mode: 'fast', chargers_n: 8 },
  { mode: 'swap', chargers_n: 2 },
  { mode: 'swap', chargers_n: 4 },
  { mode: 'swap', chargers_n: 8 },
];

/** 供电方案（在 SUPPLY_DEFAULT 基础上覆盖；装机按充电负荷量级配置） */
const SUPPLY_PLANS = [
  { id: 'grid', label: '纯市电', supply: { pv_kWp: 0, storage_kWh: 0 } },
  {
    id: 'pv', label: '光伏',
    supply: { pv_kWp: 10, storage_kWh: 0, pvAmort_yuanPerKwh: 0.08 },
  },
  {
    id: 'pv_storage', label: '光伏+储能',
    supply: {
      pv_kWp: 10, storage_kWh: 10,
      pvAmort_yuanPerKwh: 0.08, storageAmort_yuanPerKwh: 0.25,
    },
  },
];

const LOADS = [1.0, 2.0];
const POLICIES_TO_RUN = process.env.POLICIES === 'all' ? POLICY_IDS : ['graded'];

const results = [];
const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;

function runCase({ policy, load, charging, supplyPlan }) {
  const sim = new Sim({
    policy, load, seed: SEED, horizon: HORIZON, warmup: WARMUP,
    charging, supply: { ...SUPPLY_DEFAULT, ...supplyPlan.supply },
  });
  sim.run();
  const m = computeMetrics(sim);
  return { sim, m };
}

function row(m, chargeMode, chargersN, supplyId) {
  const t = m.totals;
  return {
    策略: m.scenario.short,
    负荷: m.scenario.load,
    充电模式: CHARGING_MODES[chargeMode].label,
    充电桩数: chargersN,
    供电方案: supplyId,
    吞吐量_架次每小时: t.throughput_per_h,
    平均延误_s: t.avg_delay_s,
    冲突次数: t.conflicts,
    能耗_kWh_每小时: t.energy_kwh_per_h,
    单位能耗_kWh_每架次: t.energy_kwh_per_sortie,
    购电_kWh_每小时: t.grid_kwh_per_h,
    光伏自用_kWh_每小时: t.pv_kwh_per_h,
    储能放电_kWh_每小时: t.storage_kwh_per_h,
    用电成本_元_每小时: t.cost_yuan_per_h,
    平均充电时长_s: t.avg_charge_s,
    平均充电排队_s: t.avg_charge_queue_s,
    充电桩利用率_pct: t.charger_utilization_pct,
    停机坪利用率_pct: t.pad_utilization_pct,
  };
}

// 基线：无充电设施（满电出发，充电不占时间）
for (const load of LOADS) {
  for (const policy of POLICIES_TO_RUN) {
    const { m } = runCase({ policy, load, charging: { enabled: false }, supplyPlan: { supply: {} } });
    results.push({ ...row(m, 'none', 0, 'grid'), 基线: '是' });
    console.log(
      `基线  负荷 ${load}  吞吐 ${m.totals.throughput_per_h}/h  延误 ${m.totals.avg_delay_s}s`,
    );
  }
}

// 因子网格
for (const policy of POLICIES_TO_RUN) {
  for (const load of LOADS) {
    for (const c of CHARGE_GRID) {
      for (const sp of SUPPLY_PLANS) {
        const charging = { enabled: true, mode: c.mode, chargers_n: c.chargers_n };
        const { m } = runCase({ policy, load, charging, supplyPlan: sp });
        results.push({ ...row(m, c.mode, c.chargers_n, sp.label), 基线: '否' });
        console.log(
          `${m.scenario.short.padEnd(6)} 负荷${load} ${CHARGING_MODES[c.mode].label.padEnd(9)} ` +
            `桩${c.chargers_n} ${sp.label.padEnd(6)} ` +
            `吞吐 ${String(m.totals.throughput_per_h).padStart(6)}/h ` +
            `延误 ${String(m.totals.avg_delay_s).padStart(7)}s ` +
            `排队 ${String(m.totals.avg_charge_queue_s).padStart(6)}s ` +
            `成本 ${String(r2(m.totals.cost_yuan_per_h)).padStart(7)}元/h`,
        );
      }
    }
  }
}

const payload = {
  generatedAt: new Date().toISOString(),
  seed: SEED,
  horizon_s: HORIZON,
  warmup_s: WARMUP,
  policies: POLICIES_TO_RUN.map((p) => POLICIES[p].id),
  charging_modes: Object.fromEntries(Object.entries(CHARGING_MODES).map(([k, v]) => [k, v.label])),
  supply_plans: SUPPLY_PLANS.map((s) => s.label),
  results,
};
writeFileSync(resolve(outDir, 'energy_experiment.json'), JSON.stringify(payload, null, 2), 'utf8');

const rows = results;
const headers = Object.keys(rows[0]);
const csv = [headers.join(','), ...rows.map((r) => headers.map((h) => r[h]).join(','))].join('\n');
writeFileSync(resolve(outDir, 'energy_experiment.csv'), '\ufeff' + csv, 'utf8');

console.log(`\n已写出 ${outDir}`);
console.log(`  energy_experiment.json / energy_experiment.csv`);
console.log(`  共 ${results.length} 组（基线 ${LOADS.length * POLICIES_TO_RUN.length} + 网格 ${POLICIES_TO_RUN.length * LOADS.length * CHARGE_GRID.length * SUPPLY_PLANS.length}），种子 ${SEED}`);
