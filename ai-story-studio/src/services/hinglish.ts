/**
 * INDIA_HINGLISH localization profile: rules, glossary, quality checks and speech text.
 *
 * Captions and scripts are Roman Hinglish ("Portal ki power down ho rahi hai. Sirf thirty seconds
 * hain!"). For SPEECH the Hindi words are converted to Devanagari while English words stay in Latin
 * letters ("पोर्टल"? no — "Portal की power down हो रही है"), because the TTS reads Devanagari with
 * its Hindi phonemizer and Latin with its English one; Roman Hindi read as English sounds wrong.
 * See docs/HINGLISH_STYLE_GUIDE.md.
 */

export const HINGLISH_PROFILE = 'INDIA_HINGLISH';

/** Sci-fi / technical words that stay in English in Hinglish. */
export const KEEP_ENGLISH = [
  'AI',
  'robot',
  'portal',
  'spaceship',
  'scanner',
  'gravity',
  'energy',
  'mission',
  'system',
  'coordinates',
  'engine',
  'galaxy',
  'activate',
  'power',
  'signal',
  'computer',
  'laser',
  'planet',
  'oxygen',
  'battery',
  'shield',
  'rocket',
  'station',
  'lab',
  'code',
  'data',
  'map',
  'radar',
  'sensor',
  'drone',
  'hologram',
  'teleport',
  'orbit',
  'asteroid',
  'meteor',
  'space',
  'captain',
  'control',
  'screen',
  'button',
  'alarm',
  'emergency',
  'backup',
  'launch',
  'target',
  'speed',
  'plan',
  'team',
  'future',
  'time',
  'machine',
];

/**
 * Sanskritised / formal Hindi (Roman) that sounds stiff in children's Hinglish, with a natural option.
 * Used to flag lines, never to rewrite silently.
 */
export const FORMAL_HINDI: Record<string, string> = {
  urja: 'energy / power',
  pravesh: 'andar jaana / entry',
  dwar: 'darwaza / portal',
  samapt: 'khatam',
  kripya: 'please',
  dhanyavaad: 'thank you / shukriya',
  yantra: 'machine',
  sanganak: 'computer',
  antariksh: 'space',
  grah: 'planet',
  vimaan: 'plane / spaceship',
  aadesh: 'order / command',
  prarambh: 'shuru',
  pratiksha: 'wait / intezaar',
  sahayata: 'madad / help',
  atyant: 'bahut',
  avashya: 'zaroor',
  kintu: 'lekin',
  parantu: 'lekin / par',
  tathapi: 'phir bhi',
  arthat: 'matlab',
  yadi: 'agar',
  athva: 'ya',
  evam: 'aur',
  uprant: 'baad mein',
  dwara: 'se',
  hetu: 'ke liye',
  prayas: 'try / koshish',
  niyantran: 'control',
  vigyan: 'science',
  shighra: 'jaldi',
  sthan: 'jagah',
  samay: 'time',
  prithvi: 'Earth / dharti',
};

