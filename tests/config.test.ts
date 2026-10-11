// The socket's address to Go: `instance` names the process, `server` the deployment (GO_SERVER_NAME). Go keeps a trip,
// and a person's ixigo login, with the Server of that name, so it must be the same across deploys (11 Oct 2026: a
// redeploy with no name stranded every older trip's replies).
import { describe, expect, it } from 'vitest';
import { serverNameOf, socketUrl } from '../src/config.js';

describe('the socket address', () => {
  it('carries the deployment name after the instance when there is one, and is unchanged without it', () => {
    expect(socketUrl('https://go.example', 'host-80')).toBe('wss://go.example/v1/socket?instance=host-80');
    expect(socketUrl('https://go.example', 'host-80', 'go-server-prod')).toBe('wss://go.example/v1/socket?instance=host-80&server=go-server-prod');
    expect(socketUrl('http://127.0.0.1:9', 'a b', 'x')).toBe('ws://127.0.0.1:9/v1/socket?instance=a%20b&server=x');
  });

  it('GO_SERVER_NAME: unset or empty is none; a name Go would not take stops the start', () => {
    expect([serverNameOf({}), serverNameOf({ GO_SERVER_NAME: '  ' }), serverNameOf({ GO_SERVER_NAME: ' go-server-prod ' })]).toEqual([undefined, undefined, 'go-server-prod']);
    for (const bad of ['go server', 'a&instance=b', 'x'.repeat(65), 'né']) expect(() => serverNameOf({ GO_SERVER_NAME: bad })).toThrow(/GO_SERVER_NAME/);
  });
});
