// Verse Assist - referenceParser.js
// Parses free-text scripture references (as they'd appear on a lower-third)
// into structured {book, chapter, verseStart, verseEnd, wholeChapter} refs.
// Depends on books.js (VA_BOOK_ALIASES, vaNormalizeBookKey, vaNormalizeNumeralPrefix).

var VA_KNOWN_TAGS = ["KJV", "NKJV", "VERIFY", "UNSURE"];

// Strips a trailing "(KJV)" / "(NKJV)" / "(verify)" / "(unsure)" tag (only
// these four, case-insensitive) and returns {text, badge}. If the
// parenthetical doesn't match a known tag, it's left alone (not stripped).
function vaStripTag(input) {
  var m = input.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (!m) {
    return { text: input.trim(), badge: null };
  }
  var inner = m[2].trim().toUpperCase();
  if (VA_KNOWN_TAGS.indexOf(inner) !== -1) {
    return { text: m[1].trim(), badge: m[2].trim() };
  }
  return { text: input.trim(), badge: null };
}

// Tries to match a book name (canonical, full, or abbreviated, with numeral
// prefix normalization) at the START of s. Returns {book, rest} on success
// (rest is what follows the book name, trimmed), or null.
function vaMatchBookAtStart(s) {
  var normalized = vaNormalizeNumeralPrefix(s.trim());
  // Try progressively shorter prefixes (word-by-word, up to 3 words, since
  // the longest book names are 3 words: "Song of Solomon", "1 Corinthians"
  // is 2 words after numeral normalization).
  var words = normalized.split(/\s+/);
  for (var wordCount = Math.min(3, words.length); wordCount >= 1; wordCount--) {
    var candidate = words.slice(0, wordCount).join(" ");
    var key = vaNormalizeBookKey(candidate);
    if (VA_BOOK_ALIASES.hasOwnProperty(key)) {
      var book = VA_BOOK_ALIASES[key];
      var restWords = words.slice(wordCount);
      var restNormalized = restWords.join(" ");
      // Map the matched prefix length back onto the ORIGINAL (non-numeral-
      // normalized) string so we return the real remainder text.
      var consumedInOriginal = s.trim().split(/\s+/).slice(0, wordCount).join(" ");
      var idx = s.indexOf(consumedInOriginal);
      var rest = idx >= 0 ? s.slice(idx + consumedInOriginal.length).trim() : restNormalized;
      return { book: book, rest: rest };
    }
  }
  return null;
}

// Parses the chapter/verse remainder (after the book name has been removed)
// for ONE piece, given the book and optional inherited context from the
// previous piece in the same comma-group.
// Returns a ref object, or null if it doesn't parse.
function vaParseChapterVerse(book, rest, inherited) {
  rest = rest.trim();
  if (rest === "") return null;

  if (/^\d+:\d+-\d+$/.test(rest)) {
    var m1 = rest.match(/^(\d+):(\d+)-(\d+)$/);
    return { book: book, chapter: m1[1], verseStart: m1[2], verseEnd: m1[3], wholeChapter: false };
  }
  if (/^\d+:\d+$/.test(rest)) {
    var m2 = rest.match(/^(\d+):(\d+)$/);
    return { book: book, chapter: m2[1], verseStart: m2[2], verseEnd: m2[2], wholeChapter: false };
  }
  if (/^\d+-\d+$/.test(rest)) {
    var m3 = rest.match(/^(\d+)-(\d+)$/);
    return { book: book, chapter: m3[1], chapterEnd: m3[2], wholeChapter: true, isChapterRange: true };
  }
  if (/^\d+$/.test(rest)) {
    // Bare number with no book/chapter context stated: if we have inherited
    // context from a verse-level previous piece in the same comma-group,
    // treat it as a new verse in the same chapter. Otherwise it's a whole
    // chapter reference.
    if (inherited && inherited.book === book && !inherited.wholeChapter) {
      return { book: book, chapter: inherited.chapter, verseStart: rest, verseEnd: rest, wholeChapter: false };
    }
    if (inherited && inherited.book === book && inherited.wholeChapter) {
      return { book: book, chapter: rest, wholeChapter: true };
    }
    return { book: book, chapter: rest, wholeChapter: true };
  }
  return null;
}

// Main entry point. Returns {refs: [...], badge: string|null, raw: string}
// or {refs: [], badge, raw, error: "..."} if nothing could be parsed.
function vaParseReference(rawInput) {
  var stripped = vaStripTag(rawInput);
  var text = stripped.text;
  var badge = stripped.badge;

  if (!text) {
    return { refs: [], badge: badge, raw: rawInput, error: "empty after stripping tag" };
  }

  var refs = [];
  var currentBook = null;
  var lastRef = null; // for same-group bare-number inheritance

  var semicolonGroups = text.split(";");
  for (var g = 0; g < semicolonGroups.length; g++) {
    var group = semicolonGroups[g].trim();
    if (!group) continue;

    var commaPieces = group.split(",");
    var groupBookEstablishedThisGroup = false;
    lastRef = null; // comma-inheritance only applies within the same group

    for (var p = 0; p < commaPieces.length; p++) {
      var piece = commaPieces[p].trim();
      if (!piece) continue;

      var bookMatch = vaMatchBookAtStart(piece);
      var book, rest;
      if (bookMatch) {
        book = bookMatch.book;
        rest = bookMatch.rest;
        currentBook = book;
        groupBookEstablishedThisGroup = true;
      } else if (currentBook) {
        book = currentBook;
        rest = piece;
      } else {
        // No book established yet anywhere - can't parse this piece.
        continue;
      }

      var ref = vaParseChapterVerse(book, rest, lastRef);
      if (ref) {
        refs.push(ref);
        lastRef = ref;
      }
    }
  }

  if (refs.length === 0) {
    return { refs: [], badge: badge, raw: rawInput, error: "no parseable reference found" };
  }
  return { refs: refs, badge: badge, raw: rawInput };
}
