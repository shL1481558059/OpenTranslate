const LATIN_LANGUAGE_RULES = [
  {
    lang: 'fr',
    characters: /[àâæçéèêëîïôœùûüÿ]/i,
    words: /\b(?:bonjour|merci|avec|pour|vous|nous|est|une|des|les|pas|dans|sur|que|qui|mais|tout|monde)\b/gi
  },
  {
    lang: 'es',
    characters: /[áéíóúñ¿¡]/i,
    words: /\b(?:hola|gracias|para|usted|que|como|esta|está|una|unos|unas|los|las|con|por|del|mundo)\b/gi
  },
  {
    lang: 'de',
    characters: /[äöüß]/i,
    words: /\b(?:hallo|danke|und|der|die|das|ist|nicht|mit|für|eine|einer|einen|welt)\b/gi
  },
  {
    lang: 'en',
    words: /\b(?:hello|thanks|please|the|and|with|this|that|you|your|world|how|are)\b/gi
  }
];

function normalizeLang(value, fallback = '', options = {}) {
  const allowAuto = options.allowAuto === true;
  const trimmed = String(value || '').trim().toLowerCase();
  if (!trimmed) {
    return fallback;
  }
  if (allowAuto && trimmed === 'auto') {
    return 'auto';
  }
  if (trimmed.startsWith('zh')) return 'zh';
  if (trimmed.startsWith('ja')) return 'ja';
  if (trimmed.startsWith('ko')) return 'ko';
  return trimmed.split(/[-_]/)[0] || fallback;
}

function detectLanguageFromText(text) {
  const input = String(text || '').trim();
  if (!input) {
    return null;
  }

  if (/[가-힣]/u.test(input)) return 'ko';
  if (/[ぁ-ゟ゠-ヿ]/u.test(input)) return 'ja';
  if (/[\u3400-\u9fff]/u.test(input)) return 'zh';

  const lower = input.toLowerCase();
  let bestLang = null;
  let bestScore = 0;

  for (const rule of LATIN_LANGUAGE_RULES) {
    let score = 0;
    if (rule.characters && rule.characters.test(lower)) {
      score += 3;
    }
    if (rule.words) {
      const matches = lower.match(rule.words);
      score += matches ? matches.length * 2 : 0;
    }
    if (score > bestScore) {
      bestLang = rule.lang;
      bestScore = score;
    }
  }

  if (bestLang && bestScore > 0) {
    return bestLang;
  }

  if (/[a-z]/i.test(input)) {
    return 'en';
  }

  return null;
}

function detectLanguageFromItems(items) {
  const counts = new Map();

  for (const item of Array.isArray(items) ? items : []) {
    const detected = detectLanguageFromText(item?.text || '');
    if (!detected) {
      continue;
    }
    counts.set(detected, (counts.get(detected) || 0) + 1);
  }

  let bestLang = null;
  let bestCount = 0;
  for (const [lang, count] of counts.entries()) {
    if (count > bestCount) {
      bestLang = lang;
      bestCount = count;
    }
  }

  return bestLang;
}

function extractMarianPair(modelId) {
  const normalized = String(modelId || '').trim();
  if (!normalized) {
    return null;
  }
  const match = normalized.match(/opus-mt-([a-z]{2,3})-([a-z]{2,3})(?:$|[^a-z])/i);
  if (!match) {
    return null;
  }
  return {
    from: normalizeLang(match[1]),
    to: normalizeLang(match[2])
  };
}

module.exports = {
  normalizeLang,
  detectLanguageFromText,
  detectLanguageFromItems,
  extractMarianPair
};
