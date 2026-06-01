// Unit-separator (U+001F) — bytes that File.name will never contain — so
// `("a.mp3", 12, 345)` and `("a.mp", 312, 345)` can't share a key.
const KEY_DELIMITER = "\u001F";

function buildDuplicateKey(file: File): string {
  // name + size collides surprisingly often for re-rips of the same
  // track at the same bitrate from different folders. lastModified
  // disambiguates without requiring content hashing — collisions across
  // name + size + lastModified are vanishingly rare for genuinely
  // different files.
  return `${file.name}${KEY_DELIMITER}${file.size}${KEY_DELIMITER}${file.lastModified}`;
}

export function dedupeFiles(files: File[]): File[] {
  const seen = new Set<string>();
  const unique: File[] = [];
  for (const file of files) {
    // Without a usable lastModified (0 or missing — privacy-hardened
    // browsers and some synthesized File handles report this), name+size
    // alone can't tell two genuinely different files apart. Keep them all
    // rather than risk silently dropping one; dedup applies only when the
    // timestamp is present.
    if (!file.lastModified) {
      unique.push(file);
      continue;
    }
    const key = buildDuplicateKey(file);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(file);
  }
  return unique;
}
