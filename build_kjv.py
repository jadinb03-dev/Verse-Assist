import json
import os
import re
import sys

SRC_DIR = r"C:\Users\jadin\AppData\Local\Temp\kjv_books"
BOOKS_ORDER_FILE = r"C:\Users\jadin\AppData\Local\Temp\Books.json"
OUT_FILE = r"C:\Users\jadin\Desktop\Claude Edit\VerseAssist\client\data\kjv.json"

FILENAME_TO_BOOK = {
    "1Chronicles.json": "1 Chronicles", "1Corinthians.json": "1 Corinthians",
    "1John.json": "1 John", "1Kings.json": "1 Kings", "1Peter.json": "1 Peter",
    "1Samuel.json": "1 Samuel", "1Thessalonians.json": "1 Thessalonians",
    "1Timothy.json": "1 Timothy", "2Chronicles.json": "2 Chronicles",
    "2Corinthians.json": "2 Corinthians", "2John.json": "2 John",
    "2Kings.json": "2 Kings", "2Peter.json": "2 Peter", "2Samuel.json": "2 Samuel",
    "2Thessalonians.json": "2 Thessalonians", "2Timothy.json": "2 Timothy",
    "3John.json": "3 John", "Acts.json": "Acts", "Amos.json": "Amos",
    "Colossians.json": "Colossians", "Daniel.json": "Daniel",
    "Deuteronomy.json": "Deuteronomy", "Ecclesiastes.json": "Ecclesiastes",
    "Ephesians.json": "Ephesians", "Esther.json": "Esther", "Exodus.json": "Exodus",
    "Ezekiel.json": "Ezekiel", "Ezra.json": "Ezra", "Galatians.json": "Galatians",
    "Genesis.json": "Genesis", "Habakkuk.json": "Habakkuk", "Haggai.json": "Haggai",
    "Hebrews.json": "Hebrews", "Hosea.json": "Hosea", "Isaiah.json": "Isaiah",
    "James.json": "James", "Jeremiah.json": "Jeremiah", "Job.json": "Job",
    "Joel.json": "Joel", "John.json": "John", "Jonah.json": "Jonah",
    "Joshua.json": "Joshua", "Jude.json": "Jude", "Judges.json": "Judges",
    "Lamentations.json": "Lamentations", "Leviticus.json": "Leviticus",
    "Luke.json": "Luke", "Malachi.json": "Malachi", "Mark.json": "Mark",
    "Matthew.json": "Matthew", "Micah.json": "Micah", "Nahum.json": "Nahum",
    "Nehemiah.json": "Nehemiah", "Numbers.json": "Numbers", "Obadiah.json": "Obadiah",
    "Philemon.json": "Philemon", "Philippians.json": "Philippians",
    "Proverbs.json": "Proverbs", "Psalms.json": "Psalms", "Revelation.json": "Revelation",
    "Romans.json": "Romans", "Ruth.json": "Ruth", "SongofSolomon.json": "Song of Solomon",
    "Titus.json": "Titus", "Zechariah.json": "Zechariah", "Zephaniah.json": "Zephaniah",
}

with open(BOOKS_ORDER_FILE, encoding="utf-8") as f:
    books_order = json.load(f)

filename_by_book = {v: k for k, v in FILENAME_TO_BOOK.items()}

missing_mapping = [b for b in books_order if b not in filename_by_book]
if missing_mapping:
    print("ERROR: no filename mapping for:", missing_mapping)
    sys.exit(1)

combined = {}  # book -> chapter(str) -> verse(str) -> text
total_verses = 0
strongs_like = []
empty_texts = []

STRONGS_PATTERN = re.compile(r"\{[HG]?\d+\}|<S>\d+</S>|\\[HG]\d+\\")

for book in books_order:
    fname = filename_by_book[book]
    path = os.path.join(SRC_DIR, fname)
    with open(path, encoding="utf-8") as f:
        data = json.load(f)

    if data.get("book") != book:
        print("WARNING: book field mismatch in %s: expected %r got %r" % (fname, book, data.get("book")))

    combined[book] = {}
    for chapter_obj in data["chapters"]:
        chnum = chapter_obj["chapter"]
        combined[book][chnum] = {}
        for verse_obj in chapter_obj["verses"]:
            vnum = verse_obj["verse"]
            text = verse_obj["text"]
            total_verses += 1
            if STRONGS_PATTERN.search(text):
                strongs_like.append("%s %s:%s" % (book, chnum, vnum))
            if not text or not text.strip():
                empty_texts.append("%s %s:%s" % (book, chnum, vnum))
            combined[book][chnum][vnum] = text

print("Total books processed:", len(combined))
print("Total verses:", total_verses)
print("Expected: 31102")
print("Match:", total_verses == 31102)
print("Verses with possible Strong's-style markup:", len(strongs_like))
if strongs_like[:10]:
    print("  examples:", strongs_like[:10])
print("Empty verse texts:", len(empty_texts))
if empty_texts[:10]:
    print("  examples:", empty_texts[:10])

os.makedirs(os.path.dirname(OUT_FILE), exist_ok=True)
with open(OUT_FILE, "w", encoding="utf-8") as f:
    json.dump({"edition": "KJV (source: aruljohn/Bible-kjv, MIT licensed, public-domain text)", "books": combined}, f, ensure_ascii=False)

print("Wrote", OUT_FILE)
print("Output file size (bytes):", os.path.getsize(OUT_FILE))
