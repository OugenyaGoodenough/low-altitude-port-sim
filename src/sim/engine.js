/**
 * 离散事件仿真引擎（Discrete Event Simulation）
 *
 * 设计要点
 * 1. 机队闭环运行：每架无人机重复"停机坪周转 → 等待放行 → 通道穿越 → 航线 → 进近等待 → 着陆"，
 *    吞吐量与延误由引擎真实跑出，不做任何后处理伪造。
 * 2. 管理策略只影响"放行规则"，不影响物理设施数量（S1/S2 的停机位与通道数量完全相同）。
 * 3. 间隔侵入（冲突）由通道内的真实运动学计算：后继机与前机在走廊重叠区间内的最小间距。
 * 4. 每次放行指令、飞手执行、偏差事件全部写入责任追溯日志链，冲突发生时自动回溯责任主体。
 */
import { CLASSES, CLASS_IDS, CORRIDOR_LENGTH_M, REACTION_S, buildScenario } from './config.js';
import {
  ENERGY_PARAMS, CHARGING_MODES, CHARGING_DEFAULT, SUPPLY_DEFAULT,
  missionEnergyKwh,
} from './energy.js';

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class EventHeap {
  constructor() { this.items = []; this.seq = 0; }
  push(t, fn) {
    const item = { t, seq: this.seq++, fn };
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].t < a[i].t || (a[p].t === a[i].t && a[p].seq <= a[i].seq)) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
    return item;
  }
  peek() { return this.items[0]; }
  pop() {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && (a[l].t < a[m].t || (a[l].t === a[m].t && a[l].seq < a[m].seq))) m = l;
        if (r < a.length && (a[r].t < a[m].t || (a[r].t === a[m].t && a[r].seq < a[m].seq))) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
  get length() { return this.items.length; }
}

const EPS = 1e-9;

export class Sim {
  constructor(opts = {}) {
    const {
      policy = 'graded',
      load = 1,
      seed = 20260930,
      horizon = 7200,
      warmup = 900,
      pilotDeviationRate = 0.06,
      maxEvents = 2_000_000,
      charging = {},
      supply = {},
    } = opts;
    this.opts = opts;
    this.scn = buildScenario(policy, load);
    this.rng = mulberry32(seed);
    this.seed = seed;
    this.horizon = horizon;
    this.warmup = warmup;
    this.pilotDeviationRate = pilotDeviationRate;
    this.maxEvents = maxEvents;
    this.chargingCfg = { ...CHARGING_DEFAULT, ...charging };
    this.supply = { ...SUPPLY_DEFAULT, ...supply };
    this.chargeEvents = [];

    this.t = 0;
    this.heap = new EventHeap();
    this._processed = 0;
    this._cmdSeq = 0;
    this._execSeq = 0;
    this._cftSeq = 0;
    this._sortieSeq = 0;

    this.pads = this.scn.pads.map((p) => ({ ...p, occupant: null, occupantCls: null, busy: [] }));
    this.channels = this.scn.channels.map((c) => ({
      ...c,
      lastEntryT: -1e9,
      lastDir: null,
      clearUntil: 0,
      movements: [],
      busy: [],
      grants: 0,
    }));
    this.aircraft = [];
    this.legs = [];
    this.sorties = [];
    this.conflicts = [];
    this.autopsies = [];
    this.log = [];
    this.chargers = this.chargingCfg.enabled
      ? Array.from({ length: Math.max(1, this.chargingCfg.chargers_n) }, () => ({ availableAt: 0, busy: [] }))
      : [];
    this.cmdById = new Map();
    this.execById = new Map();
    this.byCmdExec = new Map();
    this.movementByKey = new Map();
    this._groundEpisodes = new Map();
    this._spawn();
  }

  // ───────────────────────────── 基础工具 ─────────────────────────────
  schedule(t, fn) { return this.heap.push(t, fn); }

  _leg(rec) {
    rec.ac = rec.ac;                        // aircraft 对象
    this.legs.push(rec);
    return rec;
  }