/** Frequent Hindi words in Roman → Devanagari (speech text). Unknown words stay Latin (English phonemizer). */
export const HINDI_WORDS: Record<string, string> = {
  naam: 'नाम',
  doosri: 'दूसरी',
  doosra: 'दूसरा',
  doosre: 'दूसरे',
  dusri: 'दूसरी',
  chaloge: 'चलोगे',
  chalenge: 'चलेंगे',
  magar: 'मगर',
  hai: 'है',
  hain: 'हैं',
  ho: 'हो',
  hoga: 'होगा',
  hogi: 'होगी',
  honge: 'होंगे',
  hona: 'होना',
  hua: 'हुआ',
  hui: 'हुई',
  hue: 'हुए',
  tha: 'था',
  thi: 'थी',
  the: 'थे',
  ka: 'का',
  ki: 'की',
  ke: 'के',
  ko: 'को',
  se: 'से',
  me: 'में',
  mein: 'में',
  par: 'पर',
  pe: 'पे',
  tak: 'तक',
  nahi: 'नहीं',
  nahin: 'नहीं',
  na: 'ना',
  mat: 'मत',
  kya: 'क्या',
  kyun: 'क्यों',
  kyon: 'क्यों',
  kaise: 'कैसे',
  kahan: 'कहाँ',
  kab: 'कब',
  kaun: 'कौन',
  kitna: 'कितना',
  kitne: 'कितने',
  kitni: 'कितनी',
  yeh: 'यह',
  ye: 'ये',
  woh: 'वो',
  wo: 'वो',
  voh: 'वो',
  vo: 'वो',
  hum: 'हम',
  humein: 'हमें',
  hamara: 'हमारा',
  hamari: 'हमारी',
  hamare: 'हमारे',
  tum: 'तुम',
  tumhe: 'तुम्हें',
  tumhein: 'तुम्हें',
  tumhara: 'तुम्हारा',
  tumhari: 'तुम्हारी',
  tumhare: 'तुम्हारे',
  aap: 'आप',
  main: 'मैं',
  mai: 'मैं',
  mujhe: 'मुझे',
  mera: 'मेरा',
  meri: 'मेरी',
  mere: 'मेरे',
  tera: 'तेरा',
  teri: 'तेरी',
  apna: 'अपना',
  apni: 'अपनी',
  apne: 'अपने',
  uska: 'उसका',
  uski: 'उसकी',
  uske: 'उसके',
  usko: 'उसको',
  use: 'उसे',
  unka: 'उनका',
  unki: 'उनकी',
  unke: 'उनके',
  isko: 'इसको',
  ise: 'इसे',
  iska: 'इसका',
  iski: 'इसकी',
  iske: 'इसके',
  is: 'इस',
  us: 'उस',
  in: 'इन',
  un: 'उन',
  kar: 'कर',
  karo: 'करो',
  karna: 'करना',
  karta: 'करता',
  karti: 'करती',
  karte: 'करते',
  karenge: 'करेंगे',
  kiya: 'किया',
  raha: 'रहा',
  rahi: 'रही',
  rahe: 'रहे',
  rahna: 'रहना',
  gaya: 'गया',
  gayi: 'गई',
  gaye: 'गए',
  jao: 'जाओ',
  jaa: 'जा',
  ja: 'जा',
  jaana: 'जाना',
  jana: 'जाना',
  jaate: 'जाते',
  chalo: 'चलो',
  chal: 'चल',
  dekho: 'देखो',
  dekh: 'देख',
  dekha: 'देखा',
  suno: 'सुनो',
  sun: 'सुन',
  bolo: 'बोलो',
  bol: 'बोल',
  bola: 'बोला',
  batao: 'बताओ',
  aao: 'आओ',
  aa: 'आ',
  aaya: 'आया',
  aayi: 'आई',
  aaye: 'आए',
  abhi: 'अभी',
  jaldi: 'जल्दी',
  bahut: 'बहुत',
  sab: 'सब',
  sabko: 'सबको',
  kuch: 'कुछ',
  koi: 'कोई',
  bhi: 'भी',
  aur: 'और',
  lekin: 'लेकिन',
  toh: 'तो',
  to: 'तो',
  haan: 'हाँ',
  han: 'हाँ',
  accha: 'अच्छा',
  acha: 'अच्छा',
  achha: 'अच्छा',
  theek: 'ठीक',
  thik: 'ठीक',
  sirf: 'सिर्फ़',
  bas: 'बस',
  waise: 'वैसे',
  wahan: 'वहाँ',
  yahan: 'यहाँ',
  idhar: 'इधर',
  udhar: 'उधर',
  andar: 'अंदर',
  bahar: 'बाहर',
  upar: 'ऊपर',
  neeche: 'नीचे',
  niche: 'नीचे',
  peeche: 'पीछे',
  aage: 'आगे',
  saath: 'साथ',
  liye: 'लिए',
  wala: 'वाला',
  wali: 'वाली',
  wale: 'वाले',
  dost: 'दोस्त',
  doston: 'दोस्तों',
  yaar: 'यार',
  madad: 'मदद',
  sach: 'सच',
  sachmuch: 'सचमुच',
  pata: 'पता',
  chahiye: 'चाहिए',
  sakta: 'सकता',
  sakti: 'सकती',
  sakte: 'सकते',
  lagta: 'लगता',
  lagti: 'लगती',
  lag: 'लग',
  hoon: 'हूँ',
  hu: 'हूँ',
  hun: 'हूँ',
  rukho: 'रुको',
  ruko: 'रुको',
  dhyan: 'ध्यान',
  dar: 'डर',
  darr: 'डर',
  phir: 'फिर',
  fir: 'फिर',
  pehle: 'पहले',
  baad: 'बाद',
  ab: 'अब',
  kal: 'कल',
  aaj: 'आज',
  din: 'दिन',
  raat: 'रात',
  ghar: 'घर',
  paani: 'पानी',
  zaroor: 'ज़रूर',
  shukriya: 'शुक्रिया',
  khatam: 'ख़त्म',
  shuru: 'शुरू',
  koshish: 'कोशिश',
  jagah: 'जगह',
  matlab: 'मतलब',
  agar: 'अगर',
  ya: 'या',
  kyunki: 'क्योंकि',
  isliye: 'इसलिए',
  samjha: 'समझा',
  samjhe: 'समझे',
  samjho: 'समझो',
  socho: 'सोचो',
  chalte: 'चलते',
  milke: 'मिलके',
  milkar: 'मिलकर',
  ek: 'एक',
  do: 'दो',
  teen: 'तीन',
  char: 'चार',
  paanch: 'पाँच',
  dus: 'दस',
  bada: 'बड़ा',
  badi: 'बड़ी',
  bade: 'बड़े',
  chhota: 'छोटा',
  chhoti: 'छोटी',
  naya: 'नया',
  nayi: 'नई',
  purana: 'पुराना',
  sahi: 'सही',
  galat: 'ग़लत',
  zyada: 'ज़्यादा',
  kam: 'कम',
  jaise: 'जैसे',
  waisa: 'वैसा',
  aisa: 'ऐसा',
  aise: 'ऐसे',
  kaisa: 'कैसा',
  kisi: 'किसी',
  kis: 'किस',
  jo: 'जो',
  jab: 'जब',
  tab: 'तब',
  hi: 'ही',
  dono: 'दोनों',
  sabse: 'सबसे',
  wapas: 'वापस',
  khud: 'ख़ुद',
  mil: 'मिल',
  mila: 'मिला',
  mili: 'मिली',
  gira: 'गिरा',
  uth: 'उठ',
  utho: 'उठो',
  bachao: 'बचाओ',
  bacha: 'बचा',
  bachna: 'बचना',
  ruk: 'रुक',
  chalna: 'चलना',
  bhai: 'भाई',
  didi: 'दीदी',
  maa: 'माँ',
  papa: 'पापा',
  arre: 'अरे',
  arey: 'अरे',
  wah: 'वाह',
  oho: 'ओहो',
};
// Words that are also common English words: only treated as Hindi when the line is clearly Hindi.
const AMBIGUOUS = new Set([
  'is',
  'us',
  'in',
  'un',
  'the',
  'to',
  'do',
  'me',
  'main',
  'use',
  'par',
  'pe',
  'char',
  'hi',
  'ho',
  'bas',
  'bhai',
  'jo',
  'na',
  'ya',
  'ek',
  'kal',
  'din',
  'mat',
  'tab',
  'jab',
  'ab',
  'han',
  'mil',
  'lag',
  'sun',
  'bol',
  'dar',
  'fir',
  'ki',
  'ke',
  'ka',
  'se',
  'hu',
  'hun',
  'kam',
  'aa',
  'ja',
  'mai',
]);

