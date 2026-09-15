#!/usr/bin/env node
/* Hexsphere test suite. Run with: node tests/run.js
 *
 * The game modules are plain browser scripts, so they are loaded into a fake
 * global here rather than imported. */
'use strict';

const path = require('path');
const vm = require('vm');
const fs = require('fs');

const sandbox = { performance: { now: () => Date.now() }, URLSearchParams };
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

/* localStorage stub, so the storage module can be exercised too. */
const store = new Map();
sandbox.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k)
};

vm.createContext(sandbox);
for (const name of ['util', 'geometry', 'solver', 'game', 'storage', 'renderer', 'input']) {
  const file = path.join(__dirname, '..', 'js', name + '.js');
  vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
}

const GS = sandbox.GS;
const { buildSphere, cellCountFor, frequencyForCells } = GS.geometry;
const { makeRng, V } = GS.util;

/* ---- tiny test harness ------------------------------------------------- */

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const OFF = '\x1b[0m';

let passed = 0;
const failures = [];
let group = '';

function describe(name, fn) {
  group = name;
  console.log('\n' + name);
  fn();
}

/* A test may return a promise; those settle before the summary is printed. */
const pending = [];

function it(name, fn) {
  const where = group + ' > ' + name;
  function ok() {
    passed++;
    console.log('  ' + GREEN + 'ok' + OFF + '   ' + name);
  }
  function bad(err) {
    failures.push({ name: where, err });
    console.log('  ' + RED + 'FAIL' + OFF + ' ' + name + '\n       ' + err.message);
  }
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      pending.push(result.then(ok, bad));
      return;
    }
    ok();
  } catch (err) {
    bad(err);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message || 'assertion failed');
}

function equal(actual, expected, message) {
  if (actual !== expected) {
    throw new Error((message || 'values differ') + ': expected ' + expected + ', got ' + actual);
  }
}

/* ---- geometry ----------------------------------------------------------- */

describe('geometry', function () {
  it('produces 10f^2 + 2 cells at every frequency', function () {
    for (let f = 1; f <= 8; f++) {
      equal(buildSphere(f).count, cellCountFor(f), 'cell count at f=' + f);
    }
  });

  it('is always twelve pentagons and the rest hexagons', function () {
    for (const f of [2, 3, 5, 7]) {
      const sphere = buildSphere(f);
      let pent = 0;
      let hex = 0;
      for (let i = 0; i < sphere.count; i++) {
        const sides = sphere.cellCorners[i].length;
        if (sides === 5) pent++;
        else if (sides === 6) hex++;
        else throw new Error('cell ' + i + ' has ' + sides + ' sides at f=' + f);
      }
      equal(pent, 12, 'pentagons at f=' + f);
      equal(hex, sphere.count - 12, 'hexagons at f=' + f);
    }
  });

  it('gives every cell as many neighbours as it has sides', function () {
    const sphere = buildSphere(4);
    for (let i = 0; i < sphere.count; i++) {
      equal(sphere.neighbors[i].length, sphere.cellCorners[i].length, 'degree of cell ' + i);
    }
  });

  it('has symmetric adjacency with no self-links or duplicates', function () {
    const sphere = buildSphere(5);
    for (let i = 0; i < sphere.count; i++) {
      const seen = new Set();
      for (const j of sphere.neighbors[i]) {
        assert(j !== i, 'cell ' + i + ' lists itself');
        assert(!seen.has(j), 'duplicate neighbour in cell ' + i);
        seen.add(j);
        assert(sphere.neighbors[j].includes(i), 'adjacency not symmetric between ' + i + ' and ' + j);
      }
    }
  });

  it('is one connected surface', function () {
    const sphere = buildSphere(4);
    const seen = new Uint8Array(sphere.count);
    const stack = [0];
    seen[0] = 1;
    let n = 1;
    while (stack.length) {
      for (const j of sphere.neighbors[stack.pop()]) {
        if (!seen[j]) { seen[j] = 1; n++; stack.push(j); }
      }
    }
    equal(n, sphere.count, 'cells reachable from cell 0');
  });

  it('keeps every centre and corner on the unit sphere', function () {
    const sphere = buildSphere(3);
    for (let i = 0; i < sphere.count; i++) {
      const len = Math.hypot(sphere.centers[i * 3], sphere.centers[i * 3 + 1], sphere.centers[i * 3 + 2]);
      assert(Math.abs(len - 1) < 1e-6, 'centre ' + i + ' has length ' + len);
    }
    for (let c = 0; c < sphere.corners.length; c += 3) {
      const len = Math.hypot(sphere.corners[c], sphere.corners[c + 1], sphere.corners[c + 2]);
      assert(Math.abs(len - 1) < 1e-5, 'corner at ' + c + ' has length ' + len);
    }
  });

  it('winds every cell the same way, seen from outside', function () {
    const sphere = buildSphere(3);
    for (let i = 0; i < sphere.count; i++) {
      const ring = sphere.cellCorners[i];
      const centre = [sphere.centers[i * 3], sphere.centers[i * 3 + 1], sphere.centers[i * 3 + 2]];
      let normal = [0, 0, 0];
      for (let k = 0; k < ring.length; k++) {
        const a = ring[k];
        const b = ring[(k + 1) % ring.length];
        const pa = [sphere.corners[a * 3], sphere.corners[a * 3 + 1], sphere.corners[a * 3 + 2]];
        const pb = [sphere.corners[b * 3], sphere.corners[b * 3 + 1], sphere.corners[b * 3 + 2]];
        normal = V.add(normal, V.cross(pa, pb));
      }
      assert(V.dot(normal, centre) > 0, 'cell ' + i + ' is wound the wrong way');
    }
  });

  it('places the corners of a cell evenly around it', function () {
    const sphere = buildSphere(4);
    for (let i = 0; i < sphere.count; i += 7) {
      const centre = [sphere.centers[i * 3], sphere.centers[i * 3 + 1], sphere.centers[i * 3 + 2]];
      for (const t of sphere.cellCorners[i]) {
        const corner = [sphere.corners[t * 3], sphere.corners[t * 3 + 1], sphere.corners[t * 3 + 2]];
        const angle = Math.acos(Math.min(1, V.dot(centre, corner)));
        assert(angle < sphere.cellRadius * 1.25 && angle > sphere.cellRadius * 0.75,
          'corner distance ' + angle + ' vs radius ' + sphere.cellRadius);
      }
    }
  });

  it('maps a requested cell count to the smallest frequency that fits', function () {
    equal(frequencyForCells(92), 3, 'exact fit');
    equal(frequencyForCells(93), 4, 'one over');
    assert(cellCountFor(frequencyForCells(1000)) >= 1000, 'covers the request');
  });
});

