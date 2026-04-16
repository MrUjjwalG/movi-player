// TMDb info panel — auto-fetches movie/TV details from video title
const WORKER = "https://movi-tmdb.mr-ujjwalg.workers.dev";
const IMG = (size, path) => path ? `${WORKER}/img/${size}${path}` : null;

const tmdbToggle = document.getElementById("tmdbToggle");
const tmdbPanel = document.getElementById("tmdbPanel");
const tmdbContent = document.getElementById("tmdbContent");

let panelOpen = false;
let tmdbData = null; // cached result

// ─── Title extraction from filename/URL ──────────────────
function cleanTitle(raw) {
  if (!raw) return null;

  let name = raw;

  // Remove file extension
  name = name.replace(/\.[^.]+$/, "");

  // Replace dots, underscores, dashes with spaces
  name = name.replace(/[._]/g, " ").replace(/-/g, " ");

  // Remove common tags: 720p, 1080p, 2160p, BluRay, WEB-DL, x264, x265, HEVC, HDR, etc.
  name = name.replace(
    /\b(720p|1080p|2160p|4k|uhd|bluray|blu ray|brrip|bdrip|webrip|web dl|web-dl|webdl|hdrip|dvdrip|dvdscr|hdtv|hdcam|cam|ts|tc|r5|scr|screener|x264|x265|h264|h265|hevc|avc|aac|ac3|dts|mp3|flac|atmos|truehd|10bit|sdr|hdr|hdr10|dv|dolby vision|remux|proper|repack|extended|unrated|directors cut|dual audio|multi|hindi|english|eng|hin|esub|esubs|srt|nf|amzn|dsnp|hmax|yts|rarbg|etrg|sparks|geckos|tigole|qxr|pahe)\b/gi,
    ""
  );

  // Remove anything in brackets/parens: [YTS.MX], (2024), [1080p], etc.
  name = name.replace(/[\[\(].*?[\]\)]/g, "");

  // Collapse multiple spaces
  name = name.trim().replace(/\s{2,}/g, " ");

  return name || null;
}

function getVideoTitle() {
  // 1. From player's title attribute (raw, don't clean — may contain | and -)
  const player = document.getElementById("player");
  if (player?.title) return player.title;

  // 2. From document title (set by player.js)
  const docTitle = document.title.replace(/\s*—\s*Movi Player$/, "").trim();
  if (docTitle && docTitle !== "Movi Player") return docTitle;

  // 3. From URL param — extract filename but keep separators intact
  const params = new URLSearchParams(window.location.search);
  const url = params.get("url");
  if (url) {
    try {
      const path = new URL(url).pathname;
      const filename = decodeURIComponent(path.split("/").pop());
      // Remove extension only, keep | and - for music parsing
      return filename.replace(/\.[^.]+$/, "").trim() || null;
    } catch {}
  }

  return null;
}

// ─── Parse song/music video titles ──────────────────────
// "Honey Singh - Lungi Dance" → { people: ["Honey Singh"], song: "Lungi Dance" }
// "JISOO X ZAYN - EYES CLOSED (OFFICIAL MV)" → { people: ["JISOO", "ZAYN"], song: "EYES CLOSED" }
// "Aaj Ki Raat - 8K Video | Stree 2 | Tamannaah, Rajkummar" → { people: [...], movie: "Stree 2" }
// "Chhote Chhote Peg | Honey Singh | Neha Kakkar | Movie" → { people: [...], movie: "Movie" }

// Primary separators: | (normal) and ｜ (fullwidth) only
// " I " is handled separately as secondary split within segments
const PIPE_RE = /\s*[|\uFF5C]\s*/;

// Junk words to strip from tags/brackets
const JUNK_RE = /\b(Official|MV|M\/V|Video|Audio|Song|Lyrical|Lyrics|Visualizer|Teaser|Trailer|Full|Best|8K|4K|UHD|HD|Latest|Hindi|Superhit|Ultra|Music)\b/gi;

