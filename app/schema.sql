-- D1 schema for the visitor feedback wall on moviplayer.com.
--
-- Apply it once per environment:
--   wrangler d1 execute movi-comments --file=./schema.sql --local    # dev
--   wrangler d1 execute movi-comments --file=./schema.sql --remote   # prod
--
-- Comments go live the moment they're posted (no approval queue), so the
-- spam/abuse gate is entirely server-side: Turnstile + the profanity filter
-- + the per-IP rate limit in worker.js. `hidden` exists so a bad comment that
-- slips through can be taken down without losing the row (soft delete via
-- DELETE /api/comments?id=N with the admin token).

CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  body       TEXT    NOT NULL,
  -- Optional 1–5 star rating. NULL when the visitor left only text.
  rating     INTEGER,
  -- SHA-256(ip + ENC_SERVER_SECRET), truncated. We never store the raw IP —
  -- the hash is only used for rate limiting, and the secret keeps it from
  -- being reversed by brute-forcing the (small) IPv4 space.
  ip_hash    TEXT    NOT NULL,
  -- Epoch milliseconds.
  created_at INTEGER NOT NULL,
  hidden     INTEGER NOT NULL DEFAULT 0,
  -- NULL for a visitor's own comment; the id of the comment this answers
  -- otherwise. Only the maintainer can reply (POST carries the admin token),
  -- so the wall stays one level deep — a thread, not a forum.
  parent_id  INTEGER REFERENCES comments (id),
  -- 'visitor' | 'maintainer'. Kept explicit rather than inferred from
  -- parent_id: "a reply must be from the maintainer" is true today only
  -- because nothing else can write one, and that is not a rule worth hiding
  -- inside a column that means something else.
  author_role TEXT NOT NULL DEFAULT 'visitor'
);

-- Existing deployments predate the two columns above; CREATE TABLE IF NOT
-- EXISTS will not add them. Run once per environment, ignoring the error if
-- it has already been applied:
--
--   wrangler d1 execute movi-comments --remote \
--     --command "ALTER TABLE comments ADD COLUMN parent_id INTEGER REFERENCES comments (id)"
--   wrangler d1 execute movi-comments --remote \
--     --command "ALTER TABLE comments ADD COLUMN author_role TEXT NOT NULL DEFAULT 'visitor'"

-- Listing query: WHERE hidden = 0 [AND id < ?] ORDER BY id DESC. Paging on
-- the rowid rather than created_at keeps the cursor unique and lets this
-- index satisfy the ORDER BY without a sort step.
CREATE INDEX IF NOT EXISTS idx_comments_visible
  ON comments (hidden, id DESC);

-- Rate-limit query: WHERE ip_hash = ? AND created_at > ?.
CREATE INDEX IF NOT EXISTS idx_comments_ip
  ON comments (ip_hash, created_at DESC);

-- Replies for the page being shown: WHERE parent_id IN (…) AND hidden = 0.
CREATE INDEX IF NOT EXISTS idx_comments_parent
  ON comments (parent_id, id);

-- ─── Profanity / abuse term list ──────────────────────────────────────
--
-- The blocklist lives here rather than in worker.js so terms can be added
-- or retired without a redeploy:
--
--   wrangler d1 execute movi-comments --remote \
--     --command "INSERT OR IGNORE INTO profanity_terms (term, kind) VALUES ('newterm','word')"
--   wrangler d1 execute movi-comments --remote \
--     --command "UPDATE profanity_terms SET active = 0 WHERE term = 'oops'"
--
-- The worker caches the list in-isolate for 5 minutes, so a change takes
-- up to that long to reach every edge location.
--
-- `kind` decides how the term is matched — getting this wrong is how you
-- ship a false positive:
--
--   word    Letter-bounded match. "cock" won't fire inside "cocktail".
--           The default; use it unless you have a reason not to. Latin
--           entries need every inflection spelled out ("fuck", "fucking",
--           …) — a fuzzy suffix would make "ass" match "asset".
--           Devanagari entries land here too: JS word boundaries are
--           ASCII-only, so they end up matching as substrings anyway,
--           which is safe for scripts where they can't hide inside an
--           innocent word.
--
--   phrase  Substring match on the normalized text, for multi-word abuse
--           a single token can't see ("teri maa", "kill yourself").
--
--   strong  Substring match on the text with ALL separators stripped, so
--           "m.a.d.a.r.c.h.o.d" and "b_h_o_s_d_i_k_e" are caught. Only
--           for terms ≥6 chars that can never appear inside an ordinary
--           word — stripping separators also strips the boundaries that
--           make short entries safe. "rapist" does NOT belong here
--           ("therapist"), nor does "cunt" ("Scunthorpe").
--
-- Terms must be lowercase and already normalized (no accents, no leet
-- characters) — the worker folds incoming text into that form before
-- matching, so an entry like "Sh1t" would never match anything.

