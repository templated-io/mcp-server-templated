---
name: templated
description: "Render images (PNG, JPG, WebP), PDFs and MP4 videos from the user's Templated templates, such as social media posts, banners, Open Graph images, certificates, invoices and menus, one at a time or as a batch from a list. Use when the user mentions Templated or one of their templates, or asks to fill a saved design with new text, images or colors, to make one version per name or row, to merge PDFs, or to render a design at another size."
---

# Render designs with Templated

Templated fills a saved template (a design with named layers) with the exact
text, images and colors it is given, and returns the finished file. The output
always follows the template's layout. Templated renders templates; it does not
generate pictures from a text prompt.

Explicit instructions from the user take priority over the guidance in this
skill.

## Tools at a glance

| Goal | Tool |
|---|---|
| Find a template | `list_templates` (filter with `query`, `width`, `height`) |
| See what can be changed | `get_template_layers`; for multi-page or multi-size templates, `get_template_pages` |
| Produce the file | `create_render` |
| Check a render again or find its URL | `get_render`, `list_renders` |
| Combine renders into one PDF | `merge_renders` |
| No template fits | Design one with the `templated-design` skill (`create_template`) |

## Render flow

1. **Find the template.** Call `list_templates`. If the user named a template,
   match it by name. If several could fit, list the candidates by name and size
   and ask which one to use. If none fits or the account has no templates,
   offer to design one (see `templated-design`) instead of stopping.
2. **Read its layers.** Call `get_template_layers` with the template ID. The
   layer names it returns are the only keys `create_render` accepts in
   `layers`. For a template with several pages or sizes, call
   `get_template_pages`.
3. **Map the content to layers.** Put each value in the layer that plays that
   role: the title in the headline layer, the person's name in the name layer,
   a photo URL in the image layer. A layer that still shows placeholder copy
   and has no value from the user gets either real content or `"hide": true`,
   so no placeholder text ends up in the result. When the layer names don't
   clearly match the content, state the mapping in one line before rendering.
4. **Render once.** Call `create_render` with `template`, `layers` and the
   `format` the user asked for (`jpg` is the default).
5. **Show the result.** Share the render (the preview card or the file URL) and
   ask whether anything should change. Apply changes and render again.

Layer values are objects keyed by layer name:

```json
{
  "headline": { "text": "Grand Opening" },
  "date": { "text": "Saturday, May 9", "color": "#FFD166" },
  "photo": { "image_url": "https://example.com/storefront.jpg" },
  "badge": { "hide": true }
}
```

## Text that has to fit

- On a text layer that uses autofit, send `text` alone. An explicit
  `font_size` cancels autofit, and long text can then overflow its box.
- To keep long text inside its box, send `"autofit": "height"` with
  `min_font_size` and `max_font_size` (numbers, in pixels). If the text still
  overflows, lower `max_font_size` and render again.
- In a batch, test the longest value first, not a typical one.

## Images

- `image_url` must be a public HTTPS link to a JPG, PNG, WebP or SVG file.
- If the user only has a file in the chat and no link, explain that Templated
  needs a public link to the image. They can also upload it in the Templated
  web app (app.templated.io), after which `list_uploads` returns its URL.
- Don't make up image URLs.

## Batches: one design per name or row

1. Render the first item alone and show it. Check that every value appears in
   the right place. Ask the user to confirm the first result before rendering
   the rest, unless they already said to go ahead.
2. Call `create_render` once per remaining item, each with its own `layers`.
   Don't put several rows into one call.
3. Keep the render IDs in order. For a single file, call `merge_renders` with
   those IDs; image renders become PDF pages.
4. Report what was produced. If an item failed, name it and give the reason
   instead of skipping it silently.

## Formats and sizes

- `png` for transparency (`"transparent": true`) and sharp text or graphics,
  `jpg` for photos, `webp` for the web.
- `pdf` for documents. For printing, add `"flatten": true`, and `"cmyk": true`
  when the printer asks for CMYK.
- `mp4` for video: `duration` in milliseconds (up to 90000), optional `fps`
  (1 to 60), and an optional `animation` object per layer with `in` (slide,
  fade, zoom or rotate), `loop` (spin or pulse) and `out`, all timed in
  milliseconds. Videos take longer to render than images.
- For one render at another size, pass `width` and `height` (100 to 5000
  pixels) to `create_render`, then check the result: a layout made for a
  square can crop or crowd at another ratio. For a size the user will reuse,
  add it as a page of a multi-size template (see `templated-design`).

Common sizes: Instagram post 1080x1080, story or reel 1080x1920, link preview
(Open Graph) 1200x630, YouTube thumbnail 1280x720, A4 landscape certificate
1754x1240, A4 portrait document 1240x1754.

## Multi-page and multi-size templates

- `get_template_pages` returns each page's name, size and layers. Layer names
  can differ between pages, for example with a `-copy` suffix on the second
  page.
- To give pages their own content, pass `pages` to `create_render`:
  `[{ "page": "<page name>", "layers": { ... } }]`. Only the listed pages are
  rendered. Use either `layers` or `pages` in one call.
- A multi-page render returns one file per page. Use `merge_renders` to
  combine them into one PDF.

## When Templated is not the right tool

- Artwork or photos generated from a text prompt with no template involved:
  Templated doesn't do this. Say so in one sentence.
- Editing an existing photo (background removal, retouching) or posting to
  social networks: not supported.
- When the user asked to use Templated or one of their templates, complete the
  request with Templated tools, because a picture made another way would not
  match their saved design.

## Errors and safety

- Read the error message. It names the problem, such as a missing template, a
  layer name the template doesn't have (with the valid names), or an image URL
  that can't be fetched. Correct the call and retry once.
- If the account has reached its render limit, say plainly that the Templated
  account can't render more right now and that the details are in the user's
  Templated account. Don't promote plans or upgrades.
- If a tool reports an authorization error, ask the user to reconnect the
  Templated plugin. Never ask for passwords or API keys in the chat.
- Delete templates, renders, uploads, fonts or folders only when the user
  explicitly asks, and confirm which items first.
