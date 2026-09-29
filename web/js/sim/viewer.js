// 3D view of the simulated cut: the stock (as voxels) on the rotating, translating
// platform, the fixed hot wire, and the wire's path traced in the stock's frame.
//
// World frame: Z up, wire along X at world Y = 0. The platform center sits at
// world Y = -bedY and rotates by the platform angle, so the wire is at offset +bedY
// from the center, matching the simulator's convention.

import {
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  Float32BufferAttribute,
  GridHelper,
  Group,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshLambertMaterial,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
  OrbitControls,
} from '../../vendor/three.js';
import { MM_PER_DEG } from '../machine.js';

const FOAM = 0xf2e3c6;
const WIRE = 0xff5a36;

export class SimViewer {
  constructor(container) {
    this.container = container;
    this.renderer = new WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    this.scene = new Scene();
    this.scene.background = new Color(0x15171b);
    this.scene.add(new AmbientLight(0xffffff, 0.55));
    const sun = new DirectionalLight(0xffffff, 1.6);
    sun.position.set(1, -1.5, 2.5);
    this.scene.add(sun);
    const fill = new DirectionalLight(0xffffff, 0.5);
    fill.position.set(-2, 1, 1);
    this.scene.add(fill);

    this.camera = new PerspectiveCamera(40, 1, 1, 10000);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false;
    this.controls.addEventListener('change', () => this.requestRender());

    // Platform group: translates with the bed and rotates with A - Y
    this.platform = new Group();
    this.scene.add(this.platform);
    this.stockMesh = new Mesh(new BufferGeometry(), new MeshLambertMaterial({ color: FOAM }));
    this.platform.add(this.stockMesh);

    this.pathAll = new Line(new BufferGeometry(), new LineBasicMaterial({ color: 0x4b5563 }));
    this.pathDone = new Line(new BufferGeometry(), new LineBasicMaterial({ color: 0x60a5fa }));
    this.platform.add(this.pathAll, this.pathDone);

    this.wire = new Mesh(
      new CylinderGeometry(0.6, 0.6, 1, 8),
      new MeshLambertMaterial({ color: WIRE, emissive: WIRE, emissiveIntensity: 0.6 }),
    );
    this.wire.rotation.z = Math.PI / 2;  // cylinder axis Y -> X
    this.scene.add(this.wire);

    this.program = null;
    this.meshKey = -1;
    this.renderPending = false;

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
  }

  /** @param {{ moves, grid, removedAt }} program */
  setProgram(program) {
    this.program = program;
    this.meshKey = -1;
    const { grid, moves, removedAt } = program;

    // removalsBefore[t] = number of moves before t that removed material, so scrubbing
    // across moves that only reposition the wire can skip the mesh rebuild
    const removes = new Uint8Array(moves.length);
    for (const r of removedAt) if (r < moves.length) removes[r] = 1;
    this.removalsBefore = new Int32Array(moves.length + 1);
    for (let i = 0; i < moves.length; i++) this.removalsBefore[i + 1] = this.removalsBefore[i] + removes[i];
    const { w, d, h } = grid;
    const reach = Math.hypot(w, d) / 2;

    // Bed disc + reference grid under the stock
    if (this.bed) this.platform.remove(this.bed);
    this.bed = new Mesh(
      new CylinderGeometry(reach * 1.08, reach * 1.08, 2, 64),
      new MeshLambertMaterial({ color: 0x374151 }),
    );
    this.bed.rotation.x = Math.PI / 2;  // cylinder axis Y -> Z
    this.bed.position.z = -1;
    this.platform.add(this.bed);

    if (this.floor) this.scene.remove(this.floor);
    this.floor = new GridHelper(reach * 5, 20, 0x2d333b, 0x22262c);
    this.floor.rotation.x = Math.PI / 2;
    this.floor.position.z = -2.2;
    this.scene.add(this.floor);

    // Wire spans past the stock at any rotation
    this.wire.scale.set(1, reach * 2.6, 1);

    // Path of the wire's closest point to the rotation axis, in the platform frame
    const pts = [];
    const pushPt = (p) => {
      const rad = ((p.A - p.Y) / MM_PER_DEG) * (Math.PI / 180);
      pts.push(p.Y * Math.sin(rad), p.Y * Math.cos(rad), p.Z);
    };
    if (moves.length) pushPt(moves[0].from);
    for (const m of moves) pushPt(m.to);
    const positions = new Float32BufferAttribute(pts, 3);
    for (const line of [this.pathAll, this.pathDone]) {
      line.geometry.dispose();
      line.geometry = new BufferGeometry();
      line.geometry.setAttribute('position', positions);
    }

    this.fitView();
    this.setTime(0);
  }

  fitView() {
    if (!this.program) return;
    const { w, d, h } = this.program.grid;
    const size = Math.max(w, d, h);
    this.camera.near = size / 100;
    this.camera.far = size * 50;
    this.camera.position.set(size * 1.3, -size * 1.9, size * 1.4);
    this.controls.target.set(0, 0, h / 2);
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.requestRender();
  }

