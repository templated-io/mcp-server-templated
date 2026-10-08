// Data contract and view logic of the render preview card (ui://templated/render-card-v1.html).
// Pure and DOM-free: the server uses it to build the structuredContent of create_render
// and get_render, and the card bundle (web/render-card) uses it to decide what to show.

export type RenderStatus = "completed" | "pending" | "failed";

export interface CardRender {
  id: string;
  url?: string;
  status: RenderStatus;
  format?: string;
  width?: number;
  height?: number;
  name?: string;
  page?: string;
}

// One render puts its fields at the top level; several renders (a multi-page
// template or a batch) go in `renders`, with what they share at the top level.
export interface RenderCardData {
  status: RenderStatus;
  id?: string;
  url?: string;
  format?: string;
  width?: number;
  height?: number;
  name?: string;
  page?: string;
  templateId?: string;
  templateName?: string;
  editorUrl?: string;
  renders?: CardRender[];
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

const size = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;

const PENDING = new Set(["pending", "processing", "queued", "rendering", "in_progress", "started"]);
const FAILED = new Set(["failed", "error", "errored", "cancelled", "canceled"]);

// The API sends the RenderStatus enum name (PENDING, COMPLETED, FAILED).
export function normalizeStatus(value: unknown): RenderStatus {
  const status = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (PENDING.has(status)) return "pending";
  if (FAILED.has(status)) return "failed";
  return "completed";
}

function aggregateStatus(renders: CardRender[]): RenderStatus {
  if (renders.length === 0) return "failed";
  if (renders.some((r) => r.status === "pending")) return "pending";
  if (renders.every((r) => r.status === "failed")) return "failed";
  return "completed";
}

function toCardRender(value: unknown): CardRender | undefined {
  if (!isObject(value)) return undefined;
  const id = typeof value.id === "number" ? String(value.id) : text(value.id);
  if (!id) return undefined;
  const render: CardRender = { id, status: normalizeStatus(value.status) };
  const url = text(value.url);
  if (url) render.url = url;
  const format = text(value.format);
  if (format) render.format = format.toLowerCase();
  const width = size(value.width);
  const height = size(value.height);
  if (width && height) {
    render.width = width;
    render.height = height;
  }
  const name = text(value.name);
  if (name) render.name = name;
  const page = text(value.page);
  if (page) render.page = page;
  return render;
}

export interface CardDataOptions {
  // Base URL of the Templated web app, for the "Open in editor" link. Omitted when
  // the link should not be offered (white-label contexts scoped to an external ID).
  appUrl?: string;
}

export function editorUrl(appUrl: string, templateId: string): string {
  return `${appUrl.replace(/\/+$/, "")}/editor/${encodeURIComponent(templateId)}`;
}

// Builds the card's structuredContent from a sanitized create_render/get_render
// result: a render, an array of renders, or { url, renders } for bundles.
export function toCardData(result: unknown, options: CardDataOptions = {}): RenderCardData {
  const items = Array.isArray(result)
    ? result
    : isObject(result) && Array.isArray(result.renders)
      ? result.renders
      : [result];
  const renders = items.map(toCardRender).filter((r): r is CardRender => r !== undefined);

  const shared: Partial<RenderCardData> = {};
  const sources = items.filter(isObject);
  const templateIds = new Set(sources.map((item) => text(item.templateId)));
  const templateId = templateIds.size === 1 ? [...templateIds][0] : undefined;
  if (templateId) {
    shared.templateId = templateId;
    const templateName = sources.map((item) => text(item.templateName)).find(Boolean);
    if (templateName) shared.templateName = templateName;
    if (options.appUrl) shared.editorUrl = editorUrl(options.appUrl, templateId);
  }

  if (renders.length === 1) {
    return { ...renders[0], ...shared };
  }
  const data: RenderCardData = { status: aggregateStatus(renders), ...shared };
  const formats = new Set(renders.map((r) => r.format));
  const [format] = formats;
  if (formats.size === 1 && format) data.format = format;
  if (renders.length > 0) data.renders = renders;
  return data;
}

// --- view model -----------------------------------------------------------------

export type MediaKind = "image" | "video" | "pdf" | "file";

const IMAGE_FORMATS = new Set(["png", "jpg", "jpeg", "webp", "gif", "avif"]);
const VIDEO_FORMATS = new Set(["mp4", "webm", "mov"]);

function extensionOf(url: string | undefined): string {
  if (!url) return "";
  try {
    const last = new URL(url).pathname.split("/").pop() ?? "";
    return last.includes(".") ? last.slice(last.lastIndexOf(".") + 1).toLowerCase() : "";
  } catch {
    return "";
  }
}

export function mediaKind(format?: string, url?: string): MediaKind {
  const ext = (format ?? "").trim().toLowerCase().replace(/^\./, "") || extensionOf(url);
  if (IMAGE_FORMATS.has(ext)) return "image";
  if (VIDEO_FORMATS.has(ext)) return "video";
  if (ext === "pdf") return "pdf";
  return "file";
}

// Tool results are untrusted input: only https URLs reach src or href.
export function safeUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export interface CardItem {
  id: string;
  kind: MediaKind;
  status: RenderStatus;
  url?: string;
  width?: number;
  height?: number;
  format?: string;
  label: string;
  alt: string;
}

export type CardState = "loading" | "ready" | "pending" | "failed";
export type CardLayout = "single" | "grid" | "list";

export interface CardView {
  state: CardState;
  layout: CardLayout;
  title: string;
  meta: string;
  items: CardItem[];
  downloadUrl?: string;
  editorUrl?: string;
  pendingIds: string[];
}

// Inline grids show at most this many tiles; the rest are counted on the last tile.
export const INLINE_GRID_LIMIT = 8;
// Renders polled per round while some are still pending.
export const MAX_POLLED_RENDERS = 8;

const FORMAT_LABELS: Record<string, string> = { jpg: "JPG", jpeg: "JPG", png: "PNG", webp: "WebP", pdf: "PDF", mp4: "MP4" };
export const formatLabel = (format?: string): string | undefined =>
  format ? FORMAT_LABELS[format] ?? format.toUpperCase() : undefined;

const dimensions = (width?: number, height?: number): string | undefined =>
  width && height ? `${width} × ${height}` : undefined;

function rendersOf(data: RenderCardData): CardRender[] {
  if (data.renders && data.renders.length > 0) return data.renders;
  return data.id ? [data as CardRender] : [];
}

export function cardView(data: RenderCardData | undefined): CardView {
  if (!data) {
    return { state: "loading", layout: "single", title: "Render", meta: "", items: [], pendingIds: [] };
  }
  const renders = rendersOf(data);
  const title = data.templateName ?? (renders.length === 1 ? renders[0].name : undefined) ?? "Render";
  const items: CardItem[] = renders.map((render, index) => {
    const format = render.format ?? data.format;
    const label = render.page ?? (renders.length > 1 ? render.name ?? `Page ${index + 1}` : render.name ?? title);
    const described = [title, renders.length > 1 ? label : undefined].filter(Boolean).join(", ");
    const details = [dimensions(render.width, render.height), formatLabel(format)].filter(Boolean).join(" ");
    return {
      id: render.id,
      kind: mediaKind(format, render.url),
      status: render.status,
      url: safeUrl(render.url),
      width: render.width,
      height: render.height,
      format,
      label,
      alt: details ? `${described}, ${details}` : described,
    };
  });

  const status = data.renders ? aggregateStatus(data.renders) : data.status;
  const state: CardState = items.length === 0 || status === "failed" ? "failed" : status === "pending" ? "pending" : "ready";
  const layout: CardLayout = items.length <= 1
    ? "single"
    : items.every((item) => item.kind === "image" || item.kind === "video") ? "grid" : "list";

  let meta: string;
  if (items.length <= 1) {
    const item = items[0];
    meta = [dimensions(item?.width, item?.height), formatLabel(item?.format ?? data.format)].filter(Boolean).join(" · ");
  } else {
    const sizes = new Set(items.map((item) => dimensions(item.width, item.height)));
    const [shared] = sizes;
    const counted = renders.every((render) => render.page) ? "pages" : "files";
    meta = [`${items.length} ${counted}`, sizes.size === 1 ? shared : undefined, formatLabel(data.format)]
      .filter(Boolean).join(" · ");
  }

  const single = items.length === 1 ? items[0] : undefined;
  return {
    state,
    layout,
    title,
    meta,
    items,
    downloadUrl: single?.status === "completed" ? single.url : undefined,
    editorUrl: safeUrl(data.editorUrl),
    pendingIds: items.filter((item) => item.status === "pending").map((item) => item.id).slice(0, MAX_POLLED_RENDERS),
  };
}

// Applies a get_render result (one render) to the card's data.
export function mergeRender(data: RenderCardData, update: RenderCardData): RenderCardData {
  const [fresh] = rendersOf(update);
  if (!fresh) return data;
  if (!data.renders) {
    return data.id === fresh.id ? { ...data, ...fresh } : data;
  }
  const renders = data.renders.map((render) => (render.id === fresh.id ? { ...render, ...fresh } : render));
  return { ...data, renders, status: aggregateStatus(renders) };
}

// Polling a pending render: about 3.5 minutes in total, slowing down as it goes.
export const MAX_POLLS = 24;
export function nextPollDelay(attempt: number): number | undefined {
  if (attempt >= MAX_POLLS) return undefined;
  return Math.min(3000 + attempt * 1000, 10000);
}

// Size of the media box, in CSS pixels: the render's aspect ratio, never wider
// than the card or the render itself and never taller than maxHeight.
export function fitMedia(
  width: number | undefined,
  height: number | undefined,
  maxWidth: number,
  maxHeight: number,
): { width: number; height: number } | undefined {
  if (!width || !height || maxWidth <= 0 || maxHeight <= 0) return undefined;
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}
