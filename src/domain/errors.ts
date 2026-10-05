import { SocketCallError } from '../go/go-socket.js';

export const notFound = (message: string) => new SocketCallError(404, message, 'not_found');
export const conflict = (message: string) => new SocketCallError(409, message, 'conflict');
export const invalid = (message: string) => new SocketCallError(422, message, 'invalid');
export const rateLimited = (message: string, retryAfterSeconds: number) => new SocketCallError(429, message, 'rate_limited', retryAfterSeconds);
export const unavailable = (message: string) => new SocketCallError(503, message, 'unavailable');
