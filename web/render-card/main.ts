// Render preview card: an MCP App (ui://templated/render-card-v1.html) shown inline by
// Claude, ChatGPT and other MCP Apps hosts for create_render and get_render results.
// Built into one self-contained HTML file by scripts/build-ui.mjs.
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpAppClient, type HostContext } from "../../src/mcpAppClient.js";
import {
  cardView, formatLabel, mergeRender, nextPollDelay, toCardData, INLINE_GRID_LIMIT,
  type CardItem, type CardView, type RenderCardData,
} from "../../src/renderCard.js";

// --- state ------------------------------------------------------------------------

let data: RenderCardData | undefined;
let requestedFormat: string | undefined;
let problem: "error" | "cancelled" | undefined;
let pollAttempt = 0;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let pollStopped = false;
let host: HostContext = {};
const brokenMedia = new Set<string>();
const mediaNodes = new Map<string, HTMLElement>();

const root = document.getElementById("root")!;
const app = new McpAppClient(
  { name: "Templated render preview", version: "1.0.0" },
  { availableDisplayModes: ["inline", "fullscreen"] },
);

// --- host bridge ----------------------------------------------------------------

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// structuredContent is the card's input; the text result is a fallback for hosts that drop it.
function cardDataOf(result: CallToolResult): RenderCardData | undefined {
  if (isObject(result.structuredContent) && typeof result.structuredContent.status === "string") {
    return result.structuredContent as unknown as RenderCardData;
  }
  const text = result.content?.find((block) => block.type === "text");
  if (!text || text.type !== "text") return undefined;
  try {
    return toCardData(JSON.parse(text.text));
  } catch {
    return undefined;
  }
}

// Same effect as applyDocumentTheme and applyHostStyleVariables from the SDK:
// data-theme plus color-scheme, and the host's CSS variables on :root. Host fonts
// are not loaded, so the card makes no requests besides the render files.
function applyHost(changed: HostContext): void {
  host = { ...host, ...changed };
  const html = document.documentElement;
  const style = html.style;
  if (changed.theme === "light" || changed.theme === "dark") {
    html.setAttribute("data-theme", changed.theme);
    style.colorScheme = changed.theme;
  }
  for (const [name, value] of Object.entries(changed.styles?.variables ?? {})) {
    if (name.startsWith("--") && typeof value === "string") style.setProperty(name, value);
  }
  if (host.displayMode) html.setAttribute("data-display-mode", host.displayMode);
  const insets = host.safeAreaInsets;
  for (const side of ["top", "right", "bottom", "left"] as const) {
    style.setProperty(`--safe-${side}`, `${insets?.[side] ?? 0}px`);
  }
  // Inline cards auto-fit their content; keep the media within the host's height cap.
  const maxHeight = host.containerDimensions?.maxHeight;
  if (host.displayMode !== "fullscreen" && maxHeight) {
    style.setProperty("--media-max-h", `${Math.max(160, Math.min(480, maxHeight - 150))}px`);
  }
}

// Prefer the MCP Apps link API, then ChatGPT's own, then a plain new tab.
function openExternal(url: string): void {
  if (app.getHostCapabilities()?.openLinks) {
    app.openLink({ url }).catch(() => undefined);
    return;
  }
  const openai = (window as { openai?: { openExternal?: (o: { href: string; redirectUrl?: boolean }) => void } }).openai;
  if (openai?.openExternal) {
    openai.openExternal({ href: url, redirectUrl: false });
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

function canGoFullscreen(): boolean {
  return host.displayMode !== "fullscreen" && (host.availableDisplayModes ?? []).includes("fullscreen");
}

function stopPolling(): void {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = undefined;
}

// Async renders (long videos) start pending: ask get_render until they finish, with a cap.
function schedulePoll(): void {
  stopPolling();
  const pending = cardView(data).pendingIds;
  if (pending.length === 0 || !app.getHostCapabilities()?.serverTools) return;
  const delay = nextPollDelay(pollAttempt);
  if (delay === undefined) {
    pollStopped = true;
    render();
    return;
  }
  pollTimer = setTimeout(async () => {
    pollAttempt += 1;
    const before = JSON.stringify(data);
    for (const id of pending) {
      try {
        const update = cardDataOf(await app.callServerTool({ name: "get_render", arguments: { render_id: id } }));
        if (update && data) data = mergeRender(data, update);
      } catch {
        // try again on the next round
      }
    }
    // Re-render only on news, so assistive tech is not told the same thing again.
    if (JSON.stringify(data) !== before) render();
    schedulePoll();
  }, delay);
}

app.ontoolinput = ({ arguments: args }) => {
  if (typeof args?.format === "string") requestedFormat = args.format;
  render();
};

app.ontoolresult = (result) => {
  problem = result.isError ? "error" : undefined;
  data = result.isError ? undefined : cardDataOf(result);
  pollAttempt = 0;
  pollStopped = false;
  render();
  schedulePoll();
};

app.ontoolcancelled = () => {
  problem = "cancelled";
  render();
};

app.onhostcontextchanged = (changed) => {
  applyHost(changed);
  render();
};

app.onteardown = () => {
  stopPolling();
};

// --- rendering --------------------------------------------------------------------

type Attrs = Record<string, string | number | boolean | undefined>;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Node | string | undefined)[]) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children) if (child !== undefined) node.append(child);
  return node;
}

