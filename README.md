# Curator

Browser-based playlist builder. Ingests local audio files or song lists, enriches
metadata via MusicBrainz, matches tracks against Spotify, and creates Spotify
playlists.

## Running locally

```sh
npm install
npm run dev
npm test       # vitest unit tests
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

## What's implemented

- Drag-drop ingest of folders, audio files, .txt, and .m3u/.m3u8 (multi-folder
  drops supported).
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
- **Spotify Web Playback SDK** for full-track playback (Premium-only; falls
  back to 30-second previews automatically when the SDK reports a non-Premium
  account or fails to initialize).
- Virtualized, sortable, drag-reorderable playlist table with per-row
  re-enrich button.
- IndexedDB-backed draft persistence (debounced; flushes on pagehide) with
  in-memory undo stack covering adds, clears, reorders, and sort changes.
- Vitest unit tests covering normalizers, filename heuristic, Lucene-query
  builder, sort comparator, undo stack, and text parser.

## Still on the wishlist

- Playwright e2e test suite for the drag-drop / OAuth flows.
- Per-row inline edit of any cell (enrichment correction beyond the
  "pick a match" dialog).
- Multi-playlist drafts (single active draft today).