  _rollDeviation() {
    if (this.rng() < this.pilotDeviationRate) {
      if (this.rng() < 0.62) return { dt: 6 + this.rng() * 12, dv: 0, type: 'LATE' };
      return { dt: 0, dv: 0.15 + this.rng() * 0.15, type: 'SPEED' };
    }
    return { dt: 0, dv: 0, type: 'ADHERE' };
  }

  _headway(ch, cls) {
    return this.scn.uniformHeadway_s != null ? this.scn.uniformHeadway_s : ch.headway_s;
  }

  _assumedSpeed(cls) {
    // 分级模式：按机型自身速度计算间隔；混合模式：按统一标称速度（10 m/s）计算
    return this.scn.rule === 'per-class' ? CLASSES[cls].speed : 10;
  }

  _occupancy(ch, cls) {
    const c = CLASSES[cls];
    if (ch.kind === 'runway' && c.clearance_s) return c.clearance_s;
    return CORRIDOR_LENGTH_M / c.speed;
  }

  _allowed(ch, cls) {
    if (ch.owner === 'any') {
      // 固定翼货运机只能使用跑道
      if (cls === 'cargo') return ch.kind === 'runway';
      return true;
    }
    return ch.owner === cls;
  }

  _earliestEntry(ch, cls, dir, t) {
    let e = t;
    if (ch.lastDir === dir) {
      e = Math.max(e, ch.lastEntryT + this._headway(ch, cls));
    } else {
      e = Math.max(e, ch.clearUntil);
    }
    if (ch.kind === 'runway') e = Math.max(e, ch.clearUntil);
    return e;
  }

  _reserveChannel(ac, dir, t) {
    let best = null;
    for (const ch of this.channels) {
      if (!this._allowed(ch, ac.cls)) continue;
      const e = Math.max(t, this._earliestEntry(ch, ac.cls, dir, t));
      if (!best || e < best.entryT - EPS) best = { ch, entryT: e };
    }
    if (!best) throw new Error(`无可用通道: ${ac.cls} ${dir}`);
    const { ch, entryT } = best;
    ch.grants += 1;
    ch.lastEntryT = entryT;
    ch.lastDir = dir;
    ch.clearUntil = entryT + this._occupancy(ch, ac.cls);
    return { ch, entryT, headway: this._headway(ch, ac.cls) };
  }

  // ───────────────────────────── 停机位 ─────────────────────────────
  _allocPad(ac, t) {
    const cands = this.pads.filter(
      (p) => !p.occupant && (this.scn.rule === 'per-class' ? p.cls === ac.cls : true),
    );
    if (!cands.length) return null;
    // 混合模式：选择与已占位冲突最小的位（仍可能因物理间距不足产生地面冲突）
    let best = cands[0];
    let bestPenalty = Infinity;
    for (const p of cands) {
      let penalty = 0;
      for (const q of this.pads) {
        if (!q.occupant || q === p) continue;
        const d = Math.hypot(p.x - q.x, p.z - q.z);
        const need = Math.max(CLASSES[ac.cls].separation_m, CLASSES[q.occupantCls]?.separation_m ?? 0);
        if (d < need) penalty += need - d;
      }
      if (penalty < bestPenalty - EPS) { bestPenalty = penalty; best = p; }
    }
    best.occupant = ac.id;
    best.occupantCls = ac.cls;
    best.busyStart = t;
    if (bestPenalty > 0) this._groundConflict(ac, best, t);
    return best;
  }

  _releasePad(ac, t) {
    const p = ac.pad;
    if (!p) return;
    p.busy.push([p.busyStart, t]);
    p.occupant = null;
    p.occupantCls = null;
    ac.pad = null;
    this._closeGroundEpisodes(p, t);
  }

