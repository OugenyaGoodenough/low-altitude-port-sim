/**
 * 3D 场地：概念化高原地形 + 按 sim.scn.layout 生成的全部场地要素。
 * 所有几何都用米为单位，与仿真坐标一一对应（X/Z 平面，Y 向上）。
 * 布局随管理策略变化，因此场地要素在 rebuildField() 中整体重建。
 */
import * as THREE from 'three';
import { CLASSES } from '../sim/config.js';

export const CLASS_COLOR = {
  micro: CLASSES.micro.color,
  heavy: CLASSES.heavy.color,
  cargo: CLASSES.cargo.color,
  generic: '#a9bed6',
};

const SKY_TOP = '#3f74ab';
const SKY_BOTTOM = '#d3dfe6';
const HAZE = 0xcfdae2;

// ───────────────────────────── 确定性噪声 ─────────────────────────────
function hash2(ix, iz, seed) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(seed, 2246822519)) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177) | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function valueNoise(x, z, seed) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz, seed);
  const b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed);
  const d = hash2(ix + 1, iz + 1, seed);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}
function fbm(x, z, seed) {
  let s = 0;
  let amp = 1;
  let f = 1;
  let norm = 0;
  for (let o = 0; o < 5; o++) {
    s += amp * valueNoise(x * f, z * f, seed + o * 131);
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return s / norm;
}
const smoothstep = (e0, e1, x) => {
  const u = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return u * u * (3 - 2 * u);
};

/**
 * 概念化高原山地高程场。
 *
 * 结构（距场区中心(10,20)的半径）：
 *   d < 415          运行区（停机坪/跑道/服务站/远端任务环）完全压平，保证飞行安全与画面不被遮挡
 *   415 ~ 560        盆地边缘起坡
 *   ≈ 620 米环带      近景丘陵（100~170 m，方位向起伏 → 连绵山脊轮廓）
 *   ≈ 1100 米环带     中景山脊（260~520 m）
 *   ≈ 1900 米环带     远景雪线峰群（600~950 m）
 * 同一函数用于地形网格与场地要素落地高度，保证几何一致。
 */
export function heightAt(x, z) {
  const dx = x - 10;
  const dz = z - 20;
  const d = Math.hypot(dx, dz);
  const flat = smoothstep(415, 560, d);
  if (flat <= 0) return 0;
  const ang = Math.atan2(dz, dx);
  // 用单位圆坐标作为噪声输入，保证绕场区一周连续无缝
  const ca = Math.cos(ang) + 7.3;
  const sa = Math.sin(ang) + 7.3;
  const undulate = (a, b) => Math.pow(fbm(ca * a, sa * a, b), 1.15);
  const band = (center, width) => Math.exp(-Math.pow((d - center) / width, 2));

  // 近景丘陵（位于相机环绕走廊外缘约 760 m 环带：越高越显眼，同时不遮挡场区）
  let h = band(760, 200) * (40 + 150 * undulate(3.4, 4242) + 90 * undulate(7.1, 2468) + 70 * undulate(14.3, 3579));
  h += band(780, 200) * (fbm(x / 120, z / 120, 555) - 0.5) * 82;
  h += band(790, 210) * (fbm(x / 46, z / 46, 6633) - 0.5) * 30;
  // 中景山脊（约 1.7 km 环带）
  h += band(1700, 420) * (200 + 420 * undulate(2.2, 8181) + 190 * undulate(5.3, 8642));
  // 远景雪线峰群（约 2.7 km 环带）
  h += band(2700, 900) * (400 + 500 * undulate(1.4, 1234) + 220 * undulate(3.7, 9753));
  // 大尺度起伏（避开相机环绕走廊）
  h += (fbm(x / 420, z / 420, 1337) - 0.45) * 150 * smoothstep(900, 1400, d);
  h += (fbm(x / 1500 + 3.1, z / 1500 - 1.7, 99) - 0.42) * 260 * smoothstep(1500, 2300, d);
  return Math.max(0, h) * flat;
}

// ───────────────────────────── 贴图工具 ─────────────────────────────
const CJK = '"Microsoft YaHei","PingFang SC","Noto Sans SC","Hiragino Sans GB",sans-serif';

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

/** 文字标牌（Canvas 贴图 Sprite），worldHeight 为标牌在世界中的高度（米） */
export function makeLabel(text, { size = 44, color = '#eaf4ff', bg = 'rgba(8,16,26,0.62)', bgStroke = 'rgba(140,200,240,0.35)', worldHeight = 20, maxPx = 1024 } = {}) {
  const font = `600 ${size}px ${CJK}`;
  const measure = document.createElement('canvas').getContext('2d');
  measure.font = font;
  const pad = Math.round(size * 0.42);
  const w = Math.min(maxPx, Math.ceil(measure.measureText(text).width) + pad * 2);
  const h = size + pad * 2;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const c = canvas.getContext('2d');
  c.font = font;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillStyle = bg;
  roundRect(c, 3, 3, w - 6, h - 6, Math.min(18, h * 0.3));
  c.fill();
  c.lineWidth = 3;
  c.strokeStyle = bgStroke;
  c.stroke();
  c.fillStyle = color;
  c.fillText(text, w / 2, h / 2 + size * 0.04);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false }));
  const s = worldHeight / h;
  sprite.scale.set(w * s, h * s, 1);
  sprite.userData.isLabel = true;
  sprite.userData.baseSize = { w: w * s, h: h * s };
  return sprite;
}

