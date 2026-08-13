import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * `agentsignal alert --wait` exits 0 on acknowledgement and 2 on expiry.
 *
 * The README sells this as `agentsignal alert --wait "Deploy?" && ./deploy.sh`,
 * which makes the exit code load-bearing in the most literal way: get it wrong
 * in one direction and a deploy nobody approved runs anyway. It had no test.
 *
 * Spawned rather than imported, because `process.exit` is the behaviour under
 * test and there is no honest way to observe it in-process. `HOME` points at a
 * temp directory so the CLI reads a config we wrote instead of the developer's
 * own -- the base URL only comes from that file, and rewriting somebody's real
 * one to run a test would be a poor trade.
 */

const RECIPIENT = 'u_8fk2AbCdEfGhIjKlMnOpQr';
const CLI = resolve(__dirname, '..', 'src', 'index.ts');

let server: Server;
let baseUrl: string;
/** Flipped per test to choose what the receipt says. */
let acknowledged = false;

beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');

    if (req.url?.startsWith('/v1/messages')) {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        res.end(JSON.stringify({
          ok: true,
          id: 'm_1',
          receipt: 'r_test',
          deliveries: { total: 1, sent: 1, failed: 0, queued: 0 },
        }));
      });
      return;
    }

    if (req.url?.startsWith('/v1/receipts/')) {
      const answer = () =>
        res.end(JSON.stringify({ ok: true, acknowledged, acked_at: null, waited_ms: 5 }));

      if (acknowledged) return answer();

      // Hold the request the way the real endpoint does. Answering "not yet"
      // instantly while still reporting `waited_ms` would make the client spin
      // -- it takes that field to mean the server honoured ?wait= and so does
      // not pace itself. Holding is both truer to production and what lets the
      // expiry case finish in one request rather than hundreds.
      const held = Number(new URL(req.url, 'http://x').searchParams.get('wait') ?? '1');
      setTimeout(answer, Math.min(held, 60) * 1000);
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: { code: 'not_found', message: 'no' } }));
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

/** Run the CLI with its own HOME, and report how it exited. */
function runCli(args: string[]): Promise<{ code: number; output: string }> {
  const home = mkdtempSync(join(tmpdir(), 'agentsignal-cli-'));
  mkdirSync(join(home, '.config', 'agentsignal'), { recursive: true });
  writeFileSync(
    join(home, '.config', 'agentsignal', 'config.json'),
    JSON.stringify({ apiKey: 'as_test_key', baseUrl }),
  );

  return new Promise((resolveRun) => {
    const child = spawn('npx', ['tsx', CLI, ...args], {
      env: { ...process.env, HOME: home, AGENTSIGNAL_API_KEY: 'as_test_key' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stderr.on('data', (c) => (output += c));
    child.stdout.on('data', (c) => (output += c));
    child.on('close', (code) => resolveRun({ code: code ?? -1, output }));
  });
}

describe('alert --wait', () => {
  it('exits 0 when a human acknowledges, so `&&` proceeds', async () => {
    acknowledged = true;

    const { code } = await runCli([
      'alert', '--to', RECIPIENT, '--wait', '--retry', '30', '--expire', '30', 'Deploy?',
    ]);

    expect(code).toBe(0);
  }, 60_000);

  /**
   * The direction that matters. A zero here would run the deploy that nobody
   * approved, and it would do it silently.
   */
  it('exits 2 when nobody answers, so `&&` stops', async () => {
    acknowledged = false;

    const { code, output } = await runCli([
      // 30 is the floor for both: the schema refuses a retry below 30 or one
      // that outlives its own expiry. So this case costs its 30 seconds.
      'alert', '--to', RECIPIENT, '--wait', '--retry', '30', '--expire', '30', 'Deploy?',
    ]);

    expect(code).toBe(2);
    expect(output).toContain('Expired without acknowledgement');
  }, 120_000);
});