// Extract "prod. by X" / "produced by X" — both in parens and at end
function extractProducer(str) {
  // (prod. by NDS) or (produced by NDS)
  const parenMatch = str.match(/\s*\((?:prod\.?\s*by|produced\s*by)\s+([^)]+)\)/i);
  if (parenMatch) {
    return { cleaned: str.replace(parenMatch[0], "").trim(), producer: parenMatch[1].trim() };
  }
  // prod. by NDS at end of string
  const endMatch = str.match(/\s*(?:prod\.?\s*by|produced\s*by)\s+(.+?)$/i);
  if (endMatch) {
    return { cleaned: str.replace(endMatch[0], "").trim(), producer: endMatch[1].trim() };
  }
  return { cleaned: str, producer: null };
}

function cleanMusicJunk(str) {
  return str
    .replace(/\((?:Official\s*)?(?:Music\s+)?(?:MV|M\/V|Video|Audio|Lyric(?:s|al)?|Visualizer|Song|Teaser|Trailer|Full\s+Video)\)/gi, "")
    .replace(/\[(?:Official\s*)?(?:Music\s+)?(?:MV|M\/V|Video|Audio|Lyric(?:s|al)?)\]/gi, "")
    .replace(/\((?:Full\s+)?(?:Video|Song|Lyrics?|Audio)(?:\s+(?:Video|Song|Lyrics?|Audio))*\)/gi, "")
    // Remove (Live on ...), (Live at ...), (Live), (Remix), (Acoustic), (Unplugged)
    .replace(/\((?:Live(?:\s+(?:on|at|from)\s+[^)]*)?|Remix|Acoustic|Unplugged|Slowed|Reverb|Lofi)\)/gi, "")
    .replace(/\uFF1A/g, " ") // fullwidth colon
    .replace(/^LYRICS\s*[:：]\s*/i, "")
    .replace(JUNK_RE, "")
    .replace(/[\(\[]\s*[\)\]]/g, "")
    // Remove orphan trailing " I" left after junk removal (e.g. "Kufar I" from "Kufar I Official Video")
    .replace(/\s+I\s*$/, "")
    // Remove orphan trailing/leading pipe left after junk removal
    .replace(/\s*[|\uFF5C]\s*$/, "")
    .replace(/^\s*[|\uFF5C]\s*/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Split "JISOO X ZAYN" or "Arijit Singh ft Shreya Ghoshal"
function splitArtists(str) {
  return str
    .split(/\s*(?:\bx\b|\bX\b|\bft\.?\b|\bfeat\.?\b|&|,)\s*/i)
    .map(s => s.trim())
    .filter(s => s.length > 1);
}

// Split by " I " (capital i with spaces) — used in Indian YouTube titles
// "Diljit Dosanjh I Sanya Malhotra I Charmer" → ["Diljit Dosanjh", "Sanya Malhotra", "Charmer"]
function splitByCapitalI(str) {
  const parts = str.split(/\s+I\s+/);
  // Only valid if 2+ parts and none are too short (avoid splitting "I" pronoun)
  if (parts.length >= 2 && parts.every(p => p.trim().length > 1)) {
    return parts.map(p => p.trim());
  }
  return null;
}

function parseMusicTitle(title) {
  if (!title) return null;

  // Skip TV show patterns (S01E01, Season 1, etc.) — not music
  if (/S\d{1,2}E\d{1,3}/i.test(title) || /Season\s*\d/i.test(title)) return null;

  let clean = cleanMusicJunk(title);
  clean = clean.replace(/\s{2,}/g, " ").trim();

  const parts = clean.split(PIPE_RE).map(p => p.trim()).filter(Boolean);

  // ── No pipe: try "Artist - Song" or "Artist X Artist - Song" ──
  if (parts.length < 2) {
    const dashSplit = clean.split(/\s*[-–—]\s*/);
    if (dashSplit.length >= 2) {
      const artists = splitArtists(dashSplit[0]);
      let songRaw = cleanMusicJunk(dashSplit.slice(1).join(" ").trim());
      // Extract "prod. by X" from song
      const { cleaned: song, producer } = extractProducer(songRaw);
      // Extract "(feat. X)" from song
      const fm = song.match(/\((?:feat\.?|ft\.?|with)\s+(.+?)\)\s*$/i);
      let featPeople = [];
      let finalSong = song;
      if (fm) {
        finalSong = song.replace(fm[0], "").trim();
        splitArtists(fm[1]).forEach(x => featPeople.push(x));
      }
      const people = [...artists, ...featPeople];
      if (producer) people.push(producer);
      if (people.length > 0 && finalSong) {
        return { people, song: finalSong, movie: null };
      }
    }
    return null;
  }

  // ── Has pipes ──
  // First segment: may contain song name, or "Person I Person I Song"
  const firstRaw = title.split(PIPE_RE)[0];
  const firstDashParts = firstRaw.split(/\s*[-–—]\s*/);
  let songPart = cleanMusicJunk(firstDashParts[0]).trim();
  const restParts = parts.slice(1).map(p => cleanMusicJunk(p)).filter(p => p.length > 1 && !/^\d{4}$/.test(p));

  // "Bukhaar - Bayanni | Person | Person" → song: Bukhaar, first artist: Bayanni, rest = all people (no movie)
  // But "Aaj Ki Raat - 8K Video | Stree 2 | ..." → dash is junk separator, not artist
  let dashArtist = null;
  let hasDashInFirst = false;
  if (firstDashParts.length >= 2) {
    const afterDash = cleanMusicJunk(firstDashParts.slice(1).join(" ")).trim();
    if (afterDash.length > 1) {
      // Real artist name after dash (not just junk that got cleaned away)
      hasDashInFirst = true;
      dashArtist = afterDash;
    }
    // If afterDash is empty/short after cleaning, it was junk like "8K Video" → not a real dash split
  }

  // Extract movie name from brackets: "Tip Tip (Sooryavanshi)" → song: "Tip Tip", movie: "Sooryavanshi"
  // Or from colon prefix: "KICK: Hangover" → movie: "KICK", song: "Hangover"
  let bracketMovie = null;
  const bracketMatch = songPart.match(/^(.+?)\s*\(([^)]{2,})\)\s*$/);
  if (bracketMatch) {
    songPart = bracketMatch[1].trim();
    bracketMovie = bracketMatch[2].trim();
  }

  // Check rest parts for [MovieName] in square brackets
  // "Sayeed Quadri [Bhool Bhulaiyaa] WFL" → person: "Sayeed Quadri", movie: "Bhool Bhulaiyaa"
  if (!bracketMovie) {
    for (let i = 0; i < restParts.length; i++) {
      const sqMatch = restParts[i].match(/^(.*?)\s*\[([^\]]{2,})\]\s*(.*)$/);
      if (sqMatch) {
        bracketMovie = sqMatch[2].trim();
        // Rebuild the part without the bracket
        const remaining = (sqMatch[1] + " " + sqMatch[3]).replace(/\s{2,}/g, " ").trim();
        restParts[i] = remaining.length > 1 ? remaining : "";
        break;
      }
    }
    // Filter out empty parts
    const filtered = restParts.filter(p => p.length > 1);
    restParts.length = 0;
    filtered.forEach(p => restParts.push(p));
  }
  // "KICK: Hangover" → movie: KICK, song: Hangover
  // But "AADAT (Official Video): HONEY SINGH" → colon after junk = artist separator, not movie
  const colonMatch = songPart.match(/^(.+?)\s*[:：]\s+(.+)$/);
  const originalHadJunkBeforeColon = /\(.*?\)\s*[:：]/.test(firstRaw) || /\[.*?\]\s*[:：]/.test(firstRaw);
  let colonArtist = null;
  if (!bracketMovie && colonMatch) {
    if (originalHadJunkBeforeColon) {
      // "AADAT : YO YO HONEY SINGH" → song: AADAT, colonArtist: YO YO HONEY SINGH
      songPart = colonMatch[1].trim();
      colonArtist = colonMatch[2].trim();
    } else {
      // "KICK: Hangover" → movie: KICK, song: Hangover
      bracketMovie = colonMatch[1].trim();
      songPart = colonMatch[2].trim();
    }
  }

  // If songPart itself has commas, extract people from it
  // "Main Tere Ishq Mein 2.0 Danish Alfaaz, Bohemia, Isha Malviya"
  // → song: first comma segment (may include first person), people: rest
  let extraPeople = [];
  if (colonArtist) extraPeople.push(colonArtist);
  if (dashArtist) extraPeople.push(dashArtist);

  // Extract featured artists: "(feat. Selena Gomez)", "(ft. Drake)", "(with Dua Lipa)"
  const featMatch = songPart.match(/\((?:feat\.?|ft\.?|with)\s+(.+?)\)\s*$/i);
  if (featMatch) {
    songPart = songPart.replace(featMatch[0], "").trim();
    splitArtists(featMatch[1]).forEach(a => extraPeople.push(a));
  }

  if (songPart.includes(",")) {
    const commaParts = songPart.split(",").map(p => p.trim()).filter(p => p.length > 1);
    // First part = song (may contain first person name at end, but best we can do)
    songPart = commaParts[0];
    // Rest = people
    extraPeople = commaParts.slice(1);
  }

  // Check if first segment has " I " sub-parts
  const iSplit = splitByCapitalI(songPart);
  if (iSplit && iSplit.length >= 2) {
    // Last " I " part could be the song/album name, rest are people
    // e.g. "Diljit Dosanjh I Sanya Malhotra I Charmer" → people: [Diljit, Sanya], song: Charmer
    extraPeople = [...iSplit.slice(0, -1), ...extraPeople];
    songPart = iSplit[iSplit.length - 1];
  }

  // Also check rest parts for " I " sub-splits
  const expandedRest = [];
  for (const part of restParts) {
    const sub = splitByCapitalI(part);
    if (sub) {
      sub.forEach(s => expandedRest.push(s));
    } else {
      expandedRest.push(part);
    }
  }

  // If first segment had "Song - Artist", all rest parts are people (no movie guessing)
  if (hasDashInFirst && !bracketMovie) {
    const people = [...extraPeople];
    for (const part of expandedRest) {
      if (part.includes(",")) {
        part.split(",").forEach(p => { const n = p.trim(); if (n.length > 1) people.push(n); });
      } else {
        splitArtists(part).forEach(a => people.push(a));
      }
    }
    if (people.length > 0) return { song: songPart, movie: null, people };
  }

  // If movie was found in brackets like "Song (MovieName)", all rest parts are people
  if (bracketMovie) {
    const people = [...extraPeople];
    for (const part of expandedRest) {
      if (part.includes(",")) {
        part.split(",").forEach(p => { const n = p.trim(); if (n.length > 1) people.push(n); });
      } else {
        splitArtists(part).forEach(a => people.push(a));
      }
    }
    return { song: songPart, movie: bracketMovie, people };
  }

  // If no meaningful rest parts, all extraPeople are people, no movie
  if (expandedRest.length === 0 && extraPeople.length > 0) {
    return { song: songPart, movie: null, people: extraPeople };
  }

  const hasCommaList = expandedRest.some(p => p.includes(","));

  if (hasCommaList) {
    let movie = null;
    const people = [...extraPeople];
    for (const part of expandedRest) {
      if (part.includes(",")) {
        part.split(",").forEach(p => {
          const name = p.trim();
          if (name.length > 1) people.push(name);
        });
      } else if (!movie && part.length > 1) {
        movie = part;
      }
    }
    if (people.length > 0 || movie) return { song: songPart, movie, people };
  } else {
    const allParts = [...extraPeople, ...expandedRest];

    if (allParts.length === 1) {
      const artists = splitArtists(allParts[0]);
      return { song: songPart, movie: null, people: artists };
    }

    // 3+ parts: last = movie, rest = people
    if (allParts.length >= 2) {
      const movie = allParts[allParts.length - 1];
      const people = [];
      for (let i = 0; i < allParts.length - 1; i++) {
        splitArtists(allParts[i]).forEach(a => people.push(a));
      }
      if (people.length > 0) return { song: songPart, movie, people };
    }
  }

  return null;
}

