// Verse Assist - host.jsx
// ExtendScript side. Every function returns a JSON string (the CEP bridge
// only passes strings back to the panel), shaped as either
// {success:true, ...} or {success:false, error:"..."}.

function vaGetAppInfo() {
    try {
        return JSON.stringify({
            success: true,
            appName: app.appName ? app.appName : "Premiere Pro",
            version: app.version
        });
    } catch (e) {
        return JSON.stringify({ success: false, error: String(e) });
    }
}

// ---- Stage 5: apply approved review rows ----

// Sets a text param on a MOGRT clip (same JSON-textEditValue logic as Stage 3).
function vaSetMgtText(clip, paramName, text) {
    var mgt = clip.getMGTComponent();
    if (!mgt) { return { ok: false, error: "getMGTComponent() returned null" }; }
    var found = null;
    for (var pp = 0; pp < mgt.properties.numItems; pp++) {
        if (mgt.properties[pp].displayName === paramName) { found = mgt.properties[pp]; break; }
    }
    if (!found) { return { ok: false, error: "parameter \"" + paramName + "\" not found" }; }
    var raw = vaSafeGetValue(found);
    var parsed = null;
    try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
    var newVal;
    if (parsed && typeof parsed === "object" && ("textEditValue" in parsed)) {
        parsed.textEditValue = text;
        parsed.fontTextRunLength = [text.length];
        newVal = JSON.stringify(parsed);
    } else {
        newVal = text;
    }
    var ok = found.setValue(newVal, true);
    return { ok: !!ok, error: ok ? null : "setValue() returned false" };
}

// Sets the colour label on a MOGRT project item. Clips placed from that item
// after this carry the colour. Label indices (0 Violet ... 13 Green ... 15 Yellow)
// come from a community list; verify on the first run.
function vaSetProjectLabel(projectItem, labelIndex, what, report) {
    try {
        if (labelIndex === undefined || labelIndex === null) { return; }
        projectItem.setColorLabel(labelIndex);
    } catch (e) {
        report.errors.push("Could not colour the " + what + " label " + labelIndex + ": " + String(e));
    }
}

// A Cross Dissolve centred on a cut plays half its length BEFORE the cut and half
// after. If a cut's transition window straddles a fullscreen graphic's start time,
// the first half plays with nothing covering it yet - a visible flash of the LT
// dissolve before the fullscreen appears. Since the fullscreen (once up) is a fully
// opaque layer above the LT track, the fix isn't to move the fullscreen; it's to push
// the cut itself later so the whole dissolve plays only once the fullscreen is
// already covering it. Both bordering clips' shared boundary moves to the same new
// frame-exact tick, same as a fresh placement, so no sub-frame sliver gets left behind.
// Moves a shared boundary between two touching clips to a new frame-exact tick,
// extending/shrinking both sides' outPoint/inPoint in lockstep - the same mechanics
// as a fresh placement, just applied to two clips that are already sitting there.
function vaMoveSharedBoundary(A, B, newCutT) {
    var aInTicks = Number(A.inPoint.ticks);
    var aStartTicks = Number(A.start.ticks);
    A.end = newCutT;
    var aOutT = new Time();
    aOutT.ticks = (aInTicks + (Number(newCutT.ticks) - aStartTicks)).toFixed(0);
    A.outPoint = aOutT;

    var bInTicks = Number(B.inPoint.ticks);
    var bOldStartTicks = Number(B.start.ticks);
    var shiftTicks = Number(newCutT.ticks) - bOldStartTicks;
    B.start = newCutT;
    var bInT = new Time();
    bInT.ticks = (bInTicks + shiftTicks).toFixed(0);
    B.inPoint = bInT;
}

function vaShiftCutsBehindFullscreens(seq, trackIndex, srSrFrames, srDefFrames, srName, defName, fsWindows, frameSec, frameTicks, report) {
    if (!fsWindows.length) { return; }
    var track = seq.videoTracks[trackIndex];
    var mine = [];
    var c;
    for (c = 0; c < track.clips.numItems; c++) {
        var tc = track.clips[c];
        if (tc.name === srName || tc.name === defName) { mine.push(tc); }
    }
    mine.sort(function (a, b) { return a.start.seconds - b.start.seconds; });

    var tol = frameSec / 2;
    report.fsCutsShifted = 0;
    for (var k = 0; k + 1 < mine.length; k++) {
        var A = mine[k];
        var B = mine[k + 1];
        if (Math.abs(B.start.seconds - A.end.seconds) >= tol) { continue; }
        var bothSr = (A.name === srName && B.name === srName);
        var frames = bothSr ? srSrFrames : srDefFrames;
        var halfDur = (frames * frameSec) / 2;
        var cutTime = A.end.seconds;

        for (var f = 0; f < fsWindows.length; f++) {
            var w = fsWindows[f];
            // Entrance: the fullscreen's start falls inside this cut's dissolve window -
            // part of the dissolve would play before the fullscreen is up to hide it.
            // Push the cut later so the whole dissolve plays after the fullscreen appears.
            if (cutTime - halfDur < w.fIn && cutTime + halfDur > w.fIn) {
                var newCutIn = w.fIn + halfDur;
                if (newCutIn >= B.end.seconds - frameSec) {
                    report.errors.push("Fullscreen " + w.reference + ": not enough room to push the entrance cut behind it before the next cut - dissolve may still show.");
                    break;
                }
                if (newCutIn > w.fOut - halfDur) {
                    report.errors.push("Fullscreen " + w.reference + ": its window is shorter than the transition length - the dissolve may run past where the fullscreen ends.");
                }
                try {
                    vaMoveSharedBoundary(A, B, vaFrameExactTime(newCutIn, frameTicks));
                    report.fsCutsShifted++;
                } catch (eShiftIn) {
                    report.errors.push("Could not shift cut behind fullscreen " + w.reference + ": " + String(eShiftIn));
                }
                break;
            }
            // Exit: the fullscreen's end falls inside this cut's dissolve window - the
            // dissolve would still be running after the fullscreen disappears, exposing
            // its tail end. Pull the cut earlier so the whole dissolve finishes while
            // the fullscreen is still covering it.
            if (cutTime - halfDur < w.fOut && cutTime + halfDur > w.fOut) {
                var newCutOut = w.fOut - halfDur;
                if (newCutOut <= A.start.seconds + frameSec) {
                    report.errors.push("Fullscreen " + w.reference + ": not enough room to pull the exit cut earlier - dissolve may still show after it ends.");
                    break;
                }
                try {
                    vaMoveSharedBoundary(A, B, vaFrameExactTime(newCutOut, frameTicks));
                    report.fsCutsShifted++;
                } catch (eShiftOut) {
                    report.errors.push("Could not shift cut before the end of fullscreen " + w.reference + ": " + String(eShiftOut));
                }
                break;
            }
        }
    }
}