/* ---- solver -------------------------------------------------------------- */

describe('solver', function () {
  const S = GS.solver;

  function viewOf(sphere, mines, revealedCells, flaggedCells) {
    const adj = S.adjacencyCounts(sphere, mines);
    const view = S.createView(sphere.count);
    for (const c of revealedCells) { view.revealed[c] = 1; view.counts[c] = adj[c]; }
    for (const c of flaggedCells || []) view.flagged[c] = 1;
    return view;
  }

  it('calls the neighbours of a zero safe', function () {
    const sphere = buildSphere(3);
    const mines = new Uint8Array(sphere.count);
    mines[50] = 1;
    const view = viewOf(sphere, mines, [0], []);
    const step = S.deduce(sphere, view, 1, { useExhaustive: false });
    for (const n of sphere.neighbors[0]) assert(step.safe.includes(n), 'neighbour ' + n + ' should be safe');
  });

  it('flags when a number has exactly as many unknowns as mines', function () {
    const sphere = buildSphere(3);
    const mines = new Uint8Array(sphere.count);
    const cell = 0;
    const nb = sphere.neighbors[cell];
    for (const n of nb) mines[n] = 1;
    const view = viewOf(sphere, mines, [cell], []);
    const step = S.deduce(sphere, view, nb.length, { useExhaustive: false });
    for (const n of nb) assert(step.mines.includes(n), 'neighbour ' + n + ' should be a known mine');
  });

  it('uses the remaining-mine count to finish a board', function () {
    const sphere = buildSphere(3);
    const mines = new Uint8Array(sphere.count);
    mines[7] = 1;
    const revealed = [];
    for (let i = 0; i < sphere.count; i++) if (i !== 7 && i !== 8) revealed.push(i);
    const view = viewOf(sphere, mines, revealed, [7]);
    const step = S.deduce(sphere, view, 1, { useExhaustive: false });
    assert(step.safe.includes(8), 'the last cell must be safe once every mine is flagged');
  });

  it('never claims a safe cell that holds a mine', function () {
    const sphere = buildSphere(4);
    for (let seed = 0; seed < 12; seed++) {
      const rng = makeRng('solver-safety-' + seed);
      const start = rng.int(sphere.count);
      const mineCount = 30;
      const built = S.generateBoard(sphere, mineCount, start, rng, { noGuess: false });
      const adj = S.adjacencyCounts(sphere, built.field);
      const view = S.createView(sphere.count);
      S.revealInto(sphere, built.field, adj, view, start, null);
      for (let round = 0; round < 40; round++) {
        const step = S.deduce(sphere, view, mineCount, {});
        if (!step.safe.length && !step.mines.length) break;
        for (const c of step.safe) {
          assert(!built.field[c], 'solver called cell ' + c + ' safe but it is a mine');
          S.revealInto(sphere, built.field, adj, view, c, null);
        }
        for (const c of step.mines) {
          assert(built.field[c], 'solver called cell ' + c + ' a mine but it is safe');
          view.flagged[c] = 1;
        }
      }
    }
  });

  it('computes exact probabilities that account for every remaining mine', function () {
    const sphere = buildSphere(4);
    let checked = 0;
    for (let seed = 0; seed < 200 && checked < 3; seed++) {
      const rng = makeRng('probability-' + seed);
      const mineCount = Math.round(sphere.count * 0.34);
      const start = rng.int(sphere.count);
      const built = S.generateBoard(sphere, mineCount, start, rng, { noGuess: false });
      const result = S.solveBoard(sphere, built.field, mineCount, start);
      if (result.solved || !result.stuck || !result.stuck.probabilities) continue;
      checked++;
      let flagged = 0;
      for (let i = 0; i < sphere.count; i++) if (result.view.flagged[i]) flagged++;
      let sum = 0;
      for (const [, p] of result.stuck.probabilities) sum += p;
      assert(Math.abs(sum - (mineCount - flagged)) < 1e-6,
        'probabilities sum to ' + sum + ', expected ' + (mineCount - flagged));
      for (const [cell, p] of result.stuck.probabilities) {
        assert(p >= -1e-9 && p <= 1 + 1e-9, 'probability out of range for cell ' + cell);
      }
    }
    assert(checked > 0, 'no guess-required board was produced to check');
  });

  it('keeps the opening move and its neighbours clear of mines', function () {
    const sphere = buildSphere(4);
    for (let seed = 0; seed < 8; seed++) {
      const rng = makeRng('opening-' + seed);
      const start = rng.int(sphere.count);
      const built = S.generateBoard(sphere, 30, start, rng, {});
      assert(!built.field[start], 'the first cell must be safe');
      for (const n of sphere.neighbors[start]) {
        assert(!built.field[n], 'neighbour ' + n + ' of the opening must be safe');
      }
    }
  });

  /* The opening click is always a zero cell, because the solver needs a
   * foothold, so it always cascades. On a small board that cascade was handing
   * over two thirds of the game before the player had read anything. */
  it('stops the first click from giving the board away', function () {
    const sphere = buildSphere(3);
    const mines = Math.round(sphere.count * 0.155);
    let over = 0;
    for (let r = 0; r < 12; r++) {
      const g = GS.game.createGame({ sphere, mineCount: mines, seed: 'cap-' + r, noGuess: true });
      g.openAt(r % sphere.count);
      if (g.revealedCount / g.safeCells > 0.35) over++;
    }
    equal(over, 0, 'no opening should clear more than a third of the safe cells');
  });

  /* A cap the board comfortably meets must be accepted at once. Without this,
   * a cap that silently evaluates to NaN still looks fine from the outside:
   * every board is rejected, the fallback quietly minimises the opening
   * instead of capping it, and the generator burns 200 solver runs per board
   * to get there. That is exactly what happened. */
  it('accepts a board that meets the cap instead of hunting for a smaller one', function () {
    const sphere = buildSphere(5);
    const g = GS.game.createGame({
      sphere, mineCount: 48, seed: 'generous-cap', noGuess: true, maxOpening: 0.9
    });
    g.openAt(0);
    assert(g.generation.attempts < 25,
      'took ' + g.generation.attempts + ' attempts for a cap almost any board meets');
    assert(!g.generation.openingOverCap, 'and did not fall back');
  });

  it('still finds a board when the cap cannot be met, rather than looping', function () {
    const sphere = buildSphere(3);
    const g = GS.game.createGame({
      sphere, mineCount: 14, seed: 'impossible-cap', noGuess: true, maxOpening: 0.001
    });
    const result = g.openAt(0);
    assert(result !== null, 'a board is still produced');
    assert(g.revealedCount > 0, 'and it still opens something');
  });

  /* Guards the largest board the UI offers. This one passes the moment it is
   * written, so it proves nothing about today; it exists so that raising the
   * cap again, or making generation more expensive, fails here rather than in
   * someone's hands. */
  it('still builds a guess-free board at the largest size offered', function () {
    const sphere = buildSphere(GS.geometry.frequencyForCells(4002));
    assert(sphere.count >= 4002, 'the frequency covers the requested size');
    const g = GS.game.createGame({
      sphere, mineCount: Math.round(sphere.count * 0.19), seed: 'largest', noGuess: true
    });
    const started = Date.now();
    g.openAt(0);
    assert(g.guaranteed, 'a board this size is still made guess-free');
    assert(Date.now() - started < 1500, 'and within a budget a first tap can absorb');
  });

  /* Generation is synchronous and runs on the first tap, so its time budget is
   * a freeze budget. The worst case is not the hardest board but the one just
   * past feasible: there the solver keeps almost succeeding and grinds through
   * every attempt. 4002 cells at 25% spent the full 4s and still failed. */
  it('honours its time budget, because that budget is a frozen tab', function () {
    /* 4002 cells at 25% is the measured worst case: just past feasible, where
     * the solver keeps almost succeeding and grinds through every attempt. */
    const sphere = buildSphere(GS.geometry.frequencyForCells(4002));
    const g = GS.game.createGame({
      sphere, mineCount: Math.round(sphere.count * 0.25), seed: 'corner-4002-0.25-1',
      noGuess: true, timeBudgetMs: 150
    });
    const started = Date.now();
    g.openAt(0);
    const spent = Date.now() - started;
    assert(spent < 900, 'generation took ' + spent + 'ms against a 150ms budget');
  });

  it('generates boards that can be finished without guessing', function () {
    const cases = [
      { frequency: 3, density: 0.155 },
      { frequency: 4, density: 0.175 },
      { frequency: 5, density: 0.19 },
      { frequency: 7, density: 0.2 }
    ];
    for (const c of cases) {
      const sphere = buildSphere(c.frequency);
      const mineCount = Math.round(sphere.count * c.density);
      for (let seed = 0; seed < 5; seed++) {
        const rng = makeRng('noguess-' + c.frequency + '-' + seed);
        const start = rng.int(sphere.count);
        const built = S.generateBoard(sphere, mineCount, start, rng, {});
        assert(built.guaranteed, 'no guess-free board found at f=' + c.frequency + ' seed ' + seed);
        const check = S.solveBoard(sphere, built.field, mineCount, start);
        assert(check.solved, 'generated board is not actually solvable at f=' + c.frequency);
        let placed = 0;
        for (let i = 0; i < sphere.count; i++) if (built.field[i]) placed++;
        equal(placed, mineCount, 'mines placed');
      }
    }
  });
});

