import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SignInput {
  method: string;
  /** The path plus the query string, exactly as sent. */
  target: string;
  /** The raw body. Empty for the socket upgrade. */
  body: string | Uint8Array;
}

/** `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>\n<METHOD>\n<target>\n<body>")>` */
export function signRequest(input: SignInput, secret: string, t: number = Math.floor(Date.now() / 1000)): string {
  const body = typeof input.body === 'string' ? Buffer.from(input.body, 'utf8') : Buffer.from(input.body);
  const head = Buffer.from(`${t}\n${input.method}\n${input.target}\n`, 'utf8');
  const v1 = createHmac('sha256', secret).update(Buffer.concat([head, body])).digest('hex');
  return `t=${t},v1=${v1}`;
}

/** Checks a signature header. Only used by tests: Go is the one that checks the socket's signature. */
export function verifyRequest(
  header: string,
  input: SignInput,
  secret: string,
  now: number = Math.floor(Date.now() / 1000),
  maxSkewSeconds = 300,
): boolean {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header);
  if (!m) return false;
  const t = Number(m[1]);
  if (Math.abs(now - t) > maxSkewSeconds) return false;
  const expected = signRequest(input, secret, t);
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}
