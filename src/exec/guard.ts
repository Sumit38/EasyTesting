import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** True for an address that is not on the public internet: this machine, a private network, link-local (cloud metadata) or reserved. */
export function isPrivateAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, '').toLowerCase();
  if (ip.startsWith('::ffff:')) {
    const v4 = ip.slice(7);
    return isIP(v4) === 4 ? isPrivateAddress(v4) : true;
  }
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  if (isIP(ip) === 6) return ip === '::' || ip === '::1' || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip);
  return false;
}

const INTERNAL_NAME = /(^|\.)(localhost|local|internal|lan|home|corp)$/;
const cache = new Map<string, { privateHost: boolean; at: number }>();

async function resolvesToPrivate(host: string): Promise<boolean> {
  const hit = cache.get(host);
  if (hit && Date.now() - hit.at < 60_000) return hit.privateHost;
  let privateHost = false;
  try {
    const found = await lookup(host, { all: true });
    privateHost = found.some((a) => isPrivateAddress(a.address));
  } catch {
    privateHost = false; // a name that does not resolve fails to load by itself
  }
  cache.set(host, { privateHost, at: Date.now() });
  return privateHost;
}

/**
 * Why a test browser may not open this address, or undefined when it may. On a shared server a tester must not be able to point
 * the browser at the server itself, its private network or its files. The sample site under /demo/ on this machine is allowed.
 */
export async function blockedReason(raw: string): Promise<string | undefined> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return `"${raw}" is not a valid web address.`;
  }
  if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'about:') return undefined;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return `Only http:// and https:// addresses can be tested here, not ${u.protocol}`;
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if ((host === '127.0.0.1' || host === 'localhost') && u.pathname.startsWith('/demo/')) return undefined;
  const why = `${u.hostname} is not a public website. This server only tests sites on the public internet.`;
  if (INTERNAL_NAME.test(host)) return why;
  if (isIP(host)) return isPrivateAddress(host) ? why : undefined;
  return (await resolvesToPrivate(host)) ? why : undefined;
}
