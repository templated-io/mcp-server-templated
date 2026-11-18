import { test } from "node:test";
import assert from "node:assert/strict";
import { tools, handleToolCall, ToolContent, MAX_INLINE_PDF_BYTES } from "./tools.js";
import { SERVER_INSTRUCTIONS } from "./prompts.js";
import type { RequestContext } from "./context.js";

const ctx = (apiKey: string, folderId: string | null = null): RequestContext =>
  ({ apiKey, folderId, externalId: null });

test("tools list is intact (25 tools, create_render present)", () => {
  assert.equal(tools.length, 25);
  assert.ok(tools.some((t) => t.name === "create_render"));
});

test("concurrent tool calls from different tenants keep their own keys", async () => {
  const byKey: Record<string, string[]> = {};
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    const key = init.headers["Authorization"];
    (byKey[key] ??= []).push(String(url));
    await gate;
    return { ok: true, text: async () => JSON.stringify({ email: "x@y.z" }) } as any;
  }) as typeof fetch;
  try {
    const a = handleToolCall(ctx("key-A"), "get_account", {});
    const b = handleToolCall(ctx("key-B"), "get_account", {});
    release();
    await Promise.all([a, b]);
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(byKey["Bearer key-A"].length, 1);
  assert.equal(byKey["Bearer key-B"].length, 1);
});

test("folder scoping still applies through the context", async () => {
  const urls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: any) => {
    urls.push(String(url));
    return { ok: true, text: async () => JSON.stringify({ renders: [] }) } as any;
  }) as typeof fetch;
  try {
    await handleToolCall(ctx("k", "fold-1"), "list_renders", {});
  } finally {
    globalThis.fetch = original;
  }
  assert.ok(urls[0].includes("/v1/folder/fold-1/renders"));
});

// Captures every HTTP call a tool makes so tests can assert on the body/params
// the MCP server actually forwards to the REST API.
const captureCalls = async (
  name: string,
  args: Record<string, unknown>,
  response: unknown = { id: "tpl-new" },
) => {
  const calls: { url: string; method: string; body: any }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(init.body) : undefined,
    });
    return { ok: true, text: async () => JSON.stringify(response) } as any;
  }) as typeof fetch;
  try {
    await handleToolCall(ctx("k"), name, args);
  } finally {
    globalThis.fetch = original;
  }
  return calls;
};

const schemaOf = (name: string) =>
  (tools.find((t) => t.name === name)!.inputSchema as any).properties;

const pages = [
  { page: "Square", width: 1080, height: 1080, layers: { title: { type: "text", text: "A" } } },
  { page: "Story", width: 1080, height: 1920, layers: { title: { type: "text", text: "B" } } },
];

test("template tools declare the text autofit fields and forward them to the API", async () => {
  const layerProps = (name: string) => (schemaOf(name).layers as any).items.properties;
  const pageLayerProps = (name: string) => (schemaOf(name).pages as any).items.properties.layers.additionalProperties.properties;
  for (const name of ["create_template", "update_template"]) {
    for (const props of [layerProps(name), pageLayerProps(name)]) {
      assert.deepEqual(props.autofit.enum, ["height", "width"], name);
      assert.equal(props.max_font_size.type, "number", name);
      assert.equal(props.min_font_size.type, "number", name);
    }
  }
  assert.match(tools.find((t) => t.name === "create_template")!.description!, /autofit/);
  assert.match((schemaOf("create_render").layers as any).description, /autofit/);

  const layers = [{ layer: "title", type: "text", text: "20% OFF", x: 0, y: 0, width: 680, height: 230, autofit: "height", max_font_size: 190 }];
  const calls = await captureCalls("create_template", { name: "t", width: 1080, height: 1080, layers });
  const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/v1/template"));
  assert.ok(post, "expected POST /v1/template");
  assert.deepEqual(post!.body.layers, layers);
});

test("create_template declares pages and forwards it to POST /v1/template", async () => {
  assert.ok(schemaOf("create_template").pages, "inputSchema must declare pages");

  const calls = await captureCalls("create_template", { name: "t", width: 1080, height: 1080, pages });
  const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/v1/template"));
  assert.ok(post, "must POST /v1/template");
  assert.deepEqual(post.body.pages, pages);
});

