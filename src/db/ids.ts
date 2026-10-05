import { randomBytes } from 'node:crypto';

/** Ids are opaque strings of 1 to 64 characters. The prefix only makes logs readable. */
export const newId = (prefix: string): string => `${prefix}_${randomBytes(8).toString('hex')}`;
