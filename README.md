# Botical

Real-time voice assistant powered by Claude, built with [LiveKit Agents](https://docs.livekit.io/agents/) and a self-hosted LiveKit server.

**Stack:** Deepgram STT | Claude Sonnet 4.6 LLM | Cartesia TTS | Silero VAD | LiveKit Turn Detection

## Prerequisites

- [Bun](https://bun.sh/) and [Go 1.24+](https://go.dev/) — both managed automatically via [mise](https://mise.jdx.dev/) + [direnv](https://direnv.net/):
  ```bash
  brew install mise direnv
  ```
  Then `cd` into the project directory and they'll be available.

- API keys for [Anthropic](https://console.anthropic.com/), [Deepgram](https://console.deepgram.com/), and [Cartesia](https://play.cartesia.ai/).

## Setup

```bash
cp .env.example .env     # fill in your API keys
bun install
bun run download-files   # downloads ~460MB turn detector model (first time only)
```

## Development

```bash
bun dev
```

This builds the frontend, starts the self-hosted LiveKit server, the token server, and the voice agent. Open **http://localhost:3000**, click the mic button, and speak.

Other dev commands:

| Command | Description |
|---------|-------------|
| `bun dev` | Build client + start everything |
| `bun run dev:agent` | Run agent only (LiveKit server must be running separately) |
| `bun run client` | Run token server + LiveKit server only (no agent) |
| `bun run build:client` | Build frontend to `dist/client/` |

## Production Build

```bash
bun install
bun run build:client     # bundle frontend → dist/client/
bun run build:livekit    # compile LiveKit server → dist/livekit-server
```

The frontend is bundled and minified with content-hashed filenames. The LiveKit server is compiled to a standalone Go binary.

## Running in Production

In production, LiveKit runs as a separate process with its own config and API keys. Set `LIVEKIT_EXTERNAL=true` to tell the token server to skip starting its own LiveKit child process.

```bash
# Start LiveKit separately (with your own config)
./dist/livekit-server --config livekit.yaml --node-ip <your-ip>

# Start the token server and agent
bun run src/token-server.ts &   # serves client + API on port 3000
bun run start                   # starts the voice agent
```

In dev mode (without `LIVEKIT_EXTERNAL`), the token server will use the pre-built `dist/livekit-server` binary if it exists, otherwise falls back to `go run`.

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | Yes | | Anthropic API key for Claude LLM |
| `DEEPGRAM_API_KEY` | Yes | | Deepgram API key for streaming STT |
| `CARTESIA_API_KEY` | Yes | | Cartesia API key for TTS |
| `LIVEKIT_API_KEY` | No | `devkey` | LiveKit API key |
| `LIVEKIT_API_SECRET` | No | `secret` | LiveKit API secret |
| `LIVEKIT_URL` | No | `ws://localhost:7880` | Internal LiveKit URL (used by agent) |
| `LIVEKIT_PUBLIC_URL` | No | (falls back to `LIVEKIT_URL`) | Public LiveKit URL (returned to browsers) |
| `LIVEKIT_EXTERNAL` | No | | Set to `true` to skip starting LiveKit child process |

In dev mode, LiveKit runs locally with hardcoded dev credentials — no `LIVEKIT_*` env vars needed.

## Architecture

```
Browser ←WebRTC→ LiveKit Server (localhost:7880) ←→ Voice Agent
                                                     ├─ Silero VAD (local)
                                                     ├─ Deepgram STT (streaming)
                                                     ├─ LiveKit Turn Detection (local ONNX)
                                                     ├─ Claude Sonnet 4.6 (Anthropic API)
                                                     └─ Cartesia TTS (streaming)
```

The token server (port 3000) handles HTTP only — serving the client UI, generating LiveKit tokens, and dispatching the agent. All audio flows directly between the browser and LiveKit server via WebRTC.

### Project Structure

```
src/
  main.ts              Agent entry point
  agent.ts             Bot personality, system prompt, tools
  token-server.ts      HTTP server (client + tokens + agent dispatch)
  livekit-server.ts    LiveKit child process manager
client/
  index.html           HTML shell
  src/                 Frontend TypeScript modules
  styles/main.css      Styles
livekit-server/        Vendored LiveKit Go source (git subtree)
patches/               Compatibility patches for Anthropic API
dist/
  client/              Built frontend (generated)
  livekit-server       Compiled LiveKit binary (generated)
```

## Dependencies

### Runtime

| Package | Purpose |
|---------|---------|
| `@livekit/agents` | LiveKit Agents SDK — worker lifecycle, voice pipeline, metrics |
| `@livekit/agents-plugin-openai` | OpenAI-compatible LLM plugin (used with Anthropic's API via `baseURL`) |
| `@livekit/agents-plugin-deepgram` | Deepgram Nova-3 streaming speech-to-text |
| `@livekit/agents-plugin-cartesia` | Cartesia Sonic streaming text-to-speech |
| `@livekit/agents-plugin-silero` | Silero voice activity detection (runs locally) |
| `@livekit/agents-plugin-livekit` | LiveKit turn detector (Qwen2.5-0.5B ONNX model, runs locally) |
| `livekit-server-sdk` | Server-side SDK for token generation and agent dispatch |
| `livekit-client` | Browser-side LiveKit SDK (bundled into the frontend) |
| `zod` | Schema validation for tool parameters |
| `typescript` | TypeScript compiler (type checking only — Bun runs TS directly) |

### Patches

Two patches in `patches/` auto-apply on `bun install` to fix Anthropic API compatibility:

- **`@livekit/agents`** — Fixes tool call ID format (`/` → `-` to match Anthropic's regex) and trims trailing whitespace from assistant messages (Anthropic rejects it).
- **`@livekit/agents-plugin-cartesia`** — Increases the TTS sentence buffer from 8 to 200 words and adds stream context length for more natural speech chunking.

### System

- **Bun** — Package manager, runtime, and frontend bundler (replaces npm/pnpm, Node.js, tsx, and Vite)
- **Go 1.24+** — Compiles and runs the self-hosted LiveKit WebRTC server