test("update_template declares pages and forwards pages, background and duration", async () => {
  const props = schemaOf("update_template");
  assert.ok(props.pages, "inputSchema must declare pages");

  const calls = await captureCalls("update_template", {
    template_id: "tpl-1", pages, background: "#fff", duration: 5000,
  });
  const put = calls.find((c) => c.method === "PUT" && c.url.includes("/v1/template/tpl-1"));
  assert.ok(put, "must PUT /v1/template/tpl-1");
  assert.deepEqual(put.body.pages, pages);
  assert.equal(put.body.background, "#fff");
  assert.equal(put.body.duration, 5000);
});

test("clone_template sends name as a query param to the clone endpoint", async () => {
  const calls = await captureCalls("clone_template", { template_id: "tpl-1", name: "My Clone" });
  const post = calls.find((c) => c.method === "POST" && c.url.includes("/v1/template/tpl-1/clone"));
  assert.ok(post, "must POST /v1/template/tpl-1/clone");
  assert.equal(new URL(post.url).searchParams.get("name"), "My Clone");
});

test("tool results are sanitized before reaching the model", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    text: async () => JSON.stringify({ email: "x@y.z", name: "Jane", plan: "Enterprise", apiUsage: 1, apiQuota: 10, usagePercentage: 10 }),
  })) as any;
  try {
    const result = await handleToolCall(ctx("k"), "get_account", {});
    assert.deepEqual(result, { apiUsage: 1, apiQuota: 10, usagePercentage: 10 });
  } finally {
    globalThis.fetch = original;
  }
});

test("merge_renders, delete_upload and delete_font call the endpoints the API exposes", async () => {
  const merge = await captureCalls("merge_renders", { render_ids: ["r1", "r2"] });
  assert.ok(merge[0].url.endsWith("/v1/render/merge"));
  assert.deepEqual(merge[0].body, { ids: ["r1", "r2"], host: true });

  const del = await captureCalls("delete_upload", { upload_id: "up-1" });
  assert.equal(del[0].method, "DELETE");
  assert.ok(del[0].url.endsWith("/v1/uploads?ids=up-1"));

  const font = await captureCalls("delete_font", { font_name: "My Font" });
  assert.equal(font[0].method, "DELETE");
  assert.ok(font[0].url.endsWith("/v1/fonts?fonts=My+Font"));
  assert.ok(schemaOf("delete_font").font_name, "delete_font takes the font name");
});

test("create_upload and upload_font fetch the URL and post it as multipart", async () => {
  const calls: { url: string; form?: FormData }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), form: init?.body instanceof FormData ? init.body : undefined });
    if (String(url).startsWith("https://93.184.216.34/")) {
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "font/woff2" } });
    }
    return { ok: true, text: async () => JSON.stringify({ id: "up-1", name: "logo.png", userId: "u" }) } as any;
  }) as typeof fetch;
  try {
    const upload = await handleToolCall({ apiKey: "k", folderId: null, externalId: "cust-9" }, "create_upload", {
      url: "https://93.184.216.34/logo.png", name: "brand",
    });
    assert.deepEqual(upload, { id: "up-1", name: "logo.png" });
    const post = calls.find((c) => c.url.endsWith("/v1/upload"));
    assert.ok(post?.form, "must POST multipart to /v1/upload");
    assert.equal((post!.form!.get("file") as File).name, "brand.png");
    assert.equal(post!.form!.get("externalId"), "cust-9");

    calls.length = 0;
    await handleToolCall(ctx("k"), "upload_font", { url: "https://93.184.216.34/download?id=7", name: "Inter" });
    const fontPost = calls.find((c) => c.url.endsWith("/v1/font"));
    assert.equal((fontPost!.form!.get("file") as File).name, "Inter.woff2");
  } finally {
    globalThis.fetch = original;
  }
});

