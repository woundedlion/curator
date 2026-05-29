import { describe, expect, it } from "vitest";
import {
  normalizeLineEndings,
  normalizeText,
  readBlobAsText,
  stripBom,
} from "./textNormalize";

describe("stripBom", () => {
  it("removes a leading UTF-8 BOM (U+FEFF)", () => {
    // VLC/iTunes-exported .m3u8 and Notepad UTF-8 saves carry a BOM.
    // Without stripping, downstream string compares against `"#EXTM3U"`
    // miss because the actual first char is U+FEFF.
    expect(stripBom("﻿hello")).toBe("hello");
  });

  it("returns the input unchanged when no BOM is present", () => {
    // The common case — non-Windows editors don't add a BOM. Must not
    // be a no-op that copies the string (we lean on string-equality
    // upstream).
    const input = "hello";
    expect(stripBom(input)).toBe(input);
  });

  it("only strips ONE BOM at the start (a stray inner U+FEFF is preserved)", () => {
    // U+FEFF can appear mid-stream as a zero-width no-break space.
    // Stripping every occurrence would mangle legitimate content.
    expect(stripBom("﻿a﻿b")).toBe("a﻿b");
  });

  it("returns the empty string unchanged", () => {
    expect(stripBom("")).toBe("");
  });
});

describe("normalizeLineEndings", () => {
  it("converts CRLF to LF", () => {
    // Windows text files use \r\n; every line-based parser splits on \n.
    expect(normalizeLineEndings("a\r\nb\r\nc")).toBe("a\nb\nc");
  });

  it("converts standalone CR to LF (classic-Mac line endings)", () => {
    // Rare but still surfaces from old text exports.
    expect(normalizeLineEndings("a\rb\rc")).toBe("a\nb\nc");
  });

  it("leaves LF-only input unchanged", () => {
    expect(normalizeLineEndings("a\nb\n")).toBe("a\nb\n");
  });

  it("handles a mix of CRLF, CR, and LF in the same string", () => {
    // Pathological but possible if a file was concatenated from
    // multiple sources. All three must collapse to the same separator.
    expect(normalizeLineEndings("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });

  it("does NOT touch a bare \\n followed by a stray \\r", () => {
    // CR after LF would be a malformed sequence; we collapse "\r\n"
    // and stand-alone "\r" but treat "\n\r" as "\n" followed by "\r".
    // The "\r" alone then becomes "\n" too. So "a\n\rb" → "a\n\nb".
    expect(normalizeLineEndings("a\n\rb")).toBe("a\n\nb");
  });

  it("returns the empty string unchanged", () => {
    expect(normalizeLineEndings("")).toBe("");
  });
});

describe("normalizeText", () => {
  it("composes BOM strip + line-ending normalize in one pass", () => {
    // The function exists so the common file-boundary call site is
    // one helper, not two. A behavioural regression here means a
    // parser somewhere either loses a BOM or fails to split lines.
    expect(normalizeText("﻿a\r\nb\r\nc")).toBe("a\nb\nc");
  });

  it("is idempotent on already-normalized input", () => {
    // Pure-ASCII LF-only text passes through unchanged. Idempotence
    // matters because parsers sometimes re-normalize a slice.
    const input = "line one\nline two\n";
    expect(normalizeText(input)).toBe(input);
  });
});

describe("readBlobAsText", () => {
  it("decodes valid UTF-8 input", async () => {
    // The fast path: bytes that successfully decode as UTF-8 (which
    // includes all ASCII) are returned via the strict decoder.
    const blob = new Blob([new TextEncoder().encode("héllo")], {
      type: "text/plain",
    });
    expect(await readBlobAsText(blob)).toBe("héllo");
  });

  it("falls back to Windows-1252 when bytes are not valid UTF-8", async () => {
    // A standalone 0xE9 byte ("é" in Windows-1252) is invalid UTF-8
    // because it implies a 2-byte sequence the next byte doesn't
    // complete. The fallback decoder reads it as the Latin-1 é.
    const buf = new Uint8Array([0x63, 0x61, 0x66, 0xe9]); // "café" in Windows-1252
    const blob = new Blob([buf], { type: "text/plain" });
    expect(await readBlobAsText(blob)).toBe("café");
  });

  it("preserves pure-ASCII content byte-for-byte through the UTF-8 path", async () => {
    // Regression guard: the helper must not double-decode ASCII or
    // accidentally route it through Windows-1252 (where most bytes
    // map identically but a few don't).
    const ascii = "Karma Police - Radiohead";
    const blob = new Blob([new TextEncoder().encode(ascii)]);
    expect(await readBlobAsText(blob)).toBe(ascii);
  });

  it("decodes an empty blob to an empty string", async () => {
    const blob = new Blob([], { type: "text/plain" });
    expect(await readBlobAsText(blob)).toBe("");
  });

  it("preserves a BOM in the returned string (stripping is the parser's job)", async () => {
    // `readBlobAsText` is the I/O boundary; BOM handling lives in
    // `normalizeText`/`stripBom` so the parser pipeline composes
    // cleanly. Asserting the BOM is preserved here pins that
    // contract.
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x61]); // UTF-8 BOM + "a"
    const blob = new Blob([bytes], { type: "text/plain" });
    expect(await readBlobAsText(blob)).toBe("﻿a");
  });
});