/* ---- game ---------------------------------------------------------------- */

describe('game', function () {
  const sphere = buildSphere(4);

  function fresh(overrides) {
    return GS.game.createGame(Object.assign({
      sphere, mineCount: 28, seed: 'test-seed', noGuess: true
    }, overrides));
  }

  function firstHidden(g) {
    for (let i = 0; i < sphere.count; i++) if (!g.revealed[i]) return i;
    return -1;
  }
  function firstMine(g) {
    for (let i = 0; i < sphere.count; i++) if (g.mines[i]) return i;
    return -1;
  }
  function findNumberedCell(g) {
    for (let i = 0; i < sphere.count; i++) if (g.revealed[i] && g.adjacency[i] > 0) return i;
    return -1;
  }
  function findNumberedCellWithClosedNeighbours(g) {
    for (let i = 0; i < sphere.count; i++) {
      if (!g.revealed[i] || g.adjacency[i] <= 0) continue;
      const closed = sphere.neighbors[i].filter((n) => !g.revealed[n]);
      if (closed.length > g.adjacency[i]) return i;
    }
    return -1;
  }

  it('places no mines until the first move', function () {
    const g = fresh();
    equal(g.state, 'ready', 'state before the first move');
    let mines = 0;
    for (let i = 0; i < sphere.count; i++) mines += g.mines[i];
    equal(mines, 0, 'mines before the first move');
  });

  it('opens a pocket on the first tap, never a mine', function () {
    for (let seed = 0; seed < 6; seed++) {
      const g = fresh({ seed: 'first-tap-' + seed });
      const cell = (seed * 17) % sphere.count;
      const result = g.reveal(cell);
      equal(g.state, 'playing', 'state after the first tap');
      equal(g.adjacency[cell], 0, 'the opening cell touches no mines');
      assert(result.opened.length > sphere.neighbors[cell].length, 'the opening should cascade');
      equal(result.exploded, -1, 'the first tap can never explode');
    }
  });

  it('counts flags and refuses to open a flagged cell', function () {
    const g = fresh();
    g.reveal(0);
    const hidden = firstHidden(g);
    g.toggleFlag(hidden, false);
    equal(g.flagCount, 1, 'flag count');
    equal(g.remainingMines(), g.mineCount - 1, 'mines remaining readout');
    const blocked = g.reveal(hidden);
    equal(blocked.ok, false, 'a flagged cell stays closed');
    g.toggleFlag(hidden, false);
    equal(g.flagCount, 0, 'flag removed');
  });

  it('cycles through question marks only when asked', function () {
    const g = fresh();
    g.reveal(0);
    const hidden = firstHidden(g);
    g.toggleFlag(hidden, true);
    equal(g.flags[hidden], 1, 'first press flags');
    g.toggleFlag(hidden, true);
    equal(g.flags[hidden], 2, 'second press marks it uncertain');
    g.toggleFlag(hidden, true);
    equal(g.flags[hidden], 0, 'third press clears');
  });

  it('opens around a satisfied number and refuses an unsatisfied one', function () {
    const g = fresh({ seed: 'chord' });
    g.reveal(0);
    const target = findNumberedCellWithClosedNeighbours(g);
    assert(target >= 0, 'needed a revealed number with closed neighbours');
    const before = g.revealedCount;
    const bad = g.chord(target);
    equal(bad.ok, false, 'chording before the flags are placed does nothing');
    for (const n of sphere.neighbors[target]) if (g.mines[n]) g.toggleFlag(n, false);
    const good = g.chord(target);
    assert(good.ok !== false && g.revealedCount > before, 'chording should open the rest');
    equal(good.exploded, -1, 'a correctly flagged chord never explodes');
  });

  it('explodes when a chord is built on a wrong flag', function () {
    const g = fresh({ seed: 'bad-chord' });
    g.reveal(0);
    const target = findNumberedCell(g);
    const neighbours = sphere.neighbors[target];
    let flags = 0;
    for (const n of neighbours) {
      if (!g.revealed[n] && flags < g.adjacency[target]) { g.toggleFlag(n, false); flags++; }
    }
    const wrong = neighbours.some((n) => g.flags[n] === 1 && !g.mines[n]);
    const result = g.chord(target);
    if (wrong) {
      equal(g.state, 'lost', 'a chord on a wrong flag loses');
      assert(result.exploded >= 0, 'the exploded cell is reported');
    }
  });

  it('wins when every safe cell is open, and flags the rest', function () {
    const g = fresh({ seed: 'win' });
    g.reveal(0);
    const S = GS.solver;
    for (let round = 0; round < 500 && g.state === 'playing'; round++) {
      const view = S.createView(sphere.count);
      for (let i = 0; i < sphere.count; i++) {
        view.revealed[i] = g.revealed[i];
        view.flagged[i] = g.flags[i] === 1 ? 1 : 0;
        view.counts[i] = g.revealed[i] ? g.adjacency[i] : -1;
      }
      const step = S.deduce(sphere, view, g.mineCount, {});
      if (!step.safe.length && !step.mines.length) break;
      for (const c of step.mines) if (g.flags[c] !== 1) g.toggleFlag(c, false);
      for (const c of step.safe) g.reveal(c);
    }
    equal(g.state, 'won', 'final state');
    equal(g.revealedCount, g.safeCells, 'every safe cell opened');
    equal(g.flagCount, g.mineCount, 'every mine flagged at the end');
    assert(g.elapsed() >= 0, 'elapsed time is recorded');
  });

  it('only ever hints at cells that are provable', function () {
    for (let seed = 0; seed < 6; seed++) {
      const g = fresh({ seed: 'hint-' + seed });
      g.reveal((seed * 11) % sphere.count);
      for (let round = 0; round < 300 && g.state === 'playing'; round++) {
        const hint = g.hint();
        if (hint.kind === 'safe') {
          assert(!g.mines[hint.cells[0]], 'hinted a "safe" cell that is a mine');
          g.reveal(hint.cells[0]);
        } else if (hint.kind === 'mine') {
          assert(g.mines[hint.cells[0]], 'hinted a "mine" that is safe');
          g.toggleFlag(hint.cells[0], false);
        } else break;
      }
      equal(g.state, 'won', 'following only certain hints should win a guess-free board');
    }
  });

  it('rewinds a fatal move in casual mode only', function () {
    const strict = fresh({ seed: 'rewind', allowRewind: false });
    strict.reveal(0);
    strict.reveal(firstMine(strict));
    equal(strict.state, 'lost', 'classic mode loses');
    equal(strict.rewind(), false, 'classic mode cannot rewind');

    const casual = fresh({ seed: 'rewind', allowRewind: true });
    casual.reveal(0);
    const openBefore = casual.revealedCount;
    const casualMine = firstMine(casual);
    casual.reveal(casualMine);
    equal(casual.state, 'lost', 'casual mode still loses the move');
    equal(casual.rewind(), true, 'casual mode can step back');
    equal(casual.state, 'playing', 'play resumes');
    equal(casual.revealedCount, openBefore, 'the board is restored');
    equal(casual.flags[casualMine], 1, 'the mine is flagged after a rewind');
    equal(casual.mistakes, 1, 'the mistake is counted');
  });

  /* reveal() checks for the win after its flood; the seeded opening used by the
   * daily challenge took a different path and never did. A daily whose opening
   * cascade clears the board would sit in 'playing' forever. */
  it('finishes the game when a seeded opening clears the whole board', function () {
    const g = fresh({ mineCount: 0, noGuess: false });
    g.openAt(0);
    equal(g.revealedCount, g.safeCells, 'the cascade cleared every safe cell');
    equal(g.state, 'won', 'so the game is over, not still playing');
  });

  it('builds an identical board from an identical seed', function () {
    const a = GS.game.createGame({ sphere, mineCount: 28, seed: 'daily-2026-01-01' });
    const b = GS.game.createGame({ sphere, mineCount: 28, seed: 'daily-2026-01-01' });
    a.openAt(42);
    b.openAt(42);
    for (let i = 0; i < sphere.count; i++) {
      equal(a.mines[i], b.mines[i], 'mine at ' + i + ' differs between two runs of the same seed');
    }
    equal(a.revealedCount, b.revealedCount, 'the same opening');
  });
});

