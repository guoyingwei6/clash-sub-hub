import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import worker from '../../src/staging-provider-worker';

describe('staging provider Worker', () => {
  it('serves V1 before switchAt and V2 after switchAt on the same URL', async () => {
    const future = Date.now() + 60_000;
    const past = Date.now() - 60_000;
    const v1 = await worker.fetch(new Request(
      `https://fixture.example/provider.yaml?switchAt=${future}`
    ));
    const v2 = await worker.fetch(new Request(
      `https://fixture.example/provider.yaml?switchAt=${past}`
    ));

    expect(v1.status).toBe(200);
    expect(v2.status).toBe(200);
    expect(v1.headers.get('Cache-Control')).toBe('no-store');
    expect(parse(await v1.text()).proxies[0]).toMatchObject({
      name: 'staging fixture server refresh',
      server: '192.0.2.200',
      port: 1080,
    });
    expect(parse(await v2.text()).proxies[0]).toMatchObject({
      name: 'staging fixture server refreshed v2',
      server: '192.0.2.201',
      port: 2080,
    });
  });

  it('rejects all non-fixture routes and methods', async () => {
    const wrongPath = await worker.fetch(
      new Request('https://fixture.example/not-provider')
    );
    const wrongMethod = await worker.fetch(new Request(
      'https://fixture.example/provider.yaml',
      { method: 'POST' }
    ));

    expect(wrongPath.status).toBe(404);
    expect(wrongMethod.status).toBe(404);
  });
});