// Routes each API call to a handler so a test can answer several endpoints.
type Call = { url: URL; method: string; body: any };
const withApi = async <T>(
  route: (call: Call) => Response | unknown,
  fn: (calls: Call[]) => Promise<T>,
): Promise<T> => {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    const call = { url: new URL(String(url)), method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const answer = route(call);
    return answer instanceof Response ? answer : new Response(JSON.stringify(answer), { status: 200 });
  }) as typeof fetch;
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

test("IDs are encoded into API paths so they cannot reach other endpoints", async () => {
  const calls = await captureCalls("delete_render", { render_id: "../template/X" }, {});
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).pathname, "/v1/render/..%2Ftemplate%2FX");

  const idTools: [string, Record<string, unknown>][] = [
    ["get_render", { render_id: "a/b" }], ["get_template", { template_id: "a/b" }],
    ["get_template_layers", { template_id: "a/b" }], ["get_template_pages", { template_id: "a/b" }],
    ["update_template", { template_id: "a/b", name: "x" }], ["clone_template", { template_id: "a/b" }],
    ["delete_template", { template_id: "a/b" }], ["list_template_renders", { template_id: "a/b" }],
    ["update_folder", { folder_id: "a/b", name: "x" }], ["delete_folder", { folder_id: "a/b" }],
  ];
  for (const [name, args] of idTools) {
    const [call] = await captureCalls(name, args, { id: "c1" });
    assert.ok(call.url.includes("a%2Fb") && !call.url.includes("/a/b"), `${name}: ${call.url}`);
  }

  // "." and ".." survive encodeURIComponent and would be resolved as path segments
  for (const id of ["..", "."]) {
    const dots = await captureCalls("get_template", { template_id: id }).catch((e: Error) => e);
    assert.ok(dots instanceof Error && /template_id/.test(dots.message), `${id} must be rejected`);
  }
});

test("missing required parameters are reported before any API call", async () => {
  await withApi(() => ({}), async (calls) => {
    await assert.rejects(() => handleToolCall(ctx("k"), "get_template", {}), /Missing required parameter "template_id".*list_templates/);
    await assert.rejects(() => handleToolCall(ctx("k"), "merge_renders", { render_ids: [] }), /"render_ids".*list_renders/);
    await assert.rejects(() => handleToolCall(ctx("k"), "create_render", undefined as any), /"template"/);
    assert.equal(calls.length, 0);
  });
});

test("API errors name the resource and the tool that lists valid IDs", async () => {
  await withApi(() => json(404, { status: 404, error: "Not Found" }), async () => {
    await assert.rejects(
      () => handleToolCall(ctx("k"), "get_template", { template_id: "nope" }),
      /Template nope not found in the connected Templated account \(HTTP 404\)\. Call list_templates/,
    );
    await assert.rejects(() => handleToolCall(ctx("k"), "get_render", { render_id: "r-x" }), /Render r-x not found.*list_renders/);
  });
});

const layersOf = [
  { layer: "title", type: "text", locked: false },
  { layer: "subtitle", type: "text", locked: false },
  { layer: "photo", type: "image", locked: false, group: "hero" },
  { layer: "logo", type: "image", locked: true },
];

test("create_render rejects unknown layer names with the valid ones and renders nothing", async () => {
  await withApi((call) => (call.url.pathname.endsWith("/layers") ? layersOf : { id: "r1" }), async (calls) => {
    await assert.rejects(
      () => handleToolCall(ctx("k"), "create_render", {
        template: "tpl-1", layers: { titulo: { text: "Oi" }, Photo: { image_url: "https://x/y.png" }, title: { text: "ok" } },
      }),
      (error: Error) => {
        assert.match(error.message, /"titulo"/);
        assert.match(error.message, /"Photo" \(did you mean "photo"\?\)/);
        assert.match(error.message, /Nothing was rendered/);
        assert.match(error.message, /Valid layer names: title, subtitle, photo\./);
        assert.doesNotMatch(error.message, /logo/, "locked layers are not offered");
        return true;
      },
    );
    const layersCall = calls.find((c) => c.url.pathname === "/v1/template/tpl-1/layers");
    assert.equal(layersCall?.url.searchParams.get("includeLockedLayers"), "true");
    assert.ok(!calls.some((c) => c.url.pathname === "/v1/render"), "must not render");
  });
});

