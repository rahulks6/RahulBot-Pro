# Character consistency test (v1.3.1)

A daily cartoon series needs the SAME character in every shot. This test measures that on real
pictures, with the app's real mechanism — not by checking that prompts contain the same words.

## What it does

**Advanced Mode → Real Mode Test → Character consistency test → RUN CONSISTENCY TEST** (price shown
first; nothing is rented until you confirm; the GPU is always terminated).

1. One ORIGINAL test character: a 12-year-old futuristic explorer with dark wavy hair, a teal and silver
   exploration jacket, a compact wrist scanner, white futuristic shoes and a small glowing blue robot.
2. **Canonical reference:** front view, full body, neutral pose, plain background.
3. **12 shots**, each made from the reference exactly like real episode shots are:
   image-to-image from the reference at **Settings → Generation → Character reference strength**
   (default 0.8), plus the reference as an image prompt (used only by models with an image-prompt
   adapter configured — none today, see below).
   - front view · three-quarter view · side view
   - happy · worried · surprised
   - running · using the scanner
   - inside a spaceship · on an alien planet
   - warm lighting · cool lighting
4. Every picture is validated (decodes, not blank, not black).
5. A **contact sheet** (reference + 12 shots, 5 × 3) is saved and shown with labels.
6. **Your verdict:** tick what stays consistent (face, hair, eyes, clothing, colours, proportions, age,
   accessories) and choose **PASS**, **NEEDS IMPROVEMENT** or **FAIL**. The criteria you did not tick
   are stored with the verdict.

Files: `data/storage/real-tests/<test id>/reference.png`, `shot_01.png` … `shot_12.png`,
`contact_sheet.png`.

## How to judge

PASS only if a viewer would say "that is the same child" in all 12 shots: same face shape, hair style
and colour, eye colour, skin tone, jacket colours and cut, scanner, shoes, robot, and body proportions
and age. Different poses, expressions, places and light are expected; a different face or outfit is not.

## If it is not good enough

Do not redesign everything. First find out why, with the same 12 shots:

- **Strength.** In image-to-image a HIGHER strength means MORE change from the reference: at 0.8 the
  model can re-draw a lot (new views and poses work, but the likeness may drift); at 0.5–0.6 more of the
  reference survives (likeness holds, but so does its front-facing pose). Run the test at 0.6 and at 0.8
  (Settings → Generation) and compare the two contact sheets.
- **No identity conditioning yet.** The worker's image adapter can load an IP-Adapter when a catalog entry
  sets `params.ip_adapter`, but **none is configured for FLUX.1 [schnell] today**, so the reference is
  used as the image-to-image start only (the image-prompt request is sent but not used by this model).
  Options for this model family, in order of effort: a FLUX-compatible IP-Adapter or Redux adapter in
  the catalog, then a small character LoRA trained on the approved reference sheet. Add one only if it
  measurably improves the same test set.
- **Weak reference.** A multi-view reference sheet (front, three-quarter, side) usually beats a single
  front view.

## Status today (v1.3.1)

| Environment                                         | Result                                                                                                                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Development container (no GPU, RunPod blocked)      | **BLOCKED** — no real pictures can be made.                                                                                                                        |
| Automated test with a mock RunPod and a fake worker | The harness passes: 13 image requests, every shot sent with the reference as init image at 0.8 and as an image prompt, validation, the contact sheet, the verdict. |
| Your PC with your RunPod key                        | **CHARACTER CONSISTENCY: NOT TESTED** until you run it and give your verdict.                                                                                      |
