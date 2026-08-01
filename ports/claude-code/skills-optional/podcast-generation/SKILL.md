---
name: podcast-generation
description: Use this skill when the user requests to generate, create, or produce podcasts from text content. Converts written content into a two-host conversational podcast audio format with natural dialogue.
---

<!-- deerflow-origin: ported from skills/public/podcast-generation/ @ 0950924
     port: script/workspace/output paths; present_files -> final-message listing; capability gate prepended.
-->

## Requirements & capability check (optional module - run this FIRST)

This skill is a **DeerFlow optional module**. It ships disabled: the DeerFlow Claude Code
port has no external providers of its own, and this skill cannot do its job without the
capability listed below.

**Before doing anything else, run the check. Do not start the workflow, do not improvise a
substitute, and do not fabricate output.**

Required: a TTS provider - either `VOLCENGINE_TTS_APPID` + `VOLCENGINE_TTS_ACCESS_TOKEN`
(Volcengine) or `MINIMAX_API_KEY` (MiniMax) - plus Python 3 for `scripts/generate.py`.

```bash
{ test -n "$VOLCENGINE_TTS_APPID" && test -n "$VOLCENGINE_TTS_ACCESS_TOKEN"; } \
  || test -n "$MINIMAX_API_KEY" \
  || echo "MISSING: no TTS provider (VOLCENGINE_TTS_APPID+VOLCENGINE_TTS_ACCESS_TOKEN or MINIMAX_API_KEY)"
```

If the check fails, **STOP immediately** and tell the user, in plain terms:

1. exactly what is missing (name the environment variables / tools above);
2. how to provide it - for a missing API key, export the variable in the shell that
   launches Claude Code (or add it to the project environment); for a missing tool, run
   against a host that provides it (for example an MCP server) - then restart the session;
3. how to enable this module if it is not installed yet - copy
   `ports/claude-code/skills-optional/podcast-generation/` into the project's `.claude/skills/podcast-generation/`
   (or into `~/.claude/skills/podcast-generation/` for personal scope), or enable it through your
   Claude Code settings, then restart the session.

Then end your turn. Nothing below this section runs until the check passes.

When the check passes, set the path variables used by the commands below to the directory
this `SKILL.md` was loaded from:

```bash
SKILL_DIR=<absolute path of the directory containing this SKILL.md>
```

---

# Podcast Generation Skill

## Overview

This skill generates high-quality podcast audio from text content. The workflow includes creating a structured JSON script (conversational dialogue) and executing audio generation through text-to-speech synthesis.

## Core Capabilities

- Convert any text content (articles, reports, documentation) into podcast scripts
- Generate natural two-host conversational dialogue (male and female hosts)
- Synthesize speech audio using text-to-speech
- Mix audio chunks into a final podcast MP3 file
- Support both English and Chinese content

## Workflow

### Step 1: Understand Requirements

When a user requests podcast generation, identify:

- Source content: The text/article/report to convert into a podcast
- Language: English or Chinese (based on content)
- Output location: Where to save the generated podcast
- You don't need to browse the filesystem for inputs — use the paths of the files provided by the user

### Step 2: Create Structured Script JSON

Generate a structured JSON script file in `workspace/` with naming pattern: `{descriptive-name}-script.json`

The JSON structure:
```json
{
  "locale": "en",
  "lines": [
    {"speaker": "male", "paragraph": "dialogue text"},
    {"speaker": "female", "paragraph": "dialogue text"}
  ]
}
```

### Step 3: Execute Generation

Call the Python script:
```bash
python "$SKILL_DIR"/scripts/generate.py \
  --script-file workspace/script-file.json \
  --output-file outputs/generated-podcast.mp3 \
  --transcript-file outputs/generated-podcast-transcript.md
```

Parameters:

- `--script-file`: Absolute path to JSON script file (required)
- `--output-file`: Absolute path to output MP3 file (required)
- `--transcript-file`: Absolute path to output transcript markdown file (optional, but recommended)

> [!IMPORTANT]
> - Execute the script in one complete call. Do NOT split the workflow into separate steps.
> - The script handles all TTS API calls and audio generation internally.
> - Do NOT read the Python file, just call it with the parameters.
> - Always include `--transcript-file` to generate a readable transcript for the user.
> - The TTS provider and its concurrency are selected automatically from environment variables — you do not choose or tune them.

## Script JSON Format

The script JSON file must follow this structure:

```json
{
  "title": "The History of Artificial Intelligence",
  "locale": "en",
  "lines": [
    {"speaker": "male", "paragraph": "Hello Deer! Welcome back to another episode."},
    {"speaker": "female", "paragraph": "Hey everyone! Today we have an exciting topic to discuss."},
    {"speaker": "male", "paragraph": "That's right! We're going to talk about..."}
  ]
}
```

Fields:
- `title`: Title of the podcast episode (optional, used as heading in transcript)
- `locale`: Language code - "en" for English or "zh" for Chinese
- `lines`: Array of dialogue lines
  - `speaker`: Either "male" or "female"
  - `paragraph`: The dialogue text for this speaker

