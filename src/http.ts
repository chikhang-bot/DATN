export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = "REQUEST_ERROR",
    public details?: unknown,
  ) {
    super(message);
  }
}

export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}

export async function readJson<T>(request: Request, maxBytes = 16_384): Promise<T> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new ApiError(415, "Content-Type phải là application/json", "UNSUPPORTED_MEDIA_TYPE");
  }
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > maxBytes) throw new ApiError(413, "Nội dung yêu cầu quá lớn", "PAYLOAD_TOO_LARGE");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new ApiError(413, "Nội dung yêu cầu quá lớn", "PAYLOAD_TOO_LARGE");
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(400, "JSON không hợp lệ", "INVALID_JSON");
  }
}

export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin) return;
  if (new URL(origin).origin !== new URL(request.url).origin) {
    throw new ApiError(403, "Nguồn yêu cầu không hợp lệ", "INVALID_ORIGIN");
  }
}

export function methodNotAllowed(allowed: string[]): Response {
  return json({ error: { code: "METHOD_NOT_ALLOWED", message: "Phương thức không được hỗ trợ" } }, 405, {
    Allow: allowed.join(", "),
  });
}

export function parsePositiveInt(value: string | null, fallback: number, max: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}
