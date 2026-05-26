# Curator — Design Doc

A browser-based playlist builder that ingests local music files or song lists, enriches them via an open music database, matches them against Spotify, and creates Spotify playlists in a chosen order.

---

## 1. Goals & Non-Goals

**Goals**
- Turn a folder of music files or a plain-text song list into a curated, reorderable playlist.
- Enrich incomplete metadata using a free, open music database.
- Surface Spotify availability per track and let the user create/replace playlists in Spotify.
- Let the user import an existing Spotify playlist back into the builder for editing/remixing.

**Non-Goals**
- Audio fingerprinting (AcoustID) — defer to v2. v1 uses filename + ID3 + fuzzy string match.
- Uploading audio anywhere — local files never leave the browser.
- Other streaming providers (Apple Music, Tidal, YouTube Music) — Spotify only in v1.
- Multi-user / shared playlists with collaborators — single-user, single-device.

---

## 2. Tech Stack & Key Decisions

| Concern | Choice | Why |
|---|---|---|
| App shape | **Pure SPA** (no backend) | Spotify OAuth supports PKCE for SPAs; MusicBrainz needs no key; local files never leave the device. No server = no hosting cost, no auth secrets to manage. |
| Framework | **React + TypeScript + Vite** | Standard, fast HMR, ecosystem support for the libraries below. |
| State | **Zustand** | Less boilerplate than Redux; selectors avoid re-render storms when a 500-item playlist mutates. |
| Drag & drop | **@dnd-kit/core** | A11y-friendly, virtualization-compatible, actively maintained (vs. react-beautiful-dnd which is unmaintained). |
| ID3/metadata | **music-metadata-browser** | Parses ID3v1/v2, Vorbis (FLAC/OGG), MP4 atoms, ASF (WMA). Pure JS, no WASM. |
| Fuzzy matching | **Fuse.js** | Weighted multi-field scoring; small footprint. |
| HTTP | **fetch + a small queued client** | Need request queueing for MusicBrainz's 1-req/sec rate limit. |
| Persistence | **IndexedDB (via `idb`)** for MB cache + draft playlists; **sessionStorage** for Spotify tokens | Tokens in sessionStorage limit XSS blast radius; cached lookups in IDB so re-imports are instant. |
| Styling | **Tailwind CSS** | Fastest path to a dense, table-like UI. |
| Testing | **Vitest + React Testing Library + Playwright** | Vitest matches Vite; Playwright for the drag-drop flows that unit tests can't cover. |

**Alternatives considered:**
- *Tauri/Electron* desktop app — would unlock direct filesystem access without prompts. Skipped for v1 because the browser File System Access API and drag-drop are sufficient and deployment is trivial.
- *Thin backend (Cloudflare Worker)* — would let us hide a Spotify client secret and act as an MB proxy with shared caching. Not needed for v1; revisit if MB rate limits bite or if we want server-side credential storage across devices.
- *Last.fm / Discogs* for enrichment — both require API keys. MusicBrainz is keyless and has the best canonical metadata.

---

## 3. Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Browser (SPA)                                               │
│                                                              │
│  ┌────────────┐   ┌──────────────┐   ┌───────────────────┐   │
│  │  Ingest    │──▶│  Playlist    │──▶│  Spotify Adapter  │   │
│  │  (drop /   │   │  Store       │   │  (PKCE OAuth,     │   │
│  │   pick)    │   │  (Zustand)   │   │   search, create) │   │
│  └────────────┘   └──────────────┘   └───────────────────┘   │
│        │                  ▲                    ▲             │
│        ▼                  │                    │             │
│  ┌────────────┐   ┌──────────────┐             │             │
│  │  Metadata  │──▶│  Enrichment  │             │             │
│  │  Parser    │   │  (MusicBrainz│             │             │
│  │  (ID3 etc.)│   │   + Fuse.js) │             │             │
│  └────────────┘   └──────────────┘             │             │
│                          │                     │             │
│                          ▼                     │             │
│                   ┌──────────────┐             │             │
│                   │  IndexedDB   │◀────────────┘             │
│                   │  (cache,     │                           │
│                   │   drafts)    │                           │
│                   └──────────────┘                           │
└──────────────────────────────────────────────────────────────┘
            │                                  │
            ▼                                  ▼
   musicbrainz.org/ws/2          accounts.spotify.com + api.spotify.com
   (1 req/sec, no key)           (PKCE OAuth, user token)
```

**Module boundaries**
- `ingest/` — drag-drop handlers, File System Access API wrappers, text-file parser, recursive folder walker.
- `metadata/` — `music-metadata-browser` wrapper, normalizers (strip "(Remastered)", "feat.", whitespace).
- `enrichment/` — MusicBrainz client with rate-limit queue, Fuse-based candidate scorer, cache layer.
- `spotify/` — PKCE flow, token refresh, search, playlist CRUD.
- `store/` — Zustand slices: `tracks`, `enrichment`, `spotify`, `settings`.
- `ui/` — table view, sort/reorder, settings panel, playlist sidebar.

---

## 4. Feature Specifications

### 4.1 Ingest (req §1)

**Drop target**: full-window overlay activated on `dragenter`. Accepts:
- One or more **files** — `.txt`, `.m3u`/`.m3u8`, or audio files (`.mp3 .flac .m4a .ogg .opus .wav .aac .wma`).
- One or more **folders** — walked recursively if the recursion toggle is on (default **true**); otherwise only direct children.
- **Multiple folders in a single drop** — each top-level folder becomes a root in the BFS walk; every audio file found across all roots is added to the same active playlist in drop order. This is the recommended way to combine libraries from several locations.

**Implementation**:
- Use `DataTransferItem.webkitGetAsEntry()` for the drop path; this is the only cross-browser way to detect folders inside a drop. Walk with a queue-based BFS so the call stack doesn't blow up on deep trees, and seed the queue with every dropped root so multi-folder drops work without special handling.
- For users who prefer a picker, also expose a button that calls `window.showDirectoryPicker()` (File System Access API, Chromium-only) with a fallback to `<input type="file" webkitdirectory>`. The picker is single-folder per click in both browsers; to ingest multiple folders via picker, click it once per folder — each invocation appends to the current playlist and is independently undoable.

**Text-file parsing** (§1a):
- Read as UTF-8, normalize line endings, split on `\n`, drop empty lines and lines starting with `#`.
- Each line becomes a `Track` with `rawTitle = line` and everything else empty — enrichment will fill in the rest.
- Best-effort split on ` - ` heuristic: if a line matches `Artist - Title` or `Artist - Album - Title`, pre-populate those fields. Show a small "guessed" indicator the user can correct.
- Also accept `.m3u`/`.m3u8`: treat `#EXTINF` lines as Artist/Title hints, ignore comments otherwise.

**Audio-file parsing** (§1b):
- Filter by extension first, then run `music-metadata-browser` on each file.
- Extract: `artist`, `albumartist`, `album`, `title`, `year`, `track.no`, `track.of`, `disk.no`, `duration`, `genre`, `picture` (first cover).
- Keep a reference to the original `File` handle (needed for previewing audio if we add that later — out of scope for v1 but free to retain).
- Run extraction in a Web Worker pool (`navigator.hardwareConcurrency` workers) so a 2,000-file drop doesn't freeze the UI.

**Recursion toggle** (§1c): single switch in the top toolbar, persisted to localStorage. Default `true`.

**Mixed drops**: text files and audio files dropped together are merged into the same active playlist in drop order.

