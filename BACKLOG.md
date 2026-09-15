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

**2. Art direction.** The board names already promise an art direction nothing
backs up: Pebble, Moon, Earth, Neptune, Sun all render as the same blue hex ball
on the same starfield. Make each body distinct in surface, palette, lighting and
sky, and give the typography a point of view. Self-contained in `styles.css`,
the renderer's shading and the theme tokens; touches no game logic. The menu
itself is competent and is not the problem.

**3. Feel.** Animation timing, spin weight, haptics, the tactility of a cascade
and a flag. Deliberately after 1 and 2: tuning timings against a correct
renderer and a settled look is the only way to tell whether a change helped.

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
