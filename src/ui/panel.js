/**
 * UI 层：实时指标、对照实验表、控制台、责任追溯面板、录屏字幕。
 * 实时指标全部由当前播放时刻 t 之前的 sim.sorties / sim.conflicts / pad.busy 统计得出，
 * 不在任何地方写死数字。
 */

const POLICY_ORDER = ['graded', 'pooledConservative', 'pooledNaive'];
const LOAD_TABS = [0.6, 1, 1.5, 2];
const MAX_TRACE_ROWS = 400;

const $ = (id) => document.getElementById(id);
const fmt = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '—');
const clock = (s) => {
  const sign = s < 0 ? '-' : '';
  const v = Math.abs(s);
  const h = Math.floor(v / 3600);
  const m = Math.floor((v % 3600) / 60);
  const sec = v % 60;
  return `${sign}${h > 0 ? `${h}:` : ''}${String(m).padStart(2, '0')}:${sec.toFixed(1).padStart(4, '0')}`;
};

/** 累加与区间重叠统计：busy 区间列表在 [0, t] 内的总时长 */
function overlapUpTo(intervals, t) {
  let sum = 0;
  for (let i = 0; i < intervals.length; i++) {
    const [a, b] = intervals[i];
    if (a >= t) break;
    sum += Math.min(b, t) - a;
  }
  return sum;
}

function countUpTo(sorted, t) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (sorted[m] <= t) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/** 日志字段的中文名（责任追溯面板展示用） */
import { energyCost } from '../sim/energy.js';

const FIELD_LABEL = {
  id: '日志号',
  t: '记录时刻',
  kind: '记录类型',
  actor: '主体',
  ac: '无人机',
  cls: '机型',
  sortie: '架次',
  chId: '通道',
  dir: '方向',
  plannedEntryT: '计划进入(s)',
  assumedHeadway_s: '调度假设间隔(s)',
  assumedSpeed_mps: '调度假设航速(m/s)',
  rule: '规则',
  note: '备注',
  ref: '关联指令',
  actualEntryT: '实际进入(s)',
  dt_s: '进入偏差(s)',
  actualSpeed_mps: '实际航速(m/s)',
  dv: '航速偏差',
  verdict: '判定',
  deviationType: '偏差类型',
  typeLabel: '事件类型',
  chLabel: '位置',
  measured_m: '实测量(m)',
  required_m: '要求(m)',
  severity: '严重程度',
};
const KIND_LABEL = { RELEASE: '放行指令', PILOT_EXEC: '飞手执行', CFT: '冲突事件' };
const CLS_LABEL = { micro: '微型四旋翼', heavy: '重型多旋翼', cargo: '固定翼货运' };
const CHARGING_LABEL = { off: '无充电', slow: '慢充 3kW', fast: '快充 30kW', swap: '换电 2min' };
const SUPPLY_LABEL = { grid: '纯市电', pv: '光伏', pv_storage: '光伏+储能' };

const fmtTime = (v) => (typeof v === 'number' ? `${v.toFixed(1)} s` : String(v));

export class UI {
  constructor(handlers) {
    this.h = handlers;
    this.sim = null;
    this.replay = null;
    this.rows = [];
    this._builtBody = new Set();
    this.highlightId = null;
    this.traceFilter = 'all';
    this.playing = false;
    this.speed = 2;
    this.mode = 'graded';
    this.view = 'orbit';
    this.airborne = 0;
    this.duration = 7200;
    this._bindControls();
  }

