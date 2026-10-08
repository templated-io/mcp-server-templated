import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cardView, fitMedia, mediaKind, mergeRender, nextPollDelay, normalizeStatus, safeUrl, toCardData,
  INLINE_GRID_LIMIT, MAX_POLLED_RENDERS, MAX_POLLS,
} from "./renderCard.js";

const APP = "https://app.templated.io";
const render = (over: Record<string, unknown> = {}) => ({
  id: "r1", url: "https://cdn.templated.media/render/r1.png", status: "COMPLETED", format: "png",
  width: 1080, height: 1080, templateId: "t1", templateName: "Summer Sale", ...over,
});

test("status names from the API map to completed, pending or failed", () => {
  assert.equal(normalizeStatus("COMPLETED"), "completed");
  assert.equal(normalizeStatus("PENDING"), "pending");
  assert.equal(normalizeStatus("processing"), "pending");
  assert.equal(normalizeStatus("FAILED"), "failed");
  assert.equal(normalizeStatus(undefined), "completed");
});

test("one render becomes flat card data with the editor link", () => {
  assert.deepEqual(toCardData(render(), { appUrl: APP }), {
    id: "r1", url: "https://cdn.templated.media/render/r1.png", status: "completed", format: "png",
    width: 1080, height: 1080, templateId: "t1", templateName: "Summer Sale",
    editorUrl: "https://app.templated.io/editor/t1",
  });
});

test("several renders go in renders[] with what they share at the top level", () => {
  const data = toCardData([
    render({ id: "a", page: "Insta Post" }),
    render({ id: "b", page: "Story", width: 1080, height: 1920, status: "PENDING" }),
  ], { appUrl: APP });
  assert.equal(data.status, "pending");
  assert.equal(data.format, "png");
  assert.equal(data.templateName, "Summer Sale");
  assert.equal(data.id, undefined);
  assert.deepEqual(data.renders?.map((r) => [r.id, r.page, r.status]), [["a", "Insta Post", "completed"], ["b", "Story", "pending"]]);
});

test("card data drops malformed fields and omits the editor link without an app URL", () => {
  const data = toCardData({ id: 7, status: "COMPLETED", width: "big", height: null, url: "", templateId: "t1" });
  assert.deepEqual(data, { id: "7", status: "completed", templateId: "t1" });
  assert.deepEqual(toCardData("nonsense"), { status: "failed" });
});

test("renders of different templates share no template fields", () => {
  const data = toCardData([render({ id: "a" }), render({ id: "b", templateId: "t2", templateName: "Other" })], { appUrl: APP });
  assert.equal(data.templateId, undefined);
  assert.equal(data.editorUrl, undefined);
});

test("media kind comes from the format, then from the URL", () => {
  assert.equal(mediaKind("png"), "image");
  assert.equal(mediaKind("JPG"), "image");
  assert.equal(mediaKind("webp"), "image");
  assert.equal(mediaKind("mp4"), "video");
  assert.equal(mediaKind("pdf"), "pdf");
  assert.equal(mediaKind(undefined, "https://cdn.templated.media/x/y.webp?v=1"), "image");
  assert.equal(mediaKind("html"), "file");
});

test("only https URLs are used in the card", () => {
  assert.equal(safeUrl("https://cdn.templated.media/a.png"), "https://cdn.templated.media/a.png");
  assert.equal(safeUrl("http://cdn.templated.media/a.png"), undefined);
  assert.equal(safeUrl("javascript:alert(1)"), undefined);
  assert.equal(safeUrl("data:image/png;base64,AAA"), undefined);
  assert.equal(safeUrl(42), undefined);
});

test("a single image shows size and format, with Download and Open in editor", () => {
  const view = cardView(toCardData(render(), { appUrl: APP }));
  assert.equal(view.state, "ready");
  assert.equal(view.layout, "single");
  assert.equal(view.title, "Summer Sale");
  assert.equal(view.meta, "1080 × 1080 · PNG");
  assert.equal(view.items[0].kind, "image");
  assert.equal(view.items[0].alt, "Summer Sale, 1080 × 1080 PNG");
  assert.equal(view.downloadUrl, "https://cdn.templated.media/render/r1.png");
  assert.equal(view.editorUrl, "https://app.templated.io/editor/t1");
});

