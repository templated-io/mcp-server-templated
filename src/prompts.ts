import type { GetPromptResult, Prompt } from "@modelcontextprotocol/sdk/types.js";

// Server-level guidance sent at initialize. Most new connections come from people
// who just signed up and have no templates yet; without this the model tends to
// stop and send them to the web app instead of producing a first render.
export const SERVER_INSTRUCTIONS = [
  "Templated renders images (PNG, JPG, WebP), multi-page PDFs and MP4 videos from templates.",
  "Start with list_templates. If the account has no templates yet (common right after sign-up), do not stop or send the user to the web app: offer to design one from their description with create_template, then render it.",
  "Before rendering, call get_template_layers and use those exact layer names as keys. Unknown keys are ignored and the render still succeeds, so a mismatch is silent.",
  "Render one, show the URL to the user, and only then render a batch.",
  "Common sizes: Instagram post 1080x1080, story 1080x1920, link preview (OG) 1200x630, A4 landscape certificate 1754x1240.",
].join("\n");

type PromptDef = Prompt & { build: (args: Record<string, string>) => string };

const opt = (value: string | undefined, label: string) => (value ? `\n${label}: ${value}` : "");

const definitions: PromptDef[] = [
  {
    name: "first-render",
    title: "Make my first design",
    description: "Create (or pick) a template and render a first image from a short description",
    arguments: [{ name: "idea", description: "What to make, e.g. 'a promo banner for our autumn sale'", required: false }],
    build: (a) =>
      `Help me make my first design with Templated${a.idea ? `: ${a.idea}` : ""}.
1. Call list_templates. If one of my templates fits, use it. Otherwise design one with create_template at the right size for the use (ask me only if the size is unclear).
2. Call get_template_layers and render it once with create_render, filling the layers with real content from my request.
3. Show me the image URL and ask what to change. Apply changes with update_template and render again until I'm happy.`,
  },
  {
    name: "instagram-post",
    title: "Instagram post",
    description: "Render a 1080x1080 Instagram post from a headline, reusing a fitting template or creating one",
    arguments: [
      { name: "headline", description: "Main text of the post", required: true },
      { name: "details", description: "Subtitle or supporting text", required: false },
      { name: "image_url", description: "Public URL of a photo to include", required: false },
      { name: "brand_color", description: "Brand color, e.g. #1B2123", required: false },
    ],
    build: (a) =>
      `Create an Instagram post (1080x1080) with Templated.
Headline: ${a.headline ?? ""}${opt(a.details, "Details")}${opt(a.image_url, "Photo")}${opt(a.brand_color, "Brand color")}
Use a square template from list_templates if one fits; otherwise create one with create_template with layers named headline, details${a.image_url ? ", photo" : ""}. Read get_template_layers, render once with create_render, and show me the URL before making variations.`,
  },
  {
    name: "certificates",
    title: "Certificates for a list of names",
    description: "Render one certificate per name, checking the first before generating the rest",
    arguments: [
      { name: "names", description: "Recipient names, separated by commas or new lines", required: true },
      { name: "title", description: "Course, event or award the certificate is for", required: true },
      { name: "date", description: "Date to print on the certificate", required: false },
      { name: "issuer", description: "Organization or person issuing it", required: false },
    ],
    build: (a) =>
      `Generate certificates with Templated.
Names: ${a.names ?? ""}
For: ${a.title ?? ""}${opt(a.date, "Date")}${opt(a.issuer, "Issued by")}
Use a certificate template from list_templates, or create one with create_template (A4 landscape, 1754x1240) with layers name, title${a.date ? ", date" : ""}${a.issuer ? ", issuer" : ""}.
Render the first name only, show me the URL and check that every value appears. After that, render one certificate per remaining name (one create_render call each) and offer to combine them into a single PDF with merge_renders.`,
  },
  {
    name: "og-image",
    title: "Link preview (OG) image",
    description: "Render a 1200x630 Open Graph image for a page or blog post",
    arguments: [
      { name: "title", description: "Page or post title", required: true },
      { name: "site", description: "Site or brand name", required: false },
      { name: "url", description: "Page URL to show on the image", required: false },
    ],
    build: (a) =>
      `Create a link preview (Open Graph) image, 1200x630, with Templated.
Title: ${a.title ?? ""}${opt(a.site, "Site")}${opt(a.url, "URL")}
Reuse a 1200x630 template from list_templates if one fits, otherwise create one with create_template. Render once, look at the result to confirm the whole title fits inside the image, and show me the URL.`,
  },
];

export const prompts: Prompt[] = definitions.map(({ build: _build, ...prompt }) => prompt);

export function getPrompt(name: string, args: Record<string, string> = {}): GetPromptResult {
  const def = definitions.find((d) => d.name === name);
  if (!def) {
    throw new Error(`Unknown prompt: ${name}`);
  }
  for (const arg of def.arguments ?? []) {
    if (arg.required && !args[arg.name]) {
      throw new Error(`Missing required argument: ${arg.name}`);
    }
  }
  return {
    description: def.description,
    messages: [{ role: "user", content: { type: "text", text: def.build(args) } }],
  };
}
