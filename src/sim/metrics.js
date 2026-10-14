/** 指标聚合：全部数值取自引擎事件记录，窗口 [warmup, horizon] */
import { CLASSES, CLASS_IDS, CORRIDOR_LENGTH_M } from './config.js';
import { energyCost } from './energy.js';

const clip = (a, b, lo, hi) => Math.max(0, Math.min(b, hi) - Math.max(a, lo));
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};
const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;

export function computeMetrics(sim) {
  const { warmup, horizon } = sim;
  const hours = (horizon - warmup) / 3600;
  const done = sim.sorties.filter((s) => s.landT != null && s.landT >= warmup && s.landT <= horizon);
  const byClass = {};
  for (const cls of CLASS_IDS) {
    const list = done.filter((s) => s.cls === cls);
    const delays = list.map((s) => (s.waitDepart || 0) + (s.waitArrive || 0));
    const cycles = list.map((s) => s.cycleT).filter((x) => x != null && x > 0);
    byClass[cls] = {
      label: CLASSES[cls].label,
      fleet: sim.scn.fleet[cls],
      sorties: list.length,
      throughput_per_h: r1(list.length / hours),
      avg_delay_s: r1(avg(delays)),
      p95_delay_s: r1(pct(delays, 0.95)),
      avg_wait_depart_s: r1(avg(list.map((s) => s.waitDepart || 0))),
      avg_wait_arrive_s: r1(avg(list.map((s) => s.waitArrive || 0))),
      avg_cycle_s: r1(avg(cycles)),
      avg_charge_s: r1(avg(list.map((s) => (s.charge ? s.charge.chargeT : 0)))),
      avg_charge_queue_s: r1(avg(list.map((s) => (s.charge ? s.charge.queue : 0)))),
      ideal_cycle_s: r1(
        CLASSES[cls].turnaround_s +
          2 * (CLASSES[cls].clearance_s ?? CORRIDOR_LENGTH_M / CLASSES[cls].speed) +
          CLASSES[cls].route_s,
      ),
    };
  }

  const conflicts = sim.conflicts.filter((c) => c.t >= warmup && c.t <= horizon);
  const autopsies = sim.autopsies.filter((a) => a.t >= warmup && a.t <= horizon);
  const totalSorties = done.length;
  const byCategory = {};
  for (const a of autopsies) byCategory[a.category] = (byCategory[a.category] || 0) + 1;

  const padUtil = {};
  let padBusy = 0;
  let padCapacity = 0;
  for (const p of sim.pads) {
    const busy = p.busy.reduce((acc, [a, b]) => acc + clip(a, b, warmup, horizon), 0);
    padBusy += busy;
    padCapacity += horizon - warmup;
    padUtil[p.kind] = padUtil[p.kind] || { busy: 0, capacity: 0, pads: 0 };
    padUtil[p.kind].busy += busy;
    padUtil[p.kind].capacity += horizon - warmup;
    padUtil[p.kind].pads += 1;
  }

  // 充电桩利用率（启用充电设施时）
  let chgBusy = 0;
  let chgCap = 0;
  for (const c of sim.chargers) {
    const busy = c.busy.reduce((acc, [a, b]) => acc + clip(a, b, warmup, horizon), 0);
    chgBusy += busy;
    chgCap += horizon - warmup;
  }

  // 能耗与用电成本
  const chargeEvents = sim.chargeEvents.filter((e) => e.t >= warmup && e.t <= horizon);
  const energyKwh = done.reduce((acc, s) => acc + (s.energy_kwh || 0), 0);
  const cost = energyCost(chargeEvents, sim.supply);

  const chUtil = {};
  for (const ch of sim.channels) {
    const busy = ch.busy.reduce((acc, [a, b]) => acc + clip(a, b, warmup, horizon), 0);
    chUtil[ch.id] = {
      label: ch.label,
      owner: ch.owner,
      kind: ch.kind,
      grants: ch.movements.filter((m) => m.entryT >= warmup && m.entryT <= horizon).length,
      utilization_pct: r1((busy / (horizon - warmup)) * 100),
    };
  }

  const delaysAll = done.map((s) => (s.waitDepart || 0) + (s.waitArrive || 0));
  return {
    scenario: { id: sim.scn.id, policyId: sim.scn.policyId, name: sim.scn.name, short: sim.scn.short, load: sim.scn.load, rule: sim.scn.rule },
    seed: sim.seed,
    window: { warmup_s: warmup, horizon_s: horizon, hours: r2(hours) },
    fleet: sim.scn.fleet,
    totals: {
      sorties: totalSorties,
      throughput_per_h: r1(totalSorties / hours),
      avg_delay_s: r1(avg(delaysAll)),
      p95_delay_s: r1(pct(delaysAll, 0.95)),
      conflicts: conflicts.length,
      conflicts_air: conflicts.filter((c) => c.type === 'AIR_SEPARATION').length,
      conflicts_ground: conflicts.filter((c) => c.type === 'GROUND_SEPARATION').length,
      severe_conflicts: conflicts.filter((c) => c.severity === '严重').length,
      conflicts_per_1000_sorties: totalSorties ? r2((conflicts.length / totalSorties) * 1000) : 0,
      pad_utilization_pct: r1((padBusy / padCapacity) * 100),
      // 能耗与充电/用电成本
      energy_kwh_per_h: r1(energyKwh / hours),
      energy_kwh_per_sortie: r2(totalSorties ? energyKwh / totalSorties : 0),
      grid_kwh_per_h: r1(cost.grid_kwh / hours),
      pv_kwh_per_h: r1(cost.pv_kwh / hours),
      storage_kwh_per_h: r1(cost.storage_kwh / hours),
      cost_yuan_per_h: r2(cost.cost_yuan / hours),
      charge_events: chargeEvents.length,
      avg_charge_s: r1(avg(chargeEvents.map((e) => e.duration_s))),
      avg_charge_queue_s: r1(avg(chargeEvents.map((e) => e.queue))),
      charger_utilization_pct: sim.chargers.length ? r1((chgBusy / chgCap) * 100) : 0,
      accountability: {
        调度指令错误: byCategory['调度指令错误'] || 0,
        飞手违规: byCategory['飞手违规'] || 0,
      },
    },
    byClass,
    padUtilization: Object.fromEntries(
      Object.entries(padUtil).map(([k, v]) => [k, { pads: v.pads, utilization_pct: r1((v.busy / v.capacity) * 100) }]),
    ),
    channels: chUtil,
    incidents: autopsies.slice(0, 6),
  };
}

