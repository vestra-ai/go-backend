import { SocketCallError } from '../go/go-socket.js';

/**
 * A rule the input broke, with the field it names when known. On the app's API it becomes `422 invalid` with
 * `error.field`; on Go's socket it is an ordinary 422 (the field travels in the message).
 */
export class InvalidInput extends SocketCallError {
  constructor(message: string, readonly field: string | null = null) {
    super(422, message, 'invalid');
  }
}

export const notFound = (message: string) => new SocketCallError(404, message, 'not_found');
export const conflict = (message: string) => new SocketCallError(409, message, 'conflict');
export const invalid = (message: string, field?: string | null) => new InvalidInput(message, field ?? null);
export const rateLimited = (message: string, retryAfterSeconds: number) => new SocketCallError(429, message, 'rate_limited', retryAfterSeconds);
export const unavailable = (message: string) => new SocketCallError(503, message, 'unavailable');
