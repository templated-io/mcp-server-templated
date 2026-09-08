import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeToolResult } from "./sanitize.js";

test("get_account keeps usage numbers and drops identity and plan", () => {
  const out = sanitizeToolResult("get_account", {
    email: "x@y.z", name: "Jane", teamName: "Jane's Team",
    apiUsage: 10, apiQuota: 100, usagePercentage: 10, plan: "Enterprise",
  });
  assert.deepEqual(out, { apiUsage: 10, apiQuota: 100, usagePercentage: 10 });
});

test("templates drop owner ids, markup and internal flags", () => {
  const raw = {
    id: "t1", name: "Post", width: 1080, height: 1080, thumbnail: "https://cdn/x.png",
    userId: "u1", teamId: "team1", html: "<div/>", externalId: "cust-9", removed: false,
    ranking: 3, isMaster: false, sourceTemplateId: "t0", layers: [{ layer: "title" }],
  };
  const single = sanitizeToolResult("get_template", raw) as Record<string, unknown>;
  assert.deepEqual(Object.keys(single).sort(), ["height", "id", "layers", "name", "thumbnail", "width"]);

  const list = sanitizeToolResult("list_templates", [raw]) as Record<string, unknown>[];
  assert.equal(list[0].userId, undefined);
  assert.equal(list[0].id, "t1");

  const wrapped = sanitizeToolResult("list_templates", { templates: [raw], page: 1, total: 1 }) as Record<string, unknown>;
  assert.equal(wrapped.page, 1);
  assert.equal((wrapped.templates as Record<string, unknown>[])[0].html, undefined);
});

test("renders drop payload, storage and duplicate urls in every response shape", () => {
  const raw = {
    id: "r1", url: "https://cdn/r1.png", render_url: "https://api/r1", storage_url: "s3://bucket/r1",
    status: "COMPLETED", format: "png", templateId: "t1", payload: { webhook_url: "https://hook" },
    externalId: "cust-9", removed: false, createdAt: "2026-01-01",
  };
  assert.deepEqual(sanitizeToolResult("get_render", raw), {
    id: "r1", url: "https://cdn/r1.png", status: "COMPLETED", format: "png", templateId: "t1", createdAt: "2026-01-01",
  });
  const multi = sanitizeToolResult("create_render", { url: "https://cdn/zip", download_page_url: "https://app/d#x", renders: [raw] }) as Record<string, unknown>;
  assert.deepEqual(Object.keys(multi).sort(), ["renders", "url"]);
  assert.equal((multi.renders as Record<string, unknown>[])[0].payload, undefined);
  const list = sanitizeToolResult("list_renders", [raw]) as Record<string, unknown>[];
  assert.equal(list[0].storage_url, undefined);
});

test("folders, uploads and fonts drop user and team ids", () => {
  assert.deepEqual(sanitizeToolResult("create_folder", { id: "f1", name: "Q1", userId: "u", teamId: "t", templateCount: 0 }),
    { id: "f1", name: "Q1", templateCount: 0 });
  assert.deepEqual(sanitizeToolResult("create_upload", { id: "up1", name: "a.png", path: "https://cdn/a.png", userId: "u", teamId: "t", externalId: "e" }),
    { id: "up1", name: "a.png", path: "https://cdn/a.png" });
  assert.deepEqual(sanitizeToolResult("upload_font", { name: "Inter", isUploadedFont: true, teamId: "t", path: "s3://x" }),
    { name: "Inter", isUploadedFont: true });
});

test("layers, pages and unknown tools pass through untouched", () => {
  const layers = [{ layer: "title", type: "text", text: "Hi" }];
  assert.deepEqual(sanitizeToolResult("get_template_layers", layers), layers);
  assert.deepEqual(sanitizeToolResult("something_new", { any: 1 }), { any: 1 });
});
