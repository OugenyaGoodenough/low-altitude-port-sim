/**
 * 回放采样器：把 sim.legs 翻译成任意时刻 t 的确定性位姿。
 *
 * 设计约束：poseAt(acId, t) 必须是纯函数（不依赖真实时间、随机数或历史帧），
 * 这样 renderAt(t) 才能做到"同一 t 渲染同一帧"，录屏可复现。
 */

/** 巡航高度（米）：微型 25 / 重型 35 / 货运 60 */
export const CRUISE_ALT = { micro: 25, heavy: 35, cargo: 60 };
/** 停机位上无人机悬停高度 */
export const PAD_HOVER_Y = 1.5;
/** 盘旋等待参数：周期 6 s，半径 15~30 m */
const HOLD_PERIOD_S = 6;
const HOLD_R_MIN = 15;
const HOLD_R_MAX = 30;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a, b, u) => a + (b - a) * u;
const smoothstep = (e0, e1, x) => {
  const u = clamp01((x - e0) / (e1 - e0));
  return u * u * (3 - 2 * u);
};

function hash32(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
/** 由字符串派生的 [0,1) 稳定随机数（替代 Math.random 以保证确定性） */
function h01(s, salt) {
  return (hash32(`${s}|${salt}`) % 100003) / 100003;
}

function yawOf(dx, dz) {
  return Math.atan2(dx, dz);
}

function place(out, x, y, z, yaw) {
  out.x = x;
  out.y = y;
  out.z = z;
  out.yaw = yaw;
}

/** 合并同一架无人机前后紧邻的 hold 片段（引擎在无法分配停机位时会以 5 s 为步长反复申请） */
function mergeLegs(legs) {
  const out = [];
  for (const leg of legs) {
    const prev = out[out.length - 1];
    if (prev && prev.kind === 'hold' && leg.kind === 'hold' && Math.abs(prev.t1 - leg.t0) < 1e-6) {
      prev.t1 = leg.t1;
      continue;
    }
    out.push({ ...leg });
  }
  return out;
}

export class Replay {
  constructor(sim) {
    this.sim = sim;
    this.horizon = sim.horizon;

    this.corridors = new Map();
    for (const list of Object.values(sim.scn.layout.corridors)) {
      for (const c of list) this.corridors.set(c.id, c);
    }
    this.pads = new Map(sim.pads.map((p) => [p.id, p]));
    this.ring = sim.scn.layout.missionRing;
    this.station = sim.scn.layout.station;

    this.legsByAc = new Map();
    for (const ac of sim.aircraft) this.legsByAc.set(ac.id, []);
    for (const leg of sim.legs) {
      if (leg.t0 > sim.horizon + 2100) continue;
      const arr = this.legsByAc.get(leg.ac.id);
      if (arr) arr.push(leg);
    }
    this.fallback = new Map();
    for (const [id, arr] of this.legsByAc) {
      arr.sort((a, b) => a.t0 - b.t0 || a.t1 - b.t1);
      const legs = mergeLegs(arr);
      this.legsByAc.set(id, legs);
      // 该机首次出现时所处的停机位，用于"无片段时停回原位"
      const withPad = legs.find((l) => l.padId);
      this.fallback.set(id, withPad ? withPad.padId : null);
    }

    // 着陆片段（arrive）本身不带停机位，用"下一次周期开始时的停机位"反查
    this.landPad = new Map();
    for (const s of sim.sorties) {
      if (s.landT != null && s.padId) this.landPad.set(`${s.droneId}@${s.landT.toFixed(3)}`, s.padId);
    }

    this.ringCache = new Map();
    this._tmp = { x: 0, y: 0, z: 0, yaw: 0, spin: 1, visible: true };
    /** duration 用于录屏线性映射 */
    this.duration = sim.horizon;
  }

  legsOf(acId) {
    return this.legsByAc.get(acId) || [];
  }

  /** 远端任务区的航路点：由架次号派生，保证 cruise_out 终点与 cruise_in 起点一致 */
  ringPoint(sortieId) {
    let p = this.ringCache.get(sortieId);
    if (!p) {
      const a = h01(sortieId, 'ra') * Math.PI * 2;
      const r = this.ring.radius * (0.72 + 0.38 * h01(sortieId, 'rr'));
      p = [this.ring.x + r * Math.cos(a), this.ring.z + r * Math.sin(a)];
      this.ringCache.set(sortieId, p);
    }
    return p;
  }

  /** 最后一个 t0 <= t 的片段下标（-1 表示尚未开始） */
  legIndexAt(legs, t) {
    let lo = 0;
    let hi = legs.length - 1;
    let res = -1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (legs[m].t0 <= t) {
        res = m;
        lo = m + 1;
      } else hi = m - 1;
    }
    return res;
  }

  legAt(acId, t) {
    const legs = this.legsByAc.get(acId);
    if (!legs || !legs.length) return null;
    const i = this.legIndexAt(legs, t);
    return i < 0 ? null : legs[i];
  }

  /** 当前是否在空（起飞通道穿越、航线、盘旋、进近） */
  isAirborne(acId, t) {
    const leg = this.legAt(acId, t);
    if (!leg) return false;
    return leg.kind === 'depart' || leg.kind === 'cruise_out' || leg.kind === 'cruise_in'
      || leg.kind === 'hold' || leg.kind === 'arrive';
  }

  poseAt(acId, t, out = {}) {
    const legs = this.legsByAc.get(acId);
    out.spin = 1;
    out.visible = true;
    if (!legs || !legs.length) return this._parkPose(acId, t, out);
    const i = this.legIndexAt(legs, t);
    if (i < 0) return this._parkPose(acId, t, out);
    const leg = legs[i];
    const tt = Math.min(t, leg.t1);
    const u = leg.t1 > leg.t0 ? clamp01((tt - leg.t0) / (leg.t1 - leg.t0)) : 1;
    this._poseOfLeg(leg, legs[i - 1] || null, tt, u, out);
    return out;
  }

  _parkPose(acId, t, out) {
    const padId = this.fallback.get(acId);
    const pad = padId ? this.pads.get(padId) : null;
    if (!pad) {
      out.visible = false;
      out.spin = 0;
      return out;
    }
    place(out, pad.x, PAD_HOVER_Y, pad.z, yawOf(0, 1) + h01(acId, 'yaw') * 6.28);
    out.spin = 0.2;
    return out;
  }

  _poseOfLeg(leg, prev, t, u, out) {
    const cls = leg.ac.cls;
    const cruise = CRUISE_ALT[cls];
    switch (leg.kind) {
      case 'turnaround':
      case 'charging':
      case 'wait_depart':
      case 'landed': {
        const pad = this.pads.get(leg.padId) || this.pads.get(this.fallback.get(leg.ac.id));
        const x = pad ? pad.x : 0;
        const z = pad ? pad.z : 0;
        place(out, x, PAD_HOVER_Y, z, h01(leg.padId || leg.ac.id, 'yaw') * 6.28);
        out.spin = leg.kind === 'turnaround' ? 0.35 : 0.85;
        return;
      }

      // 起飞：停机位 → 通道入口（滑行/平移）→ 通道出口（爬升）
      case 'depart': {
        const corr = this.corridors.get(leg.chId);
        const pad = this.pads.get(leg.from) || this.pads.get(leg.padId);
        const px = pad ? pad.x : (corr ? corr.from[0] : 0);
        const pz = pad ? pad.z : (corr ? corr.from[1] : 0);
        const a = corr ? corr.from : [px, pz];
        const b = corr ? corr.to : [px, pz];
        const taxi = cls === 'cargo' ? 0.34 : 0.2;
        if (u < taxi) {
          const v = u / taxi;
          place(out, lerp(px, a[0], v), PAD_HOVER_Y, lerp(pz, a[1], v), yawOf(a[0] - px, a[1] - pz));
        } else {
          const v = (u - taxi) / (1 - taxi);
          // 货运机沿跑道滑跑，接近末端才拉起；旋翼机离开通道入口即爬升
          const climb = cls === 'cargo' ? smoothstep(0.5, 1, v) : smoothstep(0.05, 0.9, v);
          const y = PAD_HOVER_Y + (cruise - PAD_HOVER_Y) * climb;
          place(out, lerp(a[0], b[0], v), y, lerp(a[1], b[1], v), yawOf(b[0] - a[0], b[1] - a[1]));
        }
        out.spin = 1.4;
        return;
      }

      // 出港航线：通道出口 → 远端任务区航路点
      case 'cruise_out': {
        const corr = this.corridors.get(leg.chId);
        const a = corr ? corr.to : [0, 0];
        const r = this.ringPoint(leg.sortie);
        const y = cruise + 8 * Math.sin(Math.PI * u);
        const dz = r[1] - a[1];
        place(out, lerp(a[0], r[0], u), y, lerp(a[1], r[1], u), yawOf(r[0] - a[0], dz));
        out.spin = 1.1;
        return;
      }

      // 进港航线：远端任务区航路点 → 通道出口（随后沿通道进近）
      case 'cruise_in': {
        const corr = this.corridors.get(leg.chId);
        const b = corr ? corr.to : [0, 0];
        const r = this.ringPoint(leg.sortie);
        const y = cruise + 8 * Math.sin(Math.PI * (1 - u));
        place(out, lerp(r[0], b[0], u), y, lerp(r[1], b[1], u), yawOf(b[0] - r[0], b[1] - r[1]));
        out.spin = 1.1;
        return;
      }

      // 进近着陆：通道外端 → 通道内端（下降）→ 该架次的停机位
      case 'arrive': {
        const corr = this.corridors.get(leg.chId);
        const b = corr ? corr.to : [0, 0];
        const a = corr ? corr.from : b;
        const padId = this.landPad.get(`${leg.ac.id}@${leg.t1.toFixed(3)}`);
        const pad = padId ? this.pads.get(padId) : null;
        const px = pad ? pad.x : a[0];
        const pz = pad ? pad.z : a[1];
        const approach = cls === 'cargo' ? 0.75 : 0.7;
        if (u < approach) {
          const v = u / approach;
          const y = cruise + (PAD_HOVER_Y - cruise) * smoothstep(0.12, 1, v);
          place(out, lerp(b[0], a[0], v), y, lerp(b[1], a[1], v), yawOf(a[0] - b[0], a[1] - b[1]));
        } else {
          const v = (u - approach) / (1 - approach);
          place(out, lerp(a[0], px, v), PAD_HOVER_Y, lerp(a[1], pz, v), yawOf(px - a[0], pz - a[1]));
        }
        out.spin = 1.2;
        return;
      }

      // 空中盘旋等待：在上一段终点正上方画水平圆，周期 6 s，半径 15~30 m
      case 'hold': {
        let bx;
        let by;
        let bz;
        if (prev) {
          const scratch = this._tmpPrev || (this._tmpPrev = {});
          this._poseOfLeg(prev, null, prev.t1, 1, scratch);
          bx = scratch.x;
          by = scratch.y;
          bz = scratch.z;
        } else {
          const pad = this.pads.get(this.fallback.get(leg.ac.id));
          bx = pad ? pad.x : 0;
          by = cruise;
          bz = pad ? pad.z : 0;
        }
        const rr = HOLD_R_MIN + (HOLD_R_MAX - HOLD_R_MIN) * h01(`${leg.ac.id}|${leg.sortie}`, 'hr');
        const th = (2 * Math.PI * (t - leg.t0)) / HOLD_PERIOD_S;
        // 圆心偏移一个半径，使盘旋起点与上一段终点重合
        const cx = bx - rr;
        const cz = bz;
        place(out, cx + rr * Math.cos(th), by, cz + rr * Math.sin(th), yawOf(-Math.sin(th), Math.cos(th)));
        out.spin = 1.2;
        return;
      }

      default: {
        const pad = this.pads.get(this.fallback.get(leg.ac.id));
        place(out, pad ? pad.x : 0, PAD_HOVER_Y, pad ? pad.z : 0, 0);
        out.spin = 0.3;
      }
    }
  }

  /** 供特效层使用：某冲突涉及的两机在 t 时刻的位置中点 */
  conflictAnchor(cft, t, out) {
    const scratch = this._scratch || (this._scratch = {});
    const a = this.poseAt(cft.pair[0].ac, t, scratch);
    const ax = a.x;
    const ay = a.y;
    const az = a.z;
    const b = this.poseAt(cft.pair[1].ac, t, scratch);
    out.x = (ax + b.x) / 2;
    out.y = Math.max(ay, b.y) + 6;
    out.z = (az + b.z) / 2;
    return out;
  }
}