CREATE TABLE IF NOT EXISTS profanity_terms (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  term   TEXT    NOT NULL,
  kind   TEXT    NOT NULL CHECK (kind IN ('word', 'phrase', 'strong')),
  -- Soft-disable rather than DELETE, so a term retired by mistake can be
  -- switched back on and the history of what was blocked survives.
  active INTEGER NOT NULL DEFAULT 1
);

-- One row per (term, kind): the same string can legitimately appear as
-- both a `word` and a `strong` entry, but not twice as either. Also what
-- makes the INSERT OR IGNORE seed below re-runnable.
CREATE UNIQUE INDEX IF NOT EXISTS idx_profanity_term
  ON profanity_terms (term, kind);

-- Load query: WHERE active = 1.
CREATE INDEX IF NOT EXISTS idx_profanity_active
  ON profanity_terms (active);

INSERT OR IGNORE INTO profanity_terms (term, kind) VALUES
  ('fuck', 'word'),
  ('fucks', 'word'),
  ('fucked', 'word'),
  ('fucker', 'word'),
  ('fuckers', 'word'),
  ('fucking', 'word'),
  ('fuckin', 'word'),
  ('fck', 'word'),
  ('fuk', 'word'),
  ('fuq', 'word'),
  ('stfu', 'word'),
  ('wtf', 'word'),
  ('motherfucker', 'word'),
  ('motherfucking', 'word'),
  ('mofo', 'word'),
  ('shit', 'word'),
  ('shits', 'word'),
  ('shitty', 'word'),
  ('shithead', 'word'),
  ('bullshit', 'word'),
  ('dogshit', 'word'),
  ('bitch', 'word'),
  ('bitches', 'word'),
  ('bitchy', 'word'),
  ('sob', 'word'),
  ('bastard', 'word'),
  ('bastards', 'word'),
  ('asshole', 'word'),
  ('assholes', 'word'),
  ('arsehole', 'word'),
  ('dumbass', 'word'),
  ('jackass', 'word'),
  ('fatass', 'word'),
  ('ass', 'word'),
  ('arse', 'word'),
  ('asses', 'word'),
  ('cunt', 'word'),
  ('cunts', 'word'),
  ('twat', 'word'),
  ('twats', 'word');

INSERT OR IGNORE INTO profanity_terms (term, kind) VALUES
  ('dick', 'word'),
  ('dicks', 'word'),
  ('dickhead', 'word'),
  ('prick', 'word'),
  ('pricks', 'word'),
  ('cock', 'word'),
  ('cocks', 'word'),
  ('wanker', 'word'),
  ('wankers', 'word'),
  ('bollocks', 'word'),
  ('bugger', 'word'),
  ('whore', 'word'),
  ('whores', 'word'),
  ('slut', 'word'),
  ('sluts', 'word'),
  ('hoe', 'word'),
  ('hoes', 'word'),
  ('pussy', 'word'),
  ('pussies', 'word'),
  ('piss', 'word'),
  ('pissed', 'word'),
  ('pissoff', 'word'),
  ('cumming', 'word'),
  ('cumshot', 'word'),
  ('cumslut', 'word'),
  ('jizz', 'word'),
  ('wank', 'word'),
  ('jerkoff', 'word'),
  ('blowjob', 'word'),
  ('handjob', 'word'),
  ('deepthroat', 'word'),
  ('gangbang', 'word'),
  ('creampie', 'word'),
  ('boobs', 'word'),
  ('tits', 'word'),
  ('titties', 'word'),
  ('milf', 'word'),
  ('dildo', 'word'),
  ('buttplug', 'word'),
  ('porn', 'word');

