/* VibeMine — renderer.
 *
 * A small purpose-built 3D engine on a 2D canvas: rotate the sphere with a
 * quaternion, project with a perspective camera, drop every back-facing cell
 * (the sphere is convex, so that alone gives correct ordering) and paint the
 * rest as shaded polygons. No WebGL and no libraries, which keeps the game
 * offline-installable and fast on old phones.
 */
(function (global) {
  'use strict';

  const { V, Q, clamp } = global.GS.util;

  const THEMES = {
    midnight: {
      name: 'Midnight',
      background: ['#070b18', '#0d1430'],
      stars: 'rgba(200,220,255,',
      hidden: '#3b6ea8',
      hiddenLight: '#79b3e8',
      hiddenPentagon: '#4a6fb0',
      revealed: '#101a30',
      revealedRim: '#1d2c4d',
      grid: 'rgba(6,10,22,0.85)',
      glow: 'rgba(90,150,230,0.32)',
      flag: '#ff5470',
      flagPole: '#f2f5ff',
      maybe: '#ffcf5c',
      mine: '#ff4d5e',
      mineBody: '#1b1024',
      wrong: '#8a4b8f',
      hint: '#5cffc8',
      cursor: '#ffffff',
      numbers: ['#7fd3ff', '#63e6a4', '#ff8f6b', '#c79bff', '#ffd166', '#5ce0e0', '#ff9ecd', '#cfd8ea']
    },
    daylight: {
      name: 'Daylight',
      background: ['#dfe9f5', '#b9cde4'],
      stars: 'rgba(255,255,255,',
      hidden: '#8fb6dd',
      hiddenLight: '#d9ecff',
      hiddenPentagon: '#a3bfe0',
      revealed: '#f4f8fd',
      revealedRim: '#dae5f2',
      grid: 'rgba(60,84,120,0.45)',
      glow: 'rgba(120,170,230,0.16)',
      flag: '#e02b48',
      flagPole: '#2b3550',
      maybe: '#b8860b',
      mine: '#c0182f',
      mineBody: '#2a1620',
      wrong: '#7a3b8f',
      hint: '#009e73',
      cursor: '#1b2436',
      numbers: ['#1c6fd0', '#12805a', '#c23b22', '#7b3fbf', '#b8860b', '#0f7a8a', '#c2407f', '#3d4a63']
    },
    vivid: {
      name: 'High contrast',
      background: ['#000000', '#0a0a0a'],
      stars: 'rgba(255,255,255,',
      hidden: '#5a5a5a',
      hiddenLight: '#a8a8a8',
      hiddenPentagon: '#6d6d6d',
      revealed: '#1e1e1e',
      revealedRim: '#333333',
      grid: '#000000',
      glow: 'rgba(255,255,255,0.18)',
      flag: '#ff0040',
      flagPole: '#ffffff',
      maybe: '#ffd500',
      mine: '#ff2d00',
      mineBody: '#000000',
      wrong: '#ff00ff',
      hint: '#00ffa3',
      cursor: '#ffffff',
      /* Okabe–Ito derived: distinguishable with any common colour blindness. */
      numbers: ['#56b4e9', '#009e73', '#e69f00', '#cc79a7', '#f0e442', '#0072b2', '#d55e00', '#ffffff']
    }
  };

  const LIGHT = V.normalize([-0.45, 0.7, 0.75]);

  function createRenderer(canvas) {
    const ctx = canvas.getContext('2d');

    const state = {
      sphere: null,
      game: null,
      theme: THEMES.midnight,
      orientation: Q.identity(),
      zoom: 1,
      dpr: 1,
      width: 0,
      height: 0,
      cx: 0,
      cy: 0,
      radius: 0,
      focal: 0,
      cameraDistance: 3.4,
      dirty: true,
      /* animation bookkeeping */
      revealAt: null,
      flagAt: null,
      explodedAt: 0,
      hintCell: -1,
      hintAt: 0,
      pressedCell: -1,
      hoverCell: -1,
      showPentagons: true,
      showMines: false,
      labelScale: 1,
      stars: []
    };

    /* Scratch buffers, reallocated only when the board size changes. */
    let rotCorners = null;
    let projCorners = null;
    let rotCenters = null;
    let projCenters = null;

    function setSphere(sphere) {
      state.sphere = sphere;
      rotCorners = new Float32Array(sphere.corners.length);
      projCorners = new Float32Array((sphere.corners.length / 3) * 2);
      rotCenters = new Float32Array(sphere.centers.length);
      projCenters = new Float32Array((sphere.centers.length / 3) * 2);
      state.revealAt = new Float64Array(sphere.count);
      state.flagAt = new Float64Array(sphere.count);
      state.dirty = true;
    }

    function makeStars(count) {
      const rng = global.GS.util.makeRng(1234);
      const stars = [];
      for (let i = 0; i < count; i++) {
        stars.push({
          x: rng(), y: rng(),
          r: 0.4 + rng() * 1.3,
          a: 0.25 + rng() * 0.65,
          twinkle: rng() * Math.PI * 2
        });
      }
      return stars;
    }
    state.stars = makeStars(160);

    function resize() {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(global.devicePixelRatio || 1, 2.5);
      state.dpr = dpr;
      state.width = Math.max(1, Math.round(rect.width));
      state.height = Math.max(1, Math.round(rect.height));
      canvas.width = Math.round(state.width * dpr);
      canvas.height = Math.round(state.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      state.cx = state.width / 2;
      state.cy = state.height / 2;
      /* Leave a margin for the hint ring and the glow, but otherwise fill the
       * short side of the screen. */
      const fit = Math.min(state.width, state.height) * 0.485;
      state.radius = fit * state.zoom;
      const d = state.cameraDistance;
      state.focal = state.radius * Math.sqrt(d * d - 1);
      state.dirty = true;
    }

    function setZoom(z) {
      state.zoom = clamp(z, 0.75, 3.2);
      resize();
    }

    /* ---- projection ----------------------------------------------------- */

    function projectAll() {
      const d = state.cameraDistance;
      const f = state.focal;
      const q = state.orientation;
      const qx = q[0], qy = q[1], qz = q[2], qw = q[3];

      const src = [state.sphere.corners, state.sphere.centers];
      const rot = [rotCorners, rotCenters];
      const proj = [projCorners, projCenters];

      for (let s = 0; s < 2; s++) {
        const a = src[s], r = rot[s], p = proj[s];
        for (let i = 0, j = 0; i < a.length; i += 3, j += 2) {
          const vx = a[i], vy = a[i + 1], vz = a[i + 2];
          const tx = 2 * (qy * vz - qz * vy);
          const ty = 2 * (qz * vx - qx * vz);
          const tz = 2 * (qx * vy - qy * vx);
          const rx = vx + qw * tx + (qy * tz - qz * ty);
          const ry = vy + qw * ty + (qz * tx - qx * tz);
          const rz = vz + qw * tz + (qx * ty - qy * tx);
          r[i] = rx; r[i + 1] = ry; r[i + 2] = rz;
          const w = f / (d - rz);
          p[j] = state.cx + rx * w;
          p[j + 1] = state.cy - ry * w;
        }
      }
    }

    /* ---- painting -------------------------------------------------------- */

    function paintBackground(now) {
      const t = state.theme;
      const g = ctx.createLinearGradient(0, 0, 0, state.height);
      g.addColorStop(0, t.background[0]);
      g.addColorStop(1, t.background[1]);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, state.width, state.height);

      if (t.name !== 'Daylight') {
        for (let i = 0; i < state.stars.length; i++) {
          const s = state.stars[i];
          const a = s.a * (0.65 + 0.35 * Math.sin(now / 1400 + s.twinkle));
          ctx.fillStyle = t.stars + a.toFixed(3) + ')';
          ctx.fillRect(s.x * state.width, s.y * state.height, s.r, s.r);
        }
      }

      const glow = ctx.createRadialGradient(
        state.cx, state.cy, state.radius * 0.85,
        state.cx, state.cy, state.radius * 1.28);
      glow.addColorStop(0, t.glow);
      glow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(state.cx, state.cy, state.radius * 1.3, 0, Math.PI * 2);
      ctx.fill();
    }

    function shade(hex, amount) {
      const n = parseInt(hex.slice(1), 16);
      let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
      if (amount >= 0) {
        r = r + (255 - r) * amount; g = g + (255 - g) * amount; b = b + (255 - b) * amount;
      } else {
        const k = 1 + amount;
        r *= k; g *= k; b *= k;
      }
      return 'rgb(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ')';
    }

    const easeOut = (t) => 1 - Math.pow(1 - t, 3);

    function render(now) {
      const sphere = state.sphere;
      const game = state.game;
      if (!sphere) return;
      const theme = state.theme;
      now = now || performance.now();

      projectAll();
      paintBackground(now);

      const d = state.cameraDistance;
      const cellPixels = state.radius * sphere.cellRadius * 1.9;
      const drawLabels = cellPixels > 11;
      const fontSize = Math.max(7, cellPixels * 0.72 * state.labelScale);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';

      let animating = false;

      for (let i = 0; i < sphere.count; i++) {
        const cz = rotCenters[i * 3 + 2];
        const nx = rotCenters[i * 3], ny = rotCenters[i * 3 + 1];
        /* Cull anything on the far side of the sphere. */
        const facing = nx * (0 - nx) + ny * (0 - ny) + cz * (d - cz);
        if (facing <= 0.02) continue;

        const ring = sphere.cellCorners[i];
        const revealed = game ? game.revealed[i] : 0;
        const flag = game ? game.flags[i] : 0;
        const isMine = game && (state.showMines || game.state === 'lost') && game.mines[i];

        /* Reveal wave: cells pop outward from where the player tapped. */
        let scale = 0.9;
        if (revealed) {
          const t0 = state.revealAt[i];
          if (t0 && now - t0 < 260) {
            const k = easeOut((now - t0) / 260);
            scale = 0.9 * (0.45 + 0.55 * k);
            animating = true;
          }
        }

        const diffuse = clamp(nx * LIGHT[0] + ny * LIGHT[1] + cz * LIGHT[2], -1, 1);
        const limb = clamp(cz, 0, 1);

        let fill;
        if (revealed) {
          fill = shade(theme.revealed, 0.06 * diffuse + 0.10 * limb);
        } else if (state.showPentagons && ring.length === 5) {
          fill = shade(theme.hiddenPentagon, 0.30 * diffuse + 0.10 * limb - 0.12);
        } else {
          fill = shade(theme.hidden, 0.34 * diffuse + 0.12 * limb - 0.12);
        }
        if (isMine && !revealed) fill = theme.mineBody;
        if (state.pressedCell === i && !revealed) fill = shade(theme.hiddenLight, 0.1);

        ctx.beginPath();
        for (let c = 0; c < ring.length; c++) {
          const t = ring[c];
          let px = projCorners[t * 2], py = projCorners[t * 2 + 1];
          if (scale !== 1) {
            px = projCenters[i * 2] + (px - projCenters[i * 2]) * scale;
            py = projCenters[i * 2 + 1] + (py - projCenters[i * 2 + 1]) * scale;
          }
          if (c === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fillStyle = fill;
        ctx.fill();

        if (cellPixels > 6) {
          const hovered = state.hoverCell === i && !revealed && game && game.state !== 'lost';
          ctx.strokeStyle = hovered ? theme.cursor : theme.grid;
          ctx.lineWidth = Math.max(0.5, cellPixels * (hovered ? 0.075 : 0.045));
          ctx.stroke();
        }

        const px = projCenters[i * 2], py = projCenters[i * 2 + 1];
        const size = cellPixels * (0.55 + 0.45 * limb);

        if (revealed && !isMine) {
          const n = game.adjacency[i];
          /* Cells near the silhouette are foreshortened to a sliver, so their
           * numbers shrink with them instead of colliding with the neighbours. */
          if (n > 0 && drawLabels && limb > 0.12) {
            const labelSize = fontSize * (0.5 + 0.5 * limb);
            ctx.fillStyle = theme.numbers[Math.min(n, 8) - 1];
            ctx.font = '700 ' + labelSize.toFixed(1) + 'px ui-rounded, "Segoe UI", system-ui, sans-serif';
            ctx.fillText(String(n), px, py + labelSize * 0.04);
          }
        } else if (flag === 1) {
          drawFlag(px, py, size, now, i);
        } else if (flag === 2) {
          ctx.fillStyle = theme.maybe;
          ctx.font = '700 ' + fontSize.toFixed(1) + 'px system-ui, sans-serif';
          ctx.fillText('?', px, py);
        }

        if (isMine) {
          /* `size` spans the cell, and the spikes reach 1.55x the radius
           * passed in, so keep the body well under a quarter of the cell. */
          const exploded = game.exploded === i;
          drawMine(px, py, size * (exploded ? 0.24 : 0.18), exploded, now);
          if (exploded) animating = true;
        }
        if (game && game.state === 'lost' && flag === 1 && !game.mines[i]) {
          ctx.strokeStyle = theme.wrong;
          ctx.lineWidth = Math.max(1, cellPixels * 0.08);
          ctx.beginPath();
          ctx.moveTo(px - size * 0.3, py - size * 0.3);
          ctx.lineTo(px + size * 0.3, py + size * 0.3);
          ctx.moveTo(px + size * 0.3, py - size * 0.3);
          ctx.lineTo(px - size * 0.3, py + size * 0.3);
          ctx.stroke();
        }
      }

      /* Hint marker: a pulsing ring that fades after a few seconds. */
      if (state.hintCell >= 0) {
        const age = now - state.hintAt;
        if (age > 4200) state.hintCell = -1;
        else {
          const i = state.hintCell;
          const cz = rotCenters[i * 3 + 2];
          if (cz > 0) {
            const px = projCenters[i * 2], py = projCenters[i * 2 + 1];
            const pulse = 1 + 0.28 * Math.sin(age / 130);
            ctx.strokeStyle = theme.hint;
            ctx.globalAlpha = clamp(1 - age / 4200, 0, 1);
            ctx.lineWidth = Math.max(1.6, cellPixels * 0.11);
            ctx.beginPath();
            ctx.arc(px, py, cellPixels * 0.62 * pulse, 0, Math.PI * 2);
            ctx.stroke();
            ctx.globalAlpha = 1;
          }
          animating = true;
        }
      }

      state.dirty = animating;
      return animating;

      function drawFlag(px, py, size, now, index) {
        const t0 = state.flagAt[index];
        let s = size;
        if (t0 && now - t0 < 220) { s = size * (0.5 + 0.5 * easeOut((now - t0) / 220)); animating = true; }
        const h = s * 0.62;
        ctx.strokeStyle = theme.flagPole;
        ctx.lineWidth = Math.max(0.8, s * 0.09);
        ctx.beginPath();
        ctx.moveTo(px - h * 0.18, py + h * 0.55);
        ctx.lineTo(px - h * 0.18, py - h * 0.6);
        ctx.stroke();
        ctx.fillStyle = theme.flag;
        ctx.beginPath();
        ctx.moveTo(px - h * 0.18, py - h * 0.6);
        ctx.lineTo(px + h * 0.62, py - h * 0.26);
        ctx.lineTo(px - h * 0.18, py + h * 0.06);
        ctx.closePath();
        ctx.fill();
      }

      function drawMine(px, py, r, exploded, now) {
        if (exploded) {
          const age = now - state.explodedAt;
          const k = clamp(age / 420, 0, 1);
          const blast = r * (1 + 2.4 * easeOut(k));
          ctx.globalAlpha = (1 - k) * 0.8;
          ctx.fillStyle = theme.mine;
          ctx.beginPath();
          ctx.arc(px, py, blast, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 1;
        }
        ctx.fillStyle = exploded ? theme.mine : theme.flagPole;
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = exploded ? theme.mine : theme.flagPole;
        ctx.lineWidth = Math.max(0.7, r * 0.32);
        for (let a = 0; a < 4; a++) {
          const ang = (a / 4) * Math.PI;
          ctx.beginPath();
          ctx.moveTo(px - Math.cos(ang) * r * 1.55, py - Math.sin(ang) * r * 1.55);
          ctx.lineTo(px + Math.cos(ang) * r * 1.55, py + Math.sin(ang) * r * 1.55);
          ctx.stroke();
        }
      }
    }

    /* ---- picking ---------------------------------------------------------
     * Cast a ray from the camera through the tapped pixel, hit the sphere,
     * then rotate that point back into board space. The cells are the Voronoi
     * regions of their centres, so the nearest centre is the tapped cell. */

    function unproject(sx, sy) {
      const f = state.focal;
      const d = state.cameraDistance;
      const dx = (sx - state.cx) / f;
      const dy = -(sy - state.cy) / f;
      /* Ray: origin (0,0,d), direction (dx, dy, -1) after perspective divide. */
      const ox = 0, oy = 0, oz = d;
      const rx = dx, ry = dy, rz = -1;
      const a = rx * rx + ry * ry + rz * rz;
      const b = 2 * (ox * rx + oy * ry + oz * rz);
      const c = oz * oz - 1;
      const disc = b * b - 4 * a * c;
      if (disc < 0) return null;
      const t = (-b - Math.sqrt(disc)) / (2 * a);
      return [ox + rx * t, oy + ry * t, oz + rz * t];
    }

    function pickCell(sx, sy) {
      if (!state.sphere) return -1;
      const hit = unproject(sx, sy);
      if (!hit) return -1;
      const local = Q.rotate(Q.conjugate(state.orientation), hit);
      const centers = state.sphere.centers;
      let best = -1, bestDot = -2;
      for (let i = 0; i < state.sphere.count; i++) {
        const dot = local[0] * centers[i * 3] + local[1] * centers[i * 3 + 1] + local[2] * centers[i * 3 + 2];
        if (dot > bestDot) { bestDot = dot; best = i; }
      }
      return best;
    }

    /* Direction the camera is looking at, in board space — used to bias
     * hints towards whatever the player currently has in view. */
    function focusDirection() {
      return Q.rotate(Q.conjugate(state.orientation), [0, 0, 1]);
    }

    /* Spin the globe so a given cell ends up facing the player. */
    function orientationFacing(cellIndex) {
      const c = state.sphere.centers;
      const target = [c[cellIndex * 3], c[cellIndex * 3 + 1], c[cellIndex * 3 + 2]];
      const rotated = Q.rotate(state.orientation, target);
      const delta = Q.between(V.normalize(rotated), [0, 0, 1]);
      return Q.normalize(Q.multiply(delta, state.orientation));
    }

    function markRevealed(cells, now) {
      for (const item of cells) state.revealAt[item.cell] = now + item.depth * 26;
      state.dirty = true;
    }

    return {
      state,
      ctx,
      canvas,
      setSphere,
      setZoom,
      resize,
      render,
      pickCell,
      unproject,
      focusDirection,
      orientationFacing,
      markRevealed,
      themes: THEMES
    };
  }

  global.GS = global.GS || {};
  global.GS.renderer = { createRenderer, THEMES };
})(typeof globalThis !== 'undefined' ? globalThis : this);
