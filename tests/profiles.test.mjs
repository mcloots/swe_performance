import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProfile, phaseAt } from '../k6/profiles.js';

test('load preserves the original constant request-rate configuration', () => {
  const p = buildProfile({ RATE: '50', DURATION: '15s' });
  assert.equal(p.type, 'load');
  assert.equal(p.scenario.executor, 'constant-arrival-rate');
  assert.equal(p.scenario.rate, 50);
  assert.equal(p.scenario.duration, '15s');
  assert.equal(phaseAt(p, 1000), 'steady');
});

test('soak uses sustained normal load and defaults to hours', () => {
  const p = buildProfile({ TEST_TYPE: 'soak' });
  assert.equal(p.scenario.duration, '2h');
  assert.equal(p.scenario.rate, buildProfile().scenario.rate);
  assert.equal(buildProfile({ TEST_TYPE: 'soak', DURATION: '2m' }).scenario.duration, '2m');
});

test('stress gradually reaches above-normal traffic and returns to the original rate', () => {
  const p = buildProfile({ TEST_TYPE: 'stress', RATE: '10', STRESS_RATE: '80' });
  assert.equal(p.scenario.startRate, 10);
  assert.equal(p.phases[1].durationMs, 60000);
  assert.equal(p.phases[2].target, 80);
  assert.equal(p.phases.at(-1).target, 10);
  assert.equal(p.phases.at(-1).endMs, 280000);
  assert.equal(phaseAt(p, 29999), 'baseline');
  assert.equal(phaseAt(p, 30000), 'ramp_up');
  assert.equal(phaseAt(p, 90000), 'high');
  assert.equal(phaseAt(p, 220000), 'recovery');
});

test('spike changes quickly, holds briefly and observes recovery', () => {
  const p = buildProfile({ TEST_TYPE: 'spike' });
  assert.equal(p.phases[1].durationMs, 1000);
  assert.equal(p.phases[2].durationMs, 20000);
  assert.equal(p.phases[2].target, 200);
  assert.equal(p.phases[3].durationMs, 1000);
  assert.equal(p.phases.at(-1).durationMs, 60000);
  assert.equal(p.phases.at(-1).endMs, 112000);
});

test('short verification scales time but preserves rates and phase boundaries', () => {
  const p = buildProfile({ TEST_TYPE: 'spike', TIME_SCALE: '0.1' });
  assert.equal(p.phases.at(-1).endMs, 11200);
  assert.equal(p.phases[2].target, 200);
  assert.equal(phaseAt(p, 5199), 'ramp_down');
  assert.equal(phaseAt(p, 5200), 'recovery');
});

test('configuration errors cannot silently select a different workload', () => {
  for (const env of [
    { TEST_TYPE: 'typo' }, { RATE: '-1' }, { PRE_ALLOCATED_VUS: '30', MAX_VUS: '20' },
    { TEST_TYPE: 'stress', STRESS_RATE: '10' }, { TEST_TYPE: 'spike', TIME_SCALE: '0' },
    { TEST_TYPE: 'stress', DURATION: '5s' }, { TEST_TYPE: 'soak', TIME_SCALE: '0.1' },
  ]) assert.throws(() => buildProfile(env));
});
