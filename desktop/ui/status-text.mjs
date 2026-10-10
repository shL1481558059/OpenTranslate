export function presentTranslateError(error) {
  const message = String(error || '').trim() || '未知错误';
  if (message.startsWith('翻译失败') || message.startsWith('当前翻译服务不支持')) {
    return message;
  }
  return `翻译失败：${message}`;
}
