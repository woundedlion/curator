// Strip a leading UTF-8 BOM (U+FEFF). Notepad on Windows saves UTF-8
// with a BOM; VLC/iTunes export .m3u8 with one. Without stripping, the
// first non-comment line's leading character becomes `<U+FEFF>...`,
// which breaks downstream matching and parsing.
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
