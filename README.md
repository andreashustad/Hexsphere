# Hexsphere

Minesweeper on a globe. The board is a sphere tiled with hexagons — plus the
twelve pentagons you cannot avoid when you close hexagons into a ball — so there
are no edges, no corners, and no safe border to start from. You spin the world
with a finger and sweep it clean.

A from-scratch rebuild of a globe minesweeper that disappeared from the Play
Store, written as a web app that installs to an Android home screen and runs
completely offline.

![Hexsphere](docs/screenshot-board.png)

## What it does differently

| | |
|---|---|
| **Guaranteed solvable boards** | Every board is checked by a solver that only makes provable deductions before you ever see it. If the board would force a coin flip, it is rebuilt. Losing is always a misread, never bad luck. |
| **Hints that explain themselves** | The hint button points at a cell you could already have worked out and says *why* — "provably safe", "provably a mine", or "that flag is wrong". |
| **Exact odds when you do gamble** | Turn the guarantee off and, if a position really is ambiguous, the hint ranks the safest cell using exact probabilities computed over every consistent mine arrangement. |
| **Casual mode** | One fatal tap can be stepped back, and the mine gets flagged for you. |
| **Daily challenge** | The same board for everyone, derived from the date, pre-opened at the same cell. |
| **Sizes from 92 to 1442 cells** | Five presets plus a custom board where you pick the cell count and the mine density. |
| **Reads well for everyone** | Three themes including a high-contrast one with an Okabe–Ito number palette that stays distinguishable with any common colour blindness, plus adjustable number size. |
| **Pentagons are marked** | The twelve five-neighbour cells are tinted, because a cell that touches five neighbours instead of six changes what its number means. |
| **No ads, no tracking, no network** | Nothing is sent anywhere. Once loaded the game never talks to the network again. |

## Play

Open `index.html` — no build step, no dependencies.

For the service worker (offline install) it needs to be served over HTTP rather
than opened from disk:

```sh
npx http-server . -p 8080     # then open http://localhost:8080/
```

## Getting it onto a phone

**As an installed web app.** Turn on GitHub Pages for this repository
(Settings → Pages → *Deploy from a branch*, `main`, `/`), then open
`https://andreashustad.github.io/Hexsphere/` in Chrome on the phone and choose
**⋮ → Add to Home screen**. It installs with its own icon, launches without
browser chrome, and works in aeroplane mode from then on. Long-press the icon
for shortcuts straight into the daily challenge or a new game.

**As an APK.** [`android/`](android) is an Android Studio project that wraps the
same files in a native shell — one WebView, no permissions at all (not even
`INTERNET`), assets served through `WebViewAssetLoader` so the game gets a
proper secure origin for its saved settings and records. Gradle gathers the web
app from the repository root at build time, so there is only ever one copy of
the game here.

```sh
# Open android/ in Android Studio and let it sync (it supplies the Gradle
# wrapper), then:
./gradlew assembleDebug        # app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

The Gradle build is the one part of this project that has not been run by its
author — expect Android Studio to want to adjust the AGP or Gradle version to
match your install.

## Controls

| Action | Gesture |
|---|---|
| Spin the globe | Drag — it keeps coasting when you let go |
| Open a cell | Tap |
| Flag a mine | Long press, or turn on **Flag** in the dock and tap |
| Open around a number | Tap a number whose flags are all placed |
| Zoom | Pinch, scroll, or the dock buttons |

Keyboard: arrows spin, <kbd>+</kbd>/<kbd>-</kbd> zoom, <kbd>Space</kbd> opens the
centre cell, <kbd>F</kbd> flags it, <kbd>C</kbd> opens around it, <kbd>H</kbd>
hint, <kbd>N</kbd> new game.

## How it works

**The board** (`js/geometry.js`) is a Goldberg polyhedron. An icosahedron is
subdivided `f` times, projected onto the unit sphere, and then dualised: every
vertex of that geodesic sphere becomes one playable cell. That yields exactly
`10f² + 2` cells, of which exactly twelve are pentagons, at any size — a tiling
with no poles and no seams, where every cell is very nearly the same size.

**The solver** (`js/solver.js`) escalates through three levels: single-constraint
saturation, the subset rule between overlapping numbers, and — when those stall —
an exhaustive search that splits the frontier into independent components and
enumerates every consistent mine arrangement. Arrangements are weighted by how
many ways the leftover mines fit in the cells nobody can see yet, computed in log
space, which gives exact per-cell probabilities. Cells at probability 0 or 1 are
certainties; everything else is a genuine guess.

**Generation** (`generateBoard`) scatters mines with the opening move and its
neighbours kept clear, then asks the solver to play the board. If logic alone
cannot finish it, a single mine is moved within the region the solver got stuck
in and it tries again — small local repairs, so the parts that already worked
survive. In practice a guess-free board is found in a handful of milliseconds
even at 1002 cells.

**The renderer** (`js/renderer.js`) is a small 3D engine on a plain 2D canvas:
quaternion orientation, a perspective camera, back-face culling (the sphere is
convex, so culling alone gives correct draw order) and per-cell diffuse shading.
Picking casts a ray onto the sphere and takes the nearest cell centre — the cells
*are* the Voronoi regions of their centres, so that is exact. No WebGL and no
libraries, which is what keeps the whole game a handful of small files.

## Tests

```sh
node tests/run.js
```

Covers the tiling's topology (cell counts, exactly twelve pentagons, symmetric
adjacency, winding, connectivity), the solver's deductions and probability
arithmetic, the guarantee that generated boards really are guess-free, and the
game rules — cascades, flags, chording, wins, rewind, seeded boards, and the
promise that a hint never points at a mine it called safe.

## Layout

```
index.html              app shell
styles.css              chrome (the board itself is canvas)
manifest.webmanifest    installable app metadata
sw.js                   offline cache
js/util.js              RNG, vector and quaternion maths
js/geometry.js          Goldberg sphere construction
js/solver.js            deduction, probabilities, board generation
js/game.js              game state: reveal, flag, chord, hint, rewind
js/renderer.js          canvas 3D renderer
js/input.js             touch, mouse and keyboard
js/storage.js           settings, records, daily history
js/main.js              menus, HUD, game loop
android/                Android Studio project wrapping the web app
tests/run.js            test suite
tools/make-icons.js     renders every icon from the real board geometry
```

`tools/make-icons.js` renders the web, Apple touch and Android launcher icons —
the globe in them is the actual board geometry, so the icons cannot drift out of
sync with the game.