test("a PDF and an MP4 are shown as their own kinds", () => {
  const pdf = cardView(toCardData(render({ format: "pdf", url: "https://cdn.templated.media/r1.pdf" })));
  assert.equal(pdf.items[0].kind, "pdf");
  assert.equal(pdf.meta, "1080 × 1080 · PDF");
  const mp4 = cardView(toCardData(render({ format: "mp4", url: "https://cdn.templated.media/r1.mp4" })));
  assert.equal(mp4.items[0].kind, "video");
  assert.equal(mp4.meta, "1080 × 1080 · MP4");
});

test("multi-page images use a grid and other formats a list", () => {
  const pages = ["Cover", "Inside", "Back"].map((page, i) => render({ id: `p${i}`, page }));
  const grid = cardView(toCardData(pages));
  assert.equal(grid.layout, "grid");
  assert.equal(grid.meta, "3 pages · 1080 × 1080 · PNG");
  assert.deepEqual(grid.items.map((item) => item.label), ["Cover", "Inside", "Back"]);
  assert.equal(grid.items[1].alt, "Summer Sale, Inside, 1080 × 1080 PNG");
  assert.equal(grid.downloadUrl, undefined, "no single file to download");

  const pdfs = cardView(toCardData(pages.map((p) => ({ ...p, format: "pdf" }))));
  assert.equal(pdfs.layout, "list");
  assert.equal(pdfs.meta, "3 pages · 1080 × 1080 · PDF");
  assert.ok(INLINE_GRID_LIMIT >= 3);
});

test("pending renders are listed for polling, capped per round", () => {
  const many = Array.from({ length: 12 }, (_, i) => render({ id: `r${i}`, status: "PENDING" }));
  const view = cardView(toCardData(many));
  assert.equal(view.state, "pending");
  assert.equal(view.pendingIds.length, MAX_POLLED_RENDERS);
  const single = cardView(toCardData(render({ status: "PENDING", format: "mp4" })));
  assert.equal(single.state, "pending");
  assert.deepEqual(single.pendingIds, ["r1"]);
  assert.equal(single.downloadUrl, undefined);
});

test("failed renders and empty results show the failed state", () => {
  assert.equal(cardView(toCardData(render({ status: "FAILED" }))).state, "failed");
  assert.equal(cardView(toCardData([])).state, "failed");
  assert.equal(cardView(undefined).state, "loading");
});

test("a polled render replaces the pending one", () => {
  const pending = toCardData([render({ id: "a", status: "PENDING" }), render({ id: "b" })]);
  const done = mergeRender(pending, toCardData(render({ id: "a" })));
  assert.equal(done.status, "completed");
  assert.equal(cardView(done).state, "ready");
  const single = mergeRender(toCardData(render({ status: "PENDING" })), toCardData(render()));
  assert.equal(single.status, "completed");
  assert.equal(mergeRender(single, toCardData(render({ id: "other" }))), single, "other renders are ignored");
});

test("polling slows down and stops after the cap", () => {
  assert.equal(nextPollDelay(0), 3000);
  assert.ok(nextPollDelay(5)! > nextPollDelay(0)!);
  assert.equal(nextPollDelay(MAX_POLLS - 1), 10000);
  assert.equal(nextPollDelay(MAX_POLLS), undefined);
});

test("media fits the card width and height without upscaling", () => {
  assert.deepEqual(fitMedia(1080, 1080, 600, 480), { width: 480, height: 480 });
  assert.deepEqual(fitMedia(1200, 630, 600, 480), { width: 600, height: 315 });
  assert.deepEqual(fitMedia(1080, 1920, 600, 480), { width: 270, height: 480 });
  assert.deepEqual(fitMedia(200, 100, 600, 480), { width: 200, height: 100 });
  assert.equal(fitMedia(undefined, 100, 600, 480), undefined);
});
