function buildDuplicateKey(file: File): string {
  // name + size collides surprisingly often for re-rips of the same
  // track at the same bitrate from different folders. lastModified
  // disambiguates without requiring content hashing — collisions across
  // name + size + lastModified are vanishingly rare for genuinely
  // different files. Use a control-character delimiter so a path
  // containing a colon never accidentally collides with another file.
  return `${file.name}${file.size}${file.lastModified ?? 0}`;
}

export function dedupeFiles(files: File[]): File[] {
  const seen = new Set<string>();
  const unique: File[] = [];
  for (const file of files) {
    const key = buildDuplicateKey(file);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(file);
  }
  return unique;
}
