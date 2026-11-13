/**
 * Копирование в буфер с фолбэком (отсмотр 2026-08-21: «хендл должен
 * копироваться одним нажатием»). `navigator.clipboard` есть только в
 * secure context и не во всех WebView — иначе временный input + execCommand.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // падаем в фолбэк
  }
  try {
    const el = document.createElement('textarea');
    el.value = text;
    el.setAttribute('readonly', '');
    el.style.position = 'fixed';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}
