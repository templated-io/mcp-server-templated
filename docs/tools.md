# Templated MCP server: tool reference

Generated from the server's tool definitions by `scripts/tools-doc.mjs`.

Templated renders images (PNG, JPG, WebP), PDFs and MP4 videos from templates: it fills a saved design with the exact text, images and colors it is given. It is template rendering, not AI image generation.

## Setup

- **Endpoint:** `https://mcp.templated.io/mcp` (MCP Streamable HTTP, production). There is no separate test environment; reviewers use a dedicated test account in production.
- **Authentication:** OAuth 2.1 with PKCE (S256). Authorization server metadata: `https://api.templated.io/.well-known/oauth-authorization-server`; protected resource metadata: `https://mcp.templated.io/.well-known/oauth-protected-resource`. Dynamic client registration (RFC 7591) is supported, and pre-registered clients are available on request.
- **Sign-in:** the user signs in to their Templated account (email and password, or Google) and approves access on the consent page. New users can create an account there.
- **Scopes:** no OAuth scopes. A connection has access to the connected Templated account's templates, renders, folders, uploads and fonts, and to nothing else. The token is tied to the account's API key: regenerating the API key in Templated revokes every connection.
- **Setup guide:** https://templated.io/docs/integrations/mcp/
- **Automations:** an API key can be sent as `Authorization: Bearer <key>` instead of OAuth.

## Permissions

11 tools are **Read**, 10 are **Write** and 4 are **Sensitive write**. Read tools never change data. Write tools create or change items in the user's own Templated account and never send, publish or share anything with other people. Sensitive writes are the deletes that cannot be undone. No tool makes purchases, moves money, sends messages or posts to social networks. Render usage is counted against the plan the user already has; no tool changes a plan or charges a payment method.

| Tool | Permission | Side effects |
|---|---|---|
| `create_render` | Write | Creates a render (a file on the Templated CDN) and counts toward the account's monthly render usage. Fetches the image URLs passed in layers. |
| `get_render` | Read | None. |
| `list_renders` | Read | None. |
| `delete_render` | Sensitive write | Permanently deletes the render from the account. Cannot be undone. |
| `merge_renders` | Write | Creates a new PDF from existing renders and counts toward the account's render usage. The original renders are not changed. |
| `list_templates` | Read | None. |
| `get_template` | Read | None. |
| `get_template_layers` | Read | None. |
| `get_template_pages` | Read | None. |
| `create_template` | Write | Creates a new template in the account. Fetches the image URLs passed in layers. |
| `update_template` | Write | Changes the template in place. With replaceLayers set to true, layers missing from the request are deleted; a page sent with hide set to true is deleted. Renders already made are not changed. |
| `clone_template` | Write | Creates a copy of the template. The original is not changed. |
| `delete_template` | Sensitive write | Permanently deletes the template; it can no longer be rendered. Renders already made are kept. Cannot be undone. |
| `list_template_renders` | Read | None. |
| `list_folders` | Read | None. |
| `create_folder` | Write | Creates a folder. |
| `update_folder` | Write | Renames the folder. |
| `delete_folder` | Write | Deletes the folder only. The templates inside it move to the top level of the account and are not deleted. |
| `list_uploads` | Read | None. |
| `create_upload` | Write | Downloads the image from the given public URL and stores it in the account's uploads. |
| `delete_upload` | Sensitive write | Permanently deletes the uploaded image from the account. Cannot be undone. |
| `list_fonts` | Read | None. |
| `upload_font` | Write | Downloads the font file from the given public URL and adds it to the account's custom fonts. |
| `delete_font` | Sensitive write | Permanently deletes every file of the custom font family; templates that use it fall back to another font in later renders. Cannot be undone. |
| `get_account` | Read | None. |

## Status handling

`create_render` waits for the file and returns each render with its `status` (`COMPLETED`, `PENDING` or `FAILED`) and URL; a multi-page template returns one render per page. `get_render` returns the current status of any render, so a client can check a pending render, or one whose call timed out, before rendering again and avoid duplicates. `merge_renders` returns the URL of the merged PDF.

## Errors

Errors are returned as tool results with `isError` set and a message that names the problem and the next step, for example:

