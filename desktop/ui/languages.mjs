export const LANGUAGES = [
  { value: 'auto', label: '自动' },
  { value: 'zh-CN', label: '中文简体' },
  { value: 'zh-TW', label: '中文繁体' },
  { value: 'en', label: '英文' },
  { value: 'ja', label: '日文' },
  { value: 'ko', label: '韩文' },
  { value: 'fr', label: '法文' },
  { value: 'de', label: '德文' },
  { value: 'es', label: '西班牙文' },
  { value: 'pt', label: '葡萄牙文' },
  { value: 'it', label: '意大利文' },
  { value: 'ru', label: '俄文' },
  { value: 'ar', label: '阿拉伯文' },
  { value: 'th', label: '泰文' },
  { value: 'vi', label: '越南文' },
  { value: 'id', label: '印尼文' }
];

export function languageOptions(options = {}) {
  const includeAuto = options.includeAuto !== false;
  return LANGUAGES.filter((item) => includeAuto || item.value !== 'auto');
}

export function shouldRetranslate(text, previous, next) {
  return String(text || '').trim().length > 0 && previous !== next;
}
