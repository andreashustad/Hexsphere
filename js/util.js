/* Hexsphere — small shared utilities: RNG, vector and quaternion math. */
(function (global) {
  'use strict';

  /* ---- deterministic RNG (mulberry32) ------------------------------- */

  function hashString(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }

  function makeRng(seed) {
    let a = (typeof seed === 'string' ? hashString(seed) : seed >>> 0) || 1;
    const rng = function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    rng.int = function (n) { return Math.floor(rng() * n); };
    rng.pick = function (arr) { return arr[rng.int(arr.length)]; };
    rng.shuffle = function (arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = rng.int(i + 1);
        const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
      }
      return arr;
    };
    return rng;
  }

  /* ---- vectors (plain [x, y, z] arrays) ----------------------------- */

  const V = {
    add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
    sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
    scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
    dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    cross: (a, b) => [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0]
    ],
    len: (a) => Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]),
    normalize: function (a) {
      const l = V.len(a) || 1;
      return [a[0] / l, a[1] / l, a[2] / l];
    }
  };

  /* ---- quaternions as [x, y, z, w], used for globe orientation ------ */

  const Q = {
    identity: () => [0, 0, 0, 1],
    multiply: function (a, b) {
      return [
        a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
        a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
        a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
        a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
      ];
    },
    fromAxisAngle: function (axis, angle) {
      const n = V.normalize(axis);
      const s = Math.sin(angle / 2);
      return [n[0] * s, n[1] * s, n[2] * s, Math.cos(angle / 2)];
    },
    normalize: function (q) {
      const l = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]) || 1;
      return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
    },
    conjugate: (q) => [-q[0], -q[1], -q[2], q[3]],
    /* Rotate a vector by a quaternion. */
    rotate: function (q, v) {
      const x = q[0], y = q[1], z = q[2], w = q[3];
      const tx = 2 * (y * v[2] - z * v[1]);
      const ty = 2 * (z * v[0] - x * v[2]);
      const tz = 2 * (x * v[1] - y * v[0]);
      return [
        v[0] + w * tx + (y * tz - z * ty),
        v[1] + w * ty + (z * tx - x * tz),
        v[2] + w * tz + (x * ty - y * tx)
      ];
    },
    /* Shortest-arc rotation taking unit vector `from` onto unit vector `to`. */
    between: function (from, to) {
      const d = V.dot(from, to);
      if (d > 0.999999) return Q.identity();
      if (d < -0.999999) {
        let axis = V.cross([1, 0, 0], from);
        if (V.len(axis) < 1e-6) axis = V.cross([0, 1, 0], from);
        return Q.fromAxisAngle(axis, Math.PI);
      }
      const c = V.cross(from, to);
      return Q.normalize([c[0], c[1], c[2], 1 + d]);
    },
    slerp: function (a, b, t) {
      let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
      let end = b;
      if (d < 0) { d = -d; end = [-b[0], -b[1], -b[2], -b[3]]; }
      if (d > 0.9995) {
        return Q.normalize([
          a[0] + (end[0] - a[0]) * t, a[1] + (end[1] - a[1]) * t,
          a[2] + (end[2] - a[2]) * t, a[3] + (end[3] - a[3]) * t
        ]);
      }
      const theta = Math.acos(d);
      const s = Math.sin(theta);
      const wa = Math.sin((1 - t) * theta) / s;
      const wb = Math.sin(t * theta) / s;
      return [
        a[0] * wa + end[0] * wb, a[1] * wa + end[1] * wb,
        a[2] * wa + end[2] * wb, a[3] * wa + end[3] * wb
      ];
    }
  };

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  global.GS = global.GS || {};
  global.GS.util = { hashString, makeRng, V, Q, clamp };
})(typeof globalThis !== 'undefined' ? globalThis : this);
