// Builds the render preview card (web/render-card) into one self-contained HTML
// file, dist/ui/render-card.html, served as the MCP Apps resource
// ui://templated/render-card-v1.html. Scripts and styles are inlined: the card
// loads nothing from the network except the render files it shows.
import * as esbuild from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = `${root}web/render-card/`;
const outDir = `${root}dist/ui/`;
const outFile = `${outDir}render-card.html`;
// Keep in sync with RENDER_CARD_MAX_BYTES in src/ui.ts.
const MAX_BYTES = 150 * 1024;

const script = await esbuild.build({
  entryPoints: [`${source}main.ts`],
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  target: ["es2020", "safari15", "chrome100", "firefox100"],
  minify: true,
  legalComments: "none",
  charset: "utf8",
  drop: ["debugger"],
  logLevel: "warning",
});

const css = await esbuild.transform(await readFile(`${source}styles.css`, "utf8"), {
  loader: "css",
  minify: true,
  target: ["safari15", "chrome100", "firefox100"],
});

// An inlined "</script" or "</style" would end the element early.
const js = script.outputFiles[0].text.replace(/<\/(script)/gi, "<\\/$1");
const styles = css.code.replace(/<\/(style)/gi, "<\\/$1");

const template = await readFile(`${source}index.html`, "utf8");
const html = template
  .replace("/*__CSS__*/", () => styles.trim())
  .replace("/*__JS__*/", () => js.trim());

const bytes = Buffer.byteLength(html);
if (bytes > MAX_BYTES) {
  console.error(`render-card.html is ${(bytes / 1024).toFixed(1)} KB, over the ${MAX_BYTES / 1024} KB budget`);
  process.exit(1);
}

await mkdir(outDir, { recursive: true });
await writeFile(outFile, html);
console.log(`dist/ui/render-card.html ${(bytes / 1024).toFixed(1)} KB`);
