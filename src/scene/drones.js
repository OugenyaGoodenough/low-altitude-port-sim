/**
 * 无人机机队：三类机型全部由基础几何体程序化拼装（不使用外部模型文件），
 * 位置/姿态完全由 Replay 按仿真时刻驱动；旋翼转速、航迹也只用 t 计算，
 * 保证 renderAt(t) 的确定性。
 */
import * as THREE from 'three';
import { CLASS_COLOR, makeLabel, rescaleLabel, disposeChildren } from './world.js';

/** 视觉放大量：真实尺寸在场区尺度下太小，这里放大到可辨识（概念化演示） */
const TRAIL_POINTS = 14;
const TRAIL_DT = 1.2;

function mat(color, opts = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.25, ...opts });
}

function arm(len, radius, color) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, len, 6), mat(color, { metalness: 0.5 }));
  m.rotation.z = Math.PI / 2;
  return m;
}

/** 二叶旋翼：用细长薄板代替圆盘，转动时肉眼可辨 */
function rotor(r, color) {
  const g = new THREE.Group();
  const blade = new THREE.BoxGeometry(r * 2, 0.09, r * 0.34);
  const mtl = mat(color, { metalness: 0.4, roughness: 0.4 });
  const b1 = new THREE.Mesh(blade, mtl);
  const b2 = new THREE.Mesh(blade, mtl);
  b2.rotation.y = Math.PI / 2;
  g.add(b1, b2);
  g.name = 'rotor';
  return g;
}

function buildMicro() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.5, 1.9), mat(0x2b333c, { metalness: 0.4 }));
  body.castShadow = true;
  g.add(body);
  const accent = new THREE.Mesh(new THREE.BoxGeometry(1.36, 0.16, 0.7), mat(0x9ff0ff, { emissive: CLASS_COLOR.micro, emissiveIntensity: 1.1 }));
  accent.position.y = 0.3;
  g.add(accent);
  const armLen = 2.6;
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const a = arm(armLen, 0.11, 0x39424d);
    a.position.set(sx * 0.65, 0.05, sz * 0.65);
    a.rotation.y = Math.atan2(sz, sx);
    g.add(a);
    const r = rotor(1.15, 0x1d2830);
    r.position.set(sx * 1.3, 0.32, sz * 1.3);
    g.add(r);
  }
  const light = new THREE.Mesh(new THREE.SphereGeometry(0.28, 10, 8), new THREE.MeshBasicMaterial({ color: CLASS_COLOR.micro }));
  light.position.set(0, -0.42, 0);
  g.add(light);
  return g;
}

function buildHeavy() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(1.15, 2.4, 8, 16), mat(0x2f3742, { metalness: 0.45 }));
  body.rotation.x = Math.PI / 2;
  body.position.y = 0.55;
  body.castShadow = true;
  g.add(body);
  const belly = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.0, 2.4), mat(0xffd9a8, { emissive: CLASS_COLOR.heavy, emissiveIntensity: 0.35 }));
  belly.position.y = -0.5;
  g.add(belly);
  const armLen = 4.4;
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const a = arm(armLen, 0.19, 0x3b444f);
    a.position.set(sx * 1.5, 0.5, sz * 1.5);
    a.rotation.y = Math.atan2(sz, sx);
    g.add(a);
    const r = rotor(2.1, 0x161d24);
    r.position.set(sx * 2.9, 0.95, sz * 2.9);
    g.add(r);
    const pod = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.9, 12), mat(0x8a949f));
    pod.position.set(sx * 2.9, 0.72, sz * 2.9);
    g.add(pod);
  }
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.16, 1.5, 1.1), mat(0xffc46b, { emissive: CLASS_COLOR.heavy, emissiveIntensity: 0.8 }));
  tail.position.set(0, 1.6, -2.1);
  g.add(tail);
  return g;
}

function buildCargo() {
  const g = new THREE.Group();
  const fuse = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 0.85, 12, 16), mat(0xe24f4f, { metalness: 0.35 }));
  fuse.rotation.x = Math.PI / 2;
  fuse.position.y = 1.5;
  fuse.castShadow = true;
  g.add(fuse);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(1.0, 2.2, 16), mat(0xf0f3f6));
  nose.rotation.x = Math.PI / 2;
  nose.position.set(0, 1.5, 7.1);
  g.add(nose);
  const cockpit = new THREE.Mesh(new THREE.SphereGeometry(0.85, 14, 10), mat(0x223b4d, { metalness: 0.6, roughness: 0.25 }));
  cockpit.position.set(0, 2.05, 5.2);
  g.add(cockpit);
  const wing = new THREE.Mesh(new THREE.BoxGeometry(22, 0.42, 3.6), mat(0xf2f5f7, { metalness: 0.2 }));
  wing.position.set(0, 1.9, 0.4);
  wing.castShadow = true;
  g.add(wing);
  const wingTipL = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.9, 2.2), mat(CLASS_COLOR.cargo, { emissive: CLASS_COLOR.cargo, emissiveIntensity: 0.5 }));
  wingTipL.position.set(-11, 2.2, 0.4);
  g.add(wingTipL);
  const wingTipR = wingTipL.clone();
  wingTipR.position.x = 11;
  g.add(wingTipR);
  const hstab = new THREE.Mesh(new THREE.BoxGeometry(8, 0.35, 2), mat(0xf2f5f7));
  hstab.position.set(0, 2.1, -5.6);
  g.add(hstab);
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.35, 3.2, 2.4), mat(0xef5350));
  fin.position.set(0, 3.6, -5.9);
  g.add(fin);
  for (const sx of [-1, 1]) {
    const pylonEngine = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 2.6, 12), mat(0xd7dde2, { metalness: 0.5 }));
    pylonEngine.rotation.x = Math.PI / 2;
    pylonEngine.position.set(sx * 5.4, 1.5, 1.4);
    g.add(pylonEngine);
    const prop = rotor(1.7, 0x2b333c);
    const holder = new THREE.Group();
    holder.position.set(sx * 5.4, 1.5, 2.8);
    // 螺旋桨绕机体纵轴（Z）旋转：把旋翼组的局部 Y 轴转成世界 Z 轴
    holder.rotation.x = -Math.PI / 2;
    holder.add(prop);
    g.add(holder);
  }
  const gear = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.3, 4.2), mat(0x39424d));
  gear.position.set(0, 0.2, 0.6);
  g.add(gear);
  return g;
}

