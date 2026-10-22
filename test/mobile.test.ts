import { mkdtempSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readApk } from '../src/mobile/apk.js';
import { createApp } from '../src/server/index.js';
// @ts-expect-error the agent is plain JavaScript that testers download as one file
import { parseAdbDevices, parseAppiumDrivers, parseJavaVersion } from '../src/server/public/easytesting-agent.mjs';

const expo = readFileSync(new URL('./fixtures/expo-go-manifest.apk', import.meta.url));

describe('reading an APK', () => {
  it('finds the app ID, version, start screen and Android versions, as Google\'s aapt2 reports them', () => {
    const info = readApk(expo);
    // aapt2 dump badging: package name='host.exp.exponent' versionCode='442' versionName='57.0.2', launchable-activity host.exp.exponent.experience.HomeActivity
    assert.equal(info.package, 'host.exp.exponent');
    assert.equal(info.versionName, '57.0.2');
    assert.equal(info.versionCode, '442');
    assert.equal(info.launchActivity, 'host.exp.exponent.experience.HomeActivity');
    assert.equal(info.minSdk, '24');
    assert.equal(info.targetSdk, '36');
    assert.ok(info.permissions.includes('android.permission.INTERNET'));
  });

  it('says plainly when a file is not an Android app', () => {
    assert.throws(() => readApk(new TextEncoder().encode('just text')), /not an APK/);
    assert.throws(() => readApk(readFileSync(new URL('./fixtures/usecase-shop.md', import.meta.url))), /not an APK/);
  });
});

describe('what the agent reads from the tools', () => {
  it('lists phones and emulators with their state and model', () => {
    const out = 'List of devices attached\nR58N12ABCDE            device usb:1-1 product:a52q model:SM_A525F device:a52q transport_id:2\nemulator-5554          device product:sdk_gphone64 model:sdk_gphone64_x86_64 transport_id:1\n0A1B2C3D               unauthorized usb:1-2 transport_id:3\n';
    assert.deepEqual(parseAdbDevices(out), [
      { serial: 'R58N12ABCDE', state: 'device', model: 'SM A525F', emulator: false },
      { serial: 'emulator-5554', state: 'device', model: 'sdk gphone64 x86 64', emulator: true },
      { serial: '0A1B2C3D', state: 'unauthorized', model: undefined, emulator: false },
    ]);
    assert.deepEqual(parseAdbDevices('* daemon not running; starting now at tcp:5037\n* daemon started successfully\nList of devices attached\n\n'), []);
  });
  it('reads Java versions old and new', () => {
    assert.equal(parseJavaVersion('java version "17.0.10" 2024-01-16 LTS'), 17);
    assert.equal(parseJavaVersion('openjdk version "1.8.0_392"'), 8);
    assert.equal(parseJavaVersion("'java' is not recognized as an internal or external command"), undefined);
  });
  it('reads the installed Appium drivers, ignoring its progress lines', () => {
    assert.deepEqual(parseAppiumDrivers('- Listing installed drivers\n{"uiautomator2":{"version":"3.5.2"}}'), ['uiautomator2']);
    assert.deepEqual(parseAppiumDrivers('nothing here'), []);
  });
});

