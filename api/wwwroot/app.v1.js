const $ = id => document.getElementById(id);
const pages = new Map();
let busy = false;
function setBusy(value) {
  busy = value;
  for (const id of ['load', 'refresh', 'submit', 'language', 'mode', 'local']) $(id).disabled = value;
}
async function load(force = false) {
  const url = `/api/lessons?language=${$('language').value}&page=1&pageSize=20&cache=${$('mode').value}`;
  const existing = pages.get(url);
  let data;
  if (!force && $('local').checked && existing && existing.expires > Date.now()) {
    data = existing.data;
    $('status').textContent = 'Frontend data cache HIT: no API request';
  } else {
    $('status').textContent = 'Loading…';
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Read failed: ${response.status}`);
    data = await response.json();
    pages.set(url, { data, expires: Date.now() + 10000 });
    $('status').textContent = `API ${response.headers.get('X-Cache')}, version ${data.version}, instance ${response.headers.get('X-Instance')}`;
  }
  $('lessons').replaceChildren(...data.items.map(item => {
    const li = document.createElement('li');
    li.textContent = `${item.id}: ${item.title} (${item.language})`;
    return li;
  }));
}
async function action(fn) {
  if (busy) return;
  setBusy(true);
  try { await fn(); } catch (error) { $('status').textContent = error.message; }
  finally { setBusy(false); }
}
$('load').onclick = () => action(() => load());
$('refresh').onclick = () => action(() => load(true));
$('language').onchange = $('mode').onchange = () => action(() => load());
$('create').onsubmit = event => {
  event.preventDefault();
  action(async () => {
    $('status').textContent = 'Saving…';
    const response = await fetch('/api/lessons', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language: $('language').value, title: $('title').value, content: 'Synthetic browser record.' }),
    });
    if (!response.ok) throw new Error(`Save failed (${response.status}); draft retained. Check stored records before retrying.`);
    pages.clear();
    $('title').value = '';
    await load(true);
  });
};
action(() => load());
