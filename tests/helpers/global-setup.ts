import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

// One real Postgres for the whole test run. Each test file makes its own database inside it.
export default async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'go-pg-'));
  const port = await freePort();
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port, persistent: false, onLog: () => {}, onError: () => {} });
  await pg.initialise();
  await pg.start();
  process.env.TEST_PG_URL = `postgres://postgres:postgres@localhost:${port}`;
  return async () => {
    await pg.stop();
    rmSync(dir, { recursive: true, force: true });
  };
}
