# Hexsphere — working rules

Minesweeper on a Goldberg-polyhedron globe. Vanilla JS, no dependencies, no
build step. Live as a PWA at https://andreashustad.github.io/Hexsphere/ and
wrapped as an Android WebView app in `android/`.

## Running it

```sh
node tests/run.js                 # 29 tests, pure Node, no deps
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

**The service worker is stale-while-revalidate.** A viewer gets the cached copy
at once and the new bytes on their *next* load, so a fix is never one push away
from being visible. Do not "optimise" it back to returning a cache hit and
stopping: that is what made pushed fixes unreachable, because `sw.js`'s own
bytes were unchanged so no new worker installed. A failed refresh resolves to
undefined rather than rejecting, which is what keeps offline play working, so
keep that `.catch`.

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