  // ───────────────────────────── 充电设施 ─────────────────────────────
  /**
   * 计划充电（耦合进周转时间）：返回 {delay, startT, endT, queue, chargeT, energy_kwh} 或 null（无需充电/设施未启用）
   * - 需要充电量 = (socTarget − soc) × 电池容量
   * - 慢充/快充：时长 = 电量 / 充电功率；供电总功率上限约束并发充电（功率均分，时长拉长）
   * - 换电：固定时长，不占用供电功率（电池在别处充电）
   * - 排队：选最早空闲的充电桩，排队时间 = 桩可用时刻 − 请求时刻
   */
  _planCharge(ac, t) {
    const cfg = this.chargingCfg;
    if (!cfg.enabled) return null;
    const p = ENERGY_PARAMS[ac.cls];
    const need = Math.max(0, cfg.socTarget - ac.soc) * p.battery_kwh; // kWh
    if (need <= 1e-6) return null;
    const mode = CHARGING_MODES[cfg.mode];
    if (!mode || (mode.power_kw == null && mode.swap_s == null)) return null;
    let chargeT;
    let allocKw = null;
    if (mode.swap_s != null) {
      chargeT = mode.swap_s;
    } else {
      const active = this.chargers.filter((c) => c.availableAt > this.t).length;
      allocKw = Math.min(mode.power_kw, cfg.supply_kW / Math.max(1, active + 1));
      chargeT = (need / allocKw) * 3600;
    }
    // 选最早空闲的充电桩
    let best = this.chargers[0];
    for (const c of this.chargers) if (c.availableAt < best.availableAt) best = c;
    const startT = Math.max(t, best.availableAt);
    const endT = startT + chargeT;
    best.availableAt = endT;
    best.busy.push([startT, endT]);
    this.chargeEvents.push({
      t: startT, energy_kwh: need, duration_s: chargeT, queue: startT - t,
      cls: ac.cls, ac: ac.id, mode: cfg.mode, allocKw, idx: this.chargers.indexOf(best),
    });
    return { delay: endT - t, startT, endT, queue: startT - t, chargeT, energy_kwh: need, allocKw };
  }

  // ───────────────────────────── 日志链 ─────────────────────────────
  _logRelease(ac, ch, dir, entryT, headway, sortie) {
    const assumedSpeed = this._assumedSpeed(ac.cls);
    const cmd = {
      id: `CMD-${String(++this._cmdSeq).padStart(4, '0')}`,
      t: +this.t.toFixed(3),
      kind: 'RELEASE',
      actor: '无人机运行服务站（调度）',
      ac: ac.id,
      cls: ac.cls,
      sortie: sortie.id,
      chId: ch.id,
      dir: dir === 'out' ? '起飞' : '着陆',
      plannedEntryT: +entryT.toFixed(3),
      assumedHeadway_s: +headway.toFixed(2),
      assumedSpeed_mps: assumedSpeed,
      rule: this.scn.rule,
      note: `按${this.scn.uniformHeadway_s != null ? '统一' : '机型分级'}间隔 ${headway.toFixed(1)}s 放行，调度假设航速 ${assumedSpeed} m/s`,
    };
    this.log.push(cmd);
    this.cmdById.set(cmd.id, cmd);
    return cmd;
  }

  _logExec(cmd, ac, actualEntryT, dev, actualSpeed, sortie) {
    const dt = actualEntryT - cmd.plannedEntryT;
    const dv = (actualSpeed - CLASSES[ac.cls].speed) / CLASSES[ac.cls].speed;
    const exec = {
      id: `EXE-${String(++this._execSeq).padStart(4, '0')}`,
      t: +actualEntryT.toFixed(3),
      kind: 'PILOT_EXEC',
      actor: `飞手（${ac.id}）`,
      ref: cmd.id,
      ac: ac.id,
      cls: ac.cls,
      sortie: sortie.id,
      plannedEntryT: cmd.plannedEntryT,
      actualEntryT: +actualEntryT.toFixed(3),
      dt_s: +dt.toFixed(2),
      actualSpeed_mps: +actualSpeed.toFixed(2),
      dv: +dv.toFixed(3),
      verdict: Math.abs(dt) > 5 || Math.abs(dv) > 0.12 ? 'DEVIATION' : 'ADHERE',
      deviationType: dev.type,
    };
    this.log.push(exec);
    this.execById.set(exec.id, exec);
    this.byCmdExec.set(cmd.id, exec);
    return exec;
  }

