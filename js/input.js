/* Hexsphere — pointer, touch and keyboard input.
 *
 * One finger drags the globe (with inertia), a tap plays the cell under it,
 * a long press plants a flag, two fingers pinch to zoom. Everything is also
 * reachable from the keyboard.
 */
(function (global) {
  'use strict';

  const { V, Q, clamp } = global.GS.util;

  const TAP_SLOP = 10;          /* px of movement still counted as a tap */
  const LONG_PRESS_MS = 420;
  const FRICTION = 0.93;
  const MIN_SPIN = 0.00035;

  function attachInput(renderer, handlers) {
    const canvas = renderer.canvas;
    const state = renderer.state;

    const pointers = new Map();
    let dragging = false;
    let moved = 0;
    let downAt = 0;
    let downCell = -1;
    let lastPos = null;
    let longPressTimer = 0;
    let longPressFired = false;
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

    function cancelLongPress() {
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = 0; }
    }

    function onDown(e) {
      canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
      const p = localPoint(e);
      pointers.set(e.pointerId, p);

      if (pointers.size === 2) {
        cancelLongPress();
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
      longPressFired = false;
      downCell = renderer.pickCell(p.x, p.y);

      if (downCell >= 0 && e.button !== 2) {
        state.pressedCell = downCell;
        state.dirty = true;
        longPressTimer = setTimeout(function () {
          longPressFired = true;
          state.pressedCell = -1;
          handlers.onLongPress(downCell);
        }, LONG_PRESS_MS);
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
      if (moved > TAP_SLOP) {
        cancelLongPress();
        if (state.pressedCell !== -1) { state.pressedCell = -1; state.dirty = true; }
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
      cancelLongPress();
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
      if (longPressFired) { spinSpeed = 0; return; }
      if (moved <= TAP_SLOP && downCell >= 0 && duration < 1500) {
        spinSpeed = 0;
        if (e.button === 2) handlers.onLongPress(downCell);
        else handlers.onTap(downCell);
        return;
      }
      if (wasPressed !== -1) return;
      /* Otherwise let the globe keep spinning for a moment. */
      if (spinSpeed > MIN_SPIN) state.dirty = true; else spinSpeed = 0;
    }

    function onCancel(e) {
      cancelLongPress();
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

    function onKey(e) {
      const step = e.shiftKey ? 0.32 : 0.14;
      switch (e.key) {
        case 'ArrowLeft': rotateBy(-step * state.radius, 0); break;
        case 'ArrowRight': rotateBy(step * state.radius, 0); break;
        case 'ArrowUp': rotateBy(0, -step * state.radius); break;
        case 'ArrowDown': rotateBy(0, step * state.radius); break;
        case '+': case '=': renderer.setZoom(state.zoom * 1.12); break;
        case '-': case '_': renderer.setZoom(state.zoom * 0.89); break;
        default: return handlers.onKey && handlers.onKey(e);
      }
      e.preventDefault();
    }

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
  global.GS.input = { attachInput };
})(typeof globalThis !== 'undefined' ? globalThis : this);