// ─── API calls ───────────────────────────────────────────
async function searchTMDb(title) {
  const cleaned = cleanTitle(title) || title;
  const res = await fetch(`${WORKER}/search?q=${encodeURIComponent(cleaned)}`);
  if (!res.ok) throw new Error(`Search failed: ${res.status}`);
  return res.json();
}

async function searchPerson(name) {
  const res = await fetch(`${WORKER}/person?q=${encodeURIComponent(name)}`);
  if (!res.ok) return null;
  return res.json();
}

async function getPersonDetails(id) {
  const res = await fetch(`${WORKER}/person/${id}`);
  if (!res.ok) return null;
  return res.json();
}

async function getMovieDetails(id) {
  const res = await fetch(`${WORKER}/movie/${id}`);
  if (!res.ok) throw new Error(`Movie details failed: ${res.status}`);
  return res.json();
}

async function getTVDetails(id) {
  const res = await fetch(`${WORKER}/tv/${id}`);
  if (!res.ok) throw new Error(`TV details failed: ${res.status}`);
  return res.json();
}

// ─── Render ──────────────────────────────────────────────
function renderLoading() {
  tmdbContent.innerHTML = `
    <div class="tmdb-loading">
      <div class="spinner"></div>
      <span>Fetching info...</span>
    </div>
  `;
}

