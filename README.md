# Curator

Browser-based playlist builder. Ingests local audio files or song lists, enriches
metadata via MusicBrainz, matches tracks against Spotify, and creates Spotify
playlists.

## Running locally

```sh
npm install
npm run dev
npm test       # vitest unit tests
npm run lint   # tsc --noEmit
npm run build  # type-check + production bundle
```

Open the printed URL.

## First-time configuration

1. Open **Settings** (gear icon, top-right).
2. Enter a **MusicBrainz contact email** — required so enrichment requests are
   attributed to you per MusicBrainz TOS.
3. Register an app at <https://developer.spotify.com/dashboard> and add a
   Redirect URI matching the app's origin (e.g. `http://localhost:5173/`).
4. Paste the **Spotify Client ID** and **Redirect URI** into Settings, then
   click **Connect to Spotify**.
5. Optional: enable **Full-track playback** in Settings if you have Spotify
   Premium (requires the `streaming` scope; reconnect after toggling).

## Architecture

Curator is a **pure SPA — no backend.** Spotify OAuth runs through the
Authorization Code + PKCE flow directly from the browser; MusicBrainz needs no
key; audio files never leave the device. The trade-offs (per-tab sessions,
user-supplied Client ID, client-side MB rate limiting) are spelled out in
[DESIGN.md](DESIGN.md) §2.

### Tech stack

| Concern              | Choice                                  |
|----------------------|-----------------------------------------|
| Framework / build    | React 18 + TypeScript + Vite            |
| State                | Zustand (multiple slice stores)         |
| Drag & drop          | `@dnd-kit/core` + `@dnd-kit/sortable`   |
| Virtualization       | `@tanstack/react-virtual`               |
| Audio metadata       | `music-metadata` (in a Web Worker pool) |
| Fuzzy matching       | Fuse.js + a small custom title-similarity helper |
| Persistence          | IndexedDB via `idb` (drafts, MB cache); localStorage (settings); sessionStorage (Spotify tokens) |
| Styling              | Tailwind CSS                            |
| Testing              | Vitest                                  |

### High-level dataflow

```
   drop / pick / paste                    paste a playlist row
          │                                       │
          ▼                                       ▼
  ┌──────────────────┐                  ┌────────────────────┐
  │ ingestController │                  │ importPlaylistById │
  │  (orchestrator)  │                  │  (Spotify import)  │
  └────────┬─────────┘                  └─────────┬──────────┘
           │                                      │
           │ buildTracksFromFiles /               │ Spotify GET items
           │ parseTextFile / parseM3U /           │ → Track[] with
           │ parseCuratorExport                   │   spotify.status=matched
           │                                      │
           ▼                                      ▼
       ┌──────────────────  playlistStore (Zustand)  ──────────────────┐
       │  trackIds[]  +  tracksById{}  +  sort  +  hideUnmatched       │
       │  + selection set  +  undo stack (in-memory)                   │
       └────┬──────────────────┬─────────────────────┬─────────────────┘
            │                  │                     │
            ▼                  ▼                     ▼
   enrichmentRunner      spotifyMatchRunner      draftRepository
   (MusicBrainz +        (Spotify search +       (debounced IDB
    Cover Art Archive)   candidate scoring)       persistence)
            │                  │
            └──> musicbrainzClient (1 req/sec token bucket + IDB cache)
                 spotify/apiClient (shared 429 wait window + circuit breaker)
```

The **playlistStore** is the single source of truth for the active draft.
Everything else is either (a) something that pushes data *into* the store
(ingest, enrichment, Spotify search/import) or (b) something that reads from it
(table render, export, publish, persistence). Runners are stateless functions
that mutate the store; UI components only read selectors and dispatch actions.

### Module layout

Each top-level folder under [src/](src/) owns a coherent layer:

