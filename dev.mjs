/** Preview-compatible entrypoint; production continues to use PORT via server.mjs. */
import { parseArgs } from 'node:util';
import { createApp } from './server.mjs';
const { values } = parseArgs({ options: { host: { type: 'string', default: '0.0.0.0' }, port: { type: 'string', default: process.env.PORT ?? '3000' }, strictPort: { type: 'boolean', default: false } } });
if (!['0.0.0.0', '127.0.0.1', 'localhost'].includes(values.host)) throw new Error('Preview host must be a local bind address');
if (!/^\d+$/.test(values.port)) throw new Error('Invalid preview port');
const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Preview port must be 0..65535');
// listen errors always fail: no fallback port, regardless of --strictPort.
const app = await createApp({ host: values.host, port });
console.log(JSON.stringify({ event: 'listening', url: app.url, fixture: true, preview: true }));
let closing = false;
const stop = () => { if (closing) return; closing = true; void app.close().then(() => { process.exitCode = 0; }, () => { process.exitCode = 1; }); };
process.once('SIGTERM', stop); process.once('SIGINT', stop);
