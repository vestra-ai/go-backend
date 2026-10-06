export interface Config {
  databaseUrl: string;
  goUrl: string;
  goSigningSecret: string;
  goSpendPrivateKey: string;
  instance: string;
  port: number;
  appOrigins: string[];
}

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (see .env.example)`);
  return v;
}

/** PEM keys are often stored in one line with literal \n in an env var. */
const pem = (s: string) => s.replace(/\\n/g, '\n');

export function loadConfig(): Config {
  return {
    databaseUrl: need('DATABASE_URL'),
    goUrl: need('GO_URL').replace(/\/+$/, ''),
    goSigningSecret: need('GO_SIGNING_SECRET'),
    goSpendPrivateKey: pem(need('GO_SPEND_PRIVATE_KEY')),
    instance: process.env.INSTANCE_NAME ?? `server-${process.pid}`,
    port: Number(process.env.PORT ?? 8080),
    appOrigins: (process.env.APP_ORIGINS ?? '').split(',').map((o) => o.trim().replace(/\/+$/, '')).filter((o) => o && o !== '*' && o !== 'null'),
  };
}

/** GO_URL is Go's https:// base URL; the socket is the same host with wss:// and /v1/socket?instance=<name>. */
export function socketUrl(goUrl: string, instance: string): string {
  return `${goUrl.replace(/^http/, 'ws')}/v1/socket?instance=${encodeURIComponent(instance)}`;
}
