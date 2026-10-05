// The numbers from the contract (guides/socket.md, guides/reliability.md, guides/money.md).
export const SIGNATURE_HEADER = 'x-go-signature';
export const SOCKET_PATH = '/v1/socket';
export const MAX_FRAME_BYTES = 1_048_576;
export const PING_INTERVAL_SECONDS = 20;
export const IDLE_CLOSE_SECONDS = 40;
export const RECONNECT_BACKOFF_SECONDS = [1, 2, 5, 10, 30] as const;
export const MAX_APPROVAL_TTL_SECONDS = 600;
export const CONTRACT_VERSION = '1.0.0';
