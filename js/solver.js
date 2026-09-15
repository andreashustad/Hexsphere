/* Hexsphere — logic solver and board generator.
 *
 * The solver plays a board the way a careful human would: only ever acting on
 * deductions it can prove. It is used for three things:
 *   1. generating boards that are guaranteed solvable without guessing,
 *   2. the in-game hint button,
 *   3. ranking the safest cell when a board really does force a guess.
 */
(function (global) {
  'use strict';

  const DEFAULTS = {
    /* Cap on the exhaustive search, so a huge frontier can never hang the UI. */
    maxComponentCells: 26,
    maxNodes: 120000,
    useExhaustive: true
  };

  /* ---- log-gamma, for counting arrangements of the off-frontier cells ---- */

  const LANCZOS = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7
  ];

  function logGamma(z) {
    if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
    z -= 1;
    let x = 0.99999999999980993;
    for (let i = 0; i < LANCZOS.length; i++) x += LANCZOS[i] / (z + i + 1);
    const t = z + LANCZOS.length - 0.5;
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
  }

  function logChoose(n, k) {
    if (k < 0 || k > n) return -Infinity;
    if (k === 0 || k === n) return 0;
    return logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
  }

  /* ---- board view -------------------------------------------------------
   * A view is what the player can see: which cells are revealed, what number
   * each revealed cell shows, and where the flags are. The solver never looks
   * at the hidden mines. */

  function createView(count) {
    return {
      count,
      revealed: new Uint8Array(count),
      flagged: new Uint8Array(count),
      counts: new Int8Array(count).fill(-1)
    };
  }

  function collectConstraints(sphere, view) {
    const constraints = [];
    const unknown = [];
    const isFrontier = new Uint8Array(view.count);

    for (let i = 0; i < view.count; i++) {
      /* A revealed zero is a constraint too: everything around it is safe.
       * In play those neighbours are already open, but the solver is also used
       * on views built from elsewhere. */
      if (!view.revealed[i] || view.counts[i] < 0) continue;
      const nb = sphere.neighbors[i];
      const cells = [];
      let flags = 0;
      for (let n = 0; n < nb.length; n++) {
        const j = nb[n];
        if (view.flagged[j]) flags++;
        else if (!view.revealed[j]) cells.push(j);
      }
      if (cells.length === 0) continue;
      constraints.push({ cells, count: view.counts[i] - flags, source: i });
      for (let c = 0; c < cells.length; c++) isFrontier[cells[c]] = 1;
    }
    for (let i = 0; i < view.count; i++) {
      if (!view.revealed[i] && !view.flagged[i]) unknown.push(i);
    }
    return { constraints, unknown, isFrontier };
  }

  /* ---- rule 1: a single constraint can be saturated or exhausted -------- */

  function applySimpleRules(constraints, safe, mines) {
    let progress = false;
    for (let c = 0; c < constraints.length; c++) {
      const { cells, count } = constraints[c];
      if (count === 0) {
        for (const cell of cells) { if (!safe.has(cell)) { safe.add(cell); progress = true; } }
      } else if (count === cells.length) {
        for (const cell of cells) { if (!mines.has(cell)) { mines.add(cell); progress = true; } }
      }
    }
    return progress;
  }

  /* ---- rule 2: one constraint contained in another ---------------------- */

  function applySubsetRule(constraints, safe, mines) {
    let progress = false;
    const byCell = new Map();
    for (let c = 0; c < constraints.length; c++) {
      for (const cell of constraints[c].cells) {
        if (!byCell.has(cell)) byCell.set(cell, []);
        byCell.get(cell).push(c);
      }
    }
    const sets = constraints.map((c) => new Set(c.cells));

    for (let a = 0; a < constraints.length; a++) {
      const seen = new Set();
      for (const cell of constraints[a].cells) {
        for (const b of byCell.get(cell)) {
          if (b === a || seen.has(b)) continue;
          seen.add(b);
          /* Is A a subset of B? */
          if (sets[a].size >= sets[b].size) continue;
          let contained = true;
          for (const x of constraints[a].cells) {
            if (!sets[b].has(x)) { contained = false; break; }
          }
          if (!contained) continue;

          const diff = constraints[b].cells.filter((x) => !sets[a].has(x));
          const diffCount = constraints[b].count - constraints[a].count;
          if (diffCount === 0) {
            for (const x of diff) { if (!safe.has(x)) { safe.add(x); progress = true; } }
          } else if (diffCount === diff.length) {
            for (const x of diff) { if (!mines.has(x)) { mines.add(x); progress = true; } }
          }
        }
      }
    }
    return progress;
  }

  /* ---- rule 3: exhaustive search over the frontier ----------------------
   * Splits the frontier into independent components, enumerates every mine
   * arrangement consistent with the visible numbers, then weights each
   * arrangement by how many ways the leftover mines fit in the cells nobody
   * can see yet. Cells that are a mine in every weighted arrangement (or in
   * none) are certain; the rest get an exact probability. */

  function componentsOf(constraints) {
    const parent = new Map();
    const find = (x) => {
      while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); }
      return x;
    };
    const union = (a, b) => {
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };
    for (const con of constraints) {
      for (const cell of con.cells) if (!parent.has(cell)) parent.set(cell, cell);
      for (let i = 1; i < con.cells.length; i++) union(con.cells[0], con.cells[i]);
    }
    const groups = new Map();
    for (const cell of parent.keys()) {
      const root = find(cell);
      if (!groups.has(root)) groups.set(root, { cells: [], constraints: [] });
      groups.get(root).cells.push(cell);
    }
    for (const con of constraints) groups.get(find(con.cells[0])).constraints.push(con);
    return Array.from(groups.values());
  }

  /* Enumerate one component. Returns solution counts bucketed by how many
   * mines the arrangement uses, plus per-cell counts in the same buckets. */
  function enumerateComponent(component, budget) {
    const cells = component.cells;
    const n = cells.length;
    const localOf = new Map();
    for (let i = 0; i < n; i++) localOf.set(cells[i], i);

    const cons = component.constraints.map((c) => ({
      cells: c.cells.map((x) => localOf.get(x)),
      count: c.count,
      mines: 0,
      left: c.cells.length
    }));
    const consOf = [];
    for (let i = 0; i < n; i++) consOf.push([]);
    for (let ci = 0; ci < cons.length; ci++) {
      for (const local of cons[ci].cells) consOf[local].push(ci);
    }

    /* Assign the most constrained cells first — it prunes far sooner. */
    const order = cells.map((_, i) => i).sort((a, b) => consOf[b].length - consOf[a].length);

    const assign = new Uint8Array(n);
    const byTotal = new Map();
    let nodes = 0;
    let overflow = false;

    function record(total) {
      let bucket = byTotal.get(total);
      if (!bucket) { bucket = { solutions: 0, cellMines: new Float64Array(n) }; byTotal.set(total, bucket); }
      bucket.solutions++;
      for (let i = 0; i < n; i++) if (assign[i]) bucket.cellMines[i]++;
    }

    function place(pos, total) {
      if (overflow) return;
      if (++nodes > budget.maxNodes) { overflow = true; return; }
      if (pos === n) { record(total); return; }
      const local = order[pos];
      for (let value = 0; value <= 1; value++) {
        let ok = true;
        for (const ci of consOf[local]) {
          const con = cons[ci];
          con.mines += value;
          con.left -= 1;
          if (con.mines > con.count || con.mines + con.left < con.count) ok = false;
        }
        if (ok) { assign[local] = value; place(pos + 1, total + value); }
        for (const ci of consOf[local]) {
          const con = cons[ci];
          con.mines -= value;
          con.left += 1;
        }
        if (overflow) return;
      }
    }

    place(0, 0);
    if (overflow) return null;
    return { cells, byTotal };
  }

  function applyExhaustive(sphere, view, totalMines, constraints, unknown, isFrontier, safe, mines, opts) {
    const comps = componentsOf(constraints);
    if (comps.length === 0) return { progress: false, probabilities: null };
    for (const c of comps) {
      if (c.cells.length > opts.maxComponentCells) return { progress: false, probabilities: null };
    }

    const budget = { maxNodes: opts.maxNodes };
    const results = [];
    for (const comp of comps) {
      const r = enumerateComponent(comp, budget);
      if (!r) return { progress: false, probabilities: null };
      results.push(r);
    }

    const flagged = view.flagged.reduce((a, b) => a + b, 0);
    const minesLeft = totalMines - flagged;
    const outside = unknown.filter((c) => !isFrontier[c]);

    /* Distribution over "mines used by the frontier", per component. */
    const dists = results.map((r) => {
      const totals = Array.from(r.byTotal.keys()).sort((a, b) => a - b);
      return { totals, byTotal: r.byTotal };
    });

    function convolve(list) {
      let acc = new Map([[0, 1]]);
      for (const d of list) {
        const next = new Map();
        for (const [t0, w0] of acc) {
          for (const t of d.totals) {
            const key = t0 + t;
            next.set(key, (next.get(key) || 0) + w0 * d.byTotal.get(t).solutions);
          }
        }
        acc = next;
      }
      return acc;
    }

    /* Prefix/suffix convolutions let us ask "everything except component i". */
    const prefix = [new Map([[0, 1]])];
    for (let i = 0; i < dists.length; i++) prefix.push(convolve(dists.slice(0, i + 1)));
    const suffix = [];
    for (let i = 0; i <= dists.length; i++) suffix.push(convolve(dists.slice(i)));

    function combine(a, b) {
      const out = new Map();
      for (const [ta, wa] of a) for (const [tb, wb] of b) {
        out.set(ta + tb, (out.get(ta + tb) || 0) + wa * wb);
      }
      return out;
    }

    /* Everything is weighted in log space: the number of ways to scatter the
     * remaining mines over the unseen cells dwarfs double precision. */
    let logTotal = -Infinity;
    const addLog = (acc, term) => {
      if (term === -Infinity) return acc;
      if (acc === -Infinity) return term;
      const hi = Math.max(acc, term);
      return hi + Math.log(Math.exp(acc - hi) + Math.exp(term - hi));
    };

    const full = prefix[dists.length];
    for (const [t, w] of full) {
      if (w <= 0) continue;
      const lc = logChoose(outside.length, minesLeft - t);
      if (lc === -Infinity) continue;
      logTotal = addLog(logTotal, Math.log(w) + lc);
    }
    if (logTotal === -Infinity) return { progress: false, probabilities: null };

    const probabilities = new Map();
    let progress = false;

    for (let i = 0; i < results.length; i++) {
      const rest = combine(prefix[i], suffix[i + 1]);
      const cells = results[i].cells;
      const logNum = new Float64Array(cells.length).fill(-Infinity);
      for (const [t, bucket] of results[i].byTotal) {
        for (const [tr, wr] of rest) {
          if (wr <= 0) continue;
          const lc = logChoose(outside.length, minesLeft - t - tr);
          if (lc === -Infinity) continue;
          const base = Math.log(wr) + lc;
          for (let c = 0; c < cells.length; c++) {
            if (bucket.cellMines[c] === 0) continue;
            logNum[c] = addLog(logNum[c], Math.log(bucket.cellMines[c]) + base);
          }
        }
      }
      for (let c = 0; c < cells.length; c++) {
        const p = logNum[c] === -Infinity ? 0 : Math.exp(logNum[c] - logTotal);
        probabilities.set(cells[c], p);
        if (p < 1e-9) { if (!safe.has(cells[c])) { safe.add(cells[c]); progress = true; } }
        else if (p > 1 - 1e-9) { if (!mines.has(cells[c])) { mines.add(cells[c]); progress = true; } }
      }
    }

    /* Cells with no visible neighbour all share one probability. */
    if (outside.length > 0) {
      let logNum = -Infinity;
      for (const [t, w] of full) {
        if (w <= 0) continue;
        const rem = minesLeft - t;
        const lc = logChoose(outside.length, rem);
        if (lc === -Infinity || rem <= 0) continue;
        logNum = addLog(logNum, Math.log(w) + lc + Math.log(rem / outside.length));
      }
      const p = logNum === -Infinity ? 0 : Math.exp(logNum - logTotal);
      for (const cell of outside) {
        probabilities.set(cell, p);
        if (p < 1e-9) { if (!safe.has(cell)) { safe.add(cell); progress = true; } }
        else if (p > 1 - 1e-9) { if (!mines.has(cell)) { mines.add(cell); progress = true; } }
      }
    }

    return { progress, probabilities };
  }

  /* ---- one round of deduction ------------------------------------------ */

  function deduce(sphere, view, totalMines, options) {
    const opts = Object.assign({}, DEFAULTS, options);
    const safe = new Set();
    const mines = new Set();
    const { constraints, unknown, isFrontier } = collectConstraints(sphere, view);

    if (unknown.length === 0) return { safe: [], mines: [], probabilities: null, exhaustive: false };

    let progress = applySimpleRules(constraints, safe, mines);
    if (!progress) progress = applySubsetRule(constraints, safe, mines);

    /* Counting rule: the remaining mines may already account for everything. */
    if (!progress) {
      let flagged = 0;
      for (let i = 0; i < view.count; i++) if (view.flagged[i]) flagged++;
      const left = totalMines - flagged;
      if (left === 0) { for (const c of unknown) safe.add(c); progress = safe.size > 0; }
      else if (left === unknown.length) { for (const c of unknown) mines.add(c); progress = mines.size > 0; }
    }

    let probabilities = null;
    let exhaustive = false;
    if (!progress && opts.useExhaustive && constraints.length > 0) {
      const res = applyExhaustive(sphere, view, totalMines, constraints, unknown, isFrontier, safe, mines, opts);
      probabilities = res.probabilities;
      progress = res.progress;
      exhaustive = true;
    }

    return { safe: Array.from(safe), mines: Array.from(mines), probabilities, exhaustive };
  }

  /* ---- play a whole board using deduction only -------------------------- */

  function revealInto(sphere, mineField, adjacency, view, index, order) {
    if (view.revealed[index] || view.flagged[index]) return true;
    if (mineField[index]) return false;
    const stack = [index];
    while (stack.length) {
      const cur = stack.pop();
      if (view.revealed[cur]) continue;
      view.revealed[cur] = 1;
      view.flagged[cur] = 0;
      view.counts[cur] = adjacency[cur];
      if (order) order.push(cur);
      if (adjacency[cur] === 0) {
        for (const nb of sphere.neighbors[cur]) {
          if (!view.revealed[nb] && !mineField[nb]) stack.push(nb);
        }
      }
    }
    return true;
  }

  function adjacencyCounts(sphere, mineField) {
    const adj = new Int8Array(sphere.count);
    for (let i = 0; i < sphere.count; i++) {
      if (mineField[i]) { adj[i] = -1; continue; }
      let n = 0;
      for (const nb of sphere.neighbors[i]) if (mineField[nb]) n++;
      adj[i] = n;
    }
    return adj;
  }

  /* Returns how far pure logic gets on this board from this opening move. */
  function solveBoard(sphere, mineField, totalMines, start, options) {
    const adjacency = adjacencyCounts(sphere, mineField);
    const view = createView(sphere.count);
    revealInto(sphere, mineField, adjacency, view, start, null);

    let safeCells = 0;
    for (let i = 0; i < sphere.count; i++) if (!mineField[i]) safeCells++;

    for (;;) {
      let revealedCount = 0;
      for (let i = 0; i < sphere.count; i++) if (view.revealed[i]) revealedCount++;
      if (revealedCount === safeCells) {
        return { solved: true, revealed: revealedCount, safeCells, view };
      }
      const step = deduce(sphere, view, totalMines, options);
      if (step.safe.length === 0 && step.mines.length === 0) {
        return { solved: false, revealed: revealedCount, safeCells, view, stuck: step };
      }
      for (const cell of step.mines) view.flagged[cell] = 1;
      for (const cell of step.safe) revealInto(sphere, mineField, adjacency, view, cell, null);
    }
  }

  /* ---- board generation -------------------------------------------------
   * Scatter mines, keeping the opening move and its neighbours clear so the
   * first click always opens a pocket. Then check the board is solvable by
   * logic alone; if it is not, nudge one mine at a time out of the region the
   * solver got stuck in and try again. */

  function scatter(sphere, mineCount, forbidden, rng) {
    const candidates = [];
    for (let i = 0; i < sphere.count; i++) if (!forbidden[i]) candidates.push(i);
    rng.shuffle(candidates);
    const field = new Uint8Array(sphere.count);
    for (let i = 0; i < mineCount && i < candidates.length; i++) field[candidates[i]] = 1;
    return field;
  }

  /* How many cells the first click would clear on this field. */
  function cascadeSize(sphere, field, start) {
    const view = createView(sphere.count);
    revealInto(sphere, field, adjacencyCounts(sphere, field), view, start, null);
    let n = 0;
    for (let i = 0; i < sphere.count; i++) if (view.revealed[i]) n++;
    return n;
  }

  function generateBoard(sphere, mineCount, start, rng, options) {
    /* maxOpening caps the first click as a fraction of the safe cells.
     *
     * The opening is always a zero cell, because a guess-free board has to
     * give the solver a foothold, so it always cascades. On 92 cells that
     * cascade was handing over two thirds of the game before the player had
     * read anything. Moving mines nearer the start does not help: the
     * generator rejects those boards as unsolvable and draws another that
     * cascades anyway, so the guarantee itself is what demands a big opening.
     * Capping the cascade and drawing again is the lever that works, and it
     * costs nothing because it only ever binds on the small boards, which are
     * the fast ones to generate. */
    const opts = Object.assign({ noGuess: true, attempts: 40, repairs: 24 }, options);
    /* Not defaults in the Object.assign above: a caller passing either key with
     * an undefined value would overwrite it. That already bit once, when
     * `reach <= NaN` was false for every board and silently turned the opening
     * cap into "minimise the opening" at 200 solver runs apiece. */
    const maxOpening = opts.maxOpening === undefined ? 0.2 : opts.maxOpening;
    /* Generation is synchronous and runs on the player's first tap, so this is
     * a freeze budget, not a compute budget. Every board the game actually
     * offers finishes far inside it: 4002 cells at 19% takes about 4ms. It only
     * binds just past the feasible density, where the solver keeps almost
     * succeeding and grinds through every attempt. */
    const timeBudgetMs = opts.timeBudgetMs === undefined ? 500 : opts.timeBudgetMs;
    const forbidden = new Uint8Array(sphere.count);
    forbidden[start] = 1;
    for (const nb of sphere.neighbors[start]) forbidden[nb] = 1;

    const openingSize = 1 + sphere.neighbors[start].length;
    const placeable = sphere.count - openingSize;
    const mines = Math.min(mineCount, placeable);
    const cap = Math.max(openingSize, Math.floor((sphere.count - mines) * maxOpening));

    if (!opts.noGuess) {
      let field = scatter(sphere, mines, forbidden, rng);
      for (let i = 0; i < opts.attempts && cascadeSize(sphere, field, start) > cap; i++) {
        field = scatter(sphere, mines, forbidden, rng);
      }
      return { field, guaranteed: false, attempts: 0 };
    }

    const started = Date.now();
    let best = null;
    let bestScore = -1;
    let attempts = 0;
    /* The tightest solvable board found whose opening is still over the cap.
     * A solvable board that opens too much beats an unsolvable one, so this is
     * the fallback rather than giving up on the guarantee. */
    let generous = null;
    let generousReach = Infinity;

    for (let attempt = 0; attempt < opts.attempts; attempt++) {
      let field = scatter(sphere, mines, forbidden, rng);
      for (let repair = 0; repair <= opts.repairs; repair++) {
        attempts++;
        const result = solveBoard(sphere, field, mines, start, options);
        if (result.solved) {
          const reach = cascadeSize(sphere, field, start);
          if (reach <= cap) return { field, guaranteed: true, attempts };
          if (reach < generousReach) { generousReach = reach; generous = field.slice(); }
          break;
        }
        if (result.revealed > bestScore) { bestScore = result.revealed; best = field.slice(); }
        if (Date.now() - started > timeBudgetMs) {
          if (generous) return { field: generous, guaranteed: true, attempts, openingOverCap: true };
          return { field: best, guaranteed: false, attempts, timedOut: true };
        }
        field = nudge(sphere, field, result, forbidden, rng);
        if (!field) break;
      }
    }
    if (generous) return { field: generous, guaranteed: true, attempts, openingOverCap: true };
    return { field: best, guaranteed: false, attempts };
  }

  /* Move a single mine within the unsolved region. Small, local changes keep
   * the parts of the board that already worked while breaking the ambiguity. */
  function nudge(sphere, field, result, forbidden, rng) {
    const view = result.view;
    const undecided = [];
    for (let i = 0; i < sphere.count; i++) {
      if (!view.revealed[i] && !forbidden[i]) undecided.push(i);
    }
    const mines = undecided.filter((i) => field[i]);
    const empty = undecided.filter((i) => !field[i]);
    if (mines.length === 0 || empty.length === 0) return null;
    const next = field.slice();
    next[rng.pick(mines)] = 0;
    next[rng.pick(empty)] = 1;
    return next;
  }

  global.GS = global.GS || {};
  global.GS.solver = {
    createView, deduce, solveBoard, generateBoard, adjacencyCounts,
    revealInto, logChoose, DEFAULTS
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