test("create_render accepts locked layers and group names, and renders", async () => {
  await withApi((call) => (call.url.pathname.endsWith("/layers") ? layersOf : { id: "r1", url: "https://cdn/r1.jpg" }), async (calls) => {
    const result = await handleToolCall(ctx("k"), "create_render", {
      template: "tpl-1", layers: { title: { text: "Hi" }, logo: { hide: true }, hero: { hide: false } },
    });
    assert.deepEqual(result, { id: "r1", url: "https://cdn/r1.jpg" });
    const render = calls.find((c) => c.url.pathname === "/v1/render");
    assert.deepEqual(render?.body.layers, { title: { text: "Hi" }, logo: { hide: true }, hero: { hide: false } });
  });
});

test("create_render still renders when the layer lookup itself fails", async () => {
  await withApi((call) => (call.url.pathname.endsWith("/layers") ? json(500, { error: "Internal Server Error" }) : { id: "r1" }), async (calls) => {
    await handleToolCall(ctx("k"), "create_render", { template: "tpl-1", layers: { anything: { text: "x" } } });
    assert.ok(calls.some((c) => c.url.pathname === "/v1/render"));
  });
});

const pagesOf = [
  { page: "Square", width: 1080, height: 1080, layers: { title: { type: "text" }, photo: { type: "image" } } },
  { page: "Story", width: 1080, height: 1920, layers: { title: { type: "text" }, cta: { type: "text", group: "footer" } } },
];

test("create_render validates pages against each page's own layers", async () => {
  await withApi((call) => (call.url.pathname.endsWith("/pages") ? pagesOf : { renders: [] }), async (calls) => {
    await assert.rejects(
      () => handleToolCall(ctx("k"), "create_render", {
        template: "tpl-2",
        pages: [{ page: "Square", layers: { cta: { text: "Go" } } }, { page: "Banner", layers: {} }],
      }),
      (error: Error) => {
        assert.match(error.message, /no page named "Banner"/);
        assert.match(error.message, /Valid page names: Square, Story\./);
        assert.match(error.message, /Page "Square" has no layer named "cta"/);
        assert.match(error.message, /Valid layer names on that page: title, photo\./);
        return true;
      },
    );
    assert.equal(calls.find((c) => c.url.pathname.endsWith("/pages"))?.url.searchParams.get("includeLockedLayers"), "true");
    assert.ok(!calls.some((c) => c.url.pathname === "/v1/render"));

    calls.length = 0;
    const pages = [{ page: "Story", layers: { cta: { text: "Go" }, footer: { hide: false } } }];
    await handleToolCall(ctx("k"), "create_render", { template: "tpl-2", pages });
    const render = calls.find((c) => c.url.pathname === "/v1/render");
    assert.deepEqual(render?.body.pages, pages);
    assert.equal(render?.body.layers, undefined);
  });
});

test("create_render refuses layers and pages together (the API would ignore layers)", async () => {
  await withApi(() => ({}), async (calls) => {
    await assert.rejects(
      () => handleToolCall(ctx("k"), "create_render", { template: "t", layers: { a: {} }, pages: [{ page: "P", layers: {} }] }),
      /either layers or pages/,
    );
    assert.equal(calls.length, 0);
  });
});

test("merge_renders with host false returns a small PDF as an embedded resource", async () => {
  const pdf = new TextEncoder().encode("%PDF-1.7\n" + "x".repeat(2048));
  const pdfResponse = (bytes: Uint8Array<ArrayBuffer>) => new Response(bytes, {
    status: 200,
    headers: { "content-type": "application/pdf", "content-disposition": 'form-data; name="attachment"; filename="merged_renders.pdf"' },
  });
  await withApi(() => pdfResponse(pdf), async (calls) => {
    const result = await handleToolCall(ctx("k"), "merge_renders", { render_ids: ["r1", "r2"], host: false });
    assert.deepEqual(calls[0].body, { ids: ["r1", "r2"], host: false });
    assert.ok(result instanceof ToolContent);
    const resource = result.content.find((c) => c.type === "resource") as any;
    assert.equal(resource.resource.mimeType, "application/pdf");
    assert.match(resource.resource.uri, /merged_renders\.pdf$/);
    assert.deepEqual([...Buffer.from(resource.resource.blob, "base64")], [...pdf]);
  });

  const big = new Uint8Array(MAX_INLINE_PDF_BYTES + 1);
  await withApi(() => pdfResponse(big), async () => {
    await assert.rejects(
      () => handleToolCall(ctx("k"), "merge_renders", { render_ids: ["r1"], host: false }),
      /too large to return inline.*host set to true/,
    );
  });
});