const SVG_NS = "http://www.w3.org/2000/svg";
function icon(paths: string[], size = 20): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [k, v] of Object.entries({
    width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
    "stroke-width": 1.5, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true",
  })) svg.setAttribute(k, String(v));
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}
const FILE_ICON = ["M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z", "M14 3v5h5"];
const PDF_ICON = [...FILE_ICON, "M9 13h6", "M9 17h4"];
const VIDEO_ICON = ["M4 6h11a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z", "M16 10l5-3v10l-5-3"];
const DOWNLOAD_ICON = ["M12 4v11", "M7 10l5 5 5-5", "M5 20h14"];
const EDIT_ICON = ["M14 4l6 6", "M4 20l1-5L15 5l4 4-10 10z"];
const ALERT_ICON = ["M12 8v5", "M12 16.5v.5", "M10.3 4.2L2.8 17.5A2 2 0 0 0 4.5 20.5h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z"];

const kindIcon = (item: CardItem, size?: number) =>
  icon(item.kind === "pdf" ? PDF_ICON : item.kind === "video" ? VIDEO_ICON : FILE_ICON, size);

function spinner(label?: string): HTMLElement {
  return el("div", { class: "placeholder", role: "status" }, el("div", { class: "spinner", "aria-hidden": "true" }), label);
}

// A link that the host opens (MCP Apps open-link), falling back to the browser.
function linkButton(label: string, url: string, variant: "primary" | "secondary", iconPaths?: string[]): HTMLAnchorElement {
  const link = el("a", { class: `btn ${variant}`, href: url, target: "_blank", rel: "noopener noreferrer" },
    iconPaths ? icon(iconPaths, 18) : undefined, label);
  link.addEventListener("click", (event) => {
    event.preventDefault();
    openExternal(url);
  });
  return link;
}

// A file the card cannot show (its host is outside the CSP, or it failed to load)
// keeps its Download button or clickable tile, which open the file itself.
const previewUnavailable = (item: CardItem) =>
  el("div", { class: "placeholder" }, kindIcon(item, 24), el("span", {}, "Preview unavailable"));

const canPreview = (item: CardItem) => Boolean(item.url) && !brokenMedia.has(item.url!);

// Images and videos are cached by URL so re-renders (theme change, polling) keep
// them loaded and a playing video keeps playing.
function mediaNode(item: CardItem, thumbnail: boolean): HTMLElement {
  if (!canPreview(item)) return previewUnavailable(item);
  const key = `${thumbnail ? "t" : "m"}|${item.url}`;
  const cached = mediaNodes.get(key);
  if (cached) return cached;
  const size = item.width && item.height ? { width: item.width, height: item.height } : {};
  const node: HTMLImageElement | HTMLVideoElement = item.kind === "video"
    ? el("video", {
      src: item.url, controls: !thumbnail, muted: thumbnail, playsinline: true, preload: "metadata",
      "aria-label": item.alt, ...size,
    })
    : el("img", { src: item.url, alt: item.alt, decoding: "async", loading: thumbnail ? "lazy" : undefined, ...size });
  node.addEventListener("error", () => {
    brokenMedia.add(item.url!);
    mediaNodes.delete(key);
    render();
  }, { once: true });
  mediaNodes.set(key, node);
  return node;
}

// The frame takes the render's aspect ratio before the file loads, so the card
// never jumps: as wide as the card allows, capped by the render size and --media-max-h.
function frame(item: CardItem, content: Node): HTMLElement {
  if (!item.width || !item.height) return el("div", { class: "frame free" }, content);
  const ratio = item.width / item.height;
  const box = el("div", { class: "frame" }, content);
  box.style.aspectRatio = `${item.width} / ${item.height}`;
  box.style.width = `min(100%, ${item.width}px, calc(var(--media-max-h) * ${ratio.toFixed(4)}))`;
  return box;
}

function singleMedia(item: CardItem, view: CardView): HTMLElement | undefined {
  if (item.kind === "pdf" || item.kind === "file") {
    return el("div", { class: "file" }, kindIcon(item, 36),
      el("div", { class: "text" }, el("p", { class: "title" }, view.title), el("p", { class: "meta" }, view.meta || formatLabel(item.format))));
  }
  if (item.status === "pending") {
    const box = frame(item, spinner(item.kind === "video" ? "Rendering the video…" : "Rendering…"));
    box.classList.add("waiting");
    return el("div", { class: "media" }, box);
  }
  if (item.status === "failed") return undefined;
  if (!canPreview(item)) return el("div", { class: "media" }, previewUnavailable(item));
  return el("div", { class: "media" }, frame(item, mediaNode(item, false)));
}

