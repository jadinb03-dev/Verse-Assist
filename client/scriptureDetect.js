// Verse Assist - scriptureDetect.js
// Single-pass scripture detection: one Claude call per time chunk, run
// sequentially with carry-forward context. Output is validated against the
// bundled KJV before anything is accepted.

var VA_DETECT_PROMPT = null;
var VA_DETECT_PROMPT_ERROR = null;
var VA_DETECT_ENDPOINT = "https://api.anthropic.com/v1/messages";
var VA_DETECT_CORE_SECONDS = 540;   // ~9 minute core per chunk
var VA_DETECT_OVERLAP_SECONDS = 60; // guide requires at least 60 s overlap

function vaLoadDetectPrompt(callback) {
  if (VA_DETECT_PROMPT || VA_DETECT_PROMPT_ERROR) { callback(); return; }
  var xhr = new XMLHttpRequest();
  xhr.open("GET", "./prompts/scripture_detection.md", true);
  xhr.onreadystatechange = function () {
    if (xhr.readyState === 4) {
      if (xhr.status === 200 || xhr.status === 0) {
        VA_DETECT_PROMPT = xhr.responseText;
      } else {
        VA_DETECT_PROMPT_ERROR = "Failed to load scripture_detection.md (HTTP " + xhr.status + ")";
      }
      callback();
    }
  };
  xhr.send();
}

function vaBuildUserMessage(chunk, carryIn) {
  var srt = chunk.blocks.map(function (b) {
    return b.index + "\n" + b.tcIn + " --> " + b.tcOut + "\n" + b.text;
  }).join("\n\n");
  return "Carry-in context: " + carryIn + "\n\n" +
    "Process this transcript chunk. Input window: " + vaSecondsToSrt(chunk.winStart) +
    " to " + vaSecondsToSrt(chunk.winEnd) + ". Only emit cues whose tc_in falls in the core window " +
    vaSecondsToSrt(chunk.coreStart) + " to " + vaSecondsToSrt(chunk.coreEnd) +
    " (the last chunk: from " + vaSecondsToSrt(chunk.coreStart) + " to the end). " +
    "Respond with one JSON object only.\n\nTRANSCRIPT CHUNK (SRT):\n" + srt;
}

function vaCallClaude(apiKey, model, system, userMessage, callback) {
  var xhr = new XMLHttpRequest();
  xhr.open("POST", VA_DETECT_ENDPOINT, true);
  xhr.setRequestHeader("content-type", "application/json");
  xhr.setRequestHeader("x-api-key", apiKey);
  xhr.setRequestHeader("anthropic-version", "2023-06-01");
  xhr.setRequestHeader("anthropic-dangerous-direct-browser-access", "true");
  xhr.onreadystatechange = function () {
    if (xhr.readyState !== 4) return;
    if (xhr.status !== 200) {
      callback("HTTP " + xhr.status + ": " + xhr.responseText.slice(0, 300), null);
      return;
    }
    try {
      var body = JSON.parse(xhr.responseText);
      var text = "";
      for (var i = 0; i < body.content.length; i++) {
        if (body.content[i].type === "text") text += body.content[i].text;
      }
      callback(null, text);
    } catch (e) {
      callback("Could not read API response: " + e, null);
    }
  };
  xhr.send(JSON.stringify({
    model: model,
    max_tokens: 16000,
    system: system,
    messages: [{ role: "user", content: userMessage }]
  }));
}

// Extracts and parses the single JSON object. Throws if it isn't valid JSON.
function vaExtractJson(text) {
  var start = text.indexOf("{");
  var end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("No JSON object in response");
  return JSON.parse(text.slice(start, end + 1));
}

// Resolves a parsed reference against the KJV. Returns null if all verses
// exist, or a string describing the first problem.
function vaCheckRefExists(ref) {
  if (!vaChapterExists(ref.book, ref.chapter)) return "chapter does not exist";
  if (ref.isChapterRange) {
    if (!vaChapterExists(ref.book, ref.chapterEnd)) return "chapter range end does not exist";
    return null;
  }
  if (ref.wholeChapter) return null;
  var s = Number(ref.verseStart), e = Number(ref.verseEnd);
  for (var v = s; v <= e; v++) {
    if (vaLookupVerse(ref.book, ref.chapter, v) === null) return "verse " + ref.chapter + ":" + v + " does not exist";
  }
  return null;
}