const PROTOS = { micro: buildMicro, heavy: buildHeavy, cargo: buildCargo };
/** 场区尺度约 700 m，机型按真实尺寸会小到看不清，这里统一放大到可辨识（概念化演示） */
const MODEL_SCALE = { micro: 1.95, heavy: 1.3, cargo: 1.05 };

export class DroneFleet {
  constructor(scene) {
    this.group = new THREE.Group();
    scene.add(this.group);
    this.protos = {};
    for (const k of Object.keys(PROTOS)) this.protos[k] = PROTOS[k]();
    this.items = [];
    this.trailVisible = true;
    this.labelVisible = true;
    this.selected = null;
  }

  rebuild(sim) {
    disposeChildren(this.group);
    this.items = [];
    for (const ac of sim.aircraft) {
      const mesh = this.protos[ac.cls].clone(true);
      mesh.scale.setScalar(MODEL_SCALE[ac.cls] ?? 1);
      mesh.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = true;
          o.receiveShadow = false;
        }
      });
      const rotors = [];
      mesh.traverse((o) => {
        if (o.name === 'rotor') rotors.push(o);
      });
      this.group.add(mesh);

      const color = CLASS_COLOR[ac.cls];
      const label = makeLabel(`${ac.id}`, {
        size: 34,
        worldHeight: ac.cls === 'cargo' ? 12 : ac.cls === 'heavy' ? 10 : 8,
        color,
        bg: 'rgba(6,12,20,0.6)',
      });
      label.visible = this.labelVisible;
      this.group.add(label);

      const ringGeo = new THREE.RingGeometry(5.2, 6.4, 40);
      const selRing = new THREE.Mesh(
        ringGeo,
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false }),
      );
      selRing.rotation.x = -Math.PI / 2;
      selRing.visible = false;
      this.group.add(selRing);

      const posArr = new Float32Array(TRAIL_POINTS * 3);
      const trailGeo = new THREE.BufferGeometry();
      trailGeo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
      const trail = new THREE.Line(
        trailGeo,
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.55, depthWrite: false }),
      );
      trail.frustumCulled = false;
      trail.visible = this.trailVisible;
      this.group.add(trail);

      this.items.push({
        ac,
        mesh,
        label,
        rotors,
        selRing,
        trail,
        posArr,
        out: {},
        scratch: {},
        spinPhase: (ac.id.charCodeAt(ac.id.length - 1) % 7) * 0.6,
      });
    }
  }

  setTrailsVisible(on) {
    this.trailVisible = on;
    for (const it of this.items) it.trail.visible = on;
  }

  setLabelsVisible(on) {
    this.labelVisible = on;
    for (const it of this.items) it.label.visible = on;
  }

  select(acId) {
    this.selected = acId;
    for (const it of this.items) it.selRing.visible = it.ac.id === acId;
  }

  /** 把整支机队渲染到仿真时刻 t */
  update(t, replay, camera) {
    for (const it of this.items) {
      const p = replay.poseAt(it.ac.id, t, it.out);
      it.mesh.visible = p.visible;
      it.label.visible = p.visible && this.labelVisible;
      it.selRing.visible = p.visible && it.ac.id === this.selected;
      if (!p.visible) {
        it.trail.visible = false;
        continue;
      }
      it.mesh.position.set(p.x, p.y, p.z);
      it.mesh.rotation.y = p.yaw;
      const spin = t * 9 * (p.spin ?? 1) + it.spinPhase;
      for (const r of it.rotors) r.rotation.y = spin;
      it.label.position.set(p.x, p.y + (it.ac.cls === 'cargo' ? 9 : 5), p.z);
      if (camera) rescaleLabel(it.label, camera, 700, 0.3);
      it.selRing.position.set(p.x, Math.max(0.9, p.y - 2.2), p.z);
      it.selRing.rotation.z = t * 0.9;

      it.trail.visible = this.trailVisible;
      if (this.trailVisible) {
        const arr = it.posArr;
        for (let k = 0; k < TRAIL_POINTS; k++) {
          const q = replay.poseAt(it.ac.id, Math.max(0, t - k * TRAIL_DT), it.scratch);
          arr[k * 3] = q.x;
          arr[k * 3 + 1] = q.y;
          arr[k * 3 + 2] = q.z;
        }
        it.trail.geometry.attributes.position.needsUpdate = true;
        it.trail.geometry.computeBoundingSphere();
      }
    }
  }

  /** 供 UI 统计：当前在空的架数 */
  airborneCount(replay, t) {
    let n = 0;
    for (const it of this.items) if (replay.isAirborne(it.ac.id, t)) n++;
    return n;
  }
}