test("every list tool caps limit at 100 and sends an explicit default of 25", async () => {
  for (const name of ["list_renders", "list_templates", "list_template_renders", "list_uploads", "list_folders", "list_fonts"]) {
    const limit = schemaOf(name).limit;
    assert.equal(limit.maximum, 100, `${name} limit.maximum`);
    assert.match(limit.description, /25/, `${name} documents the default`);
  }
  const extra = { list_template_renders: { template_id: "t1" } } as Record<string, Record<string, unknown>>;
  for (const name of ["list_renders", "list_templates", "list_template_renders", "list_uploads"]) {
    const [byDefault] = await captureCalls(name, { ...extra[name] }, []);
    const params = new URL(byDefault.url).searchParams;
    assert.equal(params.get("limit"), "25", `${name} default`);
    assert.equal(params.get("page"), "0", `${name} page`);
    const [capped] = await captureCalls(name, { ...extra[name], limit: 1000, page: -3 }, []);
    assert.equal(new URL(capped.url).searchParams.get("limit"), "100", `${name} cap`);
    assert.equal(new URL(capped.url).searchParams.get("page"), "0", `${name} page floor`);
  }
});

test("list_templates on an account with no templates points the model at create_template", async () => {
  await withApi(() => [], async () => {
    const out = await handleToolCall(ctx("k"), "list_templates", {});
    assert.ok(out instanceof ToolContent);
    const body = JSON.parse((out.content[0] as { text: string }).text);
    assert.deepEqual(body.templates, []);
    assert.match(body.message, /create_template/);
  });
});

test("list_templates stays a plain empty list when a filter, a later page or a scope explains it", async () => {
  await withApi(() => [], async () => {
    for (const args of [{ query: "x" }, { width: 1080 }, { height: 1080 }, { tags: "a" }, { page: 1 }]) {
      assert.deepEqual(await handleToolCall(ctx("k"), "list_templates", args), [], JSON.stringify(args));
    }
    assert.deepEqual(await handleToolCall(ctx("k", "fold-1"), "list_templates", {}), [], "folder");
    assert.deepEqual(await handleToolCall({ apiKey: "k", folderId: null, externalId: "e" }, "list_templates", {}), [], "external id");
  });
});

test("list results are cut to the page size when the API ignores paging", async () => {
  const templates = Array.from({ length: 40 }, (_, i) => ({ id: `t${i}`, name: `T${i}` }));
  await withApi(() => templates, async () => {
    const page0 = await handleToolCall(ctx("k"), "list_templates", { query: "T", limit: 10 }) as any[];
    assert.deepEqual(page0.map((t) => t.id), ["t0", "t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9"]);
    const page2 = await handleToolCall(ctx("k"), "list_templates", { query: "T", limit: 10, page: 2 }) as any[];
    assert.equal(page2[0].id, "t20");
  });
});

test("list_folders pages locally because the API returns every folder", async () => {
  const folders = Array.from({ length: 30 }, (_, i) => ({ id: `f${i}`, name: `F${i}`, templateCount: i, teamId: "team" }));
  await withApi(() => folders, async () => {
    const out = await handleToolCall(ctx("k"), "list_folders", { limit: 10, page: 2 }) as any;
    assert.deepEqual(out.folders.map((f: any) => f.id), ["f20", "f21", "f22", "f23", "f24", "f25", "f26", "f27", "f28", "f29"]);
    assert.equal(out.total, 30);
    assert.equal(out.hasMore, false);
    assert.equal(out.folders[0].teamId, undefined);
  });
});

