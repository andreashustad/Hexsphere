/* Hexsphere — game state.
 *
 * Mines are placed on the first click, never before, so the opening move
 * always lands in a clear pocket and the board can be built to be solvable
 * without guessing.
 */
(function (global) {
  'use strict';

  const { makeRng } = global.GS.util;
  const solver = global.GS.solver;

  const FLAG_NONE = 0;
  const FLAG_MINE = 1;
  const FLAG_MAYBE = 2;

  function createGame(config) {
    const sphere = config.sphere;
    const count = sphere.count;
    const seed = config.seed || String(Date.now());
    const rng = makeRng(seed);

    const game = {
      sphere,
      seed,
      mineCount: config.mineCount,
      noGuess: config.noGuess !== false,
      allowRewind: !!config.allowRewind,
      state: 'ready',
      mines: new Uint8Array(count),
      adjacency: new Int8Array(count).fill(-1),
      revealed: new Uint8Array(count),
      flags: new Uint8Array(count),
      revealedCount: 0,
      flagCount: 0,
      safeCells: count - config.mineCount,
      guaranteed: false,
      exploded: -1,
      mistakes: 0,
      hintsUsed: 0,
      moves: 0,
      startedAt: 0,
      endedAt: 0,
      generation: null,
      snapshots: []
    };

    /* ---- generation -------------------------------------------------- */

    function generate(start) {
      const result = solver.generateBoard(sphere, game.mineCount, start, rng, {
        noGuess: game.noGuess
      });
      game.mines = result.field;
      game.guaranteed = !!result.guaranteed;
      game.generation = result;
      let placed = 0;
      for (let i = 0; i < count; i++) if (game.mines[i]) placed++;
      game.mineCount = placed;
      game.safeCells = count - placed;
      game.adjacency = solver.adjacencyCounts(sphere, game.mines);
    }

    /* ---- snapshots, for the optional rewind assist -------------------- */

    function snapshot() {
      game.snapshots.push({
        revealed: game.revealed.slice(),
        flags: game.flags.slice(),
        revealedCount: game.revealedCount,
        flagCount: game.flagCount
      });
      if (game.snapshots.length > 24) game.snapshots.shift();
    }

    function restore(snap) {
      game.revealed = snap.revealed;
      game.flags = snap.flags;
      game.revealedCount = snap.revealedCount;
      game.flagCount = snap.flagCount;
    }

    /* ---- core actions -------------------------------------------------- */

    /* Flood outwards from a cell, stopping at cells that touch a mine.
     * Returns the cells opened, each tagged with its ring distance so the
     * renderer can play the reveal as an expanding wave. */
    function openFrom(index) {
      const opened = [];
      if (game.revealed[index]) return opened;
      let frontier = [index];
      let depth = 0;
      const seen = new Set([index]);
      while (frontier.length) {
        const next = [];
        for (const cell of frontier) {
          if (game.revealed[cell]) continue;
          game.revealed[cell] = 1;
          if (game.flags[cell]) { game.flags[cell] = FLAG_NONE; game.flagCount--; }
          game.revealedCount++;
          opened.push({ cell, depth });
          if (game.adjacency[cell] === 0) {
            for (const nb of sphere.neighbors[cell]) {
              if (!game.revealed[nb] && !seen.has(nb)) { seen.add(nb); next.push(nb); }
            }
          }
        }
        frontier = next;
        depth++;
      }
      return opened;
    }

    function finishIfWon(result) {
      if (game.revealedCount !== game.safeCells) return;
      game.state = 'won';
      game.endedAt = Date.now();
      for (let i = 0; i < count; i++) {
        if (game.mines[i] && game.flags[i] !== FLAG_MINE) {
          game.flags[i] = FLAG_MINE;
          game.flagCount++;
          result.flagged.push(i);
        }
      }
    }

    function emptyResult() {
      return { ok: true, opened: [], flagged: [], unflagged: [], exploded: -1, changed: [] };
    }

    game.reveal = function (index) {
      const result = emptyResult();
      if (game.state === 'won' || game.state === 'lost') { result.ok = false; return result; }
      if (game.revealed[index] || game.flags[index] === FLAG_MINE) { result.ok = false; return result; }

      if (game.state === 'ready') {
        generate(index);
        game.state = 'playing';
        game.startedAt = Date.now();
      }
      snapshot();
      game.moves++;

      if (game.mines[index]) {
        game.state = 'lost';
        game.endedAt = Date.now();
        game.exploded = index;
        result.exploded = index;
        return result;
      }
      result.opened = openFrom(index);
      finishIfWon(result);
      return result;
    };

    game.toggleFlag = function (index, allowMaybe) {
      const result = emptyResult();
      if (game.state === 'won' || game.state === 'lost') { result.ok = false; return result; }
      if (game.revealed[index]) { result.ok = false; return result; }
      if (game.state === 'ready') { result.ok = false; return result; }

      const current = game.flags[index];
      let next;
      if (current === FLAG_NONE) next = FLAG_MINE;
      else if (current === FLAG_MINE) next = allowMaybe ? FLAG_MAYBE : FLAG_NONE;
      else next = FLAG_NONE;

      if (current === FLAG_MINE) game.flagCount--;
      if (next === FLAG_MINE) game.flagCount++;
      game.flags[index] = next;
      if (next === FLAG_MINE) result.flagged.push(index);
      else result.unflagged.push(index);
      return result;
    };

    /* Tap a satisfied number to open everything still closed around it. */
    game.chord = function (index) {
      const result = emptyResult();
      if (game.state !== 'playing') { result.ok = false; return result; }
      if (!game.revealed[index] || game.adjacency[index] <= 0) { result.ok = false; return result; }

      const nb = sphere.neighbors[index];
      let flags = 0;
      const closed = [];
      for (const j of nb) {
        if (game.flags[j] === FLAG_MINE) flags++;
        else if (!game.revealed[j]) closed.push(j);
      }
      if (flags !== game.adjacency[index] || closed.length === 0) { result.ok = false; return result; }

      snapshot();
      game.moves++;
      for (const j of closed) {
        if (game.mines[j]) {
          game.state = 'lost';
          game.endedAt = Date.now();
          game.exploded = j;
          result.exploded = j;
          return result;
        }
      }
      for (const j of closed) {
        for (const o of openFrom(j)) result.opened.push(o);
      }
      finishIfWon(result);
      return result;
    };

    /* ---- assists -------------------------------------------------------- */

    /* Ask the solver for one cell the player could have worked out. */
    game.hint = function () {
      if (game.state === 'ready') {
        return { kind: 'start', cells: [], message: 'Tap anywhere to open the first pocket.' };
      }
      if (game.state !== 'playing') return { kind: 'none', cells: [] };

      const view = solver.createView(count);
      for (let i = 0; i < count; i++) {
        view.revealed[i] = game.revealed[i];
        view.flagged[i] = game.flags[i] === FLAG_MINE ? 1 : 0;
        view.counts[i] = game.revealed[i] ? game.adjacency[i] : -1;
      }
      /* A wrong flag makes the position unsolvable; say so rather than lie. */
      for (let i = 0; i < count; i++) {
        if (view.flagged[i] && !game.mines[i]) {
          game.hintsUsed++;
          return { kind: 'badflag', cells: [i], message: 'That flag is wrong — the cell is safe.' };
        }
      }

      const step = solver.deduce(sphere, view, game.mineCount, {});
      game.hintsUsed++;
      const safe = step.safe.filter((c) => !game.revealed[c] && game.flags[c] !== FLAG_MINE);
      if (safe.length) return { kind: 'safe', cells: [pickClosest(safe)], message: 'This cell is provably safe.' };
      const mines = step.mines.filter((c) => game.flags[c] !== FLAG_MINE);
      if (mines.length) return { kind: 'mine', cells: [pickClosest(mines)], message: 'This cell is provably a mine.' };

      if (step.probabilities && step.probabilities.size) {
        let bestCell = -1, bestP = Infinity;
        for (const [cell, p] of step.probabilities) {
          if (game.revealed[cell] || game.flags[cell] === FLAG_MINE) continue;
          if (p < bestP) { bestP = p; bestCell = cell; }
        }
        if (bestCell >= 0) {
          return {
            kind: 'guess', cells: [bestCell], risk: bestP,
            message: 'No certainty here — this is the safest cell at ' +
              Math.round((1 - bestP) * 100) + '%.'
          };
        }
      }
      return { kind: 'none', cells: [], message: 'Nothing new can be deduced right now.' };
    };

    /* Prefer a hint near what the player is already looking at. */
    function pickClosest(cells) {
      if (!game.focus) return cells[0];
      let best = cells[0], bestDot = -2;
      for (const c of cells) {
        const d = game.focus[0] * sphere.centers[c * 3] +
          game.focus[1] * sphere.centers[c * 3 + 1] +
          game.focus[2] * sphere.centers[c * 3 + 2];
        if (d > bestDot) { bestDot = d; best = c; }
      }
      return best;
    }

    /* Casual mode: step back over a fatal click and flag the mine instead. */
    game.rewind = function () {
      if (game.state !== 'lost' || !game.allowRewind || game.snapshots.length === 0) return false;
      restore(game.snapshots.pop());
      if (game.exploded >= 0 && game.flags[game.exploded] !== FLAG_MINE) {
        game.flags[game.exploded] = FLAG_MINE;
        game.flagCount++;
      }
      game.exploded = -1;
      game.state = 'playing';
      game.endedAt = 0;
      game.mistakes++;
      return true;
    };

    game.elapsed = function () {
      if (!game.startedAt) return 0;
      return (game.endedAt || Date.now()) - game.startedAt;
    };

    game.remainingMines = function () { return game.mineCount - game.flagCount; };

    /* Reveal every mine — used for the end-of-game board. */
    game.revealAllMines = function () {
      const cells = [];
      for (let i = 0; i < count; i++) {
        if (game.mines[i] && game.flags[i] !== FLAG_MINE) cells.push(i);
        else if (!game.mines[i] && game.flags[i] === FLAG_MINE) cells.push(i);
      }
      return cells;
    };

    /* Pre-built board with a fixed opening, so a shared seed gives everyone
     * the exact same puzzle. */
    game.openAt = function (start) {
      if (game.state !== 'ready') return null;
      generate(start);
      game.state = 'playing';
      game.startedAt = Date.now();
      const result = emptyResult();
      result.opened = openFrom(start);
      finishIfWon(result);
      return result;
    };

    return game;
  }

  global.GS = global.GS || {};
  global.GS.game = { createGame, FLAG_NONE, FLAG_MINE, FLAG_MAYBE };
})(typeof globalThis !== 'undefined' ? globalThis : this);
