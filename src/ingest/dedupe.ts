function buildDuplicateKey(file: File): string {
  return `${file.name}:${file.size}`;
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