// Validates one raw cue from the model. Returns {ok, cue, reason}.
function vaValidateCue(raw) {
  var reasons = [];
  if (raw.display !== "LT" && raw.display !== "FS") reasons.push("display must be LT or FS");
  if (!/^\d{2}:\d{2}:\d{2},\d{3}$/.test(raw.tc_in || "")) reasons.push("bad tc_in");
  if (!/^\d{2}:\d{2}:\d{2},\d{3}$/.test(raw.tc_out || "")) reasons.push("bad tc_out");
  var startSec = vaSrtTimeToSeconds(raw.tc_in || "");
  var endSec = vaSrtTimeToSeconds(raw.tc_out || "");
  if (startSec !== null && endSec !== null && endSec <= startSec) reasons.push("tc_out not after tc_in");
  if (typeof raw.reference !== "string" || !raw.reference.trim()) reasons.push("missing reference");
  if (raw.flag !== undefined && raw.flag !== null && raw.flag !== "verify" && raw.flag !== "unsure") reasons.push("bad flag");

  var parsed = null;
  if (reasons.length === 0) {
    parsed = vaParseReference(raw.reference);
    if (!parsed.refs || parsed.refs.length === 0) {
      reasons.push("reference did not parse: " + raw.reference);
    } else {
      for (var i = 0; i < parsed.refs.length; i++) {
        var problem = vaCheckRefExists(parsed.refs[i]);
        if (problem) { reasons.push(raw.reference + ": " + problem); break; }
      }
    }
  }
  if (reasons.length === 0 && raw.display === "FS") {
    if (parsed.refs.length !== 1) reasons.push("FS must be exactly one verse");
    else {
      var r = parsed.refs[0];
      if (r.wholeChapter || r.isChapterRange || r.verseStart !== r.verseEnd) reasons.push("FS must be a single verse");
    }
  }
  if (reasons.length) return { ok: false, cue: null, reason: reasons.join("; ") };

  var cue = {
    display: raw.display,
    tc_in: raw.tc_in,
    tc_out: raw.tc_out,
    startSec: startSec,
    spokenEndSec: endSec,
    reference: raw.reference.trim(),
    canonicalRef: parsed.refs[0],
    mention_type: String(raw.mention_type || "unspecified"),
    flag: raw.flag || null,
    boundaries_estimated: !!raw.boundaries_estimated,
    trigger_quote: String(raw.trigger_quote || ""),
    note: String(raw.note || "")
  };

  if (cue.display === "FS") {
    var verseText = vaLookupVerse(cue.canonicalRef.book, cue.canonicalRef.chapter, cue.canonicalRef.verseStart) || "";
    var words = verseText.split(/\s+/).filter(function (w) { return w.length > 0; }).length;
    var hold = Math.max(3, 0.4 * words);
    cue.verseText = verseText;
    cue.wordCount = words;
    cue.holdSeconds = hold;
    cue.displayEndSec = Math.max(cue.spokenEndSec, cue.startSec + hold);
  }
  return { ok: true, cue: cue, reason: null };
}

// Ownership filter: a chunk keeps cues whose tc_in falls in its core window.
function vaOwnedByChunk(cue, chunk, isLast) {
  if (cue.startSec < chunk.coreStart) return false;
  if (!isLast && cue.startSec >= chunk.coreEnd) return false;
  return true;
}

// Near-duplicate filter across the merged list.
function vaIsDuplicate(cue, accepted) {
  for (var i = 0; i < accepted.length; i++) {
    var a = accepted[i];
    if (a.display === cue.display && a.reference === cue.reference && Math.abs(a.startSec - cue.startSec) < 3) {
      return true;
    }
  }
  return false;
}

// Non-scripture production markers (Website/Helpline/BRoll/Definition/Product) - a
// separate, much simpler track from scripture cues. No KJV lookup, no display/reference.
var VA_MARKER_TYPES = ["Website", "Helpline", "BRoll", "Definition", "Product"];

function vaValidateMarkerCue(raw) {
  var reasons = [];
  if (VA_MARKER_TYPES.indexOf(raw.type) === -1) { reasons.push("type must be one of " + VA_MARKER_TYPES.join(", ")); }
  if (!/^\d{2}:\d{2}:\d{2},\d{3}$/.test(raw.tc_in || "")) { reasons.push("bad tc_in"); }
  if (reasons.length) { return { ok: false, marker: null, reason: reasons.join("; ") }; }
  var startSec = vaSrtTimeToSeconds(raw.tc_in);
  return {
    ok: true,
    marker: {
      type: raw.type,
      tc_in: raw.tc_in,
      startSec: startSec,
      name: String(raw.name || "").trim(),
      trigger_quote: String(raw.trigger_quote || "")
    },
    reason: null
  };
}

function vaIsDuplicateMarker(marker, accepted) {
  for (var i = 0; i < accepted.length; i++) {
    var a = accepted[i];
    if (a.type === marker.type && a.name === marker.name && Math.abs(a.startSec - marker.startSec) < 3) {
      return true;
    }
  }
  return false;
}