- a layer name the template doesn't have, with the list of valid names (nothing is rendered);
- a template, render, folder, upload or font ID that isn't in the connected account, with the tool to call for valid IDs;
- an image or font URL that can't be fetched (private network addresses are refused);
- an expired or revoked connection (HTTP 401): reconnect Templated;
- the account's render limit reached: the message says the account can't render more right now, without promoting plans.

## Limits

- Each render and each merge counts toward the account's monthly render quota (`get_account` returns the usage).
- One update at a time per template: a concurrent `update_template` on the same template returns HTTP 429 with a retry hint.
- Renders: 100 to 5000 pixels per side; videos up to 90 seconds; uploads up to 10 MB; `merge_renders` with `host` set to false returns the PDF inline only up to 100 KB.
- List tools return up to 100 items per page.

## Data

The server stores nothing of its own: each call is forwarded to the Templated API for the connected account and the result is returned. Tool results contain the account's templates, renders and assets, and no personal data such as names or email addresses. Privacy policy: https://templated.io/privacy/

## Tools

### `create_render`

**Create Render** · Write

Render a Templated template into an image (JPG, PNG or WebP), a PDF or an MP4 video, with new text, images and colors in its layers. Use this when the user wants a finished design from one of their templates, such as a social media post, banner, OG image, certificate or invoice. Templated fills the saved template with the exact values given: this is template rendering, not AI image generation. Pass the template ID and 'layers' keyed by the layer names from get_template_layers; names the template doesn't have are rejected before anything is rendered. Multi-page templates render every page, or only the pages listed in 'pages'. Each output counts toward the account's render usage. Returns the render with its file URL (one render per page for multi-page templates).

| Input | Type | Required | Description |
|---|---|---|---|
| `template` | string | yes | The template ID to render (from list_templates) |
| `format` | `jpg` \| `png` \| `webp` \| `pdf` \| `mp4` | no | Output format. Default: jpg |
| `layers` | object | no | Layer values keyed by layer name, e.g. { "title": { "text": "Hello" }, "photo": { "image_url": "https://..." } }. Each value can set text, image_url, color, background, hide and other layer properties. 'animation' (MP4 only) takes 'in' (entrance: type slide\|fade\|zoom\|rotate, direction, duration, writingStyle), 'loop' (type spin\|pulse, duration), 'out' (exit: type slide\|fade\|zoom, direction, duration), 'start' and 'end' (when the layer appears and disappears). All animation times are in milliseconds. |
| `pages` | array of object | no | For multi-page templates: the pages to render, each with its own layer values. Each item has 'page' (a page name from get_template_pages) and 'layers' keyed by layer name, like the top-level 'layers'. Only the listed pages are rendered. Use either 'layers' or 'pages' in one call. |
| `transparent` | boolean | no | Make background transparent (PNG only) |
| `duration` | number | no | Video duration in milliseconds (MP4 only, max 90000) |
| `fps` | number | no | Frames per second (MP4 only, 1-60) |
| `flatten` | boolean | no | Flatten PDF for print-ready documents |
| `cmyk` | boolean | no | Use CMYK color mode (PDF only) |
| `width` | number | no | Custom width in pixels (100-5000) |
| `height` | number | no | Custom height in pixels (100-5000) |
| `scale` | number | no | Scale factor (0.1-2.0) |
| `name` | string | no | Custom name for the render |
| `background` | string | no | Background color in hex format (e.g., #FF0000) |

**Side effects:** Creates a render (a file on the Templated CDN) and counts toward the account's monthly render usage. Fetches the image URLs passed in layers.

### `get_render`

**Get Render** · Read

Get one render by ID with its status, format, size and file URL. Use this to check whether a render has finished or to find its URL again.

| Input | Type | Required | Description |
|---|---|---|---|
| `render_id` | string | yes | The render ID |

**Side effects:** None.

### `list_renders`

**List Renders** · Read

List the renders in the connected Templated account, newest first, 25 per page by default (max 100). Use this to find a render's ID or file URL, for example to merge PDFs with merge_renders. Returns each render's id, url, status, format, size and template.

| Input | Type | Required | Description |
|---|---|---|---|
| `page` | number | no | Page number, starting at 0 (default: 0) |
| `limit` | number | no | Results per page (default: 25, max: 100) |

**Side effects:** None.

### `delete_render`

**Delete Render** · Sensitive write

Permanently delete a render from the connected Templated account; it can't be restored. Use this when the user asks to remove a render. Takes the render ID from list_renders and returns a confirmation.

| Input | Type | Required | Description |
|---|---|---|---|
| `render_id` | string | yes | The render ID to delete |

**Side effects:** Permanently deletes the render from the account. Cannot be undone.

### `merge_renders`

**Merge Renders into PDF** · Write

Merge several renders into one PDF, in the order given, for example one certificate or invoice per recipient. Image renders become PDF pages. Use this after creating the individual renders. Each merge counts toward the account's render usage. Returns the URL of the merged PDF. With host set to false the PDF itself is returned inline instead, which only works for PDFs up to 100 KB.

| Input | Type | Required | Description |
|---|---|---|---|
| `render_ids` | array of string | yes | Render IDs to merge, in page order |
| `host` | boolean | no | true (default): return a URL to the merged PDF. false: return the PDF inline as an embedded file, for PDFs up to 100 KB. |

**Side effects:** Creates a new PDF from existing renders and counts toward the account's render usage. The original renders are not changed.

### `list_templates`

**List Templates** · Read

List the templates in the connected Templated account, 25 per page by default (max 100), optionally filtered by name (query), size (width, height) or tags. Use this first to find the template ID for create_render, get_template_layers or update_template. Returns each template's id, name, size, thumbnail, folder, and layer and page counts.

| Input | Type | Required | Description |
|---|---|---|---|
| `query` | string | no | Search query to filter templates by name |
| `page` | number | no | Page number, starting at 0 (default: 0) |
| `limit` | number | no | Results per page (default: 25, max: 100) |
| `width` | number | no | Filter by template width |
| `height` | number | no | Filter by template height |
| `tags` | string | no | Filter by tags (comma-separated) |
| `includeLayers` | boolean | no | Include each template's layers (a much larger response; get_template_layers reads one template's layers) |

