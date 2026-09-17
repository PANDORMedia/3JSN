/** Publish completed assertions consistently; failures retain the observations gathered so far. */
export async function runFixture(fixture, run) {
  const checks = [];
  function check(name, passed, observed) {
    checks.push({ name, passed, ...(observed === undefined ? {} : { observed }) });
    if (!passed) throw new Error(`Reference check failed: ${name}`);
  }
  try {
    const environment = await run(check);
    globalThis.__3jsnFixtureResult = { schemaVersion: 1, fixture, status: 'passed', environment, checks };
  } catch (error) {
    globalThis.__3jsnFixtureResult = { schemaVersion: 1, fixture, status: 'failed', checks, error: error.message };
  }
  document.documentElement.dataset.fixtureStatus = globalThis.__3jsnFixtureResult.status;
  document.getElementById('result').textContent = JSON.stringify(globalThis.__3jsnFixtureResult, null, 2);
}

export function withTimeout(promise, name, milliseconds = 5000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${name} timed out`)), milliseconds); })]).finally(() => clearTimeout(timer));
}
