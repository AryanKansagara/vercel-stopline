/* Early, same-origin theme bootstrap. No inline styles/scripts or stream state. */
(() => {
  const key = 'stopline.color-theme';
  const valid = value => ['system', 'light', 'dark'].includes(value) ? value : 'system';
  let preference = 'system';
  let saveUnavailable = false;
  try { preference = valid(window.localStorage.getItem(key)); } catch { saveUnavailable = true; }
  let system;
  try { system = window.matchMedia('(prefers-color-scheme: dark)'); } catch { system = { matches: false }; }
  let select, status;
  function apply() {
    const resolved = preference === 'system' ? system.matches ? 'dark' : 'light' : preference;
    document.documentElement.setAttribute('data-theme', resolved);
    document.documentElement.setAttribute('data-theme-preference', preference);
    const color = document.querySelector('meta[name="theme-color"]');
    if (color) color.setAttribute('content', resolved === 'dark' ? '#101322' : '#f5f6fb');
    if (select) {
      select.value = preference;
      select.title = `Color theme: ${preference}${preference === 'system' ? ` (${resolved})` : ''}${saveUnavailable ? '. Preference cannot be saved in this browser.' : ''}`;
    }
    if (status) status.textContent = `${preference === 'system' ? 'System theme, currently ' : 'Theme: '}${resolved}.${saveUnavailable ? ' Preference cannot be saved in this browser.' : ''}`;
  }
  apply();
  function bind() {
    select = document.getElementById('color-theme');
    status = document.getElementById('theme-status');
    if (select) select.addEventListener('change', () => {
      preference = valid(select.value);
      try {
        if (preference === 'system') window.localStorage.removeItem(key);
        else window.localStorage.setItem(key, preference);
        saveUnavailable = false;
      } catch { saveUnavailable = true; }
      apply();
    });
    apply();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true });
  else bind();
  const followSystem = () => { if (preference === 'system') apply(); };
  if (system.addEventListener) system.addEventListener('change', followSystem);
  else if (system.addListener) system.addListener(followSystem);
  window.addEventListener('storage', event => {
    if (event.key === key || event.key === null) { preference = valid(event.newValue); apply(); }
  });
})();
