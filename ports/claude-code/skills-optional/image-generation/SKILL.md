---
name: image-generation
description: Use this skill when the user requests to generate, create, imagine, or visualize images including characters, scenes, products, or any visual content. Supports structured prompts and reference images for guided generation.
---

<!-- deerflow-origin: ported from skills/public/image-generation/ @ 0950924
     port: script/workspace/output paths; present_files -> final-message listing; capability gate prepended.
-->

## Requirements & capability check (optional module - run this FIRST)

This skill is a **DeerFlow optional module**. It ships disabled: the DeerFlow Claude Code
port has no external providers of its own, and this skill cannot do its job without the
capability listed below.

**Before doing anything else, run the check. Do not start the workflow, do not improvise a
substitute, and do not fabricate output.**

Required: an image-generation provider API key - `GEMINI_API_KEY` (Gemini, default)
or `MINIMAX_API_KEY` (MiniMax fallback) - plus Python 3 for `scripts/generate.py`.

```bash
test -n "$GEMINI_API_KEY" || test -n "$MINIMAX_API_KEY" \
  || echo "MISSING: no image provider key (GEMINI_API_KEY or MINIMAX_API_KEY)"
```

If the check fails, **STOP immediately** and tell the user, in plain terms:

1. exactly what is missing (name the environment variables / tools above);
2. how to provide it - for a missing API key, export the variable in the shell that
   launches Claude Code (or add it to the project environment); for a missing tool, run
   against a host that provides it (for example an MCP server) - then restart the session;
3. how to enable this module if it is not installed yet - copy
   `ports/claude-code/skills-optional/image-generation/` into the project's `.claude/skills/image-generation/`
   (or into `~/.claude/skills/image-generation/` for personal scope), or enable it through your
   Claude Code settings, then restart the session.

Then end your turn. Nothing below this section runs until the check passes.

When the check passes, set the path variables used by the commands below to the directory
this `SKILL.md` was loaded from:

```bash
SKILL_DIR=<absolute path of the directory containing this SKILL.md>
```

---

# Image Generation Skill

## Overview

This skill generates high-quality images using structured prompts and a Python script. The workflow includes creating JSON-formatted prompts and executing image generation with optional reference images.

## Core Capabilities

- Create structured JSON prompts for AIGC image generation
- Support multiple reference images for style/composition guidance
- Generate images through automated Python script execution
- Handle various image generation scenarios (character design, scenes, products, etc.)

## Workflow

### Step 1: Understand Requirements

When a user requests image generation, identify:

- Subject/content: What should be in the image
- Style preferences: Art style, mood, color palette
- Technical specs: Aspect ratio, composition, lighting
- Reference images: Any images to guide generation
- You don't need to browse the filesystem for inputs — use the paths of the files provided by the user

### Step 2: Create Structured Prompt

Generate a structured JSON file in `workspace/` with naming pattern: `{descriptive-name}.json`

### Step 3: Execute Generation

Call the Python script:
```bash
python "$SKILL_DIR"/scripts/generate.py \
  --prompt-file workspace/prompt-file.json \
  --reference-images /path/to/ref1.jpg /path/to/ref2.png \
  --output-file outputs/generated-image.jpg
  --aspect-ratio 16:9
```

Parameters:

- `--prompt-file`: Absolute path to JSON prompt file (required)
- `--reference-images`: Absolute paths to reference images (optional, space-separated)
- `--output-file`: Absolute path to output image file (required)
- `--aspect-ratio`: Aspect ratio of the generated image (optional, default: 16:9)

[!NOTE]
Do NOT read the python file, just call it with the parameters.

## Character Generation Example

User request: "Create a Tokyo street style woman character in 1990s"

Create prompt file: `workspace/asian-woman.json`
```json
{
  "characters": [{
    "gender": "female",
    "age": "mid-20s",
    "ethnicity": "Japanese",
    "body_type": "slender, elegant",
    "facial_features": "delicate features, expressive eyes, subtle makeup with emphasis on lips, long dark hair partially wet from rain",
    "clothing": "stylish trench coat, designer handbag, high heels, contemporary Tokyo street fashion",
    "accessories": "minimal jewelry, statement earrings, leather handbag",
    "era": "1990s"
  }],
  "negative_prompt": "blurry face, deformed, low quality, overly sharp digital look, oversaturated colors, artificial lighting, studio setting, posed, selfie angle",
  "style": "Leica M11 street photography aesthetic, film-like rendering, natural color palette with slight warmth, bokeh background blur, analog photography feel",
  "composition": "medium shot, rule of thirds, subject slightly off-center, environmental context of Tokyo street visible, shallow depth of field isolating subject",
  "lighting": "neon lights from signs and storefronts, wet pavement reflections, soft ambient city glow, natural street lighting, rim lighting from background neons",
  "color_palette": "muted naturalistic tones, warm skin tones, cool blue and magenta neon accents, desaturated compared to digital photography, film grain texture"
}
```

Execute generation:
```bash
python "$SKILL_DIR"/scripts/generate.py \
  --prompt-file workspace/cyberpunk-hacker.json \
  --output-file outputs/cyberpunk-hacker-01.jpg \
  --aspect-ratio 2:3
```