**Side effects:** None.

### `get_template`

**Get Template** · Read

Get one template's details by ID: name, size, background, thumbnail, tags, folder, and layer and page counts. Use this to check a template's size or settings; get_template_layers returns its editable layers.

| Input | Type | Required | Description |
|---|---|---|---|
| `template_id` | string | yes | The template ID |

**Side effects:** None.

### `get_template_layers`

**Get Template Layers** · Read

List a template's layers with their names, types and current values (text, image_url, colors, fonts, position and size). Use this before create_render: the layer names are the keys create_render accepts in 'layers'. Covers every page of a multi-page template; get_template_pages groups the layers by page.

| Input | Type | Required | Description |
|---|---|---|---|
| `template_id` | string | yes | The template ID |

**Side effects:** None.

### `get_template_pages`

**Get Template Pages** · Read

List the pages of a multi-page or multi-size template, each with its name, width, height and layers keyed by layer name. Use this to render specific pages with create_render ('pages') or to edit pages with update_template, which accepts the same shape.

| Input | Type | Required | Description |
|---|---|---|---|
| `template_id` | string | yes | The template ID |

**Side effects:** None.

### `create_template`

**Create Template** · Write

Create a new template in the connected Templated account from layers, for example a social media post, banner, OG image, certificate or invoice. Use this when none of the existing templates fits or the account has no templates yet. Each layer has a unique name in 'layer' and a 'type': text, image, shape or rating. Shape layers draw rectangles, circles and other shapes from SVG content in 'html'. For a multi-page or multi-size template (several sizes in one template), pass 'pages' in place of 'layers'. Returns the new template; its ID can be rendered right away with create_render.

| Input | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Template name |
| `width` | number | yes | Template width in pixels |
| `height` | number | yes | Template height in pixels |
| `background` | string | no | Template background color (e.g., '#ffffff', 'rgb(255,255,255)', 'transparent') |
| `duration` | number | no | Default video duration in milliseconds for MP4 renders (e.g., 5000 for 5 seconds). Used as fallback when no duration is specified at render time. |
| `layers` | array of object | no | Layers of a single-page template. Each layer object has 'layer' (its unique name, later used as the key in create_render) and 'type'. |
| `pages` | array of object | no | Pages for a multi-page or multi-size template (for example an Instagram square, a story and an X landscape version in one template, each with its own width and height). Used in place of top-level 'layers'. Each page has 'page' (a unique name), optional 'width'/'height' (default: the template size), and 'layers' as an object keyed by layer name, the same shape get_template_pages returns. |

