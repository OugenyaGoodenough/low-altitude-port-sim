/**
 * 无人机分级运行管理仿真 —— 参数与场景配置
 *
 * 所有数值集中在本文档中，便于在项目计划书中作为"仿真假设与参数"引用。
 * 场景设计原则：S1 与 S2 使用**完全相同的物理设施数量**（18 个停机位 + 4 条起降通道），
 * 差异只来自管理规则（专属 vs 共用、按机型间隔 vs 统一间隔）。
 */

/** 三类无人机（对应规格书 vehicles + entities） */
export const CLASSES = {
  micro: {
    id: 'micro',
    label: '微型四旋翼无人机',
    short: '微型',
    separation_m: 5,      // 机型最小安全间隔
    speed: 15,            // 起降通道内速度 m/s
    climb_s: 8,           // 垂直起降占用通道时间
    descend_s: 8,
    route_s: 90,          // 往返航线时间（任务段）
    turnaround_s: 30,     // 停机坪周转时间
    color: '#6fe3ff',
  },
  heavy: {
    id: 'heavy',
    label: '重型多旋翼无人机',
    short: '重型',
    separation_m: 20,
    speed: 10,
    climb_s: 12,
    descend_s: 12,
    route_s: 120,
    turnaround_s: 120,
    color: '#ffc46b',
  },
  cargo: {
    id: 'cargo',
    label: '固定翼货运无人机',
    short: '货运',
    separation_m: 40,
    speed: 35,
    climb_s: 30,          // 滑跑起飞
    descend_s: 30,        // 滑跑着陆
    route_s: 420,
    turnaround_s: 90,
    clearance_s: 90,      // 跑道清空时间（规格书 cargo_runway.occupancy_s）
    color: '#ff8a8a',
  },
};

export const CLASS_IDS = Object.keys(CLASSES);

/** 起降通道长度（走廊），用于间隔/追尾冲突的几何判定 */
export const CORRIDOR_LENGTH_M = 120;
/** 通信与反应附加时间 */
export const REACTION_S = 1.5;

/** 规划负荷下的机队规模（负荷 = 投入运行的无人机数量） */
export const FLEET_BASE = { micro: 10, heavy: 3, cargo: 2 };

/** 负荷水平扫描（相对规划负荷） */
export const LOAD_LEVELS = [0.6, 1.0, 1.5, 2.0];

/** 资源占用时长（秒）：通道占用 = 走廊穿越时间；货运用跑道清空时间 */
export function channelServiceTime(cls, kind) {
  const c = CLASSES[cls];
  if (kind === 'runway' && c.clearance_s) return c.clearance_s;
  return CORRIDOR_LENGTH_M / c.speed;
}

/** 按机型分级标准计算的安全放行间隔（秒）：间隔 / 速度 + 反应时间 */
export function safeHeadway(cls) {
  const c = CLASSES[cls];
  return c.separation_m / c.speed + REACTION_S;
}

/**
 * 三种管理策略
 * - graded：分级管理（专属场地 + 按机型间隔标准）
 * - pooledConservative：混合管理-统一保守规则（共用场地 + 取最保守机型间隔）
 * - pooledNaive：混合管理-统一经验规则（共用场地 + 统一短间隔，未考虑机型速度差异）
 */
