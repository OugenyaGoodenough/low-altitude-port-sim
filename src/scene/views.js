/**
 * 相机视角机：环绕 / 俯视 / 无人机运行服务站视角 / 跟随选中无人机。
 * 说明：pol 为相机相对注视点的仰角（0 = 与注视点等高，π/2 = 正俯视）。
 * 相机位置只是 (仿真时刻 t, 用户鼠标偏移) 的函数，不含阻尼与累积状态，
 * 因此 renderAt(t) 可以稳定复现同一画面。
 */
const VIEWS = ['orbit', 'top', 'station', 'follow'];

const FOLLOW_DIST = { micro: 62, heavy: 110, cargo: 200 };
/**
 * 构图偏移：左右两块面板各占屏宽约 21%，可用可视区中心比画面中心略低。
 * 把相机整体抬头约 1.5°，场景内容在画面中下移约 3.5% 高度，
 * 主体正好落在两侧面板之间的可视区中央，同时让画面顶部多露出一线山体。
 */
const COMPOSE_PITCH = 0.026;

export class ViewRig {
  constructor(camera, dom) {
    this.camera = camera;
    this.dom = dom;
    this.view = 'orbit';
    this.followId = null;
    this.userAz = 0;
    this.userPol = 0;
    this.userDist = 1;
    this.center = { x: 0, y: 0, z: 20 };
    this._target = { x: 0, y: 0, z: 0 };
    this._scratch = {};
    this._dragging = false;
    this._px = 0;
    this._py = 0;
    this._bind();
  }

  _bind() {
    const dom = this.dom;
    dom.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this._dragging = true;
      this._px = e.clientX;
      this._py = e.clientY;
      dom.setPointerCapture?.(e.pointerId);
    });
    dom.addEventListener('pointermove', (e) => {
      if (!this._dragging) return;
      const dx = e.clientX - this._px;
      const dy = e.clientY - this._py;
      this._px = e.clientX;
      this._py = e.clientY;
      this.userAz -= dx * 0.005;
      this.userPol = clamp(this.userPol + dy * 0.004, -0.55, 0.9);
    });
    const stop = (e) => {
      this._dragging = false;
      dom.releasePointerCapture?.(e.pointerId);
    };
    dom.addEventListener('pointerup', stop);
    dom.addEventListener('pointercancel', stop);
    dom.addEventListener(
      'wheel',
      (e) => {
        this.userDist = clamp(this.userDist * (1 + Math.sign(e.deltaY) * 0.08), 0.3, 3.2);
      },
      { passive: true },
    );
    dom.addEventListener('dblclick', () => this.resetOffsets());
  }

  resetOffsets() {
    this.userAz = 0;
    this.userPol = 0;
    this.userDist = 1;
  }

  setView(name) {
    if (!VIEWS.includes(name)) return false;
    this.view = name;
    this.resetOffsets();
    return true;
  }

  followAircraft(id) {
    this.followId = id;
    this.view = 'follow';
    this.resetOffsets();
  }

  /** 设置场区中心（环绕/俯视的注视点） */
  setCenter(x, z) {
    this.center.x = x;
    this.center.z = z;
  }

  update(t, replay, fleet) {
    const cam = this.camera;
    const c = this.center;
    const target = this._target;
    let dist;
    let az;
    let pol;

    if (this.view === 'top') {
      dist = 1500 * this.userDist;
      az = 0.35 + this.userAz;
      pol = clamp(1.45 + this.userPol * 0.5, 0.9, 1.52);
      target.x = c.x;
      target.y = 0;
      target.z = c.z;
    } else if (this.view === 'station') {
      const st = replay.station;
      // 站在服务站观景层，缓慢扫视停机坪与跑道（远端任务环位于服务站身后，不在该视角画面内）
      const k = 0.5 + 0.5 * Math.sin(t * 0.05);
      cam.position.set(st.x + 24, 52 + this.userPol * 40, st.z + 16);
      target.x = -140 + 170 * k;
      target.y = 4;
      target.z = 60 - 60 * k;
      cam.lookAt(target.x, target.y, target.z);
      cam.rotateX(COMPOSE_PITCH);
      return;
    } else if (this.view === 'follow' && this.followId) {
      const p = replay.poseAt(this.followId, t, this._scratch);
      const cls = this.followId.startsWith('M') ? 'micro' : this.followId.startsWith('H') ? 'heavy' : 'cargo';
      const d = (FOLLOW_DIST[cls] || 120) * this.userDist;
      az = p.yaw + Math.PI + 0.45 + this.userAz;
      pol = clamp(0.42 + this.userPol, 0.06, 1.3);
      target.x = p.x;
      target.y = p.y + 1;
      target.z = p.z;
      cam.position.set(
        p.x + Math.sin(az) * Math.cos(pol) * d,
        p.y + Math.sin(pol) * d + 8,
        p.z + Math.cos(az) * Math.cos(pol) * d,
      );
      cam.lookAt(target.x, target.y, target.z);
      cam.rotateX(COMPOSE_PITCH);
      return;
    } else {
      dist = 950 * this.userDist;
      az = 0.62 + t * 0.028 + this.userAz;
      // 仰角 26°：场区占画面中下部约 60%，上方约 30% 留给盆地外缘的连绵山体
      pol = clamp(0.44 + this.userPol, 0.08, 1.5);
      target.x = c.x;
      target.y = 8;
      target.z = c.z;
    }

    const cosP = Math.cos(pol);
    cam.position.set(
      target.x + Math.sin(az) * cosP * dist,
      target.y + Math.sin(pol) * dist,
      target.z + Math.cos(az) * cosP * dist,
    );
    cam.lookAt(target.x, target.y, target.z);
    cam.rotateX(COMPOSE_PITCH);
  }
}

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}