## Script Writing Guidelines

When creating the script JSON, follow these guidelines:

### Format Requirements
- Only two hosts: male and female, alternating naturally
- Target runtime: approximately 10 minutes of dialogue (around 40-60 lines)
- Start with the male host saying a greeting that includes "Hello Deer"

### Tone & Style
- Natural, conversational dialogue - like two friends chatting
- Use casual expressions and conversational transitions
- Avoid overly formal language or academic tone
- Include reactions, follow-up questions, and natural interjections

### Content Guidelines
- Frequent back-and-forth between hosts
- Keep sentences short and easy to follow when spoken
- Plain text only - no markdown formatting in the output
- Translate technical concepts into accessible language
- No mathematical formulas, code, or complex notation
- Make content engaging and accessible for audio-only listeners
- Exclude meta information like dates, author names, or document structure

## Podcast Generation Example

User request: "Generate a podcast about the history of artificial intelligence"

Step 1: Create script file `workspace/ai-history-script.json`:
```json
{
  "title": "The History of Artificial Intelligence",
  "locale": "en",
  "lines": [
    {"speaker": "male", "paragraph": "Hello Deer! Welcome back to another fascinating episode. Today we're diving into something that's literally shaping our future - the history of artificial intelligence."},
    {"speaker": "female", "paragraph": "Oh, I love this topic! You know, AI feels so modern, but it actually has roots going back over seventy years."},
    {"speaker": "male", "paragraph": "Exactly! It all started back in the 1950s. The term artificial intelligence was actually coined by John McCarthy in 1956 at a famous conference at Dartmouth."},
    {"speaker": "female", "paragraph": "Wait, so they were already thinking about machines that could think back then? That's incredible!"},
    {"speaker": "male", "paragraph": "Right? The early pioneers were so optimistic. They thought we'd have human-level AI within a generation."},
    {"speaker": "female", "paragraph": "But things didn't quite work out that way, did they?"},
    {"speaker": "male", "paragraph": "No, not at all. The 1970s brought what's called the first AI winter..."}
  ]
}
```

Step 2: Execute generation:
```bash
python "$SKILL_DIR"/scripts/generate.py \
  --script-file workspace/ai-history-script.json \
  --output-file outputs/ai-history-podcast.mp3 \
  --transcript-file outputs/ai-history-transcript.md
```

This will generate:
- `ai-history-podcast.mp3`: The audio podcast file
- `ai-history-transcript.md`: A readable markdown transcript of the podcast

## Specific Templates

Read the following template file only when matching the user request.

- [Tech Explainer](templates/tech-explainer.md) - For converting technical documentation and tutorials

## Output Format

The generated podcast follows the "Hello Deer" format:
- Two hosts: one male, one female
- Natural conversational dialogue
- Starts with "Hello Deer" greeting
- Target duration: approximately 10 minutes
- Alternating speakers for engaging flow

## Output Handling

After generation:

- Podcasts and transcripts are saved in `outputs/`
- Share both the podcast MP3 and transcript MD with the user by listing their paths in your final message
- Provide brief description of the generation result (topic, duration, hosts)
- Offer to regenerate if adjustments needed

## Requirements

The following environment variables must be set:
- For Volcengine: `VOLCENGINE_TTS_APPID` and `VOLCENGINE_TTS_ACCESS_TOKEN`
- For MiniMax: `MINIMAX_API_KEY`
- `VOLCENGINE_TTS_CLUSTER`: Volcengine TTS cluster (optional, defaults to "volcano_tts")

## Notes

- **Always execute the full pipeline in one call** - no need to test individual steps or worry about timeouts
- The script JSON should match the content language (en or zh)
- Technical content should be simplified for audio accessibility in the script
- Complex notations (formulas, code) should be translated to plain language in the script
- Long content may result in longer podcasts

## Providers (Volcengine / MiniMax)

Auto-selected by environment variables:

- `VOLCENGINE_TTS_APPID` + `VOLCENGINE_TTS_ACCESS_TOKEN` set → Volcengine TTS (default).
- Only `MINIMAX_API_KEY` set → MiniMax TTS (`/v1/t2a_v2`).
- Force with `PODCAST_GENERATION_PROVIDER=volcengine|minimax`.

MiniMax overrides: `MINIMAX_API_HOST` (default `https://api.minimaxi.com`),
`MINIMAX_TTS_MODEL` (default `speech-2.6-hd`), `MINIMAX_TTS_VOICE_MALE`
(default `male-qn-qingse`), `MINIMAX_TTS_VOICE_FEMALE` (default `female-tianmei`).

Concurrency is owned by each provider internally — MiniMax runs single-threaded
to reduce rate-limit failures, Volcengine uses 4 workers. There is no
caller-facing concurrency knob; transient rate limits are handled by automatic
retry with backoff.
