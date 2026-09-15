# Backlog

## Bug-fix plan

Seven of the eight defects from the 2026-09-15 review are fixed and covered by
tests. Git history holds what each one was. One is left, and it is left
deliberately.

### 6. Home-screen shortcuts corrupt persistent state — `js/main.js:635`

`applyLaunchParams` writes `settings.mode` and persists it, so launching the
Daily shortcut once switches every later normal launch to daily mode.

Parsing is extracted and tested (`storage.launchOverrides`, which does now
parse `?new=1`), but nothing acts on either value yet beyond the old mode
write. The persistence half is not fixed, because it needs a decision rather
than a patch:

- `const settings = data.settings` is the same object the whole app saves, and
  nine separate `storage.save(data)` calls will persist a session override the
  moment anything else is written.
- `settings.mode` is read in ten places, so a session-only mode means either a
  `sessionMode` accessor threaded through those reads, or splitting `settings`
  into a session copy plus an explicit `saveSettings()` write-through.

The second question is what the mode chips in Settings should show while a
shortcut launch is active: the persisted preference, or the mode actually being
played. The two options above answer that differently.

There is also a case for deleting `?new=1` from `manifest.webmanifest` instead
of honouring it: the app always starts a new game on launch, so the shortcut
does nothing the plain icon does not already do.

### Noticed while playing, not yet investigated (2026-09-15)

- **The reset button restores the board oddly.** Andreas's words: "resets the
  board back weirdly, but it might just be the way I put it." Not reproduced or
  characterised yet. Start by watching what the refresh control in the HUD does
  to `current` and to the renderer's orientation, and whether `spinTo` is still
  animating into the old board when the new one arrives (there is a known
  ~420ms overlap, listed under the earlier out-of-scope observations).
- **Nothing changes visually above some board size.** Likely the label cutoff at
  `js/renderer.js` (`drawLabels = cellPixels > 11`), which silently stops drawing
  numbers once cells get small, but it may also be the body surface losing
  definition when features fall below one cell. Worth checking both, and whether
  the threshold should depend on zoom rather than being fixed.

### Reported but not verified

Three findings from the same review that were never checked against the code.
Do not act on them without confirming first.

- `MainActivity.java:103` — `webView.destroy()` called while the WebView is
  still the content view. Claimed to crash on some vendor WebView builds.
- `MainActivity.java:80` — `restoreState` has no fallback when it returns null,
  claimed to leave a blank screen after process death.
- `js/solver.js:430` — `solveBoard`'s `for(;;)` has no no-progress guard. The
  reviewer did not demonstrate a case where `deduce` returns something
  unrevealable, so this is theoretical.

---

## Improvements

Four sub-projects, each with its own design and each shippable alone. Ordered.
Agreed 2026-09-15 that all three axes (looks, feel, content) are in play.

**1. The bugs above.** Done bar item 6. Two of them were the looks-and-feel
complaint: the reveal wave painted garbage over every cascade, and a silently
unguaranteed board is why one occasionally felt unfair.

**2. Art direction.** Done. Each board size is now a body with its own surface,
sky, halo and light, composing with the theme rather than replacing it. Typography
was deliberately left out and is still available as a separate, smaller piece of
work: the menu and HUD are still system font.

**3. Feel.** Animation timing, spin weight, haptics, the tactility of a cascade
and a flag. Deliberately after 1 and 2: tuning timings against a correct
renderer and a settled look is the only way to tell whether a change helped.

**3b. Difficulty axis. Done 2026-09-15.** Four levels (Gentle, Normal, Hard,
Insane), each setting the mine density, the opening cap and the generator's
effort budget. Size stays a separate choice. The raw density slider is gone: it
asked the player to think in a generator parameter, offered combinations that
could not be delivered, and fragmented records across 22 density values.

One idea measured and rejected before building this: defining a level by *which
deduction technique* a board requires, using the solver's existing escalation
from local rules to the subset rule to exhaustive enumeration. It would have
been size-invariant and meaningful. It does not exist in practice: the band of
boards needing exhaustive reasoning but still having a guaranteed answer is
0-7% of boards, usually 3%. The escalation is a cliff, not a gradient.

Records now key on size plus level, so old bests, set at the previous per-size
densities, are orphaned rather than migrated. Pretending a 19% Earth board was
"Normal" would have been worse than losing a handful of times.

The measurements that shaped the densities, kept because they are the reason
the numbers are what they are:

- A hex sphere gives each cell 6 neighbours where square minesweeper gives 8, so
  the same density leaves many more zero-cells. Square beginner/intermediate/
  expert densities of 12.3/15.6/20.6% correspond to 16.1/20.3/26.5% here.
- The previous ladder ran 15.5% to 21%, spanning below-beginner to intermediate,
  and reached nothing like expert. Hard and Insane are new territory.
- The guess-free guarantee has a density ceiling that falls as boards grow:
  Pebble holds to about 29.5%, Earth to 28%, Sun to 25%. Hard and Insane sit at
  or past that on the larger worlds, so those boards will sometimes need a
  guess, and the game says so when it happens. That is a deliberate property of
  the hard rungs, not a defect: Andreas's call on 2026-09-15 was that hitting
  the ceiling does not matter, and designing around it was making the game worse.
  Their effort budgets are cut instead, so a board that cannot be guaranteed is
  discovered in 150-250ms rather than half a second.

Still untested by play: whether Hard at 26% is enjoyable or merely grinding on a
4002-cell board. Each level is one row of constants in `js/solver.js`.

**4. Content.** Modes, progression, reasons to return beyond the daily. Largest
and most speculative, and its answer depends on whether this stays a game for
one person. Deferred until that is known.

---

## Testing notes

`main.js` cannot be loaded by `tests/run.js`: it builds a renderer that needs a
real canvas 2D context. The agreed approach (2026-09-15) is to extract the rule
a bug lives in as a pure function and test that, leaving only wiring untested.
`storage.isRanked`, `storage.launchOverrides`, `input.makeKeyHandler` and
`renderer.revealScale` all exist for that reason. Wiring gets checked by driving
the real game in a browser.

The suite supports async tests: return a promise from `it` and it settles before
the summary. That is what lets `sw.js` be driven against a fake Cache Storage
and a fake network.

---

## Distribution

Live as a PWA on GitHub Pages. That is the whole current distribution story and
it costs nothing.

Google Play, if it ever happens: the $25 developer account fee is not the real
cost. A personal Play Console account created on or after 2023-11-13 must run a
closed test with at least 12 testers continuously opted in for 14 days before
production. Recruiting and holding twelve people who actually click the opt-in
link is the actual barrier. Verify the rule is still current before planning
around it.

Also required before a Play submission, none of it done: a privacy policy URL, a
completed Data Safety form, a content rating questionnaire, and store assets
(feature graphic, screenshots, descriptions). Play wants an AAB
(`bundleRelease`), not the APK.

Two things to check rather than assume:

- `android:allowBackup="true"` with no backup rules means Android auto-backup
  syncs the WebView's `localStorage` to the user's Google Drive. That is data
  leaving the device, which contradicts both the README's "nothing is sent
  anywhere" and a "collects no data" Data Safety declaration. Either set it
  false or declare it.
- Play's spam policy targets apps that are a web page in a WebView. Hexsphere
  should clear it (assets bundled, no remote URL, real game logic) but it is a
  known rejection pattern worth knowing about in advance.

Unverified as of 2026-09-15: whether Play's EU trader/non-trader declaration
applies to a Norwegian individual publishing a free app and what it exposes
publicly, and the status of Android's developer-verification requirement for
sideloaded apps, which could affect plain APK distribution.