INSERT OR IGNORE INTO profanity_terms (term, kind) VALUES
  ('porno', 'word'),
  ('pornhub', 'word'),
  ('xnxx', 'word'),
  ('xvideos', 'word'),
  ('hentai', 'word'),
  ('nudes', 'word'),
  ('horny', 'word'),
  ('orgasm', 'word'),
  ('masturbate', 'word'),
  ('masturbating', 'word'),
  ('anal', 'word'),
  ('rape', 'word'),
  ('raped', 'word'),
  ('rapist', 'word'),
  ('molest', 'word'),
  ('pedo', 'word'),
  ('paedo', 'word'),
  ('pedophile', 'word'),
  ('incest', 'word'),
  ('bestiality', 'word'),
  ('nigger', 'word'),
  ('niggers', 'word'),
  ('nigga', 'word'),
  ('niggas', 'word'),
  ('negro', 'word'),
  ('faggot', 'word'),
  ('faggots', 'word'),
  ('fag', 'word'),
  ('fags', 'word'),
  ('dyke', 'word'),
  ('tranny', 'word'),
  ('chink', 'word'),
  ('spic', 'word'),
  ('wetback', 'word'),
  ('kike', 'word'),
  ('gook', 'word'),
  ('raghead', 'word'),
  ('towelhead', 'word'),
  ('retard', 'word'),
  ('retards', 'word');

INSERT OR IGNORE INTO profanity_terms (term, kind) VALUES
  ('retarded', 'word'),
  ('spastic', 'word'),
  ('kys', 'word'),
  ('killyourself', 'word'),
  ('scumbag', 'word'),
  ('douchebag', 'word'),
  ('dumbfuck', 'word'),
  ('clusterfuck', 'word'),
  ('madarchod', 'word'),
  ('madarchood', 'word'),
  ('madharchod', 'word'),
  ('maderchod', 'word'),
  ('madrchod', 'word'),
  ('behenchod', 'word'),
  ('bhenchod', 'word'),
  ('behanchod', 'word'),
  ('bahanchod', 'word'),
  ('bhenchodh', 'word'),
  ('bsdk', 'word'),
  ('mkc', 'word'),
  ('mkb', 'word'),
  ('bhosdike', 'word'),
  ('bhosadike', 'word'),
  ('bhosdiwale', 'word'),
  ('bhosdi', 'word'),
  ('bhosda', 'word'),
  ('bhosad', 'word'),
  ('chutiya', 'word'),
  ('chutiye', 'word'),
  ('chutiyapa', 'word'),
  ('chutia', 'word'),
  ('chutiyo', 'word'),
  ('chuttiya', 'word'),
  ('chut', 'word'),
  ('chuth', 'word'),
  ('chutt', 'word'),
  ('lund', 'word'),
  ('lauda', 'word'),
  ('lawda', 'word'),
  ('loda', 'word');

INSERT OR IGNORE INTO profanity_terms (term, kind) VALUES
  ('lodu', 'word'),
  ('launda', 'word'),
  ('gaand', 'word'),
  ('gand', 'word'),
  ('gaandu', 'word'),
  ('gandu', 'word'),
  ('gandmasti', 'word'),
  ('gaandfat', 'word'),
  ('harami', 'word'),
  ('haramzada', 'word'),
  ('haramzade', 'word'),
  ('haramkhor', 'word'),
  ('randi', 'word'),
  ('raand', 'word'),
  ('rundi', 'word'),
  ('chinal', 'word'),
  ('chinaal', 'word'),
  ('bhadwa', 'word'),
  ('bhadve', 'word'),
  ('bhadua', 'word'),
  ('dalla', 'word'),
  ('dalal', 'word'),
  ('chod', 'word'),
  ('chodu', 'word'),
  ('chodo', 'word'),
  ('chudai', 'word'),
  ('chudwa', 'word'),
  ('chuda', 'word'),
  ('chodne', 'word'),
  ('jhant', 'word'),
  ('jhaant', 'word'),
  ('jhatu', 'word'),
  ('jhaatu', 'word'),
  ('tatti', 'word'),
  ('tatty', 'word'),
  ('kamina', 'word'),
  ('kamine', 'word'),
  ('kaminey', 'word'),
  ('hijra', 'word'),
  ('khusra', 'word');

