// Workload configuration stays separate from the shared GET/POST iteration.
export function buildProfile(env = {}) {
  const type = env.TEST_TYPE || 'load';
  if (!['load', 'stress', 'spike', 'soak'].includes(type)) {
    throw new Error('TEST_TYPE=load|stress|spike|soak');
  }
  function integer(name, fallback) {
    const value = Number(env[name] || fallback);
    if (!Number.isInteger(value) || value < 1 || value > 100000) throw new Error(`Invalid ${name}`);
    return value;
  }
  const rate = integer('RATE', 20);
  const allocated = integer('PRE_ALLOCATED_VUS', 20);
  const maximum = integer('MAX_VUS', 100);
  if (maximum < allocated) throw new Error('MAX_VUS must be >= PRE_ALLOCATED_VUS');
  const common = { timeUnit: '1s', preAllocatedVUs: allocated, maxVUs: maximum, gracefulStop: '15s' };
  if (type === 'load' || type === 'soak') {
    if (env.TIME_SCALE) throw new Error('Use DURATION for load/soak; TIME_SCALE is for stress/spike');
    return {
      type, phases: [],
      scenario: { ...common, executor: 'constant-arrival-rate', rate,
        duration: env.DURATION || (type === 'soak' ? '2h' : '60s') },
    };
  }
  if (env.DURATION) throw new Error('Use TIME_SCALE for stress/spike; DURATION is for load/soak');
  const scale = Number(env.TIME_SCALE || 1);
  if (!Number.isFinite(scale) || scale < 0.01 || scale > 10) throw new Error('TIME_SCALE must be 0.01..10');
  const peak = type === 'stress' ? integer('STRESS_RATE', rate * 5) : integer('SPIKE_RATE', rate * 10);
  if (peak <= rate) throw new Error('Peak rate must exceed RATE');
  const definitions = type === 'stress'
    ? [['baseline', 30, rate], ['ramp_up', 60, peak], ['high', 120, peak], ['ramp_down', 10, rate], ['recovery', 60, rate]]
    : [['baseline', 30, rate], ['ramp_up', 1, peak], ['high', 20, peak], ['ramp_down', 1, rate], ['recovery', 60, rate]];
  let endMs = 0;
  const phases = definitions.map(([name, seconds, target]) => {
    const durationMs = Math.round(seconds * scale * 1000);
    endMs += durationMs;
    return { name, durationMs, endMs, target };
  });
  return {
    type, phases,
    scenario: { ...common, executor: 'ramping-arrival-rate', startRate: rate,
      stages: phases.map(p => ({ duration: `${p.durationMs}ms`, target: p.target })) },
  };
}

export function phaseAt(profile, elapsedMs) {
  return profile.phases.find(p => elapsedMs < p.endMs)?.name
    || (profile.phases.length ? 'recovery' : 'steady');
}
