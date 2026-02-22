let voiceStateEl: HTMLElement;
let voiceStateLabelEl: HTMLElement;
let currentAgentState = 'initializing';
let userSpeaking = false;
let voiceEnabled = false;

export function initVoiceState(el: HTMLElement): void {
  voiceStateEl = el;
  voiceStateLabelEl = el.querySelector('.voice-state-label')!;
}

function refresh(): void {
  voiceStateEl.className = 'voice-state' + (voiceEnabled ? ' visible' : '');

  let label: string;
  let stateClass: string;
  if (currentAgentState === 'listening' && userSpeaking) {
    label = 'Listening';
    stateClass = 'listening';
  } else if (currentAgentState === 'listening') {
    label = 'Waiting';
    stateClass = '';
  } else if (currentAgentState === 'thinking') {
    label = 'Thinking';
    stateClass = 'thinking';
  } else if (currentAgentState === 'speaking') {
    label = 'Speaking';
    stateClass = 'speaking';
  } else {
    label = 'Waiting';
    stateClass = '';
  }

  voiceStateLabelEl.textContent = label;
  voiceStateEl.classList.remove('listening', 'thinking', 'speaking');
  if (stateClass) voiceStateEl.classList.add(stateClass);
}

export function updateVoiceState(agentState: string): void {
  currentAgentState = agentState;
  refresh();
}

export function setUserSpeaking(speaking: boolean): void {
  userSpeaking = speaking;
  refresh();
}

export function setVoiceEnabled(enabled: boolean): void {
  voiceEnabled = enabled;
  refresh();
}

export function resetVoiceState(): void {
  userSpeaking = false;
  currentAgentState = 'initializing';
  refresh();
}
