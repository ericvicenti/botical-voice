import 'dotenv/config';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AccessToken, AgentDispatchClient } from 'livekit-server-sdk';

const PORT = 3000;
const LIVEKIT_URL = process.env.LIVEKIT_URL ?? 'ws://localhost:7880';
const API_KEY = process.env.LIVEKIT_API_KEY ?? 'devkey';
const API_SECRET = process.env.LIVEKIT_API_SECRET ?? 'secret';

// Convert wss:// URL to https:// for REST API calls
const LIVEKIT_HOST = LIVEKIT_URL.replace(/^wss?:\/\//, 'https://');

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

const dispatchClient = new AgentDispatchClient(LIVEKIT_HOST, API_KEY, API_SECRET);

async function generateToken(identity: string, roomName: string): Promise<string> {
  const at = new AccessToken(API_KEY, API_SECRET, { identity });
  at.addGrant({ roomJoin: true, room: roomName });
  return await at.toJwt();
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  console.log(`[${ts()}] [http] ${req.method} ${url.pathname}`);

  if (url.pathname === '/api/token') {
    try {
      const identity = `user-${Math.random().toString(36).slice(2, 8)}`;
      const room = url.searchParams.get('room') ?? 'botical-room';
      const token = await generateToken(identity, room);
      console.log(`[${ts()}] [token] generated for ${identity} in room "${room}" → ${LIVEKIT_URL}`);

      // Explicitly dispatch the agent to this room
      console.log(`[${ts()}] [dispatch] requesting agent "botical" for room "${room}"...`);
      try {
        const dispatch = await dispatchClient.createDispatch(room, 'botical');
        console.log(`[${ts()}] [dispatch] created dispatch id=${dispatch.id} for room "${room}"`);
      } catch (dispatchErr) {
        console.error(`[${ts()}] [dispatch] ERROR:`, dispatchErr);
        // Don't fail the token request — agent might already be in the room
      }

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ token, url: LIVEKIT_URL, room, identity }));
    } catch (err) {
      console.error(`[${ts()}] [token] ERROR:`, err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    const html = await readFile(join(import.meta.dirname, '../client/index.html'), 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`[${ts()}] [server] Client: http://localhost:${PORT}`);
  console.log(`[${ts()}] [server] Token API: http://localhost:${PORT}/api/token`);
  console.log(`[${ts()}] [server] LiveKit URL: ${LIVEKIT_URL}`);
  console.log(`[${ts()}] [server] LiveKit Host (REST): ${LIVEKIT_HOST}`);
  console.log(`[${ts()}] [server] API Key: ${API_KEY.slice(0, 8)}...`);
  console.log(`[${ts()}] [server] Agent dispatch: enabled (agent name: "botical")`);
});
