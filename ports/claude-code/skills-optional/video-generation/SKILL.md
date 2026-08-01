---
name: video-generation
description: Use this skill when the user requests to generate, create, or imagine videos. Supports structured prompts and reference image for guided generation.
---

<!-- deerflow-origin: ported from skills/public/video-generation/ @ 0950924
     port: script/workspace/output paths; present_files -> final-message listing; capability gate prepended.
-->

## Requirements & capability check (optional module - run this FIRST)

This skill is a **DeerFlow optional module**. It ships disabled: the DeerFlow Claude Code
port has no external providers of its own, and this skill cannot do its job without the
capability listed below.

**Before doing anything else, run the check. Do not start the workflow, do not improvise a
substitute, and do not fabricate output.**

Required: a video-generation provider API key - `GEMINI_API_KEY` (Veo, default) or
`MINIMAX_API_KEY` (MiniMax fallback) - plus Python 3 for `scripts/generate.py`.

```bash
test -n "$GEMINI_API_KEY" || test -n "$MINIMAX_API_KEY" \
  || echo "MISSING: no video provider key (GEMINI_API_KEY or MINIMAX_API_KEY)"
```

If the check fails, **STOP immediately** and tell the user, in plain terms:

1. exactly what is missing (name the environment variables / tools above);
2. how to provide it - for a missing API key, export the variable in the shell that
   launches Claude Code (or add it to the project environment); for a missing tool, run
   against a host that provides it (for example an MCP server) - then restart the session;
3. how to enable this module if it is not installed yet - copy
   `ports/claude-code/skills-optional/video-generation/` into the project's `.claude/skills/video-generation/`
   (or into `~/.claude/skills/video-generation/` for personal scope), or enable it through your
   Claude Code settings, then restart the session.

Then end your turn. Nothing below this section runs until the check passes.

When the check passes, set the path variables used by the commands below to the directory
this `SKILL.md` was loaded from:

```bash
SKILL_DIR=<absolute path of the directory containing this SKILL.md>
```

---

# Video Generation Skill

## Overview

This skill generates high-quality videos using structured prompts and a Python script. The workflow includes creating JSON-formatted prompts and executing video generation with optional reference image.

## Core Capabilities

- Create structured JSON prompts for AIGC video generation
- Support reference image as guidance or the first/last frame of the video
- Generate videos through automated Python script execution

## Workflow

### Step 1: Understand Requirements

When a user requests video generation, identify:

- Subject/content: What should be in the image
- Style preferences: Art style, mood, color palette
- Technical specs: Aspect ratio, composition, lighting
- Reference image: Any image to guide generation
- You don't need to browse the filesystem for inputs — use the paths of the files provided by the user

### Step 2: Create Structured Prompt

Generate a structured JSON file in `workspace/` with naming pattern: `{descriptive-name}.json`

### Step 3: Create Reference Image (Optional when image-generation skill is available)

Generate reference image for the video generation.

- If only 1 image is provided, use it as the guided frame of the video

### Step 3: Execute Generation

Call the Python script:
```bash
python "$SKILL_DIR"/scripts/generate.py \
  --prompt-file workspace/prompt-file.json \
  --reference-images /path/to/ref1.jpg \
  --output-file outputs/generated-video.mp4 \
  --aspect-ratio 16:9
```

Parameters:

- `--prompt-file`: Absolute path to JSON prompt file (required)
- `--reference-images`: Absolute paths to reference image (optional)
- `--output-file`: Absolute path to output image file (required)
- `--aspect-ratio`: Aspect ratio of the generated image (optional, default: 16:9)

[!NOTE]
Do NOT read the python file, instead just call it with the parameters.

## Video Generation Example

User request: "Generate a short video clip depicting the opening scene from "The Chronicles of Narnia: The Lion, the Witch and the Wardrobe"

Step 1: Search for the opening scene of "The Chronicles of Narnia: The Lion, the Witch and the Wardrobe" online

Step 2: Create a JSON prompt file with the following content:

```json
{
  "title": "The Chronicles of Narnia - Train Station Farewell",
  "background": {
    "description": "World War II evacuation scene at a crowded London train station. Steam and smoke fill the air as children are being sent to the countryside to escape the Blitz.",
    "era": "1940s wartime Britain",
    "location": "London railway station platform"
  },
  "characters": ["Mrs. Pevensie", "Lucy Pevensie"],
  "camera": {
    "type": "Close-up two-shot",
    "movement": "Static with subtle handheld movement",
    "angle": "Profile view, intimate framing",
    "focus": "Both faces in focus, background soft bokeh"
  },
  "dialogue": [
    {
      "character": "Mrs. Pevensie",
      "text": "You must be brave for me, darling. I'll come for you... I promise."
    },
    {
      "character": "Lucy Pevensie",
      "text": "I will be, mother. I promise."
    }
  ],
  "audio": [
    {
      "type": "Train whistle blows (signaling departure)",
      "volume": 1
    },
    {
      "type": "Strings swell emotionally, then fade",
      "volume": 0.5
    },
    {
      "type": "Ambient sound of the train station",
      "volume": 0.5
    }
  ]
}
```

Step 3: Use the image-generation skill to generate the reference image

Load the image-generation skill and generate a single reference image `narnia-farewell-scene-01.jpg` according to the skill.

Step 4: Use the generate.py script to generate the video
```bash
python "$SKILL_DIR"/scripts/generate.py \
  --prompt-file workspace/narnia-farewell-scene.json \
  --reference-images outputs/narnia-farewell-scene-01.jpg \
  --output-file outputs/narnia-farewell-scene-01.mp4 \
  --aspect-ratio 16:9
```
> Do NOT read the python file, just call it with the parameters.

## Output Handling

After generation:

- Videos are typically saved in `outputs/`
- Share generated videos (come first) with the user as well as the generated image if applicable, by listing their paths in your final message
- Provide brief description of the generation result
- Offer to iterate if adjustments needed

## Notes

- Always use English for prompts regardless of user's language
- JSON format ensures structured, parsable prompts
- Reference image enhance generation quality significantly
- Iterative refinement is normal for optimal results

## Providers (Gemini / MiniMax)

Auto-selected by environment variables (CLI unchanged):

- `GEMINI_API_KEY` set → Gemini Veo (default, unchanged).
- Only `MINIMAX_API_KEY` set → MiniMax video (`/v1/video_generation`, async 3-step poll/download).
- Force with `VIDEO_GENERATION_PROVIDER=gemini|minimax`.

MiniMax overrides: `MINIMAX_API_HOST` (default `https://api.minimaxi.com`),
`MINIMAX_VIDEO_MODEL` (default `MiniMax-Hailuo-2.3`). The first reference image is used
as MiniMax `first_frame_image`. MiniMax ignores `--aspect-ratio` (it uses resolution/duration).
