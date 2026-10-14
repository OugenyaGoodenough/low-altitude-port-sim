/**
 * 能耗与充电设施模型（研究扩展模块）
 *
 * 物理简化模型（参数为行业典型示例值，答辩/计划书前请按真实机型数据校准）：
 *  - 旋翼悬停功率（动量理论）：P_hover = W^1.5 / (√(2·ρ·A) · FM)，即"能耗 ∝ 重量 ^1.5"
 *  - 多旋翼巡航功率（U 型曲线）：P(v) = P_hover·(v_h/v) + 0.5·ρ·CdA·v³
 *  - 固定翼巡航功率：P = W·v / (L/D)
 *  - 爬升功率：P_climb = W·ROC + 悬停项（旋翼）/ 巡航项（固定翼），即"能耗 ∝ 爬升率"
 *  - 单次任务能耗：E = Σ P_i·Δt_i（爬升 + 往返巡航 + 下降 + 空中等待盘旋）
 *
 * 充电设施：慢充 / 快充 / 换电三种模式；充电桩为有限服务台，排队 + 充电时长耦合进周转时间；
 * 供电总功率上限约束并发充电功率（快充并发受限时充电时间拉长）。
 *
 * 供电侧：分时电价 + 光伏日内出力 + 储能（谷充峰放），影响"用电成本"指标。
 * 所有成本函数为确定性简化模型，供对照研究使用。
 */

import { CLASSES } from './config.js';

export const G = 9.81;
export const RHO = 1.225; // 海平面标准大气密度 kg/m³

/** 每类机型的能耗参数（示例值，需按真实机型校准） */
export const ENERGY_PARAMS = {
  micro: {
    weight_kg: 1.5,         // 总重（含载重）
    battery_kwh: 0.12,      // 电池容量
    disk_area_m2: 0.50,     // 旋翼桨盘总面积
    dragArea_m2: 0.020,     // 废阻力面积 Cd·A
    liftDrag: null,         // 固定翼升阻比（旋翼为 null）
    cruiseAlt_m: 120,       // 巡航高度
    climbRate_mps: 3.0,     // 爬升率
    figureMerit: 0.70,      // 悬停品质因数 FM
    mission_s: 900,         // 真实任务巡航时长（往返，能耗结算用；与演示航线 route_s 解耦）
    battery_cost_yuan: 500, // 单块电池成本（换电模式的备件投资）
  },
  heavy: {
    weight_kg: 15,
    battery_kwh: 1.5,
    disk_area_m2: 4.02,
    dragArea_m2: 0.15,
    liftDrag: null,
    cruiseAlt_m: 150,
    climbRate_mps: 2.5,
    figureMerit: 0.70,
    mission_s: 1800,
    battery_cost_yuan: 4000,
  },
  cargo: {
    weight_kg: 30,
    battery_kwh: 3.0,
    disk_area_m2: null,
    dragArea_m2: 0.30,
    liftDrag: 12,
    cruiseAlt_m: 200,
    climbRate_mps: 2.0,
    figureMerit: null,
    mission_s: 2400,
    battery_cost_yuan: 8000,
  },
};

/** 悬停功率（W）；固定翼无悬停工况，返回 null */
export function hoverPowerW(cls) {
  const p = ENERGY_PARAMS[cls];
  if (!p.disk_area_m2) return null;
  const W = p.weight_kg * G;
  return Math.pow(W, 1.5) / Math.sqrt(2 * RHO * p.disk_area_m2) / p.figureMerit;
}

/** 悬停诱导速度 v_h（m/s） */
export function hoverInducedSpeed(cls) {
  const p = ENERGY_PARAMS[cls];
  if (!p.disk_area_m2) return null;
  return Math.sqrt((p.weight_kg * G) / (2 * RHO * p.disk_area_m2));
}

/** 巡航功率（W）：多旋翼 U 型曲线；固定翼线性 */
export function cruisePowerW(cls, v) {
  const p = ENERGY_PARAMS[cls];
  const W = p.weight_kg * G;
  if (p.liftDrag) return (W * v) / p.liftDrag;
  const Ph = hoverPowerW(cls);
  const vh = hoverInducedSpeed(cls);
  return Ph * (vh / v) + 0.5 * RHO * p.dragArea_m2 * v * v * v;
}

/** 经济巡航速度（多旋翼最小功率点，数值扫描） */
export function ecoSpeed(cls) {
  const p = ENERGY_PARAMS[cls];
  if (p.liftDrag) return null;
  let best = 10;
  let bestP = Infinity;
  for (let v = 2; v <= 60; v += 0.5) {
    const P = cruisePowerW(cls, v);
    if (P < bestP) { bestP = P; best = v; }
  }
  return best;
}

/** 爬升功率（W）：W·ROC + 悬停项（旋翼）/ + 巡航项（固定翼） */
export function climbPowerW(cls, roc) {
  const p = ENERGY_PARAMS[cls];
  const W = p.weight_kg * G;
  if (p.liftDrag) return W * roc + cruisePowerW(cls, 12);
  return W * roc + hoverPowerW(cls);
}

/** 下降功率（W）：旋翼按悬停功率 35%（低功率下降），固定翼按巡航 20%（下滑） */
export function descendPowerW(cls) {
  const p = ENERGY_PARAMS[cls];
  if (p.liftDrag) return cruisePowerW(cls, 12) * 0.2;
  return hoverPowerW(cls) * 0.35;
}

/** 巡航速度（与运行仿真引擎的通道速度一致，保证能耗口径与运行口径对齐） */
export function cruiseSpeedFor(cls) {
  return CLASSES[cls].speed;
}

