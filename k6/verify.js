import http from 'k6/http';
import { check, sleep } from 'k6';

// Negative contract cases deliberately expect 400/404; checks still assert exact statuses.
http.setResponseCallback(http.expectedStatuses(200, 201, 400, 404));

export const options = { vus: 1, iterations: 1, thresholds: { checks: ['rate==1'] } };
const base = __ENV.BASE_URL || 'http://api:53120';
const second = __ENV.SECOND_URL;
const payload = title => JSON.stringify({ language: 'nl', title, content: 'Verification fixture.' });
const create = title => http.post(`${base}/api/lessons`, payload(title), { headers: { 'Content-Type': 'application/json' } });
const read = (mode, language = 'nl', page = 1, host = base) =>
  http.get(`${host}/api/lessons?cache=${mode}&language=${language}&page=${page}&pageSize=2`);

export function setup() {
  // Wait for database readiness on each API before exercising its contracts.
  for (const host of [base, ...(second ? [second] : [])]) {
    let ready = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      const r = http.get(`${host}/api/health`);
      if (r.status === 200) { ready = true; break; }
      sleep(0.5);
    }
    if (!ready) throw new Error(`API/database not ready: ${host}`);
  }
}

export default function () {
  check(http.get(`${base}/api/health`), { 'database ready': r => r.status === 200 });
  const first = create(`verify-before-${Date.now()}`);
  check(first, { 'create 201': r => r.status === 201 });
  const saved = first.json();
  check(http.get(`${base}${first.headers.Location}`), {
    'created row readable': r => r.status === 200 && r.json().id === saved.id && r.json().title === saved.title,
  });
  const prior = {};
  for (const mode of ['none', 'memory']) {
    const cold = read(mode);
    check(cold, {
      [`${mode}: cold status`]: r => r.status === 200 && r.headers['X-Cache'] === (mode === 'none' ? 'BYPASS' : 'MISS'),
      [`${mode}: latest row`]: r => r.json().items[0].id === saved.id,
      [`${mode}: no browser response caching`]: r => r.headers['Cache-Control'] === 'no-store',
    });
    const hot = read(mode);
    check(hot, { [`${mode}: warm status`]: r => r.headers['X-Cache'] === (mode === 'none' ? 'BYPASS' : 'HIT') });
    prior[mode] = hot.json().version;
    const french = read(mode, 'fr');
    check(french, { [`${mode}: separate language`]: r => r.status === 200 && r.json().items.every(x => x.language === 'fr') });
    check(read(mode, 'nl', 2), { [`${mode}: separate page`]: r => r.json().items[0].id !== saved.id });
  }
  if (second) {
    // The earlier POST gave both API copies a fresh generation.
    check(read('memory', 'nl', 1, second), { 'second API has own memory': r => r.headers['X-Cache'] === 'MISS' });
    check(read('memory', 'nl', 1, second), { 'second API warms its own memory': r => r.headers['X-Cache'] === 'HIT' });
  }
  const after = create(`verify-after-${Date.now()}`).json();
  for (const mode of ['memory']) {
    check(read(mode), {
      [`${mode}: POST invalidates list`]: r => r.json().version > prior[mode] && r.json().items[0].id === after.id
        && r.headers['X-Cache'] === 'MISS',
    });
    if (second) check(read(mode, 'nl', 1, second), {
      [`${mode}: POST visible on second API`]: r => r.json().items[0].id === after.id,
    });
  }
  check(http.get(`${base}/api/lessons?language=xx`), { 'invalid language 400': r => r.status === 400 });
  check(http.get(`${base}/api/lessons?pageSize=101`), { 'bounded page size 400': r => r.status === 400 });
  check(http.get(`${base}/api/lessons/0`), { 'unknown record 404': r => r.status === 404 });
  check(http.post(`${base}/api/lessons`, payload(''), { headers: { 'Content-Type': 'application/json' } }), {
    'invalid write 400': r => r.status === 400,
  });
  check(http.get(`${base}/app.v1.js`), {
    'versioned JS browser cache': r => r.status === 200 && r.headers['Cache-Control'].includes('immutable'),
  });
  if (__ENV.CHECK_TTL === 'true') {
    sleep(Number(__ENV.TTL_WAIT_SECONDS || 31));
    for (const mode of ['memory']) check(read(mode), {
      [`${mode}: expires`]: r => r.headers['X-Cache'] === 'MISS',
    });
  }
}