function tile(item: CardItem): HTMLElement {
  const content = item.status === "pending" ? spinner()
    : item.status === "failed" ? el("span", {}, "Failed")
    : mediaNode(item, true);
  const button = el("button", {
    class: "tile", type: "button", disabled: !item.url || item.status !== "completed",
    "aria-label": item.status === "completed" ? `Open ${item.label}` : `${item.label}: ${item.status}`,
  }, el("span", { class: "thumb" }, content), el("span", { class: "tile-label" }, item.label));
  button.addEventListener("click", () => item.url && openExternal(item.url));
  return button;
}

function row(item: CardItem): HTMLElement {
  const status = item.status === "completed" ? formatLabel(item.format) : item.status === "pending" ? "Rendering…" : "Failed";
  const content = [kindIcon(item), el("span", { class: "grow" }, item.label), el("span", { class: "meta" }, status)];
  if (item.status !== "completed" || !item.url) return el("li", {}, el("div", { class: "row" }, ...content));
  const link = el("a", { class: "row", href: item.url, target: "_blank", rel: "noopener noreferrer", "aria-label": `Open ${item.label}` }, ...content);
  link.addEventListener("click", (event) => {
    event.preventDefault();
    openExternal(item.url!);
  });
  return el("li", {}, link);
}

// Inline, long results show the first tiles and a count; fullscreen shows everything.
function collection(view: CardView): HTMLElement {
  const all = host.displayMode === "fullscreen" || view.items.length <= INLINE_GRID_LIMIT;
  const shown = all ? view.items : view.items.slice(0, INLINE_GRID_LIMIT - 1);
  const hidden = view.items.length - shown.length;
  if (view.layout === "list") {
    const list = el("ul", { class: "list" }, ...shown.map(row));
    if (hidden > 0) list.append(el("li", {}, moreButton(hidden, "row")));
    return list;
  }
  const grid = el("div", { class: "grid" }, ...shown.map(tile));
  if (hidden > 0) grid.append(moreButton(hidden, "tile"));
  return grid;
}

function moreButton(hidden: number, variant: "tile" | "row"): HTMLElement {
  const label = `+${hidden} more`;
  const fullscreen = canGoFullscreen();
  const button = el("button", { class: variant, type: "button", disabled: !fullscreen, "aria-label": fullscreen ? `Show all, ${label}` : label },
    variant === "tile" ? el("span", { class: "thumb more" }, label) : el("span", { class: "grow" }, label));
  button.addEventListener("click", () => {
    app.requestDisplayMode({ mode: "fullscreen" }).catch(() => undefined);
  });
  return button;
}

function actions(view: CardView): HTMLElement | undefined {
  const buttons: HTMLElement[] = [];
  if (view.downloadUrl) buttons.push(linkButton("Download", view.downloadUrl, "primary", DOWNLOAD_ICON));
  if (view.editorUrl) {
    buttons.push(linkButton("Open in editor", view.editorUrl, buttons.length ? "secondary" : "primary", EDIT_ICON));
  }
  return buttons.length ? el("div", { class: "actions" }, ...buttons) : undefined;
}

function note(view: CardView): HTMLElement | undefined {
  if (view.state === "pending") {
    const canPoll = app.getHostCapabilities()?.serverTools && !pollStopped;
    return el("p", { class: "note" }, canPoll
      ? "Still rendering. This card updates when the file is ready."
      : "Still rendering. Ask to check the render again in a minute.");
  }
  if (view.state === "failed") return el("p", { class: "note danger" }, "This render failed.");
  return undefined;
}

function card(): HTMLElement[] {
  if (problem) {
    return [el("div", { class: "file" }, icon(ALERT_ICON, 28), el("div", { class: "text" },
      el("p", { class: "title" }, problem === "cancelled" ? "Render cancelled" : "The render did not complete"),
      el("p", { class: "meta" }, problem === "cancelled" ? "Nothing was rendered." : "The details are in the conversation.")))];
  }
  const view = cardView(data);
  if (view.state === "loading") {
    const format = formatLabel(requestedFormat);
    const label = host.toolInfo?.tool.name === "get_render" ? "Checking the render…"
      : format ? `Rendering ${format}…` : "Rendering your design…";
    return [el("div", { class: "media" }, spinner(label))];
  }

  const parts: (HTMLElement | undefined)[] = [];
  const single = view.layout === "single" ? view.items[0] : undefined;
  const fileTile = single && (single.kind === "pdf" || single.kind === "file");
  if (single) parts.push(singleMedia(single, view));
  else parts.push(collection(view));

  const text = fileTile ? undefined
    : el("div", { class: "text" }, el("h1", { class: "title" }, view.title), view.meta ? el("p", { class: "meta" }, view.meta) : undefined);
  const buttons = actions(view);
  if (text || buttons) parts.push(el("div", { class: "body" }, text, buttons));
  parts.push(note(view));
  return parts.filter((part): part is HTMLElement => part !== undefined);
}

function render(): void {
  root.replaceChildren(...card());
}

// --- start ------------------------------------------------------------------------

render();
app.connect()
  .then(() => {
    applyHost(app.getHostContext());
    app.autoResize();
    render();
    schedulePoll();
  })
  .catch(() => {
    // Not inside an MCP Apps host: nothing to show beyond the loading state.
  });
