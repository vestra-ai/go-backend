// GO_CONTRACT as Go's team writes it (11 Oct 2026: "set it to 1.3.0"): any 1.x from 1.1 up behaves as 1.1; a typo stops the start.
import { describe, expect, it } from 'vitest';
import { goContractOf } from '../src/config.js';

describe('GO_CONTRACT', () => {
  it('reads 1.0 and 1.x versions, short or with a patch, and refuses anything else', () => {
    const of = (v?: string) => goContractOf(v === undefined ? {} : { GO_CONTRACT: v });
    expect([of(), of('1.0'), of('1.0.0'), of('1.1'), of('1.1.0'), of('1.3.0'), of(' 1.3.0 '), of('1.12')]).toEqual(['1.0', '1.0', '1.0', '1.1', '1.1', '1.1', '1.1', '1.1']);
    for (const bad of ['2.0', '1', 'v1.3.0', '1.3.0-beta', 'latest']) expect(() => of(bad)).toThrow(/GO_CONTRACT must be a 1\.x version/);
  });
});