/** 标牌按相机距离等比缩放：远看够大、近看不糊屏（只依赖相机位置，不影响确定性） */
export function rescaleLabel(sprite, camera, refDist = 900, minK = 0.12) {
  const base = sprite.userData.baseSize;
  if (!base) return;
  const d = camera.position.distanceTo(sprite.position);
  const k = Math.min(3, Math.max(minK, d / refDist));
  sprite.scale.set(base.w * k, base.h * k, 1);
}

function canvasTexture(w, h, draw) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  draw(canvas.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// ───────────────────────────── 布局工具 ─────────────────────────────
function floorPlane(w, h, color, opacity = 1, y = 0.04) {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshStandardMaterial({ color, roughness: 0.95, metalness: 0, transparent: opacity < 1, opacity }),
  );
  m.rotation.x = -Math.PI / 2;
  m.position.y = y;
  m.receiveShadow = true;
  return m;
}

function stripLine(a, b, width, color, y, opacity = 0.85) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(width, 0.12, len),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }),
  );
  m.position.set((a[0] + b[0]) / 2, y, (a[1] + b[1]) / 2);
  m.rotation.y = Math.atan2(b[0] - a[0], b[1] - a[1]);
  return m;
}

export class World {
  constructor(scene) {
    this.scene = scene;
    this.root = new THREE.Group();
    scene.add(this.root);
    this.field = new THREE.Group();
    this.root.add(this.field);
    this.labels = new THREE.Group();
    this.root.add(this.labels);
    this.terrain = null;
  }