/* ---- storage -------------------------------------------------------------- */

describe('storage', function () {
  it('starts from defaults and round-trips through localStorage', function () {
    store.clear();
    const data = GS.storage.load();
    equal(data.settings.difficulty, 'earth', 'default difficulty');
    data.settings.theme = 'vivid';
    GS.storage.save(data);
    equal(GS.storage.load().settings.theme, 'vivid', 'saved setting survives a reload');
  });

  it('tracks bests, win rate and streaks', function () {
    store.clear();
    const data = GS.storage.load();
    assert(GS.storage.recordResult(data, 'earth', true, 45000), 'a first win is a personal best');
    assert(!GS.storage.recordResult(data, 'earth', true, 60000), 'a slower win is not');
    assert(GS.storage.recordResult(data, 'earth', true, 30000), 'a faster win is');
    GS.storage.recordResult(data, 'earth', false, 12000);
    equal(data.records.earth.played, 4, 'games played');
    equal(data.records.earth.won, 3, 'games won');
    equal(data.records.earth.best, 30000, 'best time');
    equal(data.totals.streak, 0, 'a loss resets the streak');
    equal(data.totals.bestStreak, 3, 'best streak remembered');
  });

  it('formats the date key as an ISO date', function () {
    equal(GS.storage.todayKey(new Date(2026, 0, 5)), '2026-01-05', 'zero padding');
  });
});

