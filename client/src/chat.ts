let chatEl: HTMLElement;

export function initChat(el: HTMLElement): void {
  chatEl = el;
}

function scrollChat(): void {
  const atBottom = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 80;
  if (atBottom) chatEl.scrollTop = chatEl.scrollHeight;
}

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

export function addUserMessage(text: string): void {
  const div = document.createElement('div');
  div.className = 'msg user';
  div.textContent = text;
  chatEl.appendChild(div);
  scrollChat();
}

export function addAgentMessage(text: string): void {
  const div = document.createElement('div');
  div.className = 'msg agent';
  div.textContent = text;
  chatEl.appendChild(div);
  scrollChat();
}

export function addInterimMessage(id: string, text: string, isUser: boolean): HTMLElement {
  const existing = activeSegments.get(id);
  if (existing) {
    existing.textContent = text;
    scrollChat();
    return existing;
  }
  const div = document.createElement('div');
  div.className = `msg ${isUser ? 'user' : 'agent'} interim`;
  div.textContent = text;
  chatEl.appendChild(div);
  activeSegments.set(id, div);
  scrollChat();
  return div;
}

export function finalizeSegment(id: string, text: string, isUser: boolean): void {
  const existing = activeSegments.get(id);
  if (existing) {
    existing.textContent = text;
    existing.classList.remove('interim');
    activeSegments.delete(id);
  } else {
    if (isUser) {
      addUserMessage(text);
    } else {
      addAgentMessage(text);
    }
  }
}

const activeSegments = new Map<string, HTMLElement>();

export interface ToolCallInfo {
  name: string;
  args: string;
  output: string;
  isError: boolean;
}

export function addToolCard(tools: ToolCallInfo[]): void {
  for (const tool of tools) {
    const card = document.createElement('div');
    card.className = 'tool-card';

    let argsDisplay: string;
    try {
      const parsed = JSON.parse(tool.args);
      argsDisplay = JSON.stringify(parsed, null, 2);
    } catch {
      argsDisplay = tool.args || '(none)';
    }

    card.innerHTML = `
      <div class="tool-header">
        <span class="tool-icon">&#9881;</span>
        <span class="tool-name">${escapeHtml(tool.name)}</span>
        <span class="tool-toggle">&#9654;</span>
      </div>
      <div class="tool-details">
        <div class="tool-label">Arguments</div>
        <div class="tool-content">${escapeHtml(argsDisplay)}</div>
        <div class="tool-label">Result</div>
        <div class="tool-content ${tool.isError ? 'tool-error' : ''}">${escapeHtml(tool.output || '(empty)')}</div>
      </div>
    `;

    const header = card.querySelector('.tool-header')!;
    const details = card.querySelector('.tool-details')!;
    const toggle = card.querySelector('.tool-toggle')!;
    header.addEventListener('click', () => {
      details.classList.toggle('open');
      toggle.classList.toggle('open');
    });

    chatEl.appendChild(card);
    scrollChat();
  }
}
