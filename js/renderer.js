/* Hexsphere — renderer.
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

  const easeOut = (t) => 1 - Math.pow(1 - t, 3);

  /* A cell's drawn size as a fraction of a face-on one.
   *
   * Cells near the silhouette are foreshortened in proportion to how far they
   * have turned away, so anything drawn on them has to shrink at the same rate
   * or it spills out. The previous curve, 0.5 + 0.5 * limb, shrank far too
   * slowly: it only fitted from limb 0.56 upwards, so every number outside the
   * middle two thirds of the disc was drawn larger than its own cell, and at
   * the rim they floated clear of the globe. 1.25 * limb keeps a mark inside
   * its cell everywhere while leaving the middle of the board at full size. */
  const LABEL_RATIO = 0.72;    /* label size as a fraction of a face-on cell */
  const MIN_LABEL_PX = 9;      /* below this a number is unreadable, so omit it */

  function foreshorten(limb) {
    return clamp(1.25 * limb, 0, 1);
  }

  /* Eased 0..1 progress since a stamped time. Every animation here goes through
   * this, because the stamps can be in the future: the reveal wave sets them
   * ahead on purpose so the cascade ripples outward, and a pointer event can
   * land after the frame's timestamp was taken. easeOut is a cubic, so an
   * unclamped input does not degrade, it explodes: an age of -2.2s once drew a
   * flag 27,000 pixels wide, mirrored through its own centre. */
  function progress(now, t0, duration) {
    return easeOut(clamp((now - t0) / duration, 0, 1));
  }

  /* ---- bodies ------------------------------------------------------------
   *
   * Every board size is a place, not just a cell count. A body owns the
   * covered surface, the sky, the light and the halo; the theme keeps the
   * numbers, the revealed cells and the chrome, because those are what you
   * read rather than what you look at.
   *
   * A cleared cell still takes a trace of its body (revealedMix), or the whole
   * art direction would fade out exactly as you play: covered cells are the
   * ones you spend the game removing.
   */
  const BODIES = {
    pebble: {
      id: 'pebble', frequency: 3, cells: 92,
      sky: ['#0c0a07', '#1c1610'], hidden: '#6f5c46', tint: '#3a2f25', pentagon: '#806c55',
      surface: 'craters', freq: 5, amount: 0.85, revealedMix: 0.12,
      glow: 'rgba(196,164,122,0.14)', light: [-0.5, 0.66, 0.56]
    },
    moon: {
      id: 'moon', frequency: 4, cells: 162,
      sky: ['#04050a', '#0a0c13'], hidden: '#b2aea8', tint: '#4b4845', pentagon: '#bcb8b2',
      surface: 'craters', freq: 3.4, amount: 0.92, revealedMix: 0.10,
      glow: 'rgba(226,226,220,0.09)', light: [-0.62, 0.52, 0.58]
    },
    /* Low roughness keeps the base octave dominant, which is the difference
     * between continents and a scatter of islands. */
    earth: {
      id: 'earth', frequency: 5, cells: 252,
      sky: ['#04070f', '#0a1126'], hidden: '#15537f', tint: '#44724a', pentagon: '#1c5c8d',
      surface: 'continents', land: 0.50, freq: 1.25, roughness: 0.25, amount: 0.95,
      revealedMix: 0.14,
      glow: 'rgba(86,166,255,0.42)', haloInner: 0.9, haloOuter: 1.22, light: [-0.45, 0.7, 0.75]
    },
    neptune: {
      id: 'neptune', frequency: 7, cells: 492,
      sky: ['#03040e', '#060b20'], hidden: '#3f6ad2', tint: '#0e1f52', pentagon: '#4a72d6',
      surface: 'bands', freq: 9, amount: 1.0, revealedMix: 0.12,
      glow: 'rgba(116,146,255,0.36)', haloInner: 0.88, haloOuter: 1.26, light: [-0.4, 0.66, 0.78]
    },
    /* Self-luminous, so the light is nearly flat. Its own marks too: the
     * theme's red flag disappears into orange. */
    sun: {
      id: 'sun', frequency: 9, cells: 812,
      sky: ['#0b0400', '#210c02'], hidden: '#d9661a', tint: '#ffdf7a', pentagon: '#e8812c',
      surface: 'granules', freq: 7, amount: 0.8, lightMix: 0.25, revealedMix: 0.16,
      glow: 'rgba(255,164,48,0.58)', haloInner: 0.74, haloOuter: 1.5,
      flag: '#14123a', flagPole: '#f6e7cf', light: [0, 0, 1]
    }
  };

  /* A custom board borrows the body of the preset it is closest to in size, so
   * it still lands somewhere rather than falling back to a neutral grey. */
  function bodyForBoard(difficultyId, cellCount) {
    if (BODIES[difficultyId]) return BODIES[difficultyId];
    let best = null;
    let bestGap = Infinity;
    for (const id of Object.keys(BODIES)) {
      const gap = Math.abs(BODIES[id].cells - cellCount);
      if (gap < bestGap) { bestGap = gap; best = BODIES[id]; }
    }
    return best;
  }

  /* High contrast exists so the board stays readable with any common colour
   * blindness. A planet painted over it would undo exactly that, so the body
   * is dropped outright there rather than blended more gently. The sky and the
   * halo are left alone on purpose: they carry no cell state, no number and no
   * mark, so tinting them costs no readability. */
  function activeBody(theme, body) {
    if (!body) return null;
    return theme && theme.name === 'High contrast' ? null : body;
  }

  /* ---- surface ------------------------------------------------------------ */

  function hash3(i, j, k) {
    let h = i * 374761393 + j * 668265263 + k * 2147483647;
    h = (h ^ (h >> 13)) * 1274126177;
    return ((h ^ (h >> 16)) >>> 0) / 4294967295;
  }

  function smoothstep(a, b, t) {
    const x = clamp((t - a) / (b - a), 0, 1);
    return x * x * (3 - 2 * x);
  }

  function valueNoise(x, y, z) {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const xf = x - xi, yf = y - yi, zf = z - zi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
    let acc = 0;
    for (let dz = 0; dz <= 1; dz++) {
      for (let dy = 0; dy <= 1; dy++) {
        for (let dx = 0; dx <= 1; dx++) {
          acc += hash3(xi + dx, yi + dy, zi + dz) *
            (dx ? u : 1 - u) * (dy ? v : 1 - v) * (dz ? w : 1 - w);
        }
      }
    }
    return acc;
  }

  /* roughness 1 is full detail; lower keeps the base octave dominant. */
  function fbm(x, y, z, roughness) {
    const r = roughness === undefined ? 1 : roughness;
    const w1 = 0.3 * r, w2 = 0.1 * r;
    return valueNoise(x, y, z) * (1 - w1 - w2)
      + valueNoise(x * 2.1, y * 2.1, z * 2.1) * w1
      + valueNoise(x * 4.3, y * 4.3, z * 4.3) * w2;
  }

  /* One deterministic 0..1 surface value per cell, from the cell's own place on
   * the sphere. Built once per board in setSphere, never per frame. */
  function buildTerrain(sphere, body) {
    const n = sphere.count;
    const out = new Float32Array(n);
    if (!body || !body.surface || body.surface === 'none') return out;
    const f = body.freq || 4;
    /* Feature size is counted in cells, not radians, so one treatment holds up
     * from 92 cells to 1442. */
    const scale = f * Math.sqrt(n / 252);

    const raw = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = sphere.centers[i * 3], y = sphere.centers[i * 3 + 1], z = sphere.centers[i * 3 + 2];
      raw[i] = body.surface === 'bands'
        ? 0.5 + 0.5 * Math.sin(y * f * 1.9 + Math.sin(y * f * 0.7) * 1.4)
        : fbm(x * scale, y * scale, z * scale, body.roughness);
    }

    /* Normalise before shaping. The noise does not reliably span [0, 1], and
     * shaping an unnormalised range is what silently flattened Earth to a
     * single value at every cell. The test named after this guards it. */
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) { if (raw[i] < lo) lo = raw[i]; if (raw[i] > hi) hi = raw[i]; }
    const span = (hi - lo) || 1;

    for (let i = 0; i < n; i++) {
      let v = (raw[i] - lo) / span;
      if (body.surface === 'continents') {
        const cut = body.land === undefined ? 0.5 : body.land;
        v = smoothstep(cut - 0.06, cut + 0.10, v);
      } else if (body.surface === 'craters') {
        v = Math.pow(v, 1.4);
      } else if (body.surface === 'granules') {
        v = 0.5 + 0.5 * Math.sin(v * 14);
      }
      out[i] = clamp(v, 0, 1);
    }
    return out;
  }

  function mixHex(a, b, t) {
    const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
    const r = Math.round(((pa >> 16) & 255) * (1 - t) + ((pb >> 16) & 255) * t);
    const g = Math.round(((pa >> 8) & 255) * (1 - t) + ((pb >> 8) & 255) * t);
    const bl = Math.round((pa & 255) * (1 - t) + (pb & 255) * t);
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + bl).toString(16).slice(1);
  }

  /* Reveal wave: a cell grows from 45% to full size over REVEAL_MS.
   * markRevealed stamps each cell with a *future* time so the wave ripples
   * outward from the tap, which means the age below is negative until a cell's
   * turn arrives. The clamp is what keeps that from running the easing far
   * outside [0, 1]: unclamped, a cell 41 levels deep eases to -131 and paints
   * its corners mirrored through its own centre at 65x, filling the canvas. */
  const REVEAL_MS = 260;
  const CELL_SCALE = 0.9;

  function revealScale(now, t0) {
    return CELL_SCALE * (0.45 + 0.55 * progress(now, t0, REVEAL_MS));
  }

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
      state.terrain = buildTerrain(sphere, state.body);
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
      /* The sky and the halo follow the body in every theme, high contrast
       * included: they hold no cell state, no number and no mark, so they cost
       * no readability, and without them the globes look airless. */
      const b = state.body;
      const sky = (b && b.sky) || t.background;
      const g = ctx.createLinearGradient(0, 0, 0, state.height);
      g.addColorStop(0, sky[0]);
      g.addColorStop(1, sky[1]);
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
        state.cx, state.cy, state.radius * ((b && b.haloInner) || 0.85),
        state.cx, state.cy, state.radius * ((b && b.haloOuter) || 1.28));
      glow.addColorStop(0, (b && b.glow) || t.glow);
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

    function render(now) {
      const sphere = state.sphere;
      const game = state.game;
      if (!sphere) return;
      const theme = state.theme;
      const body = activeBody(theme, state.body);
      now = now || performance.now();

      projectAll();
      paintBackground(now);

      const d = state.cameraDistance;
      const cellPixels = state.radius * sphere.cellRadius * 1.9;
      const drawLabels = cellPixels > 11;
      const fontSize = Math.max(7, cellPixels * LABEL_RATIO * state.labelScale);
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
        let scale = CELL_SCALE;
        if (revealed) {
          const t0 = state.revealAt[i];
          if (t0 && now - t0 < REVEAL_MS) {
            scale = revealScale(now, t0);
            animating = true;
          }
        }

        /* A body may steer the light, and a self-luminous one flattens it. */
        const L = (body && body.light) || LIGHT;
        const lit = body && body.lightMix !== undefined ? body.lightMix : 1;
        const diffuse = clamp(nx * L[0] + ny * L[1] + cz * L[2], -1, 1) * lit;
        const limb = clamp(cz, 0, 1);

        let fill;
        if (revealed) {
          /* A cleared cell keeps a trace of its world. Small, deliberately:
           * this is the surface the numbers are read against. */
          const base = body
            ? mixHex(theme.revealed, body.hidden, body.revealedMix === undefined ? 0.12 : body.revealedMix)
            : theme.revealed;
          fill = shade(base, 0.06 * diffuse + 0.10 * limb);
        } else if (state.showPentagons && ring.length === 5) {
          fill = shade((body && body.pentagon) || theme.hiddenPentagon, 0.30 * diffuse + 0.10 * limb - 0.12);
        } else {
          const base = body
            ? mixHex(body.hidden, body.tint, (state.terrain ? state.terrain[i] : 0) * (body.amount || 0.5))
            : theme.hidden;
          fill = shade(base, 0.34 * diffuse + 0.12 * limb - 0.12);
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
        /* Same curve as the numbers, but a flag is never dropped: it marks a
         * decision you made, and losing sight of it would invite a second one
         * on the same cell. A tiny flag still reads as a mark. */
        const size = cellPixels * Math.max(0.18, foreshorten(limb));

        if (revealed && !isMine) {
          const n = game.adjacency[i];
          /* Cells near the silhouette are foreshortened to a sliver, so their
           * numbers shrink with them rather than spilling over the neighbours.
           * Past the point where a number would be too small to read it is
           * dropped instead: spin the globe to bring it round. */
          const labelSize = fontSize * foreshorten(limb);
          if (n > 0 && drawLabels && labelSize >= MIN_LABEL_PX) {
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
        if (t0 && now - t0 < 220) { s = size * (0.5 + 0.5 * progress(now, t0, 220)); animating = true; }
        const h = s * 0.62;
        /* The theme's marks are tuned against navy. A body far off blue, the
         * Sun above all, restates them or its flags vanish into its surface. */
        const marks = activeBody(theme, state.body);
        ctx.strokeStyle = (marks && marks.flagPole) || theme.flagPole;
        ctx.lineWidth = Math.max(0.8, s * 0.09);
        ctx.beginPath();
        ctx.moveTo(px - h * 0.18, py + h * 0.55);
        ctx.lineTo(px - h * 0.18, py - h * 0.6);
        ctx.stroke();
        ctx.fillStyle = (marks && marks.flag) || theme.flag;
        ctx.beginPath();
        ctx.moveTo(px - h * 0.18, py - h * 0.6);
        ctx.lineTo(px + h * 0.62, py - h * 0.26);
        ctx.lineTo(px - h * 0.18, py + h * 0.06);
        ctx.closePath();
        ctx.fill();
      }

      function drawMine(px, py, r, exploded, now) {
        if (exploded) {
          const k = clamp((now - state.explodedAt) / 420, 0, 1);
          const blast = r * (1 + 2.4 * progress(now, state.explodedAt, 420));
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
  global.GS.renderer = {
    createRenderer, THEMES, BODIES, revealScale, progress, foreshorten, LABEL_RATIO,
    buildTerrain, bodyForBoard, activeBody
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
