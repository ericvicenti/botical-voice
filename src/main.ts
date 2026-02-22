import 'dotenv/config';
import { cli, defineAgent, voice, ServerOptions, metrics } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as cartesia from '@livekit/agents-plugin-cartesia';
import * as silero from '@livekit/agents-plugin-silero';
import * as livekit from '@livekit/agents-plugin-livekit';
import { BotAgent } from './agent.js';

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

    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad as silero.VAD,
      stt: new deepgram.STT({
        model: 'nova-3',
        language: 'en',
      }),
      llm: new openai.LLM({
        model: 'claude-haiku-4-5-20251001',
        apiKey: process.env.ANTHROPIC_API_KEY ?? '',
        baseURL: 'https://api.anthropic.com/v1/',
        temperature: 0.8,
      }),
      tts: new cartesia.TTS({
        language: 'en',
      }),
      turnDetection: new livekit.turnDetector.MultilingualModel(),
      voiceOptions: {
        allowInterruptions: true,
        minInterruptionDuration: 0.5,
        minEndpointingDelay: 0.5,
        maxEndpointingDelay: 3.0,
        preemptiveGeneration: true,
      },
    });

    // --- Pipeline metrics (latency per stage) ---
    session.on(Events.MetricsCollected, (ev) => {
      const m = ev.metrics;
      usageCollector.collect(m);

      if (m.type === 'stt_metrics') {
        console.log(
          `[${ts()}] [stt] audio: ${fmtMs(m.audioDurationMs)}, ` +
          `duration: ${fmtMs(m.durationMs)}, streamed: ${m.streamed}`
        );
      } else if (m.type === 'llm_metrics') {
        console.log(
          `[${ts()}] [llm] TTFT: ${fmtMs(m.ttftMs)}, duration: ${fmtMs(m.durationMs)}, ` +
          `tokens: ${m.promptTokens}→${m.completionTokens} (${Math.round(m.tokensPerSecond)} tok/s)` +
          (m.cancelled ? ' [CANCELLED]' : '')
        );
      } else if (m.type === 'tts_metrics') {
        console.log(
          `[${ts()}] [tts] TTFB: ${fmtMs(m.ttfbMs)}, duration: ${fmtMs(m.durationMs)}, ` +
          `audio: ${fmtMs(m.audioDurationMs)}, chars: ${m.charactersCount}` +
          (m.cancelled ? ' [CANCELLED]' : '')
        );
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

cli.runApp(new ServerOptions({ agent: import.meta.filename, agentName: 'botical' }));
