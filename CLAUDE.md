# Botical3

Real-time voice assistant built with LiveKit Agents (TypeScript/Bun), with a self-hosted LiveKit server.

## Quick Start

```bash
bun install
bun run download-files   # downloads ~460MB turn detector ONNX models (first time only)
bun dev                  # builds client, starts LiveKit server + token-server + agent
```

Open http://localhost:3000, click Connect, and speak.

## Prerequisites

- **Bun** — Managed automatically via [mise](https://mise.jdx.dev/) + [direnv](https://direnv.net/). Just `cd` into the project directory and Bun will be available. If not already installed: `brew install mise direnv`.
- **Go 1.24+** — Also managed via mise. Required for the self-hosted LiveKit server.

## Required Environment Variables

Copy `.env.example` to `.env` and fill in:

- `ANTHROPIC_API_KEY` — Anthropic API key for Claude LLM
- `DEEPGRAM_API_KEY` — Deepgram API key for streaming STT
- `CARTESIA_API_KEY` — Cartesia API key for TTS

LiveKit credentials are not needed — the server runs locally with hardcoded dev credentials (`devkey`/`secret`). Bun automatically loads `.env` files (no dotenv needed).

## Architecture

### Frontend

The browser client is a TypeScript app built with Bun's HTML bundler. Source lives in `client/`:

```
client/
  index.html          — HTML shell with <script type="module"> and <link>
  src/
    main.ts           — Entry point, wires modules together
    room.ts           — LiveKit room connection, events, reconnection
    chat.ts           — Chat message rendering (user/agent/tool cards)
    voice-state.ts    — Voice state indicator logic
    debug.ts          — Debug panel logging
  styles/
    main.css          — All styles
```

Built output goes to `dist/client/` with content-hashed JS/CSS files. The token server serves these built files.

### LiveKit Server (Self-Hosted)

The LiveKit WebRTC server source is vendored at `livekit-server/` via `git subtree` from [github.com/livekit/livekit](https://github.com/livekit/livekit). The token server starts it automatically as a child process on port 7880.

- **Dev mode**: Uses `go run` for fast iteration — no build step needed
- **Pre-built binary**: If `dist/livekit-server` exists (from `bun run build:livekit`), uses that instead
- **Port detection**: Skips starting if port 7880 is already in use
- **Forking**: Edit Go source in `livekit-server/` directly. Pull upstream updates with: `git subtree pull --prefix=livekit-server --squash https://github.com/livekit/livekit.git master`

### Pipeline

Browser mic -> LiveKit Server (localhost:7880, WebSocket) -> Agent:
1. **VAD**: Silero (voice activity detection, runs locally)
2. **STT**: Deepgram Nova-3 (streaming — only streaming STT with a LiveKit Node.js plugin)
3. **Turn Detection**: LiveKit Multilingual Model (Qwen2.5-0.5B ONNX, runs locally, dynamically adjusts endpointing delay 0.5s-3.0s)
4. **LLM**: Anthropic Claude Sonnet 4.6 via OpenAI-compatible endpoint
5. **TTS**: Cartesia Sonic (streaming)

Audio flows Browser <-> LiveKit Server (local) <-> Agent. The token server only handles HTTP (token generation, serving the built client).

### Key Files

- `src/main.ts` — Agent entry point. `defineAgent({ prewarm, entry })` loads VAD model, creates the voice session with all providers, wires up comprehensive logging for every pipeline stage.
- `src/agent.ts` — `BotAgent` class extending `voice.Agent`. Contains system instructions and tools (`get_time`, `set_reminder`). At least one tool must be defined (see Anthropic quirks below).
- `src/token-server.ts` — HTTP server on port 3000. Starts LiveKit server, serves the built client from `dist/client/` at `/`, generates LiveKit tokens at `/api/token`, and creates explicit agent dispatches via `AgentDispatchClient`.
- `src/livekit-server.ts` — LiveKit server child process manager. Handles starting, readiness detection, and graceful shutdown.
- `client/` — Frontend TypeScript source (see Frontend section above).
- `livekit-server/` — Vendored LiveKit Go source (git subtree).
- `patches/@livekit%2Fagents@1.0.47.patch` — Patch fixing Anthropic tool call ID and whitespace compatibility (see below).

### Scripts

- `bun dev` — Build client + run LiveKit server + token-server + agent together (use this for development)
- `bun run dev:agent` — Run agent only (assumes LiveKit server already running)
- `bun run client` — Run token server + LiveKit server only (no agent)
- `bun run build:client` — Build frontend to `dist/client/`
- `bun run build:livekit` — Compile LiveKit server Go binary to `dist/livekit-server`
- `bun run download-files` — Download turn detector ONNX model files (~460MB)

## Anthropic + LiveKit OpenAI Plugin Compatibility

There is no native `@livekit/agents-plugin-anthropic` for Node.js. We use `@livekit/agents-plugin-openai` with `baseURL: 'https://api.anthropic.com/v1/'`. This works but has known incompatibilities that required workarounds:

### 1. Empty tools array rejected
Anthropic rejects `tools: []` while OpenAI accepts it. The agent must always define at least one tool. That's why `get_time` and `set_reminder` exist in `agent.ts` — removing all tools will cause 400 errors.

### 2. Tool call ID format (patched)
LiveKit's voice pipeline generates tool call IDs like `item_abc123/fnc_0` with a `/` separator. Anthropic requires IDs matching `^[a-zA-Z0-9_-]+$` (no slashes or other special characters). Fixed via patch which changes `/` to `-` and sanitizes all callId values with `.replace(/[^a-zA-Z0-9_-]/g, '')` both at generation time and at the API boundary. The patch is at `patches/@livekit%2Fagents@1.0.47.patch` and auto-applies on `bun install`. Patches require the `bun patch` / `bun patch --commit` workflow to generate — manually written patch files won't be applied.

### 3. Event name types
Session events require the `voice.AgentSessionEventTypes` enum, not raw strings. E.g., `session.on(Events.Error, ...)` not `session.on('error', ...)`.

## Agent Dispatch

The agent must be explicitly dispatched to a room. This is handled automatically:
1. Agent registers with `agentName: 'botical'` in `ServerOptions` (`main.ts`)
2. When a user requests a token, the token server also calls `dispatchClient.createDispatch(room, 'botical')` (`token-server.ts`)
3. LiveKit server sends the job to the registered worker, triggering the `entry` callback

Without explicit dispatch, the agent worker registers but never receives jobs.

## Production Deployment

In production, LiveKit runs as a separate process (managed by systemd) with its own config file and API keys. The token server skips starting its own LiveKit child process.

### Key Environment Variables

| Variable | Dev Default | Production | Description |
|----------|-------------|------------|-------------|
| `LIVEKIT_API_KEY` | `devkey` | Real key | LiveKit API key |
| `LIVEKIT_API_SECRET` | `secret` | Real secret | LiveKit API secret |
| `LIVEKIT_URL` | `ws://localhost:7880` | `ws://localhost:7880` | Internal URL (agent SDK reads this) |
| `LIVEKIT_PUBLIC_URL` | (not set) | `wss://domain/rtc` | Public URL returned to browsers |
| `LIVEKIT_HOST` | `http://localhost:7880` | `http://localhost:7880` | Internal URL for dispatch API |
| `LIVEKIT_EXTERNAL` | (not set) | `true` | Skip child LiveKit process in token server |

**Important**: `LIVEKIT_URL` must always be the internal localhost URL. The LiveKit agents SDK reads `process.env.LIVEKIT_URL` as a fallback for its WebSocket connection. Setting it to the public URL would route the agent through the reverse proxy instead of connecting directly.

See `DEPLOYMENT.md` (gitignored) for full server setup details.

## Logging

The agent outputs comprehensive timestamped logs for every pipeline stage:
- `[livekit]` — LiveKit server output (prefixed from child process)
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

Two separate tsconfig files:
- `tsconfig.json` — Backend (Node.js/Bun APIs, strict mode with `exactOptionalPropertyTypes`)
- `client/tsconfig.json` — Frontend (DOM types, no Node.js types)

Use `?? ''` for optional env vars (not just `!`). The `ctx.proc.userData.vad` is `unknown` and must be cast: `ctx.proc.userData.vad as silero.VAD`.
