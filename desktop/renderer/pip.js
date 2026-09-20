/**
 * PiP window. Plays whatever source the main window (or a Finder open, or a
 * drag-drop) hands it, seeked to the right position, and reports its state back
 * so the main window can resume from there. Escape / the button / double-click
 * return to the main window.
 */
import { applySettings, captureSettings } from "/handoff.js";

const p = document.getElementById("pip-player");
const params = new URLSearchParams(location.search);

const baseName = (x) => String(x).split(/[?#]/)[0].split(/[\\/]/).pop() || String(x);
const localSrc = (fp) => "/_local/" + encodeURIComponent(baseName(fp)) + "?p=" + encodeURIComponent(fp);

// How the main window had this film set up. Held rather than used once: a file
// opened from Finder while PiP is up replaces the source in this same window,
// and the viewer's language and speed should survive that too.
let settings = null;
try {
  settings = JSON.parse(params.get("s") || "null");
} catch {
  settings = null;
}
let stopApplying = () => {};

function load(src, time, playing) {
  if (!src) return;
  if (playing) p.setAttribute("autoplay", "");
  p.src = src;
  // Set it right away — the player now holds a seek made before it's ready and
  // applies it the moment it can (and resume covers it from saved position too).
  if (time > 0) {
    try { p.currentTime = time; } catch {}
  }
  stopApplying();
  stopApplying = applySettings(p, settings);
  reportState();
}

/**
 * Merged, not replaced. The read-back runs once a second from the moment the
 * source is set, and for the first of those the file has not been opened yet —
 * it reports no languages at all. Overwriting with that would throw away the
 * pick that is still waiting for the track lists to exist, which is the one
 * thing this whole path is for. A language only moves when a real one answers.
 */
function merge(prev, next) {
  if (!next) return prev;
  if (!prev) return next;
  // Captions have a third state. "None active" is only an answer once the file
  // has actually listed some — before that it is indistinguishable from a list
  // that has not arrived, and taking it at face value would report captions off
  // for a file that is about to turn them on.
  const subsKnown = !!next.subtitle || next.subtitlesOff;
  return {
    // Audio is never off, so nothing here means nothing was known yet.
    audio: next.audio || prev.audio,
    subtitle: subsKnown ? next.subtitle : prev.subtitle,
    subtitlesOff: subsKnown ? !!next.subtitlesOff : !!prev.subtitlesOff,
    volume: typeof next.volume === "number" ? next.volume : prev.volume,
    muted: typeof next.muted === "boolean" ? next.muted : prev.muted,
    rate: typeof next.rate === "number" ? next.rate : prev.rate,
  };
}

function reportState() {
  const src = typeof p.src === "string" ? p.src : null;
  // Read back rather than echo what arrived: the point of the return trip is
  // whatever the viewer changed in HERE.
  settings = merge(settings, captureSettings(p));
  try { window.movi.pipReportState(src, p.currentTime || 0, settings); } catch {}
}

// Initial handoff from the main window.
load(params.get("src"), parseFloat(params.get("t") || "0"), params.get("playing") === "1");

setInterval(reportState, 1000);
window.addEventListener("beforeunload", reportState);

// A Finder open while PiP is active is routed here by the main process.
window.movi.onPipLoad((d) => load(d && d.src, (d && d.time) || 0, true));

// The float is a window too, and it is the one that is usually making the
// sound when the app is closed — see fadeAudioThen in main.js.
window.movi.onFadeOut?.((ms) => {
  try {
    p.fadeOutAudio?.(ms || 200);
  } catch {
    /* nothing playing, or an older bundle without it */
  }
});

// Drag & drop onto the PiP window.
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", async (e) => {
  e.preventDefault();
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (!f) return;
  const fp = window.movi.pathForFile(f);
  if (fp) {
    try { await window.movi.grant([fp]); } catch {}
    load(localSrc(fp), 0, true);
  } else if (typeof p.setFile === "function") {
    p.setFile(f);
  }
});

// Return to the main window: the button, Escape, or a double-click.
document.getElementById("pip-exit").addEventListener("click", () => window.movi.pipClose());
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") window.movi.pipClose();
});
document.addEventListener("dblclick", () => window.movi.pipClose());

// Hide the player's own (dead) Document-PiP button inside the PiP window.
function hideInnerPipBtn(attempt = 0) {
  const sr = p.shadowRoot;
  if (!sr) {
    if (attempt < 20) setTimeout(() => hideInnerPipBtn(attempt + 1), 100);
    return;
  }
  if (sr.querySelector("#pip-hide-pipbtn")) return;
  const s = document.createElement("style");
  s.id = "pip-hide-pipbtn";
  s.textContent = ".movi-pip-btn, .movi-context-menu-pip { display: none !important; }";
  sr.appendChild(s);
}
hideInnerPipBtn();
