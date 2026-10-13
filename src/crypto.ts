const encoder = new TextEncoder();

export function randomToken(bytes = 32): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return toBase64Url(value);
}

export function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return toHex(new Uint8Array(digest));
}

export async function hashPassword(
  password: string,
  saltHex?: string,
  iterations = 210_000,
): Promise<{ hash: string; salt: string; iterations: number }> {
  const salt = saltHex ? fromHex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    material,
    256,
  );
  return { hash: toHex(new Uint8Array(bits)), salt: toHex(salt), iterations };
}

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[0-9a-f]+$/i.test(value) || value.length % 2 !== 0) throw new Error("Invalid hex");
  const result = new Uint8Array(value.length / 2);
  for (let i = 0; i < result.length; i += 1) result[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return result as Uint8Array<ArrayBuffer>;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
