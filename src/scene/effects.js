/**
 * 视觉特效层：冲突告警（红色扩散光圈 + 警告标记）、调度指令连线、
 * 指定冲突事件的定位高亮。全部动画只由仿真时刻 t 决定，保证可复现。
 */
import * as THREE from 'three';

const RING_POOL = 14;
const LINE_POOL = 10;
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const WARN_TEX = (() => {
  let tex = null;
  return () => {
    if (tex) return tex;
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const c = canvas.getContext('2d');
    c.clearRect(0, 0, size, size);
    c.beginPath();
    c.moveTo(size / 2, 26);
    c.lineTo(size - 22, size - 40);
    c.lineTo(22, size - 40);
    c.closePath();
    c.fillStyle = 'rgba(255,58,48,0.92)';
    c.fill();
    c.lineWidth = 10;
    c.strokeStyle = 'rgba(255,235,230,0.95)';
    c.stroke();
    c.fillStyle = '#fff';
    c.font = 'bold 140px "Microsoft YaHei",sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('!', size / 2, size / 2 + 24);
    tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  };
})();

export class Effects {
  constructor(scene) {
    this.group = new THREE.Group();
    scene.add(this.group);
    this.rings = [];
    this.marks = [];
    this.lines = [];
    this.showCommands = true;
    this.conflicts = [];
    this.releases = [];
    this.replay = null;
    this.sim = null;
    this.highlightId = null;
    this._anchor = { x: 0, y: 0, z: 0 };
    this._scratch = {};
    this._buildPools();
  }