/* ---- keyboard ------------------------------------------------------------- */

/* The globe used to claim the arrow keys before anything else saw them, so the
 * sliders in the settings sheet could not be moved from the keyboard: the value
 * stayed put and the hidden globe rotated instead. */
describe('keyboard', function () {
  const { makeKeyHandler } = GS.input;

  function press(key, delegate) {
    const rotated = [];
    const zoomed = [];
    const onKey = makeKeyHandler({ onKey: delegate }, {
      state: { radius: 1, zoom: 1 },
      rotateBy: (dx, dy) => rotated.push([dx, dy]),
      setZoom: (z) => zoomed.push(z)
    });
    let prevented = false;
    onKey({ key, shiftKey: false, preventDefault: () => { prevented = true; } });
    return { rotated, zoomed, prevented };
  }

  const claims = () => true;
  const declines = () => false;

  it('offers every key to the delegate before the globe takes it', function () {
    equal(press('ArrowLeft', claims).rotated.length, 0, 'the settings sliders need the arrows');
    equal(press('ArrowLeft', declines).rotated.length, 1, 'but the globe spins when nothing else wants them');
    equal(press('+', claims).zoomed.length, 0, 'zoom keys defer too');
  });

  it('leaves a key nobody claims completely alone', function () {
    const r = press('q', declines);
    equal(r.rotated.length, 0, 'no rotation');
    assert(!r.prevented, 'and no preventDefault, so typing elsewhere still works');
  });
});

/* ---- taps ----------------------------------------------------------------- */

/* Tap flags, double tap opens. Only hidden cells are ambiguous: a tap on a
 * revealed number can only mean chord, so it must not pay the double-tap wait.
 * Chording is frequent enough that making it wait would be felt. */
