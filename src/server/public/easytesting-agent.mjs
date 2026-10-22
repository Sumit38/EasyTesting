#!/usr/bin/env node
/**
 * EasyTesting Agent: checks this computer for what Android app testing needs (Java, the Android SDK and ADB, a phone or
 * emulator, Appium and its Android driver, Appium Inspector) and shows the result on the EasyTesting Mobile page.
 *
 *   First time:  node easytesting-agent.mjs https://your-easytesting-site PAIRING-CODE
 *   Afterwards:  node easytesting-agent.mjs https://your-easytesting-site
 *
 * What it does, and nothing else: runs the fixed check commands listed below (java -version, adb devices, appium --version...),
 * sends their results to your EasyTesting site, and saves a copy of the apps you uploaded there into
 * ~/EasyTesting/apps so Appium can install them. It never runs commands sent by the server.
 * Press Ctrl+C to stop it.
 */
import { exec } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname, platform } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const AGENT_VERSION = '1.0.0';
export const OS = platform() === 'win32' ? 'windows' : platform() === 'darwin' ? 'mac' : 'linux';

/** Runs a command and gives back what it printed, never throwing: a missing tool is a result, not a crash. */
export function run(cmd, timeout = 20000) {
  return new Promise((done) => {
    exec(cmd, { timeout, windowsHide: true, env: process.env }, (err, stdout, stderr) => done({ ok: !err, out: `${stdout ?? ''}\n${stderr ?? ''}`.trim(), code: err?.code }));
  });
}

/** "adb devices -l" lines: serial, state (device, unauthorized, offline...), model. */
export function parseAdbDevices(text) {
  return String(text).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^List of devices/i.test(l) && !l.startsWith('*'))
    .map((l) => {
      const [serial, state, ...rest] = l.split(/\s+/);
      const model = rest.find((x) => x.startsWith('model:'))?.slice(6).replace(/_/g, ' ');
      return { serial, state, model, emulator: serial.startsWith('emulator-') };
    }).filter((d) => d.serial && d.state);
}

