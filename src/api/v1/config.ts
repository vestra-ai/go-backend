// §4.14: what the app reads before anything else (no sign-in): the contract version, the feature flags and the push key,
// and the health check (also at /health for the platform).
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.js';
import { SECTIONS, type RouteMeta } from './meta.js';
import { PUBLIC, type V1Deps } from './shared.js';

/** The contract version this server speaks and the oldest app it answers. */
export const CONTRACT_VERSION = '1.0.0';
export const MIN_CLIENT_VERSION = '1.0.0';
export const CURRENCY_DEFAULT = 'INR';

export const routes: RouteMeta[] = [
  { method: 'GET', path: '/app/v1/config', section: SECTIONS.config, title: 'Config', summary: 'The contract version, the feature flags and the Web Push public key. No sign-in.', auth: 'none' },
  { method: 'GET', path: '/app/v1/health', section: SECTIONS.config, title: 'Health', summary: 'Whether the server is up and connected to Go. No sign-in.', auth: 'none' },
];

export function register(app: FastifyInstance, _ctx: Ctx, deps: V1Deps): void {
  const health = async () => ({ ok: true, go: deps.go.connected ?? null });
  app.get('/health', PUBLIC, health);
  app.get('/app/v1/health', PUBLIC, health);
  app.get('/app/v1/config', PUBLIC, async () => ({
    contract: CONTRACT_VERSION,
    min_client_version: MIN_CLIENT_VERSION,
    currency_default: CURRENCY_DEFAULT,
    features: deps.features,
    vapid_public_key: deps.pushPublicKey ?? null,
  }));
}
