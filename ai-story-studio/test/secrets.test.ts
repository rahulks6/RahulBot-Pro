import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { dpapiProtector, SecretStore, type KeyProtector } from '../src/services/secrets.ts';

/** Fake keys are assembled at runtime so no key-shaped string sits in the source. */
const fakeKey = (tag: string) => ['rpa', `TESTONLY${tag}ABCDEFGHIJ1234`].join('_');

describe('secret store (encrypted at rest)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ais-secrets-'));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('never writes a saved key in plain text', () => {
    const d = join(dir, 'a');
    const s = new SecretStore(d, {});
    const key = fakeKey('A');
    s.set('runpodApiKey', key);
    s.setJson('youtubeToken', { refresh_token: 'refresh-secret-value', expiry: 1 });
    const onDisk = readFileSync(s.path, 'utf8');
    assert.ok(!onDisk.includes(key), 'API key not in the file');
    assert.ok(!onDisk.includes('refresh-secret-value'), 'OAuth token not in the file');
    assert.match(onDisk, /"version": 2/);
    const fresh = new SecretStore(d, {});
    assert.equal(fresh.get('runpodApiKey'), key);
    assert.deepEqual(fresh.getJson('youtubeToken'), { refresh_token: 'refresh-secret-value', expiry: 1 });
    assert.equal(fresh.masked('runpodApiKey'), '••••••••1234');
  });

  it('encrypts a v1 plain-text store on first read', () => {
    const d = join(dir, 'b');
    const key = fakeKey('B');
    new SecretStore(d, {}).delete('hfToken'); // creates the folder
    writeFileSync(
      join(d, 'secrets.json'),
      JSON.stringify({ version: 1, values: { runpodApiKey: key }, workerTokens: { pod1: 'aisw_x' } }),
    );
    const s = new SecretStore(d, {});
    assert.equal(s.get('runpodApiKey'), key);
    assert.equal(s.workerToken('pod1'), 'aisw_x');
    const onDisk = readFileSync(s.path, 'utf8');
    assert.ok(!onDisk.includes(key) && !onDisk.includes('aisw_x'), 'rewritten encrypted');
  });

  it('uses the key protector (DPAPI on Windows) and explains a store it cannot unlock', () => {
    const d = join(dir, 'c');
    const calls: string[] = [];
    const xor = (b: Buffer) => Buffer.from(b.map((x) => x ^ 0x5a));
    const fake: KeyProtector = {
      kind: 'dpapi',
      protect: (k) => (calls.push('protect'), xor(k)),
      unprotect: (b) => (calls.push('unprotect'), xor(b)),
    };
    const s = new SecretStore(d, {}, fake);
    s.set('runpodApiKey', fakeKey('C'));
    assert.equal(s.protection, 'dpapi');
    assert.equal(new SecretStore(d, {}, fake).get('runpodApiKey'), fakeKey('C'));
    assert.deepEqual(calls, ['protect', 'unprotect']);
    const otherUser: KeyProtector = {
      kind: 'dpapi',
      protect: (k) => k,
      unprotect: () => {
        throw new Error('Key not valid for use in specified state');
      },
    };
    assert.throws(() => new SecretStore(d, {}, otherUser).get('runpodApiKey'), /Forget saved keys/);
    const s2 = new SecretStore(d, {}, otherUser);
    s2.forgetAll();
    assert.equal(s2.source('runpodApiKey'), 'none');
  });

  it('the environment wins, and nothing but keys pass validation', () => {
    const s = new SecretStore(join(dir, 'd'), { RUNPOD_API_KEY: fakeKey('ENV') });
    assert.equal(s.source('runpodApiKey'), 'env');
    assert.throws(() => s.set('runpodApiKey', 'has space'), /valid key/);
  });

  it('Windows DPAPI round trip', { skip: process.platform !== 'win32' && 'Windows only' }, () => {
    const key = Buffer.from('0123456789abcdef0123456789abcdef');
    const blob = dpapiProtector.protect(key);
    assert.ok(!blob.equals(key));
    assert.ok(dpapiProtector.unprotect(blob).equals(key));
  });
});
