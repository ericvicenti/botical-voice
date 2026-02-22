import { Room, RoomEvent, Track } from 'livekit-client';
import { debug } from './debug';
import { addUserMessage, addAgentMessage, addToolCard, addInterimMessage, finalizeSegment } from './chat';
import { updateVoiceState, setUserSpeaking, setVoiceEnabled, resetVoiceState } from './voice-state';

let room: Room | null = null;
let voiceEnabled = false;
let audioElements: HTMLAudioElement[] = [];
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let voiceGreetingSent = false;

// Preload tool call sound
const toolSound = new Audio('/assets/SimpleClicks.wav');

interface RoomElements {
  statusBadge: HTMLElement;
  textInput: HTMLInputElement;
  sendBtn: HTMLButtonElement;
  voiceBtn: HTMLButtonElement;
}

let els: RoomElements;

export function initRoom(elements: RoomElements): void {
  els = elements;

  // Voice toggle
  els.voiceBtn.addEventListener('click', async () => {
    if (!room) return;
    voiceEnabled = !voiceEnabled;
    els.voiceBtn.classList.toggle('active', voiceEnabled);

    await room.localParticipant.setMicrophoneEnabled(voiceEnabled);
    audioElements.forEach(el => { el.muted = !voiceEnabled; });
    setVoiceEnabled(voiceEnabled);

    // Trigger agent greeting on first voice enable
    if (voiceEnabled && !voiceGreetingSent) {
      voiceGreetingSent = true;
      room.localParticipant.sendText('hi', { topic: 'lk.chat' }).catch(() => {});
    }

    debug(`Voice ${voiceEnabled ? 'enabled' : 'disabled'}`);
  });

  // Text input
  async function sendMessage(): Promise<void> {
    const text = els.textInput.value.trim();
    if (!text || !room) return;

    els.textInput.value = '';
    addUserMessage(text);

    try {
      await room.localParticipant.sendText(text, { topic: 'lk.chat' });
      debug(`Sent text: "${text}"`);
    } catch (err) {
      debug(`Send error: ${(err as Error).message}`, 'error');
    }
  }

  els.sendBtn.addEventListener('click', sendMessage);
  els.textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
}

