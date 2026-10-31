/** Public HTTPS only, every DNS answer checked, then one address pinned for the TLS socket. */
import { isIP } from 'node:net';
import { Resolver } from 'node:dns/promises';
import https from 'node:https';
const v4Number = text => text.split('.').reduce((n, part) => (n * 256) + Number(part), 0);
function in4(address, base, bits) { return Math.floor(v4Number(address) / 2 ** (32 - bits)) === Math.floor(v4Number(base) / 2 ** (32 - bits)); }
function v6Number(address) {
  let text = address.toLowerCase();
  if (text.includes('.')) {
    const split = text.lastIndexOf(':'), value = v4Number(text.slice(split + 1));
    text = text.slice(0, split + 1) + Math.floor(value / 65536).toString(16) + ':' + (value % 65536).toString(16);
  }
  const halves = text.split('::'), left = halves[0] ? halves[0].split(':') : [], right = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  const groups = halves.length === 1 ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return groups.reduce((n, x) => (n << 16n) | BigInt('0x' + x), 0n);
}
function in6(value, base, bits) { return value >> BigInt(128 - bits) === v6Number(base) >> BigInt(128 - bits); }
export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) return ![
    ['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],
    ['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],
    ['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4],['168.63.129.16',32],
  ].some(([base,bits]) => in4(address,base,bits));
  if (family !== 6) return false;
  const value = v6Number(address);
  if (in6(value, '::ffff:0:0', 96)) {
    const n = Number(value & 0xffffffffn), mapped = [24,16,8,0].map(shift => Math.floor(n / 2 ** shift) % 256).join('.');
    return isPublicAddress(mapped);
  }
  return in6(value, '2000::', 3) && ![['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]].some(([base,bits]) => in6(value,base,bits));
}
export function validateEndpoint(input) {
  if (typeof input !== 'string' || input.length < 9 || input.length > 2048 || input !== input.trim() || /[\x00-\x20\x7f\\]/.test(input)) throw new Error('Endpoint must be a public HTTPS URL');
  let url; try { url = new URL(input); } catch { throw new Error('Endpoint must be a public HTTPS URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || url.hash || input.includes('#')) throw new Error('Only public HTTPS port 443 without URL credentials or fragment is supported');
  if (url.search.length > 1024 || [...url.searchParams].length > 16) throw new Error('Endpoint query is too large');
  for (const [key, value] of url.searchParams) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (key.length > 64 || value.length > 256 || /(?:token|apikey|password|passwd|secret|signature|credential|authorization|bearer)/.test(normalized) || ['key','auth','sig','session','sessionid'].includes(normalized)) throw new Error('Credential-like query parameters are refused; use the ephemeral API key field');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (!hostname || hostname.includes('*') || /(?:^|\.)(?:localhost|local|internal|invalid|test|example)$/.test(hostname) || hostname.endsWith('.home.arpa')) throw new Error('Endpoint hostname is not public');
  if (isIP(hostname) && !isPublicAddress(hostname)) throw new Error('Endpoint address is not public');
  return url;
}
export async function resolvePublicTarget(input, { resolverFactory = () => new Resolver({ timeout: 1500, tries: 1 }), timeoutMs = 2000 } = {}) {
  const url = validateEndpoint(input), hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname)) return { url, address: hostname, family: isIP(hostname), addresses: [{ address: hostname, family: isIP(hostname) }] };
  const resolver = resolverFactory(); let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; resolver.cancel(); }, timeoutMs);
  try {
    const responses = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]); const addresses = [];
    if (timedOut) throw new Error('Endpoint DNS lookup timed out');
    for (const [index, response] of responses.entries()) {
      if (response.status === 'rejected') { if (['ENODATA','ENOTFOUND'].includes(response.reason?.code)) continue; throw new Error('Endpoint DNS lookup failed'); }
      for (const address of response.value) addresses.push({ address, family: index === 0 ? 4 : 6 });
    }
    if (!addresses.length || addresses.length > 64 || addresses.some(x => isIP(x.address) !== x.family || !isPublicAddress(x.address))) throw new Error('Every endpoint DNS address must be public');
    const selected = addresses.find(x => x.family === 4) ?? addresses[0];
    return { url, ...selected, addresses };
  } finally { clearTimeout(timer); }
}
export function pinnedOptions(target, { method = 'GET', headers = {}, signal } = {}) {
  const url = validateEndpoint(target.url.href), hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!isPublicAddress(target.address) || isIP(target.address) !== target.family) throw new Error('Pinned endpoint address is not public');
  return {
    protocol: 'https:', hostname, port: 443, path: url.pathname + url.search, method, headers, signal, agent: false,
    servername: isIP(hostname) ? undefined : hostname, rejectUnauthorized: true, maxHeaderSize: 32768,
    lookup(_name, options, callback) { if (typeof options === 'function') callback = options; callback(null, options?.all ? [{ address: target.address, family: target.family }] : target.address, target.family); },
  };
}
export function openPinnedRequest(target, options, onResponse) {
  const request = https.request(pinnedOptions(target, options), onResponse);
  request.maxHeadersCount = 64;
  request.end(options.body);
  return request;
}
