import { baseUrlOf } from './base-url';

describe('baseUrlOf', () => {
  it('keeps a single origin as it is', () => {
    expect(baseUrlOf(['http://localhost:3000'])).toBe('http://localhost:3000');
  });

  it('answers on each host, falling back to the first', () => {
    expect(
      baseUrlOf([
        'https://apptemplate.pietroteruya.dev',
        'http://localhost:3000',
      ]),
    ).toEqual({
      allowedHosts: ['apptemplate.pietroteruya.dev', 'localhost:3000'],
      fallback: 'https://apptemplate.pietroteruya.dev',
      protocol: 'https',
    });
  });

  it('refuses an empty list', () => {
    expect(() => baseUrlOf([])).toThrow();
  });
});