const DEVANAGARI = /[ऀ-ॿ]/;

export function words(text: string): string[] {
  return text.toLowerCase().match(/[a-z']+/g) ?? [];
}

/** Share of words (0..1) that are Hindi, by the lexicon. */
export function hindiShare(text: string): number {
  const w = words(text);
  if (!w.length) return 0;
  const strong = w.filter((x) => HINDI_WORDS[x] && !AMBIGUOUS.has(x)).length;
  const weak = w.filter((x) => HINDI_WORDS[x] && AMBIGUOUS.has(x)).length;
  // Ambiguous words only count when the line is visibly Hindi.
  return (strong + (strong > 0 ? weak : 0)) / w.length;
}

export interface LineIssue {
  severity: 'error' | 'warn';
  code:
    | 'devanagari'
    | 'formal_hindi'
    | 'mostly_english'
    | 'too_much_hindi'
    | 'name_missing'
    | 'number_changed'
    | 'too_long'
    | 'empty';
  message: string;
}

const NUMBER_WORDS =
  /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|hundred|thousand|\d+)\b/gi;

/**
 * Quality checks for one localized line (spec: formal Hindi, literal translation, unnatural mix,
 * names, changed facts, length). `names` are character/place names that must survive unchanged.
 */
export function checkLine(
  english: string,
  hinglish: string,
  names: string[],
  englishShare = 0.4,
): LineIssue[] {
  const issues: LineIssue[] = [];
  const h = hinglish.trim();
  if (!h) return [{ severity: 'error', code: 'empty', message: 'The Hinglish line is empty.' }];
  if (DEVANAGARI.test(h))
    issues.push({
      severity: 'error',
      code: 'devanagari',
      message: 'Captions/script must be Roman Hinglish (no Devanagari).',
    });
  const formal = words(h).filter((w) => FORMAL_HINDI[w]);
  if (formal.length)
    issues.push({
      severity: 'warn',
      code: 'formal_hindi',
      message: `Formal Hindi: ${[...new Set(formal)].map((w) => `"${w}" → ${FORMAL_HINDI[w]}`).join(', ')}.`,
    });
  const share = hindiShare(h);
  const wordCount = words(h).length;
  if (wordCount >= 4 && share < 0.12)
    issues.push({
      severity: 'warn',
      code: 'mostly_english',
      message: 'This line is almost all English; add natural Hindi.',
    });
  const expectedHindi = 1 - englishShare;
  if (wordCount >= 5 && share > Math.min(0.95, expectedHindi + 0.35))
    issues.push({
      severity: 'warn',
      code: 'too_much_hindi',
      message: 'Very little English for this character; keep the tech words in English.',
    });
  for (const n of names)
    if (
      new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(english) &&
      !new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(h)
    )
      issues.push({ severity: 'error', code: 'name_missing', message: `"${n}" must stay in the line.` });
  const nums = (s: string) =>
    (s.match(NUMBER_WORDS) ?? [])
      .map((x) => x.toLowerCase())
      .sort()
      .join(',');
  if (nums(english) !== nums(h))
    issues.push({
      severity: 'warn',
      code: 'number_changed',
      message: 'A number differs from the English line (keep facts identical).',
    });
  if (h.length > english.length * 1.6 + 12)
    issues.push({
      severity: 'warn',
      code: 'too_long',
      message: 'Much longer than the English line; it may not fit the same shot.',
    });
  return issues;
}

/**
 * Speech text for the TTS: Hindi words in Devanagari, English words and names unchanged in Latin
 * letters (so each is read by the right phonemizer). `pronunciation` maps names/terms to a
 * spoken form (e.g. {"Aira": "आइरा"}).
 */
export function speechText(hinglish: string, pronunciation: Record<string, string> = {}): string {
  const hindiLine = hindiShare(hinglish) >= 0.15;
  const lowerPron = new Map(Object.entries(pronunciation).map(([k, v]) => [k.toLowerCase(), v]));
  return hinglish.replace(/[A-Za-z']+/g, (w) => {
    const lw = w.toLowerCase();
    if (lowerPron.has(lw)) return lowerPron.get(lw)!;
    const dev = HINDI_WORDS[lw];
    if (!dev) return w;
    if (AMBIGUOUS.has(lw) && !hindiLine) return w;
    return dev;
  });
}

/** Accept a model-provided speech text only if it keeps the English words and has Devanagari for Hindi. */
export function validSpeechText(hinglish: string, speech: string | undefined): boolean {
  if (!speech?.trim()) return false;
  if (hindiShare(hinglish) >= 0.15 && !DEVANAGARI.test(speech)) return false;
  const latin = (s: string) => (s.match(/[A-Za-z]{3,}/g) ?? []).map((x) => x.toLowerCase());
  const english = latin(hinglish).filter((w) => !HINDI_WORDS[w]);
  const kept = new Set(latin(speech));
  return english.every((w) => kept.has(w));
}

export const STYLE_GUIDE = `Localization profile INDIA_HINGLISH (for Indian children 6-12):
- Natural spoken Hinglish, the way Indian kids and families talk: Hindi grammar, English words where people really use them.
- Roman script only (no Devanagari). Simple, modern, energetic. Not formal/shuddh Hindi, not slang-heavy, not word-for-word.
- Keep sci-fi and tech words in English: ${KEEP_ENGLISH.slice(0, 30).join(', ')}.
- Keep every name exactly as written. Keep every number and fact. Keep each line about as short as the English (it must fit the same shot).
- Each character keeps their own voice: follow their "english_share" (how much English they mix in) and notes.
Example: "The portal is losing power. We have thirty seconds!" → "Portal ki power down ho rahi hai. Sirf thirty seconds hain!"
Bad (formal): "Pravesh dwar ki urja samapt ho rahi hai."`;

export const LOCALIZE_MARKER = 'LOCALIZE REQUEST (JSON):';

export interface LocalizeLine {
  id: string;
  speaker: string;
  english: string;
  /** Seconds the line may take (the English line's slot). */
  maxSeconds: number;
  englishShare: number;
  notes: string;
}

export function localizePrompt(lines: LocalizeLine[], names: string[], shorter = false): string {
  return `${STYLE_GUIDE}
${shorter ? 'These lines were TOO LONG to fit their shots: rewrite each one shorter (fewer words), same meaning.\n' : ''}Localize every line below into Hinglish. For each line also give "speech": the same Hinglish with the Hindi words written in Devanagari and the English words (and names) left in Latin letters, for the voice actor.
Names that must stay unchanged: ${names.join(', ') || '(none)'}.
Return JSON: {"lines": [{"id": "…", "hinglish": "…", "speech": "…"}]}
${LOCALIZE_MARKER} ${JSON.stringify({ lines, shorter })}`;
}