function renderError(msg) {
  tmdbContent.innerHTML = `
    <button class="tmdb-close" id="tmdbClose">&times;</button>
    <div class="tmdb-error">
      <p>${msg || "No results found"}</p>
    </div>
  `;
  document.getElementById("tmdbClose").addEventListener("click", closePanel);
}

function renderPanel(data, type) {
  const title = data.title || data.name || "Unknown";
  const originalTitle = data.original_title || data.original_name || "";
  const overview = data.overview || "No overview available.";
  const date = data.release_date || data.first_air_date || "";
  const year = date ? date.split("-")[0] : "—";
  const rating = data.vote_average ? data.vote_average.toFixed(1) : "—";
  const votes = data.vote_count || 0;
  const runtime = data.runtime || (data.episode_run_time?.[0]) || null;
  const genres = data.genres || [];
  const backdrop = IMG("w780", data.backdrop_path);
  const poster = IMG("w342", data.poster_path);
  const cast = (data.credits?.cast || []).slice(0, 10);
  const status = data.status || "";
  const lang = (data.original_language || "").toUpperCase();
  const seasons = data.number_of_seasons;
  const episodes = data.number_of_episodes;
  const tagline = data.tagline || "";

  const showOriginal = originalTitle && originalTitle !== title;
  const typeBadge = type === "tv"
    ? `<span class="tmdb-badge type-tv">TV</span>`
    : `<span class="tmdb-badge type-movie">Movie</span>`;

  tmdbContent.innerHTML = `
    ${backdrop ? `
    <div class="tmdb-backdrop">
      <img src="${backdrop}" alt="">
      <div class="gradient"></div>
    </div>` : `<div style="height:60px"></div>`}

    <button class="tmdb-close" id="tmdbClose">&times;</button>

    <div class="tmdb-body">
      <div class="tmdb-poster-row">
        ${poster
          ? `<img src="${poster}" alt="${title}">`
          : `<div style="width:80px;height:120px;background:#111;border-radius:10px"></div>`}
        <div class="tmdb-title-block">
          <h2>${title}</h2>
          ${showOriginal ? `<div class="original-title">${originalTitle}</div>` : ""}
          <div class="tmdb-badges">
            ${typeBadge}
            <span class="tmdb-badge rating">${rating} &#9733;</span>
            <span class="tmdb-badge year">${year}</span>
          </div>
        </div>
      </div>

      ${tagline ? `<div style="font-size:11px;color:#555;font-style:italic;margin-bottom:12px">"${tagline}"</div>` : ""}

      ${genres.length ? `
      <div class="tmdb-genres">
        ${genres.map(g => `<span>${g.name}</span>`).join("")}
      </div>` : ""}

      <div class="tmdb-overview">${overview}</div>

      <div class="tmdb-stats">
        ${runtime ? `<div class="tmdb-stat"><div class="label">Runtime</div><div class="value">${runtime} min</div></div>` : ""}
        <div class="tmdb-stat"><div class="label">Rating</div><div class="value">${rating}/10 (${votes.toLocaleString()})</div></div>
        ${status ? `<div class="tmdb-stat"><div class="label">Status</div><div class="value">${status}</div></div>` : ""}
        ${lang ? `<div class="tmdb-stat"><div class="label">Language</div><div class="value">${lang}</div></div>` : ""}
        ${seasons ? `<div class="tmdb-stat"><div class="label">Seasons</div><div class="value">${seasons} (${episodes} eps)</div></div>` : ""}
        ${date ? `<div class="tmdb-stat"><div class="label">${type === "tv" ? "First Aired" : "Release"}</div><div class="value">${date}</div></div>` : ""}
      </div>

      ${cast.length ? `
      <div class="tmdb-section-title">Cast</div>
      <div class="tmdb-cast">
        ${cast.map(c => `
          <div class="tmdb-cast-item">
            ${c.profile_path
              ? `<img src="${IMG("w92", c.profile_path)}" alt="${c.name}">`
              : `<div class="no-avatar">${c.name[0]}</div>`}
            <div class="name">${c.name}</div>
            <div class="role">${c.character || ""}</div>
          </div>
        `).join("")}
      </div>` : ""}
    </div>
  `;

  document.getElementById("tmdbClose").addEventListener("click", closePanel);
}

