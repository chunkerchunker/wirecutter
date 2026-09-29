// Hot-wire carving simulation on a voxel grid.
//
// Geometry (stock frame, origin on the rotation axis at bed level, Z up):
// - The wire is a horizontal line perpendicular to Y at height Z. Relative to the
//   platform center it sits at offset Y (bed position), so in the rotated stock frame
//   the wire covers every voxel whose s = u*sin(θ) + v*cos(θ) equals Y.
// - A cut at a fixed rotation θ is therefore a 2D path in the (s, z) plane, extruded
//   along the wire. Material is modeled per (s, z) cell: a cell holds material if any
//   voxel projects onto it.
// - Whenever the path so far splits the projected material into disconnected pieces,
//   every piece except the one containing the workpiece center (0, h/2) is removed
//   (the largest piece is kept if the center itself was cut). The kerf is removed too.
//
// Output: removedAt[voxel] = index of the move that removed it (ALIVE if never).

import { MM_PER_DEG } from '../machine.js';

export const ALIVE = 0x7fffffff;
const TARGET_CELLS = 120;  // cells along the largest stock dimension
const ROTATION_EPS = 1e-6;

export function makeGrid({ w, d, h }) {
  const cs = Math.max(0.25, Math.max(w, d, h) / TARGET_CELLS);
  const nu = Math.max(1, Math.ceil(w / cs));
  const nv = Math.max(1, Math.ceil(d / cs));
  const nz = Math.max(1, Math.ceil(h / cs));
  return { w, d, h, cs, nu, nv, nz };
}

