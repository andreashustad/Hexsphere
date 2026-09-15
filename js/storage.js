/* Hexsphere — settings, records and daily-challenge history.
 * Everything lives in localStorage; the game works fine without it. */
(function (global) {
  'use strict';

  const KEY = 'hexsphere.v1';

  const DEFAULT_SETTINGS = {
    theme: 'midnight',
    difficulty: 'earth',
    mode: 'classic',
    noGuess: true,
    questionMarks: false,
    vibrate: true,
    sound: false,
    markPentagons: true,
    autoChord: true,
    labelScale: 1,
    customCells: 252,
    customDensity: 0.19
  };

  function load() {
    let saved = {};
    try {
      const raw = global.localStorage && global.localStorage.getItem(KEY);
      if (raw) saved = JSON.parse(raw) || {};
    } catch (err) { saved = {}; }
    return {
      settings: Object.assign({}, DEFAULT_SETTINGS, saved.settings || {}),
      records: saved.records || {},
      daily: saved.daily || {},
      totals: Object.assign({ played: 0, won: 0, streak: 0, bestStreak: 0 }, saved.totals || {})
    };
  }

  function save(data) {
    try {
      global.localStorage && global.localStorage.setItem(KEY, JSON.stringify(data));
    } catch (err) { /* private browsing, quota — the game still plays */ }
  }

  /* Records a finished game and reports whether it set a personal best. */
  function recordResult(data, key, won, timeMs, meta) {
    data.totals.played++;
    if (won) {
      data.totals.won++;
      data.totals.streak++;
      data.totals.bestStreak = Math.max(data.totals.bestStreak, data.totals.streak);
    } else {
      data.totals.streak = 0;
    }
    const rec = data.records[key] || { played: 0, won: 0, best: null, bestAt: 0, totalTime: 0 };
    rec.played++;
    let isBest = false;
    /* Hints and undos still count as a win, but they do not set a record. */
    const ranked = !meta || meta.ranked !== false;
    if (won) {
      rec.won++;
      rec.totalTime += timeMs;
      if (ranked && (rec.best === null || timeMs < rec.best)) {
        rec.best = timeMs;
        rec.bestAt = Date.now();
        isBest = true;
      }
    }
    data.records[key] = rec;
    save(data);
    return isBest;
  }

  /* Home-screen shortcuts arrive as query parameters. They describe this launch
   * only: writing them into settings meant one tap on the Daily shortcut
   * switched every later normal launch to daily mode. */
  function launchOverrides(search) {
    try {
      const params = new global.URLSearchParams(search || '');
      return { mode: params.get('mode'), newGame: params.get('new') === '1' };
    } catch (err) {
      return { mode: null, newGame: false };
    }
  }

  /* Whether a finished game may set a personal best. The UI promises the daily
   * is "one ranked attempt", so the daily history is the authority on that
   * rather than anything the caller tracks; and a board the generator gave up
   * on may need a coin flip, so its time is not comparable with the rest. */
  function isRanked(data, attempt) {
    if (attempt.mode === 'casual') return false;
    if (attempt.rewound) return false;
    if (attempt.hintsUsed > 0) return false;
    if (!attempt.guaranteed) return false;
    if (attempt.mode === 'daily' && data.daily[attempt.today || todayKey()]) return false;
    return true;
  }

  function todayKey(date) {
    const d = date || new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  global.GS = global.GS || {};
  global.GS.storage = {
    load, save, recordResult, isRanked, launchOverrides, todayKey, DEFAULT_SETTINGS, KEY
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