  _registerMovement(ac, sortie, ch, dir, entryT, speed, cmd, exec) {
    const occT = this._occupancy(ch, ac.cls);
    const m = {
      dir, cls: ac.cls, ac: ac.id, sortie: sortie.id,
      entryT, exitT: entryT + occT, speed, chId: ch.id,
      cmdId: cmd?.id, execId: exec?.id,
    };
    ch.movements.push(m);
    ch.busy.push([entryT, entryT + occT]);
    this._airConflictCheck(ch, m);
    return m;
  }

  _airConflictCheck(ch, m) {
    // 找同方向的前一架
    let prev = null;
    for (let i = ch.movements.length - 2; i >= 0; i--) {
      if (ch.movements[i].dir === m.dir) { prev = ch.movements[i]; break; }
    }
    if (!prev || prev.exitT <= m.entryT + EPS) return;
    const tStart = m.entryT;
    const tEnd = Math.min(prev.exitT, m.exitT);
    const gapAt = (t) => prev.speed * (t - prev.entryT) - m.speed * (t - m.entryT);
    const g1 = gapAt(tStart);
    const g2 = gapAt(tEnd);
    const minGap = Math.min(g1, g2);
    const required = Math.max(CLASSES[prev.cls].separation_m, CLASSES[m.cls].separation_m);
    if (minGap < required - EPS) {
      const tAt = g1 <= g2 ? tStart : tEnd;
      this._airConflict(ch, prev, m, minGap, required, tAt, tEnd);
    }
  }

  _airConflict(ch, prev, m, minGap, required, tAt, tEnd) {
    const sev = minGap < required * 0.5 ? '严重' : '一般';
    const cft = {
      id: `CFT-${String(++this._cftSeq).padStart(4, '0')}`,
      t: +tAt.toFixed(3),
      window: [+m.entryT.toFixed(2), +tEnd.toFixed(2)],
      type: 'AIR_SEPARATION',
      typeLabel: '空中间隔侵入',
      chId: ch.id,
      chLabel: ch.label,
      pair: [
        { ac: prev.ac, cls: prev.cls, cmdId: prev.cmdId, execId: prev.execId, speed: prev.speed },
        { ac: m.ac, cls: m.cls, cmdId: m.cmdId, execId: m.execId, speed: m.speed },
      ],
      measured_m: +minGap.toFixed(2),
      required_m: required,
      severity: sev,
    };
    this.conflicts.push(cft);
    this._autopsy(cft);
  }

  _groundConflict(ac, pad, t) {
    let measured = Infinity;
    let required = 0;
    let other = null;
    for (const q of this.pads) {
      if (!q.occupant || q === pad) continue;
      const d = Math.hypot(pad.x - q.x, pad.z - q.z);
      const need = Math.max(CLASSES[ac.cls].separation_m, CLASSES[q.occupantCls]?.separation_m ?? 0);
      if (d < need && d < measured) { measured = d; required = need; other = q; }
    }
    if (!other) return;
    const cft = {
      id: `CFT-${String(++this._cftSeq).padStart(4, '0')}`,
      t: +t.toFixed(3),
      window: [+t.toFixed(2), +t.toFixed(2)],
      type: 'GROUND_SEPARATION',
      typeLabel: '地面停机间隔侵入',
      chId: pad.id,
      chLabel: `停机位 ${pad.id}`,
      pair: [
        { ac: other.occupant, cls: other.occupantCls, padId: other.id },
        { ac: ac.id, cls: ac.cls, padId: pad.id },
      ],
      measured_m: +measured.toFixed(2),
      required_m: required,
      severity: measured < required * 0.5 ? '严重' : '一般',
    };
    // 同一对停机位的违例共存只记一次，释放时结算持续时长
    const key = [other.id, pad.id].sort().join('|');
    this.conflicts.push(cft);
    this._groundEpisodes.set(key, cft);
    this._autopsy(cft);
  }

