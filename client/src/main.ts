import { initDebug } from './debug';
import { initChat } from './chat';
import { initCosts } from './costs';
import { initVoiceState } from './voice-state';
import { initRoom, connect } from './room';

// DOM refs
const chatEl = document.getElementById('chat')!;
const statusBadge = document.getElementById('status-badge')!;
const textInput = document.getElementById('text-input') as HTMLInputElement;
const sendBtn = document.getElementById('send-btn') as HTMLButtonElement;
const voiceBtn = document.getElementById('voice-btn') as HTMLButtonElement;
const debugBtn = document.getElementById('debug-btn')!;
const debugPanel = document.getElementById('debug-panel')!;
const debugClose = document.getElementById('debug-close')!;
const debugLog = document.getElementById('debug-log')!;
const voiceStateEl = document.getElementById('voice-state')!;
const costDisplayEl = document.getElementById('cost-display')!;

// Initialize modules
initDebug(debugLog, debugBtn, debugPanel, debugClose);
initChat(chatEl);
initCosts(costDisplayEl);
initVoiceState(voiceStateEl);
initRoom({ statusBadge, textInput, sendBtn, voiceBtn });

// Auto-connect on page load
connect();
