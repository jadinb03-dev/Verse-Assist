# Hand-producing a detection JSON (no live API call needed)

Stage 4 of Verse Assist normally calls the Claude API to detect scripture cues and
production markers from a transcript. That costs money per episode, so instead this
work can be done by hand - any Claude session (not just this one) can do it, following
the same guide the live API would use as its system prompt.

This is exactly how `wfl2005_detection.json` in this repo was produced.

## What to give the other Claude session

1. **`client/prompts/scripture_detection.md`** - the full detection guide: what counts
   as a scripture mention, how to tell lower-third from fullscreen, the non-scripture
   production marker types (Section 7A), and the exact output JSON schema (Section 8).
2. **`client/data/kjv.json`** - the KJV text, for validating that every reference it
   produces actually exists (book/chapter/verse).
3. **`client/books.js`** - canonical book names and accepted abbreviations/aliases
   (e.g. "Psalm" is an accepted alias for the canonical "Psalms" - validate against
   this table, not just an exact string match on `kjv.json`'s own keys).
4. **The episode's `.srt` transcript file.**

If the other Claude has this repository cloned, it already has all four.

## What to ask for

Ask it to:

1. Read `scripture_detection.md` in full first.
2. Read the **entire** `.srt` file - large transcripts get truncated by default file-read
   tools, so explicitly ask it to keep reading in multiple passes until it's covered
   every line, per the guide's own completeness rule (Section 3.2).
3. Produce one JSON object following the Section 8 schema exactly: `cues` (scripture
   LT/FS, never including actual verse wording - only references and timecodes, per the
   guide's Hard Rule), `markers` (Website/Helpline/BRoll/Definition/Product, per Section
   7A), and `skipped_notes`.

## Validate before trusting it

Before importing the result into Stage 5, check every `reference` in `cues` actually
resolves in `client/data/kjv.json`, using the alias table in `client/books.js` to
normalize book names first (not a raw string match - the guide says "Psalm" but the
data file's key is "Psalms"). Also sanity-check: no `tc_out <= tc_in`, no overlapping
LT spans, FS cues are single verses only. A short Python or Node script can check all
of this in a few seconds - that's how `wfl2005_detection.json` was checked (0 reference
errors, no overlaps).

## Then

Paste the finished JSON into Stage 5's "Import detection JSON" box in Verse Assist.