  /** 地形、天空、光照：与策略无关，只建一次 */
  buildBase() {
    const skyTex = canvasTexture(4, 256, (c, w, h) => {
      const g = c.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, SKY_TOP);
      g.addColorStop(0.55, '#8fb2cf');
      g.addColorStop(1, SKY_BOTTOM);
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
    });
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(4300, 32, 16),
      new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, fog: false, depthWrite: false }),
    );
    this.root.add(sky);

    const seg = 300;
    const size = 5600;
    const geo = new THREE.PlaneGeometry(size, size, seg, seg);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    // 高海拔浅色调：盆地浅土黄 → 草甸 → 岩屑坡 → 岩壁 → 雪线
    const cPlain = new THREE.Color('#8d8f66');
    const cDry = new THREE.Color('#b8ad86');
    const cLow = new THREE.Color('#9ea883');
    const cMid = new THREE.Color('#b0b19b');
    const cRock = new THREE.Color('#c2c1b9');
    const cHigh = new THREE.Color('#e2e6e7');
    const cSnow = new THREE.Color('#f6fafc');
    const tmp = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const yLocal = pos.getY(i);
      const h = heightAt(x, -yLocal);
      pos.setZ(i, h);
      const patch = fbm(x / 210, -yLocal / 210, 4242);
      const patch2 = fbm(x / 74 + 11.3, -yLocal / 74 - 5.1, 8181);
      // 高程配色（纵向压缩的概念化配色：低处干草甸，210 m 以上转为浅色岩壁，400 m 以上见雪）
      const t = Math.max(0, h) / 900;
      if (t < 0.014) tmp.copy(cPlain).lerp(cDry, Math.min(1, patch * 2.1));
      else if (t < 0.08) tmp.copy(cDry).lerp(cLow, (t - 0.014) / 0.066);
      else if (t < 0.2) tmp.copy(cLow).lerp(cMid, (t - 0.08) / 0.12);
      else if (t < 0.33) tmp.copy(cMid).lerp(cRock, (t - 0.2) / 0.13);
      else if (t < 0.45) tmp.copy(cRock).lerp(cHigh, (t - 0.33) / 0.12);
      else tmp.copy(cHigh).lerp(cSnow, Math.min(1, (t - 0.45) / 0.17));
      // 轻微风化斑驳
      const n = fbm(x / 38, -yLocal / 38, 777) * 0.6 + patch2 * 0.4;
      const k = 0.82 + n * 0.36;
      colors[i * 3] = tmp.r * k;
      colors[i * 3 + 1] = tmp.g * k;
      colors[i * 3 + 2] = tmp.b * k;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1, metalness: 0 });
    this.terrain = new THREE.Mesh(geo, mat);
    this.terrain.receiveShadow = true;
    this.root.add(this.terrain);

    this.root.add(new THREE.HemisphereLight(0xdfeaf6, 0x6b7057, 0.8));
    const sun = new THREE.DirectionalLight(0xfff2dd, 1.75);
    sun.position.set(520, 760, 430);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const cam = sun.shadow.camera;
    cam.left = -520;
    cam.right = 520;
    cam.top = 520;
    cam.bottom = -520;
    cam.near = 200;
    cam.far = 2000;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.6;
    this.root.add(sun);
    this.sun = sun;
    const fill = new THREE.DirectionalLight(0xa9cbff, 0.45);
    fill.position.set(-600, 380, -420);
    this.root.add(fill);
  }

  /** 按当前策略重建全部场地要素 */
  rebuildField(sim) {
    disposeChildren(this.field);
    disposeChildren(this.labels);
    const scn = sim.scn;
    const L = scn.layout;
    const g = this.field;

    const pads = sim.pads;
    const xs = pads.map((p) => p.x);
    const zs = pads.map((p) => p.z);
    const minX = Math.min(...xs) - 34;
    const maxX = Math.max(...xs) + 34;
    const minZ = Math.min(...zs) - 34;
    const maxZ = Math.max(...zs) + 34;
    const apron = floorPlane(maxX - minX, maxZ - minZ, 0x9aa1a8, 1, 0.05);
    apron.position.set((minX + maxX) / 2, 0.05, (minZ + maxZ) / 2);
    g.add(apron);
    // 停机坪与跑道之间的联络道
    const apronEdgeX = maxX;
    const tie = floorPlane(Math.abs(L.runway.x - apronEdgeX) + 40, 26, 0x8f969d, 1, 0.05);
    tie.position.set((apronEdgeX + L.runway.x) / 2, 0.05, L.runway.z + L.runway.length - 40);
    g.add(tie);

    this._buildPads(pads, scn);
    this._buildRunway(L.runway);
    this._buildCorridors(scn, L);
    this._buildStation(L.station);
    this._buildMissionRing(L.missionRing);
    this._buildLabels(pads, L);
    this._buildChargers(sim);
  }

  _buildPads(pads, scn) {
    const g = this.field;
    const groups = new Map();
    for (const p of pads) {
      const cls = p.cls || 'generic';
      const color = CLASS_COLOR[p.kind] || CLASS_COLOR[cls] || CLASS_COLOR.generic;
      const r = p.kind === 'micro' ? 3.6 : p.kind === 'heavy' ? 6.4 : p.kind === 'cargo' ? 8.5 : 4.6;
      const base = new THREE.Mesh(
        new THREE.CylinderGeometry(r, r * 1.06, 0.7, p.kind === 'cargo' ? 6 : 18),
        new THREE.MeshStandardMaterial({ color: 0xd7dde2, roughness: 0.9 }),
      );
      base.position.set(p.x, 0.35, p.z);
      base.castShadow = true;
      base.receiveShadow = true;
      g.add(base);

      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(r * 0.86, p.kind === 'micro' ? 0.28 : 0.42, 8, 40),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(p.x, 0.74, p.z);
      g.add(ring);

      const dot = new THREE.Mesh(
        new THREE.CircleGeometry(r * 0.26, 18),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55 }),
      );
      dot.rotation.x = -Math.PI / 2;
      dot.position.set(p.x, 0.72, p.z);
      g.add(dot);

      const key = p.kind;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }

    // 停机区配套建筑（机库 / 充换电站），提升场地可信度
    for (const [kind, list] of groups) {
      const cx = list.reduce((a, p) => a + p.x, 0) / list.length;
      const cz = list.reduce((a, p) => a + p.z, 0) / list.length;
      const hangar = new THREE.Mesh(
        new THREE.BoxGeometry(kind === 'micro' ? 26 : 34, 7, 16),
        new THREE.MeshStandardMaterial({ color: 0xe4e9ee, roughness: 0.75, metalness: 0.1 }),
      );
      hangar.position.set(cx, 3.5, cz + (kind === 'cargo' ? -26 : 22));
      hangar.castShadow = true;
      hangar.receiveShadow = true;
      this.field.add(hangar);
      const roof = new THREE.Mesh(
        new THREE.BoxGeometry(kind === 'micro' ? 27 : 35, 0.6, 17),
        new THREE.MeshBasicMaterial({ color: kind === 'micro' ? 0x6fe3ff : kind === 'heavy' ? 0xffc46b : 0xff8a8a, transparent: true, opacity: 0.5 }),
      );
      roof.position.set(hangar.position.x, 7.3, hangar.position.z);
      this.field.add(roof);
      for (let i = 0; i < 3; i++) {
        const box = new THREE.Mesh(
          new THREE.BoxGeometry(3.2, 2.6, 7),
          new THREE.MeshStandardMaterial({ color: 0xc8cdd3, roughness: 0.85 }),
        );
        box.position.set(hangar.position.x - 18 - i * 5, 1.3, hangar.position.z - 12);
        box.castShadow = true;
        this.field.add(box);
      }
    }
  }

  _buildRunway(rw) {
    const g = this.field;
    const W = rw.width;
    const LEN = rw.length;
    const tex = canvasTexture(256, 2048, (c, w, h) => {
      const px = (m) => (m / W) * w;          // 横向像素
      const py = (m) => (m / LEN) * h;        // 纵向像素
      c.fillStyle = '#41474d';
      c.fillRect(0, 0, w, h);
      c.fillStyle = 'rgba(255,255,255,0.05)';
      for (let i = 0; i < 40; i++) c.fillRect(0, py((i * 37) % LEN), w, 2);
      c.fillStyle = '#e9edf0';
      // 两侧边线
      c.fillRect(px(1.6), 0, px(0.8), h);
      c.fillRect(px(W - 2.4), 0, px(0.8), h);
      // 中线虚线
      const dash = py(24);
      for (let y = py(46); y < h - py(46); y += dash * 2) c.fillRect(w / 2 - px(0.55), y, px(1.1), dash);
      // 两端斑马线（跑道入口标志）
      for (let i = 0; i < 6; i++) {
        const bx = px(3.4 + i * 5);
        c.fillRect(bx, py(10), px(2.6), py(24));
        c.fillRect(bx, h - py(34), px(2.6), py(24));
      }
      c.save();
      c.translate(w * 0.3, py(88));
      c.font = `700 ${px(9)}px ${CJK}`;
      c.fillStyle = '#eef2f5';
      c.textAlign = 'center';
      c.fillText('36', 0, 0);
      c.translate(w * 0.4, h - py(176));
      c.fillText('18', 0, 0);
      c.restore();
    });
    const rwMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(W, LEN),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92, metalness: 0 }),
    );
    rwMesh.rotation.x = -Math.PI / 2;
    rwMesh.position.set(rw.x, 0.07, rw.z + LEN / 2);
    rwMesh.receiveShadow = true;
    g.add(rwMesh);

    // 跑道灯光：边灯（白）+ 两端入口灯（绿/红）
    const lamp = new THREE.SphereGeometry(0.55, 8, 6);
    const edgeCount = 2 * (Math.floor(LEN / 26) + 1);
    const edge = new THREE.InstancedMesh(lamp, new THREE.MeshBasicMaterial({ color: 0xfff6d0 }), edgeCount);
    const m4 = new THREE.Matrix4();
    let i = 0;
    for (let s = 0; s <= Math.floor(LEN / 26); s++) {
      const z = rw.z + s * 26;
      m4.makeTranslation(rw.x - W / 2 - 1.2, 0.9, z);
      edge.setMatrixAt(i++, m4);
      m4.makeTranslation(rw.x + W / 2 + 1.2, 0.9, z);
      edge.setMatrixAt(i++, m4);
    }
    edge.instanceMatrix.needsUpdate = true;
    g.add(edge);

    const thresh = new THREE.InstancedMesh(lamp, new THREE.MeshBasicMaterial({ color: 0x7dff9b }), 12);
    const thresh2 = new THREE.InstancedMesh(lamp, new THREE.MeshBasicMaterial({ color: 0xff6b6b }), 12);
    for (let k = 0; k < 6; k++) {
      m4.makeTranslation(rw.x - W / 2 + 2 + k * (W - 4) / 5, 0.9, rw.z - 2);
      thresh.setMatrixAt(k, m4);
      m4.makeTranslation(rw.x - W / 2 + 2 + k * (W - 4) / 5, 0.9, rw.z + LEN + 2);
      thresh2.setMatrixAt(k, m4);
    }
    thresh.instanceMatrix.needsUpdate = true;
    thresh2.instanceMatrix.needsUpdate = true;
    g.add(thresh, thresh2);

    // 进近灯排
    for (let k = 1; k <= 6; k++) {
      for (const zc of [rw.z - k * 24, rw.z + LEN + k * 24]) {
        const l = new THREE.Mesh(lamp, new THREE.MeshBasicMaterial({ color: k <= 3 ? 0xfff2c0 : 0xffc06a }));
        l.position.set(rw.x, 0.9, zc);
        g.add(l);
      }
    }
  }

  _buildCorridors(scn, L) {
    const g = this.field;
    const byId = new Map();
    for (const list of Object.values(L.corridors)) for (const c of list) byId.set(c.id, c);
    for (const ch of scn.channels) {
      if (ch.kind === 'runway') continue; // 跑道即货运通道，不再叠加色带
      const c = byId.get(ch.id);
      if (!c) continue;
      const color = CLASS_COLOR[ch.owner] || CLASS_COLOR.generic;
      const a = c.from;
      const b = c.to;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const width = ch.owner === 'heavy' ? 13 : ch.owner === 'any' ? 11 : 8;
      const ribbon = new THREE.Mesh(
        new THREE.PlaneGeometry(len, width),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.17, depthWrite: false, side: THREE.DoubleSide }),
      );
      ribbon.rotation.x = -Math.PI / 2;
      ribbon.rotation.z = -Math.atan2(b[1] - a[1], b[0] - a[0]);
      ribbon.position.set((a[0] + b[0]) / 2, 0.55, (a[1] + b[1]) / 2);
      g.add(ribbon);
      const off = width / 2 - 0.6;
      const nx = -Math.sin(Math.atan2(b[1] - a[1], b[0] - a[0]));
      const nz = Math.cos(Math.atan2(b[1] - a[1], b[0] - a[0]));
      g.add(stripLine([a[0] + nx * off, a[1] + nz * off], [b[0] + nx * off, b[1] + nz * off], 0.5, color, 0.62, 0.6));
      g.add(stripLine([a[0] - nx * off, a[1] - nz * off], [b[0] - nx * off, b[1] - nz * off], 0.5, color, 0.62, 0.6));
      // 通道方向指示（沿通道每 40 m 一个箭头）
      const n = Math.floor(len / 40);
      const dir = Math.atan2(b[0] - a[0], b[1] - a[1]);
      for (let i = 1; i <= n; i++) {
        const u = i / (n + 1);
        const arrow = new THREE.Mesh(
          new THREE.ConeGeometry(1.7, 4.6, 3),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7 }),
        );
        // 圆锥默认指向 +Y，绕 X 转 +90° 后指向 +Z，再绕 Y 转到通道方向
        arrow.rotation.set(Math.PI / 2, dir, 0, 'YXZ');
        arrow.position.set(a[0] + (b[0] - a[0]) * u, 1.1, a[1] + (b[1] - a[1]) * u);
        g.add(arrow);
      }
    }
  }

  /** 无人机运行服务站（视觉地标：塔状建筑 + 天线），严格不使用"塔台"字样 */
  _buildStation(st) {
    const g = this.field;
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(13, 15, 9, 24),
      new THREE.MeshStandardMaterial({ color: 0xdfe5ea, roughness: 0.7, metalness: 0.15 }),
    );
    base.position.set(st.x, 4.5, st.z);
    base.castShadow = true;
    base.receiveShadow = true;
    g.add(base);

    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(6.4, 8.6, 26, 24),
      new THREE.MeshStandardMaterial({ color: 0xeef2f6, roughness: 0.6, metalness: 0.2 }),
    );
    shaft.position.set(st.x, 22, st.z);
    shaft.castShadow = true;
    g.add(shaft);

    const glass = new THREE.Mesh(
      new THREE.CylinderGeometry(7.4, 7.4, 7.5, 24),
      new THREE.MeshStandardMaterial({ color: 0x1b3b52, emissive: 0x2b6f96, emissiveIntensity: 0.85, roughness: 0.3, metalness: 0.4 }),
    );
    glass.position.set(st.x, 30, st.z);
    g.add(glass);

    const cap = new THREE.Mesh(
      new THREE.CylinderGeometry(8.6, 7.2, 2.4, 24),
      new THREE.MeshStandardMaterial({ color: 0xf4f7fa, roughness: 0.6 }),
    );
    cap.position.set(st.x, 35, st.z);
    cap.castShadow = true;
    g.add(cap);

    // 屋顶停机坪 + 天线
    const roofPad = new THREE.Mesh(
      new THREE.CylinderGeometry(6.4, 6.4, 0.5, 24),
      new THREE.MeshStandardMaterial({ color: 0x9fb0bd, roughness: 0.85 }),
    );
    roofPad.position.set(st.x, 36.4, st.z);
    g.add(roofPad);
    const roofRing = new THREE.Mesh(
      new THREE.TorusGeometry(5.4, 0.3, 8, 32),
      new THREE.MeshBasicMaterial({ color: CLASS_COLOR.micro }),
    );
    roofRing.rotation.x = -Math.PI / 2;
    roofRing.position.set(st.x, 36.8, st.z);
    g.add(roofRing);

    const mast = new THREE.Mesh(
      new THREE.CylinderGeometry(0.35, 0.5, 22, 8),
      new THREE.MeshStandardMaterial({ color: 0xc9d2da, metalness: 0.5, roughness: 0.5 }),
    );
    mast.position.set(st.x + 13, 46, st.z + 9);
    g.add(mast);
    const beacon = new THREE.Mesh(
      new THREE.SphereGeometry(1.5, 12, 10),
      new THREE.MeshBasicMaterial({ color: 0xff5a4d }),
    );
    beacon.position.set(st.x + 13, 57.5, st.z + 9);
    beacon.userData.beacon = true;
    g.add(beacon);

    const dishPivot = new THREE.Group();
    dishPivot.position.set(st.x, 40, st.z);
    dishPivot.userData.dish = true;
    const dish = new THREE.Mesh(
      new THREE.SphereGeometry(3.4, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2.6),
      new THREE.MeshStandardMaterial({ color: 0xf0f4f7, side: THREE.DoubleSide, roughness: 0.6 }),
    );
    dish.rotation.z = Math.PI;
    dishPivot.add(dish);
    g.add(dishPivot);
  }

  _buildMissionRing(ring) {
    const g = this.field;
    const y0 = heightAt(ring.x, ring.z) + 1;
    const grp = new THREE.Group();
    grp.position.set(ring.x, y0, ring.z);
    const disc = new THREE.Mesh(
      new THREE.RingGeometry(ring.radius - 3, ring.radius, 96, 1),
      new THREE.MeshBasicMaterial({ color: CLASS_COLOR.micro, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false }),
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = 0.6;
    grp.add(disc);
    const halo = new THREE.Mesh(
      new THREE.TorusGeometry(ring.radius, 1.6, 8, 96),
      new THREE.MeshBasicMaterial({ color: CLASS_COLOR.micro, transparent: true, opacity: 0.3, depthWrite: false }),
    );
    halo.rotation.x = -Math.PI / 2;
    halo.position.y = 46;
    grp.add(halo);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const pylon = new THREE.Mesh(
        new THREE.CylinderGeometry(0.5, 0.9, 46, 6),
        new THREE.MeshStandardMaterial({ color: 0xbfcbd6, roughness: 0.8 }),
      );
      pylon.position.set(Math.cos(a) * ring.radius, 23, Math.sin(a) * ring.radius);
      pylon.castShadow = true;
      grp.add(pylon);
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(1.4, 10, 8), new THREE.MeshBasicMaterial({ color: 0x9df3ff }));
      lamp.position.set(Math.cos(a) * ring.radius, 47.5, Math.sin(a) * ring.radius);
      grp.add(lamp);
    }
    g.add(grp);
    const label = makeLabel('远端任务区 · 环形航路点', { size: 42, worldHeight: 40 });
    label.position.set(ring.x, y0 + 92, ring.z);
    this.labels.add(label);
  }

  _buildLabels(pads, L) {
    const nameByKind = { micro: '微坪停机区', heavy: '重坪停机区', cargo: '货运坪', generic: '通用停机坪' };    const groups = new Map();
    for (const p of pads) {
      if (!groups.has(p.kind)) groups.set(p.kind, []);
      groups.get(p.kind).push(p);
    }
    for (const [kind, list] of groups) {
      const cx = list.reduce((a, p) => a + p.x, 0) / list.length;
      const cz = list.reduce((a, p) => a + p.z, 0) / list.length;
      const label = makeLabel(`${nameByKind[kind] || kind} ${list.length} 位`, {
        size: 40,
        worldHeight: 22,
        color: CLASS_COLOR[kind] || CLASS_COLOR.generic,
      });
      label.position.set(cx, 32, cz);
      this.labels.add(label);
    }
    const rwLabel = makeLabel('货运跑道 420 m', { size: 40, worldHeight: 24, color: CLASS_COLOR.cargo });
    rwLabel.position.set(L.runway.x, 34, L.runway.z + L.runway.length * 0.88);
    this.labels.add(rwLabel);

    const stLabel = makeLabel('无人机运行服务站', { size: 48, worldHeight: 30, color: '#dff4ff' });
    stLabel.position.set(L.station.x, 70, L.station.z);
    this.labels.add(stLabel);
  }

  /** 充电设施可视化：停机坪南缘一排充电桩/换电台，充电时顶部亮灯（灯色随模式） */
  _buildChargers(sim) {
    this.chargers = null;
    if (!sim.chargingCfg?.enabled) return;
    const cfg = sim.chargingCfg;
    const n = Math.max(1, cfg.chargers_n);
    const g = this.field;
    const pads = sim.pads;
    const xs = pads.map((p) => p.x);
    const zs = pads.map((p) => p.z);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const maxZ = Math.max(...zs);
    const rowZ = maxZ + 26;
    const span = Math.max(40, maxX - minX);
    const step = span / Math.max(1, n - 1);
    const lampOn = cfg.mode === 'slow' ? 0x7dff9b : cfg.mode === 'swap' ? 0xffc46b : 0x57d7ff;
    const byIdx = [];
    for (let i = 0; i < n; i++) {
      const x = minX + i * step;
      const post = new THREE.Mesh(
        new THREE.CylinderGeometry(0.7, 0.9, 3.0, 10),
        new THREE.MeshStandardMaterial({ color: 0x33404d, roughness: 0.6, metalness: 0.3 }),
      );
      post.position.set(x, 1.5, rowZ);
      post.castShadow = true;
      g.add(post);
      const head = new THREE.Mesh(
        new THREE.BoxGeometry(1.5, 0.5, 0.9),
        new THREE.MeshStandardMaterial({ color: 0x8fa8bd, roughness: 0.5 }),
      );
      head.position.set(x, 3.1, rowZ);
      g.add(head);
      const lamp = new THREE.Mesh(
        new THREE.SphereGeometry(0.55, 10, 8),
        new THREE.MeshBasicMaterial({ color: 0x22303a }),
      );
      lamp.position.set(x, 3.6, rowZ);
      g.add(lamp);
      byIdx.push({ lamp, lampOn, events: [] });
    }
    // 每个桩的忙闲区间（来自引擎 chargeEvents，按开始时刻排序）
    for (const e of sim.chargeEvents) {
      const holder = byIdx[e.idx];
      if (holder) holder.events.push([e.t, e.t + e.duration_s]);
    }
    for (const holder of byIdx) holder.events.sort((a, b) => a[0] - b[0]);
    this.chargers = byIdx;
  }

  setLabelsVisible(on) {
    this.labels.visible = on;
  }

  /** 服务站天线与雷达随时间转动（仅与仿真时刻 t 有关，保证确定性） */
  update(t, camera) {
    for (const obj of this.field.children) {
      if (obj.userData.dish) obj.rotation.y = -t * 0.25;
      if (obj.userData.beacon) {
        const on = (t % 2) < 1.2;
        obj.material.color.set(on ? 0xff5a4d : 0x552222);
      }
    }
    // 充电桩指示灯：正在充电的桩亮灯
    if (this.chargers) {
      for (const holder of this.chargers) {
        let on = false;
        for (const [a, b] of holder.events) {
          if (t >= a && t <= b) { on = true; break; }
          if (t < a) break;
        }
        holder.lamp.material.color.set(on ? holder.lampOn : 0x22303a);
      }
    }
    if (camera) for (const label of this.labels.children) rescaleLabel(label, camera);
  }
}

export function disposeChildren(group) {
  for (let i = group.children.length - 1; i >= 0; i--) {
    const child = group.children[i];
    group.remove(child);
    child.traverse?.((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if (m.map) m.map.dispose();
          m.dispose();
        }
      }
    });
  }
}
