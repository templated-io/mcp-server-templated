# Templated MCP Server

MCP (Model Context Protocol) server for [Templated](https://templated.io) - the API for automated image, video, and PDF generation.

This server enables AI assistants like Claude, Cursor, and ChatGPT to interact with your Templated account - generate renders, manage templates, upload assets, and access all API features using natural language.

## Features

- **Render Generation**: Create images (JPG, PNG, WebP), videos (MP4), and PDFs from templates
- **Template Management**: List, create, update, clone, and delete templates
- **Layer Inspection**: Get template layers to understand what can be customized
- **Asset Management**: Upload and manage images, videos, and custom fonts
- **Folder Organization**: Create and manage folders for templates

## Quick Start

### Get Your API Key

1. Sign up at [app.templated.io](https://app.templated.io)
2. Go to your [API Key page](https://app.templated.io/api-key)
3. Copy your API key

## Connection Options

### Option 1: Remote Server (Recommended)

Use our hosted MCP server - no installation required, always up-to-date.

**Endpoint:** `https://mcp.templated.io/mcp` (OAuth login) — or `https://mcp.templated.io/mcp?apiKey=YOUR_API_KEY` for automation

#### Claude (web, desktop, mobile)

Templated is listed in the Claude connectors directory: open [claude.ai/directory/templatedio](https://claude.ai/directory/templatedio) (or **Customize → Connectors** and search for Templated), click **Connect** and sign in to your Templated account. To add it as a custom connector instead, use **Settings → Connectors → Add custom connector** with `https://mcp.templated.io/mcp`.

#### Claude Code

```bash
claude mcp add --transport http templated https://mcp.templated.io/mcp
```

Then run `/mcp` inside Claude Code and sign in when prompted.

#### Cursor IDE

[![Add to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=templated&config=eyJ1cmwiOiJodHRwczovL21jcC50ZW1wbGF0ZWQuaW8vbWNwIn0=)

Or add it manually to `~/.cursor/mcp.json`. Either way, click **Login** when Cursor asks and sign in to Templated:

```json
{
  "mcpServers": {
    "templated": {
      "url": "https://mcp.templated.io/mcp"
    }
  }
}
```

For automations, use `https://mcp.templated.io/mcp?apiKey=your-api-key-here` as the URL instead.

#### ChatGPT

1. Go to **Settings → Connected Apps → Add MCP Server**
2. Enter URL: `https://mcp.templated.io/mcp`
3. Set Authentication to **OAuth** and sign in to Templated when prompted
4. Click Create

**Alternative (automations):** enter `https://mcp.templated.io/mcp?apiKey=your-api-key-here` and set Authentication to **No Auth** instead.

### Plugin for Cursor and Grok

This repository is also a plugin that bundles the hosted MCP server with three skills:

- `templated`: render from existing templates (exact layer names, batches, sizes, multi-page PDFs and merging PDFs)
- `templated-design`: design a new template from a short brief, or fix the layout of an existing one
- `setup`: a first-run flow that checks the account and produces a first render, including on accounts with no templates yet

| File | Used by |
|---|---|
| `.cursor-plugin/plugin.json` | Cursor and Grok Bot (Cursor Marketplace) |
| `.grok-plugin/plugin.json` | Grok Build (xAI plugin marketplace) |
| `.mcp.json` | The MCP server (`https://mcp.templated.io/mcp`) |
| `skills/` | The skills above (also packaged in the ChatGPT plugin) |

No configuration is needed: the first tool call opens the Templated sign-in (OAuth), where you can also create an account. Nothing runs on your machine; the plugin only connects to the hosted server.

To try it locally in Cursor, clone this repository into `~/.cursor/plugins/local/templated` and run **Developer: Reload Window**.

### Option 2: Local Server

Run the MCP server locally on your machine. Requires Node.js 18+.

#### Claude Desktop

To run the server locally instead of using the remote connector, add to your config file:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`  
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "templated": {
      "command": "npx",
      "args": ["mcp-server-templated"],
      "env": {
        "TEMPLATED_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

#### Cursor IDE (Local)

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "templated": {
      "command": "npx",
      "args": ["mcp-server-templated"],
      "env": {
        "TEMPLATED_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

#### Manual Installation

```bash
# Using npx (no install needed)
npx mcp-server-templated

# Or install globally
npm install -g mcp-server-templated
```

## Authentication

The remote server supports two ways to authenticate:

- **OAuth 2.1** via the Templated authorization server — used automatically by interactive clients (Claude, ChatGPT, Cursor, Claude Code) when you connect to `https://mcp.templated.io/mcp` without an API key.
- **API key** via `?apiKey=YOUR_API_KEY` on the URL or an `Authorization: Bearer YOUR_API_KEY` header — used for automations and multi-tenant scoping (`folderId`/`externalId`).

## Available Tools

Full reference with inputs, permission class (read, write or sensitive write) and side effects: [docs/tools.md](docs/tools.md) (regenerate with `npm run build && npm run docs:tools`).

### Render Operations

| Tool | Description |
|------|-------------|
| `create_render` | Create an image, video, or PDF from a template |
| `get_render` | Get details of a specific render |
| `list_renders` | List all renders in your account |
| `delete_render` | Delete a render |
| `merge_renders` | Merge multiple PDF renders into one |

### Template Operations

| Tool | Description |
|------|-------------|
| `list_templates` | List all templates (with search/filter) |
| `get_template` | Get template details |
| `get_template_layers` | Get all layers of a template |
| `get_template_pages` | Get pages of a multi-page template |
| `create_template` | Create a new template (single-page via `layers`, multi-page/multi-size via `pages`) |
| `update_template` | Update an existing template (add or edit pages via `pages`) |
| `clone_template` | Clone a template (optional new `name`) |
| `delete_template` | Delete a template |
| `list_template_renders` | List renders from a template |

### Folder Operations

| Tool | Description |
|------|-------------|
| `list_folders` | List all folders |
| `create_folder` | Create a new folder |
| `update_folder` | Rename a folder |
| `delete_folder` | Delete a folder |

### Asset Operations

| Tool | Description |
|------|-------------|
| `list_uploads` | List uploaded assets |
| `create_upload` | Upload a file from URL |
| `delete_upload` | Delete an upload |
| `list_fonts` | List custom fonts |
| `upload_font` | Upload a custom font |
| `delete_font` | Delete a custom font by name |

### Account

| Tool | Description |
|------|-------------|
| `get_account` | Get render usage for the current period |

## In-chat render preview

In hosts that support [MCP Apps](https://modelcontextprotocol.io/docs/extensions/apps) (Claude on web, desktop and mobile, ChatGPT, VS Code and others), `create_render` and `get_render` show their result as a preview card inside the conversation:

- **Images** (PNG, JPG, WebP) appear fitted to the card; **MP4** renders get a video player; **PDFs** show as a file tile.
- Multi-page templates show their pages as a grid (a list for PDFs).
- Each card has **Download** and **Open in editor** buttons, and follows the host's light or dark theme.
- A render that is still processing shows a waiting state and updates itself when the file is ready.

The card is the UI resource `ui://templated/render-card-v1.html`, one self-contained HTML file (about 21 KB) that loads nothing except the render files from `cdn.templated.media` and `templated-assets.s3.amazonaws.com`. Clients without MCP Apps support (Cursor, Claude Code, scripts) get the same JSON text result as before, plus `structuredContent` with the render's URL, format, size and status.

## Example Usage

Once configured, you can ask your AI assistant to:

- "List my templates"
- "Create a render from template [ID] with the title set to 'Hello World'"
- "Generate a PDF certificate with the name 'John Doe'"
- "What layers does template [ID] have?"
- "Create a new template called 'Social Post' with a title and image layer"
- "Clone my Instagram template and rename it"
- "Upload this image to my account"
- "Show my API usage and account info"

### Creating a Render

```
"Create a render using template abc-123 with these changes:
- Set the 'title' layer text to 'Welcome!'
- Set the 'photo' layer image to https://example.com/photo.jpg
- Output as PNG with transparent background"
```

Claude will use the `create_render` tool with:
```json
{
  "template": "abc-123",
  "format": "png",
  "transparent": true,
  "layers": {
    "title": { "text": "Welcome!" },
    "photo": { "image_url": "https://example.com/photo.jpg" }
  }
}
```

## Development

```bash
# Clone the repository
git clone https://github.com/templated-io/mcp-server-templated.git
cd mcp-server-templated

# Install dependencies
npm install

# Build (the server, then the preview card into dist/ui/render-card.html)
npm run build

# Test
npm test

# Run in stdio mode (for local MCP clients)
TEMPLATED_API_KEY=your-key node dist/index.js

# Run in HTTP mode (for remote access)
PORT=3456 node dist/index.js
# Then access: http://localhost:3456/mcp?apiKey=your-key
```

### Testing with MCP Inspector

```bash
npx @modelcontextprotocol/inspector npx mcp-server-templated
```

## Resources

- [Templated Documentation](https://templated.io/docs)
- [MCP Documentation](https://modelcontextprotocol.io)
- [Template Gallery](https://templated.io/templates)

## License

MIT
