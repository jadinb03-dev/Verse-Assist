// Verse Assist - srt.js
// SRT parsing and time-based chunking with overlap and core-ownership.

function vaSrtTimeToSeconds(s) {
  var m = s.match(/^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/);
  if (!m) return null;
  var ms = Number((m[4] + "00").slice(0, 3));
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + ms / 1000;
}

function vaSecondsToSrt(sec) {
  if (sec < 0) sec = 0;
  var totalMs = Math.round(sec * 1000);
  var ms = totalMs % 1000;
  var totalS = Math.floor(totalMs / 1000);
  var s = totalS % 60;
  var m = Math.floor(totalS / 60) % 60;
  var h = Math.floor(totalS / 3600);
  function pad(n, w) { var x = String(n); while (x.length < w) x = "0" + x; return x; }
  return pad(h, 2) + ":" + pad(m, 2) + ":" + pad(s, 2) + "," + pad(ms, 3);
}

// Returns [{index, tcIn, tcOut, startSec, endSec, text}]. Throws on malformed input.
function vaParseSrt(raw) {
  var text = raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  var blocks = text.split(/\n\s*\n/);
  var out = [];
  for (var i = 0; i < blocks.length; i++) {
    var lines = blocks[i].split("\n").filter(function (l) { return l.replace(/\s+/g, "").length > 0; });
    if (lines.length < 2) continue;
    var timeLineIdx = /-->/.test(lines[0]) ? 0 : 1;
    var tm = lines[timeLineIdx].match(/^\s*(\S+)\s*-->\s*(\S+)/);
    if (!tm) continue;
    var startSec = vaSrtTimeToSeconds(tm[1]);
    var endSec = vaSrtTimeToSeconds(tm[2]);
    if (startSec === null || endSec === null) {
      throw new Error("Bad timecode in SRT block " + (i + 1) + ": " + lines[timeLineIdx]);
    }
    out.push({
      index: out.length + 1,
      tcIn: vaSecondsToSrt(startSec),
      tcOut: vaSecondsToSrt(endSec),
      startSec: startSec,
      endSec: endSec,
      text: lines.slice(timeLineIdx + 1).join(" ").replace(/\s+/g, " ").trim()
    });
  }
  if (out.length === 0) throw new Error("No SRT blocks found. Is this an .srt file?");
  return out;
}

// Splits blocks into time chunks. Each chunk has:
//  - input window: [coreStart - overlap, coreEnd + overlap] (what the model sees)
//  - core window: [coreStart, coreEnd) (cues owned by this chunk, by tc_in)
function vaChunkBlocks(blocks, coreSeconds, overlapSeconds) {
  if (blocks.length === 0) return [];
  var last = blocks[blocks.length - 1].endSec;
  var chunks = [];
  var coreStart = 0;
  while (coreStart < last) {
    var coreEnd = coreStart + coreSeconds;
    var winStart = Math.max(0, coreStart - overlapSeconds);
    var winEnd = coreEnd + overlapSeconds;
    var inWindow = blocks.filter(function (b) {
      return b.endSec > winStart && b.startSec < winEnd;
    });
    if (inWindow.length > 0) {
      chunks.push({
        number: chunks.length + 1,
        coreStart: coreStart,
        coreEnd: coreEnd,
        winStart: winStart,
        winEnd: winEnd,
        blocks: inWindow
      });
    }
    coreStart = coreEnd;
  }
  return chunks;
}