describe('taps', function () {
  const { makeTapHandler } = GS.input;

  function harness(revealedCells) {
    const log = [];
    let seq = 1;
    const timers = new Map();
    const revealed = new Set(revealedCells || []);
    const tap = makeTapHandler({
      isRevealed: (cell) => revealed.has(cell),
      onChord: (cell) => log.push('chord:' + cell),
      onFlag: (cell) => log.push('flag:' + cell),
      onOpen: (cell) => log.push('open:' + cell)
    }, {
      doubleTapMs: 280,
      setTimeout: (fn) => { const id = seq++; timers.set(id, fn); return id; },
      clearTimeout: (id) => { timers.delete(id); }
    });
    return {
      tap,
      log,
      pending: () => timers.size,
      elapse: () => {
        const fns = Array.from(timers.values());
        timers.clear();
        for (const fn of fns) fn();
      }
    };
  }

  it('chords a revealed cell at once, without waiting for a second tap', function () {
    const h = harness([7]);
    h.tap(7);
    equal(h.log.join(), 'chord:7', 'chord fired immediately');
    equal(h.pending(), 0, 'and nothing is left waiting');
  });

  it('opens a hidden cell on the second tap, and never flags it on the way', function () {
    const h = harness();
    h.tap(3);
    h.tap(3);
    equal(h.log.join(), 'open:3', 'no flag flicker before the open');
    h.elapse();
    equal(h.log.join(), 'open:3', 'and the pending flag was cancelled, not merely deferred');
  });

  it('flags a hidden cell when no second tap arrives', function () {
    const h = harness();
    h.tap(3);
    equal(h.log.length, 0, 'nothing happens yet: it might still become a double tap');
    h.elapse();
    equal(h.log.join(), 'flag:3', 'the window closed, so it was a flag');
  });

  it('commits a pending flag when the next tap lands on a different cell', function () {
    const h = harness();
    h.tap(3);
    h.tap(8);
    equal(h.log.join(), 'flag:3', 'the first tap is honoured rather than dropped');
    h.elapse();
    equal(h.log.join(), 'flag:3,flag:8', 'and the second resolves on its own window');
  });

  it('does not treat a tap on a revealed cell as the second half of a double tap', function () {
    const h = harness([8]);
    h.tap(3);
    h.tap(8);
    equal(h.log.join(), 'flag:3,chord:8', 'two different intentions, both honoured');
  });
});

/* ---- launch shortcuts ------------------------------------------------------ */

/* The home-screen shortcuts used to write straight into settings, so one tap on
 * Daily switched every later normal launch to daily mode. And ?new=1, declared
 * in the manifest, was read by nobody. */
describe('launch shortcuts', function () {
  const { launchOverrides } = GS.storage;

  it('reads both shortcuts the manifest declares', function () {
    equal(launchOverrides('?mode=daily').mode, 'daily', 'the daily shortcut');
    assert(launchOverrides('?new=1').newGame, 'the new-game shortcut');
  });

  it('asks for nothing when the app is launched normally', function () {
    const plain = launchOverrides('');
    equal(plain.mode, null, 'no mode override');
    assert(!plain.newGame, 'no new game');
  });
});

/* ---- ranking rules -------------------------------------------------------- */

/* main.js used to decide this inline, and got it wrong twice: it never
 * consulted the daily history, so every replay could overwrite the record, and
 * it never consulted game.guaranteed, so a board the generator gave up on
 * competed with boards that were provably guess-free. */
describe('ranking rules', function () {
  const { isRanked, todayKey } = GS.storage;

  function attempt(overrides) {
    return Object.assign({ mode: 'classic', rewound: false, hintsUsed: 0, guaranteed: true }, overrides);
  }
  function data(daily) {
    return { settings: {}, records: {}, daily: daily || {}, totals: {} };
  }

  it('ranks a clean classic game', function () {
    assert(isRanked(data(), attempt()), 'nothing disqualifies it');
  });

  it('refuses casual, a rewind and a hinted game', function () {
    assert(!isRanked(data(), attempt({ mode: 'casual' })), 'casual has a safety net');
    assert(!isRanked(data(), attempt({ rewound: true })), 'a rewind undid a fatal move');
    assert(!isRanked(data(), attempt({ hintsUsed: 1 })), 'a hint did some of the reading');
  });

  it('refuses a daily replay, because the UI promises one ranked attempt', function () {
    const today = todayKey();
    const played = {};
    played[today] = { won: false, time: 90000 };
    assert(isRanked(data(), attempt({ mode: 'daily' })), 'the first attempt counts');
    assert(!isRanked(data(played), attempt({ mode: 'daily' })), 'the second does not');
    assert(isRanked(data(played), attempt({ mode: 'classic' })), 'and it only affects the daily');
  });

  it('refuses a board the generator could not guarantee', function () {
    assert(!isRanked(data(), attempt({ guaranteed: false })),
      'an unguaranteed board may need a coin flip, so its time is not comparable');
  });
});

/* ---- difficulty levels ---------------------------------------------------- */

/* A level is what a player picks; a density is what the generator needs. The
 * raw density slider exposed the second as if it were the first, and 19% is not
 * one difficulty anyway: it leaves 40% of 92-cell boards solvable by logic and
 * 87% of 492-cell ones. A level also bundles the opening cap, because how much
 * the first click hands you is as much of the experience as the mine count. */
describe('difficulty levels', function () {
  const { LEVELS, levelFor } = GS.solver;

  it('is a ladder: denser and less generous at every step', function () {
    for (let i = 1; i < LEVELS.length; i++) {
      const prev = LEVELS[i - 1];
      const here = LEVELS[i];
      assert(here.density > prev.density,
        here.id + ' is not denser than ' + prev.id);
      assert(here.maxOpening <= prev.maxOpening,
        here.id + ' gives away more of the board than ' + prev.id);
    }
  });

  it('gives the generator everything it needs at every rung', function () {
    for (const level of LEVELS) {
      assert(level.density > 0 && level.density < 0.5, level.id + ' density out of range');
      assert(level.maxOpening > 0 && level.maxOpening <= 1, level.id + ' opening cap out of range');
      assert(level.timeBudgetMs > 0, level.id + ' has no effort budget');
      assert(typeof level.label === 'string' && level.label.length, level.id + ' has no label');
    }
  });

  it('falls back rather than breaking on a level it does not know', function () {
    equal(levelFor('normal').id, 'normal', 'a known level');
    equal(levelFor('not-a-level').id, 'normal', 'anything else lands on normal');
    equal(levelFor(undefined).id, 'normal', 'including nothing at all');
  });

  /* The hard rungs are expected to sometimes fail to be guess-free. What they
   * must not do is spend a long time discovering that, because generation is
   * synchronous on the first tap. */
  it('never lets a hard level spend long failing', function () {
    const sphere = buildSphere(5);
    for (const level of LEVELS) {
      const g = GS.game.createGame({
        sphere, mineCount: Math.round(sphere.count * level.density),
        seed: 'level-' + level.id, noGuess: true,
        maxOpening: level.maxOpening, timeBudgetMs: level.timeBudgetMs
      });
      const started = Date.now();
      g.openAt(0);
      const spent = Date.now() - started;
      assert(spent < level.timeBudgetMs + 400,
        level.id + ' took ' + spent + 'ms against a ' + level.timeBudgetMs + 'ms budget');
    }
  });
});