// Adds a transition centred on every cut between two adjacent clips on the
// track that were placed by Verse Assist. Scripture-to-scripture cuts use
// srSrFrames, cuts touching the default MOGRT use srDefFrames.
// Transitions are added through the QE DOM, which Adobe does not document
// for scripting. Failures are reported per cut instead of stopping the run.
function vaAddTransitions(seq, trackIndex, transitionName, srSrFrames, srDefFrames, srName, defName, frameSec, report) {
    var track = seq.videoTracks[trackIndex];
    var c;
    var mine = [];
    for (c = 0; c < track.clips.numItems; c++) {
        var tc = track.clips[c];
        if (tc.name === srName || tc.name === defName) { mine.push({ index: c, clip: tc }); }
    }
    mine.sort(function (a, b) { return a.clip.start.seconds - b.clip.start.seconds; });

    // Which consecutive pairs (by position within "mine") are a real touching cut.
    var pairs = [];
    for (var k = 0; k + 1 < mine.length; k++) {
        var A = mine[k].clip;
        var B = mine[k + 1].clip;
        if (Math.abs(B.start.seconds - A.end.seconds) < frameSec / 2) {
            var bothSr = (A.name === srName && B.name === srName);
            pairs.push({ mineIdx: k, frames: bothSr ? srSrFrames : srDefFrames, label: A.name + " -> " + B.name });
        }
    }
    if (pairs.length === 0) { report.transitionNote = "No adjacent clips to transition between."; return; }

    try { app.enableQE(); } catch (eQ) { report.errors.push("Transitions: enableQE() failed: " + eQ); return; }
    var qeSeq;
    var trans;
    var qeTrack;
    try {
        qeSeq = qe.project.getActiveSequence();
        trans = qe.project.getVideoTransitionByName(transitionName);
        qeTrack = qeSeq.getVideoTrackAt(trackIndex);
    } catch (eQ2) {
        report.errors.push("Transitions: QE lookup failed: " + eQ2);
        return;
    }
    if (!trans) { report.errors.push("Transitions: QE could not find a transition named \"" + transitionName + "\"."); return; }

    report.qeItemCount = qeTrack.numItems;
    report.domClipCount = mine.length;

    // The QE item list interleaves our clips with placeholder slots, and a dump showed
    // the placeholders don't appear at a fixed stride - there's one between some cuts
    // and none between others. So instead of computing an index, the whole QE list is
    // walked once in order and every item whose name matches one of our clips is kept,
    // in the order encountered. Because neither list reorders clips, the Nth such item
    // found is the same clip as mine[N] - matched by position in a single pass, not by
    // any arithmetic on the index.
    var qeClipIndices = [];
    for (var qi = 0; qi < qeTrack.numItems; qi++) {
        try {
            var qit = qeTrack.getItemAt(qi);
            if (qit.name === srName || qit.name === defName) { qeClipIndices.push(qi); }
        } catch (eWalk) { /* unreadable slot; skip it */ }
    }
    report.qeMatchedClips = qeClipIndices.length;
    if (qeClipIndices.length !== mine.length) {
        report.errors.push("Transitions: found " + qeClipIndices.length + " named QE item(s) but " + mine.length + " of our clips on the track - the two lists may not line up. Proceeding with the shorter count.");
    }

    report.transitions = 0;
    for (var p2 = 0; p2 < pairs.length; p2++) {
        var pr = pairs[p2];
        if (pr.mineIdx >= qeClipIndices.length) {
            report.errors.push("Transition " + pr.label + ": no matching QE item found for this cut.");
            continue;
        }
        try {
            var qeItem = qeTrack.getItemAt(qeClipIndices[pr.mineIdx]);
            qeItem.addTransition(trans, false, "0:" + pr.frames, "0:00", 0.5, false, true);
            report.transitions++;
        } catch (eT) {
            report.errors.push("Transition " + pr.label + " (" + pr.frames + " frames) at qe[" + qeClipIndices[pr.mineIdx] + "]: " + String(eT));
        }
    }
}

// Builds a Time snapped to the nearest exact frame boundary, set via .ticks (an exact
// integer string) rather than .seconds. Time.seconds takes whatever sub-frame tick value
// it's given with no frame-snapping, while overwriteClip's plain-number position argument
// snaps internally - two different Premiere code paths rounding the same input two
// different ways, which is what was leaving a sub-frame sliver at almost every cut. Doing
// the snap ourselves, once, in exact integer tick arithmetic, and writing ticks instead of
// seconds, makes every boundary bit-exact regardless of which API places it.
function vaFrameExactTime(seconds, frameTicks) {
    var TICKS_PER_SECOND = 254016000000;
    var frameIndex = Math.round((seconds * TICKS_PER_SECOND) / frameTicks);
    var snappedTicks = frameIndex * frameTicks;
    var t = new Time();
    try {
        t.ticks = snappedTicks.toFixed(0);
    } catch (eTicks) {
        t.seconds = snappedTicks / TICKS_PER_SECOND;
    }
    return t;
}

// Compares where a clip was asked to go with where it actually landed.
// Returns a description when they differ by more than tol, otherwise null.
function vaPlacementMismatch(askedS, askedE, clip, tol) {
    var gotS = clip.start.seconds;
    var gotE = clip.end.seconds;
    if (Math.abs(gotS - askedS) <= tol && Math.abs(gotE - askedE) <= tol) { return null; }
    return "asked " + askedS.toFixed(3) + "s-" + askedE.toFixed(3) + "s, got " + gotS.toFixed(3) + "s-" + gotE.toFixed(3) + "s";
}

// Returns the stretches of [spanS, spanE] that no clip on the track covers, as
// [[start, end], ...] in seconds. Stretches shorter than tol are ignored.
function vaUncoveredGaps(track, spanS, spanE, tol) {
    var ivs = [];
    for (var c = 0; c < track.clips.numItems; c++) {
        var cl = track.clips[c];
        var s = cl.start.seconds;
        var e = cl.end.seconds;
        if (e > spanS && s < spanE) {
            ivs.push([Math.max(s, spanS), Math.min(e, spanE)]);
        }
    }
    ivs.sort(function (a, b) { return a[0] - b[0]; });
    var gaps = [];
    var cur = spanS;
    for (var k = 0; k < ivs.length; k++) {
        if (ivs[k][0] > cur + tol) { gaps.push([cur, ivs[k][0]]); }
        if (ivs[k][1] > cur) { cur = ivs[k][1]; }
    }
    if (spanE > cur + tol) { gaps.push([cur, spanE]); }
    return gaps;
}

