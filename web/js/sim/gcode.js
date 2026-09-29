// Minimal G-code interpreter for simulation: turns program lines into a flat list
// of straight-line moves (arcs are split into short segments).
//
// Supported: G0/G1, G2/G3 (I/J/K or R, in the G17/G18/G19 plane), G20/G21,
// G90/G91, G53 (treated as work coordinates), $H (homes Z to 0) and $J= jogs.
// Anything else is ignored; unrecognized lines are reported as warnings.
//
// The wire's position before the program runs is unknown, so the first move and
// homing moves are marked non-cutting (cut: false): the stock is assumed to be
// placed after homing, and the wire to start wherever the program first sends it.

import { MAX_FEED } from '../machine.js';

const AXES = ['X', 'Y', 'Z', 'A'];
const ARC_SEGMENT_MM = 1;

// Plane -> [first axis, second axis, first center offset word, second center offset word]
const PLANES = {
  17: ['X', 'Y', 'I', 'J'],
  18: ['Z', 'X', 'K', 'I'],
  19: ['Y', 'Z', 'J', 'K'],
};

function parseWords(text) {
  const words = [];
  const re = /([A-Z])\s*([-+]?(?:\d+\.?\d*|\.\d+))/g;
  let m;
  while ((m = re.exec(text))) words.push([m[1], parseFloat(m[2])]);
  return words;
}

function stripComments(line) {
  return line.replace(/\([^)]*\)/g, '').split(';')[0].trim();
}

/**
 * @param {string[]} lines program lines
 * @returns {{ moves: Array<{line:number, from:object, to:object, feed:number, rapid:boolean, cut:boolean}>, warnings: string[] }}
 */
export function parseGcode(lines) {
  const pos = { X: 0, Y: 0, Z: 0, A: 0 };
  const moves = [];
  const warnings = [];
  let relative = false;
  let unitScale = 1;
  let plane = 17;
  let motion = 0;
  let feed = MAX_FEED;

  const addMove = (lineIdx, target, rapid, cut = true) => {
    const from = { ...pos };
    if (AXES.every((a) => target[a] === from[a])) return;
    if (moves.length === 0) cut = false;
    moves.push({ line: lineIdx, from, to: { ...target }, feed: rapid ? MAX_FEED : feed, rapid, cut });
    Object.assign(pos, target);
  };

  lines.forEach((raw, lineIdx) => {
    let text = stripComments(raw).toUpperCase();
    if (!text) return;

    if (text.startsWith('$H')) {
      // Only Z has homing configured; it homes to machine 0
      addMove(lineIdx, { ...pos, Z: 0 }, true, false);
      return;
    }
    if (text.startsWith('$')) {
      if (!text.startsWith('$J=')) return;  // settings/commands don't move
    }

    const isJog = text.startsWith('$J=');
    if (isJog) text = text.slice(3);

    // Reject prose: a G-code line must start with a word like G1 or X10
    if (!/^[A-Z]\s*[-+.\d]/.test(text)) {
      warnings.push(`Line ${lineIdx + 1}: not G-code, ignored`);
      return;
    }

    const words = parseWords(text);
    let lineRelative = relative;
    let lineMotion = isJog ? 1 : motion;
    let hasMotionWord = false;
    const vals = {};

    for (const [letter, value] of words) {
      if (letter === 'G') {
        switch (value) {
          case 0: case 1: case 2: case 3:
            lineMotion = value;
            hasMotionWord = true;
            break;
          case 17: case 18: case 19: plane = value; break;
          case 20: unitScale = 25.4; break;
          case 21: unitScale = 1; break;
          case 90: lineRelative = false; break;
          case 91: lineRelative = true; break;
          default: break;  // G53, G54.., G94 etc. don't affect the simulated path
        }
      } else {
        vals[letter] = value;
      }
    }

    if (!isJog) {
      relative = lineRelative;
      if (hasMotionWord) motion = lineMotion;
    }
    if (vals.F !== undefined) feed = Math.min(vals.F * unitScale, MAX_FEED);

    const target = { ...pos };
    let hasAxis = false;
    for (const a of AXES) {
      if (vals[a] === undefined) continue;
      hasAxis = true;
      // A is in mm of belt travel like Y, so it scales with units too
      const v = vals[a] * unitScale;
      target[a] = lineRelative ? pos[a] + v : v;
    }
    if (!hasAxis) return;

    if (lineMotion === 2 || lineMotion === 3) {
      addArc(lineIdx, target, vals, lineMotion === 2, unitScale);
    } else {
      addMove(lineIdx, target, lineMotion === 0);
    }
  });

  function addArc(lineIdx, target, vals, clockwise, scale) {
    const [p, q, ip, iq] = PLANES[plane];
    const start = { ...pos };
    const dp = target[p] - start[p];
    const dq = target[q] - start[q];
    let cp, cq;
    if (vals.R !== undefined) {
      // Radius form (same center choice as Grbl): positive R = arc under 180°
      const r = vals.R * scale;
      const d = Math.hypot(dp, dq);
      if (d === 0 || Math.abs(r) < d / 2) {
        warnings.push(`Line ${lineIdx + 1}: invalid arc radius, drawn as a line`);
        addMove(lineIdx, target, false);
        return;
      }
      const h = Math.sqrt(r * r - (d * d) / 4) * (clockwise ? -1 : 1) * Math.sign(r);
      cp = start[p] + dp / 2 - (h * dq) / d;
      cq = start[q] + dq / 2 + (h * dp) / d;
    } else {
      cp = start[p] + (vals[ip] || 0) * scale;
      cq = start[q] + (vals[iq] || 0) * scale;
    }
    const r = Math.hypot(start[p] - cp, start[q] - cq);
    let a0 = Math.atan2(start[q] - cq, start[p] - cp);
    let a1 = Math.atan2(target[q] - cq, target[p] - cp);
    let sweep = a1 - a0;
    if (clockwise && sweep >= 0) sweep -= 2 * Math.PI;
    if (!clockwise && sweep <= 0) sweep += 2 * Math.PI;
    const segments = Math.max(4, Math.ceil((Math.abs(sweep) * r) / ARC_SEGMENT_MM));
    for (let i = 1; i <= segments; i++) {
      const t = i / segments;
      const pt = {};
      for (const a of AXES) pt[a] = start[a] + (target[a] - start[a]) * t;  // helical/other axes
      pt[p] = cp + r * Math.cos(a0 + sweep * t);
      pt[q] = cq + r * Math.sin(a0 + sweep * t);
      if (i === segments) Object.assign(pt, target);
      addMove(lineIdx, pt, false);
    }
  }

  return { moves, warnings };
}