/* ---- bodies --------------------------------------------------------------- */

/* Each board size is a named body (Pebble, Moon, Earth, Neptune, Sun) with its
 * own surface, sky and light. The surface is a 0..1 value per cell, computed
 * once per board.
 *
 * The first test is a regression guard with a story: the treatments were built
 * on noise that did not span [0, 1], so the shaping functions crushed them and
 * Earth's terrain came out as 0.000 at all 252 cells. Nothing threw, nothing
 * failed, the planet was just flat. A surface that does not vary is the bug. */
describe('bodies', function () {
  const { BODIES, buildTerrain, bodyForBoard, activeBody, THEMES } = GS.renderer;

  it('gives every textured body a surface that actually varies', function () {
    for (const id of Object.keys(BODIES)) {
      const body = BODIES[id];
      if (!body.surface || body.surface === 'none') continue;
      const terrain = buildTerrain(buildSphere(body.frequency), body);
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < terrain.length; i++) {
        if (terrain[i] < lo) lo = terrain[i];
        if (terrain[i] > hi) hi = terrain[i];
      }
      assert(hi - lo > 0.5, id + ' surface spans only ' + lo.toFixed(3) + '..' + hi.toFixed(3));
    }
  });

  it('builds the same surface every time, so a board does not shimmer', function () {
    const sphere = buildSphere(4);
    const a = buildTerrain(sphere, BODIES.moon);
    const b = buildTerrain(sphere, BODIES.moon);
    for (let i = 0; i < a.length; i++) equal(a[i], b[i], 'cell ' + i + ' differs between builds');
  });

  it('leaves the surface flat when a body declares none', function () {
    const terrain = buildTerrain(buildSphere(3), { surface: 'none' });
    for (let i = 0; i < terrain.length; i++) equal(terrain[i], 0, 'cell ' + i);
  });

  it('gives a custom board the body of the nearest preset size', function () {
    equal(bodyForBoard('custom', 92), BODIES.pebble, 'a tiny custom board is a pebble');
    equal(bodyForBoard('custom', 1442), BODIES.sun, 'a huge one is a sun');
    equal(bodyForBoard('earth', 252), BODIES.earth, 'a named size uses its own body');
  });

  it('suppresses the body entirely in the high contrast theme', function () {
    equal(activeBody(THEMES.vivid, BODIES.earth), null,
      'the colour-blind palette must not be overpainted by a planet');
    equal(activeBody(THEMES.midnight, BODIES.earth), BODIES.earth, 'but every other theme keeps it');
  });
});

/* ---- renderer ------------------------------------------------------------- */

/* markRevealed stamps each cell with a *future* time, so the reveal ripples
 * outward from the tap. Every cell in a cascade therefore spends time with a
 * negative age, and the scale it paints at must survive that. */
describe('renderer', function () {
  const { revealScale } = GS.renderer;

  it('never paints a cell inverted or larger than full size', function () {
    const deepest = 60 * 26; /* deeper than any cascade the 1442-cell board can produce */
    for (let age = -deepest; age <= 1000; age += 7) {
      const scale = revealScale(0, -age);
      assert(scale >= 0 && scale <= 0.9, 'scale at age ' + age + 'ms was ' + scale);
    }
  });

  it('holds a cell at its starting size until its turn in the wave arrives', function () {
    const start = revealScale(0, 0);
    equal(revealScale(0, 1066), start, 'a cell 41 levels deep waits, it does not invert');
    equal(revealScale(0, 26), start, 'nor does the cell one level out');
  });

  it('grows the cell to full size by the end of the wave', function () {
    equal(revealScale(260, 0), 0.9, 'fully popped');
    assert(revealScale(130, 0) > revealScale(0, 0), 'and grows on the way there');
  });

  /* Cells near the silhouette are foreshortened to slivers, but their numbers
   * and flags were drawn nearly full size, so they spilled outside their own
   * cells, collided with each other, and at the very edge floated outside the
   * globe entirely. The old curve, 0.5 + 0.5 * limb, only fitted at limb >= 0.56,
   * which is to say everything outside the middle two thirds of the disc was
   * wrong. */
  it('never draws a mark wider than the cell it sits on', function () {
    const { foreshorten, LABEL_RATIO } = GS.renderer;
    for (let limb = 0.02; limb <= 1.0001; limb += 0.02) {
      /* A cell's projected width shrinks in proportion to limb; a face-on cell
       * is 1. The label is LABEL_RATIO of a face-on cell before shrinking. */
      const drawn = LABEL_RATIO * foreshorten(limb);
      assert(drawn <= limb, 'at limb ' + limb.toFixed(2) + ' the mark is ' +
        drawn.toFixed(3) + ' wide in a cell ' + limb.toFixed(3) + ' wide');
    }
  });

  it('keeps marks full size wherever the cell can hold them', function () {
    const { foreshorten } = GS.renderer;
    equal(foreshorten(1), 1, 'dead centre');
    equal(foreshorten(0.8), 1, 'and still full size well before it');
    assert(foreshorten(0.4) < foreshorten(0.8), 'but shrinking towards the rim');
    equal(foreshorten(0), 0, 'and nothing at the silhouette');
  });

  /* Every animation here eases on a stamped time, and those times can sit in
   * the future: the reveal wave stamps them ahead deliberately, and a pointer
   * event can land after the frame's timestamp was taken. Unclamped, the
   * easing runs away, which is how a flag once drew 27,000 pixels wide. One
   * shared helper means the next animation cannot reintroduce it. */
  it('keeps every animation between not-started and finished', function () {
    const { progress } = GS.renderer;
    for (const age of [-90000, -2206, -220, -1, 0, 1, 110, 219, 220, 900, 90000]) {
      const p = progress(0, -age, 220);
      assert(p >= 0 && p <= 1, 'progress at age ' + age + 'ms was ' + p);
    }
    equal(progress(0, 0, 220), 0, 'not started');
    equal(progress(220, 0, 220), 1, 'finished');
  });
});