// payload = {
//   mogrtName, videoTrackIndex, textParamName, animationParamName, markerColorIndex,
//   meetThresholdFrames, fillDefault, defaultMogrtName,
//   transitionsEnabled, transitionName, srSrFrames, srDefFrames,
//   fsEnabled, fsMogrtName, fsTrackIndex, fsTextParamName, fsAnimationParamName,
//   fillBookends,   // extends the default fill to before the first/after the last ref
//   previousMarkers: [{startSec, reference}],   // markers placed by the last apply
//   lt: [{tc_in, tc_out, reference}],
//   fs: [{tc_in, displayEnd, reference, verseText}],
//   markers: [{type, tc_in, name, triggerQuote}]   // non-scripture production markers
// }
// Removes the previous Verse Assist output first (clips and "VA |" markers),
// then places the approved LT rows and creates the approved fullscreen markers.
function vaApplyApproved(payloadJson) {
    try {
        var p = JSON.parse(payloadJson);
        var seq = app.project.activeSequence;
        if (!seq) { return JSON.stringify({ success: false, error: "No active sequence." }); }
        var timing = vaGetSequenceTiming(seq);
        var report = { success: true, removedClips: 0, removedMarkers: 0, placedLt: 0, markersFs: 0, errors: [], placed: [] };
        var i, c, t;

        // 1. Previous LT placements from the last apply. Swept by name on the LT track,
        // not by recorded position: the meet-halfway snap and the walk cursor can place a
        // clip a hair off where it landed last time, so position-matching missed it and
        // left a sub-frame sliver behind -- too thin to trip the overlap conflict check
        // below, but a real track item, which is why some cuts looked like one edit but
        // needed two presses of the down-arrow key to step past.
        var vaSweepTrack = function (trackIndex, names) {
            if (trackIndex < 0 || trackIndex >= seq.videoTracks.numTracks) { return; }
            var prevTrack = seq.videoTracks[trackIndex];
            var targets = [];
            for (c = 0; c < prevTrack.clips.numItems; c++) {
                var it = prevTrack.clips[c];
                if (names.indexOf(it.name) !== -1) { targets.push(it); }
            }
            for (t = 0; t < targets.length; t++) {
                try { targets[t].remove(false, false); report.removedClips++; }
                catch (eR) { report.errors.push("Could not remove previous clip " + targets[t].name + " at " + targets[t].start.seconds + "s: " + eR); }
            }
        };
        vaSweepTrack(p.videoTrackIndex, [p.mogrtName, p.defaultMogrtName]);
        if (p.fsEnabled && p.fsMogrtName) { vaSweepTrack(p.fsTrackIndex, [p.fsMogrtName]); }

        // 2. Previous fullscreen markers from the last apply. Markers are now named with
        // just the reference (no "VA |" tag to sweep by), so instead the exact position
        // and reference of every marker the last apply created is recorded client-side
        // and matched back here - both have to match, so a coincidental manual marker at
        // a similar time with a different name is left alone.
        var markers = seq.markers;
        var markerTol = (1 / timing.actualFrameRate) / 2;
        var prevMarkers = p.previousMarkers || [];
        var oldMarkers = [];
        var m = markers.getFirstMarker();
        while (m) {
            // Any "VA |"-tagged marker is swept by that tag alone: it catches markers
            // from before the fullscreen naming change (which have no recorded-position
            // entry to match against), and it's also the live removal path for the
            // production markers placed below, which keep the "VA |" tag on purpose.
            if (m.name && m.name.indexOf("VA |") === 0) {
                oldMarkers.push(m);
            } else {
                for (var pm = 0; pm < prevMarkers.length; pm++) {
                    if (m.name === prevMarkers[pm].reference && Math.abs(m.start.seconds - prevMarkers[pm].startSec) < markerTol) {
                        oldMarkers.push(m);
                        break;
                    }
                }
            }
            m = markers.getNextMarker(m);
        }
        for (t = 0; t < oldMarkers.length; t++) {
            try { markers.deleteMarker(oldMarkers[t]); report.removedMarkers++; }
            catch (eD) { report.errors.push("Could not delete previous marker \"" + oldMarkers[t].name + "\": " + eD); }
        }

        // 3. Approved LT rows, meet-halfway rule, and default-MOGRT fill.
        var frameSec = 1 / timing.actualFrameRate;
        var frameTicks = Number(timing.timebase);
        var meetFrames = (p.meetThresholdFrames !== undefined && p.meetThresholdFrames !== null) ? p.meetThresholdFrames : 28;

        // Computed early (not just in the fullscreen loop below) so the cut-shifting
        // pass can use these windows before fullscreen markers/graphics are placed.
        // One entry per p.fs row, in the same order - a failed one is kept as null so
        // the fullscreen loop below can still index into this array by position.
        var fsWindows = [];
        var fsAllWindows = [];
        var fsRows = p.fs || [];
        for (i = 0; i < fsRows.length; i++) {
            try {
                var fwIn = vaTimecodeToSeconds(fsRows[i].tc_in, timing.nominalFps, timing.isDropFrame, timing.actualFrameRate);
                var fwOut = vaTimecodeToSeconds(fsRows[i].displayEnd, timing.nominalFps, timing.isDropFrame, timing.actualFrameRate);
                var fw = { fIn: fwIn, fOut: fwOut, reference: fsRows[i].reference };
                fsWindows.push(fw);
                fsAllWindows.push(fw);
            } catch (eFw) {
                fsAllWindows.push(null); // reported again, in detail, in the fullscreen loop below
            }
        }
        var items = [];
        var lt = p.lt || [];
        for (i = 0; i < lt.length; i++) {
            try {
                var iS = vaTimecodeToSeconds(lt[i].tc_in, timing.nominalFps, timing.isDropFrame, timing.actualFrameRate);
                var oS = vaTimecodeToSeconds(lt[i].tc_out, timing.nominalFps, timing.isDropFrame, timing.actualFrameRate);
                if (oS <= iS) { throw new Error("tc_out is not after tc_in"); }
                items.push({ kind: "LT", row: lt[i], inS: iS, outS: oS, label: "LT " + lt[i].tc_in + " " + lt[i].reference, textValue: lt[i].reference });
            } catch (eP) {
                report.errors.push("LT " + lt[i].tc_in + " " + lt[i].reference + ": " + String(eP));
            }
        }

        // Every fullscreen cue also gets a normal LT placement with the reference (same
        // MOGRT, same track, same green label) alongside its marker/graphic. That way if
        // the fullscreen graphic is ever turned off, there's still an LT on screen
        // instead of nothing - the fullscreen is an optional upgrade, not a replacement.
        for (i = 0; i < fsRows.length; i++) {
            var fsForLt = fsAllWindows[i];
            if (!fsForLt) { continue; } // parse failure, already reported in the fullscreen loop below
            items.push({ kind: "LT", row: fsRows[i], inS: fsForLt.fIn, outS: fsForLt.fOut, label: "FS-LT " + fsRows[i].tc_in + " " + fsRows[i].reference, textValue: fsRows[i].reference, fsOrigin: true });
        }
        items.sort(function (a, b) { return a.inS - b.inS; });

        // A fullscreen nested inside a wider citation's span should temporarily show its
        // own narrower reference, then resume the wider one afterward - so instead of
        // dropping the fullscreen's LT fallback, the wider citation is split around it
        // (and around every other fullscreen nested in the same span, in order), leaving
        // a gap exactly where each fullscreen sits. Pieces with nothing left in them
        // (the fullscreen starts right at the citation's own edge) are simply omitted.
        var overlapTol = frameSec / 2;
        var realItems = [];
        var fsItemsList = [];
        for (i = 0; i < items.length; i++) {
            if (items[i].fsOrigin) { fsItemsList.push(items[i]); } else { realItems.push(items[i]); }
        }

        // Fullscreens read in quick succession (e.g. several Beatitudes back to back) can
        // have hold-time padding that runs into the next one's start. A fullscreen's own
        // start is the actual moment that verse begins and stays fixed; its end is just
        // padding for readability, so when two overlap, the earlier one is simply trimmed
        // to end where the next one starts rather than either one being dropped.
        fsItemsList.sort(function (a, b) { return a.inS - b.inS; });
        for (i = 0; i + 1 < fsItemsList.length; i++) {
            if (fsItemsList[i].outS > fsItemsList[i + 1].inS + overlapTol) {
                fsItemsList[i].outS = fsItemsList[i + 1].inS;
            }
        }
        // A genuine data anomaly - two fullscreens starting at (or before) the same
        // instant - can't be resolved by trimming; the earlier one is dropped instead.
        var fsCleaned = [];
        for (i = 0; i < fsItemsList.length; i++) {
            if (fsItemsList[i].outS - fsItemsList[i].inS > overlapTol) {
                fsCleaned.push(fsItemsList[i]);
            } else {
                report.fsLtSkippedOverlap = (report.fsLtSkippedOverlap || 0) + 1;
            }
        }
        fsItemsList = fsCleaned;

        var finalItems = [];
        for (i = 0; i < realItems.length; i++) {
            var W = realItems[i];
            var nested = [];
            for (var fi = 0; fi < fsItemsList.length; fi++) {
                var Fn = fsItemsList[fi];
                if (Fn.inS < W.outS - overlapTol && W.inS < Fn.outS - overlapTol) { nested.push(Fn); }
            }
            if (nested.length === 0) { finalItems.push(W); continue; }
            nested.sort(function (a, b) { return a.inS - b.inS; });
            var cursor = W.inS;
            for (var ni = 0; ni < nested.length; ni++) {
                var fStart = Math.max(nested[ni].inS, W.inS);
                var fEnd = Math.min(nested[ni].outS, W.outS);
                if (fStart - cursor > overlapTol) {
                    finalItems.push({ kind: W.kind, row: W.row, inS: cursor, outS: fStart, label: W.label, textValue: W.textValue });
                }
                cursor = fEnd;
            }
            if (W.outS - cursor > overlapTol) {
                finalItems.push({ kind: W.kind, row: W.row, inS: cursor, outS: W.outS, label: W.label, textValue: W.textValue });
            }
        }

        // Fullscreen-vs-fullscreen overlap was already resolved by trimming above, so
        // every remaining fullscreen item (whether or not it fell inside a real citation)
        // just gets placed as-is.
        for (var fj = 0; fj < fsItemsList.length; fj++) {
            finalItems.push(fsItemsList[fj]);
        }

        finalItems.sort(function (a, b) { return a.inS - b.inS; });
        items = finalItems;

        // Gaps under the threshold: the two neighbours meet at the midpoint (snapped to a frame).
        for (i = 0; i + 1 < items.length; i++) {
            var gap = items[i + 1].inS - items[i].outS;
            if (gap > 0 && gap < meetFrames * frameSec) {
                var mid = Math.round(((items[i].outS + items[i + 1].inS) / 2) / frameSec) * frameSec;
                items[i].outS = mid;
                items[i + 1].inS = mid;
                report.meetCount = (report.meetCount || 0) + 1;
            }
        }

        var ltTrack = seq.videoTracks[p.videoTrackIndex];
        var srProject = items.length ? vaFindProjectItemByName(app.project.rootItem, p.mogrtName) : null;
        var defProject = (p.fillDefault && p.defaultMogrtName) ? vaFindProjectItemByName(app.project.rootItem, p.defaultMogrtName) : null;
        var tol = frameSec / 2;

        // Colour labels live on the project item, so set them before placing.
        if (p.labelsEnabled) {
            if (srProject) { vaSetProjectLabel(srProject, p.srLabelIndex, "scripture MOGRT", report); }
            // When the default is its own project item (a separate copy), label that copy
            // "no label" once, so it doesn't inherit the scripture colour.
            if (defProject && p.defaultMogrtName !== p.mogrtName) {
                vaSetProjectLabel(defProject, p.noLabelIndex, "default MOGRT", report);
            }
        }

        // Any existing clip overlapping the target range is a conflict and is logged,
        // including leftover clips that share a MOGRT name. Previous Verse Assist output
        // is removed before this runs, so only unrecorded clips can conflict.
        var isVaName = function (n) { return n === p.mogrtName || n === p.defaultMogrtName; };

        // Places one item on the given track. Throws with a reason if it can't be placed.
        // textParamName/animationParamName are passed in rather than closed over, since the
        // fullscreen graphic is a different MOGRT template with its own parameter names.
        var placeTimelineItem = function (it, useItem, useName, track, textParamName, animationParamName) {
            if (!useItem) { throw new Error("MOGRT \"" + useName + "\" not found in the Project panel"); }
            for (c = 0; c < track.clips.numItems; c++) {
                var ex = track.clips[c];
                if (it.inS < ex.end.seconds - tol && ex.start.seconds < it.outS - tol) {
                    throw new Error("conflicts with existing clip \"" + ex.name + "\"");
                }
            }
            // Both ends of this placement are snapped to an exact frame tick ourselves
            // (see vaFrameExactTime) rather than handed to Premiere as plain seconds:
            // overwriteClip's numeric position argument and Time.end's .seconds setter
            // round sub-frame values two different ways, which is what was leaving a
            // sub-frame sliver at almost every cut between two touching clips.
            var startT = vaFrameExactTime(it.inS, frameTicks);
            if (!track.overwriteClip(useItem, startT)) { throw new Error("overwriteClip() returned false"); }
            var placed = vaFindNearestTrackItemByStart(track, it.inS);
            if (!placed) { throw new Error("placed but could not find it back"); }
            var endT = vaFrameExactTime(it.outS, frameTicks);
            placed.end = endT;
            // A manual drag-trim moves the source-relative outPoint in lockstep with the
            // sequence-relative end. Mirror that with the same exact-tick arithmetic so
            // outPoint and end agree bit-for-bit, not just to the nearest millisecond.
            var durationTicks = Number(endT.ticks) - Number(startT.ticks);
            var outT = new Time();
            outT.ticks = (Number(placed.inPoint.ticks) + durationTicks).toFixed(0);
            placed.outPoint = outT;
            if (it.textValue !== undefined && it.textValue !== null && textParamName) {
                var txt = vaSetMgtText(placed, textParamName, it.textValue);
                if (!txt.ok) { throw new Error("text not set: " + txt.error); }
            }
            if (animationParamName) { vaSetBooleanParam(placed, animationParamName, false); }
            return placed;
        };

        // 1. One walk through the span in time order. The walk position is where the
        // timeline is known to be filled up to. For each cue: the default fills from the
        // walk position up to the cue, then the cue is placed. Each piece is read back, and
        // the walk continues from where Premiere actually left off. Every placement goes
        // into space the walk has just confirmed as empty.
        report.defaultPieces = 0;
        report.defaultShort = 0;
        var canDefault = p.fillDefault && p.defaultMogrtName && defProject;
        var spanS = items.length ? items[0].inS : 0;
        var spanE = items.length ? items[0].outS : 0;
        for (i = 1; i < items.length; i++) {
            if (items[i].outS > spanE) { spanE = items[i].outS; }
        }
        // Bookends: the stretch before the first reference and after the last one is
        // otherwise left completely blank. Reusing the exact same default MOGRT/track/
        // text/animation settings, the lead-in just means starting the walk at 0 instead
        // of spanS - the existing per-cue default-fill loop below handles the rest with
        // no changes. The trail-out needs an explicit pass after the loop, added below.
        var fillBookends = p.fillBookends && canDefault;
        var seqEndSeconds = null;
        if (fillBookends) {
            seqEndSeconds = 0;
            for (var vt = 0; vt < seq.videoTracks.numTracks; vt++) {
                var vtrack = seq.videoTracks[vt];
                for (var vc2 = 0; vc2 < vtrack.clips.numItems; vc2++) {
                    var vEnd = vtrack.clips[vc2].end.seconds;
                    if (vEnd > seqEndSeconds) { seqEndSeconds = vEnd; }
                }
            }
        }
        var walk = fillBookends ? 0 : spanS;
        for (i = 0; i < items.length; i++) {
            var cue = items[i];

            // Default up to this cue. The shared item is switched to "no label" for the
            // fill and back to green for the cue, so the fills should stay uncoloured.
            if (canDefault) {
                if (p.labelsEnabled && srProject) { vaSetProjectLabel(srProject, p.noLabelIndex, "default fill (no label)", report); }
                var dCur = walk;
                var dGuard = 0;
                while (cue.inS - dCur > tol && dGuard < 500) {
                    dGuard++;
                    try {
                        var dPiece = placeTimelineItem({ kind: "DEFAULT", row: null, inS: dCur, outS: cue.inS, label: "Default fill" }, defProject, p.defaultMogrtName, ltTrack, p.textParamName, p.animationParamName);
                        report.defaultPieces++;
                        var dMis = vaPlacementMismatch(dCur, cue.inS, dPiece, tol);
                        if (dMis) { report.errors.push("Default piece at " + dCur.toFixed(3) + "s: " + dMis); }
                        if (dPiece.end.seconds < cue.inS - tol) { report.defaultShort++; }
                        if (dPiece.end.seconds <= dCur + tol) {
                            report.errors.push("Default fill at " + dCur.toFixed(2) + "s: the MOGRT would not extend.");
                            break;
                        }
                        dCur = dPiece.end.seconds;
                    } catch (eDef) {
                        report.errors.push("Default fill at " + dCur.toFixed(2) + "s: " + String(eDef));
                        break;
                    }
                }
                if (dCur > walk) { walk = dCur; }
            }

            // The cue itself, labelled green.
            try {
                if (p.labelsEnabled && srProject) { vaSetProjectLabel(srProject, p.srLabelIndex, "scripture MOGRT", report); }
                var plLt = placeTimelineItem(cue, srProject, p.mogrtName, ltTrack, p.textParamName, p.animationParamName);
                if (cue.fsOrigin) { report.placedFsLt = (report.placedFsLt || 0) + 1; } else { report.placedLt++; }
                var ltMis = vaPlacementMismatch(cue.inS, cue.outS, plLt, tol);
                if (ltMis) { report.errors.push((cue.fsOrigin ? "FS-LT " : "LT ") + cue.row.tc_in + " " + cue.row.reference + ": " + ltMis); }
                walk = plLt.end.seconds;
            } catch (eLt) {
                var eLtStr = String(eLt);
                // A fullscreen's own LT fallback colliding with something already there is
                // benign, not an error: a wider citation already covers that span, so the
                // "something's on screen either way" goal this fallback exists for is
                // already met. Any other failure (including a real LT row conflicting)
                // is still reported normally.
                if (cue.fsOrigin && eLtStr.indexOf("conflicts with existing clip") !== -1) {
                    report.fsLtSkippedOverlap = (report.fsLtSkippedOverlap || 0) + 1;
                } else {
                    report.errors.push(cue.label + ": " + eLtStr);
                }
                // A failed cue leaves its window empty; the walk moves past it.
                if (cue.outS > walk) { walk = cue.outS; }
            }
        }

        // Trail-out bookend: the loop above stops once the last cue is placed, so this
        // needs its own pass to extend the default fill from there to the actual end of
        // content, with the same no-label switch the per-cue fills already use.
        if (fillBookends) {
            if (p.labelsEnabled && srProject) { vaSetProjectLabel(srProject, p.noLabelIndex, "default fill (no label)", report); }
            var tCur = walk;
            var tGuard = 0;
            while (seqEndSeconds - tCur > tol && tGuard < 500) {
                tGuard++;
                try {
                    var tPiece = placeTimelineItem({ kind: "DEFAULT", row: null, inS: tCur, outS: seqEndSeconds, label: "Default fill (trail-out)" }, defProject, p.defaultMogrtName, ltTrack, p.textParamName, p.animationParamName);
                    report.defaultPieces++;
                    if (tPiece.end.seconds <= tCur + tol) {
                        report.errors.push("Default fill (trail-out) at " + tCur.toFixed(2) + "s: the MOGRT would not extend.");
                        break;
                    }
                    tCur = tPiece.end.seconds;
                } catch (eTrail) {
                    report.errors.push("Default fill (trail-out) at " + tCur.toFixed(2) + "s: " + String(eTrail));
                    break;
                }
            }
            walk = tCur;
        }

        if (items.length) {
            // Verification: read the track again and report anything still uncovered.
            var verifySpanS = fillBookends ? 0 : spanS;
            var verifySpanE = fillBookends ? seqEndSeconds : spanE;
            var left = vaUncoveredGaps(ltTrack, verifySpanS, verifySpanE, tol);
            report.uncovered = left.length;
            for (var u = 0; u < left.length; u++) {
                report.errors.push("STILL UNCOVERED: " + left[u][0].toFixed(3) + "s to " + left[u][1].toFixed(3) + "s");
            }
            // Diagnostic: what Premiere reports for the clips around the first uncovered stretches.
            for (var d = 0; d < left.length && d < 3; d++) {
                var dS = left[d][0] - 30;
                var dE = left[d][1] + 30;
                for (c = 0; c < ltTrack.clips.numItems; c++) {
                    var dc = ltTrack.clips[c];
                    if (dc.end.seconds > dS && dc.start.seconds < dE) {
                        report.errors.push("  DUMP near " + left[d][0].toFixed(3) + "s: \"" + dc.name + "\" " + dc.start.seconds.toFixed(3) + "s-" + dc.end.seconds.toFixed(3) + "s");
                    }
                }
            }
        }

        // 3. Rebuild the placement record from what is on the track, so re-applying removes
        // every piece. Default pieces also get the animation toggle turned off.
        report.placed = [];
        for (c = 0; c < ltTrack.clips.numItems; c++) {
            var vc = ltTrack.clips[c];
            if (!isVaName(vc.name)) { continue; }
            if (vc.name === p.defaultMogrtName) {
                vaSetBooleanParam(vc, p.animationParamName, false);
                report.placedDefault = (report.placedDefault || 0) + 1;
            }
            report.placed.push({ trackIndex: p.videoTrackIndex, startSec: vc.start.seconds, name: vc.name });
        }

        // 3a. If a fullscreen graphic will cover this track, push any cut whose dissolve
        // would start before the fullscreen is up so the whole dissolve plays hidden
        // behind it instead. Only meaningful once transitions and the fullscreen
        // graphic are both actually going to exist.
        if (p.transitionsEnabled && p.fsEnabled && fsWindows.length && report.placed.length) {
            vaShiftCutsBehindFullscreens(seq, p.videoTrackIndex, p.srSrFrames, p.srDefFrames, p.mogrtName, p.defaultMogrtName, fsWindows, frameSec, frameTicks, report);
        }

        // 3b. Transitions at every cut between adjacent clips on the track.
        if (p.transitionsEnabled && report.placed.length) {
            vaAddTransitions(seq, p.videoTrackIndex, p.transitionName, p.srSrFrames, p.srDefFrames, p.mogrtName, p.defaultMogrtName, frameSec, report);
        }

        // 4. Approved fullscreen markers, and - if a fullscreen MOGRT is configured - an
        // actual on-screen graphic for each one, with the verse's own text (not the
        // reference) set into it, on its own track so it never conflicts with LT clips.
        var fs = p.fs || [];
        var fsTrack = (p.fsEnabled && p.fsTrackIndex >= 0 && p.fsTrackIndex < seq.videoTracks.numTracks) ? seq.videoTracks[p.fsTrackIndex] : null;
        var fsProject = (p.fsEnabled && p.fsMogrtName) ? vaFindProjectItemByName(app.project.rootItem, p.fsMogrtName) : null;
        if (p.fsEnabled && fs.length && !fsProject) {
            report.errors.push("Fullscreen graphic: MOGRT \"" + p.fsMogrtName + "\" not found in the Project panel - markers were still created, but no graphic was placed.");
        }
        report.placedFs = 0;
        report.markersPlaced = [];
        for (i = 0; i < fs.length; i++) {
            var fr = fs[i];
            var fIn, fOut;
            try {
                var fwPre = fsAllWindows[i];
                if (!fwPre) { throw new Error("could not parse tc_in/displayEnd"); }
                fIn = fwPre.fIn;
                fOut = fwPre.fOut;
                var mk = markers.createMarker(fIn);
                if (!mk) { throw new Error("createMarker returned null"); }
                mk.name = fr.reference;
                mk.comments = fr.verseText;
                mk.end = fOut;
                mk.setColorByIndex(p.markerColorIndex);
                report.markersFs++;
                report.markersPlaced.push({ startSec: fIn, reference: fr.reference });
            } catch (eF) {
                report.errors.push("FS " + fr.reference + " at " + fr.tc_in + ": " + String(eF));
                continue;
            }
            if (fsTrack && fsProject) {
                try {
                    var fsItem = { kind: "FS", row: fr, inS: fIn, outS: fOut, label: "FS " + fr.tc_in + " " + fr.reference, textValue: fr.verseText };
                    var plFs = placeTimelineItem(fsItem, fsProject, p.fsMogrtName, fsTrack, p.fsTextParamName, p.fsAnimationParamName);
                    // The fullscreen template has two separate text boxes - verse text
                    // (set above, same path every other text param goes through) and the
                    // reference, set here directly since it's unique to this one MOGRT.
                    if (p.fsReferenceParamName) {
                        var refTxt = vaSetMgtText(plFs, p.fsReferenceParamName, fr.reference);
                        if (!refTxt.ok) { report.errors.push("FS reference text " + fr.reference + " at " + fr.tc_in + ": " + refTxt.error); }
                    }
                    report.placedFs++;
                    report.placed.push({ trackIndex: p.fsTrackIndex, startSec: plFs.start.seconds, name: plFs.name });
                } catch (eFg) {
                    report.errors.push("FS graphic " + fr.reference + " at " + fr.tc_in + ": " + String(eFg));
                }
            }
        }

        // 5. Non-scripture production markers (Website/Helpline/BRoll/Definition/
        // Product) - plain markers only, no graphic, left at Premiere's default color
        // on purpose. Named "VA | <type> | <name>" so the sweep above picks them up
        // again next time without any position bookkeeping.
        var otherMarkers = p.markers || [];
        report.markersOther = 0;
        for (i = 0; i < otherMarkers.length; i++) {
            var om = otherMarkers[i];
            try {
                var omSec = vaTimecodeToSeconds(om.tc_in, timing.nominalFps, timing.isDropFrame, timing.actualFrameRate);
                var omk = markers.createMarker(omSec);
                if (!omk) { throw new Error("createMarker returned null"); }
                omk.name = "VA | " + om.type + (om.name ? " | " + om.name : "");
                omk.comments = om.triggerQuote || "";
                report.markersOther++;
            } catch (eOm) {
                report.errors.push(om.type + " marker at " + om.tc_in + ": " + String(eOm));
            }
        }

        return JSON.stringify(report);
    } catch (e) {
        return JSON.stringify({ success: false, error: String(e) + (e.line ? (" (line " + e.line + ")") : "") });
    }
}

