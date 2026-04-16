const TMDB_BASE = "https://api.themoviedb.org/3";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const ROUTES = {
  "/search": "auto-detect movie/tv from query (S02E01, Season 2, etc.)",
  "/movie/:id": "movie details with credits, videos, images",
  "/tv/:id": "tv show details",
  "/tv/:id/season/:n": "season details with episodes",
  "/tv/:id/season/:n/episode/:e": "episode details",
  "/person?q=name": "search person by name",
  "/person/:id": "person details with credits and images",
  "/trending": "trending movies this week",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function parseQuery(input) {
  const match = input.match(/^(.+?)\s+((?:19|20)\d{2})$/);
  if (match) return { query: match[1].trim(), year: match[2] };
  return { query: input.trim(), year: null };
}

// Parse TV series queries - all common formats
// S02E01, S2E1, Season 2 Episode 1, S02, Season 2, 2x01, etc.
function parseSeriesQuery(input) {
  const patterns = [
    // S02E01, S2E1, s02e01
    /^(.+?)\s*S(\d{1,2})E(\d{1,3})$/i,
    // S02 EP01, S2 EP1
    /^(.+?)\s*S(\d{1,2})\s*EP(\d{1,3})$/i,
    // 2x01, 02x01
    /^(.+?)\s*(\d{1,2})x(\d{1,3})$/i,
    // Season 2 Episode 1, Season 2 Ep 1
    /^(.+?)\s*Season\s*(\d+)\s*(?:Episode|Ep\.?)\s*(\d+)$/i,
  ];

  for (const pattern of patterns) {
    const m = input.match(pattern);
    if (m) {
      return { title: m[1].trim(), season: parseInt(m[2]), episode: parseInt(m[3]) };
    }
  }

  // Season only: S02, Season 2
  const seasonOnly = [
    /^(.+?)\s*S(\d{1,2})$/i,
    /^(.+?)\s*Season\s*(\d+)$/i,
  ];

  for (const pattern of seasonOnly) {
    const m = input.match(pattern);
    if (m) {
      return { title: m[1].trim(), season: parseInt(m[2]), episode: null };
    }
  }

  return null;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (request.method !== "GET") {
      return json({ error: "Method not allowed" }, 405);
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Health check
    if (path === "/") {
      return json({ status: "ok", routes: Object.keys(ROUTES) });
    }

    // --- /search?q=Maamla Legal Hai S02E01 ---
    // Auto-detects movie vs TV from query format
    if (path === "/search") {
      const q = url.searchParams.get("q");
      if (!q) return json({ error: "q parameter required" }, 400);

      const page = url.searchParams.get("page") || "1";
      const lang = url.searchParams.get("lang") || "en-US";
      const headers = { Authorization: `Bearer ${env.TMDB_ACCESS_TOKEN}` };

      const series = parseSeriesQuery(q);

      // TV show detected
      if (series) {
        // Search for the show
        const searchRes = await fetch(
          `${TMDB_BASE}/search/tv?query=${encodeURIComponent(series.title)}&page=${page}&language=${lang}`,
          { headers },
        );
        const searchData = await searchRes.json();

        if (searchData.results?.length > 0) {
          const show = searchData.results[0];

          // Fetch episode details if episode specified
          if (series.episode !== null) {
            const epRes = await fetch(
              `${TMDB_BASE}/tv/${show.id}/season/${series.season}/episode/${series.episode}?language=${lang}`,
              { headers },
            );
            const epData = await epRes.json();
            return json({ type: "tv", show, season: series.season, episode: epData });
          }

          // Fetch season details if only season specified
          const seasonRes = await fetch(
            `${TMDB_BASE}/tv/${show.id}/season/${series.season}?language=${lang}`,
            { headers },
          );
          const seasonData = await seasonRes.json();
          return json({ type: "tv", show, season_details: seasonData });
        }

        return json({ type: "tv", results: searchData.results, total_results: 0 });
      }

      // Movie search with year parsing
      const { query, year } = parseQuery(q);

      let tmdbUrl = `${TMDB_BASE}/search/movie?query=${encodeURIComponent(query)}&page=${page}&language=${lang}`;
      if (year) tmdbUrl += `&year=${year}`;

      const res = await fetch(tmdbUrl, { headers });
      const data = await res.json();

      // Fallback: agar year se result nahi mila, bina year ke retry
      if (year && data.results?.length === 0) {
        const retryRes = await fetch(
          `${TMDB_BASE}/search/movie?query=${encodeURIComponent(q)}&page=${page}&language=${lang}`,
          { headers },
        );
        return json({ type: "movie", ...(await retryRes.json()) });
      }

      return json({ type: "movie", ...data });
    }

    // --- /movie/123 ---
    if (path.startsWith("/movie/")) {
      const id = path.split("/")[2];
      if (!id) return json({ error: "movie id required" }, 400);

      const lang = url.searchParams.get("lang") || "en-US";
      const append = url.searchParams.get("append") || "credits,videos,images";

      const res = await fetch(
        `${TMDB_BASE}/movie/${id}?language=${lang}&append_to_response=${append}`,
        { headers: { Authorization: `Bearer ${env.TMDB_ACCESS_TOKEN}` } },
      );
      return json(await res.json());
    }

    // --- /tv/123 or /tv/123/season/2 or /tv/123/season/2/episode/1 ---
    if (path.startsWith("/tv/")) {
      const parts = path.split("/").filter(Boolean); // ["tv", "123", "season", "2", ...]
      const id = parts[1];
      if (!id) return json({ error: "tv id required" }, 400);

      const lang = url.searchParams.get("lang") || "en-US";
      const headers = { Authorization: `Bearer ${env.TMDB_ACCESS_TOKEN}` };

      // /tv/123/season/2/episode/1
      if (parts[2] === "season" && parts[4] === "episode") {
        const res = await fetch(
          `${TMDB_BASE}/tv/${id}/season/${parts[3]}/episode/${parts[5]}?language=${lang}`,
          { headers },
        );
        return json(await res.json());
      }

      // /tv/123/season/2
      if (parts[2] === "season") {
        const res = await fetch(
          `${TMDB_BASE}/tv/${id}/season/${parts[3]}?language=${lang}`,
          { headers },
        );
        return json(await res.json());
      }

      // /tv/123
      const append = url.searchParams.get("append") || "credits,videos,images";
      const res = await fetch(
        `${TMDB_BASE}/tv/${id}?language=${lang}&append_to_response=${append}`,
        { headers },
      );
      return json(await res.json());
    }

    // --- /person?q=Honey Singh ---
    if (path === "/person") {
      const q = url.searchParams.get("q");
      if (!q) return json({ error: "q parameter required" }, 400);

      const lang = url.searchParams.get("lang") || "en-US";
      const res = await fetch(
        `${TMDB_BASE}/search/person?query=${encodeURIComponent(q)}&language=${lang}`,
        { headers: { Authorization: `Bearer ${env.TMDB_ACCESS_TOKEN}` } },
      );
      return json(await res.json());
    }

    // --- /person/123 --- (person details)
    if (path.match(/^\/person\/\d+$/)) {
      const id = path.split("/")[2];
      const lang = url.searchParams.get("lang") || "en-US";
      const append = url.searchParams.get("append") || "combined_credits,images";

      const res = await fetch(
        `${TMDB_BASE}/person/${id}?language=${lang}&append_to_response=${append}`,
        { headers: { Authorization: `Bearer ${env.TMDB_ACCESS_TOKEN}` } },
      );
      return json(await res.json());
    }

    // --- /img/w780/abc123.jpg --- (image proxy for COEP)
    if (path.startsWith("/img/")) {
      // path: /img/w780/abc123.jpg → tmdb: /t/p/w780/abc123.jpg
      const imgPath = path.replace("/img/", "");
      const imgRes = await fetch(`https://image.tmdb.org/t/p/${imgPath}`);
      if (!imgRes.ok) return new Response("Not found", { status: 404 });

      return new Response(imgRes.body, {
        headers: {
          "Content-Type": imgRes.headers.get("Content-Type") || "image/jpeg",
          "Cache-Control": "public, max-age=604800",
          "Cross-Origin-Resource-Policy": "cross-origin",
          ...CORS_HEADERS,
        },
      });
    }

    // --- /trending ---
    if (path === "/trending") {
      const page = url.searchParams.get("page") || "1";
      const lang = url.searchParams.get("lang") || "en-US";

      const res = await fetch(
        `${TMDB_BASE}/trending/movie/week?page=${page}&language=${lang}`,
        { headers: { Authorization: `Bearer ${env.TMDB_ACCESS_TOKEN}` } },
      );
      return json(await res.json());
    }

    return json({ error: "Not found" }, 404);
  },
};
