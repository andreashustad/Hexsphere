/* Hexsphere — application wiring: menus, HUD, game loop. */
(function (global) {
  'use strict';

  const { geometry, game: gameApi, renderer: rendererApi, input, storage, util } = global.GS;
  const { Q, clamp } = util;

  const DIFFICULTIES = [
    { id: 'pebble', label: 'Pebble', frequency: 3, density: 0.155, note: '92 cells' },
    { id: 'moon', label: 'Moon', frequency: 4, density: 0.175, note: '162 cells' },
    { id: 'earth', label: 'Earth', frequency: 5, density: 0.19, note: '252 cells' },
    { id: 'neptune', label: 'Neptune', frequency: 7, density: 0.2, note: '492 cells' },
    { id: 'sun', label: 'Sun', frequency: 9, density: 0.21, note: '812 cells' },
    { id: 'custom', label: 'Custom', frequency: 5, density: 0.19, note: 'your own' }
  ];

  const MODE_NOTES = {
    classic: 'Timed, no safety net. Personal bests are recorded here.',
    casual: 'A mistake can be undone once, and hints are free. Nothing is timed for records.',
    daily: 'The same board for everyone, every day. One ranked attempt.'
  };

  const $ = (id) => document.getElementById(id);

  const data = storage.load();
  const settings = data.settings;

  const el = {
    canvas: $('globe'),
    mines: $('stat-mines'),
    minesBox: $('readout-mines'),
    time: $('stat-time'),
    tag: $('difficulty-tag'),
    toast: $('toast'),
    sheet: $('sheet'),
    sheetBackdrop: $('sheet-backdrop'),
    result: $('result'),
    resultBackdrop: $('result-backdrop'),
    resultTitle: $('result-title'),
    resultLine: $('result-line'),
    resultStats: $('result-stats'),
    btnHint: $('btn-hint'),
    btnRewind: $('btn-result-rewind')
  };

  const renderer = rendererApi.createRenderer(el.canvas);
  const spheres = new Map();

  let current = null;       /* active game */
  let controls = null;      /* input handle */
  let lastTimeText = '';
  let lastMineText = '';
  let toastTimer = 0;
  let endTimer = 0;          /* the result card's delay; cancelled by a new game */
  let pendingRecord = null;

  /* ---- helpers ---------------------------------------------------------- */

  function sphereFor(frequency) {
    if (!spheres.has(frequency)) spheres.set(frequency, geometry.buildSphere(frequency));
    return spheres.get(frequency);
  }

  function difficultyById(id) {
    return DIFFICULTIES.find((d) => d.id === id) || DIFFICULTIES[2];
  }

  function formatTime(ms) {
    const total = Math.floor(ms / 1000);
    const s = total % 60;
    const m = Math.floor(total / 60) % 60;
    const h = Math.floor(total / 3600);
    const mm = h ? String(m).padStart(2, '0') : String(m);
    return (h ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
  }

  function buzz(pattern) {
    if (!settings.vibrate || !global.navigator || !navigator.vibrate) return;
    try { navigator.vibrate(pattern); } catch (err) { /* ignore */ }
  }

  function toast(message, kind) {
    el.toast.textContent = message;
    el.toast.className = 'toast is-visible' + (kind ? ' is-' + kind : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.className = 'toast'; }, 3200);
  }

  /* ---- starting a game --------------------------------------------------- */

  /* The daily board is derived from the date alone, so every player gets the
   * identical puzzle, opened at the identical first cell. */
  function dailyPlan(dateKey) {
    const rng = util.makeRng('hexsphere-daily-' + dateKey);
    const pool = ['moon', 'earth', 'earth', 'neptune'];
    const pick = difficultyById(pool[rng.int(pool.length)]);
    const sphere = sphereFor(pick.frequency);
    return {
      difficulty: pick,
      sphere,
      mineCount: Math.round(sphere.count * pick.density),
      seed: 'hexsphere-daily-' + dateKey,
      start: rng.int(sphere.count)
    };
  }

  function currentPlan() {
    if (settings.mode === 'daily') return dailyPlan(storage.todayKey());
    const pick = difficultyById(settings.difficulty);
    let frequency = pick.frequency;
    let density = pick.density;
    if (pick.id === 'custom') {
      frequency = geometry.frequencyForCells(settings.customCells);
      density = settings.customDensity;
    }
    const sphere = sphereFor(frequency);
    return {
      difficulty: pick,
      sphere,
      mineCount: clamp(Math.round(sphere.count * density), 1, sphere.count - 12),
      seed: String(Date.now()) + ':' + Math.random(),
      start: -1
    };
  }

  function recordKey(plan) {
    if (settings.mode === 'daily') return 'daily';
    if (plan.difficulty.id === 'custom') return 'custom:' + plan.sphere.count + ':' + Math.round(settings.customDensity * 100);
    return plan.difficulty.id;
  }

  function newGame() {
    const plan = currentPlan();
    clearTimeout(endTimer);
    endTimer = 0;
    current = {
      plan,
      game: gameApi.createGame({
        sphere: plan.sphere,
        mineCount: plan.mineCount,
        seed: plan.seed,
        noGuess: settings.noGuess,
        allowRewind: settings.mode === 'casual'
      }),
      recorded: false,
      rewound: false,
      warnedUnguaranteed: false
    };

    renderer.setSphere(plan.sphere);
    renderer.state.game = current.game;
    renderer.state.showMines = false;
    renderer.state.hintCell = -1;
    renderer.state.explodedAt = 0;
    renderer.state.orientation = Q.identity();
    renderer.state.dirty = true;
    controls && controls.stopSpin();

    if (plan.start >= 0) {
      const opened = current.game.openAt(plan.start);
      if (opened) renderer.markRevealed(opened.opened, performance.now());
      renderer.state.orientation = renderer.orientationFacing(plan.start);
      /* The daily generates its board here rather than on the first tap, so
       * this is where its guarantee is known. */
      warnIfNotGuaranteed();
    }

    hideResult();
    el.tag.textContent = plan.difficulty.label + ' · ' + plan.sphere.count + ' cells' +
      (settings.mode === 'daily' ? ' · daily ' + storage.todayKey() : '');
    lastTimeText = lastMineText = '';
    updateHud(true);
    updateHintButton();
  }

  /* ---- HUD --------------------------------------------------------------- */

  function updateHud() {
    if (!current) return;
    const g = current.game;
    const mineText = String(g.remainingMines());
    if (mineText !== lastMineText) {
      el.mines.textContent = mineText;
      el.minesBox.classList.toggle('is-zero', g.remainingMines() === 0);
      lastMineText = mineText;
    }
    const timeText = formatTime(g.elapsed());
    if (timeText !== lastTimeText) {
      el.time.textContent = timeText;
      lastTimeText = timeText;
    }
  }

  function updateHintButton() {
    const playable = current && (current.game.state === 'playing' || current.game.state === 'ready');
    el.btnHint.disabled = !playable;
  }

  /* ---- moves -------------------------------------------------------------- */

  /* The result card is delayed so the explosion or the win can play out. Start
   * a new game inside that window and the pending call would otherwise read
   * the fresh game and book a loss against a board nobody played, resetting
   * the streak. Both the cancel and the identity check below are needed: the
   * cancel handles a new game, the check handles anything else that replaces
   * current.game while a timer is in flight. */
  function scheduleEndOfGame(delay) {
    const scheduledFor = current.game;
    clearTimeout(endTimer);
    endTimer = setTimeout(function () {
      endTimer = 0;
      if (current && current.game === scheduledFor) endOfGame();
    }, delay);
  }

  /* The generator can give up and hand back a board that needs a guess. Saying
   * nothing would make the game look unfair rather than honest, since the help
   * text promises the opposite. */
  function warnIfNotGuaranteed() {
    if (!settings.noGuess || current.warnedUnguaranteed) return;
    if (current.game.state === 'ready' || current.game.guaranteed) return;
    current.warnedUnguaranteed = true;
    toast('This board could not be made guess-free. It may need a guess.', 'bad');
  }

  function applyResult(result) {
    if (!result || !result.ok) return;
    warnIfNotGuaranteed();
    const now = performance.now();
    if (result.opened.length) {
      renderer.markRevealed(result.opened, now);
      buzz(result.opened.length > 12 ? 18 : 8);
    }
    for (const cell of result.flagged) renderer.state.flagAt[cell] = now;
    renderer.state.dirty = true;

    if (result.exploded >= 0) {
      renderer.state.explodedAt = now;
      renderer.state.showMines = true;
      buzz([0, 40, 60, 90]);
      scheduleEndOfGame(520);
    } else if (current.game.state === 'won') {
      buzz([0, 25, 45, 25, 45, 60]);
      scheduleEndOfGame(380);
    }
    updateHintButton();
  }

  /* Double tap, or Space from the keyboard. */
  function openCell(cell) {
    const g = current.game;
    if (g.state === 'won' || g.state === 'lost') return;
    if (g.flags[cell] === gameApi.FLAG_MINE) { toast('Unflag it first to open it.'); return; }
    applyResult(g.reveal(cell));
  }

  /* Tap on a revealed number. */
  function chord(cell) {
    const g = current.game;
    if (g.state === 'won' || g.state === 'lost') return;
    if (settings.autoChord) applyResult(g.chord(cell));
  }

  /* Tap on a hidden cell, or right-click, or F from the keyboard. */
  function flag(cell) {
    const g = current.game;
    if (g.state === 'ready') {
      toast('Double tap to open a cell first. The mines are placed on your first open.');
      return;
    }
    if (g.state !== 'playing') return;
    /* Right-click does not route through the tap handler, so it can still
     * arrive on a revealed cell. */
    if (g.revealed[cell]) { chord(cell); return; }
    const result = g.toggleFlag(cell, settings.questionMarks);
    if (result.ok) {
      renderer.state.flagAt[cell] = performance.now();
      renderer.state.dirty = true;
      buzz(12);
      updateHud();
    }
  }

  function askHint() {
    if (!current) return;
    const g = current.game;
    g.focus = renderer.focusDirection();
    const hint = g.hint();
    if (hint.cells && hint.cells.length) {
      const cell = hint.cells[0];
      renderer.state.hintCell = cell;
      renderer.state.hintAt = performance.now();
      spinTo(cell);
    }
    renderer.state.dirty = true;
    toast(hint.message || 'Nothing to suggest.', hint.kind === 'guess' ? 'bad' : 'good');
  }

  /* Ease the globe round so a cell comes to the front. */
  function spinTo(cell) {
    const target = renderer.orientationFacing(cell);
    const from = renderer.state.orientation;
    const startedAt = performance.now();
    controls && controls.stopSpin();
    (function step() {
      const t = clamp((performance.now() - startedAt) / 420, 0, 1);
      const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      renderer.state.orientation = Q.slerp(from, target, eased);
      renderer.state.dirty = true;
      if (t < 1) requestAnimationFrame(step);
    })();
  }

  /* ---- end of game --------------------------------------------------------- */

  function endOfGame() {
    const g = current.game;
    const won = g.state === 'won';
    const plan = current.plan;
    /* Read the rule before the daily history is written below, or today's own
     * attempt would count as the replay that disqualifies it. */
    const ranked = storage.isRanked(data, {
      mode: settings.mode,
      rewound: current.rewound,
      hintsUsed: g.hintsUsed,
      guaranteed: g.guaranteed
    });
    let isBest = false;

    if (!current.recorded) {
      current.recorded = true;
      isBest = storage.recordResult(data, recordKey(plan), won, g.elapsed(), { ranked: ranked });
      if (settings.mode === 'daily') {
        data.daily[storage.todayKey()] = {
          won, time: g.elapsed(), hints: g.hintsUsed, cells: plan.sphere.count
        };
        storage.save(data);
      }
      renderStats();
    }

    el.result.className = 'result ' + (won ? 'is-win' : 'is-loss');
    el.resultTitle.textContent = won ? 'Sphere cleared' : 'Boom';
    el.resultLine.textContent = won
      ? plan.difficulty.label + ' · ' + plan.sphere.count + ' cells · ' + g.mineCount + ' mines'
      : (g.allowRewind ? 'You can step back one move and keep going.' : 'That cell was a mine.');

    const stats = [
      ['Time', formatTime(g.elapsed())],
      ['Opened', g.revealedCount + '/' + g.safeCells]
    ];
    if (g.hintsUsed) stats.push(['Hints', String(g.hintsUsed)]);
    if (g.mistakes) stats.push(['Undos', String(g.mistakes)]);
    el.resultStats.innerHTML = stats.map(function (s) {
      return '<div class="result-stat"><b>' + s[1] + '</b><span>' + s[0] + '</span></div>';
    }).join('') + (isBest ? '<div class="badge">New personal best</div>' : '');

    el.btnRewind.hidden = !(g.state === 'lost' && g.allowRewind);
    showResult();
  }

  function showResult() {
    el.result.hidden = false;
    el.resultBackdrop.hidden = false;
  }

  function hideResult() {
    el.result.hidden = true;
    el.resultBackdrop.hidden = true;
  }

  /* ---- menus and settings --------------------------------------------------- */

  function openSheet(tab) {
    el.sheet.hidden = false;
    el.sheetBackdrop.hidden = false;
    if (tab) selectTab(tab);
    renderStats();
  }

  function closeSheet() {
    el.sheet.hidden = true;
    el.sheetBackdrop.hidden = true;
  }

  function selectTab(name) {
    document.querySelectorAll('.tab').forEach(function (t) {
      const on = t.dataset.tab === name;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    document.querySelectorAll('.panel').forEach(function (p) {
      p.classList.toggle('is-active', p.dataset.panel === name);
    });
  }

  function buildDifficultyChips() {
    const wrap = $('difficulty-chips');
    wrap.innerHTML = '';
    for (const d of DIFFICULTIES) {
      const cells = d.id === 'custom'
        ? settings.customCells + ' cells'
        : geometry.cellCountFor(d.frequency) + ' cells · ' +
          Math.round(geometry.cellCountFor(d.frequency) * d.density) + ' mines';
      const b = document.createElement('button');
      b.className = 'chip' + (settings.difficulty === d.id ? ' is-active' : '');
      b.dataset.difficulty = d.id;
      b.innerHTML = d.label + '<small>' + cells + '</small>';
      b.addEventListener('click', function () {
        settings.difficulty = d.id;
        if (settings.mode === 'daily') setMode('classic');
        storage.save(data);
        buildDifficultyChips();
        $('custom-box').hidden = d.id !== 'custom';
      });
      wrap.appendChild(b);
    }
    $('custom-box').hidden = settings.difficulty !== 'custom';
  }

  function buildThemeChips() {
    const wrap = $('theme-chips');
    wrap.innerHTML = '';
    Object.keys(rendererApi.THEMES).forEach(function (key) {
      const theme = rendererApi.THEMES[key];
      const b = document.createElement('button');
      b.className = 'chip' + (settings.theme === key ? ' is-active' : '');
      b.textContent = theme.name;
      b.addEventListener('click', function () {
        settings.theme = key;
        applyTheme();
        storage.save(data);
        buildThemeChips();
      });
      wrap.appendChild(b);
    });
  }

  function applyTheme() {
    const theme = rendererApi.THEMES[settings.theme] || rendererApi.THEMES.midnight;
    renderer.state.theme = theme;
    renderer.state.dirty = true;
    document.documentElement.dataset.theme = settings.theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme.background[0]);
  }

  function setMode(mode) {
    settings.mode = mode;
    document.querySelectorAll('#mode-chips .chip').forEach(function (c) {
      c.classList.toggle('is-active', c.dataset.mode === mode);
    });
    let note = MODE_NOTES[mode];
    if (mode === 'daily') {
      const played = data.daily[storage.todayKey()];
      if (played) {
        note += ' Today: ' + (played.won ? 'cleared in ' + formatTime(played.time) : 'lost') +
          '. Replays are unranked.';
      }
    }
    $('mode-note').textContent = note;
    storage.save(data);
  }

  function renderStats() {
    const rate = data.totals.played ? Math.round((data.totals.won / data.totals.played) * 100) : 0;
    $('totals').innerHTML = [
      ['Played', data.totals.played],
      ['Won', data.totals.won],
      ['Win rate', rate + '%'],
      ['Streak', data.totals.streak],
      ['Best streak', data.totals.bestStreak]
    ].map(function (t) {
      return '<div class="total-card"><b>' + t[1] + '</b><span>' + t[0] + '</span></div>';
    }).join('');

    const rows = [];
    for (const d of DIFFICULTIES) {
      if (d.id === 'custom') continue;
      const r = data.records[d.id];
      rows.push('<tr><td>' + d.label + '</td><td>' + (r ? r.won : 0) + '</td><td>' +
        (r && r.best !== null && r.best !== undefined ? formatTime(r.best) : '—') + '</td></tr>');
    }
    const daily = data.records.daily;
    rows.push('<tr><td>Daily</td><td>' + (daily ? daily.won : 0) + '</td><td>' +
      (daily && daily.best != null ? formatTime(daily.best) : '—') + '</td></tr>');
    $('records-body').innerHTML = rows.join('');
  }

  function bindToggle(id, key, onChange) {
    const node = $(id);
    node.checked = !!settings[key];
    node.addEventListener('change', function () {
      settings[key] = node.checked;
      storage.save(data);
      onChange && onChange(node.checked);
    });
  }

  /* ---- wiring -------------------------------------------------------------- */

  function bindUi() {
    $('btn-menu').addEventListener('click', function () { openSheet('play'); });
    $('sheet-close').addEventListener('click', closeSheet);
    el.sheetBackdrop.addEventListener('click', closeSheet);
    $('btn-new').addEventListener('click', function () { newGame(); });
    $('btn-start').addEventListener('click', function () { closeSheet(); newGame(); });

    document.querySelectorAll('.tab').forEach(function (t) {
      t.addEventListener('click', function () { selectTab(t.dataset.tab); });
    });
    document.querySelectorAll('#mode-chips .chip').forEach(function (c) {
      c.addEventListener('click', function () { setMode(c.dataset.mode); });
    });

    el.btnHint.addEventListener('click', askHint);
    $('btn-zoom-in').addEventListener('click', function () { renderer.setZoom(renderer.state.zoom * 1.25); });
    $('btn-zoom-out').addEventListener('click', function () { renderer.setZoom(renderer.state.zoom / 1.25); });

    $('btn-result-again').addEventListener('click', function () { newGame(); });
    $('btn-result-look').addEventListener('click', hideResult);
    el.btnRewind.addEventListener('click', function () {
      if (current.game.rewind()) {
        current.rewound = true;
        current.recorded = true;
        renderer.state.showMines = false;
        renderer.state.explodedAt = 0;
        renderer.state.dirty = true;
        hideResult();
        updateHud();
        updateHintButton();
        toast('Stepped back. That cell is flagged now.', 'good');
      }
    });

    bindToggle('opt-noguess', 'noGuess');
    bindToggle('opt-autochord', 'autoChord');
    bindToggle('opt-question', 'questionMarks');
    bindToggle('opt-vibrate', 'vibrate');
    bindToggle('opt-pentagons', 'markPentagons', function (on) {
      renderer.state.showPentagons = on;
      renderer.state.dirty = true;
    });

    const scale = $('opt-labelscale');
    scale.value = Math.round(settings.labelScale * 100);
    $('label-scale-value').textContent = scale.value + '%';
    scale.addEventListener('input', function () {
      settings.labelScale = scale.value / 100;
      $('label-scale-value').textContent = scale.value + '%';
      renderer.state.labelScale = settings.labelScale;
      renderer.state.dirty = true;
      storage.save(data);
    });

    const cells = $('custom-cells');
    const density = $('custom-density');
    cells.value = settings.customCells;
    density.value = Math.round(settings.customDensity * 100);
    function syncCustom() {
      const frequency = geometry.frequencyForCells(Number(cells.value));
      const count = geometry.cellCountFor(frequency);
      settings.customCells = count;
      settings.customDensity = Number(density.value) / 100;
      $('custom-cells-label').textContent = count;
      $('custom-density-label').textContent = density.value + '% · ' +
        Math.round(count * settings.customDensity) + ' mines';
      storage.save(data);
      buildDifficultyChips();
    }
    cells.addEventListener('input', syncCustom);
    density.addEventListener('input', syncCustom);
    syncCustom();

    $('btn-reset-stats').addEventListener('click', function () {
      if (!global.confirm('Clear all times and statistics?')) return;
      data.records = {};
      data.daily = {};
      data.totals = { played: 0, won: 0, streak: 0, bestStreak: 0 };
      storage.save(data);
      renderStats();
      toast('Statistics cleared.');
    });
  }

  /* Returns true when this handler has taken the key, which stops the globe
   * from also acting on it. */
  function onKey(e) {
    if (e.key === 'Escape') {
      if (!el.sheet.hidden) closeSheet();
      else if (!el.result.hidden) hideResult();
      return true;
    }
    /* While the sheet is open it owns the keyboard: its sliders are driven
     * with the arrow keys, and the globe behind it must stay put. */
    if (!el.sheet.hidden) return true;
    const centre = function () {
      return renderer.pickCell(renderer.state.cx, renderer.state.cy);
    };
    switch (e.key.toLowerCase()) {
      case ' ': case 'enter': openCell(centre()); e.preventDefault(); break;
      case 'f': flag(centre()); break;
      case 'c': applyResult(current.game.chord(centre())); break;
      case 'h': askHint(); break;
      case 'n': newGame(); break;
      default: return false;
    }
    return true;
  }

  /* ---- boot ------------------------------------------------------------------ */

  function loop(now) {
    if (controls) controls.applyInertia();
    if (renderer.state.dirty) renderer.render(now);
    updateHud();
    requestAnimationFrame(loop);
  }

  /* Home-screen shortcuts land here: ?mode=daily or ?new=1.
   *
   * KNOWN BUG, see BACKLOG item 6: the mode is still written into settings and
   * persisted, so one tap on the Daily shortcut changes every later normal
   * launch. Parsing now goes through the tested storage.launchOverrides, but
   * the fix needs a decision about where a session-only mode should live,
   * because settings.mode is read in ten places and data.settings is the same
   * object the whole app saves. */
  function applyLaunchParams() {
    const wanted = storage.launchOverrides(location.search);
    if (wanted.mode && MODE_NOTES[wanted.mode]) settings.mode = wanted.mode;
    storage.save(data);
  }

  function start() {
    applyLaunchParams();
    applyTheme();
    renderer.state.showPentagons = settings.markPentagons;
    renderer.state.labelScale = settings.labelScale;
    renderer.resize();

    controls = input.attachInput(renderer, {
      isRevealed: (cell) => !!(current && current.game.revealed[cell]),
      onOpen: openCell,
      onChord: chord,
      onFlag: flag,
      onKey: onKey,
      onZoom: function () { renderer.state.dirty = true; }
    });

    bindUi();
    buildDifficultyChips();
    buildThemeChips();
    setMode(settings.mode);
    renderStats();
    newGame();

    global.addEventListener('resize', function () { renderer.resize(); });
    global.addEventListener('orientationchange', function () { setTimeout(function () { renderer.resize(); }, 150); });
    document.addEventListener('visibilitychange', function () { renderer.state.dirty = true; });

    requestAnimationFrame(loop);

    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
      navigator.serviceWorker.register('sw.js').catch(function () { /* offline support is optional */ });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  global.GS.app = { DIFFICULTIES, newGame: function () { newGame(); }, renderer };
})(typeof globalThis !== 'undefined' ? globalThis : this);
