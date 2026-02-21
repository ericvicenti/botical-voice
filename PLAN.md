# Botical3 Voice Agent — Implementation Plan

## Overview

A real-time voice assistant built with LiveKit Agents (TypeScript/Node.js) using:
- **STT:** Deepgram Nova-3 (streaming, ~200-300ms)
- **LLM:** Anthropic Claude Haiku 4.5 (via OpenAI-compatible endpoint)
- **TTS:** Cartesia Sonic 3 (40ms TTFB, with voice cloning support)
- **VAD:** Silero (voice activity detection)
- **Turn Detection:** LiveKit Multilingual Model (Qwen2.5-0.5B, ~50ms inference)

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                        LiveKit Room                                  │
│                                                                      │
│  ┌─────────────┐     WebRTC      ┌───────────────────────────────┐  │
│  │ Browser/App  │ ◄════════════► │  Agent Worker (Node.js)       │  │
│  │ (user)       │                │                               │  │
│  └─────────────┘                │  ┌─ AgentSession ───────────┐ │  │
│                                  │  │                          │ │  │
│                                  │  │  Audio In                │ │  │
│                                  │  │    │                     │ │  │
│                                  │  │    ▼                     │ │  │
│                                  │  │  ┌──────┐  Silero VAD   │ │  │
│                                  │  │  │ VAD  │──────────────►│ │  │
│                                  │  │  └──┬───┘  (speech      │ │  │
│                                  │  │     │       detection)   │ │  │
│                                  │  │     ▼                    │ │  │
│                                  │  │  ┌──────────┐           │ │  │
│                                  │  │  │ STT Node │           │ │  │
│                                  │  │  │ Deepgram │           │ │  │
│                                  │  │  │ Nova-3   │           │ │  │
│                                  │  │  └──┬───────┘           │ │  │
│                                  │  │     │ transcript stream  │ │  │
│                                  │  │     ▼                    │ │  │
│                                  │  │  ┌──────────────┐       │ │  │
│                                  │  │  │ Turn Detector │       │ │  │
│                                  │  │  │ (Multilingual │       │ │  │
│                                  │  │  │  Model)       │       │ │  │
│                                  │  │  └──┬───────────┘       │ │  │
│                                  │  │     │ end-of-turn signal │ │  │
│                                  │  │     ▼                    │ │  │
│                                  │  │  ┌──────────┐           │ │  │
│                                  │  │  │ LLM Node │           │ │  │
│                                  │  │  │ Claude   │           │ │  │
│                                  │  │  │ Haiku4.5 │           │ │  │
│                                  │  │  └──┬───────┘           │ │  │
│                                  │  │     │ token stream       │ │  │
│                                  │  │     ▼                    │ │  │
│                                  │  │  ┌──────────┐           │ │  │
│                                  │  │  │ TTS Node │           │ │  │
│                                  │  │  │ Cartesia │           │ │  │
│                                  │  │  │ Sonic 3  │           │ │  │
│                                  │  │  └──┬───────┘           │ │  │
│                                  │  │     │ audio stream       │ │  │
│                                  │  │     ▼                    │ │  │
│                                  │  │  Audio Out               │ │  │
│                                  │  └──────────────────────────┘ │  │
│                                  └───────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

---

## How Claude (Anthropic) Works in TypeScript

**The problem:** There is no `@livekit/agents-plugin-anthropic` for Node.js — it only exists for Python.

**The solution:** Anthropic provides an official OpenAI-compatible API endpoint at `https://api.anthropic.com/v1/`. The `@livekit/agents-plugin-openai` LLM class accepts `baseURL` and `apiKey` parameters, so we can point it directly at Anthropic's endpoint.

```typescript
import * as openai from '@livekit/agents-plugin-openai';

const llm = new openai.LLM({
  baseURL: 'https://api.anthropic.com/v1/',
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: 'claude-haiku-4-5',
  temperature: 0.8,
});
```

**What's supported through this compatibility layer:**
- Streaming chat completions (fully supported)
- Tool/function calling (fully supported)
- `max_tokens`, `top_p`, `stop`, `temperature` (fully supported)
- `stream` and `stream_options` (fully supported)
- `parallel_tool_calls` (fully supported)