export const POLICIES = {
  graded: {
    id: 's1_graded',
    name: 'S1 分级管理模式',
    short: '分级模式',
    desc: '三类无人机使用各自专属场地与通道；放行间隔按各机型安全标准分别计算',
    rule: 'per-class',
    channels: [
      { id: 'L-M1', label: '微坪通道 1', kind: 'lane', owner: 'micro', headway_s: 4 },
      { id: 'L-M2', label: '微坪通道 2', kind: 'lane', owner: 'micro', headway_s: 4 },
      { id: 'L-H1', label: '重坪通道', kind: 'lane', owner: 'heavy', headway_s: 12 },
      { id: 'RWY', label: '货运跑道', kind: 'runway', owner: 'cargo', headway_s: 90 },
    ],
    pads: [
      { kind: 'micro', cls: 'micro', count: 12, spacing_m: 8, cols: 4, origin: [-140, -16] },
      { kind: 'heavy', cls: 'heavy', count: 4, spacing_m: 24, cols: 2, origin: [-140, 80] },
      { kind: 'cargo', cls: 'cargo', count: 2, spacing_m: 48, cols: 2, origin: [-40, 150] },
    ],
  },
  pooledConservative: {
    id: 's2a_pooled_conservative',
    name: 'S2 混合管理模式（统一保守规则）',
    short: '混合-保守',
    desc: '全部机型共用同一片通用场地与通道；放行间隔统一取最保守机型的标准（12 s）',
    rule: 'uniform-conservative',
    uniformHeadway_s: 12,
    channels: [
      { id: 'G1', label: '通用通道 1', kind: 'lane', owner: 'any', headway_s: 12 },
      { id: 'G2', label: '通用通道 2', kind: 'lane', owner: 'any', headway_s: 12 },
      { id: 'G3', label: '通用通道 3', kind: 'lane', owner: 'any', headway_s: 12 },
      { id: 'RWY', label: '共用跑道', kind: 'runway', owner: 'any', headway_s: 90 },
    ],
    pads: [
      { kind: 'generic', cls: null, count: 18, spacing_m: 10, cols: 6, origin: [-150, 60] },
    ],
  },
  pooledNaive: {
    id: 's2b_pooled_naive',
    name: 'S2 混合管理模式（统一经验规则）',
    short: '混合-经验',
    desc: '全部机型共用同一片通用场地与通道；放行间隔统一取经验值 4 s，未区分机型速度差异',
    rule: 'uniform-naive',
    uniformHeadway_s: 4,
    channels: [
      { id: 'G1', label: '通用通道 1', kind: 'lane', owner: 'any', headway_s: 4 },
      { id: 'G2', label: '通用通道 2', kind: 'lane', owner: 'any', headway_s: 4 },
      { id: 'G3', label: '通用通道 3', kind: 'lane', owner: 'any', headway_s: 4 },
      { id: 'RWY', label: '共用跑道', kind: 'runway', owner: 'any', headway_s: 90 },
    ],
    pads: [
      { kind: 'generic', cls: null, count: 18, spacing_m: 10, cols: 6, origin: [-150, 60] },
    ],
  },
};

export const POLICY_IDS = Object.keys(POLICIES);

/** 生成停机位坐标布局（仿真与 3D 场景共用同一套几何） */
export function buildPads(policy) {
  const pads = [];
  let n = 0;
  for (const group of policy.pads) {
    const cols = group.cols || 4;
    for (let i = 0; i < group.count; i++) {
      const r = Math.floor(i / cols);
      const c = i % cols;
      pads.push({
        id: `${group.kind[0].toUpperCase()}${++n}`,
        index: n - 1,
        kind: group.kind,
        cls: group.cls,
        spacing_m: group.spacing_m,
        x: group.origin[0] + c * group.spacing_m,
        z: group.origin[1] + r * group.spacing_m,
      });
    }
  }
  return pads;
}

/** 生成完整场景（策略 + 负荷 → 机队、通道、停机位、几何） */
export function buildScenario(policyId, load = 1) {
  const policy = POLICIES[policyId];
  if (!policy) throw new Error(`未知管理策略: ${policyId}`);
  const fleet = {};
  for (const cls of CLASS_IDS) {
    fleet[cls] = Math.max(1, Math.round(FLEET_BASE[cls] * load));
  }
  const pads = buildPads(policy);
  return {
    id: policy.id,
    policyId,
    name: policy.name,
    short: policy.short,
    desc: policy.desc,
    rule: policy.rule,
    load,
    fleet,
    pads,
    channels: policy.channels.map((c) => ({ ...c, service_s: channelServiceTime('cargo', c.kind) })),
    uniformHeadway_s: policy.uniformHeadway_s ?? null,
    /** 安全标准按机型真实标准给定（混合模式的安全要求不因管理粗放而降低） */
    separation: Object.fromEntries(CLASS_IDS.map((c) => [c, CLASSES[c].separation_m])),
    layout: {
      pads,
      runway: { x: 70, z: -190, length: 420, width: 36, heading: 0 },
      corridors: {
        micro: [
          { id: 'L-M1', from: [-136, -8], to: [60, -8] },
          { id: 'L-M2', from: [-136, -24], to: [60, -24] },
        ],
        heavy: [{ id: 'L-H1', from: [-132, 92], to: [60, 92] }],
        pooled: [
          { id: 'G1', from: [-146, 64], to: [60, 64] },
          { id: 'G2', from: [-146, 74], to: [60, 74] },
          { id: 'G3', from: [-146, 84], to: [60, 84] },
        ],
        cargo: [{ id: 'RWY', from: [70, -190], to: [70, 230] }],
      },
      station: { x: 120, z: 30 },
      missionRing: { x: 300, z: 40, radius: 70 },
      apronCenter: policy.rule === 'per-class' ? [-120, 40] : [-120, 80],
    },
  };
}

/** 放行间隔（写入日志链的"调度假设"） */
export function headwayFor(policy, ch, cls) {
  if (policy.rule === 'per-class') return ch.headway_s;
  return policy.uniformHeadway_s;
}