// ---- Stage 4: transcript file access ----

function vaBrowseForTranscript() {
    try {
        var f = File.openDialog("Select a transcript (.srt)", "*.srt");
        if (!f) {
            return JSON.stringify({ success: false, error: "No file selected." });
        }
        return JSON.stringify({ success: true, path: f.fsName });
    } catch (e) {
        return JSON.stringify({ success: false, error: String(e) });
    }
}

function vaReadTextFile(path) {
    try {
        var f = new File(path);
        if (!f.exists) {
            return JSON.stringify({ success: false, error: "File not found: " + path });
        }
        f.encoding = "UTF-8";
        f.open("r");
        var text = f.read();
        f.close();
        return JSON.stringify({ success: true, text: text });
    } catch (e) {
        return JSON.stringify({ success: false, error: String(e) });
    }
}

// ---- Stage 3: cue list placement ----

// Returns the sequence's timebase, display-format code, and derived nominal
// fps / drop-frame flag / actual frame rate. videoDisplayFormat codes per
// Adobe's documented constants: 102 = 29.97 Drop, 106 = 59.94 Drop (these
// are the only two drop-frame codes; display-format parity is NOT a
// reliable drop-frame signal in general, e.g. 104 = 30fps Non-Drop is also
// even, so the two drop codes are checked explicitly rather than by parity).
function vaGetSequenceTiming(seq) {
    var timebaseStr = seq.timebase;
    var displayFormat = seq.videoDisplayFormat;
    var actualFrameRate = 254016000000 / Number(timebaseStr);
    var nominalFps = Math.round(actualFrameRate);
    var isDropFrame = (displayFormat === 102 || displayFormat === 106);
    return {
        timebase: String(timebaseStr),
        videoDisplayFormat: displayFormat,
        nominalFps: nominalFps,
        isDropFrame: isDropFrame,
        actualFrameRate: actualFrameRate
    };
}

