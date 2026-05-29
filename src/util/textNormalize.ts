// Strip a leading UTF-8 BOM (U+FEFF). Notepad on Windows saves UTF-8
// with a BOM; VLC/iTunes export .m3u8 with one. Without stripping, the
// first non-comment line's leading character becomes `<U+FEFF>...`,
// which breaks downstream matching and parsing.
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// Normalize Windows (CRLF) and classic-Mac (CR) line endings to Unix
// (LF). Every text-source parser (m3u, plain text, curator-export)
// needs this; rolling it into a single helper alongside `stripBom`
// keeps the call sites honest.
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n|\r/g, "\n");
}

// One-shot text normalization: BOM strip + line-ending normalize. The
// common case at every text-file boundary. Use when you read a file
// for line-based parsing; use the more specific helpers when you only
// need one transform (e.g. a single line of input from a UI form).
export function normalizeText(text: string): string {
  return normalizeLineEndings(stripBom(text));
}

// Decode a Blob/File as text with UTF-8-then-Windows-1252 fallback.
// Browsers' built-in `Blob.text()` is hard-coded to UTF-8 and
// silently replaces invalid bytes with U+FFFD — files that Notepad
// saved as "ANSI" (Windows-1252) come back as mojibake (`café` →
// `caf?`). The fallback path catches that: we try strict UTF-8 first
// (`{ fatal: true }` throws on the first invalid byte sequence), and
// only fall back to Windows-1252 on failure. Pure-ASCII files are
// valid UTF-8 by definition, so the common case never enters the
// fallback. Windows-1252 was chosen because it's the dominant
// non-UTF-8 encoding in the wild for English/Latin text and is
// superset-compatible with ISO-8859-1.
export async function readBlobAsText(blob: Blob): Promise<string> {
  const buffer = new Uint8Array(await blob.arrayBuffer());
  try {
    // `ignoreBOM: true` keeps any leading U+FEFF in the output —
    // BOM stripping is the parser pipeline's job (`normalizeText` →
    // `stripBom`), and silently swallowing it here would mean every
    // caller is missing a byte they may need to detect file type.
    return new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(buffer);
  } catch {
    return new TextDecoder("windows-1252").decode(buffer);
  }
}