/* ---- service worker ------------------------------------------------------- */

/* The service worker is the delivery mechanism: if it serves a stale cached
 * copy and never refreshes it, a fix pushed to Pages never reaches a browser
 * that already installed the game. That is worth testing, so sw.js is loaded
 * into a fake worker global with a fake Cache Storage and a fake network. */
function loadServiceWorker() {
  const listeners = {};
  const cacheStore = new Map();
  const network = new Map();
  const waits = [];
  let versionCache = null;

  const urlOf = (req) => (typeof req === 'string' ? req : req.url);

  function response(body) {
    return { body, status: 200, type: 'basic', clone: () => response(body) };
  }

  function makeCache() {
    const entries = new Map();
    return {
      entries,
      match: (req) => Promise.resolve(entries.get(urlOf(req))),
      put: (req, res) => { entries.set(urlOf(req), res); return Promise.resolve(); },
      addAll: (urls) => {
        for (const u of urls) entries.set(u, response('precached ' + u));
        return Promise.resolve();
      }
    };
  }

  const caches = {
    open: (name) => {
      if (!cacheStore.has(name)) cacheStore.set(name, makeCache());
      if (versionCache === null) versionCache = name;
      return Promise.resolve(cacheStore.get(name));
    },
    keys: () => Promise.resolve(Array.from(cacheStore.keys())),
    delete: (name) => { cacheStore.delete(name); return Promise.resolve(true); },
    match: (req) => {
      for (const cache of cacheStore.values()) {
        const hit = cache.entries.get(urlOf(req));
        if (hit) return Promise.resolve(hit);
      }
      return Promise.resolve(undefined);
    }
  };

  const sandbox = {
    caches,
    Request: function (url, opts) {
      this.url = url;
      this.method = 'GET';
      this.cache = opts && opts.cache;
    },
    fetch: (req) => {
      const url = urlOf(req);
      if (!network.has(url)) return Promise.reject(new Error('offline: ' + url));
      return Promise.resolve(response(network.get(url)));
    },
    self: {
      addEventListener: (type, fn) => { listeners[type] = fn; },
      skipWaiting: () => Promise.resolve(),
      clients: { claim: () => Promise.resolve() }
    }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const swFile = path.join(__dirname, '..', 'sw.js');
  vm.runInContext(fs.readFileSync(swFile, 'utf8'), sandbox, { filename: swFile });

  function drive(type, extra) {
    const local = [];
    const event = Object.assign({ waitUntil: (p) => { local.push(p); waits.push(p); } }, extra);
    listeners[type](event);
    return { event, settled: () => Promise.all(local) };
  }

  return {
    install: () => drive('install').settled(),
    request(url) {
      let responded = Promise.resolve(undefined);
      const run = drive('fetch', {
        request: { url, method: 'GET' },
        respondWith: (p) => { responded = p; }
      });
      return responded.then((res) => ({ res, settled: run.settled }));
    },
    seed(url, body) { cacheStore.get(versionCache).entries.set(url, response(body)); },
    setNetwork(url, body) { network.set(url, body); },
    cached(url) {
      const hit = cacheStore.get(versionCache).entries.get(url);
      return hit && hit.body;
    },
    offline() { network.clear(); }
  };
}

const ASSET = 'https://hexsphere.test/js/game.js';

describe('service worker', function () {
  it('refreshes a cached asset so a pushed fix reaches an installed client', function () {
    const sw = loadServiceWorker();
    return sw.install().then(function () {
      sw.seed(ASSET, 'old bytes');
      sw.setNetwork(ASSET, 'new bytes');
      return sw.request(ASSET);
    }).then(function (hit) {
      equal(hit.res.body, 'old bytes', 'the cached copy is served at once, so the game stays instant');
      return hit.settled();
    }).then(function () {
      equal(sw.cached(ASSET), 'new bytes', 'the cache now holds the fix, so the next load picks it up');
    });
  });

  it('still serves from cache with no network at all', function () {
    const sw = loadServiceWorker();
    return sw.install().then(function () {
      sw.seed(ASSET, 'cached bytes');
      sw.offline();
      return sw.request(ASSET);
    }).then(function (hit) {
      equal(hit.res.body, 'cached bytes', 'offline play must keep working');
      return hit.settled();
    }).then(function () {
      equal(sw.cached(ASSET), 'cached bytes', 'a failed refresh must not evict the copy we have');
    });
  });
});

/* ---- summary --------------------------------------------------------------- */

Promise.all(pending).then(function () {
  console.log('');
  if (failures.length) {
    console.log(RED + failures.length + ' failing' + OFF + ', ' + passed + ' passing\n');
    for (const f of failures) console.log('  ' + f.name + '\n    ' + (f.err.stack || f.err.message) + '\n');
    process.exit(1);
  }
  console.log(GREEN + 'all ' + passed + ' tests passing' + OFF + '\n');
});