| Folder | Responsibility |
|---|---|
| [src/ingest/](src/ingest/) | Drop-target plumbing, recursive folder walker, text/m3u/curator-export parsers, in-batch dedupe, `Track[]` construction from `File[]`. |
| [src/metadata/](src/metadata/) | `music-metadata` wrapper (audio file → tag fields) and the normalizers (parenthetical stripping, `feat./ft.`, NFKD, `&`→`and`) used by both MB queries and the candidate scorer. |
| [src/workers/](src/workers/) | The Web Worker pool that runs `music-metadata` off the main thread. Pool size is `clamp(navigator.hardwareConcurrency, 2, 8)`. |
| [src/enrichment/](src/enrichment/) | MusicBrainz client with token-bucket rate limit, strict-then-`dismax` query strategy, candidate dedup (by song identity, year-aware), Fuse.js scorer, Cover Art Archive HEAD probe. |
| [src/spotify/](src/spotify/) | PKCE auth, token storage, the **unified API wrapper** (`apiClient.ts` — shared `nextAllowedAt`, retry policy, circuit breaker), per-track search, playlist read/create/replace via `/v1/playlists/{id}/items`, and the Web Playback SDK wrapper. |
| [src/services/](src/services/) | Orchestrators that compose the layers above into user-visible actions: [ingestController](src/services/ingestController.ts), [enrichmentRunner](src/services/enrichmentRunner.ts), [spotifyMatchRunner](src/services/spotifyMatchRunner.ts), [spotifyPicker](src/services/spotifyPicker.ts), [playlistPublisher](src/services/playlistPublisher.ts), [playlistExporter](src/services/playlistExporter.ts), [spotifyBootstrap](src/services/spotifyBootstrap.ts). These are the only callers that hold cross-layer policy. |
| [src/store/](src/store/) | Zustand stores: [playlistStore](src/store/playlistStore.ts) (draft state + undo), [settingsStore](src/store/settingsStore.ts) (localStorage-backed), [spotifyStore](src/store/spotifyStore.ts) (connection + playlists), [uiStore](src/store/uiStore.ts) (toasts, busy counter, modals). Pure helpers ([sortComparator](src/store/sortComparator.ts), [undoStack](src/store/undoStack.ts), [selectionHelpers](src/store/selectionHelpers.ts)) live alongside and are independently unit-tested. |
| [src/db/](src/db/) | IndexedDB layer (`idb`). [database.ts](src/db/database.ts) owns schema/version, [draftRepository.ts](src/db/draftRepository.ts) persists the active draft with debounced writes + `pagehide`/`visibilitychange` flush, [musicbrainzCache.ts](src/db/musicbrainzCache.ts) stores MB candidate lists with a `version` field for cache invalidation. |
| [src/playback/](src/playback/) | In-app playback store. Picks the right backend per click (local `<audio>`, Spotify Web Playback SDK, Spotify 30-s preview, or disabled) and serializes playback so only one track plays at a time. |
| [src/ui/](src/ui/) | React components. The table is [PlaylistTable](src/ui/PlaylistTable.tsx) + [SortableTrackRow](src/ui/SortableTrackRow.tsx) (virtualized, dnd-kit-sortable). The drop overlay, dialogs (ambiguous picker, name-collision, settings), toolbar, sidebar, and now-playing bar are all peers. |
| [src/hooks/](src/hooks/) | Small custom hooks ([useAppBootstrap](src/hooks/useAppBootstrap.ts) wires up draft restore + Spotify bootstrap on first paint, [useVisibleTrackIds](src/hooks/useVisibleTrackIds.ts) applies the hide-unmatched filter, [useEnrichmentRemaining](src/hooks/useEnrichmentRemaining.ts) exposes queue depth to the toolbar, [useDialogFocus](src/hooks/useDialogFocus.ts) is the shared focus trap used by every modal). |

### Source of truth (the rule that holds the data layer together)

This is the most load-bearing invariant in the codebase and is worth knowing
before touching anything in enrichment, Spotify, or the store:

1. **User edit** wins. Never overwritten by an automatic process.
2. **A selected Spotify URI** is the row's identity. Whatever the user picked
   (or auto-pick chose) — its title/artist/album/year/duration/coverUrl become
   the row's displayed fields. Switching to a different Spotify candidate
   rewrites these and triggers a background MB re-enrichment under the new
   identity.
3. **MusicBrainz** is supplementary. It fills *missing* fields only — typically
   a year when Spotify lacks `album.release_date`, and cover art when Spotify
   didn't supply images. It never overwrites a Spotify-matched row's displayed
   fields. This rule exists because earlier versions of the app did let MB
   "correct" Spotify-matched fields, which produced wrong-year regressions
   whenever MB and Spotify disagreed.
4. **Filename heuristic** is the lowest-priority source — overwritten by any of
   the above.

See [DESIGN.md](DESIGN.md) §4.3 for the full field-overwrite matrix.

### Rate limiting & error handling

Two independent rate-limit regimes:

- **MusicBrainz**: client-side token-bucket queue in
  [rateLimitedQueue.ts](src/enrichment/rateLimitedQueue.ts) (1 token/sec, burst
  1) — MB allows 1 req/sec per IP. The IDB cache makes warm re-imports
  effectively free.
- **Spotify**: every call to `api.spotify.com` *and* `accounts.spotify.com`
  routes through [spotify/apiClient.ts](src/spotify/apiClient.ts). It enforces a
  module-level `nextAllowedAt` shared across all callers (so a 429 on
  `/search` also pauses `/me/playlists`), honors `Retry-After` with ≤300 ms
  jitter, caps retries at 3, and opens a circuit breaker that fails all
  in-flight calls fast for `min(retryAfter, 30s)` after the cap is hit. Token
  refresh requests share the same wait window so they can't bypass the cool-off.
  No other file is allowed to `fetch()` Spotify directly.

Typed errors (`SpotifyAuthExpiredError`, `SpotifyForbiddenError`,
`SpotifyRateLimitError`) flow out of the wrapper and let callers respond by
type instead of digging into raw `Response` objects.

### Persistence

