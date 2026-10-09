var csInterface = new CSInterface();

var LS_KEY_MOGRT_NAME = "verseAssist.mogrtName";
var LS_KEY_MOGRT_PATH = "verseAssist.mogrtPath";
var LS_KEY_TRACK_NUMBER = "verseAssist.trackNumber";
var LS_KEY_TEXT_PARAM_NAME = "verseAssist.textParamName";
var LS_KEY_ANIMATION_PARAM_NAME = "verseAssist.animationParamName";

function log(msg, cls) {
  var el = document.getElementById("log");
  var span = document.createElement("div");
  if (cls) span.className = cls;
  span.textContent = msg;
  el.appendChild(span);
  el.scrollTop = el.scrollHeight;
}

function logJsonResult(result) {
  try {
    var obj = JSON.parse(result);
    log(JSON.stringify(obj, null, 2), obj.success === false ? "err" : "info");
    return obj;
  } catch (e) {
    log("Non-JSON response from host (raw): " + result, "err");
    return null;
  }
}

function getTrackIndex0Based() {
  var n = parseInt(document.getElementById("trackNumber").value, 10);
  if (isNaN(n) || n < 1) n = 1;
  return n - 1;
}

function evalHost(call, callback) {
  if (!window.__adobe_cep__) {
    // Not running inside CEP (e.g. loaded in a plain browser for testing).
    if (callback) callback(JSON.stringify({ success: false, error: "CEP bridge (__adobe_cep__) not present - not running inside Premiere." }));
    return;
  }
  try {
    csInterface.evalScript(call, callback);
  } catch (e) {
    if (callback) callback(JSON.stringify({ success: false, error: "evalScript threw: " + e }));
  }
}

// ---- Settings persistence ----
function loadSettings() {
  var name = localStorage.getItem(LS_KEY_MOGRT_NAME);
  var path = localStorage.getItem(LS_KEY_MOGRT_PATH);
  var track = localStorage.getItem(LS_KEY_TRACK_NUMBER);
  var textParam = localStorage.getItem(LS_KEY_TEXT_PARAM_NAME);
  var animParam = localStorage.getItem(LS_KEY_ANIMATION_PARAM_NAME);
  if (name) document.getElementById("mogrtName").value = name;
  if (path) document.getElementById("mogrtPath").value = path;
  if (track) document.getElementById("trackNumber").value = track;
  if (textParam) document.getElementById("textParamName").value = textParam;
  if (animParam) document.getElementById("animationParamName").value = animParam;
}
function saveSettings() {
  localStorage.setItem(LS_KEY_MOGRT_NAME, document.getElementById("mogrtName").value);
  localStorage.setItem(LS_KEY_MOGRT_PATH, document.getElementById("mogrtPath").value);
  localStorage.setItem(LS_KEY_TRACK_NUMBER, document.getElementById("trackNumber").value);
  localStorage.setItem(LS_KEY_TEXT_PARAM_NAME, document.getElementById("textParamName").value);
  localStorage.setItem(LS_KEY_ANIMATION_PARAM_NAME, document.getElementById("animationParamName").value);
}

// ---- Startup: show Premiere version ----
function checkAppInfo() {
  evalHost("vaGetAppInfo()", function (result) {
    var infoEl = document.getElementById("appInfo");
    try {
      var obj = JSON.parse(result);
      if (obj.success) {
        infoEl.textContent = obj.appName + " " + obj.version;
        infoEl.className = "";
      } else {
        infoEl.textContent = "Could not read Premiere version: " + obj.error;
        infoEl.className = "warn";
      }
    } catch (e) {
      infoEl.textContent = "Could not reach the ExtendScript host (raw response: " + result + "). Is debug mode enabled for CSXS.12?";
      infoEl.className = "warn";
    }
  });
}

// ---- Stage 3: Cue List ----
var LS_KEY_CSV_PATH = "verseAssist.csvPath";

function log3(msg, cls) {
  var el = document.getElementById("stage3Log");
  var span = document.createElement("div");
  if (cls) span.className = cls;
  span.textContent = msg;
  el.appendChild(span);
  el.scrollTop = el.scrollHeight;
}

function loadStage3Settings() {
  var csv = localStorage.getItem(LS_KEY_CSV_PATH);
  if (csv) document.getElementById("csvPath").value = csv;
}
function saveStage3Settings() {
  localStorage.setItem(LS_KEY_CSV_PATH, document.getElementById("csvPath").value);
}

function refreshSequenceTimingInfo() {
  var el = document.getElementById("sequenceTimingInfo");
  evalHost("vaGetSequenceTimingInfo()", function (result) {
    try {
      var obj = JSON.parse(result);
      if (obj.success) {
        var t = obj.timing;
        el.textContent = "Sequence timing: timebase=" + t.timebase + ", frame rate=" + t.actualFrameRate.toFixed(3) + "fps (nominal " + t.nominalFps + "), " + (t.isDropFrame ? "DROP-FRAME" : "non-drop") + " (displayFormat code " + t.videoDisplayFormat + ")";
      } else {
        el.textContent = "Could not read sequence timing: " + obj.error;
      }
    } catch (e) {
      el.textContent = "Could not read sequence timing (raw: " + result + ")";
    }
  });
}

// ---- Stage 2: Verse Viewer ----
var vaPollTimer = null;
var vaPollInFlight = false;
var vaPollDurations = []; // rolling window of round-trip ms, for the perf readout
var VA_POLL_INTERVAL_MS = 300;
var VA_POLL_WINDOW = 20;

