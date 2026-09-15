/* Hexsphere — pointer, touch and keyboard input.
 *
 * One finger drags the globe (with inertia), a tap plants a flag, a double tap
 * opens a cell, a tap on a revealed number opens around it, two fingers pinch
 * to zoom. Everything is also reachable from the keyboard.
 */
(function (global) {
  'use strict';

  const { V, Q, clamp } = global.GS.util;

  const TAP_SLOP = 10;          /* px of movement still counted as a tap */
  const DOUBLE_TAP_MS = 280;    /* how long a lone tap waits to see if it is a double */
  const HOLD_FLAG_MS = 380;     /* a press held this long flags the moment it lifts */
  const FRICTION = 0.93;
  const MIN_SPIN = 0.00035;

  /* Tap flags, double tap opens, and a tap on a revealed number chords.
   *
   * Only hidden cells are ambiguous, so only they wait out the double-tap
   * window; chording stays instant, which matters because it is frequent. The
   * open fires on the second tap rather than at the end of the window, so the
   * common action has no latency either. The alternative, flagging at once and
   * undoing it on a second tap, would flash a flag on every cell you open,
   * including every cell of a cascade.
   *
   * That leaves flagging as the one action that pays the wait, and it was the
   * one that felt broken. Two things answer it, and neither touches the window
   * itself. `hold` is the whole wait removed for a press deliberate enough to
   * be unambiguous, and `onPending` lets the board show the wait it is serving
   * rather than going quiet for a quarter of a second.
   *
   * Timers are injected so the window can be driven in tests. */
  function makeTapHandler(handlers, deps) {
    let pendingCell = -1;
    let pendingTimer = 0;

    /* Announced on every change, including back to -1, so a renderer can hold
     * nothing but the current wait. */
    function announce() {
      if (handlers.onPending) handlers.onPending(pendingCell, deps.doubleTapMs);
    }

    function clearPending() {
      if (pendingTimer) deps.clearTimeout(pendingTimer);
      pendingTimer = 0;
      pendingCell = -1;
      announce();
    }

    /* A tap elsewhere ends the first cell's wait, so the flag still lands
     * rather than being swallowed by the next tap. */
    function commitPending() {
      const cell = pendingCell;
      clearPending();
      if (cell >= 0) handlers.onFlag(cell);
    }

    function tap(cell) {
      if (handlers.isRevealed(cell)) {
        commitPending();
        handlers.onChord(cell);
        return;
      }
      if (pendingCell === cell) {
        clearPending();
        handlers.onOpen(cell);
        return;
      }
      commitPending();
      pendingCell = cell;
      announce();
      pendingTimer = deps.setTimeout(function () {
        pendingTimer = 0;
        pendingCell = -1;
        announce();
        if (cell >= 0) handlers.onFlag(cell);
      }, deps.doubleTapMs);
    }

    /* A press held well past the double-tap window, then lifted. Nothing is
     * ambiguous about it: a second tap would have to land inside the window,
     * and the window has already gone by while the finger was still down. So
     * the flag lands on the lift with no wait at all, which is as fast as
     * flagging can be, and the caller keeps the hold threshold above the window
     * so the two gestures cannot be confused.
     *
     * A hold on the cell already waiting is still the second tap of a double
     * tap, just a slow one, so it opens. */
    tap.hold = function (cell) {
      if (handlers.isRevealed(cell)) {
        commitPending();
        handlers.onChord(cell);
        return;
      }
      if (pendingCell === cell) {
        clearPending();
        handlers.onOpen(cell);
        return;
      }
      commitPending();
      handlers.onFlag(cell);
    };

    return tap;
  }

  /* The delegate gets first refusal on every key, and says so by returning
   * true. The globe used to claim the arrow keys first and only pass on what
   * it did not recognise, which meant the settings sheet never saw them: its
   * sliders would not move and the hidden globe rotated instead. */
  function makeKeyHandler(handlers, deps) {
    return function onKey(e) {
      if (handlers.onKey && handlers.onKey(e)) return;
      const step = e.shiftKey ? 0.32 : 0.14;
      switch (e.key) {
        case 'ArrowLeft': deps.rotateBy(-step * deps.state.radius, 0); break;
        case 'ArrowRight': deps.rotateBy(step * deps.state.radius, 0); break;
        case 'ArrowUp': deps.rotateBy(0, -step * deps.state.radius); break;
        case 'ArrowDown': deps.rotateBy(0, step * deps.state.radius); break;
        case '+': case '=': deps.setZoom(deps.state.zoom * 1.12); break;
        case '-': case '_': deps.setZoom(deps.state.zoom * 0.89); break;
        default: return;
      }
      e.preventDefault();
    };
  }

  function attachInput(renderer, handlers) {
    const canvas = renderer.canvas;
    const state = renderer.state;

    const pointers = new Map();
    let dragging = false;
    let moved = 0;
    let downAt = 0;
    let downCell = -1;
    let lastPos = null;
    let pinchDistance = 0;
    let spinAxis = null;
    let spinSpeed = 0;
    let lastMoveTime = 0;

    function localPoint(e) {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    function rotateBy(dx, dy) {
      const r = Math.max(40, state.radius);
      const angle = Math.sqrt(dx * dx + dy * dy) / r;
      if (angle < 1e-6) return null;
      const axis = V.normalize([dy, dx, 0]);
      const delta = Q.fromAxisAngle(axis, angle);
      state.orientation = Q.normalize(Q.multiply(delta, state.orientation));
      state.dirty = true;
      return { axis, angle };
    }

    /* The pending cell goes straight into render state: the wait is the tap
     * handler's business, but showing it is the renderer's. */
    const tapHandlers = Object.assign({}, handlers, {
      onPending: function (cell, windowMs) {
        state.pendingFlagCell = cell;
        state.pendingFlagAt = performance.now();
        state.pendingFlagMs = windowMs;
        state.dirty = true;
      }
    });

    const tap = makeTapHandler(tapHandlers, {
      doubleTapMs: DOUBLE_TAP_MS,
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id)
    });

    function onDown(e) {
      canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
      const p = localPoint(e);
      pointers.set(e.pointerId, p);

      if (pointers.size === 2) {
        state.pressedCell = -1;
        const pts = Array.from(pointers.values());
        pinchDistance = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        return;
      }

      spinSpeed = 0;
      dragging = true;
      moved = 0;
      downAt = performance.now();
      lastMoveTime = downAt;
      lastPos = p;
      downCell = renderer.pickCell(p.x, p.y);

      if (downCell >= 0 && e.button !== 2) {
        state.pressedCell = downCell;
        state.dirty = true;
      }
    }

    function onMove(e) {
      if (!pointers.has(e.pointerId)) {
        const hover = renderer.pickCell(localPoint(e).x, localPoint(e).y);
        if (hover !== state.hoverCell) { state.hoverCell = hover; state.dirty = true; }
        return;
      }
      const p = localPoint(e);
      const prev = pointers.get(e.pointerId);
      pointers.set(e.pointerId, p);

      if (pointers.size === 2) {
        const pts = Array.from(pointers.values());
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        if (pinchDistance > 0 && Math.abs(dist - pinchDistance) > 1) {
          renderer.setZoom(state.zoom * (dist / pinchDistance));
          handlers.onZoom && handlers.onZoom(state.zoom);
        }
        pinchDistance = dist;
        return;
      }
      if (!dragging) return;

      const dx = p.x - prev.x;
      const dy = p.y - prev.y;
      moved += Math.hypot(dx, dy);
      if (moved > TAP_SLOP && state.pressedCell !== -1) {
        state.pressedCell = -1;
        state.dirty = true;
      }
      if (moved <= TAP_SLOP) return;

      const spin = rotateBy(dx, dy);
      const now = performance.now();
      const dt = Math.max(8, now - lastMoveTime);
      lastMoveTime = now;
      if (spin) {
        spinAxis = spin.axis;
        spinSpeed = clamp(spin.angle / dt * 16, 0, 0.16);
      }
      lastPos = p;
    }

    function onUp(e) {
      pointers.delete(e.pointerId);
      if (pointers.size === 1) {
        /* Second finger lifted: resume dragging from the one that remains. */
        pinchDistance = 0;
        lastPos = Array.from(pointers.values())[0];
        moved = TAP_SLOP + 1;
        return;
      }
      if (pointers.size > 0) return;

      const wasPressed = state.pressedCell;
      state.pressedCell = -1;
      state.dirty = true;

      if (!dragging) return;
      dragging = false;

      const duration = performance.now() - downAt;
      /* A press that never moved is a press on a cell, however long it lasted.
       * It used to be dropped past 1500ms, on the grounds that something held
       * that long was not a tap; with a hold now meaning flag there is nothing
       * left for the cap to protect, and it would only make the gesture fail
       * for whoever holds longest. The cell is highlighted throughout, so a
       * finger resting on the globe can see what it is about to do. */
      if (moved <= TAP_SLOP && downCell >= 0) {
        spinSpeed = 0;
        /* Right-click stays an instant flag on desktop: it is unambiguous, so
         * it has no reason to wait out the double-tap window. Neither does a
         * press held past the window, for the same reason. */
        if (e.button === 2) handlers.onFlag(downCell);
        else if (duration >= HOLD_FLAG_MS) tap.hold(downCell);
        else tap(downCell);
        return;
      }
      if (wasPressed !== -1) return;
      /* Otherwise let the globe keep spinning for a moment. */
      if (spinSpeed > MIN_SPIN) state.dirty = true; else spinSpeed = 0;
    }

    function onCancel(e) {
      pointers.delete(e.pointerId);
      dragging = false;
      state.pressedCell = -1;
      state.dirty = true;
    }

    function onWheel(e) {
      e.preventDefault();
      renderer.setZoom(state.zoom * (e.deltaY > 0 ? 0.92 : 1.08));
      handlers.onZoom && handlers.onZoom(state.zoom);
    }

    /* Called once per frame by the main loop to keep the globe coasting. */
    function applyInertia() {
      if (spinSpeed <= MIN_SPIN || !spinAxis || dragging) return false;
      state.orientation = Q.normalize(Q.multiply(Q.fromAxisAngle(spinAxis, spinSpeed), state.orientation));
      spinSpeed *= FRICTION;
      state.dirty = true;
      return true;
    }

    function stopSpin() { spinSpeed = 0; }

    const onKey = makeKeyHandler(handlers, {
      state,
      rotateBy,
      setZoom: (z) => renderer.setZoom(z)
    });

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onCancel);
    canvas.addEventListener('pointerleave', function () {
      if (state.hoverCell !== -1) { state.hoverCell = -1; state.dirty = true; }
    });
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    global.addEventListener('keydown', onKey);

    return { applyInertia, stopSpin, rotateBy };
  }

  global.GS = global.GS || {};
  global.GS.input = { attachInput, makeKeyHandler, makeTapHandler };
})(typeof globalThis !== 'undefined' ? globalThis : this);