| Data | Where | Why |
|---|---|---|
| Settings (Client ID, MB email, toggles) | localStorage | Small, synchronous, survives across sessions. Auto-saved on every keystroke. |
| Active draft (`trackIds`, `tracksById` with `localFile` handles, `sort`, `hideUnmatched`) | IndexedDB | Files are structured-cloneable; whole draft survives reload. Writes are debounced 250 ms with a `pagehide` / `visibilitychange→hidden` flush. A single bad file's structured-clone failure falls back to saving that track without `localFile` rather than dropping the whole transaction. |
| MusicBrainz candidate cache | IndexedDB | Keyed on normalized `(title, artist, album)`. Has a `version` field so we can invalidate on shape changes without touching IDB schema. Empty results are deliberately not cached. |
| Spotify tokens | sessionStorage | Per-tab scope limits XSS blast radius; the trade-off is that a fresh tab must reconnect. |
| Undo stack, busy counter, toasts, selection set | In-memory (Zustand) | Transient; a fresh tab should start clean. |

### Concurrency

- **Audio parsing**: worker pool sized to `clamp(navigator.hardwareConcurrency,
  2, 8)`. Main thread stays interactive on multi-thousand-file drops.
- **MB enrichment**: serialized through the 1 req/sec queue. The toolbar
  surfaces live queue depth (`Enriching · N remaining`) so users know how long
  a cold import will take.
- **Spotify search**: 4 in flight, gated by
  [concurrencyLimiter.ts](src/spotify/concurrencyLimiter.ts) and the shared
  `apiClient` wait window.
- **Persistence writes**: debounced and coalesced (a burst of 100 enrichment
  completions becomes one IDB transaction).
- **UI busy state**: a ref-counted `busyCount` in `uiStore` — each orchestrator
  brackets its work with `incrementBusy()` / `decrementBusy()`, so concurrent
  operations don't toggle the spinner spuriously.

### Where to read more

- [DESIGN.md](DESIGN.md) is the authoritative source for feature behavior,
  resolved decisions, edge cases, and the source-of-truth rules. Anything that
  feels surprising in the code is almost certainly explained there.
- Unit tests sit next to the code they cover — see
  [normalizers.test.ts](src/metadata/normalizers.test.ts),
  [filenameHeuristic.test.ts](src/ingest/filenameHeuristic.test.ts),
  [textParser.test.ts](src/ingest/textParser.test.ts),
  [curatorExportParser.test.ts](src/ingest/curatorExportParser.test.ts),
  [luceneQuery.test.ts](src/enrichment/luceneQuery.test.ts),
  [sortComparator.test.ts](src/store/sortComparator.test.ts),
  [undoStack.test.ts](src/store/undoStack.test.ts),
  [selectionHelpers.test.ts](src/store/selectionHelpers.test.ts).

## What's implemented

- Drag-drop ingest of folders, audio files, .txt, .m3u/.m3u8, and `.curator.txt`
  round-trip export files (multi-folder drops supported).
- Folder picker via File System Access API with `<input webkitdirectory>` fallback.
- Audio metadata parsing (ID3/Vorbis/MP4/etc.) via `music-metadata` running in a
  **Web Worker pool** sized to `navigator.hardwareConcurrency`.
- Filename-derived metadata fallback when ID3 tags are missing or blank; dual
  Spotify search when filename and ID3 disagree.
- MusicBrainz enrichment with a 1-req/sec queue + IndexedDB cache; strict
  Lucene-phrase first, permissive `dismax` fallback when the strict query has
  zero results.
- Cover art column fetched from the Cover Art Archive (release-based, 250px).
- Spotify PKCE OAuth, per-track search, playlist creation/replace with the new
  `/v1/playlists/{id}/items` endpoint, name-collision dialog (Replace/Cancel),
  and drag-to-import (drag a playlist row onto the draft to append).
- Local export to `.curator.txt` (JSON) and re-import that restores selected
  Spotify URIs + MB recording ids so round-tripped playlists are publish-ready
  without re-running search/enrichment.
- **Spotify Web Playback SDK** for full-track playback (Premium-only; falls
  back to 30-second previews automatically when the SDK reports a non-Premium
  account or fails to initialize).
- Virtualized, sortable, drag-reorderable playlist table with per-row
  re-enrich button and a unified selection model (click / shift-click /
  ctrl-click / rubber-band / group drag).
- IndexedDB-backed draft persistence (debounced; flushes on pagehide) with
  in-memory undo stack covering adds, clears, reorders, and sort changes.
- Per-file ingest failures surface as a single aggregated toast
  (`Skipped N files…`) per drop; per-file detail is in the console.
- Partial-publish surfacing — when Spotify rejects one or more chunks during a
  playlist push, the success toast becomes an error with `X/Y added` and the
  playlist link still attached so the user can click through.
- Modal focus management — every dialog (Spotify picker, MB picker, name
  collision, Settings) traps Tab, closes on Esc, and restores focus on
  unmount via a shared `useDialogFocus` hook.
- Cover Art Archive negative-cache so re-enrichment passes don't re-probe
  releases that already returned 404.
- 53 Vitest unit tests covering normalizers, filename heuristic, Lucene-query
  builder, sort comparator, undo stack, selection helpers, text parser, and the
  curator export parser.

## Still on the wishlist

- Playwright e2e test suite for the drag-drop / OAuth flows.
- Per-row inline edit of any cell (enrichment correction beyond the
  "pick a match" dialog).
- Multi-playlist drafts (single active draft today).