function vaFormatRefHeading(ref) {
  if (ref.isChapterRange) return ref.book + " " + ref.chapter + "-" + ref.chapterEnd;
  if (ref.wholeChapter) return ref.book + " " + ref.chapter;
  if (ref.verseStart === ref.verseEnd) return ref.book + " " + ref.chapter + ":" + ref.verseStart;
  return ref.book + " " + ref.chapter + ":" + ref.verseStart + "-" + ref.verseEnd;
}

function vaBuildVerseLines(ref) {
  var lines = [];
  if (ref.isChapterRange) {
    var startCh = parseInt(ref.chapter, 10);
    var endCh = parseInt(ref.chapterEnd, 10);
    for (var ch = startCh; ch <= endCh; ch++) {
      if (!vaChapterExists(ref.book, ch)) {
        lines.push({ num: ch, text: null, isChapterLabel: true });
        continue;
      }
      var count = vaChapterVerseCount(ref.book, ch);
      lines.push({ num: ch, text: null, isChapterLabel: true, label: "Chapter " + ch });
      for (var v = 1; v <= count; v++) {
        lines.push({ num: v, text: vaLookupVerse(ref.book, ch, v) });
      }
    }
  } else if (ref.wholeChapter) {
    if (!vaChapterExists(ref.book, ref.chapter)) {
      lines.push({ num: ref.chapter, text: null });
    } else {
      var cnt = vaChapterVerseCount(ref.book, ref.chapter);
      for (var vv = 1; vv <= cnt; vv++) {
        lines.push({ num: vv, text: vaLookupVerse(ref.book, ref.chapter, vv) });
      }
    }
  } else {
    var vs = parseInt(ref.verseStart, 10);
    var ve = parseInt(ref.verseEnd, 10);
    for (var vn = vs; vn <= ve; vn++) {
      lines.push({ num: vn, text: vaLookupVerse(ref.book, ref.chapter, vn) });
    }
  }
  return lines;
}

function vaRenderViewer(clips) {
  var area = document.getElementById("viewerArea");
  var cards = [];

  clips.forEach(function (clip) {
    clip.textParams.forEach(function (tp) {
      var parsed = vaParseReference(tp.text);
      if (!parsed || parsed.refs.length === 0) return; // not a scripture reference, ignore

      var cardHtml = "<div class='verse-card'>";

      parsed.refs.forEach(function (ref, idx) {
        var headingClass = "verse-ref-heading" + (idx > 0 ? " verse-ref-subheading" : "");
        cardHtml += "<div class='" + headingClass + "'>" + vaEscapeHtml(vaFormatRefHeading(ref));
        if (parsed.badge && idx === 0) {
          cardHtml += "<span class='verse-badge'>" + vaEscapeHtml(parsed.badge) + "</span>";
        }
        cardHtml += "</div>";

        var lines = vaBuildVerseLines(ref);
        lines.forEach(function (line) {
          if (line.isChapterLabel) {
            cardHtml += "<div class='verse-line' style='color:#999;margin-top:6px;'>" + vaEscapeHtml(line.label) + "</div>";
          } else if (line.text === null) {
            cardHtml += "<div class='verse-line verse-not-found'>" + line.num + ": not found</div>";
          } else {
            cardHtml += "<div class='verse-line'><span class='verse-num'>" + line.num + "</span><span class='verse-text'>" + vaEscapeHtml(line.text) + "</span><button type='button' class='verse-copy-btn' data-verse-text='" + vaEscapeHtml(line.text) + "' title='Copy this verse'>Copy</button></div>";
          }
        });
      });

      cardHtml += "</div>";
      cards.push(cardHtml);
    });
  });

  if (cards.length === 0) {
    area.innerHTML = "<div class='empty-state'>No scripture references detected under the playhead.</div>";
  } else {
    area.innerHTML = cards.join("");
  }
}

// Copies just the verse text (no reference, no verse number) to the clipboard.
function vaCopyFallback(text) {
  var ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); } catch (eCopy) { /* best effort */ }
  document.body.removeChild(ta);
}

function vaCopyVerseToClipboard(text, btn) {
  var flash = function () {
    if (!btn) return;
    var prev = btn.textContent;
    btn.textContent = "Copied";
    btn.classList.add("copied");
    setTimeout(function () {
      btn.textContent = prev;
      btn.classList.remove("copied");
    }, 900);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(flash, function () { vaCopyFallback(text); flash(); });
  } else {
    vaCopyFallback(text);
    flash();
  }
}

function vaEscapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

function vaUpdatePerfReadout() {
  var statusEl = document.getElementById("viewerStatus");
  if (vaPollDurations.length === 0) {
    statusEl.textContent = "Watching playhead...";
    return;
  }
  var sum = vaPollDurations.reduce(function (a, b) { return a + b; }, 0);
  var avg = sum / vaPollDurations.length;
  var max = Math.max.apply(null, vaPollDurations);
  statusEl.textContent = "Watching playhead... round-trip avg " + avg.toFixed(0) + "ms, max " + max.toFixed(0) + "ms (last " + vaPollDurations.length + " polls)";
}

function vaPollOnce() {
  if (vaPollInFlight) return; // don't stack calls if a previous one is still out
  vaPollInFlight = true;
  var startTime = performance.now();
  evalHost("vaGetMogrtTextsUnderPlayhead()", function (result) {
    var elapsed = performance.now() - startTime;
    vaPollDurations.push(elapsed);
    if (vaPollDurations.length > VA_POLL_WINDOW) vaPollDurations.shift();
    vaPollInFlight = false;

    try {
      var obj = JSON.parse(result);
      if (obj.success) {
        vaRenderViewer(obj.clips);
        vaUpdatePerfReadout();
      } else {
        document.getElementById("viewerStatus").textContent = "Error: " + obj.error;
      }
    } catch (e) {
      document.getElementById("viewerStatus").textContent = "Error reading host response: " + result;
    }
  });
}

