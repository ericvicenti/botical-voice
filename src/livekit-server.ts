import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { join } from 'node:path';
import { access } from 'node:fs/promises';

const LIVEKIT_PORT = 7880;
const LIVEKIT_SERVER_DIR = join(import.meta.dirname, '../livekit-server');

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

async function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createNetServer();
    server.once('error', () => resolve(true));
    server.once('listening', () => {
      server.close();
      resolve(false);
    });
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Start the LiveKit server as a child process.
 *
 * In dev mode (default), uses `go run` for fast iteration.
 * If a pre-built binary exists at dist/livekit-server, uses that instead.
 *
 * Returns a cleanup function that kills the child process.
 */
export async function startLiveKit(): Promise<() => void> {
  // Check if port is already in use (another LiveKit instance running)
  if (await isPortInUse(LIVEKIT_PORT)) {
    console.log(`[${ts()}] [livekit] port ${LIVEKIT_PORT} already in use, skipping server start`);
    return () => {};
  }

  // Prefer pre-built binary if it exists, otherwise use `go run`
  const binaryPath = join(import.meta.dirname, '../dist/livekit-server');
  let command: string;
  let args: string[];
  let cwd: string;

  try {
    await access(binaryPath);
    command = binaryPath;
    args = ['--dev'];
    cwd = LIVEKIT_SERVER_DIR;
    console.log(`[${ts()}] [livekit] using pre-built binary`);
  } catch {
    command = 'go';
    args = ['run', './cmd/server', '--dev'];
    cwd = LIVEKIT_SERVER_DIR;
    console.log(`[${ts()}] [livekit] using go run (dev mode)`);
  }

  return new Promise<() => void>((resolve, reject) => {
    const child: ChildProcess = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let resolved = false;
    let stopping = false;

    const cleanup = () => {
      stopping = true;
      if (child.exitCode === null && !child.killed) {
        console.log(`[${ts()}] [livekit] stopping server...`);
        child.kill('SIGTERM');
      }
    };

    // Kill LiveKit when our process exits
    process.on('exit', cleanup);
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    const handleOutput = (data: Buffer) => {
      const lines = data.toString().trimEnd().split('\n');
      for (const line of lines) {
        console.log(`[${ts()}] [livekit] ${line}`);

        // Detect server readiness (Go logger may write to stdout or stderr)
        if (!resolved && line.includes('starting LiveKit server')) {
          resolved = true;
          resolve(cleanup);
        }
      }
    };

    child.stdout?.on('data', handleOutput);
    child.stderr?.on('data', handleOutput);

    child.on('error', (err) => {
      console.error(`[${ts()}] [livekit] failed to start:`, err.message);
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });

    child.on('exit', (code, signal) => {
      console.log(`[${ts()}] [livekit] exited (code: ${code}, signal: ${signal})`);
      process.removeListener('exit', cleanup);
      process.removeListener('SIGINT', cleanup);
      process.removeListener('SIGTERM', cleanup);
      if (!resolved && !stopping) {
        resolved = true;
        reject(new Error(`LiveKit server exited unexpectedly with code ${code}`));
      }
    });

    // Timeout: if server doesn't start within 30s, reject
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup();
        reject(new Error('LiveKit server failed to start within 30s'));
      }
    }, 30_000);
  });
}
