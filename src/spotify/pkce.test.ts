import { describe, expect, it } from "vitest";
import {
  deriveCodeChallenge,
  generateAuthState,
  generateCodeVerifier,
} from "./pkce";

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

describe("PKCE helpers", () => {
  it("generates a code verifier that is base64url-encoded", () => {
    const v = generateCodeVerifier();
    expect(BASE64URL_PATTERN.test(v)).toBe(true);
    // 32 random bytes -> 43 base64url chars (no padding).
    expect(v.length).toBe(43);
  });

  it("generates an auth state token that is base64url-encoded", () => {
    const s = generateAuthState();
    expect(BASE64URL_PATTERN.test(s)).toBe(true);
    // 16 random bytes -> 22 base64url chars (no padding).
    expect(s.length).toBe(22);
  });

  it("produces a different verifier on each call (extremely high probability)", () => {
    const a = generateCodeVerifier();
    const b = generateCodeVerifier();
    expect(a).not.toBe(b);
  });

  it("derives a SHA-256 challenge that is base64url-encoded and deterministic", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    // Reference output from RFC 7636 §4.6 example, in base64url:
    // S256(dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk) =
    //   "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    const challenge = await deriveCodeChallenge(verifier);
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    expect(BASE64URL_PATTERN.test(challenge)).toBe(true);
  });

  it("produces the same challenge for the same verifier", async () => {
    const verifier = generateCodeVerifier();
    const a = await deriveCodeChallenge(verifier);
    const b = await deriveCodeChallenge(verifier);
    expect(a).toBe(b);
  });
});