### 4.2 Playlist Display (req §2)

**Table columns**: `Idx | ▶ | Artist | Year | Album | # | Title | MB | ♫ | [Actions]`
- Virtualized via `@tanstack/react-virtual` (1,000+ rows must scroll smoothly).
- Row height fixed (44px) so virtualization stays simple.
- `Idx` is 1-based and reflects current order, not insertion order — it updates live on reorder/sort.
- Album track `#` displayed as `track.no/track.of` if both known, else just `track.no`.
- Missing fields render as `—` in a muted color; clicking enters an inline edit.
- The **MB** column shows the per-row MusicBrainz enrichment status. Glyphs mirror the Spotify column so the table reads consistently — `·` idle, `…` pending, `●` matched, `◐` ambiguous (clickable picker), `✗` failed. Each glyph carries an `aria-label` for screen readers.

**Toolbar actions** (req §2d):
- **Clear playlist** — wipes all tracks from the active draft. Confirms before clearing because it's destructive. Snapshots the prior state into the undo stack so an accidental click is recoverable while the tab is open.
- **Undo last addition** — reverses the most recent batch that added rows (drag-drop, picker, Spotify import "append", text-paste). For a "replace"-style operation (Clear, Spotify import "replace") the full prior state is restored. Bounded to the last 10 operations. The stack is in-memory only and resets on tab close.

**Reorder** (§2a):
- `@dnd-kit` sortable; drag handle in the leftmost cell.
- Multi-select (shift-click range, ctrl/cmd-click toggle) so users can move groups of tracks.
- After a manual reorder, the active sort indicator clears (the sort is no longer "in effect").

**Sort** (§2c):
- Click a column header to sort ascending; click again for descending; click a third time to clear.
- Sort affects display *and* the order pushed to Spotify on create.
- Tie-breaker: stable insertion order (so sort is reproducible).
- Empty values sort to the bottom regardless of direction.
- Active sort field/direction persists with the playlist draft (IndexedDB), so a refresh restores the same view.

**Unmatched tracks**:
- Rows whose `spotify.status` is `missing` are rendered in muted/grayed style across all cells; the Spotify glyph is the muted `○`.
- Toolbar has a **"Hide unmatched"** toggle (default off, persisted with the draft). When on, missing-Spotify rows are filtered from the view and from the create-playlist payload — their indices renumber accordingly. The count of hidden rows is shown next to the toggle.
- Ambiguous (`◐`) rows are *not* hidden by the toggle; they still demand a decision.

### 4.3 Metadata Enrichment (req §3)

**Role**: MusicBrainz enrichment is **supplementary**. Spotify is the source of truth for any track that has a selected Spotify URI (§4.5). MB's job is to fill *missing* metadata — chiefly a year when Spotify lacks `album.release_date`, and a cover art URL when Spotify didn't supply album images. MB does **not** overwrite fields that came from a Spotify match (or that the user typed). This rule is the single most important change vs. older versions of this design: it eliminates the class of bugs where a track playable on Spotify displayed an MB-derived album/year that didn't match what would actually play.

**Field-overwrite policy at a glance**:

| Source of incoming value | Policy |
|---|---|
| User edit (manual) | Never overwritten by any automatic process |
| Spotify match (auto-pick or picker) | Overwrites all displayed fields. Wipes MB enrichment state on the row so MB re-runs into the new identity. |
| MB enrichment, on row WITHOUT a Spotify URI | Fill-missing for identity; fill-missing for derived. (Earlier "always prefer match for album/year" rule is gone — it caused wrong-year regressions when MB and Spotify disagreed.) |
| MB enrichment, on row WITH a Spotify URI | Fill-missing for everything. Cover art is the only commonly-filled field in practice. |
| Filename heuristic | Lowest priority — overwritten by anything above. |

**Trigger**: automatically after ingest. Two user-driven re-enrich entry points exist:

- **Per-row re-enrich** (↻ icon on every row): clears that track's enrichment status to `idle`, deletes its cache entry, calls `enrichTrack` with `bypassCache: true`. Uses fill-missing field policy — even on explicit user re-enrich, a Spotify-matched row's displayed fields are preserved (the user already chose the version they want via the picker).
- **Re-enrich all** (toolbar ↻ icon): same as above but iterates every non-`spotify-import` track in the playlist.
- **Automatic re-enrich on version change**: when the user picks a different Spotify candidate via the picker, the row's MB cache is cleared and enrichment is queued in the background. This is the *only* time MB enrichment runs against fields the user might consider "set" — and even then it only fills gaps, never overwrites.

Both manual entries also work as the escape hatch when a stale cached MB result needs to be refetched. The global "Clear MusicBrainz cache" in Settings nukes everything as a heavier alternative.

**Provider**: MusicBrainz Web Service v2 (`https://musicbrainz.org/ws/2/`)
- Endpoints: `/recording?query=...&fmt=json&inc=releases+artist-credits`
- **Identification**: browser support for setting `User-Agent` via `fetch()` is uneven (some engines strip or override it), so we use MB's documented SPA-friendly alternative: a `client=Curator/<version>-<contact-email>` query parameter on every request. We also attempt to send `User-Agent` for engines that honor it; the `client=` param is the guarantee.
- Rate limit: **1 request/second per IP**. We enforce client-side via a token-bucket queue (1 token/sec, burst 1). UI shows queue depth so users understand the wait on large imports.
- Scale note: at 1 req/sec a 1,000-track cold import takes ~17 min; warm re-imports hit the IDB cache and complete in seconds. v2 may issue broader queries to batch lookups if this proves painful.

**Lucene-style query** (strict pass):
```
recording:"<title>" AND artist:"<artist>"
```
Album is intentionally excluded — release titles vary heavily across remasters, deluxe editions, and regional reissues, so requiring an exact phrase match on `release:` collapses to zero results too often. The candidate scorer still uses album to rank ties.

**Permissive (`dismax`) fallback**: when the strict quoted-phrase query returns zero recordings, we retry with `dismax=true&query=<title-tokens> <artist-tokens>` — strips Lucene field prefixes/quotes/`AND` and lets MB's DisMax parser tokenize freely. Catches cases like ID3 title `"Lovesponge"` (no space) vs. MB's `"Love Sponge"` where the strict phrase form misses but token-based scoring hits. Costs one extra rate-limited request per *missed* track only.

**Dual ID3-vs-filename query**: when an audio file's ID3 metadata disagrees with the filename-derived hints, we also try the MB search with the filename-derived `(title, artist)` tuple if the primary doesn't auto-match. Candidates from both queries are merged (deduped by `recordingId`, primary first) and re-classified. This is symmetric with the same mechanism used for Spotify search (§4.5), and resolves the case where a file has been retagged with a bad title but the filename still carries the real song name.

Drop clauses when a field is missing. Always-on normalizers before query:
- Strip parenthetical/bracketed suffixes (`(Remastered 2011)`, `[Live]`).
- Strip `feat./featuring/ft.` and the name after.
- NFKD unicode normalize + casefold.
- Replace `&` with `and`.
- **Blank ID3 falls through to filename hints**: an ID3 frame containing `""` (empty string) is treated as missing, so the filename heuristic supplies the value. Without this, files that have been tag-stripped but kept descriptive filenames produced empty MB queries.

