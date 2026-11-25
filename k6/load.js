import http from 'k6/http';
import { check } from 'k6';
import { Rate } from 'k6/metrics';
import exec from 'k6/execution';
import { buildProfile, phaseAt } from './profiles.js';

function integer(name, fallback, min = 1, max = 100000) {
  const value = Number(__ENV[name] || fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}
const base = (__ENV.BASE_URL || 'http://api:53120').replace(/\/$/, '');
const target = __ENV.TARGET || 'read';
const mode = __ENV.CACHE || 'none';
const language = __ENV.LANGUAGE || 'nl';
const pageCount = integer('PAGES', 1, 1, 100);
const size = integer('PAGE_SIZE', 20, 1, 100);
const profile = buildProfile(__ENV);
if (!['read', 'write', 'mixed'].includes(target)) throw new Error('TARGET=read|write|mixed');
if (!['none', 'memory'].includes(mode)) throw new Error('CACHE=none|memory');
if (!['nl', 'fr', 'de'].includes(language)) throw new Error('LANGUAGE=nl|fr|de');
if (target !== 'read' && __ENV.ALLOW_WRITES !== 'true') throw new Error('Set ALLOW_WRITES=true for writes');
const runId = __ENV.RUN_ID || String(Date.now());
const failed = new Rate('failed_responses');
const hits = new Rate('cache_hits');

export const options = {
  scenarios: { api: profile.scenario },
  summaryTrendStats: ['med', 'p(95)', 'p(99)', 'max'],
  thresholds: {
    http_req_failed: ['rate<0.01'],
    failed_responses: ['rate<0.01'],
    dropped_iterations: ['count==0'],
    'http_req_duration{operation:read}': [`p(95)<${__ENV.P95_MS || 500}`],
    ...(target === 'read' ? {} : { 'http_req_duration{operation:write}': [`p(95)<${__ENV.P95_MS || 500}`] }),
  },
};
// Do not create an unused read threshold on write-only runs.
if (target === 'write') delete options.thresholds['http_req_duration{operation:read}'];

// Keep baseline, peak and recovery visible instead of hiding them in one percentile.
// Empty thresholds materialize phase submetrics for reporting; global budgets still apply.
for (const phase of profile.phases) {
  options.thresholds[`http_req_duration{phase:${phase.name}}`] = [];
  options.thresholds[`failed_responses{phase:${phase.name}}`] = [];
}
if (profile.phases.length) {
  for (const operation of target === 'mixed' ? ['read', 'write'] : [target === 'write' ? 'write' : 'read']) {
    options.thresholds[`http_req_duration{phase:recovery,operation:${operation}}`] = [`p(95)<${__ENV.P95_MS || 500}`];
  }
  options.thresholds['failed_responses{phase:recovery}'] = ['rate<0.01'];
}

export default function () {
  const iteration = exec.scenario.iterationInTest;
  const write = target === 'write' || (target === 'mixed' && iteration % 10 === 0);
  const operation = write ? 'write' : 'read';
  const phase = phaseAt(profile, Date.now() - exec.scenario.startTime);
  const tags = { operation, phase, test_type: profile.type };
  const params = { redirects: 0, timeout: '10s', tags: { ...tags, name: `${operation} lessons` } };
  let response;
  let title;
  if (write) {
    title = `k6-${runId}-${iteration}`;
    params.headers = { 'Content-Type': 'application/json' };
    response = http.post(`${base}/api/lessons`, JSON.stringify({ language, title, content: 'Synthetic load test record.' }), params);
  } else {
    const page = iteration % pageCount + 1;
    response = http.get(`${base}/api/lessons?language=${language}&page=${page}&pageSize=${size}&cache=${mode}`, params);
  }
  let data = null;
  try { data = response.json(); } catch (_) { /* A malformed body is a failed contract. */ }
  let valid;
  if (write) {
    valid = check(response, {
      'write: 201': r => r.status === 201,
      'write: saved record contract': () => Number.isInteger(data?.id) && data.id > 0 && data.language === language
        && data.title === title && data.content === 'Synthetic load test record.' && Number.isFinite(Date.parse(data.createdAt)),
      'write: Location': r => r.headers.Location === `/api/lessons/${data?.id}`,
    });
  } else {
    valid = check(response, {
      'read: 200': r => r.status === 200,
      'read: page contract': () => data?.language === language && data?.page === iteration % pageCount + 1
        && data?.pageSize === size && Number.isInteger(data?.version) && data.version > 0
        && Array.isArray(data?.items) && data.items.length === size
        && data.items.every((item, index, items) => Number.isInteger(item.id) && item.language === language
          && typeof item.title === 'string' && item.title.length > 0 && typeof item.content === 'string'
          && Number.isFinite(Date.parse(item.createdAt)) && (index === 0 || items[index - 1].id > item.id)),
    });
    hits.add(response.headers['X-Cache'] === 'HIT', tags);
  }
  failed.add(!valid, tags);
}
