import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('./theme.js', import.meta.url), 'utf8');
function browser({ stored = null, dark = false, blocked = false, loading = false } = {}) {
  const attributes = {}, handlers = {}, mediaHandlers = {}, values = new Map();
  if (stored !== null) values.set('stopline.color-theme', stored);
  const selectHandlers = {}, select = { value: 'system', title: '', addEventListener(name, handler) { selectHandlers[name] = handler; } };
  const status = { textContent: '' }, meta = { content: '', setAttribute(_key, value) { this.content = value; } };
  const media = { matches: dark, addEventListener(name, handler) { mediaHandlers[name] = handler; } };
  const documentHandlers = {};
  const document = { readyState: loading ? 'loading' : 'complete', documentElement: { setAttribute(key, value) { attributes[key] = value; } },
    addEventListener(name, handler) { documentHandlers[name] = handler; },
    querySelector() { return meta; }, getElementById(id) { return id === 'color-theme' ? select : status; } };
  const storage = { getItem(key) { if (blocked) throw Error('blocked'); return values.get(key) ?? null; },
    setItem(key, value) { if (blocked) throw Error('blocked'); values.set(key, value); },
    removeItem(key) { if (blocked) throw Error('blocked'); values.delete(key); } };
  const window = { localStorage: storage, matchMedia() { return media; }, addEventListener(name, handler) { handlers[name] = handler; } };
  vm.runInNewContext(source, { window, document });
  return { attributes, select, status, meta, values,
    ready() { documentHandlers.DOMContentLoaded(); },
    choose(value) { select.value = value; selectHandlers.change(); },
    system(value) { media.matches = value; mediaHandlers.change(); },
    storage(value, key = 'stopline.color-theme') { handlers.storage({ key, newValue: value }); } };
}

test('system default resolves before controls bind and follows live OS changes', () => {
  const page = browser({ dark: true });
  assert.equal(page.attributes['data-theme'], 'dark'); assert.equal(page.select.value, 'system');
  assert.equal(page.meta.content, '#101322');
  page.system(false); assert.equal(page.attributes['data-theme'], 'light');
  assert.match(page.status.textContent, /System theme, currently light/);
});
test('explicit light and dark choices persist across reloads and override OS changes', () => {
  const page = browser({ dark: true }); page.choose('light');
  assert.equal(page.values.get('stopline.color-theme'), 'light');
  page.system(true); assert.equal(page.attributes['data-theme'], 'light');
  const reload = browser({ stored: page.values.get('stopline.color-theme'), dark: true });
  assert.equal(reload.attributes['data-theme'], 'light'); assert.equal(reload.select.value, 'light');
  reload.choose('dark'); assert.equal(reload.values.get('stopline.color-theme'), 'dark');
  reload.system(false); assert.equal(reload.attributes['data-theme'], 'dark');
});
test('returning to System clears the explicit override and resumes following OS', () => {
  const page = browser({ stored: 'dark', dark: false }); page.choose('system');
  assert.equal(page.values.has('stopline.color-theme'), false);
  assert.equal(page.attributes['data-theme'], 'light');
  page.system(true); assert.equal(page.attributes['data-theme'], 'dark');
});
test('invalid stored values and unavailable storage never break the application', () => {
  assert.equal(browser({ stored: '<script>', dark: true }).attributes['data-theme'], 'dark');
  const page = browser({ blocked: true }); page.choose('dark');
  assert.equal(page.attributes['data-theme'], 'dark');
  assert.match(page.status.textContent, /cannot be saved/);
});
test('theme changes synchronize across tabs without reacting to unrelated storage', () => {
  const page = browser({ stored: 'light', dark: true });
  page.storage('dark', 'other-key'); assert.equal(page.attributes['data-theme'], 'light');
  page.storage('dark'); assert.equal(page.attributes['data-theme'], 'dark'); assert.equal(page.select.value, 'dark');
  page.storage(null); assert.equal(page.attributes['data-theme'], 'dark'); assert.equal(page.select.value, 'system');
});
test('saved theme applies in the head before controls exist, then binds after parsing', () => {
  const page = browser({ stored: 'dark', dark: false, loading: true });
  assert.equal(page.attributes['data-theme'], 'dark');
  assert.equal(page.meta.content, '#101322');
  assert.equal(page.select.value, 'system');
  page.ready(); assert.equal(page.select.value, 'dark');
  page.choose('light'); assert.equal(page.attributes['data-theme'], 'light');
});
test('semantic normal and status text palettes meet 4.5:1 contrast in both themes', async () => {
  const css = await readFile(new URL('./themes.css', import.meta.url), 'utf8');
  const luminance = color => {
    const hex = color.length === 4 ? color.slice(1).split('').map(c => c + c).join('') : color.slice(1);
    const rgb = hex.match(/../g).map(c => parseInt(c, 16) / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
    return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
  };
  const palettes = [...css.matchAll(/:root(?:\[data-theme="dark"\])?\{([^}]+)\}/g)];
  assert.equal(palettes.length, 2);
  for (const [index, palette] of palettes.entries()) {
    const tokens = Object.fromEntries([...palette[1].matchAll(/--([\w-]+):(#\w+)/g)].map(match => [match[1], match[2]]));
    for (const [foreground, background] of [['ink','white'], ['muted','paper'], ['muted','white'],
      ['indigo','paper'], ['teal','paper'], ['warning','paper'], ['danger','paper'],
      ['primary-ink','indigo'], ['console-muted','console']]) {
      const values = [luminance(tokens[foreground]), luminance(tokens[background])];
      const ratio = (Math.max(...values) + .05) / (Math.min(...values) + .05);
      assert.ok(ratio >= 4.5, `${index ? 'dark' : 'light'} ${foreground}/${background}: ${ratio.toFixed(2)}`);
    }
  }
});
