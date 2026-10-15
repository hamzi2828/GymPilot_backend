// Putting a gym's host on the website's Vercel project (platform/vercelDomains.js),
// with fetch stood in for: the request it makes (endpoint, team, token, body),
// a host already on the project, a refusal, a TXT verification Vercel wants,
// and doing nothing at all -- no request -- while the env vars are unset.

const test = require('node:test');
const assert = require('node:assert/strict');
const vercel = require('../../src/platform/vercelDomains');

const realFetch = global.fetch;
const ENV = ['VERCEL_TOKEN', 'VERCEL_PROJECT_ID', 'VERCEL_TEAM_ID'];

function withVercel(env, responses, fn) {
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  const requests = [];
  global.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request ${init.method} ${url}`);
    return { ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => next.body };
  };
  return Promise.resolve(fn(requests)).finally(() => {
    global.fetch = realFetch;
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

const CONNECTED = { VERCEL_TOKEN: 'tok_test', VERCEL_PROJECT_ID: 'gympilot-demo', VERCEL_TEAM_ID: 'team_abc' };

test('unset: nothing is requested, and the result says why', () =>
  withVercel({}, [], async (requests) => {
    assert.equal(vercel.configured(), false);
    const result = await vercel.addDomain('ironworks.gymspilotpro.com');
    assert.equal(result.added, false);
    assert.match(result.skipped, /VERCEL_TOKEN/);
    assert.equal(requests.length, 0);
  }));

test('a platform subdomain is POSTed to the project, under the team, with the token', () =>
  withVercel(CONNECTED, [{ status: 200, body: { name: 'ironworks.gymspilotpro.com', verified: true } }], async (requests) => {
    const result = await vercel.addDomain('IronWorks.gymspilotpro.com');
    assert.deepEqual(
      { added: result.added, verified: result.verified, host: result.host, www: result.www },
      { added: true, verified: true, host: 'ironworks.gymspilotpro.com', www: undefined }
    );
    assert.equal(requests.length, 1, 'a subdomain has no www twin');
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].url, 'https://api.vercel.com/v10/projects/gympilot-demo/domains?teamId=team_abc');
    assert.equal(requests[0].headers.Authorization, 'Bearer tok_test');
    assert.deepEqual(requests[0].body, { name: 'ironworks.gymspilotpro.com' });
  }));

test('a host already on the project is read back, not an error', () =>
  withVercel(
    CONNECTED,
    [
      { status: 409, body: { error: { code: 'domain_already_in_use', message: 'in use' } } },
      { status: 200, body: { name: 'ironworks.gymspilotpro.com', verified: true } }
    ],
    async (requests) => {
      const result = await vercel.addDomain('ironworks.gymspilotpro.com');
      assert.equal(result.added, true);
      assert.equal(requests[1].method, 'GET');
      assert.equal(requests[1].url, 'https://api.vercel.com/v9/projects/gympilot-demo/domains/ironworks.gymspilotpro.com?teamId=team_abc');
    }
  ));

test('a TXT record Vercel wants first is passed on', () =>
  withVercel(
    { ...CONNECTED, VERCEL_TEAM_ID: undefined },
    [{ status: 200, body: { verified: false, verification: [{ type: 'TXT', domain: '_vercel.gymspilotpro.com', value: 'vc-domain-verify=x', reason: 'pending' }] } }],
    async (requests) => {
      const result = await vercel.addDomain('ironworks.gymspilotpro.com');
      assert.equal(result.verified, false);
      assert.deepEqual(result.verification, [{ type: 'TXT', domain: '_vercel.gymspilotpro.com', value: 'vc-domain-verify=x' }]);
      assert.ok(!requests[0].url.includes('teamId'), 'no team, no teamId');
    }
  ));

test('a refusal or a network failure resolves with the reason, never throws', async () => {
  await withVercel(CONNECTED, [{ status: 403, body: { error: { code: 'forbidden', message: 'Not authorized' } } }], async () => {
    const result = await vercel.addDomain('ironworks.gymspilotpro.com');
    assert.equal(result.added, false);
    assert.equal(result.error, 'Not authorized');
    assert.equal(result.dns.type, 'CNAME');
  });
  await withVercel(CONNECTED, [], async () => {
    const result = await vercel.addDomain('ironworks.gymspilotpro.com');
    assert.equal(result.added, false);
    assert.match(result.error, /unexpected request/);
  });
});

test('removing a host DELETEs it; one already gone counts as removed', () =>
  withVercel(CONNECTED, [{ status: 404, body: {} }], async (requests) => {
    const result = await vercel.removeDomain('ironworks.gymspilotpro.com');
    assert.equal(result.removed, true);
    assert.equal(requests[0].method, 'DELETE');
  }));