  _buildPools() {
    const ringGeo = new THREE.RingGeometry(0.82, 1, 56);
    for (let i = 0; i < RING_POOL; i++) {
      const m = new THREE.Mesh(
        ringGeo,
        new THREE.MeshBasicMaterial({
          color: 0xff3b30,
          transparent: true,
          opacity: 0,
          side: THREE.DoubleSide,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      m.rotation.x = -Math.PI / 2;
      m.visible = false;
      m.frustumCulled = false;
      this.group.add(m);
      this.rings.push(m);

      const sp = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: WARN_TEX(), transparent: true, depthWrite: false, opacity: 0 }),
      );
      sp.visible = false;
      this.group.add(sp);
      this.marks.push(sp);
    }

    const lineGeo = new THREE.CylinderGeometry(0.55, 0.55, 1, 8, 1, true);
    for (let i = 0; i < LINE_POOL; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0x8ff0ff,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const cyl = new THREE.Mesh(lineGeo, mat);
      cyl.visible = false;
      cyl.frustumCulled = false;
      this.group.add(cyl);
      const head = new THREE.Mesh(
        new THREE.SphereGeometry(2.2, 12, 10),
        new THREE.MeshBasicMaterial({ color: 0xd6ffff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }),
      );
      head.visible = false;
      this.group.add(head);
      this.lines.push({ cyl, head });
    }

    // 责任追溯"定位"专用高亮
    this.hlRing = new THREE.Mesh(
      new THREE.RingGeometry(16, 19, 64),
      new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    this.hlRing.rotation.x = -Math.PI / 2;
    this.hlRing.visible = false;
    this.hlRing.frustumCulled = false;
    this.group.add(this.hlRing);
    this.hlBeam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.9, 0.9, 1, 8, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    this.hlBeam.visible = false;
    this.group.add(this.hlBeam);
  }

  rebuild(sim, replay) {
    this.sim = sim;
    this.replay = replay;
    this.conflicts = sim.conflicts.slice().sort((a, b) => a.t - b.t);
    this.releases = sim.log.filter((e) => e.kind === 'RELEASE').sort((a, b) => a.t - b.t);
    this.highlightId = null;
    this.hlRing.visible = false;
    this.hlBeam.visible = false;
  }

  setCommandLinesVisible(on) {
    this.showCommands = on;
    if (!on) {
      for (const l of this.lines) {
        l.cyl.visible = false;
        l.head.visible = false;
      }
    }
  }

  setHighlight(id) {
    this.highlightId = id;
  }

  /** 指令连线：RELEASE 日志后 0.6 s 内从无人机运行服务站连向被放行无人机 */
  _updateCommandLines(t) {
    if (!this.showCommands) return;
    let slot = 0;
    for (const rec of this.releases) {
      if (rec.t > t) break;
      const age = t - rec.t;
      if (age < 0 || age > 0.6) continue;
      if (slot >= LINE_POOL) break;
      const ac = this.sim.aircraft.find((a) => a.id === rec.ac);
      if (!ac) continue;
      const p = this.replay.poseAt(ac.id, t, this._scratch);
      if (!p.visible) continue;
      const st = this.sim.scn.layout.station;
      const from = _v1.set(st.x, 40, st.z);
      const to = _v2.set(p.x, p.y + 1, p.z);
      const line = this.lines[slot++];
      const k = 1 - age / 0.6;
      const dir = _v3.copy(to).sub(from);
      const len = dir.length();
      line.cyl.position.copy(from).addScaledVector(dir, 0.5);
      line.cyl.quaternion.setFromUnitVectors(_up, dir.normalize());
      line.cyl.scale.set(1, len, 1);
      line.cyl.material.opacity = 0.75 * k;
      line.cyl.visible = true;
      line.head.position.copy(to);
      line.head.material.opacity = 0.9 * k;
      line.head.scale.setScalar(0.6 + 0.6 * k);
      line.head.visible = true;
    }
    for (let i = slot; i < LINE_POOL; i++) {
      this.lines[i].cyl.visible = false;
      this.lines[i].head.visible = false;
    }
  }

  /** 冲突告警：光圈 + 警告标记，持续到 endT（地面冲突）或 t+6 s */
  _updateConflicts(t) {
    const active = [];
    for (const c of this.conflicts) {
      if (c.t - 0.1 > t) break;
      const end = c.endT != null ? c.endT : c.t + 6;
      if (t <= end) active.push(c);
    }
    if (active.length > RING_POOL) active.splice(0, active.length - RING_POOL);
    for (let i = 0; i < RING_POOL; i++) {
      const ring = this.rings[i];
      const mark = this.marks[i];
      const c = active[i];
      if (!c) {
        ring.visible = false;
        mark.visible = false;
        continue;
      }
      const a = this.replay.conflictAnchor(c, t, this._anchor);
      const age = Math.max(0, t - c.t);
      const end = c.endT != null ? c.endT : c.t + 6;
      const tail = Math.max(0, Math.min(1, (end - t) / 1.6));
      const grow = 1 - Math.exp(-age / 2.2);
      const pulse = 1 + 0.12 * Math.sin(age * 6.5);
      const r = (12 + 34 * grow) * pulse;
      ring.position.set(a.x, Math.max(1.2, a.y - 5), a.z);
      ring.scale.set(r, r, 1);
      ring.material.opacity = 0.8 * tail * (c.severity === '严重' ? 1 : 0.7);
      ring.visible = true;
      ring.material.color.set(c.severity === '严重' ? 0xff2a1f : 0xff7a3d);

      const ms = 30 + 8 * Math.sin(age * 5);
      mark.position.set(a.x, a.y + 14 + 2 * Math.sin(age * 3), a.z);
      mark.scale.set(ms, ms, 1);
      mark.material.opacity = 0.95 * tail;
      mark.visible = true;
    }
  }

  _updateHighlight(t) {
    if (!this.highlightId || !this.sim) {
      this.hlRing.visible = false;
      this.hlBeam.visible = false;
      return;
    }
    const c = this.conflicts.find((x) => x.id === this.highlightId);
    if (!c) {
      this.hlRing.visible = false;
      this.hlBeam.visible = false;
      return;
    }
    const a = this.replay.conflictAnchor(c, Math.max(t, c.t), this._anchor);
    const pulse = 1 + 0.1 * Math.sin(t * 4);
    this.hlRing.position.set(a.x, 1.4, a.z);
    this.hlRing.scale.set(pulse, pulse, 1);
    this.hlRing.visible = true;
    const h = Math.max(6, a.y);
    this.hlBeam.scale.set(1, h, 1);
    this.hlBeam.position.set(a.x, h / 2, a.z);
    this.hlBeam.visible = true;
  }

  update(t) {
    if (!this.replay) return;
    this._updateConflicts(t);
    this._updateCommandLines(t);
    this._updateHighlight(t);
  }
}
