// Verse Assist - kjvLookup.js
// Loads the bundled KJV dataset and provides verse lookup.

var VA_KJV_DATA = null;
var VA_KJV_LOAD_ERROR = null;

function vaLoadKjvData(callback) {
  if (VA_KJV_DATA || VA_KJV_LOAD_ERROR) {
    callback();
    return;
  }
  var xhr = new XMLHttpRequest();
  xhr.open("GET", "./data/kjv.json", true);
  xhr.onreadystatechange = function () {
    if (xhr.readyState === 4) {
      if (xhr.status === 200 || xhr.status === 0) {
        try {
          VA_KJV_DATA = JSON.parse(xhr.responseText);
        } catch (e) {
          VA_KJV_LOAD_ERROR = "Failed to parse kjv.json: " + e;
        }
      } else {
        VA_KJV_LOAD_ERROR = "Failed to load kjv.json (HTTP " + xhr.status + ")";
      }
      callback();
    }
  };
  xhr.send();
}

// Looks up a single verse. Returns the text string, or null if the
// book/chapter/verse doesn't exist in the dataset.
function vaLookupVerse(book, chapter, verse) {
  if (!VA_KJV_DATA) return null;
  var b = VA_KJV_DATA.books[book];
  if (!b) return null;
  var c = b[String(chapter)];
  if (!c) return null;
  var v = c[String(verse)];
  if (v === undefined) return null;
  return v;
}

// Returns the number of verses in a chapter, or 0 if the book/chapter
// doesn't exist. Used for whole-chapter and chapter-range display.
function vaChapterVerseCount(book, chapter) {
  if (!VA_KJV_DATA) return 0;
  var b = VA_KJV_DATA.books[book];
  if (!b) return 0;
  var c = b[String(chapter)];
  if (!c) return 0;
  var count = 0;
  for (var k in c) {
    if (c.hasOwnProperty(k)) count++;
  }
  return count;
}

function vaChapterExists(book, chapter) {
  if (!VA_KJV_DATA) return false;
  var b = VA_KJV_DATA.books[book];
  if (!b) return false;
  return !!b[String(chapter)];
}