/** The major version from "java -version": 1.8.0_x is 8, 17.0.10 is 17. */
export function parseJavaVersion(text) {
  const m = String(text).match(/version "(\d+)(?:\.(\d+))?/);
  if (!m) return undefined;
  return m[1] === '1' ? Number(m[2]) : Number(m[1]);
}

/** The installed Appium drivers, from "appium driver list --installed --json". */
export function parseAppiumDrivers(text) {
  const start = String(text).indexOf('{');
  if (start < 0) return [];
  try {
    return Object.keys(JSON.parse(String(text).slice(start)));
  } catch {
    return [];
  }
}

function sdkHome() {
  const env = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  const fallback = OS === 'windows' ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Android', 'Sdk') : OS === 'mac' ? join(homedir(), 'Library', 'Android', 'sdk') : join(homedir(), 'Android', 'Sdk');
  return { env, path: env || (existsSync(fallback) ? fallback : undefined), fallback };
}

const quote = (p) => (/\s/.test(p) ? `"${p}"` : p);

/** Every check, in the order a person sets things up. */
export async function runChecks(exec_ = run) {
  const checks = [];
  const add = (id, ok, detail) => checks.push({ id, ok, detail });

  const node = Number(process.versions.node.split('.')[0]);
  add('node', node >= 18, `Node.js ${process.versions.node}${node < 18 ? ' is too old: install version 18 or newer' : ''}`);

  const java = await exec_('java -version');
  const jv = parseJavaVersion(java.out);
  add('java', jv !== undefined && jv >= 11, jv === undefined ? 'Java was not found.' : jv < 11 ? `Java ${jv} is too old for Appium: install Java 17.` : `Java ${jv}${process.env.JAVA_HOME ? '' : ' (JAVA_HOME is not set; set it if Appium complains)'}`);

  const sdk = sdkHome();
  add('android-sdk', !!sdk.env, sdk.env ? `ANDROID_HOME is ${sdk.env}` : sdk.path ? `The Android SDK is at ${sdk.path}, but ANDROID_HOME is not set, so Appium will not find it.` : 'The Android SDK was not found.');

  const adbBin = sdk.path && existsSync(join(sdk.path, 'platform-tools', OS === 'windows' ? 'adb.exe' : 'adb')) ? join(sdk.path, 'platform-tools', OS === 'windows' ? 'adb.exe' : 'adb') : 'adb';
  const adbV = await exec_(`${quote(adbBin)} version`);
  const inPath = (await exec_('adb version')).ok;
  add('adb', adbV.ok, adbV.ok ? `${(adbV.out.match(/Android Debug Bridge version [\d.]+/) ?? ['ADB'])[0]}${inPath ? '' : ' (not on PATH: add platform-tools to PATH)'}` : 'ADB (platform-tools) was not found.');

  const list = adbV.ok ? parseAdbDevices((await exec_(`${quote(adbBin)} devices -l`)).out) : [];
  const ready = list.filter((d) => d.state === 'device');
  const waiting = list.filter((d) => d.state === 'unauthorized');
  add('device', ready.length > 0,
    ready.length ? `Connected: ${ready.map((d) => `${d.model ?? d.serial}${d.emulator ? ' (emulator)' : ''}`).join(', ')}`
      : waiting.length ? 'A phone is connected but has not allowed this computer: unlock it and tap Allow on "Allow USB debugging?".'
        : list.length ? `A device is ${list[0].state}: unplug it and plug it in again.` : 'No phone or emulator is connected.');

  const emu = sdk.path && existsSync(join(sdk.path, 'emulator')) ? join(sdk.path, 'emulator', OS === 'windows' ? 'emulator.exe' : 'emulator') : undefined;
  const avds = emu ? (await exec_(`${quote(emu)} -list-avds`)).out.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !/^(INFO|WARNING|ERROR)\b/.test(s)) : [];

  const appium = await exec_('appium --version');
  const av = (appium.out.match(/(\d+)\.\d+\.\d+/) ?? [])[0];
  add('appium', appium.ok && !!av && Number(av.split('.')[0]) >= 2, !appium.ok ? 'Appium was not found.' : !av || Number(av.split('.')[0]) < 2 ? `Appium ${av ?? '?'} is too old: install Appium 2.` : `Appium ${av}`);

  const drivers = appium.ok ? parseAppiumDrivers((await exec_('appium driver list --installed --json', 60000)).out) : [];
  add('uiautomator2', drivers.includes('uiautomator2'), drivers.includes('uiautomator2') ? 'The Android driver (UiAutomator2) is installed.' : appium.ok ? 'The Android driver is not installed.' : 'Install Appium first.');

  let serverUp = false;
  for (const p of ['/status', '/wd/hub/status']) {
    try {
      const r = await fetch('http://127.0.0.1:4723' + p, { signal: AbortSignal.timeout(2000) });
      if (r.ok) { serverUp = true; break; }
    } catch { /* not running */ }
  }
  add('appium-server', serverUp, serverUp ? 'The Appium server is running on port 4723.' : 'The Appium server is not running.');

  const inspectorPaths = OS === 'windows'
    ? [join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Appium Inspector', 'Appium Inspector.exe'), join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Appium Inspector', 'Appium Inspector.exe')]
    : OS === 'mac' ? ['/Applications/Appium Inspector.app', join(homedir(), 'Applications', 'Appium Inspector.app')] : [];
  const inspector = inspectorPaths.find((p) => existsSync(p));
  add('inspector', OS === 'linux' ? null : !!inspector, inspector ? `Appium Inspector is installed (${inspector}).` : OS === 'linux' ? 'On Linux Appium Inspector is an AppImage the agent cannot find; tick it yourself if you have it.' : 'Appium Inspector was not found.');

  return { checks, devices: list, avds };
}