  _closeGroundEpisodes(pad, t) {
    for (const [key, cft] of this._groundEpisodes) {
      if (key.split('|').includes(pad.id)) {
        cft.endT = +t.toFixed(3);
        cft.duration_s = +(t - cft.t).toFixed(1);
        this._groundEpisodes.delete(key);
      }
    }
  }

  _closeAllGroundEpisodes() {
    const last = this.t;
    for (const [key, cft] of this._groundEpisodes) {
      cft.endT = +last.toFixed(3);
      cft.duration_s = +(last - cft.t).toFixed(1);
      this._groundEpisodes.delete(key);
    }
  }

  /** 责任追溯：由冲突事件回溯日志链，判断调度指令错误 vs 飞手违规 */
  _autopsy(cft) {
    const involved = cft.pair.map((p) => ({
      ac: p.ac, cls: p.cls,
      cmd: p.cmdId ? this.cmdById.get(p.cmdId) : null,
      exec: p.execId ? this.execById.get(p.execId) : null,
    }));
    const deviations = involved.filter(
      (e) => e.exec && (Math.abs(e.exec.dt_s) > 5 || Math.abs(e.exec.dv) > 0.12),
    );
    let category;
    let responsible;
    let basis;
    if (deviations.length) {
      category = '飞手违规';
      responsible = deviations.map((d) => `${d.ac}（飞手）`).join('、');
      basis = deviations.map((d) => {
        const parts = [];
        if (Math.abs(d.exec.dt_s) > 5) parts.push(`放行时刻偏离 ${d.exec.dt_s > 0 ? '+' : ''}${d.exec.dt_s}s（指令 ${d.cmd.plannedEntryT}s，实际 ${d.exec.actualEntryT}s）`);
        if (Math.abs(d.exec.dv) > 0.12) parts.push(`航速偏离 ${(d.exec.dv * 100).toFixed(0)}%（实际 ${d.exec.actualSpeed_mps} m/s）`);
        return `${d.ac}: ${parts.join('；')}`;
      });
    } else {
      category = '调度指令错误';
      responsible = '无人机运行服务站（调度）';
      if (cft.type === 'GROUND_SEPARATION') {
        basis = [`停机位物理间距 ${cft.measured_m} m 小于 ${involved[0].cls}/${involved[1].cls} 机型要求的 ${cft.required_m} m，调度分配未按机型间隔要求分区`];
      } else {
        const [a, b] = involved;
        basis = [`放行指令按统一间隔 ${a.cmd?.assumedHeadway_s ?? b.cmd?.assumedHeadway_s}s、标称航速 ${a.cmd?.assumedSpeed_mps ?? b.cmd?.assumedSpeed_mps} m/s 计算，未区分机型速度差异`,
          `实际航速 ${a.ac} ${a.exec?.actualSpeed_mps ?? CLASSES[a.cls].speed} m/s、${b.ac} ${b.exec?.actualSpeed_mps ?? CLASSES[b.cls].speed} m/s`,
          `通道内最小间距 ${cft.measured_m} m < 要求 ${cft.required_m} m`];
      }
    }
    const autopsy = {
      incidentId: cft.id,
      t: cft.t,
      type: cft.type,
      typeLabel: cft.typeLabel,
      category,
      responsible,
      basis,
      chain: involved.flatMap((e) => [e.cmd?.id, e.exec?.id].filter(Boolean)).concat(cft.id),
    };
    this.autopsies.push(autopsy);
    cft.autopsy = autopsy;
    return autopsy;
  }

