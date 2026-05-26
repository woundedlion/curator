const CODE_VERIFIER_BYTES = 32;
const STATE_BYTES = 16;

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomBytes(length: number): Uint8Array {
  const buffer = new Uint8Array(length);
  crypto.getRandomValues(buffer);
  return buffer;
}

export function generateCodeVerifier(): string {
  return toBase64Url(randomBytes(CODE_VERIFIER_BYTES));
}

export function generateAuthState(): string {
  return toBase64Url(randomBytes(STATE_BYTES));
}

export async function deriveCodeChallenge(codeVerifier: string): Promise<string> {
  const encoded = new TextEncoder().encode(codeVerifier);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return toBase64Url(new Uint8Array(digest));
}
