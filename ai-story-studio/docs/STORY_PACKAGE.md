# Story Package format (v1)

A **Story Package** is one JSON document that carries a complete episode, from the project and cast to every shot, line and sound cue. Import it with **Stories → Import Story Package**. You can also import it from code with `importStoryPackage(studio, json, { projectId? })`.

- The package is **validated first**: schema, types, limits, unique keys and cross-references. Every problem is reported with its JSON path, e.g. `scenes[1].shots[0].characters[0].character: unknown character "ghost"`.
- The import runs in **one database transaction**. If anything fails, nothing is written, and the failed attempt is recorded in the import history.
- Paid LLM APIs are never needed. You can write packages by hand, export them from your own tools, or generate them with any assistant you like.

Complete examples:

- [`examples/story-package.example.json`](examples/story-package.example.json) creates a new project.
- [`examples/story-package.episode2.example.json`](examples/story-package.episode2.example.json) imports into an existing project.

## Top level

| Field        | Type                              | Required | Notes                                                                                                      |
| ------------ | --------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| `format`     | `"ai-story-studio/story-package"` | yes      |                                                                                                            |
| `version`    | `1`                               | yes      | number or string                                                                                           |
| `project`    | object                            | \*       | Required when importing into a **new** project. Omit it when importing into an existing project.           |
| `styles`     | array of Style                    | no       | Project-scoped style presets. Existing presets with the same name are reused.                              |
| `narrator`   | Voice                             | no       | Project narrator. Ignored if the project already has a narrator, to keep that narrator's voice consistent. |
| `characters` | array of Character                | no       |                                                                                                            |
| `locations`  | array of Location                 | no       |                                                                                                            |
| `props`      | array of Prop                     | no       |                                                                                                            |
| `story`      | Story                             | yes      |                                                                                                            |
| `scenes`     | array of Scene (≥ 1)              | yes      | In story order.                                                                                            |

Unknown fields are rejected to catch typos. Text fields have length limits (typically 200–5000 characters, and 100,000 for `storyText`). The whole package must be ≤ 2 MB.

### Keys and reuse

Characters, variants, locations, props, styles, scenes and shots each have a package-local `key` made of letters, digits, `-` or `_`. Other entries refer to them by that key.

When importing into an **existing project**, an entity whose **name** matches an existing one is **reused unchanged**. That applies to characters, variants, locations, props and styles. Locked entities are never modified. To reference recurring cast, list them with just `key` and `name`:

```json
"characters": [{ "key": "pip", "name": "Pip", "variants": [{ "key": "raincoat", "name": "Rain coat" }] }]
```

## project

`name` (required), `series`, `description`, `genre`, `targetAudience`, `aspectRatio` (`"16:9"` | `"9:16"`), `fps` (`24` | `30`), `defaultQuality` (`"fast_preview"` | `"optimized"` | `"high_quality"`), `defaultStyle` (a style `key` from this package, or the name of an existing/built-in preset), `productionNotes`.

## Style

`key`, `name`, `stylePrompt`, `rendering`, `lighting`, `colors`, `camera`, `negativePrompt`.

## Voice (narrator or character voice)

| Field            | Notes                                                    |
| ---------------- | -------------------------------------------------------- |
| `name`           |                                                          |
| `voiceModel`     | Defaults to `mock-tts` in Phase 1.                       |
| `voiceIdentity`  | Model-specific speaker id or reference id.               |
| `language`       | BCP-47-like code, e.g. `en`, `hi-IN`.                    |
| `presentation`   | `male` / `female` / `neutral`                            |
| `pitch`          | Semitones, from -12 to 12.                               |
| `speed`          | From 0.5 to 2.                                           |
| `speakingStyle`  |                                                          |
| `narrationStyle` | e.g. `warm storyteller`, `calm bedtime narrator`         |
| `defaultEmotion` | One of the emotions listed below.                        |
| `settings`       | Free-form object for model-specific settings, max 16 KB. |

Emotions: `neutral, happy, sad, excited, afraid, angry, whispering, tired, surprised, nervous, calm`.

## Character