function vaStartPolling() {
  if (vaPollTimer) return;
  vaPollDurations = [];
  vaPollTimer = setInterval(vaPollOnce, VA_POLL_INTERVAL_MS);
  vaPollOnce();
  document.getElementById("pollToggleBtn").textContent = "Stop Watching Playhead";
  document.getElementById("pollToggleBtn").classList.add("toggledOn");
}

function vaStopPolling() {
  if (vaPollTimer) {
    clearInterval(vaPollTimer);
    vaPollTimer = null;
  }
  document.getElementById("pollToggleBtn").textContent = "Start Watching Playhead";
  document.getElementById("pollToggleBtn").classList.remove("toggledOn");
  document.getElementById("viewerStatus").textContent = "Not watching. Click \"Start Watching Playhead\" to begin.";
}

document.addEventListener("DOMContentLoaded", function () {
  loadSettings();
  checkAppInfo();

  vaLoadKjvData(function () {
    if (VA_KJV_LOAD_ERROR) {
      document.getElementById("viewerStatus").textContent = "KJV data failed to load: " + VA_KJV_LOAD_ERROR;
    }
    // Review rows are validated against the KJV, so draw them only once it's loaded.
    renderReviewTable();
  });

  var vaTabs = [
    { btn: "tabBtnStage1", panel: "tabStage1" },
    { btn: "tabBtnStage2", panel: "tabStage2" },
    { btn: "tabBtnStage3", panel: "tabStage3" },
    { btn: "tabBtnStage4", panel: "tabStage4" },
    { btn: "tabBtnStage5", panel: "tabStage5" }
  ];
  vaTabs.forEach(function (tab) {
    document.getElementById(tab.btn).addEventListener("click", function () {
      vaTabs.forEach(function (t) {
        document.getElementById(t.btn).classList.toggle("active", t.btn === tab.btn);
        document.getElementById(t.panel).classList.toggle("active", t.panel === tab.panel);
      });
      if (tab.panel === "tabStage3") {
        refreshSequenceTimingInfo();
      }
    });
  });

  document.getElementById("pollToggleBtn").addEventListener("click", function () {
    if (vaPollTimer) {
      vaStopPolling();
    } else {
      vaStartPolling();
    }
  });

  document.getElementById("largeTextToggle").addEventListener("change", function (e) {
    document.getElementById("viewerArea").classList.toggle("large-text", e.target.checked);
  });

  // Delegated: viewerArea's contents are replaced wholesale on every poll, so a single
  // listener on the stable container (rather than one per button) survives that.
  document.getElementById("viewerArea").addEventListener("click", function (e) {
    var btn = e.target.closest ? e.target.closest(".verse-copy-btn") : null;
    if (!btn) return;
    vaCopyVerseToClipboard(btn.getAttribute("data-verse-text") || "", btn);
  });

  document.getElementById("mogrtName").addEventListener("change", saveSettings);
  document.getElementById("mogrtPath").addEventListener("change", saveSettings);
  document.getElementById("trackNumber").addEventListener("change", saveSettings);
  document.getElementById("textParamName").addEventListener("change", saveSettings);
  document.getElementById("animationParamName").addEventListener("change", saveSettings);

  document.getElementById("clearLogBtn").addEventListener("click", function () {
    document.getElementById("log").innerHTML = "";
  });

  document.getElementById("browseBtn").addEventListener("click", function () {
    evalHost("vaBrowseForMogrt()", function (result) {
      var obj = logJsonResult(result);
      if (obj && obj.success) {
        document.getElementById("mogrtPath").value = obj.path;
        saveSettings();
      }
    });
  });

  document.getElementById("insertBtn").addEventListener("click", function () {
    var name = document.getElementById("mogrtName").value;
    var path = document.getElementById("mogrtPath").value;
    var trackIndex = getTrackIndex0Based();
    var animationParamName = document.getElementById("animationParamName").value;
    var call;

    if (name) {
      log("Looking for \"" + name + "\" in the Project panel, placing on V" + (trackIndex + 1) + " at playhead...", "info");
      call = "vaInsertExistingMogrtAtPlayhead(" + JSON.stringify(name) + ", " + trackIndex + ", " + JSON.stringify(animationParamName) + ")";
    } else if (path) {
      log("Importing " + path + " and placing on V" + (trackIndex + 1) + " at playhead...", "info");
      call = "vaInsertMogrtAtPlayhead(" + JSON.stringify(path) + ", " + trackIndex + ", " + JSON.stringify(animationParamName) + ")";
    } else {
      log("Set a MOGRT name (preferred) or a file path first.", "err");
      return;
    }

    evalHost(call, function (result) {
      var obj = logJsonResult(result);
      if (obj && obj.success) {
        log("Placed \"" + obj.clipName + "\" from " + obj.startSeconds.toFixed(3) + "s to " + obj.endSeconds.toFixed(3) + "s.", "ok");
        if (obj.animationToggle) {
          if (obj.animationToggle.attempted) {
            log("Animation toggle: " + (obj.animationToggle.success ? "turned off OK." : "FAILED - " + obj.animationToggle.error), obj.animationToggle.success ? "ok" : "warn");
          } else if (obj.animationToggle.reason) {
            log("Animation toggle: not attempted - " + obj.animationToggle.reason, "warn");
          }
        }
      }
    });
  });

  document.getElementById("dumpBtn").addEventListener("click", function () {
    var trackIndex = getTrackIndex0Based();
    log("Dumping components on clip near playhead on V" + (trackIndex + 1) + "...", "info");
    var call = "vaDumpComponents(" + trackIndex + ")";
    evalHost(call, function (result) {
      logJsonResult(result);
    });
  });

  document.getElementById("setTextBtn").addEventListener("click", function () {
    var trackIndex = getTrackIndex0Based();
    var testString = "John 3:16";
    var textParamName = document.getElementById("textParamName").value;
    if (!textParamName) {
      log("Set a Text parameter name first (e.g. \"LT Text\").", "err");
      return;
    }
    log("Attempting to set \"" + textParamName + "\" on clip near playhead on V" + (trackIndex + 1) + " to \"" + testString + "\"...", "info");
    var call = "vaSetTestText(" + trackIndex + ", " + JSON.stringify(testString) + ", " + JSON.stringify(textParamName) + ")";
    evalHost(call, function (result) {
      var obj = logJsonResult(result);
      if (obj && obj.success && obj.attempts) {
        var okCount = 0;
        obj.attempts.forEach(function (a) {
          if (a.success) okCount++;
        });
        log(okCount + " of " + obj.attempts.length + " candidate text parameter(s) set successfully.", okCount > 0 ? "ok" : "warn");
      }
    });
  });

  // ---- Stage 3 wiring ----
  loadStage3Settings();
  document.getElementById("csvPath").addEventListener("change", saveStage3Settings);

  document.getElementById("clearStage3LogBtn").addEventListener("click", function () {
    document.getElementById("stage3Log").innerHTML = "";
  });

  document.getElementById("browseCsvBtn").addEventListener("click", function () {
    evalHost("vaBrowseForCsv()", function (result) {
      try {
        var obj = JSON.parse(result);
        if (obj.success) {
          document.getElementById("csvPath").value = obj.path;
          saveStage3Settings();
        } else {
          log3(obj.error, "err");
        }
      } catch (e) {
        log3("Non-JSON response: " + result, "err");
      }
    });
  });

  document.getElementById("runCueListBtn").addEventListener("click", function () {
    var csvPath = document.getElementById("csvPath").value;
    var mogrtName = document.getElementById("mogrtName").value;
    var trackIndex = getTrackIndex0Based();
    var textParamName = document.getElementById("textParamName").value;
    var animationParamName = document.getElementById("animationParamName").value;

    if (!csvPath) { log3("Set a cue list CSV path first.", "err"); return; }
    if (!mogrtName) { log3("Set the MOGRT name in the \"Stage 1: MOGRT Tools\" tab first.", "err"); return; }
    if (!textParamName) { log3("Set the text parameter name in the \"Stage 1: MOGRT Tools\" tab first.", "err"); return; }

    log3("Running cue list " + csvPath + " on V" + (trackIndex + 1) + " with MOGRT \"" + mogrtName + "\", text param \"" + textParamName + "\"...", "info");

    var call = "vaPlaceCueList(" + JSON.stringify(csvPath) + ", " + JSON.stringify(mogrtName) + ", " + trackIndex + ", " + JSON.stringify(textParamName) + ", " + JSON.stringify(animationParamName) + ")";
    evalHost(call, function (result) {
      try {
        var obj = JSON.parse(result);
        if (!obj.success) {
          log3("FAILED: " + obj.error, "err");
          return;
        }
        var t = obj.timing;
        log3("Sequence timing: timebase=" + t.timebase + ", frame rate=" + t.actualFrameRate.toFixed(3) + "fps (nominal " + t.nominalFps + "), " + (t.isDropFrame ? "DROP-FRAME" : "non-drop"), "info");
        log3("Done. Placed: " + obj.placedCount + ". Skipped/failed: " + obj.skippedCount + ".", obj.skippedCount > 0 ? "warn" : "ok");
        if (obj.skipped && obj.skipped.length) {
          log3("Skipped rows:", "warn");
          obj.skipped.forEach(function (s) { log3("  - " + s, "warn"); });
        }
      } catch (e) {
        log3("Non-JSON response: " + result, "err");
      }
    });
  });

  // ---- Stage 4: scripture detection (single pass) ----
  var LS_KEY_API_KEY = "verseAssist.claudeApiKey";
  var LS_KEY_MODEL = "verseAssist.claudeModel";
  var LS_KEY_TRANSCRIPT = "verseAssist.transcriptPath";
  var LS_KEY_LAST_DETECTION = "verseAssist.lastDetection";
  var LS_KEY_PRODUCT_NAME = "verseAssist.productTeachingName";

  function log4(msg, cls) {
    var el = document.getElementById("stage4Log");
    var span = document.createElement("div");
    if (cls) span.className = cls;
    span.textContent = msg;
    el.appendChild(span);
    el.scrollTop = el.scrollHeight;
  }

  function loadStage4Settings() {
    var k = localStorage.getItem(LS_KEY_API_KEY);
    var m = localStorage.getItem(LS_KEY_MODEL);
    var t = localStorage.getItem(LS_KEY_TRANSCRIPT);
    var pn = localStorage.getItem(LS_KEY_PRODUCT_NAME);
    if (k) document.getElementById("claudeApiKey").value = k;
    if (m) document.getElementById("claudeModel").value = m;
    if (t) document.getElementById("transcriptPath").value = t;
    if (pn) document.getElementById("productTeachingName").value = pn;
  }
  function saveStage4Settings() {
    localStorage.setItem(LS_KEY_API_KEY, document.getElementById("claudeApiKey").value);
    localStorage.setItem(LS_KEY_MODEL, document.getElementById("claudeModel").value);
    localStorage.setItem(LS_KEY_TRANSCRIPT, document.getElementById("transcriptPath").value);
    localStorage.setItem(LS_KEY_PRODUCT_NAME, document.getElementById("productTeachingName").value);
  }

  function renderStage4Result(res) {
    var lt = res.cues.filter(function (c) { return c.display === "LT"; }).length;
    var fs = res.cues.filter(function (c) { return c.display === "FS"; }).length;
    var flagged = res.cues.filter(function (c) { return c.flag; }).length;
    var markers = res.markers || [];

    log4("", null);
    log4("=== RESULT ===", "info");
    log4("Chunks: " + res.chunkCount + ". LT cues: " + lt + ". FS cues: " + fs + ". Flagged (verify/unsure): " + flagged + ". Production markers: " + markers.length + ".", "info");

    if (res.failedChunks.length) {
      log4("WARNING: " + res.failedChunks.length + " chunk(s) FAILED. These time windows are NOT covered:", "err");
      res.failedChunks.forEach(function (f) { log4("  - chunk " + f.chunk + " window " + f.window + ": " + f.error, "err"); });
    }

    res.cues.forEach(function (c) {
      var line;
      if (c.display === "FS") {
        line = "FS " + c.tc_in + " -> " + c.tc_out + " (display to " + vaSecondsToSrt(c.displayEndSec) + ") | " + c.reference + " | " + c.mention_type;
      } else {
        line = "LT " + c.tc_in + " -> " + c.tc_out + " | " + c.reference + " | " + c.mention_type;
      }
      if (c.flag) line += " [" + c.flag + "]";
      log4(line, c.flag ? "warn" : null);
      if (c.display === "FS") log4("    \"" + c.verseText + "\"", "info");
      if (c.trigger_quote) log4("    quote: " + c.trigger_quote, null);
    });

    markers.forEach(function (m) {
      var line = m.type + " " + m.tc_in + (m.name ? " | " + m.name : "");
      log4(line, null);
      if (m.trigger_quote) log4("    quote: " + m.trigger_quote, null);
    });

    if (res.rejected.length) {
      log4("Rejected by validation (" + res.rejected.length + "):", "warn");
      res.rejected.forEach(function (r) { log4("  - chunk " + r.chunk + " " + r.tc + " " + r.reference + ": " + r.reason, "warn"); });
    }
    if (res.skipped.length) {
      log4("Skipped notes (" + res.skipped.length + "):", "info");
      res.skipped.forEach(function (s) { log4("  - " + s.tc + " \"" + s.quote + "\" - " + s.reason, "info"); });
    }

    window.vaLastDetection = res;
    try {
      localStorage.setItem(LS_KEY_LAST_DETECTION, JSON.stringify(res));
      reviewRows = buildReviewRows(res);
      saveReviewRows();
      renderReviewTable();
      log4("Saved for Stage 5 review (" + reviewRows.length + " rows).", "info");
    } catch (e) {
      log4("Could not save result to local storage (" + e + "). It is still held in memory for this session.", "warn");
    }
  }

  loadStage4Settings();
  ["claudeApiKey", "claudeModel", "transcriptPath", "productTeachingName"].forEach(function (id) {
    document.getElementById(id).addEventListener("change", saveStage4Settings);
  });

  document.getElementById("clearStage4LogBtn").addEventListener("click", function () {
    document.getElementById("stage4Log").innerHTML = "";
  });

  document.getElementById("browseTranscriptBtn").addEventListener("click", function () {
    evalHost("vaBrowseForTranscript()", function (result) {
      try {
        var obj = JSON.parse(result);
        if (obj.success) {
          document.getElementById("transcriptPath").value = obj.path;
          saveStage4Settings();
        } else {
          log4(obj.error, "err");
        }
      } catch (e) {
        log4("Non-JSON response: " + result, "err");
      }
    });
  });

  document.getElementById("runDetectBtn").addEventListener("click", function () {
    var apiKey = document.getElementById("claudeApiKey").value.trim();
    var model = document.getElementById("claudeModel").value.trim();
    var path = document.getElementById("transcriptPath").value.trim();
    if (!apiKey) { log4("Enter your Claude API key first.", "err"); return; }
    if (!model) { log4("Enter a model name first.", "err"); return; }
    if (!path) { log4("Choose a transcript .srt file first.", "err"); return; }

    log4("Loading KJV data and detection prompt...", "info");
    vaLoadKjvData(function () {
      if (VA_KJV_LOAD_ERROR) { log4("KJV data failed to load: " + VA_KJV_LOAD_ERROR, "err"); return; }
      vaLoadDetectPrompt(function () {
        if (VA_DETECT_PROMPT_ERROR) { log4(VA_DETECT_PROMPT_ERROR, "err"); return; }
        evalHost("vaReadTextFile(" + JSON.stringify(path) + ")", function (result) {
          var file;
          try { file = JSON.parse(result); } catch (e) { log4("Non-JSON response reading transcript: " + result, "err"); return; }
          if (!file.success) { log4("Could not read transcript: " + file.error, "err"); return; }
          var blocks;
          try { blocks = vaParseSrt(file.text); } catch (e) { log4("Transcript parse error: " + e.message, "err"); return; }
          log4("Parsed " + blocks.length + " SRT blocks, ending " + blocks[blocks.length - 1].tcOut + ". Running single-pass detection...", "info");
          var productTeachingName = document.getElementById("productTeachingName").value.trim();
          vaRunScriptureDetection({ blocks: blocks, apiKey: apiKey, model: model, productTeachingName: productTeachingName }, log4, renderStage4Result);
        });
      });
    });
  });

  // ---- Stage 5: review and apply ----
  var reviewRows = [];
  var LS_KEY_REVIEW_ROWS = "verseAssist.reviewRows";
  var LS_KEY_APPLIED = "verseAssist.appliedRecord";
  var LS_KEY_FS_COLOR = "verseAssist.fsMarkerColor";
  var VA_COLOR_NAMES = ["Green", "Red", "Purple", "Orange", "Yellow", "White", "Blue", "Cyan"];

  function log5(msg, cls) {
    var el = document.getElementById("stage5Log");
    var span = document.createElement("div");
    if (cls) span.className = cls;
    span.textContent = msg;
    el.appendChild(span);
    el.scrollTop = el.scrollHeight;
  }

  // Review rows are built from Stage 4 output. tc_out is the range the item
  // will occupy: the spoken end for LT, and the readable hold end for FS.
  function buildReviewRows(res) {
    var rows = res.cues.map(function (c, i) {
      var isFs = c.display === "FS";
      return {
        id: i + 1,
        kind: c.display,
        tc_in: c.tc_in,
        tc_out: isFs ? vaSecondsToSrt(c.displayEndSec) : c.tc_out,
        reference: c.reference,
        mention_type: c.mention_type,
        flag: c.flag,
        comment: isFs ? (c.verseText || "") : "",
        approved: !c.flag,   // flagged rows start unapproved so you look at them first
        deleted: false,
        error: null
      };
    });
    // Non-scripture production markers (Website/Helpline/BRoll/Definition/Product) -
    // no KJV validation, no graphic, just a plain default-colored marker on apply.
    (res.markers || []).forEach(function (m, i) {
      rows.push({
        id: rows.length + i + 1,
        kind: "MARKER",
        markerType: m.type,
        tc_in: m.tc_in,
        tc_out: m.tc_in,
        reference: m.name || "",
        mention_type: null,
        flag: null,
        comment: m.trigger_quote || "",
        approved: true,
        deleted: false,
        error: null
      });
    });
    return rows;
  }

  function saveReviewRows() {
    try { localStorage.setItem(LS_KEY_REVIEW_ROWS, JSON.stringify(reviewRows)); } catch (e) { log5("Could not save review rows: " + e, "warn"); }
  }

  // Re-checks one row's reference against the parser and KJV, and refreshes FS comment text.
  function validateReviewRow(row) {
    row.error = null;
    if (row.kind === "MARKER") { return; } // type/tc_in already validated at detection/import time
    var parsed = vaParseReference(row.reference || "");
    if (!parsed.refs || parsed.refs.length === 0) { row.error = "reference does not parse"; row.comment = row.kind === "FS" ? "" : row.comment; return; }
    for (var i = 0; i < parsed.refs.length; i++) {
      var problem = vaCheckRefExists(parsed.refs[i]);
      if (problem) { row.error = problem; return; }
    }
    if (row.kind === "FS") {
      if (parsed.refs.length !== 1 || parsed.refs[0].verseStart !== parsed.refs[0].verseEnd || parsed.refs[0].wholeChapter) {
        row.error = "FS must be a single verse";
        return;
      }
      var r = parsed.refs[0];
      row.comment = vaLookupVerse(r.book, r.chapter, r.verseStart) || "";
    }
  }

  function renderReviewTable() {
    var box = document.getElementById("reviewTable");
    var summary = document.getElementById("reviewSummary");
    if (reviewRows.length === 0) {
      box.innerHTML = "";
      summary.textContent = "No detection results yet. Run Stage 4 first.";
      return;
    }
    var html = "<table style='width:100%; border-collapse:collapse; font-size:11px;'>";
    html += "<tr style='text-align:left; color:#aaa;'><th>OK</th><th>Type</th><th>In</th><th>Out</th><th>Reference</th><th>Comment</th><th>Flag</th><th></th></tr>";
    reviewRows.forEach(function (row, idx) {
      if (row.deleted) return;
      validateReviewRow(row);
      var rowClass = row.flag ? "warn" : "";
      html += "<tr class='" + rowClass + "' style='border-top:1px solid #444;'>";
      html += "<td><input type='checkbox' data-act='approve' data-idx='" + idx + "'" + (row.approved ? " checked" : "") + "></td>";
      html += "<td>" + (row.kind === "MARKER" ? vaEscapeHtml(row.markerType) : row.kind) + "</td>";
      html += "<td>" + row.tc_in + "</td>";
      html += "<td>" + row.tc_out + "</td>";
      html += "<td><input type='text' data-act='ref' data-idx='" + idx + "' value='" + vaEscapeHtml(row.reference) + "' style='width:130px;" + (row.error ? "border-color:#e06060;" : "") + "'" + (row.error ? " title='" + vaEscapeHtml(row.error) + "'" : "") + "></td>";
      html += "<td style='max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;' title='" + vaEscapeHtml(row.comment) + "'>" + vaEscapeHtml(row.comment) + "</td>";
      html += "<td>" + (row.flag || "") + (row.error ? " <span style='color:#e06060;'>" + vaEscapeHtml(row.error) + "</span>" : "") + "</td>";
      html += "<td><button data-act='delete' data-idx='" + idx + "'>Delete</button></td>";
      html += "</tr>";
    });
    html += "</table>";
    box.innerHTML = html;

    var live = reviewRows.filter(function (r) { return !r.deleted; });
    var approved = live.filter(function (r) { return r.approved; }).length;
    var blocked = live.filter(function (r) { return r.error; }).length;
    summary.textContent = live.length + " row(s): " + approved + " approved, " + (live.length - approved) + " not approved, " + blocked + " with errors. Flagged rows start unapproved.";
  }

  document.getElementById("reviewTable").addEventListener("change", function (e) {
    var t = e.target;
    var idx = parseInt(t.getAttribute("data-idx"), 10);
    if (isNaN(idx) || !reviewRows[idx]) return;
    if (t.getAttribute("data-act") === "approve") {
      reviewRows[idx].approved = t.checked;
    } else if (t.getAttribute("data-act") === "ref") {
      reviewRows[idx].reference = t.value.trim();
    }
    saveReviewRows();
    renderReviewTable();
  });

  document.getElementById("reviewTable").addEventListener("click", function (e) {
    var t = e.target;
    if (t.getAttribute("data-act") !== "delete") return;
    var idx = parseInt(t.getAttribute("data-idx"), 10);
    if (!reviewRows[idx]) return;
    reviewRows[idx].deleted = true;
    saveReviewRows();
    renderReviewTable();
  });

  // Imports a detection result pasted from elsewhere (e.g. produced by hand from a
  // transcript). Every cue goes through the same validation as the API pipeline.
  function importDetectionJson(text) {
    var obj;
    try { obj = JSON.parse(text); } catch (e) { log5("Not valid JSON: " + e.message, "err"); return; }
    if (!obj || !Array.isArray(obj.cues)) { log5("JSON has no cues array.", "err"); return; }
    var accepted = [];
    var rejected = [];
    obj.cues.forEach(function (raw) {
      var v = vaValidateCue(raw);
      if (v.ok) accepted.push(v.cue);
      else rejected.push({ ref: raw.reference || "?", tc: raw.tc_in || "?", reason: v.reason });
    });
    var acceptedMarkers = [];
    if (Array.isArray(obj.markers)) {
      obj.markers.forEach(function (raw) {
        var vm = vaValidateMarkerCue(raw);
        if (vm.ok) acceptedMarkers.push(vm.marker);
        else rejected.push({ ref: raw.type || "?", tc: raw.tc_in || "?", reason: vm.reason });
      });
    }
    reviewRows = buildReviewRows({ cues: accepted, markers: acceptedMarkers });
    saveReviewRows();
    renderReviewTable();
    log5("Loaded " + accepted.length + " cue(s), " + acceptedMarkers.length + " marker(s) into review. Rejected " + rejected.length + ".", rejected.length ? "warn" : "ok");
    rejected.forEach(function (r) { log5("  rejected " + r.tc + " " + r.ref + ": " + r.reason, "warn"); });
    if (Array.isArray(obj.skipped_notes) && obj.skipped_notes.length) {
      log5("Skipped notes: " + obj.skipped_notes.length, "info");
    }
  }

  document.getElementById("importJsonBtn").addEventListener("click", function () {
    importDetectionJson(document.getElementById("importJson").value);
  });

  document.getElementById("approveAllBtn").addEventListener("click", function () {
    reviewRows.forEach(function (r) { if (!r.deleted) r.approved = true; });
    saveReviewRows(); renderReviewTable();
  });
  document.getElementById("approveNoneBtn").addEventListener("click", function () {
    reviewRows.forEach(function (r) { r.approved = false; });
    saveReviewRows(); renderReviewTable();
  });
  document.getElementById("clearReviewBtn").addEventListener("click", function () {
    reviewRows = [];
    saveReviewRows(); renderReviewTable();
    log5("Review cleared. Previously applied output is left on the timeline until you apply again.", "info");
  });

  document.getElementById("fsMarkerColor").addEventListener("change", function () {
    localStorage.setItem(LS_KEY_FS_COLOR, this.value);
  });

  // Apply-time settings persist between sessions under verseAssist.s5.<id>.
  var S5_IDS = ["defaultMogrtName", "fillDefault", "fillBookends", "meetThresholdFrames", "labelsEnabled", "srLabelIndex", "defLabelIndex", "transitionsEnabled", "transitionName", "srSrFrames", "srDefFrames", "fsEnabled", "fsMogrtName", "fsTrackNumber", "fsTextParamName", "fsReferenceParamName", "fsAnimationParamName"];
  S5_IDS.forEach(function (id) {
    var el = document.getElementById(id);
    var saved = localStorage.getItem("verseAssist.s5." + id);
    if (saved !== null) {
      if (el.type === "checkbox") el.checked = saved === "true";
      else el.value = saved;
    }
    el.addEventListener("change", function () {
      localStorage.setItem("verseAssist.s5." + id, el.type === "checkbox" ? String(el.checked) : el.value);
    });
  });

  document.getElementById("applyApprovedBtn").addEventListener("click", function () {
    var mogrtName = document.getElementById("mogrtName").value;
    var textParamName = document.getElementById("textParamName").value;
    var animationParamName = document.getElementById("animationParamName").value;
    if (!mogrtName) { log5("Set the MOGRT name in Stage 1 first.", "err"); return; }
    if (!textParamName) { log5("Set the text parameter name in Stage 1 first.", "err"); return; }

    var live = reviewRows.filter(function (r) { return !r.deleted; });
    live.forEach(validateReviewRow);
    var blockedRows = live.filter(function (r) { return r.approved && r.error; });
    if (blockedRows.length) {
      log5("Not applied: " + blockedRows.length + " approved row(s) have errors. Fix or unapprove them:", "err");
      blockedRows.forEach(function (r) { log5("  - " + r.kind + " " + r.tc_in + " " + r.reference + ": " + r.error, "err"); });
      renderReviewTable();
      return;
    }

    var approvedRows = live.filter(function (r) { return r.approved; });
    var prev = null;
    try { prev = JSON.parse(localStorage.getItem(LS_KEY_APPLIED) || "null"); } catch (e) { prev = null; }

    var payload = {
      mogrtName: mogrtName,
      videoTrackIndex: getTrackIndex0Based(),
      textParamName: textParamName,
      animationParamName: animationParamName,
      markerColorIndex: parseInt(document.getElementById("fsMarkerColor").value, 10),
      defaultMogrtName: document.getElementById("defaultMogrtName").value.trim(),
      fillDefault: document.getElementById("fillDefault").checked,
      fillBookends: document.getElementById("fillBookends").checked,
      meetThresholdFrames: parseInt(document.getElementById("meetThresholdFrames").value, 10),
      labelsEnabled: document.getElementById("labelsEnabled").checked,
      srLabelIndex: parseInt(document.getElementById("srLabelIndex").value, 10),
      noLabelIndex: -1,
      defLabelIndex: parseInt(document.getElementById("defLabelIndex").value, 10),
      transitionsEnabled: document.getElementById("transitionsEnabled").checked,
      transitionName: document.getElementById("transitionName").value.trim(),
      srSrFrames: parseInt(document.getElementById("srSrFrames").value, 10),
      srDefFrames: parseInt(document.getElementById("srDefFrames").value, 10),
      fsEnabled: document.getElementById("fsEnabled").checked,
      fsMogrtName: document.getElementById("fsMogrtName").value.trim(),
      fsTrackIndex: (function () {
        var n = parseInt(document.getElementById("fsTrackNumber").value, 10);
        if (isNaN(n) || n < 1) n = 1;
        return n - 1;
      })(),
      fsTextParamName: document.getElementById("fsTextParamName").value.trim(),
      fsReferenceParamName: document.getElementById("fsReferenceParamName").value.trim(),
      fsAnimationParamName: document.getElementById("fsAnimationParamName").value.trim(),
      previousClips: prev && prev.placed ? prev.placed : [],
      previousMarkers: prev && prev.markers ? prev.markers : [],
      lt: approvedRows.filter(function (r) { return r.kind === "LT"; }).map(function (r) {
        return { tc_in: r.tc_in, tc_out: r.tc_out, reference: r.reference };
      }),
      fs: approvedRows.filter(function (r) { return r.kind === "FS"; }).map(function (r) {
        return { tc_in: r.tc_in, displayEnd: r.tc_out, reference: r.reference, verseText: r.comment };
      }),
      markers: approvedRows.filter(function (r) { return r.kind === "MARKER"; }).map(function (r) {
        return { type: r.markerType, tc_in: r.tc_in, name: r.reference, triggerQuote: r.comment };
      })
    };

    log5("Applying " + payload.lt.length + " LT, " + payload.fs.length + " FS, " + payload.markers.length + " production marker(s). Removing previous Verse Assist output first...", "info");
    evalHost("vaApplyApproved(" + JSON.stringify(JSON.stringify(payload)) + ")", function (result) {
      var rep;
      try { rep = JSON.parse(result); } catch (e) { log5("Non-JSON response: " + result, "err"); return; }
      if (!rep.success) { log5("FAILED: " + rep.error, "err"); return; }
      log5("Removed previous: " + rep.removedClips + " clip(s), " + rep.removedMarkers + " marker(s).", "info");
      log5("Placed LT: " + rep.placedLt + " (+ " + (rep.placedFsLt || 0) + " fullscreen fallback LT, " + (rep.fsLtSkippedOverlap || 0) + " skipped - already covered by a wider citation). Default pieces: " + (rep.defaultPieces || 0) + " (" + (rep.defaultShort || 0) + " shorter than asked, filled in further pieces). Uncovered after fill: " + (rep.uncovered === undefined ? "n/a" : rep.uncovered) + ". Meets halfway: " + (rep.meetCount || 0) + ". Transitions: " + (rep.transitions || 0) + ". Cuts shifted behind a fullscreen: " + (rep.fsCutsShifted || 0) + ". Fullscreen markers: " + rep.markersFs + ". Fullscreen graphics placed: " + (rep.placedFs || 0) + ". Production markers: " + (rep.markersOther || 0) + ".", rep.errors.length ? "warn" : "ok");
      if (rep.transitionNote) log5("  " + rep.transitionNote, "info");
      if (rep.qeItemCount !== undefined) log5("  QE track item count: " + rep.qeItemCount + " vs. our clip count: " + rep.domClipCount + ". QE items matched by name: " + rep.qeMatchedClips + ".", "info");
      rep.errors.forEach(function (er) { log5("  - " + er, "warn"); });
      localStorage.setItem(LS_KEY_APPLIED, JSON.stringify({ placed: rep.placed, markers: rep.markersPlaced, stamp: Date.now() }));
    });
  });

  // Restore review rows from the last session on load.
  try {
    reviewRows = JSON.parse(localStorage.getItem(LS_KEY_REVIEW_ROWS) || "[]");
  } catch (e) {
    reviewRows = [];
  }
  var savedColor = localStorage.getItem(LS_KEY_FS_COLOR);
  if (savedColor !== null) document.getElementById("fsMarkerColor").value = savedColor;
});