export function simulate(moves, stock) {
  const grid = makeGrid(stock);
  const { w, d, h, cs, nu, nv, nz } = grid;
  const nVox = nu * nv * nz;
  const removedAt = new Int32Array(nVox).fill(ALIVE);

  // Cut-plane grid: s spans the stock's diagonal so every rotation fits
  const sMax = Math.hypot(w, d) / 2;
  const ns = Math.ceil((2 * sMax) / cs) + 1;
  const nCells = ns * nz;
  const sCellOf = (s) => Math.floor((s + sMax) / cs);
  const zCellOf = (z) => Math.floor(z / cs);

  const colU = new Float32Array(nu);
  const colV = new Float32Array(nv);
  for (let i = 0; i < nu; i++) colU[i] = -w / 2 + (i + 0.5) * cs;
  for (let j = 0; j < nv; j++) colV[j] = -d / 2 + (j + 0.5) * cs;

  const bucketStart = new Int32Array(nCells + 1);
  const bucketItems = new Int32Array(nVox);
  const material = new Uint8Array(nCells);
  const barrier = new Uint8Array(nCells);
  const comp = new Int32Array(nCells);
  const queue = new Int32Array(nCells);
  let groupTheta = null;

  // Bucket live voxels by the (s, z) cell they project onto at rotation theta
  function buildGroup(theta) {
    const rad = (theta * Math.PI) / 180;
    const sin = Math.sin(rad);
    const cos = Math.cos(rad);
    const colCell = new Int32Array(nu * nv);
    for (let i = 0; i < nu; i++) {
      for (let j = 0; j < nv; j++) colCell[i * nv + j] = sCellOf(colU[i] * sin + colV[j] * cos) * nz;
    }
    bucketStart.fill(0);
    for (let c = 0; c < nu * nv; c++) {
      const base = c * nz;
      for (let k = 0; k < nz; k++) {
        if (removedAt[base + k] === ALIVE) bucketStart[colCell[c] + k + 1]++;
      }
    }
    for (let c = 0; c < nCells; c++) bucketStart[c + 1] += bucketStart[c];
    const fill = bucketStart.slice(0, nCells);
    for (let c = 0; c < nu * nv; c++) {
      const base = c * nz;
      for (let k = 0; k < nz; k++) {
        const v = base + k;
        if (removedAt[v] === ALIVE) bucketItems[fill[colCell[c] + k]++] = v;
      }
    }
    for (let c = 0; c < nCells; c++) material[c] = bucketStart[c + 1] > bucketStart[c] ? 1 : 0;
    barrier.fill(0);
    groupTheta = theta;
  }

  // Mark kerf cells along a segment; returns true if it touched material
  function rasterize(s0, z0, s1, z1) {
    const len = Math.hypot(s1 - s0, z1 - z0);
    const steps = Math.max(1, Math.ceil(len / (cs / 2)));
    let hit = false;
    for (let t = 0; t <= steps; t++) {
      const f = t / steps;
      const sc = sCellOf(s0 + (s1 - s0) * f);
      const zc = zCellOf(z0 + (z1 - z0) * f);
      if (sc < 0 || sc >= ns || zc < 0 || zc >= nz) continue;
      const c = sc * nz + zc;
      if (!barrier[c]) {
        barrier[c] = 1;
        if (material[c]) hit = true;
      }
    }
    return hit;
  }

  function removeCell(c, moveIdx) {
    for (let p = bucketStart[c]; p < bucketStart[c + 1]; p++) {
      const v = bucketItems[p];
      if (removedAt[v] === ALIVE) removedAt[v] = moveIdx;
    }
    material[c] = 0;
  }

  // Label connected material pieces (4-connected, kerf excluded) and drop all but one
  function separate(moveIdx) {
    comp.fill(-1);
    let nComp = 0;
    let largest = -1;
    let largestSize = 0;
    for (let start = 0; start < nCells; start++) {
      if (!material[start] || barrier[start] || comp[start] >= 0) continue;
      let head = 0;
      let tail = 0;
      queue[tail++] = start;
      comp[start] = nComp;
      while (head < tail) {
        const c = queue[head++];
        const sc = (c / nz) | 0;
        const zc = c - sc * nz;
        const neighbors = [
          zc > 0 ? c - 1 : -1,
          zc < nz - 1 ? c + 1 : -1,
          sc > 0 ? c - nz : -1,
          sc < ns - 1 ? c + nz : -1,
        ];
        for (const n of neighbors) {
          if (n >= 0 && material[n] && !barrier[n] && comp[n] < 0) {
            comp[n] = nComp;
            queue[tail++] = n;
          }
        }
      }
      if (tail > largestSize) {
        largestSize = tail;
        largest = nComp;
      }
      nComp++;
    }

    const center = sCellOf(0) * nz + Math.min(nz - 1, zCellOf(h / 2));
    const keep = comp[center] >= 0 ? comp[center] : largest;
    for (let c = 0; c < nCells; c++) {
      if (material[c] && (barrier[c] || comp[c] !== keep)) removeCell(c, moveIdx);
    }
  }

  moves.forEach((m, i) => {
    const rot0 = (m.from.A - m.from.Y) / MM_PER_DEG;
    const rot1 = (m.to.A - m.to.Y) / MM_PER_DEG;
    if (Math.abs(rot1 - rot0) > ROTATION_EPS) {
      groupTheta = null;  // rotating: material must be re-bucketed at the new angle
      return;
    }
    if (!m.cut) return;
    if (groupTheta === null || Math.abs(groupTheta - rot0) > ROTATION_EPS) buildGroup(rot0);
    if (rasterize(m.from.Y, m.from.Z, m.to.Y, m.to.Z)) separate(i);
  });

  return { grid, removedAt };
}

// Stock guess from the program: height = highest Z, square footprint centered on the
// rotation axis reaching the farthest Y the wire visits.
export function autoStock(moves) {
  let maxY = 0;
  let maxZ = 0;
  for (const m of moves) {
    maxY = Math.max(maxY, Math.abs(m.from.Y), Math.abs(m.to.Y));
    maxZ = Math.max(maxZ, m.from.Z, m.to.Z);
  }
  const side = maxY > 0 ? 2 * maxY : 100;
  return { w: round1(side), d: round1(side), h: round1(maxZ > 0 ? maxZ : 50) };
}

function round1(x) {
  return Math.round(x * 10) / 10;
}
