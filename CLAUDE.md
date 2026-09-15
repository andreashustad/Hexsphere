# Hexsphere — working rules

Minesweeper on a Goldberg-polyhedron globe. Vanilla JS, no dependencies, no
build step. Live as a PWA at https://andreashustad.github.io/Hexsphere/ and
wrapped as an Android WebView app in `android/`.

## Running it

```sh
node tests/run.js                 # pure Node, no deps
npx http-server . -p 8080         # needed for the service worker; file:// won't do

cd android
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew assembleDebug           # app/build/outputs/apk/debug/app-debug.apk
```

`android/local.properties` is gitignored and must point at your SDK. Android
Studio writes it on first sync.

## Gotchas

**`applicationId` is `com.andreashustad.hexsphere` and is permanent** once an
APK is published to Google Play. It can never be changed after that, for any
reason. Nothing is published yet, so it is still free today.

**The daily seed string feeds the RNG.** `'hexsphere-daily-' + dateKey`
(`js/main.js:95`) determines the board. Changing that string rewrites every
historical daily, so it is effectively frozen once anyone has played one.

**`localStorage` on `github.io` is origin-scoped, not path-scoped.** Every
project published under `andreashustad.github.io` shares one store. The
`hexsphere.v1` key prefix (`js/storage.js:6`) is what keeps them apart, so it
is load-bearing, not cosmetic.

**The service worker refreshes the whole app or none of it.** A viewer gets the
cached copy at once and the new bytes on their *next* load, so a fix is never
one push away from being visible. Do not "optimise" it back to returning a cache
hit and stopping: that is what made pushed fixes unreachable, because `sw.js`'s
own bytes were unchanged so no new worker installed.

What it must never go back to is refreshing one file at a time. The game is
eight scripts that call into each other, so the unit that has to stay consistent
is the whole app. Per-file refresh meant a launch closed part-way left new
`main.js` beside old `solver.js`; the next launch served that pair, `main.js`
called `solver.levelFor`, which the old solver does not export, and the board
never drew. A blank screen with a warm cache and a healthy network, which reads
as "the PWA is broken" and is invisible from the repo. `refreshAll` therefore
fetches everything before writing anything, and a failed fetch commits nothing
rather than committing a mixture — which is also what keeps offline play
working, so keep that `.catch` on the navigation path.

**Do not hold fetched responses without reading them.** `refreshAll` calls
`response.blob()` as each response arrives rather than keeping all seventeen
until the last one lands. A response whose body is never read holds its
connection, and a browser allows about six per host, so the first version of
this deadlocked the install outright: eleven assets never got a connection, the
worker sat in `installing` for ever and nothing threw. The unit tests passed,
because a fake network has no connection limit. `tests/run.js` now models the
limit, which is the only reason that bug is catchable without a browser.

**Board generation is synchronous and runs on the player's first tap**, so
`timeBudgetMs` is a freeze budget, not a compute budget. Every board the game
offers finishes far inside it (4002 cells at 19% takes about 4ms); it only binds
just past the feasible density, where the solver keeps almost succeeding and
grinds through every attempt. Note the shape: the worst case is at the edge of
feasibility, not beyond it, because past the edge the solver fails fast. Any
future change that raises density or board size trades directly against this.

**`Object.assign` copies `undefined` over a default.** `generateBoard`'s
`maxOpening` was defaulted inside the `Object.assign` and the caller passed
`maxOpening: config.maxOpening`, which is `undefined` for a normal game. The cap
became `NaN`, `reach <= NaN` is false for every board, so the generator rejected
all of them, fell through to its "smallest opening seen" fallback and burned 200
solver runs per board doing it. Nothing threw and the tests were green, because
accidentally minimising the opening satisfied an assertion that only checked it
was small enough. Default such options *after* the assign, and test that an easy
constraint is accepted promptly rather than only testing the outcome.

**Every animation eases through `progress()`, and that is not optional.**
(`span` is the same clamp without the easing, for the rings that are meters
rather than animations; `easeOut` still has exactly one caller, which is the
point.) `easeOut` is a cubic, so feeding it a value outside `[0, 1]` does not
degrade, it explodes. Animation times here can legitimately sit in the future: the reveal
wave stamps them ahead on purpose, and a pointer event can land after the
frame's timestamp was taken. Two separate bugs came from this, a cell painted at
65x mirrored and a flag drawn 27,000 pixels wide. `easeOut` is now called from
exactly one place. Keep it that way rather than adding a second eased animation
with its own guard.

**Bodies and themes are separate axes, and must stay that way.** A body owns the
covered surface, sky, halo and light; a theme owns the numbers, revealed cells
and chrome. Collapsing them means maintaining five worlds times three themes
instead of five plus three, and it puts body colour underneath the numbers. The
high-contrast theme drops the body via `activeBody()`, because that palette
exists for colour-blind readability. The sky and halo are exempt on purpose:
they hold no cell state, number or mark.

**Only covered cells wait out the double-tap window.** `input.makeTapHandler`
sends a tap on a revealed cell straight to chord, because that tap cannot mean
anything else. Routing every tap through the window instead would look tidier
and would put a 280ms delay on chording, which is frequent enough to feel. The
open also fires on the second tap rather than when the window closes. Do not
"simplify" either of those away, and do not switch to flagging optimistically
and undoing it: that flashes a flag on every cell you open, cascades included.