`key`, `name`, `species`, `age`, `role`, `personality`, `appearance`, `face`, `hair`, `eyes`, `body`, `proportions`, `clothing`, `accessories`, `colors`, `prompt`, `negativePrompt`, `preferredSeeds` (array of integers), `voice` (Voice), `variants` (array of Variant).

Variant fields are `key`, `name`, `description`, `clothingOverride`, `promptAdditions` and `negativeAdditions`. A variant changes outfit or state, such as winter clothes, a wet version or a costume. It never changes the canonical identity.

## Location

`key`, `name`, `description`, `environment`, `architecture`, `importantObjects`, `colors`, `lighting`, `weather`, `timeOfDay`, `prompt`, `negativePrompt`.

## Prop

`key`, `name`, `description`, `scale`, `colors`, `prompt`, `negativePrompt`, `characters` (array of character keys).

## story

`title` (required), `episodeNumber`, `synopsis`, `storyText`, `moral`, `language` (default `en`), `targetDurationSec` (default 60; any length from 5 s to 4 h), `productionNotes`.

## Scene

| Field       | Notes                                                                        |
| ----------- | ---------------------------------------------------------------------------- |
| `key`       |                                                                              |
| `title`     | required                                                                     |
| `summary`   |                                                                              |
| `location`  | location key                                                                 |
| `timeOfDay` |                                                                              |
| `music`     | `{ "mood": "gentle suspense", "genre": "…", "energy": "low\|medium\|high" }` |
| `ambience`  | e.g. `forest`, `rain`, `city`                                                |
| `narration` | Lines placed at the start of the scene.                                      |
| `shots`     | ≥ 1, in order                                                                |
| `notes`     |                                                                              |

## Shot

| Field            | Notes                                                                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `key`            |                                                                                                                                        |
| `title`          |                                                                                                                                        |
| `action`         | What happens in the shot.                                                                                                              |
| `emotion`        |                                                                                                                                        |
| `characters`     | `[{ "character": "pip", "variant": "raincoat" }]`. `variant` is optional.                                                              |
| `props`          | Array of prop keys.                                                                                                                    |
| `location`       | Overrides the scene location.                                                                                                          |
| `style`          | Style key; overrides the project default.                                                                                              |
| `camera`         | `{ "framing": "wide shot", "angle": "low", "movement": "tracking" }`                                                                   |
| `lighting`       |                                                                                                                                        |
| `imagePrompt`    | Extra shot notes appended to the built prompt, or the verbatim prompt when `lockPrompts` is true.                                      |
| `motionPrompt`   | Same rules as `imagePrompt`.                                                                                                           |
| `negativePrompt` | Same rules as `imagePrompt`.                                                                                                           |
| `lockPrompts`    | `true` marks non-empty prompts as manual. The Prompt Builder then never overwrites them.                                               |
| `durationSec`    | From 0.5 to 60. Default 5.                                                                                                             |
| `fps`            | `24` or `30`. Defaults to the project FPS.                                                                                             |
| `seed`           | Optional fixed seed.                                                                                                                   |
| `generationMode` | `fast_preview` / `optimized` / `high_quality`                                                                                          |
| `mouthVisible`   | A speaking mouth is visible, so lip sync applies.                                                                                      |
| `lipSync`        | Default `true`. Set `false` to disable lip sync for this shot.                                                                         |
| `dialogue`       | `[{ "character": "pip", "text": "…", "emotion": "nervous", "delivery": "whispered", "speed": 1, "language": "en", "required": true }]` |
| `narration`      | Lines placed at this shot.                                                                                                             |
| `sfx`            | `[{ "tag": "footsteps", "offsetSec": 0.5, "required": false }]`                                                                        |
| `musicNotes`     |                                                                                                                                        |
| `ambienceNotes`  |                                                                                                                                        |

Narration line fields are `text`, `emotion`, `speed`, `language` and `required`.

A speaker with `mouthVisible: true` must also be listed in the shot's `characters`, because lip sync is only applied to visible characters. Off-screen speakers are fine when `mouthVisible` is false.

## Multilingual note

Story, dialogue and narration text and their `language` are stored separately from video assets. A later phase can add another language's lines and voices to the same approved animation without regenerating any video.
