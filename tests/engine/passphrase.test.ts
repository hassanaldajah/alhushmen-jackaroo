import { describe, expect, it } from 'vitest';
import { normalizePhrase, phraseMatches } from '../../src/worker/auth';
// @ts-ignore -- Vite raw import (no node types in this project)
import toml from '../../wrangler.toml?raw';

// Synthetic phrases only (never the real secret). Escapes keep the exact code points visible.
const SECRET = 'x'.repeat(40);
// "laptop" form: kaf, alef-hamza, ya, ta marbuta, alef maqsura, space, heh.
const BASE = 'كأية منى ها';

const variants: Record<string, string> = {
  'Persian ya U+06CC': BASE.replace(/ي/g, 'ی'),
  'alef maqsura for ya': BASE.replace(/ي/g, 'ى'),
  'ya for alef maqsura': BASE.replace(/ى/g, 'ي'),
  'yeh barree U+06D2': BASE.replace(/ي/g, 'ے'),
  'Persian kaf U+06A9': BASE.replace(/ك/g, 'ک'),
  'bare alef for hamza': BASE.replace(/أ/g, 'ا'),
  'alef + combining hamza': BASE.replace(/أ/g, 'أ'),
  'alef madda / hamza below': BASE.replace(/أ/g, 'آ'),
  'heh for ta marbuta': BASE.replace(/ة/g, 'ه'),
  'heh goal U+06C1': BASE.replace(/ه/g, 'ہ'),
  'heh doachashmee U+06BE': BASE.replace(/ه/g, 'ھ'),
  'ae U+06D5': BASE.replace(/ه/g, 'ە'),
  'presentation forms': 'ﻛﺃﻳﺔ ﻣﻨﻰ ﻫﺎ',
  'tatweel': BASE.replace(/م/g, 'مــ'),
  'harakat': BASE.replace(/م/g, 'مَ').replace(/ن/g, 'نّْ'),
  'ZWJ / ZWNJ': BASE.replace(/م/g, '‍م‌'),
  'RLM / LRM / ALM': '‏' + BASE + '‎؜',
  'bidi embedding + BOM': '﻿‫' + BASE + '‬',
  'NBSP': BASE.replace(/ /g, ' '),
  'narrow NBSP + double space': BASE.replace(/ /g, '  '),
  'leading / trailing spaces': '  ' + BASE + ' \n',
  'NFD input': BASE.normalize('NFD'),
};

describe('passphrase normalization (phone vs laptop typing)', () => {
  for (const [name, typed] of Object.entries(variants)) {
    it(`${name} normalizes like the base form`, async () => {
      expect(normalizePhrase(typed)).toBe(normalizePhrase(BASE));
      // Symmetric: it must not matter which form the secret was stored in.
      expect(await phraseMatches(typed, BASE, SECRET)).toBe(true);
      expect(await phraseMatches(BASE, typed, SECRET)).toBe(true);
    });
  }

  it('is idempotent', () => {
    for (const v of Object.values(variants)) expect(normalizePhrase(normalizePhrase(v))).toBe(normalizePhrase(v));
  });

  it('genuinely different phrases still fail', async () => {
    const wrong = [
      BASE.replace(/م/g, 'ن'), // different letter
      BASE.replace(/ /g, ''), // missing spaces
      BASE + 'ا', // extra letter
      BASE.slice(1), // missing letter
      BASE.replace(/ك/g, 'ق'), // qaf is not kaf
      '‏‍ ', // only invisible chars
      '',
    ];
    for (const w of wrong) expect(await phraseMatches(w, BASE, SECRET)).toBe(false);
  });
});

describe('deploy config', () => {
  // Regression: a stale host here made /api/auth answer 403 for every login, shown as "wrong passphrase".
  it('ALLOWED_ORIGINS is the deployed origin', () => {
    expect(/^ALLOWED_ORIGINS\s*=\s*"(.*)"/m.exec(toml as string)?.[1]).toBe('https://alhushmen.al-hassan.dev');
  });
});
