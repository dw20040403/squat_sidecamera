// 3D骨格の描画（Three.js）。床のグリッド、2台のカメラの位置、視点のプリセット（spec 5.7.1 ④）
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { BONES, jointSide } from '../fusion/landmarks';
import { cameraCenter, cameraForward, type Extrinsics } from '../fusion/camera';
import type { Vec3 } from '../fusion/math';
import { bodyFrame } from '../metrics/angles';
import { SIDE_HEX } from './colors';

const DRAW_JOINTS = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32];

export class View3D {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private spheres = new Map<number, THREE.Mesh>();
  private bones: { line: THREE.Line; a: number; b: number }[] = [];
  private camGroup = new THREE.Group();
  private lastJoints: (Vec3 | null)[] = [];
  private raf = 0;
  private dirty = true;
  private resizeObs: ResizeObserver;

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x0b0f17);
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.touchAction = 'none';

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.05, 50);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    this.controls.addEventListener('change', () => (this.dirty = true));

    // 床（Z=0）のグリッド。GridHelperはXZ平面なのでXY平面に回す
    const grid = new THREE.GridHelper(4, 16, 0x4b5563, 0x1f2937);
    grid.rotation.x = Math.PI / 2;
    this.scene.add(grid);
    const axes = new THREE.AxesHelper(0.3);
    this.scene.add(axes);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.9));
    this.scene.add(this.camGroup);

    const sphereGeo = new THREE.SphereGeometry(0.025, 12, 8);
    for (const j of DRAW_JOINTS) {
      const m = new THREE.Mesh(
        sphereGeo,
        new THREE.MeshBasicMaterial({ color: SIDE_HEX[jointSide(j)], transparent: true }),
      );
      m.visible = false;
      this.spheres.set(j, m);
      this.scene.add(m);
    }
    for (const b of BONES) {
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
      const line = new THREE.Line(
        g,
        new THREE.LineBasicMaterial({ color: SIDE_HEX[b.side], transparent: true }),
      );
      line.visible = false;
      this.bones.push({ line, a: b.a, b: b.b });
      this.scene.add(line);
    }
    this.preset('reset');
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(container);
    this.resize();
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.controls.update();
      if (this.dirty) {
        this.renderer.render(this.scene, this.camera);
        this.dirty = false;
      }
    };
    loop();
  }

  resize(): void {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  /** カメラの位置のアイコン（四角錐） */
  setCameras(cams: { label: string; extr: Extrinsics | null; color: number }[]): void {
    this.camGroup.clear();
    for (const c of cams) {
      if (!c.extr) continue;
      const C = cameraCenter(c.extr);
      const f = cameraForward(c.extr);
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(0.08, 0.16, 4),
        new THREE.MeshBasicMaterial({ color: c.color, wireframe: true }),
      );
      cone.position.set(C[0], C[1], C[2]);
      // 円錐の軸（+Y）を光軸の逆向きに合わせる（底面がカメラの前）
      cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(-f[0], -f[1], -f[2]));
      this.camGroup.add(cone);
      const ray = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(C[0], C[1], C[2]),
        new THREE.Vector3(C[0] + f[0] * 0.6, C[1] + f[1] * 0.6, C[2] + f[2] * 0.6),
      ]);
      this.camGroup.add(new THREE.Line(ray, new THREE.LineBasicMaterial({ color: c.color })));
    }
    this.dirty = true;
  }

  /** 3D骨格を更新する（MediaPipeの番号で引ける33点）。fresh=falseの関節は半透明 */
  setJoints(J: (Vec3 | null)[], fresh?: boolean[]): void {
    this.lastJoints = J;
    for (const [j, m] of this.spheres) {
      const p = J[j];
      m.visible = !!p;
      if (p) m.position.set(p[0], p[1], p[2]);
      (m.material as THREE.MeshBasicMaterial).opacity = fresh && !fresh[j] ? 0.35 : 1;
    }
    for (const b of this.bones) {
      const pa = J[b.a];
      const pb = J[b.b];
      b.line.visible = !!pa && !!pb;
      if (pa && pb) {
        const pos = b.line.geometry.getAttribute('position') as THREE.BufferAttribute;
        pos.setXYZ(0, pa[0], pa[1], pa[2]);
        pos.setXYZ(1, pb[0], pb[1], pb[2]);
        pos.needsUpdate = true;
        b.line.geometry.computeBoundingSphere();
        (b.line.material as THREE.LineBasicMaterial).opacity =
          fresh && (!fresh[b.a] || !fresh[b.b]) ? 0.35 : 1;
      }
    }
    this.dirty = true;
  }

  /** 視点のプリセット。「正面」「側面」は体の向き（y_b）に合わせる */
  preset(p: 'front' | 'side' | 'top' | 'reset'): void {
    const bf = bodyFrame(this.lastJoints);
    const yb = bf ? bf.yb : ([0, 1, 0] as Vec3);
    const xb = bf ? bf.xb : ([1, 0, 0] as Vec3);
    const target = new THREE.Vector3(0, 0, 0.9);
    const hipL = this.lastJoints[23];
    const hipR = this.lastJoints[24];
    if (hipL && hipR) target.set((hipL[0] + hipR[0]) / 2, (hipL[1] + hipR[1]) / 2, 0.9);
    const d = 3.2;
    let pos: THREE.Vector3;
    if (p === 'front') pos = new THREE.Vector3(target.x + yb[0] * d, target.y + yb[1] * d, 1.0);
    else if (p === 'side') pos = new THREE.Vector3(target.x + xb[0] * d, target.y + xb[1] * d, 1.0);
    else if (p === 'top')
      pos = new THREE.Vector3(target.x + yb[0] * 0.01, target.y + yb[1] * 0.01, target.z + d + 0.5);
    else
      pos = new THREE.Vector3(
        target.x + (yb[0] + xb[0]) * d * 0.7,
        target.y + (yb[1] + xb[1]) * d * 0.7,
        1.6,
      );
    this.camera.position.copy(pos);
    this.controls.target.copy(target);
    this.controls.update();
    this.dirty = true;
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.resizeObs.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
