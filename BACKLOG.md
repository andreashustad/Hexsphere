# Backlog

## Bug-fix plan

Eight defects, all confirmed against the code by reading it (see `file:line` on
each). Ordered by a hard dependency first, then by how visible the bug is to
someone actually playing.

The ordering constraint is real: **fix the service worker before anything else**.
Until it lands, a fix pushed to GitHub Pages does not reach a browser that has
already installed the game, so every later fix would look like it had no effect.

### 0. Service worker never delivers an update — `sw.js:4`, `sw.js:41`

`VERSION` is a hardcoded constant and the fetch handler returns any cache hit
unconditionally. A content-only push leaves every installed client serving the
old precached JS forever, because `sw.js` itself is byte-identical so no new
worker installs and `activate` never runs.

Fix: switch the fetch handler to stale-while-revalidate for same-origin GETs.
Serve the cached copy immediately, then fetch in the background and write the
result back to the cache, so the next load has the new build. On `install`,
fetch the precache list with `{cache: 'reload'}` so a stale HTTP cache cannot
seed the precache with old bytes.

This deliberately removes the need to remember a version bump. A fix that
depends on human discipline every single deploy is the same bug with extra
steps.

Verification: DevTools, Application, Service Workers. Load the page, push a
visible change, reload twice, confirm the change appears on the second reload
and that the page still loads with the network disabled.
No unit test: the suite runs in Node and there is no service worker there.

### 1. Reveal wave paints giant inverted polygons — `js/renderer.js:281`

`markRevealed` (`js/renderer.js:488`) stores a future timestamp,
`now + depth * 26`. The guard `if (t0 && now - t0 < 260)` is also true when
`now - t0` is negative, so `easeOut` runs far outside `[0, 1]`. At cascade
depth 41, reachable on a first tap on the 812-cell board: `t = -4.1`,
`easeOut = 1 - 5.1³ = -131.65`, `scale = -64.8`. A negative scale mirrors the
cell's corners through its centre at 65x size, filling the canvas. Depth 16 to
17 is routine on the 252 and 492 boards and gives scale -7.8 to -8.8.

Fix: skip the cell entirely until its start time has passed, and clamp the
eased value to `[0, 1]`.

Verification: extract the scale calculation into a pure
`revealScale(now, t0)` and test it directly. The test encodes the intent, not
the arithmetic: a cell whose reveal has not started yet must never paint, and
scale must stay inside `[0, 0.9]` for every input including times far in the
future and far in the past.

### 2. End-of-game timer fires against the wrong game — `js/main.js:210`, `js/main.js:213`

`setTimeout(endOfGame, 520)` on the loss path and `setTimeout(endOfGame, 380)`
on the win path are never cancelled. The only `clearTimeout` calls in the
codebase are for the toast and the long-press.

Hit a mine, then start a new game inside 520ms: `newGame()` replaces `current`,
the pending `endOfGame` reads the fresh game, and `storage.recordResult` books
a loss against a board nobody played. Streak reset, played count incremented,
"Boom" card shown over a clean board.

Fix: store the handle and clear it in `newGame()`. Guard `endOfGame` by
checking it is still operating on the game it was scheduled for.

Verification: manual. `main.js` is DOM-bound and extracting it for a test would
cost more than the bug does.

### 3. "Guaranteed solvable" fails silently — `js/game.js:55`

`game.guaranteed` is written once and read nowhere. Confirmed by grep: no
reader in `js/main.js` or `index.html`. When the generator gives up
(`js/solver.js:487`, `js/solver.js:493`) the player gets a board that needs a
coin flip, while the help text promises the opposite.

This is the feature the README leads with, so silence is the wrong failure
mode.

Fix: surface it. Toast when `guaranteed` is false, and mark the run so it is
not compared against guaranteed runs on the records screen.

Verification: test at the game layer. Generate at a mine density where the
solver is known to give up (custom, 1442 cells, 30%) and assert the game
reports `guaranteed === false` rather than quietly claiming success.

### 4. Daily replays are ranked, twice contradicting the UI — `js/main.js:293`

`ranked` checks mode, rewind and hint count, and never consults
`data.daily[storage.todayKey()]`. Meanwhile `MODE_NOTES.daily` (`js/main.js:20`)
says "One ranked attempt" and `js/main.js:424` says "Replays are unranked".
Lose the daily, replay it faster, and the better time overwrites the record.

Fix: make the existing daily history the authority. If today's key is already
present, the attempt is unranked.

Verification: test the rule as a pure function over the stored daily history,
so the two UI strings and the behaviour are checked against one source.

### 5. Arrow keys are swallowed before the settings sheet sees them — `js/input.js:186`

The arrow cases `break` out of the switch, so `handlers.onKey` is only reached
in the `default` branch. `js/main.js:567` correctly ignores keys while the
sheet is open, but never receives them. Focus a slider in Settings, press Left
or Right: the value does not change and the hidden globe rotates instead.

Fix: delegate first, and only handle the key for globe rotation if the
delegate did not consume it.

Verification: test `onKey` with a fake event and a stub handler. Assert that a
consumed key does not rotate.

### 6. Home-screen shortcuts corrupt persistent state — `js/main.js:595`

`applyLaunchParams` writes `settings.mode` and calls `storage.save(data)`, so
launching the Daily shortcut once switches every later normal launch to daily.
And `?new=1`, declared as a shortcut in `manifest.webmanifest`, is read by
nobody, so that shortcut starts whatever mode was last persisted.

Fix: treat a launch parameter as a one-shot override for the session rather
than a settings write, and implement `?new=1` or drop it from the manifest.

Verification: manual, two home-screen shortcuts, check settings afterwards.

### 7. Seeded opening never checks for a win — `js/game.js:309`

`reveal` calls `finishIfWon` after the flood; `openAt` does not. If a daily's
opening cascade clears every safe cell, the state stays `playing` forever: no
result card, no recorded win, mines never auto-flagged.

Fix: call the same win check at the end of `openAt`.

Verification: test at the game layer with a seed whose opening clears the
board.

---

## Toolchain

The `android/` project has never compiled. Its declared versions are roughly
two years behind the toolchain now installed, and four things have to move
together or they just produce four different failures:

- AGP, Gradle wrapper, `compileSdk` and `targetSdk`.
- `targetSdk` has a floor set by Google Play for new apps, not by us. Check the
  current floor on Play's target API level page before building a release.
- The SDK platform actually installed is the one to compile against. Check
  `~/Library/Android/sdk/platforms/` rather than assuming.

---

## Improvements

Not yet written. Andreas owns this section.
