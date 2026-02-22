import { cli, defineAgent, voice, ServerOptions, metrics } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as cartesia from '@livekit/agents-plugin-cartesia';
import * as silero from '@livekit/agents-plugin-silero';
import * as livekit from '@livekit/agents-plugin-livekit';
import { BotAgent } from './agent.js';
import { CostTracker, formatCost, type CostUpdate } from './costs.js';

const Events = voice.AgentSessionEventTypes;

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

function fmtMs(ms: number): string {
  return `${Math.round(ms)}ms`;
}

export default defineAgent({
  prewarm: async (proc) => {
    console.log(`[${ts()}] [prewarm] loading Silero VAD model...`);
    proc.userData.vad = await silero.VAD.load();
    console.log(`[${ts()}] [prewarm] VAD model loaded, worker ready (pid: ${proc.pid})`);
  },
  entry: async (ctx) => {
    console.log(`[${ts()}] [entry] job received, connecting to room...`);
    await ctx.connect();
    console.log(`[${ts()}] [entry] connected to room: ${ctx.room.name}`);

    // Log existing participants
    for (const [, p] of ctx.room.remoteParticipants) {
      console.log(`[${ts()}] [room] participant already in room: ${p.identity}`);
    }

    const usageCollector = new metrics.UsageCollector();
    const costTracker = new CostTracker();

    function publishCost(service: CostUpdate['service'], cost: number): void {
      const update: CostUpdate = {
        type: 'cost_update',
        service,
        cost,
        session: costTracker.getSession(),
      };
      ctx.room.localParticipant?.publishData(
        new TextEncoder().encode(JSON.stringify(update)),
        { reliable: true, topic: 'botical.costs' }
      );
    }

    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad as silero.VAD,
      stt: new deepgram.STT({
        model: 'nova-3',
        language: 'en',
      }),
      llm: new openai.LLM({
        model: 'claude-sonnet-4-6',
        apiKey: process.env.ANTHROPIC_API_KEY ?? '',
        baseURL: 'https://api.anthropic.com/v1/',
        temperature: 0.8,
      }),
      tts: new cartesia.TTS({
        language: 'en',
        voice: '6c9e08ad-6629-4ba3-a640-a0bae916dfff',
        model: 'sonic-3',
        speed: 'slow',
        emotion: ['positivity:high']
      }),
      turnDetection: new livekit.turnDetector.MultilingualModel(),
      voiceOptions: {
        allowInterruptions: true,
        minInterruptionDuration: 0.5,
        minEndpointingDelay: 0.5,
        maxEndpointingDelay: 3.0,
        preemptiveGeneration: true,
        userAwayTimeout: 30,
      },
    });

    // --- Pipeline metrics (latency per stage) ---
    session.on(Events.MetricsCollected, (ev) => {
      const m = ev.metrics;
      usageCollector.collect(m);

      if (m.type === 'stt_metrics') {
        const cost = costTracker.addStt(m.audioDurationMs);
        console.log(
          `[${ts()}] [stt] audio: ${fmtMs(m.audioDurationMs)}, ` +
          `duration: ${fmtMs(m.durationMs)}, streamed: ${m.streamed}, cost: ${formatCost(cost)}`
        );
        publishCost('stt', cost);
      } else if (m.type === 'llm_metrics') {
        const cached = (m as Record<string, unknown>).cachedTokens as number | undefined;
        const cost = costTracker.addLlm(m.promptTokens, m.completionTokens, cached ?? 0);
        console.log(
          `[${ts()}] [llm] TTFT: ${fmtMs(m.ttftMs)}, duration: ${fmtMs(m.durationMs)}, ` +
          `tokens: ${m.promptTokens}→${m.completionTokens} (${Math.round(m.tokensPerSecond)} tok/s), ` +
          `cost: ${formatCost(cost)}` +
          (m.cancelled ? ' [CANCELLED]' : '')
        );
        publishCost('llm', cost);
      } else if (m.type === 'tts_metrics') {
        const cost = costTracker.addTts(m.charactersCount);
        console.log(
          `[${ts()}] [tts] TTFB: ${fmtMs(m.ttfbMs)}, duration: ${fmtMs(m.durationMs)}, ` +
          `audio: ${fmtMs(m.audioDurationMs)}, chars: ${m.charactersCount}, cost: ${formatCost(cost)}` +
          (m.cancelled ? ' [CANCELLED]' : '')
        );
        publishCost('tts', cost);
      } else if (m.type === 'eou_metrics') {
        console.log(
          `[${ts()}] [eou] utterance delay: ${fmtMs(m.endOfUtteranceDelayMs)}, ` +
          `transcription delay: ${fmtMs(m.transcriptionDelayMs)}, ` +
          `turn completed delay: ${fmtMs(m.onUserTurnCompletedDelayMs)}`
        );
      } else if (m.type === 'vad_metrics') {
        console.log(
          `[${ts()}] [vad] idle: ${fmtMs(m.idleTimeMs)}, ` +
          `inferences: ${m.inferenceCount} (${fmtMs(m.inferenceDurationTotalMs)} total)`
        );
      }
    });

    // --- Agent state machine ---
    session.on(Events.AgentStateChanged, (ev) => {
      console.log(`[${ts()}] [agent] ${ev.oldState} → ${ev.newState}`);
    });

    // --- User state ---
    session.on(Events.UserStateChanged, (ev) => {
      console.log(`[${ts()}] [user-state] ${ev.oldState} → ${ev.newState}`);
      if (ev.newState === 'away') {
        session.generateReply({ userInput: '[The user has been quiet for a while. Check in briefly.]' });
      }
    });

    // --- Transcription ---
    session.on(Events.UserInputTranscribed, (ev) => {
      const tag = ev.isFinal ? 'final' : 'interim';
      console.log(`[${ts()}] [stt:${tag}] "${ev.transcript}"`);
    });

    // --- Conversation items (messages added to chat context) ---
    session.on(Events.ConversationItemAdded, (ev) => {
      const item = ev.item;
      console.log(`[${ts()}] [chat] ${item.role}: "${String(item.content).slice(0, 120)}${String(item.content).length > 120 ? '...' : ''}"`);
    });

    // --- Speech lifecycle ---
    session.on(Events.SpeechCreated, (ev) => {
      console.log(
        `[${ts()}] [speech] created (source: ${ev.source}, id: ${ev.speechHandle.id})` +
        (ev.userInitiated ? ' [user-initiated]' : '')
      );
    });

    // --- Tool execution ---
    session.on(Events.FunctionToolsExecuted, (ev) => {
      for (const fn of ev.functionCalls) {
        console.log(`[${ts()}] [tool] called: ${fn.name}(${fn.args})`);
      }

      // Forward tool call results to client
      const payload = JSON.stringify({
        type: 'tool_calls',
        tools: ev.functionCalls.map((fn, i) => ({
          name: fn.name,
          args: fn.args,
          output: ev.functionCallOutputs[i]?.output ?? '',
          isError: ev.functionCallOutputs[i]?.isError ?? false,
        })),
      });
      ctx.room.localParticipant?.publishData(
        new TextEncoder().encode(payload),
        { reliable: true, topic: 'botical.events' }
      );
    });

    // --- Errors and close ---
    session.on(Events.Error, (ev) => {
      console.error(`[${ts()}] [error] source: ${ev.source}, error:`, ev.error);
    });

    session.on(Events.Close, (ev) => {
      console.log(`[${ts()}] [session] closed: ${ev.reason}`);
      const usage = usageCollector.getSummary();
      console.log(`[${ts()}] [usage] LLM prompt: ${usage.llmPromptTokens} tokens (${usage.llmPromptCachedTokens} cached), completion: ${usage.llmCompletionTokens} tokens`);
      console.log(`[${ts()}] [usage] TTS: ${usage.ttsCharactersCount} chars, STT audio: ${fmtMs(usage.sttAudioDurationMs)}`);
      const costs = costTracker.getSession();
      console.log(
        `[${ts()}] [costs] session total: ${formatCost(costs.total)} ` +
        `(STT: ${formatCost(costs.stt)}, LLM: ${formatCost(costs.llm)}, TTS: ${formatCost(costs.tts)})`
      );
    });

    // --- Room events ---
    ctx.room.on('participantConnected', (participant) => {
      console.log(`[${ts()}] [room] participant joined: ${participant.identity}`);
    });

    ctx.room.on('participantDisconnected', (participant) => {
      console.log(`[${ts()}] [room] participant left: ${participant.identity}`);
    });

    ctx.room.on('trackSubscribed', (track, publication, participant) => {
      console.log(`[${ts()}] [room] subscribed to ${track.kind} track from ${participant.identity}`);
    });

    ctx.room.on('disconnected', () => {
      console.log(`[${ts()}] [room] disconnected`);
    });

    ctx.addShutdownCallback(async () => {
      console.log(`[${ts()}] [shutdown] closing session...`);
      await session.close();
      console.log(`[${ts()}] [shutdown] done`);
    });

    console.log(`[${ts()}] [entry] starting agent session...`);
    await session.start({
      agent: new BotAgent(),
      room: ctx.room,
    });
    console.log(`[${ts()}] [entry] agent session started, waiting for user`);
  },
});