**Side effects:** Creates a new template in the account. Fetches the image URLs passed in layers.

### `update_template`

**Update Template** · Write

Change an existing template: name, description, size, background, default video duration, layers or pages. Use this to edit a design, resize it, or add sizes to a multi-size template. Layers are matched by their 'layer' name: an existing layer is updated in place and a new name is added. Top-level 'layers' apply to the first page; 'pages' reaches the others. With replaceLayers true, layers missing from the request are deleted. To move a layer, send both x and y (a missing coordinate is set to 0). In 'pages', a page name that doesn't exist yet is added and an existing page has its layers updated. On a multi-size template, set width and height per page inside 'pages'; top-level width and height are rejected there because they would resize every page. Returns the updated template.

| Input | Type | Required | Description |
|---|---|---|---|
| `template_id` | string | yes | The template ID to update |
| `name` | string | no | New template name |
| `description` | string | no | New template description |
| `width` | number | no | New width in pixels. Applies to every page; rejected on multi-size templates (use per-page width inside 'pages') |
| `height` | number | no | New height in pixels. Applies to every page; rejected on multi-size templates (use per-page height inside 'pages') |
| `background` | string | no | Template background color |
| `duration` | number | no | Default video duration in milliseconds for MP4 renders (e.g., 5000 for 5 seconds) |
| `layers` | array of object | no | Layer definitions. Each has 'layer' (its unique name) and 'type' (text, image, shape or rating). |
| `replaceLayers` | boolean | no | true: delete the layers (on the pages being updated) that are missing from the request. false (default): keep them. |
| `pages` | array of object | no | Pages for a multi-page or multi-size template (for example an Instagram square, a story and an X landscape version in one template, each with its own width and height). Used in place of top-level 'layers'. Each page has 'page' (a unique name), optional 'width'/'height' (default: the template size), and 'layers' as an object keyed by layer name, the same shape get_template_pages returns. |

**Side effects:** Changes the template in place. With replaceLayers set to true, layers missing from the request are deleted; a page sent with hide set to true is deleted. Renders already made are not changed.

### `clone_template`

**Clone Template** · Write

Copy a template, with all its layers and pages, into a new template in the same account. Use this to make a variation without changing the original. Returns the copy, which keeps the original's name unless 'name' is given.

| Input | Type | Required | Description |
|---|---|---|---|
| `template_id` | string | yes | The template ID to clone |
| `name` | string | no | Name for the cloned template |

**Side effects:** Creates a copy of the template. The original is not changed.

### `delete_template`

**Delete Template** · Sensitive write

Permanently delete a template from the connected Templated account; it can't be restored or rendered afterwards. Renders already created from it are kept. Use this when the user asks to delete a template.

| Input | Type | Required | Description |
|---|---|---|---|
| `template_id` | string | yes | The template ID to delete |

**Side effects:** Permanently deletes the template; it can no longer be rendered. Renders already made are kept. Cannot be undone.

### `list_template_renders`

**List Renders from Template** · Read

List the renders created from one template, 25 per page by default (max 100). Use this to find earlier outputs of a template. Returns each render's id, url, status and format.

| Input | Type | Required | Description |
|---|---|---|---|
| `template_id` | string | yes | The template ID |
| `page` | number | no | Page number, starting at 0 (default: 0) |
| `limit` | number | no | Results per page (default: 25, max: 100) |

**Side effects:** None.

### `list_folders`

**List Folders** · Read

List the folders in the connected Templated account with the number of templates in each, 25 per page by default (max 100). Use this to find a folder ID for update_folder or delete_folder. Returns the folders plus total and hasMore.

| Input | Type | Required | Description |
|---|---|---|---|
| `page` | number | no | Page number, starting at 0 (default: 0) |
| `limit` | number | no | Results per page (default: 25, max: 100) |

**Side effects:** None.

### `create_folder`

**Create Folder** · Write

Create a folder to organize templates in the connected Templated account. Use this when the user wants to group templates. Returns the new folder with its ID.

| Input | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Folder name |