export async function connect(): Promise<void> {
  if (room) return;

  els.statusBadge.textContent = 'Connecting...';
  els.statusBadge.className = 'status-badge';
  debug('Fetching token from /api/token...');

  try {
    const res = await fetch('/api/token');
    if (!res.ok) throw new Error(`Token API returned ${res.status}: ${await res.text()}`);
    const { token, url, identity, room: roomName } = await res.json();
    debug(`Token received: identity=${identity}, room=${roomName}`);

    room = new Room({ adaptiveStream: true, dynacast: true });

    // Connection state
    room.on(RoomEvent.ConnectionStateChanged, (state) => {
      debug(`Connection state: ${state}`, 'info');
    });

    // Track subscriptions (agent audio)
    room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
      debug(`Track subscribed: ${track.kind} from ${participant.identity}`);
      if (track.kind === Track.Kind.Audio) {
        const el = track.attach();
        el.style.display = 'none';
        el.muted = !voiceEnabled;
        document.body.appendChild(el);
        audioElements.push(el as HTMLAudioElement);
        debug(`Audio attached from ${participant.identity}`);
      }
    });

    room.on(RoomEvent.TrackUnsubscribed, (track) => {
      const detached = track.detach();
      detached.forEach(el => {
        audioElements = audioElements.filter(a => a !== el);
        el.remove();
      });
    });

    room.on(RoomEvent.LocalTrackPublished, (publication) => {
      debug(`Local track published: ${publication.kind}`);
    });

    // Participants
    room.on(RoomEvent.ParticipantConnected, (participant) => {
      debug(`Participant joined: ${participant.identity}`);
    });
    room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      debug(`Participant left: ${participant.identity}`);
    });

    // Participant attributes (agent state)
    room.on(RoomEvent.ParticipantAttributesChanged, (_changedAttrs, participant) => {
      if (participant.identity !== room?.localParticipant?.identity) {
        const agentState = participant.attributes?.['lk.agent.state'];
        if (agentState) {
          debug(`Agent state: ${agentState}`);
          updateVoiceState(agentState);
        }
      }
    });

    // Disconnect — auto-reconnect after delay
    room.on(RoomEvent.Disconnected, (reason) => {
      debug(`Disconnected: ${reason ?? 'unknown'}`, 'info');
      els.statusBadge.textContent = 'Reconnecting...';
      els.statusBadge.className = 'status-badge';
      els.textInput.disabled = true;
      els.sendBtn.disabled = true;
      els.voiceBtn.disabled = true;
      els.voiceBtn.classList.remove('active');
      voiceEnabled = false;
      setVoiceEnabled(false);
      resetVoiceState();
      room = null;
      audioElements = [];

      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, 2000);
    });

    // Data messages (tool calls from agent)
    room.on(RoomEvent.DataReceived, (data, participant, _kind, topic) => {
      debug(`Data received: topic=${topic}, from=${participant?.identity ?? 'server'}, ${data.byteLength} bytes`);
      if (topic === 'botical.events') {
        try {
          const msg = JSON.parse(new TextDecoder().decode(data));
          if (msg.type === 'tool_calls' && msg.tools) {
            toolSound.currentTime = 0;
            toolSound.play().catch(() => {});
            addToolCard(msg.tools);
          }
        } catch (err) {
          debug(`Failed to parse event data: ${(err as Error).message}`, 'error');
        }
      }
    });

    // Transcriptions
    room.on(RoomEvent.TranscriptionReceived, (segments, participant) => {
      const isUser = participant?.identity === room?.localParticipant?.identity;

      for (const seg of segments) {
        if (!seg.text?.trim()) continue;

        if (seg.final) {
          finalizeSegment(seg.id, seg.text, isUser);
          debug(`[${isUser ? 'user' : 'agent'}:final] "${seg.text}"`);
        } else {
          addInterimMessage(seg.id, seg.text, isUser);
          debug(`[${isUser ? 'user' : 'agent'}:interim] "${seg.text}"`);
        }
      }
    });

    // Reconnection (LiveKit built-in, for brief interruptions)
    room.on(RoomEvent.Reconnecting, () => {
      debug('Reconnecting...');
      els.statusBadge.textContent = 'Reconnecting...';
      els.statusBadge.className = 'status-badge';
    });
    room.on(RoomEvent.Reconnected, () => {
      debug('Reconnected');
      els.statusBadge.textContent = 'Connected';
      els.statusBadge.className = 'status-badge connected';
    });

    // Active speakers
    room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      const localId = room?.localParticipant?.identity;
      setUserSpeaking(speakers.some(s => s.identity === localId));
      if (speakers.length > 0) {
        debug(`Active speakers: ${speakers.map(s => s.identity).join(', ')}`, 'info');
      }
    });

    // Connect to room
    debug(`Connecting to ${url}...`);
    await room.connect(url, token);
    debug(`Connected to room: ${room.name}`);

    // List existing participants
    const remotes = Array.from(room.remoteParticipants.values());
    if (remotes.length > 0) {
      debug(`${remotes.length} participant(s) in room: ${remotes.map(p => p.identity).join(', ')}`);
    }

    // Update UI state
    els.statusBadge.textContent = 'Connected';
    els.statusBadge.className = 'status-badge connected';
    els.textInput.disabled = false;
    els.sendBtn.disabled = false;
    els.voiceBtn.disabled = false;
    els.textInput.focus();

  } catch (err) {
    debug(`Connection error: ${(err as Error).message}`, 'error');
    els.statusBadge.textContent = 'Reconnecting...';
    els.statusBadge.className = 'status-badge';
    room = null;
    console.error('[client] Connection error:', err);

    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 3000);
  }
}