function vaGetSequenceTimingInfo() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) {
            return JSON.stringify({ success: false, error: "No active sequence." });
        }
        var timing = vaGetSequenceTiming(seq);
        return JSON.stringify({ success: true, timing: timing });
    } catch (e) {
        return JSON.stringify({ success: false, error: String(e) });
    }
}

// Converts a timecode string to seconds. Accepts either SRT-style
// HH:MM:SS,mmm (real elapsed time, no drop-frame math needed) or Premiere
// frame timecode HH:MM:SS:FF / HH;MM;SS;FF (frame math, including SMPTE
// drop-frame if isDropFrame is true, using nominalFps for frame-number
// arithmetic and actualFrameRate for the final seconds conversion).
function vaTimecodeToSeconds(tc, nominalFps, isDropFrame, actualFrameRate) {
    var trimmed = tc.replace(/^\s+|\s+$/g, "");

    var msMatch = trimmed.match(/^(\d+):(\d{2}):(\d{2}),(\d{1,3})$/);
    if (msMatch) {
        var hh = parseInt(msMatch[1], 10);
        var mm = parseInt(msMatch[2], 10);
        var ss = parseInt(msMatch[3], 10);
        var msStr = msMatch[4];
        while (msStr.length < 3) { msStr += "0"; }
        var ms = parseInt(msStr, 10);
        return hh * 3600 + mm * 60 + ss + ms / 1000;
    }

    var rawParts = trimmed.split(/[^0-9]+/);
    var nums = [];
    var i;
    for (i = 0; i < rawParts.length; i++) {
        if (rawParts[i].length > 0) { nums.push(parseInt(rawParts[i], 10)); }
    }
    if (nums.length !== 4) {
        throw new Error('"' + tc + '" is not a recognized HH:MM:SS,mmm or HH:MM:SS:FF timecode');
    }
    var hh2 = nums[0], mm2 = nums[1], ss2 = nums[2], ff2 = nums[3];
    var frameNumber;
    if (!isDropFrame) {
        frameNumber = (hh2 * 3600 + mm2 * 60 + ss2) * nominalFps + ff2;
    } else {
        var framesPerMinuteDropped = Math.round(nominalFps * 2 / 30);
        var totalMinutes = hh2 * 60 + mm2;
        var droppedFrames = framesPerMinuteDropped * (totalMinutes - Math.floor(totalMinutes / 10));
        frameNumber = ((hh2 * 3600 + mm2 * 60 + ss2) * nominalFps + ff2) - droppedFrames;
    }
    return frameNumber / actualFrameRate;
}