/**
 * 单次任务能耗（kWh）：爬升 + 真实任务剖面巡航（mission_s）+ 下降 + 空中等待盘旋
 * 注：mission_s 为真实任务时长（能耗口径），与运行仿真的演示航线 route_s 解耦，
 *     以保证"充电成为有意义的周转环节"（单次任务耗电约占电池容量 15%–25%）。
 * @param {string} cls 机型
 * @param {number} hold_s 空中等待盘旋时长（s，取自 sortie.waitArrive）
 */
export function missionEnergyKwh(cls, hold_s = 0) {
  const p = ENERGY_PARAMS[cls];
  const tClimb = p.cruiseAlt_m / p.climbRate_mps;
  const tDesc = p.cruiseAlt_m / Math.max(1, p.climbRate_mps * 0.6);
  const E = climbPowerW(cls, p.climbRate_mps) * tClimb
    + cruisePowerW(cls, cruiseSpeedFor(cls)) * p.mission_s
    + descendPowerW(cls) * tDesc
    + (hoverPowerW(cls) ?? cruisePowerW(cls, 12)) * hold_s;
  return E / 3_600_000; // W·s → kWh
}

// ─────────────────────────── 充电设施配置 ───────────────────────────

/** 充电模式：power_kw 用于慢充/快充；swap_s 为换电固定时长 */
export const CHARGING_MODES = {
  none: { label: '无充电（满电基线）', power_kw: null, swap_s: null },
  slow: { label: '慢充 3 kW', power_kw: 3, swap_s: null },
  fast: { label: '快充 30 kW', power_kw: 30, swap_s: null },
  swap: { label: '换电 2 min', power_kw: null, swap_s: 120 },
};

export const CHARGING_DEFAULT = {
  enabled: false,   // 默认关闭 → 原"分级 vs 混合"对照实验行为完全不变
  mode: 'none',
  chargers_n: 4,    // 充电桩（换电台）数量
  socTarget: 1.0,   // 充电目标 SOC
  supply_kW: 120,   // 停机坪供电总功率上限（快充并发受此约束，kW）
};

// ─────────────────────────── 供电侧配置 ───────────────────────────

export const SUPPLY_DEFAULT = {
  startHour: 9,             // 仿真 t=0 对应一天中的时刻（改此值可做白天/夜间对比）
  tariffPeak: 1.2,          // 峰时电价 元/kWh（示例）
  tariffOffpeak: 0.3,       // 谷时电价 元/kWh（示例）
  peakStartHour: 8,
  peakEndHour: 22,
  pv_kWp: 0,                // 光伏装机 kWp；0 = 不配光伏
  storage_kWh: 0,           // 储能容量 kWh；0 = 不配储能
  storageEff: 0.9,          // 储能充放效率（谷充能量折算）
  pvAmort_yuanPerKwh: 0,        // 光伏投资摊销 元/kWh（示例 0.08）
  storageAmort_yuanPerKwh: 0,   // 储能投资摊销 元/kWh（示例 0.25）
};

/** 仿真时刻 t → 一天中的小时 */
export function hourOf(t, supply) {
  return (supply.startHour + t / 3600) % 24;
}

/** 光伏瞬时出力（kW）：6:00–18:00 正弦型日内曲线 */
export function pvPowerKw(t, supply) {
  const hour = hourOf(t, supply);
  if (hour < 6 || hour > 18) return 0;
  return supply.pv_kWp * Math.sin((Math.PI * (hour - 6)) / 12);
}

/** 时刻 t 的电价（元/kWh） */
export function tariffAt(t, supply) {
  const hour = hourOf(t, supply);
  return hour >= supply.peakStartHour && hour < supply.peakEndHour
    ? supply.tariffPeak
    : supply.tariffOffpeak;
}

/**
 * 用电成本（确定性简化模型）
 * @param {Array<{t:number, energy_kwh:number, duration_s:number}>} events 窗口内的充电事件
 * 规则：光伏出力先抵扣充电电量；储能只在峰时放电（按谷价计费 + 损耗折算，表示谷充峰放）；
 *       光伏/储能投资按摊销 元/kWh 计入。
 * @returns {{cost_yuan:number, grid_kwh:number, pv_kwh:number, storage_kwh:number}}
 */
export function energyCost(events, supply) {
  let cost = 0;
  let grid = 0;
  let pvUsed = 0;
  let stUsed = 0;
  let storage = supply.storage_kWh || 0;
  for (const e of events) {
    const price = tariffAt(e.t, supply);
    // 事件期间光伏可发电量（kW × h）
    const pv = pvPowerKw(e.t, supply) * (e.duration_s / 3600);
    const takePv = Math.min(e.energy_kwh, pv);
    let rem = e.energy_kwh - takePv;
    let takeSt = 0;
    if (storage > 0 && price >= supply.tariffPeak) {
      takeSt = Math.min(rem, storage);
      rem -= takeSt;
      storage -= takeSt;
      cost += takeSt * (supply.tariffOffpeak / supply.storageEff); // 谷充成本（含损耗）
    }
    cost += rem * price;
    grid += rem;
    pvUsed += takePv;
    stUsed += takeSt;
  }
  cost += pvUsed * (supply.pvAmort_yuanPerKwh ?? 0) + stUsed * (supply.storageAmort_yuanPerKwh ?? 0);
  return { cost_yuan: cost, grid_kwh: grid, pv_kwh: pvUsed, storage_kwh: stUsed };
}