With reference images:
```json
{
  "characters": [{
    "gender": "based on [Image 1]",
    "age": "based on [Image 1]",
    "ethnicity": "human from [Image 1] adapted to Star Wars universe",
    "body_type": "based on [Image 1]",
    "facial_features": "matching [Image 1] with slight weathered look from space travel",
    "clothing": "Star Wars style outfit - worn leather jacket with utility vest, cargo pants with tactical pouches, scuffed boots, belt with holster",
    "accessories": "blaster pistol on hip, comlink device on wrist, goggles pushed up on forehead, satchel with supplies, personal vehicle based on [Image 2]",
    "era": "Star Wars universe, post-Empire era"
  }],
  "prompt": "Character inspired by [Image 1] standing next to a vehicle inspired by [Image 2] on a bustling alien planet street in Star Wars universe aesthetic. Character wearing worn leather jacket with utility vest, cargo pants with tactical pouches, scuffed boots, belt with blaster holster. The vehicle adapted to Star Wars aesthetic with weathered metal panels, repulsor engines, desert dust covering, parked on the street. Exotic alien marketplace street with multi-level architecture, weathered metal structures, hanging market stalls with colorful awnings, alien species walking by as background characters. Twin suns casting warm golden light, atmospheric dust particles in air, moisture vaporators visible in distance. Gritty lived-in Star Wars aesthetic, practical effects look, film grain texture, cinematic composition.",
  "negative_prompt": "clean futuristic look, sterile environment, overly CGI appearance, fantasy medieval elements, Earth architecture, modern city",
  "style": "Star Wars original trilogy aesthetic, lived-in universe, practical effects inspired, cinematic film look, slightly desaturated with warm tones",
  "composition": "medium wide shot, character in foreground with alien street extending into background, environmental storytelling, rule of thirds",
  "lighting": "warm golden hour lighting from twin suns, rim lighting on character, atmospheric haze, practical light sources from market stalls",
  "color_palette": "warm sandy tones, ochre and sienna, dusty blues, weathered metals, muted earth colors with pops of alien market colors",
  "technical": {
    "aspect_ratio": "9:16",
    "quality": "high",
    "detail_level": "highly detailed with film-like texture"
  }
}
```
```bash
python "$SKILL_DIR"/scripts/generate.py \
  --prompt-file workspace/star-wars-scene.json \
  --reference-images ./character-ref.jpg ./vehicle-ref.jpg \
  --output-file outputs/star-wars-scene-01.jpg \
  --aspect-ratio 16:9
```

## Common Scenarios

Use different JSON schemas for different scenarios.

**Character Design**:
- Physical attributes (gender, age, ethnicity, body type)
- Facial features and expressions
- Clothing and accessories
- Historical era or setting
- Pose and context

**Scene Generation**:
- Environment description
- Time of day, weather
- Mood and atmosphere
- Focal points and composition

**Product Visualization**:
- Product details and materials
- Lighting setup
- Background and context
- Presentation angle

## Specific Templates

Read the following template file only when matching the user request.

- [Doraemon Comic](templates/doraemon.md)

## Output Handling

After generation:

- Images are typically saved in `outputs/`
- Share generated images with the user by listing their paths in your final message
- Provide brief description of the generation result
- Offer to iterate if adjustments needed

## Tips: Enhancing Generation with Reference Images

For scenarios where visual accuracy is critical, **use the `image_search` tool first** to find reference images before generation.

**Recommended scenarios for using image_search tool:**
- **Character/Portrait Generation**: Search for similar poses, expressions, or styles to guide facial features and body proportions
- **Specific Objects or Products**: Find reference images of real objects to ensure accurate representation
- **Architectural or Environmental Scenes**: Search for location references to capture authentic details
- **Fashion and Clothing**: Find style references to ensure accurate garment details and styling

**Example workflow:**
1. Call the `image_search` tool to find suitable reference images:
   ```
   image_search(query="Japanese woman street photography 1990s", size="Large")
   ```
2. Download the returned image URLs to local files
3. Use the downloaded images as `--reference-images` parameter in the generation script

This approach significantly improves generation quality by providing the model with concrete visual guidance rather than relying solely on text descriptions.

## Providers (Gemini / MiniMax)

This skill auto-selects the provider by environment variables (no CLI change):

- `GEMINI_API_KEY` set → use Gemini (default, unchanged).
- Only `MINIMAX_API_KEY` set → use MiniMax (`/v1/image_generation`, model `image-01`).
- Force one explicitly with `IMAGE_GENERATION_PROVIDER=gemini|minimax`.

MiniMax optional overrides: `MINIMAX_API_HOST` (default `https://api.minimaxi.com`),
`MINIMAX_IMAGE_MODEL` (default `image-01`). Reference images are sent as the MiniMax
`subject_reference` character image. The CLI and `--prompt-file` / `--reference-images`
/ `--output-file` / `--aspect-ratio` arguments are identical for both providers.

**MiniMax prompt handling (provider-internal).** Authoring is provider-agnostic — write
the same structured JSON regardless of which provider is active. MiniMax `image-01`
consumes a single text string, so the MiniMax path itself sends only the JSON `prompt`
field (the other fields such as `style` / `composition` / `negative_prompt` apply to the
Gemini path) and enables `prompt_optimizer` so MiniMax expands it server-side. MiniMax
caps that prompt at 1500 characters; if the `prompt` field is longer, the script returns
an error instead of calling the API. The Gemini path receives the full structured JSON.

## Notes

- Always use English for prompts regardless of user's language
- JSON format ensures structured, parsable prompts
- Reference images enhance generation quality significantly
- Iterative refinement is normal for optimal results
- For character generation, include the detailed character object plus a consolidated prompt field
