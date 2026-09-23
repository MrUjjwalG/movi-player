/**
 * The toolbar popup.
 *
 * Clicking the icon used to open the player straight away, which left no way
 * to say "not on this site" — the thing an ad blocker's icon is for. So the
 * icon opens this instead: the site you are on, one control that turns
 * takeover off for it, and the button that does what the icon used to do.
 *
 * The per-site switch is stored as a list of hosts rather than a flag per
 * site, so the content script can answer "am I exempt here" from one read.
 */

const TAKEOVER_KEY = "takeOverPageVideos";
const EXEMPT_KEY = "takeoverExemptHosts";

const els = {
  host: document.getElementById("host"),
  power: document.getElementById("power"),
  title: document.getElementById("power-title"),
  sub: document.getElementById("power-sub"),
  open: document.getElementById("open"),
  note: document.getElementById("note"),
};

/** The host a per-site decision is keyed by, or "" for a page that has none. */
function hostOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol === "http:" || u.protocol === "https:") return u.hostname;
  } catch {
    /* a tab with no address yet */
  }
  return "";
}

const state = {
  tabId: null,
  host: "",
  takeoverOn: false,
  exempt: [],
};

function isExempt() {
  return state.host !== "" && state.exempt.includes(state.host);
}

function render() {
  els.host.textContent = state.host || "This page";

  // Three things can be true, and they are not the same thing: takeover is
  // off everywhere, it is on but not here, or it is on here. Saying which
  // one is most of what this popup is for.
  const usable = state.host !== "";
  const on = state.takeoverOn && usable && !isExempt();
  els.power.classList.toggle("on", on);
  els.power.setAttribute("aria-pressed", String(on));
  els.power.disabled = !usable || !state.takeoverOn;

  if (!usable) {
    els.title.textContent = "Take over videos";
    els.sub.textContent = "Not available on this page";
  } else if (!state.takeoverOn) {
    els.title.textContent = "Take over videos here";
    els.sub.textContent = "Turned off in settings";
  } else if (isExempt()) {
    els.title.textContent = "Off for this site";
    els.sub.textContent = "Click to turn it back on";
  } else {
    els.title.textContent = "On for this site";
    els.sub.textContent = "Click to turn it off here";
  }

  const show = state.takeoverOn && usable;
  els.note.hidden = !show;
  if (show) {
    els.note.textContent = isExempt()
      ? "Videos on this site play in the browser's own player."
      : "Videos on this site open in MoviPlayer.";
  }
}

async function load() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tabId = tab?.id ?? null;
  state.host = hostOf(tab?.url || "");
  const data = await chrome.storage.local.get([TAKEOVER_KEY, EXEMPT_KEY]);
  state.takeoverOn = !!data[TAKEOVER_KEY];
  state.exempt = Array.isArray(data[EXEMPT_KEY]) ? data[EXEMPT_KEY] : [];
  render();
}

els.power.addEventListener("click", async () => {
  if (!state.host || !state.takeoverOn) return;
  const turningOff = !isExempt();
  state.exempt = turningOff
    ? [...state.exempt, state.host]
    : state.exempt.filter((h) => h !== state.host);
  await chrome.storage.local.set({ [EXEMPT_KEY]: state.exempt });
  render();

  // Turning it ON reaches the page by itself: the content script is watching
  // the same store and injects from there. Turning it OFF cannot — the page's
  // own <video> elements were replaced and are gone, so there is nothing left
  // to hand the page back. A reload is the only thing that restores them, and
  // telling someone to do it themselves is asking them to finish the job.
  if (turningOff && state.tabId != null) {
    try {
      await chrome.tabs.reload(state.tabId);
    } catch {
      /* the tab went away while the popup was open */
    }
  }
});

els.open.addEventListener("click", async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL("player.html") });
  window.close();
});

load();