  // ───────────────────────── 控制台 ─────────────────────────
  _bindControls() {
    $('btn-play').addEventListener('click', () => this.h.onPlayToggle());
    $('btn-reset').addEventListener('click', () => this.h.onSeek(0, true));
    const seg = (id, items, get) => {
      const host = $(id);
      host.innerHTML = '';
      for (const it of items) {
        const b = document.createElement('button');
        b.className = 'btn seg-btn';
        b.textContent = it.label;
        b.dataset.value = String(it.value);
        b.addEventListener('click', () => this.h[it.handler](it.value));
        host.appendChild(b);
      }
      return host;
    };
    this.speedHost = seg('speed-seg', [0.5, 1, 2, 4, 8].map((v) => ({ label: `${v}×`, value: v, handler: 'onSpeed' })));
    this.modeHost = seg('mode-seg', [
      { label: '分级模式', value: 'graded', handler: 'onMode' },
      { label: '混合-保守', value: 'pooledConservative', handler: 'onMode' },
      { label: '混合-经验', value: 'pooledNaive', handler: 'onMode' },
    ]);
    this.viewHost = seg('view-seg', [
      { label: '环绕', value: 'orbit', handler: 'onView' },
      { label: '俯视', value: 'top', handler: 'onView' },
      { label: '服务站', value: 'station', handler: 'onView' },
      { label: '跟随', value: 'follow', handler: 'onView' },
    ]);
    this.chargeModeHost = seg('charge-seg', [
      { label: '无充电', value: 'off', handler: 'onChargingMode' },
      { label: '慢充 3kW', value: 'slow', handler: 'onChargingMode' },
      { label: '快充 30kW', value: 'fast', handler: 'onChargingMode' },
      { label: '换电 2min', value: 'swap', handler: 'onChargingMode' },
    ]);
    this.chargersHost = seg('chargers-seg', [2, 4, 8, 12].map((v) => ({ label: `${v} 台`, value: v, handler: 'onChargers' })));
    this.supplyHost = seg('supply-seg', [
      { label: '纯市电', value: 'grid', handler: 'onSupply' },
      { label: '光伏', value: 'pv', handler: 'onSupply' },
      { label: '光伏+储能', value: 'pv_storage', handler: 'onSupply' },
    ]);
    $('follow-select').addEventListener('change', (e) => this.h.onFollow(e.target.value));
    $('tg-lines').addEventListener('change', (e) => this.h.onToggle('lines', e.target.checked));
    $('tg-trails').addEventListener('change', (e) => this.h.onToggle('trails', e.target.checked));
    $('tg-labels').addEventListener('change', (e) => this.h.onToggle('labels', e.target.checked));
    $('tg-shadows').addEventListener('change', (e) => this.h.onToggle('shadows', e.target.checked));
    $('tg-bloom').addEventListener('change', (e) => this.h.onToggle('bloom', e.target.checked));
    const tl = $('timeline');
    tl.addEventListener('input', () => {
      this._scrubbing = true;
      this.h.onSeek(Number(tl.value), false);
      this._scrubbing = false;
    });
    $('btn-hide-ui').addEventListener('click', () => this.toggleUI());
    $('btn-show-ui').addEventListener('click', () => this.toggleUI());
    $('load-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b) this.setLoadTab(Number(b.dataset.load));
    });
    $('trace-filters').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      this.traceFilter = b.dataset.filter;
      for (const btn of $('trace-filters').querySelectorAll('button')) btn.classList.toggle('on', btn === b);
      this._applyTraceFilter();
    });
    $('energy-load-tabs')?.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b) this.setEnergyLoadTab(Number(b.dataset.load));
    });
  }

  toggleUI() {
    const hidden = document.body.classList.toggle('ui-hidden');
    $('btn-hide-ui').textContent = hidden ? '显示面板' : '隐藏面板';
  }

  setPlaying(v) {
    this.playing = v;
    $('btn-play').textContent = v ? '暂停' : '开始';
    $('btn-play').classList.toggle('on', v);
  }

  setSpeed(v) {
    this.speed = v;
    for (const b of this.speedHost.children) b.classList.toggle('on', Number(b.dataset.value) === v);
  }

  setMode(id) {
    this.mode = id;
    for (const b of this.modeHost.children) b.classList.toggle('on', b.dataset.value === id);
    this._markCompareRow();
  }

  setView(name) {
    this.view = name;
    for (const b of this.viewHost.children) b.classList.toggle('on', b.dataset.value === name);
  }

  setChargingMode(id) {
    for (const b of this.chargeModeHost.children) b.classList.toggle('on', b.dataset.value === id);
  }

  setChargers(n) {
    for (const b of this.chargersHost.children) b.classList.toggle('on', Number(b.dataset.value) === Number(n));
  }

  setSupply(id) {
    for (const b of this.supplyHost.children) b.classList.toggle('on', b.dataset.value === id);
  }

  setFollowId(id) {
    $('follow-select').value = id;
  }

  setDuration(d) {
    this.duration = d;
    const tl = $('timeline');
    tl.max = String(Math.round(d));
  }

  // ───────────────────────── 数据绑定 ─────────────────────────
  bindSim(sim, replay, meta) {
    this.sim = sim;
    this.replay = replay;
    this.meta = meta;

    const landings = sim.sorties.filter((s) => s.landT != null).sort((a, b) => a.landT - b.landT);
    this.landT = landings.map((s) => s.landT);
    this.landDelay = landings.map((s) => (s.waitDepart || 0) + (s.waitArrive || 0));
    this.landEnergy = landings.map((s) => s.energy_kwh || 0);

    // 充电事件与充电桩忙闲区间（能耗/成本/充电指标用）
    this.chargeEvents = sim.chargeEvents.slice().sort((a, b) => a.t - b.t);
    this.chargerIntervals = sim.chargers.map((c) => ({ intervals: c.busy.slice().sort((a, b) => a[0] - b[0]) }));

    const cf = sim.conflicts.slice().sort((a, b) => a.t - b.t);
    this.confT = cf.map((c) => c.t);
    this.confAir = cf.map((c) => (c.type === 'AIR_SEPARATION' ? 1 : 0));
    this.confSevere = cf.map((c) => (c.severity === '严重' ? 1 : 0));

    this.padIntervals = sim.pads.map((p) => ({
      intervals: p.busy.slice().sort((a, b) => a[0] - b[0]),
      open: p.busyStart != null ? p.busyStart : null,
    }));
    this.chIntervals = sim.channels.map((ch) => ({ id: ch.id, intervals: ch.busy.slice().sort((a, b) => a[0] - b[0]) }));

    this.cmdTimes = sim.log.filter((e) => e.kind === 'RELEASE').map((e) => e.t).sort((a, b) => a - b);
    this.devTimes = sim.log.filter((e) => e.kind === 'PILOT_EXEC' && e.verdict === 'DEVIATION').map((e) => e.t).sort((a, b) => a - b);

    this.renderTrace();
    this.renderFollowOptions();
    $('load-tabs').innerHTML = LOAD_TABS.map(
      (l) => `<button class="btn tab-btn${l === 1 ? ' on' : ''}" data-load="${l}">负荷 ${l.toFixed(1)}</button>`,
    ).join('');
    this.setMode(sim.scn.policyId);
    this.setChargingMode(meta.chargingMode ?? 'off');
    this.setChargers(meta.chargersN ?? 4);
    this.setSupply(meta.supplyId ?? 'grid');
    this.setView(this.view);
    this.setSpeed(this.speed);
    this.setDuration(meta.replayEnd ?? meta.duration);
    this.updateAt(0);
  }

  renderFollowOptions() {
    const sel = $('follow-select');
    sel.innerHTML = this.sim.aircraft
      .map((a) => `<option value="${a.id}">${a.id} · ${a.cls === 'micro' ? '微型' : a.cls === 'heavy' ? '重型' : '货运'}</option>`)
      .join('');
    sel.value = this.sim.aircraft[0].id;
  }

  /** 与当前 t 无关的顶部信息 */
  setScenarioInfo(meta) {
    $('scn-chips').innerHTML = [
      `<span class="chip strong">${meta.scenarioName}</span>`,
      `<span class="chip">负荷 ${meta.load.toFixed(1)}</span>`,
      `<span class="chip">机队 ${meta.fleetText}</span>`,
      `<span class="chip">种子 ${meta.seed}</span>`,
      `<span class="chip">仿真时长 ${Math.round(meta.duration)} s</span>`,
      `<span class="chip">${CHARGING_LABEL[meta.chargingMode] ?? '无充电'}${meta.chargingMode !== 'off' ? ` · ${meta.chargersN} 台` : ''}</span>`,
      `<span class="chip">${SUPPLY_LABEL[meta.supplyId] ?? meta.supplyLabel ?? '纯市电'}</span>`,
    ].join('');
  }

  // ───────────────────────── 实时指标 ─────────────────────────
  updateAt(t) {
    if (!this.sim) return;
    const sim = this.sim;
    const win = Math.min(t, 3600);
    const hours = win / 3600;
    const end = countUpTo(this.landT, t);
    const start = countUpTo(this.landT, t - win);
    const n = end - start;
    const throughput = hours > 0.02 ? n / hours : 0;
    let delay = 0;
    if (n > 0) {
      let s = 0;
      for (let i = start; i < end; i++) s += this.landDelay[i];
      delay = s / n;
    }
    const confTotal = countUpTo(this.confT, t);
    let confAir = 0;
    let confSevere = 0;
    for (let i = 0; i < confTotal; i++) {
      confAir += this.confAir[i];
      confSevere += this.confSevere[i];
    }
    let busy = 0;
    for (const p of this.padIntervals) {
      busy += overlapUpTo(p.intervals, t);
      if (p.open != null && p.open < t) busy += t - p.open;
    }
    const util = t > 1 ? (busy / (this.padIntervals.length * t)) * 100 : 0;

    // 能耗（统计窗口内完成架次的任务能耗）
    let energy = 0;
    for (let i = start; i < end; i++) energy += this.landEnergy[i];
    const energyRate = hours > 0.02 ? energy / hours : 0;

    // 充电桩利用率与窗口内充电事件（成本、平均排队）
    let chgBusy = 0;
    for (const c of this.chargerIntervals) chgBusy += overlapUpTo(c.intervals, t);
    const chgUtil = t > 1 && this.chargerIntervals.length ? (chgBusy / (this.chargerIntervals.length * t)) * 100 : 0;
    const winEvents = [];
    for (const e of this.chargeEvents) {
      if (e.t >= t - win && e.t < t) winEvents.push(e);
      if (e.t >= t) break;
    }
    const costRate = hours > 0.02 ? energyCost(winEvents, sim.supply).cost_yuan / hours : 0;
    const avgChgQueue = winEvents.length ? winEvents.reduce((a, e) => a + (e.queue || 0), 0) / winEvents.length : 0;
    let chBest = 0;
    let chBestId = '—';
    for (const ch of this.chIntervals) {
      const u = t > 1 ? (overlapUpTo(ch.intervals, t) / t) * 100 : 0;
      if (u > chBest) {
        chBest = u;
        chBestId = ch.id;
      }
    }

    $('m-throughput').textContent = fmt(throughput, 1);
    $('m-delay').textContent = fmt(delay, 1);
    $('m-conflicts').textContent = String(confTotal);
    $('m-util').textContent = fmt(util, 1);
    $('m-energy').textContent = fmt(energyRate, 1);
    $('m-cost').textContent = fmt(costRate, 2);
    $('m-chgutil').textContent = fmt(chgUtil, 1);
    $('metrics-window').textContent = t < 3600 ? `统计窗口 0 – ${Math.round(t)} s` : '统计窗口 最近 1 小时';
    const releases = countUpTo(this.cmdTimes, t);
    const devs = countUpTo(this.devTimes, t);
    $('metrics-sub').innerHTML = [
      `<span>已统计架次 <b>${n}</b></span>`,
      `<span>空中冲突 <b>${confAir}</b> / 地面 <b>${confTotal - confAir}</b></span>`,
      `<span>严重 <b>${confSevere}</b></span>`,
      `<span>在空 <b>${this.airborne}</b></span>`,
      `<span>放行指令 <b>${releases}</b></span>`,
      `<span>飞手偏差 <b>${devs}</b></span>`,
      `<span>通道峰值 <b>${fmt(chBest, 0)}%</b>（${chBestId}）</span>`,
      `<span>充电排队 <b>${fmt(avgChgQueue, 1)}</b>s</span>`,
    ].join('');

    $('time-readout').textContent = `t = ${clock(t)}`;
    $('scn-time').textContent = `${clock(t)} / ${clock(this.duration)}`;
    if (!this._scrubbing) $('timeline').value = String(Math.round(t));
    this._updateTraceStates(t);
  }

  // ───────────────────────── 对照实验表 ─────────────────────────
  async loadExperiment(url = './results/experiment.json') {
    try {
      const res = await fetch(url, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.experiment = await res.json();
      this.experimentUrl = url;
      this.setLoadTab(this.experiment.load_levels.includes(1) ? 1 : this.experiment.load_levels[0]);
      $('cmp-note').textContent = `数据来源 results/experiment.json（种子 ${this.experiment.seed}，${this.experiment.results.length} 组实验，引擎实测）`;
    } catch (err) {
      $('cmp-note').textContent = `对照实验数据加载失败：${err.message}（请先运行 npm run experiment 或通过 vite 预览访问）`;
      $('cmp-body').innerHTML = '';
    }
  }

  setLoadTab(load) {
    this.loadTab = load;
    for (const b of $('load-tabs').children) b.classList.toggle('on', Number(b.dataset.load) === load);
    this.renderCompare();
  }

  renderCompare() {
    if (!this.experiment) return;
    const rows = POLICY_ORDER.map((pid) => {
      const r = this.experiment.results.find((x) => x.scenario.policyId === pid && x.scenario.load === this.loadTab);
      return { pid, r };
    }).filter((x) => x.r);
    const best = Math.max(...rows.map((x) => x.r.totals.throughput_per_h));
    const least = Math.min(...rows.map((x) => x.r.totals.conflicts));
    $('cmp-body').innerHTML = rows
      .map(({ pid, r }) => {
        const t = r.totals;
        const acc = t.accountability;
        return `<tr data-policy="${pid}">
          <td class="cmp-name">${r.scenario.short}</td>
          <td class="${t.throughput_per_h === best ? 'best' : ''}">${fmt(t.throughput_per_h, 1)}</td>
          <td>${fmt(t.avg_delay_s, 1)}</td>
          <td class="${t.conflicts === least ? 'best' : ''}">${t.conflicts}</td>
          <td class="cmp-sev">${t.severe_conflicts}</td>
          <td class="cmp-acc">${acc['调度指令错误']} / ${acc['飞手违规']}</td>
        </tr>`;
      })
      .join('');
    this._markCompareRow();
  }

  _markCompareRow() {
    for (const tr of $('cmp-body').querySelectorAll('tr')) {
      tr.classList.toggle('cur', tr.dataset.policy === this.mode);
    }
  }

  // ───────────────────────── 充电设施因子实验表 ─────────────────────────
  async loadEnergyExperiment(url = './results/energy_experiment.json') {
    try {
      const res = await fetch(url, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.energyExp = await res.json();
      const loads = [...new Set(this.energyExp.results.map((r) => r.负荷))].sort((a, b) => a - b);
      $('energy-load-tabs').innerHTML = loads
        .map((l) => `<button class="btn tab-btn${l === 2 ? ' on' : ''}" data-load="${l}">负荷 ${l.toFixed(1)}</button>`)
        .join('');
      this.energyLoad = 2;
      this.renderEnergyCompare();
      $('energy-note').textContent = `数据来源 results/energy_experiment.json（种子 ${this.energyExp.seed}，${this.energyExp.results.length} 组，引擎实测）`;
    } catch (err) {
      $('energy-note').textContent = `充电因子数据加载失败：${err.message}（请先运行 node scripts/experiment_energy.mjs）`;
      $('energy-body').innerHTML = '';
    }
  }

  setEnergyLoadTab(load) {
    this.energyLoad = load;
    for (const b of $('energy-load-tabs').children) b.classList.toggle('on', Number(b.dataset.load) === load);
    this.renderEnergyCompare();
  }

  /** 行 = 模式×桩数（9 种配置）；列对比"纯市电 vs 光伏+储能"的用电成本与吞吐量 */
  renderEnergyCompare() {
    if (!this.energyExp) return;
    const load = this.energyLoad;
    const R = this.energyExp.results.filter((r) => r.负荷 === load);
    const cfgRows = [];
    for (const mode of ['slow', 'fast', 'swap']) {
      for (const n of [2, 4, 8]) {
        const grid = R.find((r) => r.充电桩数 === n && r.充电模式.includes(mode === 'slow' ? '慢充' : mode === 'fast' ? '快充' : '换电') && r.供电方案 === '纯市电');
        const pvs = R.find((r) => r.充电桩数 === n && r.充电模式.includes(mode === 'slow' ? '慢充' : mode === 'fast' ? '快充' : '换电') && r.供电方案 === '光伏+储能');
        if (grid) cfgRows.push({
          key: `${mode}${n}`,
          label: `${CHARGING_LABEL[mode]} · ${n} 台`,
          throughput: grid['吞吐量_架次每小时'],
          delay: grid['平均延误_s'],
          costGrid: grid['用电成本_元_每小时'],
          costPv: pvs ? pvs['用电成本_元_每小时'] : '—',
        });
      }
    }
    const base = R.find((r) => r.充电模式 === '无充电（满电基线）');
    $('energy-body').innerHTML = cfgRows
      .map((r) => `<tr>
        <td class="cmp-name">${r.label}</td>
        <td>${fmt(r.throughput, 1)}</td>
        <td>${fmt(r.delay, 1)}</td>
        <td>${fmt(r.costGrid, 2)}</td>
        <td>${r.costPv === '—' ? '—' : fmt(r.costPv, 2)}</td>
      </tr>`)
      .join('')
      + (base ? `<tr class="base-row"><td class="cmp-name">基线（无充电）</td><td>${fmt(base['吞吐量_架次每小时'], 1)}</td><td>${fmt(base['平均延误_s'], 1)}</td><td colspan="2">0（无充电费用）</td></tr>` : '');
  }

  // ───────────────────────── 责任追溯 ─────────────────────────
  renderTrace() {
    const sim = this.sim;
    const list = $('trace-list');
    const cf = sim.conflicts.slice().sort((a, b) => b.t - a.t).slice(0, MAX_TRACE_ROWS);
    this.rows = [];
    this._builtBody.clear();
    const html = cf.map((c) => {
      const resp = c.autopsy ? c.autopsy.responsible : '—';
      return `<div class="trace-item" data-id="${c.id}">
        <div class="trace-head">
          <span class="sev ${c.severity === '严重' ? 'sev-bad' : 'sev-mid'}">${c.severity}</span>
          <span class="tid">${c.id}</span>
          <span class="ttime">${clock(c.t)}</span>
          <span class="ttype">${c.typeLabel}${c.endT != null ? ` · 持续 ${fmt(c.endT - c.t, 0)}s` : ''}</span>
          <span class="tmeas">实测量 <b>${fmt(c.measured_m, 2)}</b> m / 要求 <b>${c.required_m}</b> m</span>
          <span class="tlocus">${c.chLabel}</span>
          <span class="tresp">责任：${resp}</span>
        </div>
        <div class="trace-body"></div>
      </div>`;
    }).join('');
    list.innerHTML = html;
    const counts = { total: sim.conflicts.length, air: 0, ground: 0, severe: 0, dispatch: 0, pilot: 0 };
    for (const c of sim.conflicts) {
      if (c.type === 'AIR_SEPARATION') counts.air++;
      else counts.ground++;
      if (c.severity === '严重') counts.severe++;
      const cat = c.autopsy?.category;
      if (cat === '调度指令错误') counts.dispatch++;
      else if (cat === '飞手违规') counts.pilot++;
    }
    $('trace-count').textContent = `共 ${counts.total} 起（空中 ${counts.air} / 地面 ${counts.ground}，严重 ${counts.severe}）｜责任：调度 ${counts.dispatch} · 飞手 ${counts.pilot}`;
    for (const el of list.querySelectorAll('.trace-item')) {
      const c = sim.conflicts.find((x) => x.id === el.dataset.id);
      this.rows.push({ el, c, state: 'future' });
      el.querySelector('.trace-head').addEventListener('click', () => this.h.onIncidentSelect(this.highlightId === c.id ? null : c.id));
    }
    this._applyTraceFilter();
    this.updateAt(this.lastT || 0);
  }

  _applyTraceFilter() {
    for (const row of this.rows) {
      const c = row.c;
      const on = this.traceFilter === 'all'
        || (this.traceFilter === 'air' && c.type === 'AIR_SEPARATION')
        || (this.traceFilter === 'ground' && c.type === 'GROUND_SEPARATION')
        || (this.traceFilter === 'severe' && c.severity === '严重');
      row.el.classList.toggle('hidden', !on);
    }
  }

  /** 事件行状态只由当前时刻 t 决定（不依赖播放历史），保证任意跳转后画面一致 */
  _updateTraceStates(t) {
    this.lastT = t;
    for (const row of this.rows) {
      const c = row.c;
      const end = c.endT != null ? c.endT : c.t + 6;
      const state = t < c.t ? 'future' : t <= end ? 'active' : 'past';
      if (row.state === state) continue;
      row.state = state;
      row.el.classList.toggle('active', state === 'active');
      row.el.classList.toggle('past', state === 'past');
    }
  }

  /** 展开某条事件的完整日志链（CMD → EXE → CFT）与责任判定依据 */
  _buildTraceBody(row) {
    const c = row.c;
    const sim = this.sim;
    const a = c.autopsy;
    const rec = (r) => {
      if (!r) return '';
      const rows = Object.entries(r)
        .filter(([k]) => !['autopsy', 'pair', 'window', 'id', 'kind', 'cls'].includes(k))
        .map(([k, v]) => {
          const val = k === 't' || k.endsWith('EntryT') ? fmtTime(v) : k === 'cls' ? CLS_LABEL[v] ?? v : Array.isArray(v) ? v.join(' / ') : String(v);
          return `<span class="kv"><i>${FIELD_LABEL[k] ?? k}</i>${val}</span>`;
        })
        .join('');
      return `<div class="logrec"><div class="logrec-t">${r.id} · ${KIND_LABEL[r.kind] ?? r.kind}</div><div class="logrec-b">${rows}</div></div>`;
    };
    const cmdIds = a ? a.chain.filter((x) => x.startsWith('CMD-')) : [];
    const execIds = a ? a.chain.filter((x) => x.startsWith('EXE-')) : [];
    const body = `
      <div class="chain-flow">${(a ? a.chain : [c.id]).map((x, i) => `<span class="chain-node${i === (a ? a.chain.length : 1) - 1 ? ' last' : ''}">${x}</span>${i < (a ? a.chain.length - 1 : 0) ? '<span class="chain-arrow">→</span>' : ''}`).join('')}</div>
      <div class="autopsy-cat">责任判定：<b class="${a && a.category === '飞手违规' ? 'cat-pilot' : 'cat-dispatch'}">${a ? a.category : '—'}</b> · 责任主体 <b>${a ? a.responsible : '—'}</b></div>
      <div class="basis"><div class="basis-t">判定依据</div><ul>${(a ? a.basis : []).map((b) => `<li>${b}</li>`).join('')}</ul></div>
      <div class="logrecs">
        ${cmdIds.map((id) => rec(sim.cmdById.get(id))).join('')}
        ${execIds.map((id) => rec(sim.execById.get(id))).join('')}
        ${rec({ id: c.id, kind: 'CFT', t: c.t, typeLabel: c.typeLabel, chLabel: c.chLabel, measured_m: c.measured_m, required_m: c.required_m, severity: c.severity, window: c.window })}
      </div>
      <div class="trace-actions"><button class="btn tiny" data-seek="${c.t}">定位到此刻</button></div>`;
    row.el.querySelector('.trace-body').innerHTML = body;
    row.el.querySelector('[data-seek]').addEventListener('click', (e) => {
      e.stopPropagation();
      this.h.onSeek(Number(e.target.dataset.seek), true);
      this.h.onIncidentSelect(c.id);
    });
    this._builtBody.add(c.id);
  }

  highlightIncident(id) {
    this.highlightId = id;
    for (const row of this.rows) {
      const on = row.c.id === id;
      row.el.classList.toggle('hl', on);
      if (on) {
        if (!this._builtBody.has(row.c.id)) this._buildTraceBody(row);
        row.el.querySelector('.trace-body').classList.add('open');
        row.el.scrollIntoView({ block: 'center' });
      } else {
        row.el.querySelector('.trace-body')?.classList.remove('open');
      }
    }
  }

  // ───────────────────────── 加载遮罩 ─────────────────────────
  showLoading(text = '正在加载…') {
    const el = $('loading');
    $('loading-text').textContent = text;
    el.classList.remove('hidden');
  }

  hideLoading() {
    // 直接隐藏（不做淡出动画）：录屏首帧截图必须与之后完全一致
    $('loading').classList.add('hidden');
  }

  // ───────────────────────── 字幕 ─────────────────────────
  setCaption({ title, subtitle, metrics } = {}) {
    const host = $('caption');
    if (!title && !subtitle && !metrics) {
      host.innerHTML = '';
      host.classList.remove('on');
      return;
    }
    const chips = normalizeMetrics(metrics);
    host.innerHTML = `<div class="cap-card">
      ${title ? `<div class="cap-title">${title}</div>` : ''}
      ${subtitle ? `<div class="cap-sub">${subtitle}</div>` : ''}
      ${chips.length ? `<div class="cap-metrics">${chips.map((x) => `<span class="cap-chip">${x}</span>`).join('')}</div>` : ''}
    </div>`;
    host.classList.add('on');
  }
}

/** 把各种形态的 metrics 参数统一成 ["标签 数值", ...] */
function normalizeMetrics(metrics) {
  if (!metrics) return [];
  if (typeof metrics === 'string') return [metrics];
  if (Array.isArray(metrics)) {
    return metrics.map((m) => {
      if (Array.isArray(m)) return `${m[0]} <b>${m[1]}</b>`;
      if (m && typeof m === 'object') return `${m.label ?? m.name ?? ''} <b>${m.value ?? ''}</b>`;
      return String(m);
    });
  }
  if (typeof metrics === 'object') {
    return Object.entries(metrics).map(([k, v]) => `${k} <b>${v}</b>`);
  }
  return [];
}
