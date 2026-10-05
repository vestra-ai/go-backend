// pnpm skips the install script of the embedded Postgres binaries unless it is approved, and without it
// the binaries cannot find their libraries. This runs that script (it is safe to run again).
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const store = join(process.cwd(), 'node_modules', '.pnpm');
if (existsSync(store)) {
  for (const dir of readdirSync(store).filter((d) => d.startsWith('@embedded-postgres+'))) {
    const pkg = join(store, dir, 'node_modules', '@embedded-postgres');
    for (const name of existsSync(pkg) ? readdirSync(pkg) : []) {
      const script = join(pkg, name, 'scripts', 'hydrate-symlinks.js');
      if (existsSync(script)) execFileSync(process.execPath, [script], { cwd: join(pkg, name), stdio: 'ignore' });
    }
  }
}
