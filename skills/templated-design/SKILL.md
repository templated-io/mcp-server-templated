---
name: templated-design
description: "Design a new Templated template from a short brief, or fix the layout of an existing one, with create_template and update_template: Instagram posts and stories, Open Graph link previews, banners, certificates, invoices, menus, quote cards and multi-size templates. Use when no existing template fits, the account has no templates yet, the user asks to design or redesign a template, or a render shows text that overflows, overlaps or is hard to read."
---

# Design a Templated template

A template is a canvas (width, height, background) with named layers. The
layer names become the keys used later in `create_render`, so name each layer
by its role.

Explicit instructions from the user about layout, colors, fonts or wording
take priority over the defaults below.

## 1. Gather the brief

You need what the piece is for, its size, the text it carries, and any brand
colors, fonts or image URLs. Use what the user already said. Ask one short
question only when the purpose or the main text is missing. Otherwise choose
sensible defaults and say which ones you chose.

| Piece | Size (px) | Keep clear |
|---|---|---|
| Instagram post | 1080x1080 | 64 px on every side |
| Story or reel | 1080x1920 | top 250 px and bottom 320 px, covered by app controls |
| Link preview (Open Graph) | 1200x630 | keep text inside the central 1000x500 |
| YouTube thumbnail | 1280x720 | the bottom-right corner, where the duration badge sits |
| Certificate, A4 landscape | 1754x1240 | 120 px margins |
| Invoice, menu or flyer, A4 portrait | 1240x1754 | 120 px margins |

## 2. Compose before placing layers

- **One message.** Write the one sentence the viewer should take away. Leave
  out anything that doesn't serve it.
- **One dominant element.** The main text is at least twice the size of the
  next largest text.
- **Two font families at most.** One display face for the headline, one text
  face for the rest. Vary weight, size, letter spacing and color instead of
  adding fonts. Widely available families such as Inter, Montserrat, Poppins,
  Roboto, Playfair Display and Archivo Black work well. `list_fonts` shows the
  fonts uploaded to the account, such as brand fonts.
- **Color 60-30-10.** One surface color for most of the canvas, a neutral
  family for the text, and one accent used at most three times.
- **One margin, one alignment edge.** Inset content by about 8% of the shorter
  side (about 90 px on 1080) and align every layer to the same left edge or the
  same center.
- **No text directly on a photo.** Put a full-canvas `shape` layer between the
  photo and the text, for example
  `<rect width="100%" height="100%" fill="#0B0E13" opacity="0.8"/>`, with an
  opacity that keeps the smallest text readable.
- **Images.** Use only image URLs the user gave you or that are already in the
  account (`list_uploads`). Without one, design with color and shapes, and keep
  an image layer only if the user plans to add a photo.

Vary the structure across a series so consecutive pieces don't look the same:

| Piece | Structure |
|---|---|
| Announcement, event | Full-bleed photo, dark overlay, text block low on the left |
| Quote, testimonial | Flat color, no photo, large centered text, thin rule above |
| Product, offer | Canvas split in two: image on one half, text on the other |
| Stat, result | One oversized number as the dominant element, label under it |
| Certificate | Centered stack: title, recipient name (largest), reason, then date and issuer at the bottom |

## 3. Create the template

Call `create_template` with `name`, `width`, `height`, an optional
`background`, and `layers`. Each layer needs a unique `layer` name, a `type`
(`text`, `image`, `shape` or `rating`) and its position (`x`, `y`, `width`,
`height`).

- **Text:** `text`, `font_family`, `font_size` (for example `"72px"`),
  `font_weight`, `color`, `horizontal_align`, `vertical_align`, `line_height`,
  `letter_spacing`.
- **Image:** `image_url`, and `object_fit: "cover"` to fill the box.
- **Shape:** SVG markup in `html`, for example
  `<rect width="100%" height="100%" rx="24" fill="#1477FF"/>`.
- **Stacking:** later layers are drawn on top; `order` sets it explicitly.

Name layers by role, in lowercase: `headline`, `subtitle`, `photo`, `logo`,
`name`, `date`, `cta`. Fill text layers with realistic content from the brief,
and size each text box for the longest value it will receive.

For several sizes of one design (for example a post, a story and a banner),
pass `pages` instead of `layers`. Each page has a `page` name, its own `width`
and `height`, and `layers` keyed by layer name. When rendering, use
`get_template_pages` to read the exact layer names of each page.

## 4. Render and check

1. Render the new template once with `create_render`, using the real content
   from the brief.
2. If you can see the rendered image, check it before showing it:
   - Is the main message the first thing you notice?
   - Does any text overflow, get cut off, or run past the margins?
   - Do any layers overlap by accident?
   - Does the headline still read at thumbnail size?
   - Is any placeholder text left?
3. Fix what failed and render again. Two passes are normal. Then show the
   result and ask the user what to change.

For long or variable text, send `"autofit": "height"` with `min_font_size` and
`max_font_size` for that layer in `create_render`, and lower `max_font_size`
until the longest string fits. Don't send `font_size` together with autofit.

## 5. Edit an existing template

- `update_template` matches layers by their `layer` name: existing names are
  updated and new names are added. For every layer you change, send `layer`,
  `type`, both `x` and `y`, and every property you want to keep, because a
  missing coordinate is set to 0 and omitted properties can be reset.
- Leave `replaceLayers` off unless the user wants layers removed, because it
  deletes every layer missing from the request.
- Avoid changing `shape` layers with `update_template`, because a shape can
  lose its SVG content. If a shape must change, create a corrected copy with
  `create_template`, tell the user its name, and keep the original unless they
  ask to delete it.
- To add a size to a multi-size template, send a new page in `pages` with its
  own `width` and `height`. On multi-size templates, set sizes per page rather
  than at the top level.
- After an update, call `get_template_layers` to confirm the change, then
  render once to check it.
- For fine adjustments, the user can open the template in the Templated editor
  (app.templated.io) and keep rendering from the chat.