**Side effects:** Creates a folder.

### `update_folder`

**Update Folder** · Write

Rename a folder. Use this when the user wants to change a folder's name. Returns the updated folder.

| Input | Type | Required | Description |
|---|---|---|---|
| `folder_id` | string | yes | The folder ID |
| `name` | string | yes | New folder name |

**Side effects:** Renames the folder.

### `delete_folder`

**Delete Folder** · Write

Delete a folder from the connected Templated account. The templates inside it are not deleted: they move out of the folder to the top level of the account. Use this when the user asks to remove a folder.

| Input | Type | Required | Description |
|---|---|---|---|
| `folder_id` | string | yes | The folder ID to delete |

**Side effects:** Deletes the folder only. The templates inside it move to the top level of the account and are not deleted.

### `list_uploads`

**List Uploads** · Read

List the images uploaded to the connected Templated account, 25 per page by default (max 100). Use this to reuse an uploaded image: its 'path' is a URL that can be set as image_url on an image layer. Returns each upload's id, name, type, size and path.

| Input | Type | Required | Description |
|---|---|---|---|
| `page` | number | no | Page number, starting at 0 (default: 0) |
| `limit` | number | no | Results per page (default: 25, max: 100) |

**Side effects:** None.

### `create_upload`

**Upload Image from URL** · Write

Upload an image (JPG, PNG, WebP or SVG, up to 10 MB) from a public URL to the connected Templated account. Use this to keep an image in the account's assets for templates and renders. Returns the upload; its 'path' is the URL to use as image_url. API reference: https://templated.io/docs

| Input | Type | Required | Description |
|---|---|---|---|
| `url` | string | yes | Public URL of the image to upload |
| `name` | string | no | Optional name for the upload |

**Side effects:** Downloads the image from the given public URL and stores it in the account's uploads.

### `delete_upload`

**Delete Upload** · Sensitive write

Permanently delete an uploaded image from the connected Templated account; it can't be restored. Use this when the user asks to remove an upload. Takes the upload ID from list_uploads.

| Input | Type | Required | Description |
|---|---|---|---|
| `upload_id` | string | yes | The upload ID to delete |

**Side effects:** Permanently deletes the uploaded image from the account. Cannot be undone.

### `list_fonts`

**List Fonts** · Read

List the custom fonts uploaded to the connected Templated account, 25 per page by default (max 100). Templates can also use any Google Font by family name: set include_google_fonts to true to list those too, and query to search by name. Use this to choose a font_family for create_template or update_template, or to find the name for delete_font. Returns the font names plus total and hasMore.

| Input | Type | Required | Description |
|---|---|---|---|
| `query` | string | no | Only fonts whose name contains this text (case-insensitive) |
| `include_google_fonts` | boolean | no | Also list the Google Fonts available to every template (default: false) |
| `page` | number | no | Page number, starting at 0 (default: 0) |
| `limit` | number | no | Results per page (default: 25, max: 100) |

**Side effects:** None.

### `upload_font`

**Upload Font** · Write

Upload a custom font file (TTF, OTF, WOFF or WOFF2) from a public URL to the connected Templated account under the given family name. Use this when a design needs a font that isn't a Google Font; templates then use it as font_family. Returns the font. API reference: https://templated.io/docs

| Input | Type | Required | Description |
|---|---|---|---|
| `url` | string | yes | URL of the font file (TTF, OTF, WOFF, WOFF2) |
| `name` | string | yes | Font family name |

**Side effects:** Downloads the font file from the given public URL and adds it to the account's custom fonts.

### `delete_font`

**Delete Font** · Sensitive write

Permanently delete a custom font from the connected Templated account by family name, including every file uploaded under that name. Templates that use it fall back to another font in later renders. Use this when the user asks to remove a font.

| Input | Type | Required | Description |
|---|---|---|---|
| `font_name` | string | yes | The font family name to delete, as returned by list_fonts |

**Side effects:** Permanently deletes every file of the custom font family; templates that use it fall back to another font in later renders. Cannot be undone.

### `get_account`

**Get Render Usage** · Read

Get the connected Templated account's render usage for the current period: renders used (apiUsage), renders included (apiQuota) and the percentage used. Use this to check how many renders are left before a large batch.

No inputs.

**Side effects:** None.