function vaBrowseForCsv() {
    try {
        var f = File.openDialog("Select a cue list CSV", "*.csv");
        if (!f) {
            return JSON.stringify({ success: false, error: "No file selected." });
        }
        return JSON.stringify({ success: true, path: f.fsName });
    } catch (e) {
        return JSON.stringify({ success: false, error: String(e) });
    }
}

// Minimal CSV parser (ES3-safe): supports double-quoted fields, embedded
// commas, and escaped "" inside quotes.
function vaParseCsv(text) {
    var rows = [];
    var row = [];
    var field = "";
    var inQuotes = false;
    var i;

    function pushField() { row.push(field); field = ""; }
    function pushRow() { pushField(); rows.push(row); row = []; }

    for (i = 0; i < text.length; i++) {
        var c = text.charAt(i);
        if (inQuotes) {
            if (c === '"') {
                if (text.charAt(i + 1) === '"') { field += '"'; i++; }
                else { inQuotes = false; }
            } else {
                field += c;
            }
        } else {
            if (c === '"') { inQuotes = true; }
            else if (c === ",") { pushField(); }
            else if (c === "\r") { /* ignore */ }
            else if (c === "\n") { pushRow(); }
            else { field += c; }
        }
    }
    if (field.length > 0 || row.length > 0) { pushRow(); }

    var filtered = [];
    for (i = 0; i < rows.length; i++) {
        if (!(rows[i].length === 1 && rows[i][0] === "")) { filtered.push(rows[i]); }
    }
    return filtered;
}

// Places an LT for every row in a cue-list CSV (regardless of the row's
// display value - a fullscreen-recommended row still gets a lower-third
// placed, per request): inserts mogrtName at tc_in, trims to tc_out, sets
// textParamName to the row's reference. Skips (and logs why) any row that
// fails to parse or collides with an existing clip on the track.
function vaPlaceCueList(csvPath, mogrtName, videoTrackIndex, textParamName, animationParamName) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) {
            return JSON.stringify({ success: false, error: "No active sequence." });
        }
        if (videoTrackIndex < 0 || videoTrackIndex >= seq.videoTracks.numTracks) {
            return JSON.stringify({ success: false, error: "Video track index " + videoTrackIndex + " out of range (sequence has " + seq.videoTracks.numTracks + " video tracks)." });
        }

        var timing = vaGetSequenceTiming(seq);

        var projectItem = vaFindProjectItemByName(app.project.rootItem, mogrtName);
        if (!projectItem) {
            return JSON.stringify({ success: false, error: "Could not find a Project panel item named \"" + mogrtName + "\"." });
        }

        var csvFile = new File(csvPath);
        if (!csvFile.exists) {
            return JSON.stringify({ success: false, error: "CSV file not found: " + csvPath });
        }
        csvFile.encoding = "UTF-8";
        csvFile.open("r");
        var csvText = csvFile.read();
        csvFile.close();

        var rows = vaParseCsv(csvText);
        if (rows.length < 2) {
            return JSON.stringify({ success: false, error: "CSV has no data rows." });
        }
        var header = rows[0];
        for (var h = 0; h < header.length; h++) { header[h] = header[h].replace(/^\s+|\s+$/g, ""); }

        var track = seq.videoTracks[videoTrackIndex];
        var placedCount = 0;
        var skipped = [];

        for (var r = 1; r < rows.length; r++) {
            var rawRow = rows[r];
            var cue = {};
            for (var c = 0; c < header.length; c++) {
                cue[header[c]] = (rawRow[c] !== undefined ? rawRow[c] : "").replace(/^\s+|\s+$/g, "");
            }
            var rowLabel = "Row " + (r + 1) + " (" + cue.display + " \"" + cue.reference + "\")";

            try {
                var tcInSec, tcOutSec;
                try {
                    tcInSec = vaTimecodeToSeconds(cue.tc_in, timing.nominalFps, timing.isDropFrame, timing.actualFrameRate);
                    tcOutSec = vaTimecodeToSeconds(cue.tc_out, timing.nominalFps, timing.isDropFrame, timing.actualFrameRate);
                } catch (eTc) {
                    skipped.push(rowLabel + ": could not parse tc_in/tc_out - " + eTc);
                    continue;
                }
                if (tcOutSec <= tcInSec) {
                    skipped.push(rowLabel + ": tc_out is not after tc_in.");
                    continue;
                }

                var conflict = null;
                for (var ci = 0; ci < track.clips.numItems; ci++) {
                    var existing = track.clips[ci];
                    if (tcInSec < existing.end.seconds && existing.start.seconds < tcOutSec) {
                        conflict = existing;
                        break;
                    }
                }
                if (conflict) {
                    skipped.push(rowLabel + ": conflicts with existing clip \"" + conflict.name + "\" (" + conflict.start.seconds.toFixed(2) + "s-" + conflict.end.seconds.toFixed(2) + "s).");
                    continue;
                }

                var placeOk = track.overwriteClip(projectItem, tcInSec);
                if (!placeOk) {
                    skipped.push(rowLabel + ": overwriteClip() returned false.");
                    continue;
                }

                var placed = vaFindNearestTrackItemByStart(track, tcInSec);
                if (!placed) {
                    skipped.push(rowLabel + ": placed but could not find it back on the track afterward.");
                    continue;
                }

                var endTime = new Time();
                endTime.seconds = tcOutSec;
                placed.end = endTime;

                var textSetOk = false;
                var textSetError = null;
                try {
                    var mgt = placed.getMGTComponent();
                    if (!mgt) {
                        textSetError = "getMGTComponent() returned null (clip stays placed, but text was not set).";
                    } else {
                        var foundParam = null;
                        for (var pp = 0; pp < mgt.properties.numItems; pp++) {
                            if (mgt.properties[pp].displayName === textParamName) { foundParam = mgt.properties[pp]; break; }
                        }
                        if (!foundParam) {
                            textSetError = "Parameter \"" + textParamName + "\" not found on this MOGRT (clip stays placed, but text was not set).";
                        } else {
                            var raw = vaSafeGetValue(foundParam);
                            var parsedVal = null;
                            try { parsedVal = JSON.parse(raw); } catch (eJ) { parsedVal = null; }
                            var newVal;
                            if (parsedVal && typeof parsedVal === "object" && ("textEditValue" in parsedVal)) {
                                parsedVal.textEditValue = cue.reference;
                                parsedVal.fontTextRunLength = [cue.reference.length];
                                newVal = JSON.stringify(parsedVal);
                            } else {
                                newVal = cue.reference;
                            }
                            textSetOk = foundParam.setValue(newVal, true);
                            if (!textSetOk) { textSetError = "setValue() returned false."; }
                        }
                    }
                } catch (eText) {
                    textSetError = String(eText);
                }

                if (!textSetOk) {
                    skipped.push(rowLabel + ": " + textSetError);
                    continue;
                }

                var animationResult = vaSetBooleanParam(placed, animationParamName, false);
                if (animationResult.attempted && !animationResult.success) {
                    skipped.push(rowLabel + ": placed and text set OK, but turning off \"" + animationParamName + "\" failed - " + animationResult.error + " (not counted as skipped/failed overall).");
                }

                placedCount++;
            } catch (eRow) {
                skipped.push(rowLabel + ": " + String(eRow));
            }
        }

        return JSON.stringify({
            success: true,
            placedCount: placedCount,
            skippedCount: skipped.length,
            skipped: skipped,
            timing: timing
        });
    } catch (e) {
        return JSON.stringify({ success: false, error: String(e) + (e.line ? (" (line " + e.line + ")") : "") });
    }
}