// Interpolates the per-episode product teaching name into the shared prompt, so the
// model knows what "this teaching"/"this series" refers to for the Product marker type.
function vaBuildDetectSystemPrompt(productTeachingName) {
  var name = (productTeachingName || "").trim();
  var note = name
    ? "Current product teaching name for this episode: \"" + name + "\"."
    : "Current product teaching name for this episode: (none set - do not assume any specific series name).";
  return VA_DETECT_PROMPT + "\n\n---\n\n" + note;
}

function vaCarryInFrom(accepted) {
  if (accepted.length === 0) return "none (start of transcript)";
  var last = accepted[accepted.length - 1];
  return "current passage at end of previous chunk is " + last.reference + " (last cue at " + last.tc_in + ")";
}

// Runs every chunk sequentially. onEvent(msg, cls) reports progress.
// onDone({cues, skipped, rejected, failedChunks}) fires at the end.
function vaRunScriptureDetection(opts, onEvent, onDone) {
  var chunks = vaChunkBlocks(opts.blocks, VA_DETECT_CORE_SECONDS, VA_DETECT_OVERLAP_SECONDS);
  var result = { cues: [], markers: [], skipped: [], rejected: [], failedChunks: [], chunkCount: chunks.length };
  var systemPrompt = vaBuildDetectSystemPrompt(opts.productTeachingName);
  var idx = 0;

  function next() {
    if (idx >= chunks.length) { onDone(result); return; }
    var chunk = chunks[idx];
    var isLast = idx === chunks.length - 1;
    var label = "Chunk " + chunk.number + "/" + chunks.length + " (" + vaSecondsToSrt(chunk.coreStart) + " - " + vaSecondsToSrt(chunk.coreEnd) + ")";
    onEvent("Sending " + label + "...", "info");
    var userMsg = vaBuildUserMessage(chunk, vaCarryInFrom(result.cues));

    var attempts = 0;
    function attempt() {
      attempts++;
      vaCallClaude(opts.apiKey, opts.model, systemPrompt, userMsg, function (err, text) {
        if (err) return fail(err);
        var obj;
        try { obj = vaExtractJson(text); } catch (e) { return fail("invalid JSON: " + e.message); }
        if (!obj || !Array.isArray(obj.cues)) return fail("JSON has no cues array");

        var accepted = 0;
        obj.cues.forEach(function (raw) {
          var v = vaValidateCue(raw);
          if (!v.ok) {
            result.rejected.push({ chunk: chunk.number, tc: raw.tc_in || "?", reference: raw.reference || "?", reason: v.reason });
            return;
          }
          if (!vaOwnedByChunk(v.cue, chunk, isLast)) return; // owned by a neighbouring chunk
          if (vaIsDuplicate(v.cue, result.cues)) return;
          result.cues.push(v.cue);
          accepted++;
        });
        var acceptedMarkers = 0;
        if (Array.isArray(obj.markers)) {
          obj.markers.forEach(function (raw) {
            var vm = vaValidateMarkerCue(raw);
            if (!vm.ok) {
              result.rejected.push({ chunk: chunk.number, tc: raw.tc_in || "?", reference: raw.type || "?", reason: vm.reason });
              return;
            }
            if (!vaOwnedByChunk(vm.marker, chunk, isLast)) return;
            if (vaIsDuplicateMarker(vm.marker, result.markers)) return;
            result.markers.push(vm.marker);
            acceptedMarkers++;
          });
        }
        if (Array.isArray(obj.skipped_notes)) {
          obj.skipped_notes.forEach(function (n) { result.skipped.push({ chunk: chunk.number, tc: n.tc, quote: n.quote, reason: n.reason }); });
        }
        result.cues.sort(function (a, b) { return a.startSec - b.startSec; });
        result.markers.sort(function (a, b) { return a.startSec - b.startSec; });
        onEvent(label + " done: " + accepted + " cue(s), " + acceptedMarkers + " marker(s) accepted.", "ok");
        idx++;
        next();
      });
    }
    function fail(reason) {
      if (attempts < 2) {
        onEvent(label + " failed (" + reason + "), retrying once...", "warn");
        attempt();
        return;
      }
      result.failedChunks.push({ chunk: chunk.number, window: vaSecondsToSrt(chunk.winStart) + " - " + vaSecondsToSrt(chunk.winEnd), error: reason });
      onEvent(label + " FAILED after retry: " + reason + ". Continuing; this window is NOT covered.", "err");
      idx++;
      next();
    }
    attempt();
  }
  next();
}