// ─── Render: Music/People panel ─────────────────────────
function renderMusicPanel(musicInfo, people, movieData) {
  const closeBtn = `<button class="tmdb-close" id="tmdbClose">&times;</button>`;

  let movieHtml = "";
  if (movieData) {
    const backdrop = IMG("w780", movieData.backdrop_path);
    movieHtml = backdrop ? `
      <div class="tmdb-backdrop">
        <img src="${backdrop}" alt="">
        <div class="gradient"></div>
      </div>` : "";
  }

  const songTitle = musicInfo.song || "";
  const movieName = movieData ? (movieData.title || movieData.name) : (musicInfo.movie || "");

  tmdbContent.innerHTML = `
    ${movieHtml}
    ${closeBtn}

    <div class="tmdb-music-header">
      <div class="song-name">${songTitle}</div>
      ${movieName && movieData ? `<div class="movie-link" data-movie-id="${movieData.id}">from ${movieName}</div>` :
        movieName ? `<div style="font-size:11px;color:#555">from ${movieName}</div>` : ""}
    </div>

    <div class="tmdb-section-title" style="padding:0 16px">People</div>
    <div class="tmdb-people-grid">
      ${people.map(p => `
        <div class="tmdb-person-card" data-person-id="${p.id}">
          ${p.profile_path
            ? `<img src="${IMG("w92", p.profile_path)}" alt="${p.name}">`
            : `<div class="no-avatar">${p.name[0]}</div>`}
          <div class="person-info">
            <div class="person-name">${p.name}</div>
            <div class="person-dept">${p.known_for_department || ""}</div>
            <div class="person-known">${(p.known_for || []).map(k => k.title || k.name).filter(Boolean).slice(0, 3).join(", ")}</div>
          </div>
        </div>
      `).join("")}
    </div>
  `;

  document.getElementById("tmdbClose").addEventListener("click", closePanel);

  // Click person → show details
  tmdbContent.querySelectorAll(".tmdb-person-card").forEach(card => {
    card.addEventListener("click", () => {
      const id = card.dataset.personId;
      if (id) showPersonDetail(id, musicInfo, people, movieData);
    });
  });

  // Click movie link → show movie panel
  const movieLink = tmdbContent.querySelector(".movie-link[data-movie-id]");
  if (movieLink) {
    movieLink.addEventListener("click", async () => {
      renderLoading();
      const details = await getMovieDetails(movieLink.dataset.movieId);
      tmdbData = details;
      renderPanel(details, "movie");
    });
  }
}

