#!/usr/bin/env node
// Writes docs/tools.md, the tool reference that directory reviewers (Meta Muse,
// Cursor, xAI) read: every tool with its inputs, output, permission class and
// side effects. Run after `npm run build`: node scripts/tools-doc.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { tools } = await import(join(root, "dist", "tools.js"));

// Sensitive writes are the deletes that can't be undone from Templated.
// delete_folder is a plain write: the templates inside it are kept.
const SENSITIVE = new Set(["delete_render", "delete_template", "delete_upload", "delete_font"]);

const SIDE_EFFECTS = {
  create_render: "Creates a render (a file on the Templated CDN) and counts toward the account's monthly render usage. Fetches the image URLs passed in layers.",
  get_render: "None.",
  list_renders: "None.",
  delete_render: "Permanently deletes the render from the account. Cannot be undone.",
  merge_renders: "Creates a new PDF from existing renders and counts toward the account's render usage. The original renders are not changed.",
  list_templates: "None.",
  get_template: "None.",
  get_template_layers: "None.",
  get_template_pages: "None.",
  create_template: "Creates a new template in the account. Fetches the image URLs passed in layers.",
  update_template: "Changes the template in place. With replaceLayers set to true, layers missing from the request are deleted; a page sent with hide set to true is deleted. Renders already made are not changed.",
  clone_template: "Creates a copy of the template. The original is not changed.",
  delete_template: "Permanently deletes the template; it can no longer be rendered. Renders already made are kept. Cannot be undone.",
  list_template_renders: "None.",
  list_folders: "None.",
  create_folder: "Creates a folder.",
  update_folder: "Renames the folder.",
  delete_folder: "Deletes the folder only. The templates inside it move to the top level of the account and are not deleted.",
  list_uploads: "None.",
  create_upload: "Downloads the image from the given public URL and stores it in the account's uploads.",
  delete_upload: "Permanently deletes the uploaded image from the account. Cannot be undone.",
  list_fonts: "None.",
  upload_font: "Downloads the font file from the given public URL and adds it to the account's custom fonts.",
  delete_font: "Permanently deletes every file of the custom font family; templates that use it fall back to another font in later renders. Cannot be undone.",
  get_account: "None.",
};

function permission(tool) {
  if (tool.annotations?.readOnlyHint) return "Read";
  return SENSITIVE.has(tool.name) ? "Sensitive write" : "Write";
}

function typeOf(schema) {
  if (schema.enum) return schema.enum.map((v) => `\`${v}\``).join(" | ");
  if (schema.type === "array") return `array of ${schema.items?.type ?? "values"}`;
  return schema.type ?? "object";
}

const cell = (text) => (text ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

const missing = tools.map((t) => t.name).filter((n) => !(n in SIDE_EFFECTS));
if (missing.length) {
  console.error(`No side-effect text for: ${missing.join(", ")}`);
  process.exit(1);
}

const counts = { Read: 0, Write: 0, "Sensitive write": 0 };
for (const t of tools) counts[permission(t)]++;

let md = `# Templated MCP server: tool reference

Generated from the server's tool definitions by \`scripts/tools-doc.mjs\`.

Templated renders images (PNG, JPG, WebP), PDFs and MP4 videos from templates: it fills a saved design with the exact text, images and colors it is given. It is template rendering, not AI image generation.

## Setup

- **Endpoint:** \`https://mcp.templated.io/mcp\` (MCP Streamable HTTP, production). There is no separate test environment; reviewers use a dedicated test account in production.
- **Authentication:** OAuth 2.1 with PKCE (S256). Authorization server metadata: \`https://api.templated.io/.well-known/oauth-authorization-server\`; protected resource metadata: \`https://mcp.templated.io/.well-known/oauth-protected-resource\`. Dynamic client registration (RFC 7591) is supported, and pre-registered clients are available on request.
- **Sign-in:** the user signs in to their Templated account (email and password, or Google) and approves access on the consent page. New users can create an account there.
- **Scopes:** no OAuth scopes. A connection has access to the connected Templated account's templates, renders, folders, uploads and fonts, and to nothing else. The token is tied to the account's API key: regenerating the API key in Templated revokes every connection.
- **Setup guide:** https://templated.io/docs/integrations/mcp/
- **Automations:** an API key can be sent as \`Authorization: Bearer <key>\` instead of OAuth.

## Permissions

${counts.Read} tools are **Read**, ${counts.Write} are **Write** and ${counts["Sensitive write"]} are **Sensitive write**. Read tools never change data. Write tools create or change items in the user's own Templated account and never send, publish or share anything with other people. Sensitive writes are the deletes that cannot be undone. No tool makes purchases, moves money, sends messages or posts to social networks. Render usage is counted against the plan the user already has; no tool changes a plan or charges a payment method.

| Tool | Permission | Side effects |
|---|---|---|
${tools.map((t) => `| \`${t.name}\` | ${permission(t)} | ${cell(SIDE_EFFECTS[t.name])} |`).join("\n")}

## Status handling

\`create_render\` waits for the file and returns each render with its \`status\` (\`COMPLETED\`, \`PENDING\` or \`FAILED\`) and URL; a multi-page template returns one render per page. \`get_render\` returns the current status of any render, so a client can check a pending render, or one whose call timed out, before rendering again and avoid duplicates. \`merge_renders\` returns the URL of the merged PDF.

## Errors

Errors are returned as tool results with \`isError\` set and a message that names the problem and the next step, for example:

- a layer name the template doesn't have, with the list of valid names (nothing is rendered);
- a template, render, folder, upload or font ID that isn't in the connected account, with the tool to call for valid IDs;
- an image or font URL that can't be fetched (private network addresses are refused);
- an expired or revoked connection (HTTP 401): reconnect Templated;
- the account's render limit reached: the message says the account can't render more right now, without promoting plans.

## Limits

- Each render and each merge counts toward the account's monthly render quota (\`get_account\` returns the usage).
- One update at a time per template: a concurrent \`update_template\` on the same template returns HTTP 429 with a retry hint.
- Renders: 100 to 5000 pixels per side; videos up to 90 seconds; uploads up to 10 MB; \`merge_renders\` with \`host\` set to false returns the PDF inline only up to 100 KB.
- List tools return up to 100 items per page.

## Data

The server stores nothing of its own: each call is forwarded to the Templated API for the connected account and the result is returned. Tool results contain the account's templates, renders and assets, and no personal data such as names or email addresses. Privacy policy: https://templated.io/privacy/

## Tools

`;

for (const t of tools) {
  const props = Object.entries(t.inputSchema.properties ?? {});
  const required = new Set(t.inputSchema.required ?? []);
  md += `### \`${t.name}\`\n\n**${t.annotations?.title ?? t.name}** · ${permission(t)}\n\n${t.description}\n\n`;
  if (props.length) {
    md += "| Input | Type | Required | Description |\n|---|---|---|---|\n";
    for (const [name, schema] of props) {
      md += `| \`${name}\` | ${cell(typeOf(schema))} | ${required.has(name) ? "yes" : "no"} | ${cell(schema.description)} |\n`;
    }
    md += "\n";
  } else {
    md += "No inputs.\n\n";
  }
  md += `**Side effects:** ${SIDE_EFFECTS[t.name]}\n\n`;
}

const out = join(root, "docs", "tools.md");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, md);
console.log(`Wrote ${out} (${tools.length} tools: ${counts.Read} read, ${counts.Write} write, ${counts["Sensitive write"]} sensitive)`);
