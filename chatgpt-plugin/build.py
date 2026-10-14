#!/usr/bin/env python3
"""Validate the ChatGPT plugin package and build dist/templated-chatgpt-plugin-<version>.zip.

Checks follow https://developers.openai.com/plugins/deploy/submission and
https://developers.openai.com/plugins/deploy/submission-errors (final directory
submission limits). Standard library only. Usage: python3 build.py [--check]
"""
import json
import re
import struct
import sys
import unicodedata
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
# The skills are shared with the Cursor, Grok and Claude Code plugin at the repo
# root; they are packaged under skills/ in the ZIP.
SKILLS_DIR = ROOT.parent / "skills"
TOOLS_SOURCE = ROOT.parent / "src" / "tools.ts"
PACKAGE_FILES = ["plugin.json", "mcp.json"]
PACKAGE_DIRS = ["assets"]

CATEGORIES = {
    "Productivity", "Creativity", "Developer Tools", "Business & Operations", "Data & Analytics",
    "Communication", "Education & Research", "Security", "Finance", "Healthcare", "Travel",
    "Entertainment", "Other",
}
# Listing text must not advertise pricing or compare with other products.
LISTING_FLAGS = re.compile(
    r"\b(free|trial|pricing|price|discount|promo\w*|credits?|upgrade|subscription|cheap\w*|best|#1|"
    r"bannerbear|placid|orshot|creatomate|abyssale|renderform|dynapictures|midjourney|dall-?e)\b",
    re.IGNORECASE,
)
SEMVER = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$")
HEX = re.compile(r"^#[0-9A-Fa-f]{6}$")

errors: list[str] = []
warnings: list[str] = []


def err(msg: str) -> None:
    errors.append(msg)


def warn(msg: str) -> None:
    warnings.append(msg)


def supported_text(value: str, multiline: bool) -> bool:
    for ch in value:
        if ch == "\n" and multiline:
            continue
        if unicodedata.category(ch) in ("Cc", "Zl", "Zp") or ch in "​‎‏  ﻿":
            return False
    return True


def check_text(label: str, value, limit: int, multiline: bool = False, required: bool = True) -> None:
    if value is None:
        if required:
            err(f"{label}: required")
        return
    if not isinstance(value, str) or not value.strip():
        err(f"{label}: must be a non-empty string")
        return
    if len(value) > limit:
        err(f"{label}: {len(value)} chars, limit {limit}")
    if not supported_text(value, multiline):
        err(f"{label}: unsupported characters" + ("" if multiline else " or line breaks"))


def check_https(label: str, value, required: bool = True) -> None:
    if value is None:
        if required:
            err(f"{label}: required for remote MCP submissions")
        return
    if not isinstance(value, str) or not re.match(r"^https://[^/@\s]+(/\S*)?$", value):
        err(f"{label}: must be an HTTPS URL without credentials")
    elif len(value) > 1024:
        err(f"{label}: longer than 1024 chars")


def luminance(hex_color: str) -> float:
    def channel(c: int) -> float:
        s = c / 255
        return s / 12.92 if s <= 0.03928 else ((s + 0.055) / 1.055) ** 2.4
    r, g, b = (int(hex_color[i:i + 2], 16) for i in (1, 3, 5))
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)