  // ───────────────────────────── 运行流程 ─────────────────────────────
  _spawn() {
    let k = 0;
    for (const cls of CLASS_IDS) {
      const n = this.scn.fleet[cls];
      for (let i = 0; i < n; i++) {
        const ac = {
          id: `${cls === 'micro' ? 'M' : cls === 'heavy' ? 'H' : 'C'}-${String(i + 1).padStart(2, '0')}`,
          cls, pad: null, sortie: null, lastLandT: 0, sortieCount: 0, conflicts: 0,
          soc: 1, // 初始满电
        };
        this.aircraft.push(ac);
        const stagger = (k % 12) * 6 + i * 3;
        const pad = this._allocPad(ac, 0);
        if (pad) {
          ac.pad = pad;
          this.schedule(stagger, () => this._startCycle(ac, this.t));
        } else {
          const stub = this._newSortie(ac);
          this.schedule(stagger, () => this._requestArrival(ac, stub));
        }
        k += 1;
      }
    }
  }

  _newSortie(ac) {
    const s = {
      id: `${ac.id}/S${++ac.sortieCount}`,
      droneId: ac.id,
      cls: ac.cls,
      landT: null,
      readyT: null,
      departT: null,
      arriveRequestT: null,
      waitDepart: 0,
      waitArrive: 0,
      cycleT: null,
      padId: null,
      conflicts: [],
    };
    this.sorties.push(s);
    return s;
  }

  _startCycle(ac, landT) {
    if (this.t > this.horizon + 1800) return;
    ac.lastLandT = landT;
    const sortie = this._newSortie(ac);
    sortie.landT = landT;
    sortie.padId = ac.pad?.id ?? null;
    ac.sortie = sortie;
    // 充电耦合进周转时间：周转 = 基础周转 + 充电排队与充电时长
    const chg = this._planCharge(ac, landT);
    sortie.charge = chg ?? null;
    if (chg) {
      ac.soc = this.chargingCfg.socTarget;
      this._leg({
        kind: 'charging', ac, sortie: sortie.id, t0: chg.startT, t1: chg.endT,
        padId: sortie.padId, queue: chg.queue, energy_kwh: chg.energy_kwh,
      });
    }
    const tr = CLASSES[ac.cls].turnaround_s + (chg ? chg.delay : 0);
    this._leg({ kind: 'turnaround', ac, sortie: sortie.id, t0: landT, t1: landT + tr, padId: sortie.padId });
    this.schedule(landT + tr, () => this._readyForDeparture(ac, sortie));
  }

  _readyForDeparture(ac, sortie) {
    if (this.t > this.horizon + 1800) return;
    sortie.readyT = this.t;
    const { ch, entryT, headway } = this._reserveChannel(ac, 'out', this.t);
    sortie.departPlanT = entryT;
    const cmd = this._logRelease(ac, ch, 'out', entryT, headway, sortie);
    const dev = this._rollDeviation();
    sortie.depDev = dev;
    const actualEntryT = entryT + dev.dt;
    sortie.waitDepart = actualEntryT - sortie.readyT;
    const padId = sortie.padId;
    this._leg({ kind: 'wait_depart', ac, sortie: sortie.id, t0: sortie.readyT, t1: actualEntryT, padId });
    this.schedule(actualEntryT, () => {
      const speed = CLASSES[ac.cls].speed * (1 + dev.dv);
      const exec = this._logExec(cmd, ac, actualEntryT, dev, speed, sortie);
      this._releasePad(ac, actualEntryT);
      sortie.departT = actualEntryT;
      this._beginDeparture(ac, sortie, ch, actualEntryT, speed, cmd, exec);
    });
  }

  _beginDeparture(ac, sortie, ch, entryT, speed, cmd, exec) {
    const c = CLASSES[ac.cls];
    const occT = this._occupancy(ch, ac.cls);
    this._registerMovement(ac, sortie, ch, 'out', entryT, speed, cmd, exec);
    this._leg({ kind: 'depart', ac, sortie: sortie.id, t0: entryT, t1: entryT + occT, chId: ch.id, from: sortie.padId });
    const tOut0 = entryT + occT;
    const tOut1 = tOut0 + c.route_s / 2;
    sortie.routeMidT = tOut1;
    this._leg({ kind: 'cruise_out', ac, sortie: sortie.id, t0: tOut0, t1: tOut1, chId: ch.id });
    this.schedule(tOut1, () => this._requestArrival(ac, sortie, tOut1));
  }