**What's NOT supported (but we don't need for voice):**
- Prompt caching (only available via native Anthropic API)
- Extended thinking output (thinking happens but output isn't returned)
- `response_format` / structured outputs (ignored)
- Audio input (ignored)

**Limitation note:** Anthropic says this endpoint is "primarily intended to test and compare model capabilities" and is not their recommended production path. However, it is functional and they commit to no breaking changes. For production at scale, we could later write a custom LLM adapter using the native Anthropic TypeScript SDK (`@anthropic-ai/sdk`) that extends the base `LLM` abstract class in `@livekit/agents`. The base class requires implementing:
- `label()` → string identifier
- `chat({ chatCtx, toolCtx, ... })` → `LLMStream`

---

## Streaming Overlap Strategy

The key to sub-second perceived latency is that **each pipeline stage starts consuming its input stream before the previous stage finishes producing**.

### Default Pipeline Flow

```
Time ─────────────────────────────────────────────────────────────────►

User speaking:     ████████████████████
                                      ↑ VAD detects end-of-speech

STT (Deepgram):       ░░░░░░░░░░░░░░░░░█  (streaming partial → final transcript)
                                         ↑ FINAL_TRANSCRIPT emitted

Turn Detector:                           ░█  (~50ms inference)
                                          ↑ end-of-turn confirmed

onUserTurnCompleted:                      ░  (hook fires, optional RAG/context injection)

LLM (Claude):                              ░░░░████████████████
                                              ↑ TTFT (~800ms)    ↑ last token
                                              │ tokens streaming out...

TTS (Cartesia):                               ░████████████████████
                                              ↑ starts on first LLM tokens
                                              40ms TTFB from first text

User hears audio:                              ▶▶▶▶▶▶▶▶▶▶▶▶▶▶▶▶▶▶

                                           ↑───────────────────────
                                           Perceived latency: ~900-1200ms
```

**Critical streaming overlaps:**
1. **STT streams partial transcripts** while user is still speaking
2. **LLM starts generating** as soon as final transcript + end-of-turn is confirmed
3. **TTS starts synthesizing** from the very first LLM tokens — it does NOT wait for the full LLM response
4. **Audio playback starts** from the first TTS audio frames — it does NOT wait for full TTS synthesis

### Preemptive Generation (Speculative Overlap)

With `preemptiveGeneration: true`, we can overlap STT and LLM:

```
Time ─────────────────────────────────────────────────────────────────►

User speaking:     ████████████████████
                                      ↑ VAD detects end-of-speech

STT (Deepgram):       ░░░░░░░░░░░░░░░░░█
                              ↑ PREFLIGHT_TRANSCRIPT (stable partial)

LLM (speculative):           ░░░░░████████  ← starts EARLY on preflight
                                          ↑ FINAL_TRANSCRIPT arrives
                                          If final matches preflight:
                                            response already partially generated!
                                          If final differs:
                                            cancel speculative, restart LLM

TTS (Cartesia):                   ████████████████
                                  ↑ even earlier start

User hears audio:                  ▶▶▶▶▶▶▶▶▶▶▶▶▶▶

                                ↑──────────────────
                                Perceived latency: ~500-800ms (best case)
```

**Tradeoffs of preemptive generation:**
- Pro: Can shave 200-400ms off perceived latency
- Con: May double LLM API calls if preflight doesn't match final transcript
- Con: Known issue where both speculative and final LLM calls complete (doubling token cost)
- Decision: **Enable it** (`preemptiveGeneration: true`) — the latency benefit is worth the occasional double-call cost for a voice assistant

---

## Interruption Handling Strategy

### Scenario 1: User interrupts while agent is speaking

```
Agent speaking:  ████████████████
User speaks:           ██████████
                       ↑ VAD detects speech onset
                       │
                       ├─ Wait min_interruption_duration (0.5s)
                       │
                       ↓
                  Agent speech PAUSED
                  STT transcribes user speech
                  Turn detector waits for end-of-turn
                  New LLM request with full context
                  New TTS starts
```

**Configuration:**
```typescript
const session = new voice.AgentSession({
  // ...providers...
  allowInterruptions: true,           // user can interrupt (default: true)
  minInterruptionDuration: 0.5,       // require 0.5s of speech to interrupt
  minInterruptionWords: 0,            // any detected speech counts
});
```

### Scenario 2: User pauses mid-sentence, then resumes

This is the turn detector model's primary job. Without it, a 0.55s pause triggers end-of-turn.

**With turn detector (recommended):**
```
User speaking:   ████████░░░░░░░░░░████████████
                         ↑ pause    ↑ resumes
                         │          │
            Turn detector analyzes: "I need to think about..."
            Low end-of-turn confidence → extends silence timeout
            Silence timeout expanded toward max_endpointing_delay (3.0s)
            User resumes before timeout → pause is ignored
```

**Configuration:**
```typescript
import * as livekit from '@livekit/agents-plugin-livekit';

const session = new voice.AgentSession({
  turnDetection: new livekit.turnDetector.MultilingualModel(),
  minEndpointingDelay: 0.5,   // minimum wait (high confidence turn is complete)
  maxEndpointingDelay: 3.0,   // maximum wait (low confidence)
});
```

### Scenario 3: False interruption ("mhmm", cough, background noise)

```
Agent speaking:  ████████████████████████████████
User: "mhmm"          ██
                       ↑ VAD detects speech
                       │
                       ├─ Agent speech PAUSED
                       │
                       ├─ Wait false_interruption_timeout (2.0s)
                       │  No STT words recognized...
                       │
                       ↓
                  AgentFalseInterruptionEvent fires
                  resume_false_interruption=true → Agent RESUMES from pause point
```

**Configuration:**
```typescript
const session = new voice.AgentSession({
  falseInterruptionTimeout: 2.0,     // wait 2s before declaring false alarm
  resumeFalseInterruption: true,     // auto-resume after false interruption
});
```

### Scenario 4: Agent starts speaking while user is still talking (race condition)

Known issue with aggressive STT endpointing. The agent can transition thinking→speaking before VAD confirms user stopped.

**Mitigation:** Use the turn detector model (not just VAD) and avoid ultra-aggressive STT endpointing settings. The turn detector provides a semantic check that prevents premature end-of-turn signals.

### Scenario 5: LLM takes too long

```
User finishes:        ████
                          ↑ end-of-turn
Agent state:              thinking................
                          │ (agent stays in "thinking")
                          │
User interrupts:                    ████
                                    ↑ user can interrupt during "thinking"
                                    → cancels pending LLM request
                                    → new turn begins
```

No built-in timeout — the user can always interrupt. The agent stays in "thinking" state (observable via `agent_state_changed` event) until the LLM responds or the user interrupts.

---

## File Structure

```
Botical3/
├── src/
│   ├── main.ts          # Entry point: defineAgent + cli.runApp
│   └── agent.ts         # Custom Agent class with hooks and tools
├── .env                 # API keys (not committed)
├── .env.example         # Template for API keys
├── .gitignore
├── package.json
├── tsconfig.json
└── PLAN.md              # This document
```

### src/main.ts — Agent entry point

This file:
1. Loads environment variables
2. Defines the agent with `defineAgent()` (prewarm + entry)
3. In `prewarm`: loads Silero VAD model (once per worker, shared across sessions)
4. In `entry`:
   - Creates an `AgentSession` wiring together STT, LLM, TTS, VAD, turn detection
   - Configures the OpenAI plugin's LLM to point at Anthropic's endpoint
   - Configures Cartesia TTS with a voice ID (can be a cloned voice)
   - Configures Deepgram STT with Nova-3 streaming
   - Starts the session with the custom Agent class
   - Connects to the room
   - Generates an initial greeting
5. Runs the CLI app with `cli.runApp()`

### src/agent.ts — Custom Agent class

This file:
1. Extends `voice.Agent` with custom instructions
2. Defines LLM tools (e.g., weather lookup, as a starting example)
3. Implements lifecycle hooks:
   - `onEnter()` — runs when agent becomes active; generates initial greeting
   - `onUserTurnCompleted(turnCtx, newMessage)` — hook point for RAG or context injection before LLM inference
4. Could override pipeline nodes (`sttNode`, `llmNode`, `ttsNode`) for custom pre/post-processing

---

## Implementation Steps

### Step 1: Configure tsconfig.json and package.json scripts
- Match the official LiveKit starter template's tsconfig
- Add `dev`, `build`, `start`, `download-files` scripts
- Use Vite for production builds, tsx for development

### Step 2: Implement src/main.ts
- Wire up the agent entry point following the official starter template pattern
- Key difference: use `openai.LLM` with Anthropic's `baseURL` instead of `inference.LLM`
- Use `@livekit/agents-plugin-cartesia` for TTS (with voice cloning voice ID)
- Use `@livekit/agents-plugin-deepgram` for STT (Nova-3, streaming)
- Configure turn detection with `livekit.turnDetector.MultilingualModel()`
- Enable preemptive generation for maximum streaming overlap
- Set up metrics collection

### Step 3: Implement src/agent.ts
- Create Agent class extending `voice.Agent`
- Set voice-optimized instructions (concise, no formatting, no emojis)
- Add example tools (weather, or domain-specific)
- Implement `onEnter` for greeting
- Implement `onUserTurnCompleted` as a hook point for future RAG integration

### Step 4: Add build tooling
- Add Vite config for production builds (SSR mode targeting Node.js)
- Configure `download-files` script to pre-download Silero VAD model

### Step 5: Test locally
- Run in dev mode with `pnpm dev`
- Use LiveKit's Agents Playground (agents-playground.livekit.io) as the frontend
- Verify streaming overlap, interruption handling, and voice quality

---

## Dependencies (already installed)

| Package | Version | Purpose |
|---|---|---|
| `@livekit/agents` | 1.0.47 | Core agents framework |
| `@livekit/agents-plugin-openai` | 1.0.47 | LLM plugin (pointed at Anthropic endpoint) |
| `@livekit/agents-plugin-deepgram` | 1.0.47 | STT (Nova-3 streaming) |
| `@livekit/agents-plugin-cartesia` | 1.0.47 | TTS (Sonic 3, voice cloning) |
| `@livekit/agents-plugin-silero` | 1.0.47 | VAD (voice activity detection) |
| `typescript` | 5.9.3 | TypeScript compiler |
| `tsx` | 4.21.0 | TypeScript execution for development |
| `zod` | 4.3.6 | Schema validation for LLM tools |

**Still needed (will add in Step 4):**
| Package | Purpose |
|---|---|
| `@livekit/agents-plugin-livekit` | Turn detector model (MultilingualModel) |
| `vite` | Production build tool |
| `dotenv` | Environment variable loading |

---

## Environment Variables Required

```
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=your-api-key
LIVEKIT_API_SECRET=your-api-secret
ANTHROPIC_API_KEY=your-anthropic-api-key
DEEPGRAM_API_KEY=your-deepgram-api-key
CARTESIA_API_KEY=your-cartesia-api-key
```

---

## Voice Cloning Setup (Cartesia)

To use a cloned voice:
1. Go to the Cartesia dashboard and create a voice clone (3 seconds of audio minimum)
2. Copy the voice ID
3. Pass it to the Cartesia TTS constructor:

```typescript
const tts = new cartesia.TTS({
  apiKey: process.env.CARTESIA_API_KEY,
  model: 'sonic-3',
  voiceId: 'your-cloned-voice-id',
});
```

For initial development/testing, Cartesia provides built-in voices that don't require cloning.

---

## Known Issues & Mitigations

1. **Preemptive generation double-billing** ([GitHub #4219](https://github.com/livekit/agents/issues/4219)): Both speculative and final LLM calls may complete. Mitigation: Accept the cost tradeoff for latency; Haiku 4.5 is cheap.

2. **Anthropic OpenAI-compat is "not production-ready"**: Anthropic's own disclaimer. Mitigation: It's fully functional and they promise no breaking changes. If issues arise, we can write a custom LLM adapter using the native Anthropic SDK.

3. **No prompt caching via OpenAI compat**: System prompts can't be cached. Mitigation: Keep system prompts short; Haiku 4.5 is fast enough. Native adapter would fix this.

4. **Agent speaking during user speech** ([GitHub #4047](https://github.com/livekit/agents/issues/4047)): Race condition with aggressive STT endpointing. Mitigation: Use turn detector model (not just VAD), don't use ultra-aggressive endpointing settings.

5. **False interruption resume** ([GitHub #4039](https://github.com/livekit/agents/issues/4039)): Was broken in v1.3.3, fixed in v1.3.4+. Mitigation: We're on v1.0.47 of the Node.js SDK; verify behavior in testing.