async function showPersonDetail(id, musicInfo, people, movieData) {
  renderLoading();
  const person = await getPersonDetails(id);
  if (!person) { renderError("Could not load person info"); return; }

  const photo = IMG("w342", person.profile_path);
  const credits = (person.combined_credits?.cast || [])
    .sort((a, b) => (b.vote_count || 0) - (a.vote_count || 0))
    .slice(0, 12);

  tmdbContent.innerHTML = `
    <button class="tmdb-close" id="tmdbClose">&times;</button>
    <div class="tmdb-person-detail">
      <button class="tmdb-back-btn" id="tmdbBackBtn">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
        Back
      </button>

      <div class="tmdb-person-hero">
        ${photo
          ? `<img src="${photo}" alt="${person.name}">`
          : `<div class="no-avatar">${person.name[0]}</div>`}
        <h2>${person.name}</h2>
        <div class="dept">${person.known_for_department || ""}</div>
      </div>

      <div class="tmdb-stats">
        ${person.birthday ? `<div class="tmdb-stat"><div class="label">Born</div><div class="value">${person.birthday}</div></div>` : ""}
        ${person.place_of_birth ? `<div class="tmdb-stat"><div class="label">Place</div><div class="value">${person.place_of_birth}</div></div>` : ""}
      </div>

      ${person.biography ? `<div class="tmdb-person-bio">${person.biography}</div>` : ""}

      ${credits.length ? `
      <div class="tmdb-section-title">Known For</div>
      <div class="tmdb-filmography">
        ${credits.map(c => `
          <div class="tmdb-film-item">
            ${c.poster_path
              ? `<img src="${IMG("w92", c.poster_path)}" alt="${c.title || c.name}">`
              : `<div style="width:34px;height:50px;background:#111;border-radius:6px;flex-shrink:0"></div>`}
            <div class="film-info">
              <div class="film-title">${c.title || c.name}</div>
              <div class="film-meta">${c.character ? `as ${c.character}` : ""} ${c.release_date?.split("-")[0] || c.first_air_date?.split("-")[0] || ""}</div>
            </div>
            ${c.vote_average ? `<div class="film-rating">${c.vote_average.toFixed(1)} &#9733;</div>` : ""}
          </div>
        `).join("")}
      </div>` : ""}
    </div>
  `;

  document.getElementById("tmdbClose").addEventListener("click", closePanel);
  document.getElementById("tmdbBackBtn").addEventListener("click", () => {
    renderMusicPanel(musicInfo, people, movieData);
  });
}

// ─── Panel toggle ────────────────────────────────────────
function openPanel() {
  panelOpen = true;
  tmdbPanel.classList.add("open");
}

function closePanel() {
  panelOpen = false;
  tmdbPanel.classList.remove("open");
}

tmdbToggle.addEventListener("click", () => {
  if (panelOpen) {
    closePanel();
  } else {
    openPanel();
    if (!tmdbData) fetchAndRender();
  }
});

// Close on Escape
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && panelOpen) closePanel();
});

// ─── Fetch and render ────────────────────────────────────
async function fetchAndRender() {
  const title = getVideoTitle();
  if (!title) {
    renderError("Could not detect video title");
    return;
  }

  renderLoading();

  try {
    // Check if this looks like a music video title
    const musicInfo = parseMusicTitle(title);

    if (musicInfo && musicInfo.people.length > 0) {
      // Music video mode: search for people
      const peopleResults = await Promise.all(
        musicInfo.people.slice(0, 6).map(name => searchPerson(name))
      );

      const people = peopleResults
        .filter(r => r?.results?.length > 0)
        .map(r => r.results[0]);

      // Also search for the movie if mentioned
      let movieData = null;
      if (musicInfo.movie) {
        const movieSearch = await searchTMDb(musicInfo.movie);
        if (movieSearch.results?.length > 0) {
          movieData = await getMovieDetails(movieSearch.results[0].id);
        }
      }

      if (people.length > 0) {
        tmdbData = { musicInfo, people, movieData };
        renderMusicPanel(musicInfo, people, movieData);
        return;
      }
      // Fall through to movie/TV search if no people found
    }

    // Movie/TV mode
    const searchResult = await searchTMDb(title);

    let type = searchResult.type || "movie";
    let item = null;

    if (type === "tv" && searchResult.show) {
      item = searchResult.show;
    } else if (searchResult.results?.length > 0) {
      item = searchResult.results[0];
    }

    if (!item) {
      renderError(`No results for "${title}"`);
      return;
    }

    // Fetch full details
    let details;
    if (type === "tv") {
      details = await getTVDetails(item.id);
    } else {
      details = await getMovieDetails(item.id);
    }

    tmdbData = details;
    renderPanel(details, type);
  } catch (err) {
    console.error("[TMDb]", err);
    renderError("Failed to fetch info");
  }
}

// ─── Auto-init: show toggle once video loads ─────────────
customElements.whenDefined("movi-player").then(() => {
  const player = document.getElementById("player");
  player.addEventListener("loadeddata", () => {
    tmdbToggle.classList.add("visible");
  });

  // Also show if video is already loaded (URL mode)
  if (player.src) {
    tmdbToggle.classList.add("visible");
  }
});

// Show toggle immediately if URL param present
if (new URLSearchParams(window.location.search).get("url")) {
  tmdbToggle.classList.add("visible");
}