test("list_fonts returns the team's uploaded fonts unless Google Fonts are asked for", async () => {
  const google = Array.from({ length: 60 }, (_, i) => ({ name: `Google ${i}`, isGoogleFont: true, isUploadedFont: false, createdAt: null }));
  const api = [
    { name: "Brand Sans", isGoogleFont: false, isUploadedFont: true, createdAt: null, externalId: null },
    { name: "Brand Sans", isGoogleFont: false, isUploadedFont: true, createdAt: null, externalId: null },
    { name: "Roboto", isGoogleFont: true, isUploadedFont: false, createdAt: null },
    ...google,
  ];
  await withApi(() => api, async () => {
    const own = await handleToolCall(ctx("k"), "list_fonts", {}) as any;
    assert.deepEqual(own, { fonts: [{ name: "Brand Sans", isGoogleFont: false, isUploadedFont: true }], page: 0, limit: 25, total: 1, hasMore: false });

    const search = await handleToolCall(ctx("k"), "list_fonts", { include_google_fonts: true, query: "robo" }) as any;
    assert.deepEqual(search.fonts.map((f: any) => f.name), ["Roboto"]);

    const all = await handleToolCall(ctx("k"), "list_fonts", { include_google_fonts: true, page: 1 }) as any;
    assert.equal(all.total, 62);
    assert.equal(all.fonts.length, 25);
    assert.equal(all.hasMore, true);
  });
  assert.ok(schemaOf("list_fonts").include_google_fonts, "include_google_fonts is declared");
  assert.ok(schemaOf("list_fonts").query, "query is declared");
});

// Every description string the model reads: tool descriptions plus nested schema text.
const descriptionsOf = (value: unknown, out: string[] = []): string[] => {
  if (Array.isArray(value)) value.forEach((v) => descriptionsOf(v, out));
  else if (value && typeof value === "object") {
    for (const [key, v] of Object.entries(value)) {
      if (key === "description" && typeof v === "string") out.push(v);
      else descriptionsOf(v, out);
    }
  }
  return out;
};

test("descriptions and instructions use neutral wording", () => {
  const texts = [...descriptionsOf(tools), SERVER_INSTRUCTIONS];
  for (const text of texts) {
    assert.doesNotMatch(text, /\b(IMPORTANT|REQUIRED|MUST|NOT|INSTEAD|REMOVES|ALWAYS|NEVER)\b/, text);
    assert.doesNotMatch(text, /!/, text);
    assert.doesNotMatch(text, /main tool/i, text);
  }
  for (const tool of tools) {
    assert.match(tool.description ?? "", /Use this/, `${tool.name} says when to use it`);
  }
  assert.match(tools.find((t) => t.name === "create_render")!.description!, /not AI image generation/);
});

test("delete tools say what is permanent and what is kept", () => {
  const describe = (name: string) => tools.find((t) => t.name === name)!.description!;
  for (const name of ["delete_render", "delete_template", "delete_upload", "delete_font"]) {
    assert.match(describe(name), /permanently/i, name);
  }
  assert.match(describe("delete_template"), /renders already created from it are kept/i);
  assert.match(describe("delete_folder"), /templates inside it are not deleted/i);
});

test("every tool keeps its title and explicit hints", () => {
  for (const tool of tools) {
    const a = tool.annotations!;
    assert.ok(a.title, `${tool.name} title`);
    for (const hint of ["readOnlyHint", "destructiveHint", "openWorldHint"] as const) {
      assert.equal(typeof a[hint], "boolean", `${tool.name} ${hint}`);
    }
    assert.equal(a.readOnlyHint && a.destructiveHint, false, `${tool.name} cannot be read-only and destructive`);
    if (/^(list|get)_/.test(tool.name)) assert.equal(a.readOnlyHint, true, `${tool.name} is read-only`);
    if (/^delete_/.test(tool.name)) assert.equal(a.destructiveHint, true, `${tool.name} is destructive`);
  }
});
