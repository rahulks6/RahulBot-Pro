# Language versions (English master + Hinglish)

Every series episode is written and made in **English** (the canonical script and the master).
The **Hinglish** version (`hi-Latn`, the INDIA_HINGLISH localization) is made from it:

```
English script ──► pictures + animation (ONE master, 1920×1080, 30 fps, no text burned in)
      │                    │
      │                    ├──► English voices + music/SFX ──► EPISODE_EN.mp4, Shorts, captions, thumbnail
      │                    │
      └─► Hinglish lines ──┴──► Hinglish voices + music/SFX ──► EPISODE_HINGLISH.mp4, Shorts, captions, thumbnail
```

## Shared master visuals

A language version is a **copy of the story** (`stories.source_story_id` points at the English
one) whose shots use the **same approved picture and the same approved clip**
(`approved_image_asset_id`, `approved_video_asset_id`). No picture or clip is generated twice, so
the two versions cannot drift apart visually and the GPU cost of a second language is only the
voices. Lip sync is switched off for language versions (it is language-specific; the shared
master uses general talking animation — no strict lip sync, as the spec allows).

Music, ambience and sound-effect cues are copied with the same settings; the audio pipeline's
content-addressed cache reuses the already-made audio for identical requests, so both versions
share the same score where the timing matches. Only the **dialogue and narration** are separate
per language.

The video's stage list shows **Hinglish version** between "Titles, descriptions and tags" and
"Quality check". Videos that do not ask for a language version show it as skipped.

## How the Hinglish lines are made

1. All narration and dialogue lines are sent to the story model in chunks of 30 with the
   [Hinglish style guide](HINGLISH_STYLE_GUIDE.md), the character names (never translated) and
   each speaker's **Hinglish style** (share of English words, tone, notes). Title, logline and
   lesson are localized too.
2. Every answer is checked (`src/services/hinglish.ts`): Roman script only (no Devanagari in the
   caption text), no formal/"shuddh" Hindi words, not just English, not too much Hindi for that
   speaker, character names kept, numbers kept, not much longer than the English line, not empty.
   Lines with errors are asked for again (up to 3 rounds); the rest are flagged.
3. For **speech**, each line gets a `speech_text`: Hindi words are written in Devanagari (from a
   Roman → Devanagari lexicon and the character pronunciations), English words stay in Latin
   letters. The worker's Kokoro voice sends Devanagari runs to its Hindi phonemizer and Latin runs
   to its English one, with one Hindi voice for the whole line. Captions always use the Roman text.

   Example: `Portal ki power down ho rahi hai. Sirf thirty seconds hain!` is spoken from
   `Portal की power down हो रही है. सिर्फ़ thirty seconds हैं!`

4. Each character (and the narrator) gets a persistent Hinglish voice profile, "&lt;Name&gt; (Hinglish)",
   using a Kokoro Hindi voice (`hf_alpha`, `hf_beta`, `hm_omega`, `hm_psi`) matched to the
   English voice's presentation, recorded in the character's canon so every episode uses the same
   one. The English voice is never changed.

## Timing fit (no lip sync, but no overruns)

After the Hinglish voices are made, each line is compared with its English line. A line longer
than 1.15 × the English line + 0.3 s:

1. is **rewritten shorter** by the story model (and re-checked);
2. if still too long, is **spoken slightly faster** (at most 1.12×);
3. if still too long, is **flagged**: the version is marked NEEDS ATTENTION and the line is listed
   in the quality check and on the episode review screen.

## Outputs per language version

`localizations` table, one row per (video, Short, language):

- final MP4 (`video_key`, 1920×1080 or 1080×1920 for Shorts, H.264/AAC),
- captions SRT + WebVTT in Roman Hinglish (burned into Shorts only when that setting is on),
- thumbnail with the Hinglish title,
- YouTube metadata: Hinglish title, description (with the AI disclosure in Hinglish), tags and
  hashtags, `defaultLanguage: hi`, captions uploaded as `hi-Latn`,
- QA (`qa_json`) and timing (`timing_json`) results.

Quality check findings: `localization`, `localization_timing`, `localization_style`,
`localization_mismatch` (e.g. a missing version or a much shorter/longer total duration than the
master).

## Status

- PASS (automated, developer test mode, real FFmpeg): shared master (same picture/clip assets),
  EN + HI finals, Shorts, Roman captions, speech text, Hindi voice profiles, timing fit (rewrite →
  pace → flag), metadata, QC findings (`test/series.test.ts`).
- The placeholder Hinglish in developer test mode is word substitution, clearly labelled — it says
  nothing about the quality of real Hinglish.
- BLOCKED here: real Hinglish from the story model and real Hindi/Hinglish voices from Kokoro
  (they need the RunPod worker). The Real Mode Test on your PC now includes a real Hinglish
  narration and a Hinglish MP4 made from the same animated clip.
