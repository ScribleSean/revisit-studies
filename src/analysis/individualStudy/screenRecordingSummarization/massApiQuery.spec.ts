import { describe, expect, it } from 'vitest';

import { buildMassApiUrl, massApiFetchableMediaUrl, utf8ToBase64Url } from './massApiQuery';

describe('massApiFetchableMediaUrl', () => {
  it('accepts https and localhost http', () => {
    expect(massApiFetchableMediaUrl('https://x.example/a')).toBe('https://x.example/a');
    expect(massApiFetchableMediaUrl('http://127.0.0.1:8080/o')).toBe('http://127.0.0.1:8080/o');
    expect(massApiFetchableMediaUrl('http://localhost:1234/o')).toBe('http://localhost:1234/o');
  });

  it('rejects blob and empty', () => {
    expect(massApiFetchableMediaUrl('blob:http://local/x')).toBeNull();
    expect(massApiFetchableMediaUrl(null)).toBeNull();
    expect(massApiFetchableMediaUrl('')).toBeNull();
  });
});

describe('buildMassApiUrl', () => {
  it('drops empty params', () => {
    const u = buildMassApiUrl('http://h/api/x', { videoUrl: 'https://a/v', foo: '', bar: null });
    expect(u).toBe('http://h/api/x?videoUrl=https%3A%2F%2Fa%2Fv');
  });

  it('supports relative API paths', () => {
    expect(buildMassApiUrl('/api/timeline', { videoUrl: 'https://z/v' })).toBe('/api/timeline?videoUrl=https%3A%2F%2Fz%2Fv');
    expect(buildMassApiUrl('/api/timeline?debug=1', { a: 'b' })).toBe('/api/timeline?debug=1&a=b');
  });
});

describe('utf8ToBase64Url', () => {
  it('round-trips unicode without padding', () => {
    const s = 'émoji 🔥';
    const b64url = utf8ToBase64Url(s);
    expect(b64url.includes('=')).toBe(false);
    const bin = atob(b64url.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    expect(new TextDecoder().decode(bytes)).toBe(s);
  });
});
