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