describe('connecting a tester\'s computer', () => {
  it('pairs the agent once with a short code, shows its checks to its owner only, and lets it fetch only its owner\'s apps', async () => {
    const { server } = createApp({ dataDir: mkdtempSync(join(tmpdir(), 'mob-')), accounts: true });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const jar: Record<string, string> = {};
    const as = (who: string) => async (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', raw?: Uint8Array) => {
      const res = await fetch(base + path, { method, headers: { ...(raw ? {} : { 'content-type': 'application/json' }), ...(jar[who] ? { cookie: jar[who] } : {}) }, body: (raw as unknown as BodyInit | undefined) ?? (body === undefined ? undefined : JSON.stringify(body)) });
      const set = res.headers.get('set-cookie')?.split(';')[0];
      if (set && !set.endsWith('=')) jar[who] = set;
      return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
    };
    const agent = (token?: string) => async (path: string, body?: unknown) => {
      const res = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, type: res.headers.get('content-type'), bytes: new Uint8Array(await res.clone().arrayBuffer()), body: (await res.json().catch(() => ({}))) as any };
    };
    const ann = as('ann'), bob = as('bob');
    try {
      await ann('/api/auth/setup', { email: 'ann@x.io', name: 'Ann', password: 'ann-password' });
      await ann('/api/users', { email: 'bob@x.io', name: 'Bob', password: 'bob-password', role: 'tester' });
      await bob('/api/auth/login', { email: 'bob@x.io', password: 'bob-password' });

      // Upload: the APK is read at once; anything else is refused with a reason.
      assert.equal((await bob('/api/mobile/apps?filename=notes.txt', undefined, 'POST', new TextEncoder().encode('hello'))).status, 400);
      const up = await bob('/api/mobile/apps?filename=expo.apk', undefined, 'POST', expo);
      assert.equal(up.status, 201, JSON.stringify(up.body));
      assert.deepEqual([up.body.package, up.body.versionName, up.body.launchActivity], ['host.exp.exponent', '57.0.2', 'host.exp.exponent.experience.HomeActivity']);

      // Pairing: a code shown to Bob, used once by his agent.
      const { code } = (await bob('/api/mobile/pair', {})).body;
      assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      assert.equal((await agent()('/api/agent/pair', { code: 'WRONG-CODE' })).status, 401);
      const paired = await agent()('/api/agent/pair', { code: code.toLowerCase() });
      assert.equal(paired.status, 200);
      assert.equal((await agent()('/api/agent/pair', { code })).status, 401, 'a code works once');
      const bobsAgent = agent(paired.body.token);

      // Without its key the agent gets nothing; with it, it reports and learns which apps to fetch.
      assert.equal((await agent('not-a-key')('/api/agent/report', { checks: [] })).status, 401);
      const reported = await bobsAgent('/api/agent/report', {
        os: 'windows', host: 'BOB-LAPTOP', agentVersion: '1.0.0', avds: ['Pixel_7_API_34'],
        checks: [{ id: 'java', ok: true, detail: 'Java 17' }, { id: 'device', ok: false, detail: 'No phone or emulator is connected.' }],
        devices: [], apps: {}, extra: 'ignored', evil: '<script>',
      });
      assert.equal(reported.status, 200);
      assert.deepEqual(reported.body.apps.map((a: any) => a.package), ['host.exp.exponent']);

      const seen = (await bob('/api/mobile/agent')).body;
      assert.equal(seen.online, true);
      assert.equal(seen.report.host, 'BOB-LAPTOP');
      assert.deepEqual(seen.report.checks.map((c: any) => [c.id, c.ok]), [['java', true], ['device', false]]);
      assert.equal(seen.report.evil, undefined, 'only known fields are kept');
      assert.equal((await ann('/api/mobile/agent')).body, null, "Ann does not see Bob's computer");

      // The agent downloads Bob's APK, and nothing that is not his.
      const apk = await bobsAgent(`/api/agent/apps/${up.body.id}/apk`);
      assert.equal(apk.status, 200);
      assert.equal(apk.type, 'application/vnd.android.package-archive');
      assert.deepEqual(apk.bytes, new Uint8Array(expo));
      const annsApp = (await ann('/api/mobile/apps?filename=a.apk', undefined, 'POST', expo)).body;
      assert.equal((await bobsAgent(`/api/agent/apps/${annsApp.id}/apk`)).status, 404);

      // Disconnecting signs the agent out.
      await bob('/api/mobile/agent', {}, 'DELETE');
      assert.equal((await bobsAgent('/api/agent/report', { checks: [] })).status, 401);

      // The agent file itself is served for download.
      const file = await fetch(base + '/agent/easytesting-agent.mjs');
      assert.equal(file.status, 200);
      assert.match(file.headers.get('content-disposition') ?? '', /attachment; filename="easytesting-agent\.mjs"/);
      assert.match(await file.text(), /It never runs commands sent by the server/);
    } finally {
      server.close();
    }
  });
});
