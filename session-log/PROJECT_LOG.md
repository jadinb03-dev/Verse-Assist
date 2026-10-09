# Verse Assist — project log

A Premiere Pro CEP/ExtendScript extension (not UXP) for automating scripture lower-thirds
and fullscreen markers on a recurring Bible-teaching broadcast. Written with Claude Code;
this file is a human-readable summary of the full working session. The exhaustive raw
transcript (every message, tool call, code diff) is the `.zip` next to this file.

## Hard rules (must stay true)

1. Verse wording never comes from a language model — all verse text comes from the
   bundled, public-domain KJV data file (`client/data/kjv.json`). The model only ever
   supplies references and timecodes.
2. The Claude API key lives in the extension's own settings storage (`localStorage`),
   never a system environment variable.
3. Nothing is placed or marked on the timeline without the Stage 5 review/approve step.
4. Re-running any stage replaces earlier Verse Assist output instead of duplicating it.

## The five stages

1. **MOGRT tools** — insert/inspect/set-text on a MOGRT at the playhead. Working.
2. **Live verse viewer** — parses a scripture reference under the playhead and shows the
   KJV text, one verse at a time, with a per-verse "Copy" button (copies just the verse
   text, no reference). Working.
3. **CSV cue-list batch placement** — working.
4. **Claude API transcript-to-cues detection** — fully built (`client/scriptureDetect.js`,
   `srt.js`, `prompts/scripture_detection.md`) but **never run against the live API** —
   held back deliberately over per-episode cost. No API key is configured anywhere.
5. **Review/approve → Apply** — the big one. Builds a table of LT (lower-third) and FS
   (fullscreen) cues, lets you approve/edit/delete rows, then places everything on the
   timeline. This is where almost all the debugging effort went. See below.

## Stage 5 apply: what it actually does now

- Places approved LT cues using the scripture MOGRT, text = the reference.
- Fills every gap between the first and last reference with a default MOGRT (no label),
  via a sequential "walk" that only ever touches space it has just confirmed is empty.
- Small gaps under a configurable frame threshold snap both neighbors to the midpoint.
- Color-codes scripture clips green, default-fill clips "no label" (index -1), by
  dynamically switching the shared project item's label during the walk.
- Adds Cross Dissolve transitions at every real cut, via the undocumented QE DOM.
- Creates a marker for every approved FS (fullscreen) cue — name = the reference only
  (no prefix), comment = the actual verse text.
- **Every FS cue also gets its own LT placement** (same MOGRT/track/green label) as a
  fallback, so if the fullscreen graphic is ever turned off there's still something on
  screen. If an FS cue sits inside a wider LT citation's span, the wider citation is
  *split* around it and resumes afterward. If two FS cues' padded reading-time windows
  overlap each other, the earlier one is trimmed to end where the next begins (never
  dropped) — its start time is authoritative; its computed end is just padding.
- If a fullscreen graphic is enabled and a Cross Dissolve's pre- or post-roll would be
  visible outside the fullscreen's on-screen window, the *cut* (not the fullscreen) is
  nudged so the whole dissolve plays hidden behind the fullscreen.
- Re-applying sweeps the LT/default track by MOGRT name (not by remembered position —
  position drifts slightly between runs and that used to leave sub-frame slivers behind).
  Fullscreen markers are swept by matching recorded position + reference from the last
  apply, with a one-time fallback for markers from before this naming change.

## The big bug hunt: transitions fading instead of crossfading

Root cause, found the hard way: `TrackItem.end = <Time with .seconds set>` does **not**
frame-snap, while `Track.overwriteClip(item, <plain seconds number>)` **does** snap
internally — two different Premiere code paths rounding the same requested time two
different ways. That left a sub-frame sliver at nearly every cut (invisible in the UI,
but a real second edit point — hence needing two presses of the down-arrow key to step
past what looked like one cut). The fix: snap every boundary to an exact frame tick
ourselves (`vaFrameExactTime`, using the sequence's exact integer `timebase`) and write
it via `Time.ticks` (an exact integer string), never `Time.seconds`, on both sides of
every cut.

QE DOM transition indexing was a red herring investigated at length first (ordinal
name-matching across the full QE item list, verified correct) — the real bug was purely
in how the clip boundaries themselves were being set, not in which QE item got picked.

## Known open items

- **Fullscreen MOGRT ("FS Text WFL") doesn't exist as a usable project asset.** It was
  authored natively in Premiere (not After Effects), and on this machine/Premiere version,
  Premiere-native graphics don't create a backing Project panel item no matter how
  they're brought in (drag to Project panel, drag to timeline, scripted `importFiles()`
  all fail the same way — confirmed with a second, freshly-made test graphic too, so it's
  not a one-off corrupted file). **Needs to be rebuilt in After Effects** and exported as
  a normal MOGRT, matching how the scripture/default MOGRTs already work. Until then,
  Stage 5's fullscreen *graphic* placement is dormant — markers and the LT fallback still
  work fine.
- The `-1` "no label" color index is a community-sourced guess, not confirmed against
  Adobe's own docs for this Premiere version.
- Stage 4 (live Claude API call) has never actually been exercised — unit-tested against
  mocked responses only.

## Syncing between machines

Tracked in git: **https://github.com/jadinb03-dev/Verse-Assist** (private repo).
On a new machine: `git clone https://github.com/jadinb03-dev/Verse-Assist.git`.
After making changes: `git add -A && git commit -m "..." && git push`; on the other
machine, `git pull` before starting work there to avoid diverging.

The OneDrive copy at `OneDrive\Claude Edit\VerseAssist` was a one-time snapshot made
before git was set up — it is **not** kept in sync going forward; git is now the source
of truth.

## Install notes — the project repo is not the same as the *installed* extension

The git repo is the project source. The extension only actually runs in Premiere from
its CEP extensions folder, which is **outside the repo** and has to be kept in sync
manually (copy the repo's contents there) on *each* machine separately:

- **Windows**: `%APPDATA%\Adobe\CEP\extensions\VerseAssist\`
  (`C:\Users\<user>\AppData\Roaming\Adobe\CEP\extensions\VerseAssist\`). Also needs
  `PlayerDebugMode` set to `1` under `HKCU\Software\Adobe\CSXS.12` in the registry, or
  Premiere won't load an unsigned extension at all.
- **Mac**: `~/Library/Application Support/Adobe/CEP/extensions/VerseAssist/`. The
  equivalent of the debug-mode registry flag is a `defaults write` command instead:
  `defaults write com.adobe.CSXS.12 PlayerDebugMode 1` (match the CSXS version number
  to whatever this Premiere install actually uses — confirmed 12 on the Windows
  machine, worth double-checking on the Mac's Premiere version too).
- **Premiere caches `host.jsx` in memory per application session.** Closing/reopening
  the panel is *not* enough to pick up a `host.jsx` change — a full quit and relaunch
  of Premiere is required. `client/main.js` and `client/index.html` changes *do* take
  effect on a panel close/reopen alone. This applies on both platforms.
- CEP version on the Windows install is 12 (not the more commonly-documented 11) —
  worth checking what the Mac's Premiere actually registers under
  `~/Library/Preferences/com.adobe.CSXS.*` once it's installed there.