/** 对照实验汇总表（写入 CSV / 控制台） */
export function summaryRows(results) {
  return results.map((m) => ({
    场景: m.scenario.name,
    政策: m.scenario.policyId,
    负荷: m.scenario.load,
    微型机数量: m.fleet.micro,
    重型机数量: m.fleet.heavy,
    货运机数量: m.fleet.cargo,
    吞吐量_架次每小时: m.totals.throughput_per_h,
    平均延误_s: m.totals.avg_delay_s,
    P95延误_s: m.totals.p95_delay_s,
    冲突次数: m.totals.conflicts,
    空中冲突: m.totals.conflicts_air,
    地面冲突: m.totals.conflicts_ground,
    严重冲突: m.totals.severe_conflicts,
    千架次冲突率: m.totals.conflicts_per_1000_sorties,
    停机坪利用率_pct: m.totals.pad_utilization_pct,
    能耗_kWh_每小时: m.totals.energy_kwh_per_h,
    单位能耗_kWh_每架次: m.totals.energy_kwh_per_sortie,
    市电购电_kWh_每小时: m.totals.grid_kwh_per_h,
    光伏自用_kWh_每小时: m.totals.pv_kwh_per_h,
    储能放电_kWh_每小时: m.totals.storage_kwh_per_h,
    用电成本_元_每小时: m.totals.cost_yuan_per_h,
    平均充电时长_s: m.totals.avg_charge_s,
    平均充电排队_s: m.totals.avg_charge_queue_s,
    充电桩利用率_pct: m.totals.charger_utilization_pct,
    调度责任事件: m.totals.accountability['调度指令错误'],
    飞手责任事件: m.totals.accountability['飞手违规'],
  }));
}
