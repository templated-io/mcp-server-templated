# Templated MCP Server

MCP (Model Context Protocol) server for [Templated](https://templated.io) - the API for automated image, video, and PDF generation.

This server enables AI assistants like Claude to interact with your Templated account to generate images, videos, and PDFs from templates.

## Features

- **Render Generation**: Create images (JPG, PNG, WebP), videos (MP4), and PDFs from templates
- **Template Management**: List, create, update, clone, and delete templates
- **Layer Inspection**: Get template layers to understand what can be customized
- **Asset Management**: Upload and manage images, videos, and custom fonts
- **Folder Organization**: Create and manage folders for templates

## Installation

### Using npx (Recommended)

```bash
npx mcp-server-templated
```

### Using npm

```bash
npm install -g mcp-server-templated
```

## Configuration

### Get Your API Key

1. Sign up at [app.templated.io](https://app.templated.io)
2. Go to your [API Key page](https://app.templated.io/api-key)
3. Copy your API key

### Claude Desktop

Add to your Claude Desktop configuration file:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`\
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

### Cursor IDE

Add to your Cursor MCP settings:

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

## Available Tools

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
| `create_template` | Create a new template |
| `update_template` | Update an existing template |
| `clone_template` | Clone a template |
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
| `delete_font` | Delete a font |

### Account

| Tool | Description |
|------|-------------|
| `get_account` | Get account info and API usage |

## Example Usage

Once configured, you can ask Claude to:

- "List my templates and show me what's available"
- "Create a social media post using template [ID] with the text 'Hello World'"
- "Generate a PDF certificate with the name 'John Doe'"
- "What layers does template [ID] have?"
- "Clone my Instagram template and name it 'Instagram Post v2'"

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

# Build
npm run build

# Run locally
TEMPLATED_API_KEY=your-key node dist/index.js
```

## Resources

- [Templated Documentation](https://templated.io/docs)
- [MCP Documentation](https://modelcontextprotocol.io)
- [Template Gallery](https://templated.io/templates)

## License

MIT
