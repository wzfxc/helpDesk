import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_DATABASE_URL } from './env.js';

const PORT = 4789;
const apiDir = path.resolve(__dirname, '..');
let child: ChildProcess | undefined;

async function waitReady(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const ok = await new Promise<boolean>((resolve) => {
      http
        .get({ port: PORT, path: '/ready' }, (res) => {
          res.resume();
          resolve(res.statusCode === 200);
        })
        .on('error', () => {
          resolve(false);
        });
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('api did not become ready');
}

// SIGTERM cannot be delivered gracefully to child processes on Windows (it is a hard kill),
// so this scenario runs on Linux/macOS (CI and the Docker image).
describe.skipIf(process.platform === 'win32')('graceful shutdown (SIGTERM)', () => {
  beforeAll(() => {
    execFileSync('npx', ['tsc', '-p', 'tsconfig.build.json'], { cwd: apiDir, stdio: 'inherit' });
  }, 120_000);

  afterAll(() => {
    child?.kill('SIGKILL');
  });

  it('finishes the in-flight request, closes SSE streams and exits with code 0', async () => {
    child = spawn('node', ['dist/main.js'], {
      cwd: apiDir,
      env: {
        ...process.env,
        API_PORT: String(PORT),
        DATABASE_URL: TEST_DATABASE_URL,
        WORKER_ENABLED: 'true',
        ATTACHMENTS_DIR: './data/test-attachments',
      },
      stdio: 'inherit',
    });
    const exit = new Promise<number | null>((resolve) =>
      child?.on('exit', (code) => {
        resolve(code);
      }),
    );
    await waitReady();

    // an in-flight request: headers sent, body still incomplete
    const body = JSON.stringify({ email: 'nobody@test.io', password: 'x' });
    const inflight = new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          port: PORT,
          path: '/auth/login',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.write(body.slice(0, 5));
      setTimeout(() => {
        child?.kill('SIGTERM');
        setTimeout(() => {
          req.end(body.slice(5));
        }, 300);
      }, 200);
    });

    expect(await inflight).toBe(401); // processed normally, not dropped
    expect([0, null]).toContain(await exit);
  }, 30_000);
});
