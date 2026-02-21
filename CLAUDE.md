# Botical3

Real-time voice assistant built with LiveKit Agents (TypeScript/Node.js).

## Quick Start

```bash
pnpm install
pnpm download-files   # downloads ~460MB turn detector ONNX models (first time only)
pnpm dev              # runs token-server + agent together
```

Open http://localhost:3000, click Connect, and speak.

## Required Environment Variables

Copy `.env.example` to `.env` and fill in:

- `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` — LiveKit Cloud project credentials (or local dev server)
- `ANTHROPIC_API_KEY` — Anthropic API key for Claude LLM
- `DEEPGRAM_API_KEY` — Deepgram API key for streaming STT
- `CARTESIA_API_KEY` — Cartesia API key for TTS

## Architecture

### Pipeline

Browser mic -> LiveKit Cloud (WebSocket) -> Agent:
1. **VAD**: Silero (voice activity detection, runs locally)
2. **STT**: Deepgram Nova-3 (streaming — only streaming STT with a LiveKit Node.js plugin)
3. **Turn Detection**: LiveKit Multilingual Model (Qwen2.5-0.5B ONNX, runs locally, dynamically adjusts endpointing delay 0.5s-3.0s)
4. **LLM**: Anthropic Claude Haiku 4.5 via OpenAI-compatible endpoint
5. **TTS**: Cartesia Sonic (streaming)

Audio flows Browser <-> LiveKit Cloud <-> Agent. The token server only handles HTTP (token generation, serving the client HTML).

### Key Files

- `src/main.ts` — Agent entry point. `defineAgent({ prewarm, entry })` loads VAD model, creates the voice session with all providers, wires up comprehensive logging for every pipeline stage.
- `src/agent.ts` — `BotAgent` class extending `voice.Agent`. Contains system instructions and tools (`get_time`, `set_reminder`). At least one tool must be defined (see Anthropic quirks below).
- `src/token-server.ts` — HTTP server on port 3000. Serves the client HTML at `/`, generates LiveKit tokens at `/api/token`, and creates explicit agent dispatches via `AgentDispatchClient`.
- `client/index.html` — Browser client using LiveKit SDK from CDN. Has comprehensive debug logging in a transcript panel (color-coded: yellow=debug, red=error, blue=user speech, green=agent speech).
- `patches/@livekit__agents.patch` — pnpm patch fixing Anthropic tool call ID compatibility (see below).

### Scripts

- `pnpm dev` — Run token-server and agent together (use this for development)
- `pnpm dev:agent` — Run agent only
- `pnpm client` — Run token server only
- `pnpm download-files` — Download turn detector ONNX model files (~460MB)
- `pnpm build` — Vite SSR build for production

## Anthropic + LiveKit OpenAI Plugin Compatibility

There is no native `@livekit/agents-plugin-anthropic` for Node.js. We use `@livekit/agents-plugin-openai` with `baseURL: 'https://api.anthropic.com/v1/'`. This works but has known incompatibilities that required workarounds:

### 1. Empty tools array rejected
Anthropic rejects `tools: []` while OpenAI accepts it. The agent must always define at least one tool. That's why `get_time` and `set_reminder` exist in `agent.ts` — removing all tools will cause 400 errors.

### 2. Tool call ID format (patched)
LiveKit's voice pipeline generates tool call IDs like `item_abc123/fnc_0` with a `/` separator. Anthropic requires IDs matching `^[a-zA-Z0-9_-]+` (no slashes). Fixed via `pnpm patch @livekit/agents` which changes `/` to `-`. The patch is at `patches/@livekit__agents.patch` and auto-applies on `pnpm install`.

### 3. Event name types
Session events require the `voice.AgentSessionEventTypes` enum, not raw strings. E.g., `session.on(Events.Error, ...)` not `session.on('error', ...)`.

## Agent Dispatch

The agent must be explicitly dispatched to a room. This is handled automatically:
1. Agent registers with `agentName: 'botical'` in `ServerOptions` (`main.ts:180`)
2. When a user requests a token, the token server also calls `dispatchClient.createDispatch(room, 'botical')` (`token-server.ts`)
3. LiveKit Cloud sends the job to the registered worker, triggering the `entry` callback

Without explicit dispatch, the agent worker registers but never receives jobs.

## Logging

The agent outputs comprehensive timestamped logs for every pipeline stage:
- `[stt]` — Speech-to-text metrics (audio duration, streaming status)
- `[llm]` — LLM metrics (TTFT, tokens/sec, prompt/completion tokens)
- `[tts]` — Text-to-speech metrics (TTFB, audio duration, character count)
- `[eou]` — End-of-utterance metrics (utterance delay, transcription delay)
- `[vad]` — Voice activity detection metrics (idle time, inference count)
- `[agent]` / `[user-state]` — State machine transitions
- `[stt:final]` / `[stt:interim]` — Transcription text
- `[chat]` — Conversation items added to context
- `[speech]` — Speech lifecycle events
- `[tool]` — Tool execution
- `[error]` — Pipeline errors with source
- `[usage]` — Cumulative token/character/audio usage on session close

## TypeScript

Strict mode with `exactOptionalPropertyTypes`. Use `?? ''` for optional env vars (not just `!`). The `ctx.proc.userData.vad` is `unknown` and must be cast: `ctx.proc.userData.vad as silero.VAD`.