  /** 在航线折返点申请进近放行；标称到达时刻 = 折返点 + 返程航时 */
  _requestArrival(ac, sortie, tMid) {
    if (this.t > this.horizon + 1800) return;
    const t = tMid ?? this.t;
    const c = CLASSES[ac.cls];
    const nominalEntry = t + c.route_s / 2;
    sortie.arriveRequestT = t;
    sortie.nominalArriveT = nominalEntry;
    const { ch, entryT, headway } = this._reserveChannel(ac, 'in', nominalEntry);
    const cmd = this._logRelease(ac, ch, 'in', entryT, headway, sortie);
    const dev = this._rollDeviation();
    sortie.arrDev = dev;
    const actualEntryT = entryT + dev.dt;
    sortie.waitArrive = (sortie.waitArrive || 0) + Math.max(0, actualEntryT - nominalEntry);
    this._leg({ kind: 'cruise_in', ac, sortie: sortie.id, t0: t, t1: Math.min(nominalEntry, actualEntryT), chId: ch.id });
    if (actualEntryT > nominalEntry + EPS) {
      this._leg({ kind: 'hold', ac, sortie: sortie.id, t0: nominalEntry, t1: actualEntryT });
    }
    this.schedule(actualEntryT, () => {
      const speed = CLASSES[ac.cls].speed * (1 + dev.dv);
      const exec = this._logExec(cmd, ac, actualEntryT, dev, speed, sortie);
      this._beginArrival(ac, sortie, ch, actualEntryT, speed, cmd, exec);
    });
  }

  _beginArrival(ac, sortie, ch, entryT, speed, cmd, exec) {
    const occT = this._occupancy(ch, ac.cls);
    this._registerMovement(ac, sortie, ch, 'in', entryT, speed, cmd, exec);
    this._leg({ kind: 'arrive', ac, sortie: sortie.id, t0: entryT, t1: entryT + occT, chId: ch.id });
    this.schedule(entryT + occT, () => this._touchdown(ac, sortie));
  }

  _touchdown(ac, sortie) {
    const t = this.t;
    const pad = this._allocPad(ac, t);
    if (!pad) {
      // 无空闲停机位：空中等待 5 s 后重试
      this._leg({ kind: 'hold', ac, sortie: sortie.id, t0: t, t1: t + 5 });
      sortie.waitArrive = (sortie.waitArrive || 0) + 5;
      this.schedule(t + 5, () => this._touchdown(ac, sortie));
      return;
    }
    ac.pad = pad;
    sortie.landT = t;
    sortie.cycleT = ac.lastLandT > 0 ? t - ac.lastLandT : null;
    // 结算本架次任务能耗（爬升+真实任务剖面巡航+下降+空中等待），扣减 SOC
    sortie.energy_kwh = missionEnergyKwh(sortie.cls, sortie.waitArrive || 0);
    ac.soc = Math.max(0, ac.soc - sortie.energy_kwh / ENERGY_PARAMS[sortie.cls].battery_kwh);
    this._leg({ kind: 'landed', ac, sortie: sortie.id, t0: t, t1: t, padId: pad.id });
    this._startCycle(ac, t);
  }

  /** 跑完整仿真（到事件队列清空或到达安全上限） */
  run() {
    while (this.heap.length) {
      const ev = this.heap.pop();
      this.t = ev.t;
      ev.fn();
      this._processed += 1;
      if (this._processed > this.maxEvents) break;
    }
    this._closeAllGroundEpisodes();
    return this;
  }

  /** 供 3D 回放使用：按时间取状态（阶段片段） */
  legsSorted() {
    return this.legs.slice().sort((a, b) => a.t0 - b.t0 || a.t1 - b.t1);
  }

  logSummary() {
    return {
      releases: this.cmdById.size,
      executions: this.execById.size,
      deviations: [...this.execById.values()].filter((e) => e.verdict === 'DEVIATION').length,
      conflicts: this.conflicts.length,
      autopsies: this.autopsies.length,
    };
  }
}