That leaves a lone tap — a flag — as the one action that pays the wait, and
play-testing on 2026-09-15 called it laggy. Two things answer it and neither
shortens the window. A press held past `HOLD_FLAG_MS` flags on the lift with no
wait at all, because a second tap would have had to land inside a window that
went by while the finger was still down; keep that threshold comfortably *above*
`DOUBLE_TAP_MS` or the two gestures start to overlap and a slow double tap flags
the cell it meant to open. And `onPending` names the cell being waited on, so the
renderer can close a ring on it: the wait was never really the problem, a wait
with no acknowledgement was. The ring is a ring and not a faint flag for the
reason in the paragraph above.

**A coast has to end at a speed, not at an angle.** `MIN_SPIN_PX` is where a
flick stops, measured in pixels of surface travel per frame, and `minSpinFor`
turns it into the radians-per-frame the inertia loop needs for the current
radius. It was a flat angle for a long time, which is not a speed anybody can
see: the same 0.00035 rad crosses four times as much screen zoomed in as zoomed
out. A screen recording of real play showed the cost — after every flick the
globe spent its last ~0.4s moving well under a pixel a frame, too slow to read
as motion and too slow to be finished, so the board never settled and the render
loop stayed awake for all of it. Anything else that decides when a movement is
over belongs in the same units, for the same reason.

**Tap to open is a second mapping, not a second input path.** The setting swaps
which gesture opens and which flags, and it does it inside `makeTapHandler` by
asking `handlers.tapOpens()` on every tap — asked, not read once, because the
sheet opens over a live board and the answer can change between two taps. Both
mappings share one hold gesture and one ring; do not grow a parallel handler for
the second mapping, and do not cache the setting.

Under tap to open the hold ring stops being a convenience and becomes a safety
rail: letting go early there does not do nothing, it *opens the cell*, which on
the wrong cell is the game. So the ring must close exactly as the hold arms —
`holdRingWindow()` is the one place that arithmetic lives, and the test pins
`after + duration === HOLD_FLAG_MS`. For the same reason the ring is drawn from
`span` and not `progress`: it is a meter, not an animation, and the eased curve
read three quarters closed a third of the way in.

**A palette is only ever a pairing.** A covered cell and an opened one are read
against each other, so a body's colours cannot be judged on their own. Two
shipped bodies had drifted until one end of their surface range landed on the
opened tone — Neptune's band troughs at 1.19:1 and the Sun's bright granules
against Daylight at 1.25:1 — and on those boards a cleared area could only be
found by looking for numbers. Both were repainted, both at the cost of some
surface definition, which is the trade every fix here makes. `renderer.cellFill`
exists so the test can ask the real code what a cell paints, for every body,
theme and surface extreme; it was inline in the render loop, where nothing could
reach it. The floor is 1.6:1, which is not a standard but the level the rest of
the set already held. Revealed cells also carry `revealedRim` rather than the
covered cells' near-black grid, so the boundary survives even where the fills
are close.

**`tools/make-icons.js` renders every icon from the real board geometry** and is
byte-deterministic, which is what lets CI gate on the icons matching. Do not
hand-edit files in `icons/`; change the generator and re-run it.

**SDK versions are pointers, not values.** `compileSdk` should track whichever
platform is actually installed under `$ANDROID_HOME/platforms/`, and
`targetSdk` tracks Google Play's current floor for new apps, which moves every
August. Check both before a release rather than trusting the numbers in
`app/build.gradle` to still be right. As of 2026-09-15 the only installed
platform was 37 and `cmdline-tools` was absent, so there is no `sdkmanager` on
the CLI; install other platforms through Studio's SDK Manager.

**The Android project first compiled on 2026-09-15.** Before that its declared
versions were about two years stale and it had never been built. Treat anything
in `android/` that predates that date as unexercised.

## Not done yet, and irreversible when it is

The release build has no `signingConfig` and no upload keystore exists. When one
is generated: never commit it, add `*.jks` and `*.keystore` to `.gitignore`
first, and back it up somewhere that is not this laptop. Losing it means never
shipping an update again. `versionCode` must also strictly increase on every
upload, forever, including uploads that were later deleted.

There is no LICENSE, so the default is all rights reserved. That blocks F-Droid
and confuses contributors.

## Decisions

**Named Hexsphere on 2026-09-15**, renamed from VibeMine. "Vibe" named how the
project was built rather than what it is, and would have dated it. Two
constraints shaped the replacement and still apply to any future rename:

- Avoid the `<noun>sweeper` construction entirely. Globesweeper is an active
  commercial product (Incandescent Games, still selling on Steam), and that
  name shape invites the comparison.
- Nearest collisions found were Hexosphere (an in-development itch.io game, one
  letter away) and Hexagonal Sphere. No exact match on Play, Steam or itch.

Rename cost is near zero today and rises sharply at first publish, because
`applicationId`, the Pages URL that PWA installs pin, the storage key and the
daily seed all carry the name.
