let debugLogEl: HTMLElement | null = null;

export function initDebug(logEl: HTMLElement, toggleBtn: HTMLElement, panel: HTMLElement, closeBtn: HTMLElement): void {
  debugLogEl = logEl;
  toggleBtn.addEventListener('click', () => panel.classList.add('open'));
  closeBtn.addEventListener('click', () => panel.classList.remove('open'));
}

export function debug(text: string, level: 'debug' | 'error' | 'info' = 'debug'): void {
  if (!debugLogEl) return;
  const time = new Date().toLocaleTimeString('en-US', { hour12: false, fractionalSecondDigits: 3 });
  const div = document.createElement('div');
  div.className = `debug-entry ${level === 'error' ? 'error' : level === 'info' ? 'info' : ''}`;
  div.textContent = `[${time}] ${text}`;
  debugLogEl.appendChild(div);
  debugLogEl.scrollTop = debugLogEl.scrollHeight;
  console.log(`[client] ${text}`);
}