def contrast(a: str, b: str) -> float:
    la, lb = sorted((luminance(a), luminance(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def png_size(path: Path):
    data = path.read_bytes()[:24]
    if data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        return None
    return struct.unpack(">II", data[16:24])


def check_asset(label: str, rel) -> None:
    if not isinstance(rel, str) or not rel.startswith("./"):
        err(f"{label}: path must start with ./")
        return
    path = (ROOT / rel).resolve()
    if ROOT not in path.parents or not path.is_file():
        err(f"{label}: {rel} missing or outside the package")
        return
    if path.stat().st_size > 5 * 1024 * 1024:
        err(f"{label}: larger than 5 MiB")
    if path.suffix.lower() != ".png":
        warn(f"{label}: only PNG dimensions are checked by this script")
        return
    size = png_size(path)
    if not size:
        err(f"{label}: not a PNG file")
        return
    w, h = size
    if w != h:
        err(f"{label}: not square ({w}x{h})")
    if not (48 <= w <= 4096):
        err(f"{label}: {w}px outside 48..4096")


def frontmatter(text: str):
    if not text.startswith("---\n"):
        return None, None
    end = text.find("\n---\n", 4)
    if end < 0:
        return None, None
    fields = {}
    for line in text[4:end].splitlines():
        m = re.match(r'^([a-z_]+):\s*"(.*)"\s*$', line) or re.match(r"^([a-z_]+):\s*(.+?)\s*$", line)
        if not m:
            return None, None
        fields[m.group(1)] = m.group(2)
    return fields, text[end + 5:]


def mcp_tool_names() -> set[str]:
    if not TOOLS_SOURCE.is_file():
        return set()
    return set(re.findall(r'^\s+name: "([a-z_]+)",', TOOLS_SOURCE.read_text(), re.MULTILINE))


def validate() -> dict:
    manifest = json.loads((ROOT / "plugin.json").read_text(encoding="utf-8"))
    allowed_root = {"$schema", "name", "version", "description", "author", "homepage", "repository",
                    "license", "keywords", "extensions"}
    for key in manifest:
        if key not in allowed_root:
            err(f"plugin.json: '{key}' is not allowed by the Agent Plugins schema")
    if manifest.get("$schema") != "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json":
        err("plugin.json: $schema must be the Agent Plugins 1.0.0 schema")
    name = manifest.get("name", "")
    if not re.match(r"^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$", name) or len(name) > 64:
        err("plugin.json: name must be lowercase kebab-case, at most 64 chars")
    if not SEMVER.match(manifest.get("version", "")):
        err("plugin.json: version must be semantic, e.g. 2.0.0")
    check_text("description", manifest.get("description"), 1024, multiline=True)
    author = manifest.get("author") or {}
    check_text("author.name", author.get("name"), 120)
    if set(author) - {"name", "email", "url"}:
        err("author: only name, email and url are allowed")
    if "url" in author:
        check_https("author.url", author["url"])
    check_https("homepage", manifest.get("homepage"), required=False)

    openai = (manifest.get("extensions") or {}).get("com.openai")
    if not isinstance(openai, dict):
        err("extensions.com.openai: missing")
        return manifest
    for forbidden in ("apps", "hooks", "test_credentials", "reviewer_instructions"):
        if forbidden in openai or forbidden in (openai.get("review") or {}):
            err(f"extensions.com.openai: '{forbidden}' can't be submitted to the directory")

    ui = openai.get("interface") or {}
    check_text("interface.displayName", ui.get("displayName"), 30)
    check_text("interface.shortDescription", ui.get("shortDescription"), 30)
    check_text("interface.longDescription", ui.get("longDescription"), 4000, multiline=True)
    check_text("interface.developerName", ui.get("developerName"), 80)
    if ui.get("category") not in CATEGORIES:
        err(f"interface.category: '{ui.get('category')}' is not a supported category")
    caps = ui.get("capabilities", [])
    if not isinstance(caps, list) or len(caps) > 20:
        err("interface.capabilities: list of at most 20")
    for i, cap in enumerate(caps if isinstance(caps, list) else []):
        check_text(f"interface.capabilities[{i}]", cap, 120)
    for field in ("websiteURL", "supportURL", "privacyPolicyURL", "termsOfServiceURL"):
        check_https(f"interface.{field}", ui.get(field))
    prompts = ui.get("defaultPrompt", [])
    prompts = [prompts] if isinstance(prompts, str) else prompts
    if len(prompts) > 3:
        err("interface.defaultPrompt: at most 3")
    seen = set()
    for i, prompt in enumerate(prompts):
        check_text(f"interface.defaultPrompt[{i}]", prompt, 128)
        if "@" in prompt:
            err(f"interface.defaultPrompt[{i}]: no @mentions")
        key = " ".join(unicodedata.normalize("NFKC", prompt).split()).casefold()
        if key in seen:
            err(f"interface.defaultPrompt[{i}]: duplicate")
        seen.add(key)
    for field, background in (("brandColor", "#FFFFFF"), ("brandColorDark", "#212121")):
        color = ui.get(field)
        if color is None:
            continue
        if not HEX.match(color):
            err(f"interface.{field}: must be #RRGGBB")
        elif contrast(color, background) < 2:
            err(f"interface.{field}: contrast {contrast(color, background):.2f}:1 against {background}, needs 2:1")
    for field in ("logo", "composerIcon", "logoDark", "composerIconDark"):
        if field in ui:
            check_asset(f"interface.{field}", ui[field])
        elif field in ("logo", "composerIcon"):
            err(f"interface.{field}: required")
    if ui.get("screenshots"):
        warn("interface.screenshots: only allowed when the current MCP scan reports a UI template; "
             "one 706px-wide PNG/JPEG per starter prompt")
    for field in ("displayName", "shortDescription", "longDescription"):
        for word in sorted({m.group(0) for m in LISTING_FLAGS.finditer(ui.get(field, ""))}):
            warn(f"interface.{field}: check wording '{word}' (no pricing, promotions or comparisons)")
    for i, prompt in enumerate(prompts):
        for word in sorted({m.group(0) for m in LISTING_FLAGS.finditer(prompt)}):
            warn(f"interface.defaultPrompt[{i}]: check wording '{word}'")

    review = openai.get("review") or {}
    cases = review.get("test_cases") or {}
    positive, negative = cases.get("positive", []), cases.get("negative", [])
    if len(positive) != 5:
        err(f"review.test_cases.positive: {len(positive)} cases, exactly 5 required")
    if len(negative) != 3:
        err(f"review.test_cases.negative: {len(negative)} cases, exactly 3 required")
    known_tools = mcp_tool_names()
    for kind, items in (("positive", positive), ("negative", negative)):
        for i, case in enumerate(items):
            label = f"review.{kind}[{i}]"
            check_text(f"{label}.description", case.get("description"), 4000, multiline=True)
            check_text(f"{label}.prompt", case.get("prompt"), 4000, multiline=True)
            if kind == "positive":
                check_text(f"{label}.tools_triggered", case.get("tools_triggered"), 4000)
                check_text(f"{label}.expected_behavior", case.get("expected_behavior"), 4000, multiline=True)
                for tool in re.split(r"\s*,\s*", case.get("tools_triggered", "")):
                    if known_tools and tool and tool not in known_tools:
                        err(f"{label}.tools_triggered: '{tool}' is not a tool of the MCP server")
            extra = set(case) - {"description", "prompt", "tools_triggered", "expected_behavior",
                                 "file_attachment_urls", "expected_output_url"}
            if extra:
                err(f"{label}: unknown fields {sorted(extra)}")
    if "demo_recording_url" in review:
        check_https("review.demo_recording_url", review["demo_recording_url"])
    else:
        warn("review.demo_recording_url: omitted, so the URL saved in the dashboard is kept")
    publication = openai.get("publication") or {}
    check_text("publication.release_notes", publication.get("release_notes"), 4000, multiline=True)
    for code in publication.get("countries") or []:
        if not re.match(r"^[A-Z]{2}$", code):
            err(f"publication.countries: '{code}' is not an uppercase country code")

    mcp = json.loads((ROOT / "mcp.json").read_text(encoding="utf-8"))
    if mcp.get("$schema") != "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json":
        err("mcp.json: $schema must be the Agent Plugins 1.0.0 MCP schema")
    servers = mcp.get("mcpServers") or {}
    if len(servers) != 1:
        err("mcp.json: plugin-level review cases require exactly one MCP server")
    for server_name, server in servers.items():
        if server.get("type") != "streamable-http" or set(server) - {"type", "url", "headers"}:
            err(f"mcp.json: {server_name} must be a streamable-http server with type and url")
        check_https(f"mcp.json {server_name}.url", server.get("url"))

    skills_dir = SKILLS_DIR
    skill_names = set()
    for entry in sorted(skills_dir.iterdir()):
        if entry.name.startswith("."):
            continue
        if not entry.is_dir():
            warn(f"skills/{entry.name}: files directly under skills/ are ignored")
            continue
        skill_md = entry / "SKILL.md"
        if not skill_md.is_file():
            err(f"skills/{entry.name}: SKILL.md missing")
            continue
        fields, body = frontmatter(skill_md.read_text(encoding="utf-8"))
        if fields is None:
            err(f"skills/{entry.name}/SKILL.md: missing or unparseable front matter")
            continue
        skill_name = fields.get("name", "")
        check_text(f"skills/{entry.name} name", skill_name, 64)
        check_text(f"skills/{entry.name} description", fields.get("description"), 1024)
        if not body.strip():
            err(f"skills/{entry.name}: empty instructions")
        if skill_name in skill_names:
            err(f"skills/{entry.name}: duplicate skill name {skill_name}")
        skill_names.add(skill_name)
        if len(f"{name}:{skill_name}") > 64:
            err(f"skills/{entry.name}: '{name}:{skill_name}' longer than 64 chars")
        agent = entry / "agents" / "openai.yaml"
        if agent.is_file():
            text = agent.read_text(encoding="utf-8")
            for key in ("display_name", "short_description"):
                if not re.search(rf'^  {key}: "[^"]+"\s*$', text, re.MULTILINE):
                    err(f"skills/{entry.name}/agents/openai.yaml: interface.{key} missing")
            if not text.startswith("interface:\n"):
                err(f"skills/{entry.name}/agents/openai.yaml: must start with an interface mapping")
        for word in sorted({m.group(0) for m in LISTING_FLAGS.finditer(skill_md.read_text())} - {"best"}):
            warn(f"skills/{entry.name}: check wording '{word}'")

    onboarding = openai.get("onboardingSkill")
    if onboarding is not None:
        path = (ROOT.parent / onboarding).resolve() if isinstance(onboarding, str) and onboarding.startswith("./skills/") else None
        if not path or not path.is_file() or path.name != "SKILL.md" or path.parent.parent != skills_dir:
            err("onboardingSkill: must point to ./skills/<skill>/SKILL.md inside the package")
    return manifest


def package_files() -> list[tuple[Path, str]]:
    """(source file, path inside the ZIP) pairs, sorted by ZIP path."""
    files = [(ROOT / f, f) for f in PACKAGE_FILES]
    for base, d in [(ROOT, d) for d in PACKAGE_DIRS] + [(SKILLS_DIR.parent, "skills")]:
        for p in (base / d).rglob("*"):
            rel = p.relative_to(base)
            if p.is_file() and not any(part.startswith(".") for part in rel.parts):
                files.append((p, rel.as_posix()))
    return sorted(files, key=lambda f: f[1])


def build(version: str) -> Path:
    out = ROOT / "dist" / f"templated-chatgpt-plugin-{version}.zip"
    out.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for path, arcname in package_files():
            info = zipfile.ZipInfo(arcname, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            zf.writestr(info, path.read_bytes())
    return out


def main() -> int:
    manifest = validate()
    for w in warnings:
        print(f"warning: {w}")
    for e in errors:
        print(f"error: {e}")
    if errors:
        print(f"{len(errors)} error(s); ZIP not built")
        return 1
    if "--check" in sys.argv:
        print("OK (check only)")
        return 0
    out = build(manifest["version"])
    with zipfile.ZipFile(out) as zf:
        names = zf.namelist()
    print(f"OK: {out} ({out.stat().st_size} bytes, {len(names)} files)")
    for n in names:
        print(f"  {n}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
