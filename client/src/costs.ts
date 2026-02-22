interface CostBreakdown {
  stt: number;
  llm: number;
  tts: number;
  total: number;
}

interface CostUpdate {
  type: 'cost_update';
  service: 'stt' | 'llm' | 'tts';
  cost: number;
  session: CostBreakdown;
}

let costEl: HTMLElement;
let totalEl: HTMLElement;
let breakdownEl: HTMLElement;
let sttEl: HTMLElement;
let llmEl: HTMLElement;
let ttsEl: HTMLElement;
let expanded = false;

export function initCosts(el: HTMLElement): void {
  costEl = el;
  totalEl = el.querySelector('.cost-total')!;
  breakdownEl = el.querySelector('.cost-breakdown')!;
  sttEl = el.querySelector('.cost-stt')!;
  llmEl = el.querySelector('.cost-llm')!;
  ttsEl = el.querySelector('.cost-tts')!;

  el.addEventListener('click', () => {
    expanded = !expanded;
    breakdownEl.classList.toggle('open', expanded);
  });
}

export function handleCostUpdate(data: unknown): void {
  const update = data as CostUpdate;
  if (update.type !== 'cost_update') return;

  costEl.classList.add('visible');
  totalEl.textContent = formatCost(update.session.total);
  sttEl.textContent = formatCost(update.session.stt);
  llmEl.textContent = formatCost(update.session.llm);
  ttsEl.textContent = formatCost(update.session.tts);
}

export function resetCosts(): void {
  costEl.classList.remove('visible');
  totalEl.textContent = '$0.0000';
  sttEl.textContent = '$0.0000';
  llmEl.textContent = '$0.0000';
  ttsEl.textContent = '$0.0000';
  expanded = false;
  breakdownEl.classList.remove('open');
}

function formatCost(dollars: number): string {
  if (dollars < 0.01) return `$${dollars.toFixed(4)}`;
  if (dollars < 1) return `$${dollars.toFixed(3)}`;
  return `$${dollars.toFixed(2)}`;
}
