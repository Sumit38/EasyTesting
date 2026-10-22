import { unzipSync } from 'fflate';

/** What EasyTesting needs to know about an Android app to install and start it. */
export interface ApkInfo {
  /** The app's ID, for example com.example.shop. */
  package: string;
  versionName?: string;
  versionCode?: string;
  /** The screen the launcher opens, in full: com.example.shop.MainActivity. */
  launchActivity?: string;
  /** The app's name, when the manifest states it as text (it is often a resource reference instead). */
  label?: string;
  minSdk?: string;
  targetSdk?: string;
  permissions: string[];
}

export class ApkError extends Error {}

/** Reads an APK (a zip with a binary AndroidManifest.xml) and returns its identity and start screen. */
export function readApk(bytes: Uint8Array): ApkInfo {
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new ApkError('That file is not an APK (an APK is a zip archive). Upload the .apk file Android Studio or your build made.');
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, { filter: (f) => f.name === 'AndroidManifest.xml' });
  } catch (e) {
    throw new ApkError(`The APK could not be opened: ${(e as Error).message}`);
  }
  const manifest = files['AndroidManifest.xml'];
  if (!manifest) throw new ApkError('That zip has no AndroidManifest.xml, so it is not an Android app. An .aab bundle must be turned into an .apk first.');
  return fromManifest(parseAxml(manifest));
}

interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}

const ANDROID = 'http://schemas.android.com/apk/res/android';

/** Android's compiled XML ("AXML"): a string pool, then start and end tags whose names and values point into it. */
export function parseAxml(buf: Uint8Array): XmlNode {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const u16 = (o: number) => v.getUint16(o, true);
  const u32 = (o: number) => v.getUint32(o, true);
  if (buf.length < 8 || u16(0) !== 0x0003) throw new ApkError('The manifest is not in the compiled format Android uses.');
  let strings: string[] = [];
  const root: XmlNode = { name: '#root', attrs: {}, children: [] };
  const stack: XmlNode[] = [root];
  const str = (i: number) => (i === 0xffffffff ? '' : strings[i] ?? '');

  let off = u16(2); // past the file header
  while (off + 8 <= buf.length) {
    const type = u16(off);
    const headerSize = u16(off + 2);
    const size = u32(off + 4);
    if (size < 8 || off + size > buf.length) break;
    if (type === 0x0001) strings = readStringPool(v, off);
    else if (type === 0x0102) {
      const ext = off + headerSize;
      const name = str(u32(ext + 4));
      const attrStart = u16(ext + 8), attrSize = u16(ext + 10), count = u16(ext + 12);
      const attrs: Record<string, string> = {};
      for (let i = 0; i < count; i++) {
        const a = ext + attrStart + i * attrSize;
        const ns = str(u32(a));
        const key = (ns === ANDROID ? 'android:' : '') + str(u32(a + 4));
        const raw = u32(a + 8);
        const dataType = v.getUint8(a + 15);
        const data = u32(a + 16);
        attrs[key] = raw !== 0xffffffff ? str(raw) : typedValue(dataType, data, str);
      }
      const node: XmlNode = { name, attrs, children: [] };
      stack[stack.length - 1].children.push(node);
      stack.push(node);
    } else if (type === 0x0103) {
      if (stack.length > 1) stack.pop();
    }
    off += size;
  }
  const manifest = root.children[0];
  if (!manifest) throw new ApkError('The manifest is empty.');
  return manifest;
}

function readStringPool(v: DataView, at: number): string[] {
  const u16 = (o: number) => v.getUint16(o, true);
  const u32 = (o: number) => v.getUint32(o, true);
  const count = u32(at + 8);
  const utf8 = (u32(at + 16) & 0x100) !== 0;
  const start = at + u32(at + 20);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    let p = start + u32(at + u16(at + 2) + i * 4);
    if (utf8) {
      // Two lengths (UTF-16 then UTF-8), each one or two bytes, then the bytes.
      p += v.getUint8(p) & 0x80 ? 2 : 1;
      let len = v.getUint8(p);
      if (len & 0x80) { len = ((len & 0x7f) << 8) | v.getUint8(p + 1); p += 2; } else p += 1;
      out.push(new TextDecoder('utf-8').decode(new Uint8Array(v.buffer, v.byteOffset + p, len)));
    } else {
      let len = u16(p);
      if (len & 0x8000) { len = ((len & 0x7fff) << 16) | u16(p + 2); p += 4; } else p += 2;
      let s = '';
      for (let k = 0; k < len; k++) s += String.fromCharCode(u16(p + k * 2));
      out.push(s);
    }
  }
  return out;
}

function typedValue(type: number, data: number, str: (i: number) => string): string {
  if (type === 0x03) return str(data);
  if (type === 0x10) return String(data | 0);
  if (type === 0x11) return '0x' + data.toString(16);
  if (type === 0x12) return data !== 0 ? 'true' : 'false';
  if (type === 0x01) return '@0x' + data.toString(16).padStart(8, '0'); // a resource: its real value lives in resources.arsc
  return String(data);
}

function fromManifest(m: XmlNode): ApkInfo {
  const pkg = m.attrs.package;
  if (!pkg) throw new ApkError('The manifest names no package, so this is not an installable app.');
  const full = (n: string | undefined) => (!n ? undefined : n.startsWith('.') ? pkg + n : n.includes('.') ? n : `${pkg}.${n}`);
  const all = (n: XmlNode, out: XmlNode[] = []): XmlNode[] => { out.push(n); n.children.forEach((c) => all(c, out)); return out; };
  const app = m.children.find((c) => c.name === 'application');
  // The launcher screen: an activity (or alias) with the MAIN action and the LAUNCHER category.
  const launchers = (app?.children ?? []).filter((c) => (c.name === 'activity' || c.name === 'activity-alias') && c.children.some((f) => f.name === 'intent-filter'
    && f.children.some((a) => a.name === 'action' && a.attrs['android:name'] === 'android.intent.action.MAIN')
    && f.children.some((a) => a.name === 'category' && a.attrs['android:name'] === 'android.intent.category.LAUNCHER')));
  const first = launchers.find((a) => a.attrs['android:enabled'] !== 'false') ?? launchers[0];
  const launch = first ? (first.name === 'activity-alias' ? first.attrs['android:name'] : first.attrs['android:name']) : undefined;
  const sdk = m.children.find((c) => c.name === 'uses-sdk');
  const label = app?.attrs['android:label'];
  return {
    package: pkg,
    versionName: m.attrs['android:versionName'] || undefined,
    versionCode: m.attrs['android:versionCode'] || undefined,
    launchActivity: full(launch),
    label: label && !label.startsWith('@') ? label : undefined,
    minSdk: sdk?.attrs['android:minSdkVersion'],
    targetSdk: sdk?.attrs['android:targetSdkVersion'],
    permissions: all(m).filter((n) => n.name === 'uses-permission').map((n) => n.attrs['android:name']).filter(Boolean),
  };
}
