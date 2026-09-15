/* VibeMine — board geometry.
 *
 * The board is a Goldberg polyhedron: subdivide an icosahedron `frequency`
 * times, project it onto the unit sphere, then take the dual. Every vertex of
 * the geodesic sphere becomes one playable cell — a hexagon, except at the 12
 * original icosahedron corners, which stay pentagons. That gives 10 * f^2 + 2
 * cells, all near-identical in size, with no seams or poles to distort play.
 */
(function (global) {
  'use strict';

  const { V } = global.GS.util;

  const PHI = (1 + Math.sqrt(5)) / 2;

  const ICO_VERTICES = [
    [-1, PHI, 0], [1, PHI, 0], [-1, -PHI, 0], [1, -PHI, 0],
    [0, -1, PHI], [0, 1, PHI], [0, -1, -PHI], [0, 1, -PHI],
    [PHI, 0, -1], [PHI, 0, 1], [-PHI, 0, -1], [-PHI, 0, 1]
  ].map(V.normalize);

  const ICO_FACES = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]
  ];

  /* Welds coincident subdivision points from adjacent faces into one vertex.
   * Uses a bucketed lookup with a tolerance so floating-point drift along a
   * shared edge can never split a vertex in two. */
  function makePointWelder(tolerance) {
    const cell = tolerance * 10;
    const buckets = new Map();
    const points = [];
    const key = (a, b, c) => a + ':' + b + ':' + c;

    return {
      points,
      add: function (p) {
        const bx = Math.floor(p[0] / cell);
        const by = Math.floor(p[1] / cell);
        const bz = Math.floor(p[2] / cell);
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            for (let dz = -1; dz <= 1; dz++) {
              const found = buckets.get(key(bx + dx, by + dy, bz + dz));
              if (found === undefined) continue;
              for (let i = 0; i < found.length; i++) {
                const q = points[found[i]];
                const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2;
                if (d < tolerance * tolerance) return found[i];
              }
            }
          }
        }
        const index = points.length;
        points.push(p);
        const k = key(bx, by, bz);
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k).push(index);
        return index;
      }
    };
  }

  /* Geodesic sphere: welded vertices plus outward-wound triangles. */
  function buildGeodesic(frequency) {
    const welder = makePointWelder(1e-6);
    const triangles = [];

    for (let f = 0; f < ICO_FACES.length; f++) {
      const [ia, ib, ic] = ICO_FACES[f];
      const a = ICO_VERTICES[ia], b = ICO_VERTICES[ib], c = ICO_VERTICES[ic];
      const grid = [];
      for (let i = 0; i <= frequency; i++) {
        grid.push([]);
        for (let j = 0; j <= frequency - i; j++) {
          const k = frequency - i - j;
          const wi = i / frequency, wj = j / frequency, wk = k / frequency;
          const p = V.normalize([
            a[0] * wi + b[0] * wj + c[0] * wk,
            a[1] * wi + b[1] * wj + c[1] * wk,
            a[2] * wi + b[2] * wj + c[2] * wk
          ]);
          grid[i].push(welder.add(p));
        }
      }
      for (let i = 0; i < frequency; i++) {
        for (let j = 0; j < frequency - i; j++) {
          triangles.push([grid[i][j], grid[i + 1][j], grid[i][j + 1]]);
          if (j < frequency - i - 1) {
            triangles.push([grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]]);
          }
        }
      }
    }

    const vertices = welder.points;
    /* Force every triangle to wind counter-clockwise seen from outside, so
     * the dual polygons below inherit a consistent orientation. */
    for (let t = 0; t < triangles.length; t++) {
      const tri = triangles[t];
      const a = vertices[tri[0]], b = vertices[tri[1]], c = vertices[tri[2]];
      const n = V.cross(V.sub(b, a), V.sub(c, a));
      if (V.dot(n, a) < 0) { const tmp = tri[1]; tri[1] = tri[2]; tri[2] = tmp; }
    }
    return { vertices, triangles };
  }

  /* Build the playable board: one cell per geodesic vertex. */
  function buildSphere(frequency) {
    if (!(frequency >= 1) || frequency !== Math.floor(frequency)) {
      throw new Error('frequency must be a positive integer');
    }
    const { vertices, triangles } = buildGeodesic(frequency);
    const count = vertices.length;

    const incident = [];
    const neighborSets = [];
    for (let i = 0; i < count; i++) { incident.push([]); neighborSets.push(new Set()); }

    /* Corner points of the dual cells are the triangle centroids. */
    const corners = new Float32Array(triangles.length * 3);
    for (let t = 0; t < triangles.length; t++) {
      const [ia, ib, ic] = triangles[t];
      const a = vertices[ia], b = vertices[ib], c = vertices[ic];
      const p = V.normalize([
        (a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3
      ]);
      corners[t * 3] = p[0]; corners[t * 3 + 1] = p[1]; corners[t * 3 + 2] = p[2];

      incident[ia].push(t); incident[ib].push(t); incident[ic].push(t);
      neighborSets[ia].add(ib); neighborSets[ia].add(ic);
      neighborSets[ib].add(ia); neighborSets[ib].add(ic);
      neighborSets[ic].add(ia); neighborSets[ic].add(ib);
    }

    const centers = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      centers[i * 3] = vertices[i][0];
      centers[i * 3 + 1] = vertices[i][1];
      centers[i * 3 + 2] = vertices[i][2];
    }

    /* Order each cell's corners around its centre so they form a simple
     * polygon, wound counter-clockwise when viewed from outside. */
    const cellCorners = [];
    for (let i = 0; i < count; i++) {
      const c = vertices[i];
      const ring = incident[i];
      const first = [
        corners[ring[0] * 3] - c[0],
        corners[ring[0] * 3 + 1] - c[1],
        corners[ring[0] * 3 + 2] - c[2]
      ];
      const u = V.normalize(V.sub(first, V.scale(c, V.dot(first, c))));
      const w = V.cross(c, u);
      const sorted = ring.slice().sort(function (p, q) {
        return angleOf(p) - angleOf(q);
      });
      cellCorners.push(sorted);

      function angleOf(t) {
        const d = [corners[t * 3] - c[0], corners[t * 3 + 1] - c[1], corners[t * 3 + 2] - c[2]];
        return Math.atan2(V.dot(d, w), V.dot(d, u));
      }
    }

    const neighbors = neighborSets.map((s) => Array.from(s));

    /* Typical angular radius of a cell, handy for sizing labels and hit slop. */
    let radiusSum = 0;
    for (let i = 0; i < count; i++) {
      const t = cellCorners[i][0];
      radiusSum += Math.acos(Math.min(1,
        centers[i * 3] * corners[t * 3] +
        centers[i * 3 + 1] * corners[t * 3 + 1] +
        centers[i * 3 + 2] * corners[t * 3 + 2]));
    }

    return {
      frequency,
      count,
      centers,
      corners,
      cellCorners,
      neighbors,
      cellRadius: radiusSum / count
    };
  }

  /* Number of cells a frequency produces, without building anything. */
  function cellCountFor(frequency) { return 10 * frequency * frequency + 2; }

  /* Smallest frequency whose board has at least `target` cells. */
  function frequencyForCells(target) {
    let f = 1;
    while (cellCountFor(f) < target) f++;
    return f;
  }

  global.GS = global.GS || {};
  global.GS.geometry = { buildSphere, cellCountFor, frequencyForCells };
})(typeof globalThis !== 'undefined' ? globalThis : this);