function vaGetSequenceInfo() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) {
            return JSON.stringify({ success: false, error: "No active sequence." });
        }
        return JSON.stringify({
            success: true,
            name: seq.name,
            videoTrackCount: seq.videoTracks.numTracks,
            playheadSeconds: seq.getPlayerPosition().seconds
        });
    } catch (e) {
        return JSON.stringify({ success: false, error: String(e) });
    }
}

function vaBrowseForMogrt() {
    try {
        var f = File.openDialog("Select a .mogrt file", "*.mogrt");
        if (!f) {
            return JSON.stringify({ success: false, error: "No file selected." });
        }
        return JSON.stringify({ success: true, path: f.fsName });
    } catch (e) {
        return JSON.stringify({ success: false, error: String(e) });
    }
}

// Finds a ProjectItem anywhere in the project (recursively through bins)
// whose name matches the given name, tolerant of the item being shown with
// or without the .mogrt extension in the Project panel.
function vaFindProjectItemByName(rootItem, name) {
    var withoutExt = name.replace(/\.mogrt$/i, "");
    var withExt = withoutExt + ".mogrt";
    var queue = [];
    for (var i = 0; i < rootItem.children.numItems; i++) {
        queue.push(rootItem.children[i]);
    }
    while (queue.length) {
        var item = queue.shift();
        if (item.name === name || item.name === withoutExt || item.name === withExt) {
            return item;
        }
        if (item.type === ProjectItemType.BIN && item.children) {
            for (var j = 0; j < item.children.numItems; j++) {
                queue.push(item.children[j]);
            }
        }
    }
    return null;
}

function vaFindNearestTrackItemByStart(track, targetSeconds) {
    var best = null;
    var bestDiff = Infinity;
    for (var i = 0; i < track.clips.numItems; i++) {
        var item = track.clips[i];
        var diff = Math.abs(item.start.seconds - targetSeconds);
        if (diff < bestDiff) {
            bestDiff = diff;
            best = item;
        }
    }
    return best;
}

// Inserts the .mogrt at mogrtPath onto videoTrackIndex (0-based) at the
// current playhead position. Returns info about the placed clip so the
// panel can immediately dump/inspect it.
function vaInsertMogrtAtPlayhead(mogrtPath, videoTrackIndex, animationParamName) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) {
            return JSON.stringify({ success: false, error: "No active sequence." });
        }
        if (videoTrackIndex < 0 || videoTrackIndex >= seq.videoTracks.numTracks) {
            return JSON.stringify({ success: false, error: "Video track index " + videoTrackIndex + " out of range (sequence has " + seq.videoTracks.numTracks + " video tracks)." });
        }

        var file = new File(mogrtPath);
        if (!file.exists) {
            return JSON.stringify({ success: false, error: "File does not exist: " + mogrtPath });
        }

        var importOk = app.project.importFiles([mogrtPath], true, app.project.rootItem, false);
        if (!importOk) {
            return JSON.stringify({ success: false, error: "app.project.importFiles() returned false for: " + mogrtPath });
        }

        // File.name URL-encodes spaces (returns "FS%20Text%20WFL" for a file with real
        // spaces in it), which only ever showed up once a template's filename actually
        // had a space in it. mogrtPath itself is the plain string the browse dialog gave
        // us, so pull the base name from that instead of from the File object.
        var baseName = mogrtPath.replace(/^.*[\\\/]/, "").replace(/\.mogrt$/i, "");
        var projectItem = vaFindProjectItemByName(app.project.rootItem, baseName);
        if (!projectItem) {
            return JSON.stringify({ success: false, error: "Imported the file but could not find the resulting ProjectItem named \"" + baseName + "\" in the project panel." });
        }

        var track = seq.videoTracks[videoTrackIndex];
        var playheadSeconds = seq.getPlayerPosition().seconds;

        var placeOk = track.overwriteClip(projectItem, playheadSeconds);
        if (!placeOk) {
            return JSON.stringify({ success: false, error: "track.overwriteClip() returned false." });
        }

        var placed = vaFindNearestTrackItemByStart(track, playheadSeconds);
        if (!placed) {
            return JSON.stringify({ success: false, error: "Placed the clip but could not find it back on the track afterward." });
        }

        var animationResult = vaSetBooleanParam(placed, animationParamName, false);

        return JSON.stringify({
            success: true,
            clipName: placed.name,
            startSeconds: placed.start.seconds,
            endSeconds: placed.end.seconds,
            videoTrackIndex: videoTrackIndex,
            animationToggle: animationResult
        });
    } catch (e) {
        return JSON.stringify({ success: false, error: String(e) + (e.line ? (" (line " + e.line + ")") : "") });
    }
}

// Places a MOGRT that's already a ProjectItem somewhere in the project
// (found by name, recursively through bins) at the playhead on
// videoTrackIndex. No import involved — this is the primary/recommended
// path when the MOGRT is already in the Project panel.
function vaInsertExistingMogrtAtPlayhead(mogrtName, videoTrackIndex, animationParamName) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) {
            return JSON.stringify({ success: false, error: "No active sequence." });
        }
        if (videoTrackIndex < 0 || videoTrackIndex >= seq.videoTracks.numTracks) {
            return JSON.stringify({ success: false, error: "Video track index " + videoTrackIndex + " out of range (sequence has " + seq.videoTracks.numTracks + " video tracks)." });
        }

        var projectItem = vaFindProjectItemByName(app.project.rootItem, mogrtName);
        if (!projectItem) {
            return JSON.stringify({ success: false, error: "Could not find a Project panel item named \"" + mogrtName + "\" (checked with and without the .mogrt extension, recursively through all bins). Check the exact spelling shown in the Project panel." });
        }

        var track = seq.videoTracks[videoTrackIndex];
        var playheadSeconds = seq.getPlayerPosition().seconds;

        var placeOk = track.overwriteClip(projectItem, playheadSeconds);
        if (!placeOk) {
            return JSON.stringify({ success: false, error: "track.overwriteClip() returned false." });
        }

        var placed = vaFindNearestTrackItemByStart(track, playheadSeconds);
        if (!placed) {
            return JSON.stringify({ success: false, error: "Placed the clip but could not find it back on the track afterward." });
        }

        var animationResult = vaSetBooleanParam(placed, animationParamName, false);

        return JSON.stringify({
            success: true,
            clipName: placed.name,
            startSeconds: placed.start.seconds,
            endSeconds: placed.end.seconds,
            videoTrackIndex: videoTrackIndex,
            animationToggle: animationResult
        });
    } catch (e) {
        return JSON.stringify({ success: false, error: String(e) + (e.line ? (" (line " + e.line + ")") : "") });
    }
}

// Finds the clip nearest the current playhead on the given track, for the
// dump/set-text buttons to operate on (so you don't have to re-insert every
// time you just want to re-inspect).
function vaGetClipNearPlayhead(videoTrackIndex) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) {
            return { error: "No active sequence." };
        }
        if (videoTrackIndex < 0 || videoTrackIndex >= seq.videoTracks.numTracks) {
            return { error: "Video track index " + videoTrackIndex + " out of range." };
        }
        var track = seq.videoTracks[videoTrackIndex];
        if (track.clips.numItems === 0) {
            return { error: "No clips on this track." };
        }
        var playheadSeconds = seq.getPlayerPosition().seconds;
        var clip = vaFindNearestTrackItemByStart(track, playheadSeconds);
        if (!clip) {
            return { error: "Could not find a clip on this track." };
        }
        return { clip: clip };
    } catch (e) {
        return { error: String(e) };
    }
}

