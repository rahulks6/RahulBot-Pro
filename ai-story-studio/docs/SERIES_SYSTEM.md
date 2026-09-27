# Series system

AI Story Studio can make an **animated series**: the same characters, world and rules across many
episodes, with a memory of what happened. It is built on top of the normal production pipeline
(story → pictures → animation → voices → final video), not beside it.

Simple Mode → **SERIES**.

## What a series is

| Part                | Where it lives                                          | What it holds                                                                                                                                                                                                                                                                                                                            |
| ------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Series              | `series` table (one per project)                        | name, description, genre, target age and audience, style, tone, minutes per episode, master language (English) and the language versions (Hinglish).                                                                                                                                                                                     |
| Series Bible        | `series.bible_json`                                     | PREMISE, WORLD, TIMELINE, SCIENCE / TECHNOLOGY RULES, FICTION RULES, CHARACTERS, RELATIONSHIPS, LOCATIONS, VEHICLES, PROPS, ORGANIZATIONS, ANTAGONISTS, visual/camera/lighting/colour language, music and SFX identity, INTRO, OUTRO, STORY RULES, AGE-SAFETY RULES, CONTINUITY RULES, BANNED CONTENT, RECURRING MYSTERIES, SEASON ARCS. |
| Canon: characters   | the series project's `characters` + `series_characters` | look (face, hair, clothes, colours), approved reference pictures and locks; role, personality, speech style, catchphrases, relationships; **Hinglish style** (share of English words, tone, notes); **pronunciation** (Devanagari, for the Hindi voice); an English and a Hinglish voice.                                                |
| Canon: places/props | the project's `locations` / `props` (+ `canon_json`)    | description, prompt, reference pictures, locks.                                                                                                                                                                                                                                                                                          |
| Seasons             | `seasons`                                               | number, title, episode target, premise, main mystery, arcs, beginning / midseason / finale state, status.                                                                                                                                                                                                                                |
| Episodes            | `episodes`                                              | number, working title, English and Hinglish titles, idea, premise, synopsis, lesson, story features (for duplicate detection), similarity and continuity results, story and production status, the video.                                                                                                                                |
| Continuity memory   | `continuity_facts`                                      | events, relationships, discoveries, new characters/places, object and character states, open and resolved mysteries — each `proposed`, `canon`, `rejected` or `retired`.                                                                                                                                                                 |

The **sci-fi starter** fills the bible with an original starting point (two curious kids and a
helper robot in a future city; no existing franchise). Everything is editable. "Empty bible" starts
from nothing.

## Making an episode

**GENERATE EPISODE** (series screen):

1. An episode row is created (or the next **planned** episode is used when no idea is typed).
2. The writer gets a **compact series memory** (never the whole history): premise, world, rules,
   tone and age, the season plan, the recurring characters (look, personality, speech), the
   locations, up to 40 canon facts, the last 6 episodes (title + synopsis), open mysteries, and
   the recent problems / villains / settings / lessons to **avoid**.
3. The writer returns the English script plus **episode notes**: premise, synopsis, lesson, story
   features (problem, setting, villain, science, resolution, lesson, set piece) and the canon it
   adds.
4. **Duplicate detection** compares the story features (not the titles) with earlier episodes
   (weighted word overlap: problem 0.30, resolution 0.20, set piece 0.15, science 0.12, villain
   0.10, setting 0.08, lesson 0.05). At 0.50 or more the story is written again once with a
   warning; if it is still similar, the episode is flagged for the person.
5. The **continuity validator** checks the script against canon: a misspelled canon name is fixed
   (edit distance), a canon look is restored, canon place names are enforced, "X is gone /
   destroyed" facts used again are errors; new characters and places are noted.
6. The facts from the new episode are stored as **proposed**. Nothing changes the canon yet.
7. Production continues as for any video (pictures, animation, voices, captions, Shorts,
   thumbnails, metadata), then the language versions (see [LOCALIZATION.md](LOCALIZATION.md)),
   then quality checks, then **READY FOR REVIEW**.

Only one episode per season is made at a time (a second GENERATE is refused until the first is
finished), so the second always sees the first.

## Canon only changes on approval

The episode review screen (SERIES → the episode) shows the English and Hinglish versions side by
side, the checks (repeat, continuity, Hinglish wording and timing) and **what this episode adds to
the canon**.

- **APPROVE EPISODE**: its proposed facts become canon; later episodes are written with them.
- **REJECT**: its facts are marked rejected and never reach the writer; the videos are kept (never
  deleted automatically), the episode number stays used.

Approving the story uploads nothing. Publishing is a separate, deliberate step
([YOUTUBE_SETUP.md](YOUTUBE_SETUP.md)).

Canon facts can also be added by hand, and retired (the writer stops using them; they stay in the
history).

## PLAN SEASON

The story model suggests N new episode ideas for the season (title, premise, problem, setting,
science, lesson) from the bible, the season plan and the episodes so far. Ideas too close to an
earlier or already planned episode (same 0.50 rule) are dropped and listed. The rest are saved as
**PLANNED** episodes: nothing is made until MAKE THIS EPISODE (or GENERATE with an empty idea).
Planned ideas can be removed; made episodes are never deleted from here.

## Production calendar and content buffer

The series screen shows, per YouTube channel profile, how many episodes are already scheduled and
until when, how many are ready for review (LOW BUFFER under 2), and the next 3 weeks of scheduled
uploads.

## What is proven and what is not

- PASS (automated, developer test mode with placeholder AI and real FFmpeg): series creation,
  bible, seasons, planned episodes, three consecutive episodes with memory, duplicate detection,
  continuity fixes, canon only on approval, rejected episodes kept out of canon, the Series screens
  through HTTP (`test/series.test.ts`, `test/series-web.test.ts`).
- BLOCKED here: the **quality** of real stories, continuity judgement and episode ideas from the
  real story model (Qwen2.5-7B on the RunPod worker) — they need a real GPU run on your PC.
- Batch generation is deliberately **not** implemented yet (spec §71/§84 step 37: only after real
  single-episode production is proven).
