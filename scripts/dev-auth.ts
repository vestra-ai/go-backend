// A fake Supabase Auth on its own, for trying Supabase sign-in by hand against any server in AUTH_MODE=supabase
// with SUPABASE_URL=http://127.0.0.1:54331. It publishes signing keys like Supabase and hands out tokens:
//   curl 'http://127.0.0.1:54331/mint?name=Priya&email=priya@gmail.com'
// Dev only: it is not Supabase and gives a token to anyone who asks. Ctrl-C stops it.
import { FakeSupabaseAuth } from '../tests/helpers/fake-supabase-auth.js';

const port = Number(process.env.DEV_AUTH_PORT ?? 54331);
const auth = new FakeSupabaseAuth();
const url = await auth.start(port, { mint: true });
console.log(`
  Fake Supabase Auth on ${url}
    keys     ${url}/auth/v1/.well-known/jwks.json
    a token  ${url}/mint?name=Priya&email=priya@gmail.com
  Point the server at it: AUTH_MODE=supabase SUPABASE_URL=${url}
`);
process.on('SIGINT', async () => (await auth.close(), process.exit(0)));
