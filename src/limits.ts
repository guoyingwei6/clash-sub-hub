export const MAX_MERGE_BYTES = 2 * 1024 * 1024;
export const MAX_NODE_YAML_BYTES = 128 * 1024;
export const MAX_PROVIDER_BYTES = 5 * 1024 * 1024;
export const MAX_SCRIPT_BYTES = 1024 * 1024;

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function requestTooLarge(request: Request, maxBytes: number): boolean {
  const contentLength = Number(request.headers.get('Content-Length') || 0);
  return Number.isFinite(contentLength) && contentLength > maxBytes;
}

export async function readResponseTextLimited(
  response: Response,
  maxBytes: number
): Promise<string> {
  const contentLength = Number(response.headers.get('Content-Length') || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new PayloadTooLargeError();
  }
  const text = await response.text();
  if (utf8ByteLength(text) > maxBytes) throw new PayloadTooLargeError();
  return text;
}

export class PayloadTooLargeError extends Error {
  constructor() {
    super('响应内容过大');
    this.name = 'PayloadTooLargeError';
  }
}