INSERT OR IGNORE INTO profanity_terms (term, kind) VALUES
  ('bakchod', 'word'),
  ('bakchodi', 'word'),
  ('bakwas', 'word'),
  ('gadha', 'word'),
  ('ullu', 'word'),
  ('nalayak', 'word'),
  ('badtameez', 'word'),
  ('kutta', 'word'),
  ('kutte', 'word'),
  ('kutiya', 'word'),
  ('suar', 'word'),
  ('suvar', 'word'),
  ('maderjaat', 'word'),
  ('maaki', 'word'),
  ('मादरचोद', 'word'),
  ('मादरचोत', 'word'),
  ('बहनचोद', 'word'),
  ('भेनचोद', 'word'),
  ('बेहनचोद', 'word'),
  ('भोसडी', 'word'),
  ('भोसड़ी', 'word'),
  ('भोसडीके', 'word'),
  ('भोसड़ीके', 'word'),
  ('भोसदी', 'word'),
  ('चूतिया', 'word'),
  ('चुतिया', 'word'),
  ('चूतिये', 'word'),
  ('चूत', 'word'),
  ('चुत', 'word'),
  ('लंड', 'word'),
  ('लौड़ा', 'word'),
  ('लौडा', 'word'),
  ('लोडा', 'word'),
  ('गांड', 'word'),
  ('गाण्ड', 'word'),
  ('गांडू', 'word'),
  ('गंदू', 'word'),
  ('हरामी', 'word'),
  ('हरामखोर', 'word'),
  ('हरामज़ादा', 'word');

INSERT OR IGNORE INTO profanity_terms (term, kind) VALUES
  ('हरामजादा', 'word'),
  ('रंडी', 'word'),
  ('रांड', 'word'),
  ('भड़वा', 'word'),
  ('भडवा', 'word'),
  ('चोद', 'word'),
  ('चुदाई', 'word'),
  ('चोदू', 'word'),
  ('झांट', 'word'),
  ('झाँट', 'word'),
  ('टट्टी', 'word'),
  ('कमीना', 'word'),
  ('कमीने', 'word'),
  ('कुत्ती', 'word'),
  ('teri maa', 'phrase'),
  ('tere maa', 'phrase'),
  ('teri ma', 'phrase'),
  ('maa ki', 'phrase'),
  ('ma ki', 'phrase'),
  ('maa chuda', 'phrase'),
  ('teri behen', 'phrase'),
  ('teri bahan', 'phrase'),
  ('behen ki', 'phrase'),
  ('bahan ki', 'phrase'),
  ('teri gand', 'phrase'),
  ('teri gaand', 'phrase'),
  ('gaand mar', 'phrase'),
  ('gand mar', 'phrase'),
  ('tere baap', 'phrase'),
  ('teri aukat', 'phrase'),
  ('your mom', 'phrase'),
  ('ur mom', 'phrase'),
  ('yo mama', 'phrase'),
  ('kill yourself', 'phrase'),
  ('go die', 'phrase'),
  ('shut up loser', 'phrase'),
  ('तेरी माँ', 'phrase'),
  ('तेरी मां', 'phrase'),
  ('तेरी बहन', 'phrase'),
  ('माँ की', 'phrase');

INSERT OR IGNORE INTO profanity_terms (term, kind) VALUES
  ('मां की', 'phrase'),
  ('madarchod', 'strong'),
  ('madharchod', 'strong'),
  ('behenchod', 'strong'),
  ('bhenchod', 'strong'),
  ('bhosdike', 'strong'),
  ('bhosadike', 'strong'),
  ('chutiya', 'strong'),
  ('chutiye', 'strong'),
  ('gaandu', 'strong'),
  ('haramzada', 'strong'),
  ('haramkhor', 'strong'),
  ('motherfuck', 'strong'),
  ('fuckyou', 'strong'),
  ('fucking', 'strong'),
  ('asshole', 'strong'),
  ('bullshit', 'strong'),
  ('bastard', 'strong'),
  ('nigger', 'strong'),
  ('faggot', 'strong'),
  ('pornhub', 'strong'),
  ('blowjob', 'strong'),
  ('gangbang', 'strong'),
  ('masturbat', 'strong'),
  ('pedophile', 'strong');
