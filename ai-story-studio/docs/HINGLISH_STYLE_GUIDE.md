# Hinglish style guide (INDIA_HINGLISH)

This is what the story model is told when it localizes an episode, and what the app checks
afterwards (`src/services/hinglish.ts`). Edit a character's Hinglish style on the series screen
(SERIES → Characters).

## The voice of the show

- **Natural spoken Hinglish**, the way Indian kids (6–12) and their families talk: Hindi grammar,
  English words where people really use them.
- **Roman script only** in the text (titles, captions, descriptions). No Devanagari on screen.
- Simple, modern, energetic. **Not** formal / "shuddh" Hindi, not slang-heavy, not word-for-word
  translation.
- Keep every **name** exactly as written. Keep every **number** and fact.
- Keep each line about as short as the English: it must fit the same shot (see Timing fit in
  [LOCALIZATION.md](LOCALIZATION.md)).

Good: _"The portal is losing power. We have thirty seconds!"_ →
**"Portal ki power down ho rahi hai. Sirf thirty seconds hain!"**

Bad (formal): _"Pravesh dwar ki urja samapt ho rahi hai."_

## Sci-fi and tech words stay English

AI, robot, portal, spaceship, scanner, gravity, energy, mission, system, coordinates, engine,
galaxy, activate, power, signal, computer, laser, planet, oxygen, battery, shield, rocket, station,
lab, code, data, map, radar, sensor, drone, hologram, teleport, orbit, asteroid, meteor, space,
captain, control, screen, button, alarm, emergency, backup, launch, target, speed, plan, team,
future, time, machine.

## Formal words the check flags (and what to say instead)

| Formal     | Say instead          | Formal    | Say instead    |
| ---------- | -------------------- | --------- | -------------- |
| urja       | energy / power       | kintu     | lekin          |
| pravesh    | andar jaana / entry  | parantu   | lekin / par    |
| dwar       | darwaza / portal     | tathapi   | phir bhi       |
| samapt     | khatam               | arthat    | matlab         |
| kripya     | please               | yadi      | agar           |
| dhanyavaad | thank you / shukriya | athva     | ya             |
| yantra     | machine              | evam      | aur            |
| sanganak   | computer             | uprant    | baad mein      |
| antariksh  | space                | dwara     | se             |
| grah       | planet               | hetu      | ke liye        |
| vimaan     | plane / spaceship    | prayas    | try / koshish  |
| aadesh     | order / command      | niyantran | control        |
| prarambh   | shuru                | vigyan    | science        |
| pratiksha  | wait / intezaar      | shighra   | jaldi          |
| sahayata   | madad / help         | sthan     | jagah          |
| atyant     | bahut                | samay     | time           |
| avashya    | zaroor               | prithvi   | Earth / dharti |

## Each character keeps their own mix

Per character (series screen):

- **English words in Hinglish lines**: few (25 %), balanced (40 %, default), many (55 %), mostly
  English (70 %). A tech-loving robot can be "mostly English"; a grandparent "few".
- **Tone**: casual, neutral or polite.
- **Notes** for the writer (e.g. "says _arre yaar_ when surprised").
- **Pronunciation** of the name in Devanagari (e.g. Aira → आइरा) so the Hindi voice says it right.

## What the automatic check reports

| Code             | Meaning                                                   |
| ---------------- | --------------------------------------------------------- |
| `devanagari`     | the caption text contains Devanagari (it must be Roman)   |
| `formal_hindi`   | a formal word from the table above                        |
| `mostly_english` | hardly any Hindi — not Hinglish                           |
| `too_much_hindi` | much more Hindi than this character's mix                 |
| `name_missing`   | a character name was changed or dropped                   |
| `number_changed` | a number from the English line is missing                 |
| `too_long`       | much longer than the English line (will not fit the shot) |
| `empty`          | no line came back                                         |

Errors are asked for again (up to 3 rounds); what remains is shown on the episode review screen
and in the quality check. The check helps; it does not replace listening to the episode.