// Scans every video track for a clip actually containing the current
// playhead (start <= playhead < end), and for each such clip that has a
// readable MGT component, returns every text-shaped parameter's current
// value. Returns JSON: {success, playheadSeconds, clips: [{trackIndex,
// clipName, textParams: [{displayName, text}]}]}
function vaGetMogrtTextsUnderPlayhead() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) {
            return JSON.stringify({ success: false, error: "No active sequence." });
        }
        var playheadSeconds = seq.getPlayerPosition().seconds;
        var clips = [];

        for (var t = 0; t < seq.videoTracks.numTracks; t++) {
            var track = seq.videoTracks[t];
            for (var i = 0; i < track.clips.numItems; i++) {
                var item = track.clips[i];
                if (item.start.seconds <= playheadSeconds && playheadSeconds < item.end.seconds) {
                    var textParams = [];
                    try {
                        var mgt = item.getMGTComponent();
                        if (mgt) {
                            for (var p = 0; p < mgt.properties.numItems; p++) {
                                var param = mgt.properties[p];
                                var raw = vaSafeGetValue(param);
                                var parsed = null;
                                try { parsed = JSON.parse(raw); } catch (eP) { parsed = null; }
                                if (parsed && typeof parsed === "object" && ("textEditValue" in parsed)) {
                                    textParams.push({ displayName: param.displayName, text: parsed.textEditValue });
                                } else if (typeof raw === "string" && parsed === null) {
                                    textParams.push({ displayName: param.displayName, text: raw });
                                }
                            }
                        }
                    } catch (eMgt) {
                        // Not a readable MGT clip (e.g. native graphic) - skip silently, this is expected for non-MOGRT clips.
                    }
                    if (textParams.length > 0) {
                        clips.push({ trackIndex: t, clipName: item.name, textParams: textParams });
                    }
                }
            }
        }

        return JSON.stringify({ success: true, playheadSeconds: playheadSeconds, clips: clips });
    } catch (e) {
        return JSON.stringify({ success: false, error: String(e) });
    }
}

// Finds a named parameter on the clip's MGT component and sets it to a
// boolean value (e.g. turning an "Animation" toggle off on placement).
// No-op (returns {attempted:false}) if paramName is empty, there's no MGT
// component, or no parameter with that exact display name exists.
function vaSetBooleanParam(trackItem, paramName, value) {
    if (!paramName) { return { attempted: false, reason: "no parameter name given" }; }
    try {
        var mgt = trackItem.getMGTComponent();
        if (!mgt) { return { attempted: false, reason: "getMGTComponent() returned null" }; }
        for (var p = 0; p < mgt.properties.numItems; p++) {
            if (mgt.properties[p].displayName === paramName) {
                try {
                    var ok = mgt.properties[p].setValue(value, true);
                    return { attempted: true, success: !!ok };
                } catch (eSet) {
                    return { attempted: true, success: false, error: String(eSet) };
                }
            }
        }
        return { attempted: false, reason: "parameter \"" + paramName + "\" not found on this MOGRT" };
    } catch (e) {
        return { attempted: true, success: false, error: String(e) };
    }
}

function vaSafeGetValue(param) {
    try {
        return param.getValue();
    } catch (e) {
        return "<error reading value: " + String(e) + ">";
    }
}

function vaSafeGetMatchName(obj) {
    try {
        return obj.matchName;
    } catch (e) {
        return null;
    }
}

// Dumps every component on the clip nearest the playhead, and every
// parameter in each component: displayName, matchName (if available), and
// current value. Tries getMGTComponent() first (the documented path for
// MOGRT text), and separately always includes the full component chain so
// nothing is hidden if getMGTComponent() returns null (a known risk for
// templates not authored as true .mogrt files in After Effects).
function vaDumpComponents(videoTrackIndex) {
    try {
        var found = vaGetClipNearPlayhead(videoTrackIndex);
        if (found.error) {
            return JSON.stringify({ success: false, error: found.error });
        }
        var clip = found.clip;

        var result = {
            success: true,
            clipName: clip.name,
            mgtComponent: null,
            mgtError: null,
            allComponents: []
        };

        try {
            var mgt = clip.getMGTComponent();
            if (mgt) {
                var mgtParams = [];
                for (var p = 0; p < mgt.properties.numItems; p++) {
                    var param = mgt.properties[p];
                    mgtParams.push({
                        displayName: param.displayName,
                        matchName: vaSafeGetMatchName(param),
                        value: vaSafeGetValue(param)
                    });
                }
                result.mgtComponent = {
                    displayName: mgt.displayName,
                    matchName: vaSafeGetMatchName(mgt),
                    params: mgtParams
                };
            } else {
                result.mgtError = "getMGTComponent() returned null/undefined.";
            }
        } catch (eMgt) {
            result.mgtError = "getMGTComponent() threw: " + String(eMgt);
        }

        try {
            var chain = clip.components;
            for (var c = 0; c < chain.numItems; c++) {
                var comp = chain[c];
                var compParams = [];
                for (var q = 0; q < comp.properties.numItems; q++) {
                    var cp = comp.properties[q];
                    compParams.push({
                        displayName: cp.displayName,
                        matchName: vaSafeGetMatchName(cp),
                        value: vaSafeGetValue(cp)
                    });
                }
                result.allComponents.push({
                    displayName: comp.displayName,
                    matchName: vaSafeGetMatchName(comp),
                    params: compParams
                });
            }
        } catch (eChain) {
            result.allComponentsError = String(eChain);
        }

        return JSON.stringify(result);
    } catch (e) {
        return JSON.stringify({ success: false, error: String(e) });
    }
}

// Attempts to set every editable text parameter found (preferring the MGT
// component if present, otherwise every component in the chain) to
// testString. A parameter is treated as "editable text" if its value is
// JSON containing a textEditValue key (the documented AE-mogrt pattern), or
// is itself a plain string. Reports success/failure per parameter with the
// exact error.
function vaSetTestText(videoTrackIndex, testString, targetParamName) {
    try {
        if (!targetParamName) {
            return JSON.stringify({ success: false, error: "No target text parameter name given." });
        }
        var found = vaGetClipNearPlayhead(videoTrackIndex);
        if (found.error) {
            return JSON.stringify({ success: false, error: found.error });
        }
        var clip = found.clip;

        var targetComponents = [];
        var usedMgt = false;
        try {
            var mgt = clip.getMGTComponent();
            if (mgt) {
                targetComponents.push(mgt);
                usedMgt = true;
            }
        } catch (eMgt) {
            // fall through to full chain
        }
        if (!usedMgt) {
            try {
                var chain = clip.components;
                for (var c = 0; c < chain.numItems; c++) {
                    targetComponents.push(chain[c]);
                }
            } catch (eChain) {
                return JSON.stringify({ success: false, error: "No MGT component and could not read component chain: " + String(eChain) });
            }
        }

        var attempts = [];

        for (var ci = 0; ci < targetComponents.length; ci++) {
            var comp = targetComponents[ci];
            var props;
            try {
                props = comp.properties;
            } catch (ePr) {
                continue;
            }
            for (var p = 0; p < props.numItems; p++) {
                var param = props[p];
                if (param.displayName !== targetParamName) {
                    continue; // only touch the one named parameter
                }
                var raw = vaSafeGetValue(param);
                var parsed = null;
                var isJsonTextParam = false;
                try {
                    parsed = JSON.parse(raw);
                    if (parsed && typeof parsed === "object" && ("textEditValue" in parsed)) {
                        isJsonTextParam = true;
                    }
                } catch (eParse) {
                    parsed = null;
                }

                var isPlainStringParam = (typeof raw === "string" && !isJsonTextParam && parsed === null);

                if (!isJsonTextParam && !isPlainStringParam) {
                    continue; // not a text-looking parameter, skip silently
                }

                var attemptResult = {
                    component: comp.displayName,
                    param: param.displayName,
                    matchName: vaSafeGetMatchName(param),
                    kind: isJsonTextParam ? "json-textEditValue" : "plain-string",
                    success: false,
                    error: null
                };

                try {
                    var newValue;
                    if (isJsonTextParam) {
                        parsed.textEditValue = testString;
                        parsed.fontTextRunLength = [testString.length];
                        newValue = JSON.stringify(parsed);
                    } else {
                        newValue = testString;
                    }
                    var ok = param.setValue(newValue, true);
                    attemptResult.success = !!ok;
                    if (!ok) {
                        attemptResult.error = "setValue() returned false";
                    }
                } catch (eSet) {
                    attemptResult.error = String(eSet);
                }

                attempts.push(attemptResult);
            }
        }

        return JSON.stringify({ success: true, usedMgt: usedMgt, attempts: attempts });
    } catch (e) {
        return JSON.stringify({ success: false, error: String(e) });
    }
}