**Candidate dedup**: before scoring, MB candidates are grouped by `(normalizedTitle | normalizedArtist)` and one representative is kept per group:
- If the track has a known year (from ID3), keep the candidate with the **smallest absolute year delta** — so a 1995-tagged track lands on the 1995 recording even if MB also returned a 2018 re-recording of the same song.
- If the track has no year, keep the **earliest** representative — gives the original release year by default.

This addresses the "wrong year" symptom that surfaced when MB returns multiple recordings (original + reissue/live) of the same song; each has its own `first-release-date`, and without dedup the scorer would sometimes pick the newer one.

**Candidate scoring** (Fuse.js, weighted):
- title 0.50 · artist 0.30 · album 0.15 · year 0.05
- Year match within ±1 = full credit, ±3 = half, else 0 (re-releases / remasters drift).

**Accept thresholds**:
- Combined Fuse score ≥ **0.75**, **AND**
- `titleSimilarity(track.title, best.title) ≥ 0.4`, **AND**
- `titleSimilarity(track.artist, best.artist) ≥ 0.4`

`titleSimilarity` is a small custom function in `src/enrichment/titleSimilarity.ts`: substring containment (`"lovesponge"` ⊆ `"lovesponge"`), then bigram-Jaccard. The artist+title sanity guards prevent a high Fuse score driven entirely by one matching field from auto-accepting a wildly wrong match. Falling below any of the three downgrades the outcome to `ambiguous`, which surfaces the candidate picker and **does not overwrite displayed fields**.

**Cover art**: fetched from the Cover Art Archive (`https://coverartarchive.org/release/{releaseMbid}/front-250`) after a successful match, using the release MBID of the earliest release on the matched recording. Implemented as a HEAD probe; 404 is expected for many releases and silently ignored. Stored on the track as `track.coverUrl` and rendered as a small thumbnail in the playlist column.

**Cache**:
- Keyed on the normalized `(title, artist, album)` tuple → `MBCandidate[]` + `cachedAt` + `version`.
- The **`version` field** lets us invalidate the cache without touching IDB schema or asking users to clear it. Bumping `MB_CACHE_VERSION` causes reads to ignore older entries (treated as misses, refetched on next enrichment, overwritten on write). The cache self-heals when the shape or derivation of `MBCandidate` changes.
- **Empty results aren't cached** — a search that returned zero recordings is not written. Otherwise a single bad search would permanently poison that key for that title/artist tuple. Cache entries can therefore only ever contain useful candidates.
- Per-track invalidation on per-row re-enrich (best-effort: deletes by *current* key) plus the `bypassCache: true` option on `enrichTrack` (always-correct: skips the cache read entirely for explicit user re-runs).
- Full cache wipe via Settings → Clear MusicBrainz cache.

### 4.4 In-App Playback (req §6.5)

Every row in the playlist can be played in-app from one of three backends, picked at click-time:

