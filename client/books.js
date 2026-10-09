// Verse Assist - books.js
// Canonical KJV book names (in order) and a common-abbreviation lookup table.

var VA_BOOKS_ORDER = [
  "Genesis", "Exodus", "Leviticus", "Numbers", "Deuteronomy", "Joshua", "Judges",
  "Ruth", "1 Samuel", "2 Samuel", "1 Kings", "2 Kings", "1 Chronicles",
  "2 Chronicles", "Ezra", "Nehemiah", "Esther", "Job", "Psalms", "Proverbs",
  "Ecclesiastes", "Song of Solomon", "Isaiah", "Jeremiah", "Lamentations",
  "Ezekiel", "Daniel", "Hosea", "Joel", "Amos", "Obadiah", "Jonah", "Micah",
  "Nahum", "Habakkuk", "Zephaniah", "Haggai", "Zechariah", "Malachi", "Matthew",
  "Mark", "Luke", "John", "Acts", "Romans", "1 Corinthians", "2 Corinthians",
  "Galatians", "Ephesians", "Philippians", "Colossians", "1 Thessalonians",
  "2 Thessalonians", "1 Timothy", "2 Timothy", "Titus", "Philemon", "Hebrews",
  "James", "1 Peter", "2 Peter", "1 John", "2 John", "3 John", "Jude", "Revelation"
];

// alias (lowercase, no periods, numeral-normalized) -> canonical book name.
// Includes the full canonical names themselves, since lookups are normalized
// the same way before matching.
var VA_BOOK_ALIASES = {};

var VA_ABBREVIATIONS = {
  "Genesis": ["Gen", "Ge", "Gn"],
  "Exodus": ["Exod", "Exo", "Ex"],
  "Leviticus": ["Lev", "Le", "Lv"],
  "Numbers": ["Num", "Nu", "Nm", "Numb"],
  "Deuteronomy": ["Deut", "De", "Dt"],
  "Joshua": ["Josh", "Jos", "Jsh"],
  "Judges": ["Judg", "Jdg", "Jg", "Jdgs"],
  "Ruth": ["Rth", "Ru"],
  "1 Samuel": ["Sam", "Sa", "Sm"],
  "2 Samuel": ["Sam", "Sa", "Sm"],
  "1 Kings": ["Kgs", "Ki"],
  "2 Kings": ["Kgs", "Ki"],
  "1 Chronicles": ["Chron", "Chr", "Ch"],
  "2 Chronicles": ["Chron", "Chr", "Ch"],
  "Ezra": ["Ezr"],
  "Nehemiah": ["Neh", "Ne"],
  "Esther": ["Esth", "Es"],
  "Job": ["Jb"],
  "Psalms": ["Ps", "Psalm", "Psa", "Pslm", "Psm"],
  "Proverbs": ["Prov", "Pro", "Pr", "Prv"],
  "Ecclesiastes": ["Eccles", "Eccl", "Ecc", "Ec", "Qoh"],
  "Song of Solomon": ["Song", "SOS", "Song of Songs", "Canticles", "Cant"],
  "Isaiah": ["Isa", "Is"],
  "Jeremiah": ["Jer", "Je", "Jr"],
  "Lamentations": ["Lam", "La"],
  "Ezekiel": ["Ezek", "Eze", "Ezk"],
  "Daniel": ["Dan", "Da", "Dn"],
  "Hosea": ["Hos", "Ho"],
  "Joel": ["Jl"],
  "Amos": ["Am"],
  "Obadiah": ["Obad", "Ob"],
  "Jonah": ["Jnh", "Jon"],
  "Micah": ["Mic", "Mc"],
  "Nahum": ["Nah", "Na"],
  "Habakkuk": ["Hab", "Hb"],
  "Zephaniah": ["Zeph", "Zep", "Zp"],
  "Haggai": ["Hag", "Hg"],
  "Zechariah": ["Zech", "Zec", "Zc"],
  "Malachi": ["Mal", "Ml"],
  "Matthew": ["Matt", "Mt"],
  "Mark": ["Mrk", "Mk", "Mr"],
  "Luke": ["Lk"],
  "John": ["Jn", "Jhn"],
  "Acts": ["Ac"],
  "Romans": ["Rom", "Ro", "Rm"],
  "1 Corinthians": ["Cor", "Co"],
  "2 Corinthians": ["Cor", "Co"],
  "Galatians": ["Gal", "Ga"],
  "Ephesians": ["Eph", "Ephes"],
  "Philippians": ["Phil", "Php", "Pp"],
  "Colossians": ["Col"],
  "1 Thessalonians": ["Thess", "Thes", "Th"],
  "2 Thessalonians": ["Thess", "Thes", "Th"],
  "1 Timothy": ["Tim", "Ti"],
  "2 Timothy": ["Tim", "Ti"],
  "Titus": ["Tit"],
  "Philemon": ["Philem", "Phm", "Pm"],
  "Hebrews": ["Heb"],
  "James": ["Jas", "Jm"],
  "1 Peter": ["Pet", "Pe"],
  "2 Peter": ["Pet", "Pe"],
  "1 John": ["Jn", "Jo"],
  "2 John": ["Jn", "Jo"],
  "3 John": ["Jn", "Jo"],
  "Jude": ["Jud"],
  "Revelation": ["Rev", "Re", "Rv", "Revelations", "Apocalypse"]
};

function vaNormalizeBookKey(s) {
  return s.toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim();
}

(function buildAliasTable() {
  for (var i = 0; i < VA_BOOKS_ORDER.length; i++) {
    var book = VA_BOOKS_ORDER[i];
    VA_BOOK_ALIASES[vaNormalizeBookKey(book)] = book;
  }
  for (var book2 in VA_ABBREVIATIONS) {
    if (!VA_ABBREVIATIONS.hasOwnProperty(book2)) continue;
    var numberedMatch = book2.match(/^([123]) (.+)$/);
    var abbrevs = VA_ABBREVIATIONS[book2];
    for (var j = 0; j < abbrevs.length; j++) {
      var abbrev = abbrevs[j];
      if (numberedMatch) {
        var num = numberedMatch[1];
        VA_BOOK_ALIASES[vaNormalizeBookKey(num + " " + abbrev)] = book2;
      } else {
        VA_BOOK_ALIASES[vaNormalizeBookKey(abbrev)] = book2;
      }
    }
  }
})();

// Normalizes a numeral prefix (I/II/III, First/Second/Third, 1st/2nd/3rd) to
// a plain leading digit, e.g. "First John" -> "1 John", "II Cor" -> "2 Cor".
function vaNormalizeNumeralPrefix(s) {
  return s
    .replace(/^III\s+/i, "3 ")
    .replace(/^II\s+/i, "2 ")
    .replace(/^I\s+/i, "1 ")
    .replace(/^(First|1st)\s+/i, "1 ")
    .replace(/^(Second|2nd)\s+/i, "2 ")
    .replace(/^(Third|3rd)\s+/i, "3 ");
}