const configFile = (server) => join(homedir(), '.easytesting', `agent-${createHash('sha256').update(server).digest('hex').slice(0, 12)}.json`);

async function call(server, path, init = {}) {
  const res = await fetch(server + path, { ...init, signal: AbortSignal.timeout(30000) });
  const body = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.arrayBuffer();
  if (!res.ok) throw new Error(body?.error || `The site answered ${res.status}.`);
  return body;
}

/** Keeps the uploaded apps in ~/EasyTesting/apps, so Appium's "app" setting can point at them. */
async function syncApps(server, token, apps) {
  const dir = join(homedir(), 'EasyTesting', 'apps');
  mkdirSync(dir, { recursive: true });
  const paths = {};
  for (const a of apps) {
    const file = join(dir, `${a.package}-${(a.versionName ?? 'app').replace(/[^\w.-]/g, '_')}-${a.id}.apk`);
    const have = existsSync(file) && createHash('sha256').update(readFileSync(file)).digest('hex') === a.sha256;
    if (!have) {
      process.stdout.write(`  Downloading ${a.filename}... `);
      const bytes = await call(server, `/api/agent/apps/${a.id}/apk`, { headers: { authorization: `Bearer ${token}` } });
      writeFileSync(file, Buffer.from(bytes));
      console.log('done');
    }
    paths[a.id] = file;
  }
  return paths;
}

const LABEL = { node: 'Node.js', java: 'Java', 'android-sdk': 'Android SDK', adb: 'ADB', device: 'Phone or emulator', appium: 'Appium', uiautomator2: 'Appium Android driver', 'appium-server': 'Appium server', inspector: 'Appium Inspector' };

async function main() {
  const [serverArg, code] = process.argv.slice(2);
  if (!serverArg) {
    console.log('Usage: node easytesting-agent.mjs https://your-easytesting-site [PAIRING-CODE]\nGet the code on the Mobile page of EasyTesting.');
    process.exit(2);
  }
  const server = serverArg.replace(/\/+$/, '');
  const cfg = configFile(server);
  let token = existsSync(cfg) ? JSON.parse(readFileSync(cfg, 'utf8')).token : undefined;
  if (code) {
    ({ token } = await call(server, '/api/agent/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) }));
    mkdirSync(join(homedir(), '.easytesting'), { recursive: true });
    writeFileSync(cfg, JSON.stringify({ server, token }), { mode: 0o600 });
    console.log('Connected to', server);
  }
  if (!token) {
    console.log('This computer is not connected yet. Get a pairing code on the Mobile page and run:\n  node easytesting-agent.mjs', server, 'YOUR-CODE');
    process.exit(2);
  }
  let apps = {};
  let last = '';
  console.log('Checking this computer. Keep this window open; the Mobile page updates as you install things. Ctrl+C to stop.\n');
  for (;;) {
    const { checks, devices, avds } = await runChecks();
    const report = { os: OS, host: hostname(), agentVersion: AGENT_VERSION, checks, devices, avds, apps };
    try {
      const out = await call(server, '/api/agent/report', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(report) });
      const before = JSON.stringify(apps);
      apps = await syncApps(server, token, out.apps ?? []);
      if (JSON.stringify(apps) !== before) await call(server, '/api/agent/report', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ ...report, apps }) });
    } catch (e) {
      console.log('Could not reach EasyTesting:', e.message);
      if (/not connected|code is wrong/.test(e.message)) process.exit(1);
    }
    const now = checks.map((c) => `${c.ok === true ? '✔' : c.ok === false ? '✖' : '?'} ${LABEL[c.id] ?? c.id}: ${c.detail}`).join('\n');
    if (now !== last) { console.log(new Date().toLocaleTimeString(), '\n' + now + '\n'); last = now; }
    await new Promise((r) => setTimeout(r, 10000));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e.message); process.exit(1); });