1. **Local file**, when `track.localFile` is set. Wrapped with `URL.createObjectURL()` and played in a single shared `<audio>` element. Object URLs are revoked when a new file plays.
2. **Spotify full track (SDK)** — when the user has enabled **Full-track playback** in Settings AND has Spotify Premium AND the track has a Spotify URI. Uses the [Spotify Web Playback SDK](https://developer.spotify.com/documentation/web-playback-sdk) (`https://sdk.scdn.co/spotify-player.js`), loaded lazily on first SDK-eligible play. The SDK registers as a remote device; we then call `PUT /v1/me/player/play?device_id={id}` with `{ uris: [trackUri] }` to start the track. Pause/resume go through the SDK's own `player.pause()` / `player.resume()`.
3. **Spotify 30-second preview**, when `spotify.previewUrl` is set but the SDK isn't enabled / isn't available. Played through the same shared `<audio>` element used for local files.
4. **Not playable** — when none of the above apply (text/m3u source with no Spotify match and no preview URL). The play button is disabled with "No preview available".

**SDK initialization & failure handling**:
- Lazy: the SDK script only loads when the user attempts to play a track that has no local file and `preferFullPlayback` is true. Avoids a Premium-required dependency for users on the preview path.
- Premium gate: the SDK fires an `account_error` event for non-Premium users. We surface a toast (`Spotify Premium required for full-track playback — falling back to 30-second previews`) and store `sdk = { status: "unavailable" }` so subsequent plays use the preview backend without retrying initialization.
- Auth errors (`authentication_error`) and unknown init failures produce similar toasts. The SDK is single-attempt per session.
- Required additional scopes (over the read/modify-playlists set): `streaming`, `user-modify-playback-state`, `user-read-playback-state`. Toggling **Full-track playback** in Settings prompts the user to reconnect so the new scopes are granted.

**Player UI**:
- A green ▶/⏸ SVG button is the leftmost cell of each row (after the drag handle); it toggles to ⏸ for the currently-playing row.
- A persistent **now-playing bar** at the bottom of the window shows the title/artist of the current track, the source label (`Local file` / `Spotify (full track)` / `Spotify preview (30s)`), and play/pause + stop controls — also SVG icons, monotone-green, no background.
- Only one track plays at a time. Starting a new track stops the previous one. The store's `currentTrackId` and `currentSource` track the live playback target.
- Error surfacing: `audio.play()` rejections (other than benign `AbortError`) and `MediaError` events both surface a toast with a human-readable cause (decode error / network / format-not-supported). No more silent failures.

**Data model additions**:
- `Track.localFile?: File` — retained for file-sourced rows and preserved across IDB persistence (Files are structured-cloneable; `saveDraft` retries without `localFile` on a single-track clone failure so a problematic file never tanks the whole save).
- `Track.spotify.previewUrl?: string` — captured from Spotify responses.
- `Settings.preferFullPlayback: boolean` — gates SDK initialization. Off by default.

**Edge cases**:
- Imported Spotify tracks have no `localFile`; they play from `previewUrl` (or SDK if Premium-enabled). Spotify omits `preview_url` for some tracks (regional licensing); those rows show a disabled play button when SDK isn't available.
- File reading may fail post-load; `MEDIA_ERR_SRC_NOT_SUPPORTED` toast tells the user the browser can't decode that file.
- Spotify import response is via `/v1/playlists/{id}/items` (§4.5); we propagate `preview_url` from each item's track.

### 4.5 Spotify Integration (req §4, §5, §6)

**Auth** (§4):
- **Authorization Code with PKCE**, no client secret in code.
- User pastes their own Spotify **Client ID** in Settings (created via developer.spotify.com), plus a Redirect URI matching the deployed app URL.
- Scopes requested: `playlist-modify-public playlist-modify-private playlist-read-private playlist-read-collaborative streaming user-modify-playback-state user-read-playback-state user-read-email`. The `streaming` + playback-state scopes are required for the Web Playback SDK; the others cover playlist read/write.
- Tokens in `sessionStorage`; refresh token used silently when the access token expires. On full expiry (refresh rejected), prompt re-auth.
- **Per-tab sessions**: sessionStorage is scoped per tab, so opening the app in a fresh tab forces re-auth. Deliberate tradeoff for tighter XSS containment over friction.
- "Disconnect" button purges all Spotify state.
- **GET requests omit `Content-Type`**: some Spotify edge layers reject GETs that carry `Content-Type: application/json`. Only requests with a body carry the content-type header.

**Unified API wrapper — every Spotify HTTP call goes through `spotify/apiClient.ts`.** No file is allowed to call `fetch()` against `api.spotify.com` or `accounts.spotify.com` directly. This is the single chokepoint that protects us from Spotify's per-IP rate budget and the penalty-lockout window that follows sustained abuse. The wrapper enforces:

1. **Shared wait window across all callers.** A module-level `nextAllowedAt` timestamp is honored by every in-flight request — so a 429 against `/search` also pauses a concurrent `/me/playlists` fetch. This prevents the herd-of-retries pattern where ten components each independently learn about the same rate limit.
2. **`Retry-After` is authoritative.** When Spotify returns 429, we read the `Retry-After` header (in seconds), add a small random jitter (≤300ms) to desynchronize concurrent retries, and update the shared wait window. We do **not** apply exponential multipliers — Spotify already knows when its bucket refills, so doubling that delay just wastes time.
3. **Capped retries → circuit breaker.** After `MAX_RETRY_ATTEMPTS` (3) consecutive 429s on a single call, the circuit opens for `min(retryAfter, 30s)` (floor 5s). While open, every `callSpotify` invocation across the app fails fast with `SpotifyRateLimitError`. This is the "stop digging" mechanism: if we've ignored three explicit slow-down signals, the right answer is to back off entirely until the penalty window drains, not to keep firing requests.
4. **Typed status handling.** 401 → `SpotifyAuthExpiredError` (caller triggers reauth via the connection badge), 403 → `SpotifyForbiddenError` carrying the response body verbatim (most often region-restricted or algorithmic-playlist edits), 204 → `undefined`, other non-2xx → generic `Error` with status + body. Callers handle these by type, not by digging into raw `Response` objects.
5. **One toast per rate-limit episode.** The rate-limit toast is debounced so a burst of 429s shows a single user-visible message ("Spotify rate-limited — pausing all requests for Ns") rather than flooding the toast stack.

The same `runWithRateLimitPolicy` core also wraps token-endpoint requests to `accounts.spotify.com/api/token` (authorization-code exchange and refresh). They use a different host and don't carry a Bearer token, but they count against the same per-IP budget — so they share the wait window and circuit breaker. This keeps a 429 on `/search` from triggering an unguarded burst of token-refresh attempts.

*Why user-supplied Client ID:* without a backend we can't safely hold a shared client secret, and Spotify's PKCE flow is per-app. Users running their own copy register their own app — same friction as any open-source Spotify tool (e.g. Spicetify).

**Spotify is the primary source of truth.** A track is "in" the created playlist iff a specific Spotify URI has been selected for it. The displayed `title / artist / album / year / duration / coverUrl` for any matched row come from the chosen Spotify candidate. MusicBrainz (§4.3) is supplementary — it backfills fields the user's source didn't provide and stays out of the way once Spotify has spoken.

**Search & availability** (§4a):
- Run `GET /v1/search?q=...&type=track&limit=10&market=<user_country>` for each track. Limit was bumped from 5 to 10 to give the picker a usable range of versions to choose from.
- **Query is intentionally minimal**: `track:"<title>" artist:"<artist>"` only. No album, no year, no other filters. The goal is a wide candidate pool — different recordings, remasters, live versions, and reissues should all surface so the user can pick the desired one. Filtering by album/year at search time hides versions and defeats the purpose.
- **Scoring uses all available local metadata.** The query is narrow but the candidate scorer is rich — every field the local file or text source can supply (album, year, duration, track number) is fed into the Fuse-based ranking against each Spotify candidate. So for a file with a clean ID3 tag saying `Album="'Til Shiloh", Year=1995`, the 1995 recording of that song will rank highest among Spotify's 10 results even though we didn't include album/year in the URL. For a text-only `"Karma Police"` entry, scoring falls back to title+artist only and the wider field is less constraining — which is correct, because the user hasn't told us what version they want.
- **Auto-pick is conservative.** The system auto-marks a track `matched` only when ALL of these hold:
  1. Top-candidate combined score ≥ **0.9** (raised from 0.85). With album/year info available in the local metadata, this is achievable when the user clearly intended a specific version.
  2. Score gap to #2 ≥ **0.15** — there's a clear winner, not a near-tie that could go either way.
  3. Title and artist similarity both ≥ 0.4 (the existing field-similarity guards).
  Failing any of these → status `ambiguous`. This intentionally biases toward "let the user choose": for tracks with only title+artist available, the score gap rarely reaches 0.15 across remasters of the same song, so most fall into the picker. For tracks with full ID3 tags pointing at one specific version, the gap is comfortably wide and auto-pick fires.
- **Statuses**:
  - `matched` — a URI is selected (auto or user-chosen). Green ●. Will be added to the created playlist.
  - `ambiguous` — candidates exist but none auto-qualified. Yellow ◐. Needs user attention before publish (the publish button greys out until ambiguous rows are resolved or hidden via the filter toggle).
  - `missing` — no candidates returned at all. Muted ○. User can edit fields and re-search via the picker.
  - `idle / pending` — initial / in-flight.
- Concurrency: 4 in flight, shared `nextAllowedAt` backoff on 429 (see §4.5 Auth) with capped retries.

**Disambiguation picker** (§4b) — the primary tool for choosing the right version. Clicking any Spotify status glyph (●, ◐, or ○) opens the picker:

- Header shows the current track identity (`Artist — Title`) for context.
- A **"Search again with"** input pre-filled with the track's current `title artist` — user can edit and refetch. This is also how a `missing` row gets a second chance (after a typo correction or a deliberate broadening).
- Candidates rendered as rich rows:
  - Cover thumbnail (40×40)
  - Title (bold)
  - Artist
  - Album · year · `mm:ss` duration
  - The currently-selected URI is visually marked (border highlight + checkmark).
  - **Per-row playback control** to the left of the row. Spotify stopped returning `preview_url` for most third-party apps in late 2024, so the dialog uses a graceful fallback chain:
    1. If `candidate.previewUrl` is set → 30-second preview via local `<audio>` (the legacy path; rare today).
    2. Else if `preferFullPlayback` is enabled and a `spotifyClientId` is configured → full track via the Spotify Web Playback SDK. The SDK is lazily initialized on first dialog play if it isn't already running.
    3. Else → renders as an external-link icon that opens `open.spotify.com/track/{id}` in a new tab.
  - Playback is routed through the shared playback store using a synthetic `candidate:{uri}` id, so the dialog and the main now-playing flow share one audio source — clicking play on a second candidate (or starting playback from the main UI) stops the first automatically. Picking a candidate or closing the dialog stops any dialog-initiated playback.
- Click any candidate to select it. Selection is **a complete identity change for the row**:
  1. Write the chosen candidate's `title / artist / album / year / durationMs / coverUrl` to the track. Spotify is the source of truth for the row's displayed identity.
  2. Update `track.spotify.uri` to the chosen one.
  3. Reset `track.enrichment` to `{ status: "idle" }` and clear that track's MB cache entry.
  4. Trigger MB enrichment in the background with `bypassCache: true` to backfill anything Spotify left blank (rare — mainly when Spotify omits `album.release_date`).
- The dialog closes immediately on select. Per-row glyph updates to ● when the new URI lands.

**ID3-vs-filename dual search** (§4c) — kept, but its role shrank. It is now a **candidate-pool broadener**: if the primary query (using ID3-derived `title/artist`) returns 0 candidates, we transparently retry with the filename-derived `(title, artist)` so the picker has something to show. This is no longer an "auto-pick from one query or the other" heuristic — it just feeds more candidates into the same merged list that the picker displays.

**Playlist creation** (§5):
- The create-playlist panel is anchored to the bottom of the main column (above the now-playing bar) and stays visible while the track list scrolls — symmetric with the toolbar at the top. Long playlists never push the Create button out of view.
- Settings: **Name**, **Description** (optional), **Public/Private** toggle (default Private), **Collaborative** toggle (default off).
- "Create Playlist" button is disabled while any track is still pending enrichment or search; tooltip explains why.
- **Name-collision handling** is a **create-time-only** decision and offers exactly two options — **Replace** (overwrite the existing playlist with the draft) or **Cancel** (abort and let the user rename the draft). There is intentionally no "Create new alongside" option: Spotify allows duplicate names but the resulting list is confusing and the most common reason to hit this dialog is "I wanted to update my existing playlist." When multiple Spotify playlists share the candidate name (rare; can happen for users who already created duplicates manually), the dialog lists them with track counts and lets the user pick which one to replace, or Cancel.
- Flow on **Create** (no collision):
  1. `POST /v1/users/{me}/playlists` → playlist id
  2. Chunk track URIs into batches of 100 (Spotify's max)
  3. `POST /v1/playlists/{id}/items` for each chunk, in order
  4. Show progress bar; on partial failure, keep going and report which tracks failed at the end
- Flow on **Replace** (collision, user picks an existing playlist):
  1. `PUT /v1/playlists/{id}/items` with the first 100 URIs (this replaces the playlist contents)
  2. `POST /v1/playlists/{id}/items` for remaining chunks
  3. Same progress/error handling as above

> **API note (Feb 2026):** Spotify deprecated `/v1/playlists/{id}/tracks` in favor of `/v1/playlists/{id}/items` across read/add/replace operations. All three are now on the `/items` path. The request bodies (`{ uris: [...] }`) are unchanged.
- On success: toast with a clickable link to the playlist in Spotify; the sidebar refreshes (§6).

**Existing playlists** (§6):
- Sidebar lists `GET /v1/me/playlists` (paginated; auto-load all pages).
- Each row: cover art, name, track count, owner badge (you vs. followed).
- **Drag a playlist row onto the draft table** to append its tracks to the current draft. There is no separate "Replace" or "Append" button per row — drag is the single, direct gesture. To replace, the user clears the draft first (Clear button → Undo if needed) and then drags. Each Spotify track becomes a Track row with all fields populated and `spotify` status already `matched` (URI preserved).
- **Imported tracks are also MB-enriched** so they pick up MB-derived data (cover art from Cover Art Archive when Spotify doesn't supply one, MB recording id for the per-row metadata picker). The displayed `title/artist/album/year` are NOT overwritten by MB though — once a track is marked `spotify.status === "matched"` (or arrived as `source.kind === "spotify-import"`), MB enrichment switches to `prefer-existing` policy for every field, treating Spotify as authoritative for what the row displays.
- The drag uses HTML5 drag-and-drop with a custom MIME type (`application/x-curator-playlist`) carrying the Spotify playlist id, so we can distinguish playlist drags from file drops on the same drop target.
- Import implementation: `GET /v1/playlists/{id}/items` (paginated; replaces the deprecated `/tracks` path as of Feb 2026).
- **Refresh spinner**: while the sidebar is fetching playlists (initial load, manual Refresh, or post-publish refresh), an animated spinner replaces the playlist list. Once the request settles the list re-renders. We avoid a "ghost list" of stale entries during refresh because a long-running paginated fetch could otherwise show pre-edit state for several seconds.

### 4.6 Settings panel

The Settings panel is **modeless and auto-saves on every keystroke** — there is no Save button. Each field is bound directly to the corresponding key in the Zustand `settingsStore`, which writes through to `localStorage` on every update. Rationale:

- Saves a click on a dialog whose contents are short (5 fields total) and where every field is independently meaningful.
- Removes the "did I save?" ambiguity that a Save button introduces; the field value is the persisted value.
- The trade-off is that a half-typed email is briefly persisted. We accept this — the only consumer that *reads* the email synchronously is the MusicBrainz client, and a half-typed email just produces a failed request that the user can re-trigger after finishing.

Special actions in the panel:
- **Connect to Spotify** triggers the PKCE redirect using the currently-saved Client ID and Redirect URI. Disabled when Client ID is empty.
- **Disconnect** clears tokens and Spotify state immediately.
- **Clear MusicBrainz cache** wipes the IDB cache store; this is an explicit destructive action, not a setting change, so it remains a button rather than a toggle.

A **Close** button is the only modal control; pressing Esc also closes the panel.

---

## 5. Data Model

```ts
type Track = {
  id: string;                    // uuid, stable across enrichment
  source: {
    kind: 'file' | 'text' | 'm3u' | 'spotify-import';
    fileName?: string;           // for file-sourced
    rawLine?: string;            // for text-sourced
    spotifyUri?: string;         // for spotify-imported
  };

  // Editable fields shown in the table
  title?: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  year?: number;
  trackNo?: number;
  trackOf?: number;
  discNo?: number;
  durationMs?: number;
  coverUrl?: string;

  localFile?: File;              // retained for file-source playback (structured-cloneable)
  altQuery?: {                   // filename-derived (title, artist) when it differs from primary
    title?: string;
    artist?: string;
  };

  enrichment: {
    status: 'idle' | 'pending' | 'matched' | 'ambiguous' | 'failed';
    mbRecordingId?: string;
    candidates?: MBCandidate[];  // top 5 for ambiguous picker
    score?: number;
    userOverride?: boolean;      // true if user manually edited; skip auto-reenrich
  };

  spotify: {
    status: 'idle' | 'pending' | 'matched' | 'ambiguous' | 'missing';
    uri?: string;
    candidates?: SpotifyCandidate[];
    score?: number;
    previewUrl?: string;         // 30-second preview, when Spotify exposes one
  };
};

type MBCandidate = {
  recordingId: string;
  releaseId?: string;            // earliest release MBID, used for Cover Art Archive
  title: string;
  artist: string;
  album?: string;
  year?: number;
  score: number;
};

type Playlist = {
  id: string;                    // local draft id — single active draft in v1
  name: string;
  description?: string;
  public: boolean;
  collaborative: boolean;
  trackIds: string[];            // order of truth for display + push
  sort: {                        // null = manual order
    field?: keyof Track | 'index';
    dir?: 'asc' | 'desc';
  } | null;
  hideUnmatched: boolean;        // toggle state persists with the draft
  // No spotifyPlaylistId stored: update-vs-create is resolved by name lookup
  // against the user's current Spotify playlists at create time.
};

type Settings = {
  spotifyClientId?: string;
  spotifyRedirectUri: string;     // defaults to window.location.origin
  recursiveFolderScan: boolean;   // default true
  acceptThresholds: { mb: number; spotify: number };
  musicbrainzContact: string;     // REQUIRED — included as MB client= param
  preferFullPlayback: boolean;    // enable Spotify Web Playback SDK (Premium-only); default false
};

type MBCacheEntry = {
  key: string;                    // normalized title|artist|album
  candidates: MBCandidate[];      // empty results NOT cached
  cachedAt: number;
  version?: number;               // bumped to invalidate on schema change
};
```

**Undo stack** (in-memory only, not persisted):

```ts
type UndoEntry =
  | { kind: 'add'; addedTrackIds: string[] }
  | { kind: 'replace'; priorTrackIds: string[]; priorTracksById: Record<string, Track> }
  | { kind: 'reorder'; priorTrackIds: string[]; priorSort: SortSpec };
```

- `add` entries are written for ingest-style operations (drop, picker, Spotify drag-append, text paste). Undo removes the listed ids.
- `replace` entries are written for full-state operations (Clear). Undo restores the captured prior state.
- `reorder` entries are written for **manual drag-reorders and column sorts** — anything that changes the relative order of existing tracks without adding or removing rows. Undo restores both the prior `trackIds` order and the prior `sort` indicator (so undoing a sort restores the previous sort state, including "manual / no sort").
- Bounded to the most recent 10 operations to cap memory. The stack lives in the playlist store; a tab close discards it. This is a deliberate trade-off — persisting undo would balloon IDB and most users only need to recover from a click made seconds ago.

**Persistence**:
- `Settings` → localStorage (small, sync access). Auto-saved on every keystroke (§4.6).
- Active playlist (including `sort`, `hideUnmatched`, and full `Track[]` with `localFile` handles) + MusicBrainz cache → IndexedDB. State survives across sessions.
- **Debounced writes** (250 ms trailing edge): a batch of rapid updates (e.g. 100 enrichment completions) coalesces into one IDB transaction. `flushPendingPersist()` is wired to `pagehide` and `visibilitychange→hidden` so a quick tab close still commits the in-flight debounce window.
- **Per-track tolerant put**: if a single track's `localFile` fails structured-clone (rare File subtypes), `saveDraft` retries that put without `localFile` rather than aborting the whole transaction. One bad file no longer drops every other track's enrichment update.
- Transient UI state (row selection, scroll position, in-flight enrichment queue, undo stack) → in-memory so refreshes feel continuous within a session but a fresh tab starts clean.
- Spotify tokens → sessionStorage (cleared on tab close; user reconnects on next session — acceptable tradeoff vs. XSS exposure).

---

## 6. UX Flow

```
┌────────────────────────────────────────────────────────────────────────────────┐
│  Curator [Recursive ✓] [Hide unmatched ✗ (3)] [Undo] [Clear] ⏳ ● Connected … ⚙ │
├──────────────┬─────────────────────────────────────────────────────────────────┤
│  Spotify     │  Drop files or a folder here (multiple folders OK), or paste    │
│  Playlists   │  ┌─────────────────────────────────────────────────────────┐    │
│              │  │Idx│▶│Artist   │Year│Album      │ # │Title       │MB│♫│  │    │
│  ◯ Liked     │  ├───┼─┼─────────┼────┼───────────┼───┼────────────┼──┼─┤  │    │
│  ▣ Roadtrip  │  │ 1 │▶│Radiohead│1997│OK Computer│ 4 │No Surprises│ ●│●│  │    │
│  ▣ Lo-fi WFH │  │ 2 │▶│Boards…  │1998│Music Has… │ 3 │Roygbiv     │ ●│●│  │    │
│  ▣ 2025 Mix  │  │ 3 │▶│unknown  │—   │—          │— │Stargazer    │ ◐│◐│  │    │
│              │  │ 4 │▷│·grayed· │·—· │·rare cut· │·—·│·B-side·    │ ✗│○│  │    │
│  [+ Import]  │  └─────────────────────────────────────────────────────────┘    │
│              │  Name [_______________________] ◯Public ◯Private                │
│              │                                          [ Create Playlist ]    │
└──────────────┴─────────────────────────────────────────────────────────────────┘
```

(Row 4 above is rendered muted/gray — `spotify.status = 'missing'`. The "Hide unmatched" toggle in the toolbar would filter it out and renumber rows.)

**State indicators in the Spotify column**:
- `●` green — matched
- `◐` yellow — ambiguous, click to pick
- `○` muted — not on Spotify
- spinner — pending

**Toolbar chrome indicators**:
- **Spotify connection badge**: a colored dot + label always visible in the toolbar. Green `●` with the connected user's display name when an auth session is live; muted `○` + "Not connected" otherwise. Clicking the badge opens Settings (where the user can connect or disconnect). The badge reflects `useSpotifyStore.connected` and updates the moment auth state changes — it's the user's at-a-glance source of truth for whether Spotify operations will work.
- **Busy spinner**: a small animated dot ring shown next to the connection badge whenever long-running work is in flight — file ingest, MusicBrainz enrichment passes, or Spotify search batches. Backed by a ref-counted `busyCount` in the UI store so concurrent operations don't toggle it spuriously: each top-level orchestration calls `incrementBusy()` on start and `decrementBusy()` on settle (success or failure). The spinner disappears when `busyCount === 0`. This is distinct from the per-row pending glyphs — the toolbar spinner is the "the app is doing something for you right now" affordance.
- **Enrichment queue depth**: when the MusicBrainz queue has pending lookups, the toolbar surfaces them as `Enriching · N remaining`. The number is the live queue depth from the rate-limited queue (1 req/sec), so users can predict how long a large import will take. Hidden when the queue drains to zero; appears near the busy spinner so the two pieces of "we're working" information stay together.
- **Icon buttons throughout the chrome**: action buttons in the toolbar and sidebar headers are icon-only (📁 pick folder, ↶ undo, 🗑 clear, ↻ refresh, ⚙ settings, ✕ close, ▶/⏸/⏹ playback, ↻ re-enrich). Every icon button carries both `aria-label` (for screen readers) and `title` (for hover tooltips that name the action). **Visual style is uniform: Spotify-green monotone glyph, no border, no background; hover dims via opacity.** This is intentional — borders + backgrounds on every chrome button made the toolbar feel busy; making them monotone tints them as "controls" without competing with the data view. Where labels are still needed for clarity — primary commit actions like "Create Playlist", state toggles like "Public", and form field labels in Settings — we keep text because mis-clicking those is materially worse than mis-clicking a navigation button.
- **Floating header**: the toolbar is sticky to the top of the viewport with a subtle drop shadow + backdrop blur. As content scrolls beneath, the toolbar remains visible and visually elevated, so the global controls (Pick folder, Undo, Settings, connection status) never disappear behind a long playlist.
- **Themed scrollbar**: all scrollable regions (playlist table, sidebar list) use a custom thin scrollbar matching the dark theme — neutral-900 track, neutral-700 thumb, brighter on hover. Implemented via `::-webkit-scrollbar` plus the standard `scrollbar-color`/`scrollbar-width` properties for Firefox.

**Empty state**: large drop zone with explanatory text and a "Pick folder" button.

**Notifications / toast lifetime**:
- Toasts auto-dismiss **3 seconds** after they appear; the visible content fades to `opacity: 0` over the last ~300 ms and is then unmounted. Manual dismissal (×) is still available and immediate.
- Errors that need user action (e.g. Spotify reauth) include an inline action link on the toast; the toast disappearing doesn't strand the user, because the underlying state (e.g. `connected: false`) is reflected in the connection badge.
- Toast IDs are monotonic; auto-dismiss timers reference them by id so an already-dismissed toast doesn't get fade-then-removed twice.

**Per-row actions on the playlist table**:
- ▶/⏸ — play/pause (green SVG triangle, monotone, no background).
- ⋮⋮ drag handle — muted gray; click-drag to reorder.
- ↻ re-enrich — invalidates that row's MB cache entry and re-queries; uses overwrite-from-match policy.
- 🗑 delete — green SVG trash icon; immediate removal (no confirm; covered by Undo).
- Status glyphs (MB, Spotify) are clickable when ambiguous OR matched — the Spotify glyph also opens the candidate picker on a green ●, letting users switch to a different Spotify candidate.

**Toggle icon buttons** (recursive scan, hide-unmatched): icon-only buttons that flip between Spotify-green (on) and muted gray (off). State is reflected via the icon color + `aria-pressed`; the count of hidden rows lives in the tooltip rather than next to the icon.

**Error toasts**:
- Spotify 401 → "Session expired, reconnect" with a one-click action.
- MusicBrainz 503 → "Music database is busy, retrying…" (auto).
- File parse errors → per-row inline indicator, never a blocking toast.

---

## 7. Edge Cases & Error Handling

| Case | Behavior |
|---|---|
| Dropped folder has thousands of files | Web Worker pool sized to `navigator.hardwareConcurrency` (clamped 2–8) parses in parallel. Main thread stays responsive; empty state shows a centered spinner. |
| File has no ID3 tags | Use filename heuristics: 1/2/3/4+ segment patterns (`01 - Title`, `Artist - Title`, `Artist - Album - Title`, `Album - TrackNo - Artist - Title`). |
| File has ID3 frames containing empty strings | Treated as missing; filename heuristic supplies the value (the `??` operator was changed to a `blankToUndefined()` helper). |
| Two tracks resolve to the same Spotify URI | Allow it — duplicates in playlists are valid Spotify behavior. |
| User edits a field after enrichment | Set `enrichment.userOverride = true`; auto-enrichment skips this track on future runs. Manual "Re-enrich" still works. |
| User drops a `.m3u` referencing absolute paths | Paths are informational only (browser can't read them); titles/EXTINF hints are used. |
| Spotify rate-limited (429) | All requests funnel through `spotify/apiClient.ts`. The wrapper honors `Retry-After` (with ≤300ms jitter), pauses every in-flight caller via a shared `nextAllowedAt` window, and after 3 consecutive 429s on one call trips a circuit breaker that fails fast for all callers until the penalty window drains. Token-endpoint requests (`accounts.spotify.com/api/token`) share this state so refresh attempts can't bypass the cool-off. (See §4.5 Unified API wrapper.) |
| Spotify returns 403 | Surfaced verbatim in the error toast with the response body; the most common cause is region-restricted or Spotify-owned algorithmic playlists. |
| Spotify endpoint deprecated (`/tracks` → `/items`, Feb 2026) | All read/add/replace calls use `/v1/playlists/{id}/items`. The track-item parser accepts `track`, `item`, or flat-shaped envelopes so future minor shape changes don't break import. |
| `/me/playlists` returns `items.total` instead of `tracks.total` | `toPlaylistSummary` reads from both, preferring `items.total` for the current API. |
| MusicBrainz strict query returns no results | Permissive `dismax` fallback fires automatically. Then dual ID3/filename alt-query if `altQuery` is set. Only if all three return nothing do we report a "no match" status. |
| MusicBrainz returns multiple recordings of the same song | Candidates are deduped by `(normalizedTitle, normalizedArtist)`; closest-to-track-year wins, else the earliest. |
| MusicBrainz match has high score but title/artist look unrelated | Title- and artist-similarity guards downgrade the outcome to `ambiguous` (no auto-overwrite). User picks the right candidate from the picker. |
| Playlist push fails partway | Already-added tracks stay; failed chunk reported with a count. |
| Tab closes mid-enrichment | `pagehide` / `visibilitychange→hidden` flush the debounced IDB write so progress isn't lost. Tracks left in `pending` status are re-queued on next session. |
| Same file dropped twice | Dedupe within a single drop on (filename + size); allow duplicates across separate drops. |
| User has no Client ID set when clicking Create | Inline prompt routing to Settings. |
| User has no MusicBrainz contact email set | Enrichment is blocked with a toast pointing to Settings. Ingest, manual edit, sort, and Spotify match still work. |
| Create-Playlist name matches existing user playlists | Replace/Cancel dialog. Multi-match → list with track counts, user picks one. |
| Premium-only SDK fails on non-Premium account | One-time toast; subsequent plays fall back to 30-second previews. |
| Bad `File.localFile` fails structured-clone on save | `saveDraft` retries that single track without the File. The track loses local-file playback but its enrichment/Spotify state still saves; the rest of the playlist is unaffected. |

---

## 8. Security & Privacy

- **No backend** → no server-side logs of user libraries or Spotify activity.
- **No telemetry** in v1. Add only if opt-in.
- **Audio files never leave the device** — they're read locally to extract tags, then the `File` reference is held only in memory.
- **Tokens** in sessionStorage (not localStorage) to limit persistence and XSS blast radius.
- **CSP**: strict — only `accounts.spotify.com`, `api.spotify.com`, `musicbrainz.org`, `coverartarchive.org` in `connect-src`.
- **MusicBrainz contact email** identifies traffic per MB's TOS. Because browser support for setting `User-Agent` is uneven, we attach the contact via MB's `client=` query parameter (see §4.3) — guaranteed to work regardless of browser. We treat the field as **required**: it's mandatory in Settings, and enrichment is blocked until it's provided. This keeps us in good standing with MB and attributes rate-limit issues to the actual user, not a shared default.

---

## 9. Testing Strategy

**Implemented (Vitest)** — `npm test` runs the suite in <1s. Covers:
- `metadata/normalizers` — parenthetical/featuring stripping, casefold, ampersand expansion, Lucene escaping.
- `ingest/filenameHeuristic` — 1/2/3/4+ segment parsing, leading track numbers, pure-digit segment as track number.
- `ingest/textParser` — single-line, `Artist - Title`, `Artist - Album - Title`, comments / blanks.
- `enrichment/luceneQuery` — clause construction, AND join, album-omission contract, empty-fields guard.
- `store/sortComparator` — string asc/desc, number asc/desc, empty-to-bottom, stable tiebreak.
- `store/undoStack` — bounded length, snapshot cloning (independent of source mutation), reorder/replace shapes.

**Still wishlist**:
- Component (React Testing Library): drop-zone overlay logic, sort header tri-state, ambiguous picker, settings form validation.
- Integration with `msw`: full ingest → enrich → match → create flow against mocked MusicBrainz + Spotify.
- E2E (Playwright): drag-drop reorder, folder upload via `<input webkitdirectory>`, Spotify OAuth stubbed at the redirect.
- Manual test corpus: a small `/fixtures` folder with files exercising ID3v1, ID3v2.3/2.4, FLAC Vorbis, M4A, missing tags, mojibake tags, multi-disc albums.

---

## 10. Milestones

1. ✅ **M1 — Ingest + display**: drag-drop folders/files/text, ID3 parsing (in a Web Worker pool), virtualized sortable table with manual reorder.
2. ✅ **M2 — Enrichment**: MusicBrainz client with rate-limit queue + dismax fallback + dual ID3/filename query, fuzzy matching with title+artist sanity guards, candidate dedup by song identity, ambiguous picker, versioned IDB cache.
3. ✅ **M3 — Spotify read**: PKCE auth (with `streaming` + playback-state scopes for the SDK), settings UI, search per track with displayed-field writeback, availability glyphs, playlist sidebar with drag-to-import.
4. ✅ **M4 — Spotify write**: create playlist on the new `/v1/playlists/{id}/items` endpoint, chunked track add, progress UI, Replace/Cancel name-collision dialog.
5. ✅ **M5 — Spotify import**: drag a playlist row onto the draft. Imported tracks are enriched but Spotify-authoritative fields are preserved.
6. ✅ **Polish (most)**: cover art column from CAA, per-row delete + re-enrich, sticky toolbar, themed scrollbar, Spotify Web Playback SDK (Premium), monotone-green icon system, fade-out toasts, reorder/sort undo, debounced persistence.
7. **Still on the wishlist**: Playwright e2e tests, keyboard shortcuts (`[`/`]` move row, Space toggle play), multi-select drag, multi-playlist drafts, dark/light theme switch.

---

## 11. Resolved Decisions

These were initially open questions; recording the outcomes here so the rationale isn't lost.

1. **Name-collision resolution** → **Replace / Cancel only.** No "Create new alongside" option; Spotify allows duplicate names but the resulting list is confusing and the most common reason to hit this dialog is "I wanted to update my existing playlist." Multi-match shows a picker. No persistent `spotifyPlaylistId` is stored — the lookup is fresh each time. (Changed from earlier "Update / Create new / Cancel" — see §4.5 Playlist creation.)
2. **State persistence** → **Persist all draft state, including sort and "Hide unmatched", to IndexedDB** with debounced writes + flush on pagehide. (See §5 Persistence.)
3. **Unmatched tracks** → **Gray them out in-place** with a toolbar **filter** toggle (default off, persisted with the draft). Hidden rows are excluded from the create-playlist payload. (See §4.2 Unmatched tracks.)
4. **Multi-playlist drafts** → **Single active draft.** Defer multi-draft to a later release if requested.
5. **MusicBrainz contact email** → **Required.** Field is mandatory in Settings; enrichment is blocked until provided. (See §8 Security & Privacy.)
6. **MB query field set** → **Title + artist only.** Album excluded — release titles vary too much across remasters. The candidate scorer still uses album to rank ties. (Changed from initial "title + artist + release" — see §4.3.)
7. **Album query strict-phrase fallback** → **`dismax=true` permissive search** when the strict quoted-phrase query returns zero recordings. Catches "Lovesponge" vs. "Love Sponge"-style token splits.
8. **Multiple recordings of the same song** → **Dedup by (title, artist), keep closest-to-track-year or earliest.** Prevents reissue/live recordings from winning the auto-match when the track was tagged with the original year.
9. **Source-of-truth hierarchy** → **Spotify is primary; MB is supplementary.** Once a Spotify URI is selected for a row (auto or via the picker), the chosen candidate's title/artist/album/year/duration/coverUrl become the row's displayed fields. MB enrichment never overwrites these — its only job is to fill gaps Spotify left blank. Earlier rules that let MB "correct" album/year on Spotify-matched rows are gone: they were the root cause of repeated wrong-year reports. (Updated; see §4.3 and §4.5.)
10. **Narrow query, wide-context scoring** → search uses only `track + artist` so all versions surface, but the **candidate scorer feeds every available local metadata field** (album, year, duration, track number from ID3 or filename) into the ranking. So a file with full ID3 tags lands on the specific version it describes; a text-only entry, with no album/year info to constrain scoring, naturally falls into the picker because no single candidate clearly wins.
11. **Disambiguation is the user's job when local metadata is thin** → **Conservative auto-pick + always-available picker.** Auto-pick fires only when score ≥ 0.9 AND #1-vs-#2 gap ≥ 0.15 AND title/artist similarity guards pass. Failing any of these → `ambiguous`. The picker (clicking the Spotify glyph in any state) shows all candidates with cover/title/artist/album/year/duration and a "Search again" input. Picking a candidate is what makes a row `matched`. (See §4.5.)
12. **Version change is an identity change** → when the user picks a different Spotify candidate via the picker, the row's title/artist/album/year/duration/coverUrl are rewritten from the chosen candidate, the MB cache for that row is cleared, and MB re-enrichment is queued in the background to fill any remaining gaps under the new identity.
13. **Spotify Web Playback SDK** → **Implemented as opt-in (Premium-only).** Earlier this was deferred to v2; now shipped behind a Settings toggle with automatic fallback to 30-second previews when the SDK reports a non-Premium account or fails to initialize.
14. **Cover art** → **Implemented.** Originally a nice-to-have; now part of the matched-enrichment flow.
15. **`/items` endpoint migration** → All playlist read/add/replace operations use `/v1/playlists/{id}/items` after Spotify's Feb 2026 deprecation of `/tracks`. (See §4.5.)
16. **Web Worker pool for audio parsing** → **Implemented.** `navigator.hardwareConcurrency` workers (clamped 2–8); main thread no longer blocks on large drops.

---

## 12. Performance & Scale Targets

Concrete targets the implementation should hit; deviations are bugs.

| Dimension | Target | Notes |
|---|---|---|
| Ingest throughput | 1,000 audio files parsed in <30s on a mid-2020 laptop | Web Worker pool sized to `navigator.hardwareConcurrency`; main thread stays responsive. |
| Display | 60fps scroll with 5,000 rows | Virtualized via `@tanstack/react-virtual`, fixed 44px row height. |
| MB enrichment | Cold: 1 req/sec (rate-limited); warm: <50ms/track (cache hit) | IDB cache keyed on normalized (title, artist, album). |
| Spotify search | 1,000 tracks in ~4–5 min absent throttling | 4 in-flight, exponential backoff on 429. |
| First contentful paint | <1s on broadband, cold cache | Vite + code-split Spotify/MB modules. |
| Restore on reopen | ≤2s from tab open to draft restored | One IDB read at startup, no network calls before paint. |
| IDB cache footprint | ≤50 MB MB cache; LRU-evict beyond | Browser per-origin quotas vary; we don't want to be the origin that consumes them. Show usage in Settings with a Clear button. |

---

## 13. Accessibility

Target WCAG 2.1 AA across the table, dialogs, and settings.

- **Keyboard**: every action available without a mouse. Table supports arrow-key navigation, Space to multi-select, Enter to inline-edit, `[` / `]` to move the focused row up/down (independent of pointer drag).
- **Drag-and-drop**: @dnd-kit `KeyboardSensor` enabled alongside `PointerSensor`; screen readers announce pickup, move, and drop.
- **Status indicators are never color-only**: every glyph carries an `aria-label` ("Matched on Spotify", "Ambiguous — press Enter to pick", "Not available on Spotify") plus a tooltip. Sort headers use `aria-sort`.
- **Modals**: ambiguous-match picker and name-collision dialog trap focus, dismiss on Esc, and restore focus on close.
- **Contrast**: text and glyphs meet AA against both light and dark themes; muted/grayed unmatched rows still hit AA contrast.
- **Reduced motion**: respect `prefers-reduced-motion` — disable drag animations and toast slide-ins.

---

## 14. Browser Compatibility

| Browser | Drag-drop ingest | Folder picker | Spotify OAuth | Notes |
|---|---|---|---|---|
| Chromium ≥114 (Chrome, Edge, Brave, Arc) | ✅ | `showDirectoryPicker()` | ✅ | Primary target. Full File System Access API. |
| Firefox ≥115 | ✅ | `<input webkitdirectory>` fallback | ✅ | `showDirectoryPicker` unavailable; folder UX is one extra click. |
| Safari ≥17 | ✅ | `<input webkitdirectory>` fallback | ✅ | `webkitGetAsEntry` works for drops; `showDirectoryPicker` absent. |
| Mobile (any) | n/a | n/a | n/a | Out of scope for v1 — touch drag-drop, folder ingest, and the dense table don't fit small screens. |

Feature detection over UA sniffing: FS Access calls are gated on `'showDirectoryPicker' in window`. No polyfills.
