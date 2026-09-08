import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// The hosted MCP server runs next to internal services, so a user-supplied URL
// must never reach loopback, private, link-local or cloud metadata addresses.

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 30_000;

export interface RemoteFile {
  bytes: ArrayBuffer;
  contentType: string;
  filename: string;
}

function isPrivateV4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

export function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateV4(ip);
  if (version !== 6) return true;
  const lower = ip.toLowerCase();
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]);
  return (
    lower === "::" || lower === "::1" ||
    lower.startsWith("fc") || lower.startsWith("fd") ||
    lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")
  );
}

export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https URLs can be fetched");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    throw new Error("URL must point to a public host");
  }
  const addresses = isIP(host)
    ? [host]
    : (await lookup(host, { all: true }).catch(() => [])).map((entry) => entry.address);
  if (addresses.length === 0) {
    throw new Error(`Could not resolve host ${host}`);
  }
  if (addresses.some(isPrivateAddress)) {
    throw new Error("URL must point to a public host");
  }
  return url;
}

function filenameFromUrl(url: URL): string {
  const last = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() ?? "");
  return last || "file";
}

export async function fetchRemoteFile(raw: string, maxBytes = MAX_BYTES): Promise<RemoteFile> {
  let url = await assertPublicUrl(raw);
  let response: Response | undefined;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) break;
      url = await assertPublicUrl(new URL(location, url).toString());
      continue;
    }
    break;
  }
  if (!response || (response.status >= 300 && response.status < 400)) {
    throw new Error("Too many redirects while fetching the URL");
  }
  if (!response.ok) {
    throw new Error(`Could not fetch the URL (HTTP ${response.status})`);
  }
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maxBytes) {
    throw new Error(`File is too large (limit ${Math.round(maxBytes / 1024 / 1024)} MB)`);
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > maxBytes) {
    throw new Error(`File is too large (limit ${Math.round(maxBytes / 1024 / 1024)} MB)`);
  }
  return {
    bytes,
    contentType: response.headers.get("content-type")?.split(";")[0].trim() || "application/octet-stream",
    filename: filenameFromUrl(url),
  };
}