  /** @param {number} t fractional move index in [0, moves.length] */
  setTime(t) {
    if (!this.program) return;
    const { moves } = this.program;
    const n = moves.length;
    t = Math.max(0, Math.min(n, t));
    const i = Math.min(Math.floor(t), Math.max(0, n - 1));
    const f = n ? Math.min(1, t - i) : 0;

    // Wire/platform pose interpolated within the current move
    const pos = n ? lerpPos(moves[i].from, moves[i].to, f) : { X: 0, Y: 0, Z: 0, A: 0 };
    const theta = ((pos.A - pos.Y) / MM_PER_DEG) * (Math.PI / 180);
    this.platform.position.y = -pos.Y;
    this.platform.rotation.z = theta;
    this.wire.position.set(0, 0, pos.Z);
    this.pathDone.geometry.setDrawRange(0, n ? i + 2 : 0);

    // Voxels removed by moves before the current one are gone
    const key = this.removalsBefore[Math.floor(t)];
    if (key !== this.meshKey) {
      this.meshKey = key;
      this.stockMesh.geometry.dispose();
      this.stockMesh.geometry = buildStockGeometry(this.program.grid, this.program.removedAt, Math.floor(t));
    }
    this.requestRender();
    return pos;
  }

  resize() {
    const { clientWidth: width, clientHeight: height } = this.container;
    if (!width || !height) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  requestRender() {
    if (this.renderPending) return;
    this.renderPending = true;
    requestAnimationFrame(() => {
      this.renderPending = false;
      this.renderer.render(this.scene, this.camera);
    });
  }
}

function lerpPos(a, b, f) {
  return {
    X: a.X + (b.X - a.X) * f,
    Y: a.Y + (b.Y - a.Y) * f,
    Z: a.Z + (b.Z - a.Z) * f,
    A: a.A + (b.A - a.A) * f,
  };
}

// Emit two triangles for every voxel face that borders empty space. Voxel (i, j, k)
// spans u in [-w/2 + i*cs, -w/2 + (i+1)*cs], v likewise, z in [k*cs, (k+1)*cs].
function buildStockGeometry(grid, removedAt, t) {
  const { w, d, nu, nv, nz, cs } = grid;
  const alive = new Uint8Array(nu * nv * nz);
  for (let v = 0; v < alive.length; v++) alive[v] = removedAt[v] >= t ? 1 : 0;
  const at = (i, j, k) =>
    i >= 0 && i < nu && j >= 0 && j < nv && k >= 0 && k < nz && alive[(i * nv + j) * nz + k] === 1;

  const u0 = -w / 2;
  const v0 = -d / 2;
  const out = new FaceBuffer();

  // Per face: neighbor offset, normal, 4 corner offsets (counter-clockwise from outside)
  const FACES = [
    [1, 0, 0, /* normal */ 1, 0, 0, /* corners */ 1, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1],
    [-1, 0, 0, -1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1],
    [0, 1, 0, 0, 1, 0, 1, 1, 0, 0, 1, 0, 0, 1, 1, 1, 1, 1],
    [0, -1, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1],
    [0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1],
    [0, 0, -1, 0, 0, -1, 0, 1, 0, 1, 1, 0, 1, 0, 0, 0, 0, 0],
  ];
  const TRI = [0, 1, 2, 0, 2, 3];

  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      for (let k = 0; k < nz; k++) {
        if (!alive[(i * nv + j) * nz + k]) continue;
        for (const f of FACES) {
          if (at(i + f[0], j + f[1], k + f[2])) continue;
          for (const c of TRI) {
            const o = 6 + c * 3;
            out.push(u0 + (i + f[o]) * cs, v0 + (j + f[o + 1]) * cs, (k + f[o + 2]) * cs, f[3], f[4], f[5]);
          }
        }
      }
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(out.positions.slice(0, out.length), 3));
  geometry.setAttribute('normal', new BufferAttribute(out.normals.slice(0, out.length), 3));
  return geometry;
}

// Growable position + normal buffer, avoiding huge intermediate JS arrays
class FaceBuffer {
  constructor() {
    this.length = 0;
    this.positions = new Float32Array(1 << 16);
    this.normals = new Float32Array(1 << 16);
  }

  push(x, y, z, nx, ny, nz) {
    if (this.length + 3 > this.positions.length) {
      this.positions = grow(this.positions);
      this.normals = grow(this.normals);
    }
    const p = this.length;
    this.positions[p] = x;
    this.positions[p + 1] = y;
    this.positions[p + 2] = z;
    this.normals[p] = nx;
    this.normals[p + 1] = ny;
    this.normals[p + 2] = nz;
    this.length += 3;
  }
}

function grow(a) {
  const b = new Float32Array(a.length * 2);
  b.set(a);
  return b;
}