// Custom load function: Bun on Linux can return identical os.cpus() times across
// samples, producing NaN. NaN load causes the LiveKit server's affinity calculation
// to fail (1-NaN=NaN), so job requests are silently dropped. Fall back to 0 if NaN.
async function cpuLoad(): Promise<number> {
  const os = await import('node:os');
  const cpus1 = os.cpus();
  return new Promise((resolve) => {
    setTimeout(() => {
      const cpus2 = os.cpus();
      let idle = 0;
      let total = 0;
      for (let i = 0; i < cpus1.length; i++) {
        const t1 = cpus1[i]!.times;
        const t2 = cpus2[i]!.times;
        idle += t2.idle - t1.idle;
        const s1 = Object.values(t1).reduce((a, b) => a + b, 0);
        const s2 = Object.values(t2).reduce((a, b) => a + b, 0);
        total += s2 - s1;
      }
      const load = +(1 - idle / total).toFixed(2);
      resolve(Number.isFinite(load) ? load : 0);
    }, 2500);
  });
}

cli.runApp(new ServerOptions({
  agent: import.meta.filename,
  agentName: 'botical',
  wsURL: process.env.LIVEKIT_URL ?? 'ws://localhost:7880',
  apiKey: process.env.LIVEKIT_API_KEY ?? 'devkey',
  apiSecret: process.env.LIVEKIT_API_SECRET ?? 'secret',
  loadFunc: cpuLoad,
}));
