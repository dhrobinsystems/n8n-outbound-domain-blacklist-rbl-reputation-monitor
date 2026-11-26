'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../lib/core');

const BASE_ENV = {
  MONITORED_DOMAINS: 'send-1.outbound-pool.example',
  MONITORED_IPS: '192.0.2.10',
  CAMPAIGN_MAP: { 'send-1.outbound-pool.example': { smartlead: ['zzz_TEST_sl_1001'], instantly: ['zzz_TEST_inst_2001'] } }
};

test('parseBool falls back to the supplied safe default on garbage or empty input', () => {
  assert.equal(core.parseBool(undefined, true), true);
  assert.equal(core.parseBool('', true), true);
  assert.equal(core.parseBool('maybe', true), true);
  assert.equal(core.parseBool('false', true), false);
  assert.equal(core.parseBool('FALSE', true), false);
  assert.equal(core.parseBool('1', false), true);
});

test('config is dry-run by default', () => {
  const cfg = core.buildConfig(BASE_ENV);
  assert.equal(cfg.live, false);
  assert.equal(cfg.dryRun, true);
});

test('DRY_RUN=false alone does not go live (SANDBOX_MODE defaults to true)', () => {
  const cfg = core.buildConfig(Object.assign({}, BASE_ENV, { DRY_RUN: 'false' }));
  assert.equal(cfg.live, false);
});

test('SANDBOX_MODE=false alone does not go live', () => {
  const cfg = core.buildConfig(Object.assign({}, BASE_ENV, { SANDBOX_MODE: 'false' }));
  assert.equal(cfg.live, false);
});

test('live mode requires DRY_RUN=false and SANDBOX_MODE=false', () => {
  const cfg = core.buildConfig(Object.assign({}, BASE_ENV, { DRY_RUN: 'false', SANDBOX_MODE: 'false' }));
  assert.equal(cfg.live, true);
});

test('config fails loudly with no targets, bad campaign map JSON, or no zones', () => {
  assert.ok(core.buildConfig({}).fatal.length > 0);
  assert.ok(core.buildConfig({ MONITORED_DOMAINS: 'a.example', CAMPAIGN_MAP: '{nope' }).fatal.length > 0);
  assert.ok(core.buildConfig({ MONITORED_DOMAINS: 'a.example', RBL_ZONES: 'not a zone' }).fatal.length > 0);
});

test('invalid targets are skipped with warnings, valid ones kept', () => {
  const cfg = core.buildConfig({ MONITORED_DOMAINS: 'a.example,not_a_domain', MONITORED_IPS: '192.0.2.1,192.0.2.256,::1' });
  assert.deepEqual(cfg.targets.map((t) => t.value), ['a.example', '192.0.2.1']);
  assert.equal(cfg.warnings.filter((w) => /Skipped invalid/.test(w)).length, 3);
});

test('zone parsing supports aliases, types, defaults, and custom zones', () => {
  const p = core.parseZones('mylist=rbl.custom-zone.example:domain,other.example,zen.spamhaus.org:ip,bad zone!');
  assert.deepEqual(p.zones, [
    { label: 'mylist', zone: 'rbl.custom-zone.example', type: 'domain' },
    { label: 'other.example', zone: 'other.example', type: 'ip' },
    { label: 'zen.spamhaus.org', zone: 'zen.spamhaus.org', type: 'ip' }
  ].slice(0, 3));
  assert.ok(core.parseZones('').zones.length >= 4);
});

test('query names are built correctly and respect target kind', () => {
  const ipZone = { label: 'z', zone: 'zen.spamhaus.org', type: 'ip' };
  const domZone = { label: 'd', zone: 'dbl.spamhaus.org', type: 'domain' };
  assert.equal(core.buildQueryName({ value: '192.0.2.10', kind: 'ip' }, ipZone), '10.2.0.192.zen.spamhaus.org');
  assert.equal(core.buildQueryName({ value: 'send-1.outbound-pool.example', kind: 'domain' }, domZone), 'send-1.outbound-pool.example.dbl.spamhaus.org');
  assert.equal(core.buildQueryName({ value: '192.0.2.10', kind: 'ip' }, domZone), null);
});

test('answer classification only counts clean 127.x answers as listed', () => {
  assert.equal(core.classifyAnswer({ errorCode: 'ENOTFOUND' }).status, 'clean');
  assert.equal(core.classifyAnswer({ errorCode: 'ENODATA' }).status, 'clean');
  assert.equal(core.classifyAnswer({ errorCode: 'ETIMEOUT' }).status, 'error');
  assert.equal(core.classifyAnswer({ errorCode: 'ESERVFAIL' }).status, 'error');
  assert.equal(core.classifyAnswer({ errorCode: 'EREFUSED' }).status, 'error');
  assert.equal(core.classifyAnswer({ addresses: ['127.0.0.2'] }).status, 'listed');
  assert.equal(core.classifyAnswer({ addresses: ['127.255.255.254'] }).status, 'error');
  assert.equal(core.classifyAnswer({ addresses: ['127.255.255.252'] }).status, 'error');
  assert.equal(core.classifyAnswer({ addresses: ['127.0.0.2', '127.255.255.255'] }).status, 'error');
  assert.equal(core.classifyAnswer({ addresses: ['192.0.2.55'] }).status, 'error');
  assert.equal(core.classifyAnswer({ addresses: [] }).status, 'clean');
});

test('lookupAll turns a hung resolver into a timeout error, not a listing', async () => {
  const targets = [{ value: '192.0.2.10', kind: 'ip' }];
  const zones = [{ label: 'z', zone: 'zen.spamhaus.org', type: 'ip' }];
  const results = await core.lookupAll(targets, zones, () => new Promise(() => {}), { timeoutMs: 20 });
  assert.equal(results[0].status, 'error');
  assert.equal(results[0].reason, 'dns_ETIMEOUT');
});

test('lookupAll only pairs targets with zones of the same kind', async () => {
  const targets = [{ value: '192.0.2.10', kind: 'ip' }, { value: 'a.example', kind: 'domain' }];
  const zones = [
    { label: 'ipz', zone: 'ip.rbl.example', type: 'ip' },
    { label: 'domz', zone: 'dom.rbl.example', type: 'domain' }
  ];
  const seen = [];
  await core.lookupAll(targets, zones, async (name) => { seen.push(name); const e = new Error('x'); e.code = 'ENOTFOUND'; throw e; }, {});
  assert.deepEqual(seen.sort(), ['10.2.0.192.ip.rbl.example', 'a.example.dom.rbl.example'].sort());
});

test('verdicts: listed, warning, clean, clean_partial, unknown', () => {
  const cfg = core.buildConfig(Object.assign({}, BASE_ENV, { MIN_LISTED_ZONES: '2' }));
  const t = (v) => ({ value: v, kind: 'ip' });
  const r = (target, status) => ({ target, kind: 'ip', zone: 'z' + Math.random(), status, codes: status === 'listed' ? ['127.0.0.2'] : [], reason: status === 'error' ? 'dns_ETIMEOUT' : undefined });
  const targets = [t('192.0.2.1'), t('192.0.2.2'), t('192.0.2.3'), t('192.0.2.4'), t('192.0.2.5')];
  const results = [
    r('192.0.2.1', 'listed'), r('192.0.2.1', 'listed'),
    r('192.0.2.2', 'listed'), r('192.0.2.2', 'clean'),
    r('192.0.2.3', 'clean'), r('192.0.2.3', 'clean'),
    r('192.0.2.4', 'clean'), r('192.0.2.4', 'error'),
    r('192.0.2.5', 'error'), r('192.0.2.5', 'error')
  ];
  const v = core.evaluateTargets(targets, results, cfg).map((x) => x.verdict);
  assert.deepEqual(v, ['listed', 'warning', 'clean', 'clean_partial', 'unknown']);
});

test('planning dedupes campaigns across targets and honors platforms, primary domains, and prefix guard', () => {
  const env = {
    MONITORED_DOMAINS: 'send-1.outbound-pool.example,primary-brand.example',
    MONITORED_IPS: '192.0.2.10',
    PRIMARY_DOMAINS: 'primary-brand.example',
    CAMPAIGN_MAP: {
      'send-1.outbound-pool.example': { smartlead: ['zzz_TEST_sl_1001'], instantly: ['zzz_TEST_inst_2001'] },
      '192.0.2.10': { smartlead: ['zzz_TEST_sl_1001', 'other_sl_5'] },
      'primary-brand.example': { smartlead: ['zzz_TEST_sl_9001'] }
    }
  };
  const verdicts = (cfg) => cfg.targets.map((t) => ({ target: t.value, kind: t.kind, verdict: 'listed', listedZones: [{ zone: 'z', codes: ['127.0.0.2'] }], isPrimary: cfg.primaryDomains.indexOf(t.value) !== -1 }));

  let cfg = core.buildConfig(env);
  let plan = core.planActions(verdicts(cfg), cfg);
  assert.deepEqual(plan.actions.map((a) => a.platform + ':' + a.campaignId), [
    'smartlead:zzz_TEST_sl_1001', 'instantly:zzz_TEST_inst_2001', 'smartlead:other_sl_5'
  ]);
  assert.equal(plan.actions[0].reasons.length, 2);
  assert.ok(plan.notes.some((n) => n.note === 'primary_domain_alert_only'));

  cfg = core.buildConfig(Object.assign({}, env, { PAUSE_PLATFORMS: 'smartlead' }));
  plan = core.planActions(verdicts(cfg), cfg);
  assert.ok(plan.actions.every((a) => a.platform === 'smartlead'));

  cfg = core.buildConfig(Object.assign({}, env, { PAUSE_ID_PREFIX_ALLOW: 'zzz_TEST_' }));
  plan = core.planActions(verdicts(cfg), cfg);
  assert.ok(plan.actions.every((a) => a.campaignId.indexOf('zzz_TEST_') === 0));
  assert.ok(plan.notes.some((n) => n.note === 'skipped_by_prefix_guard'));
});

test('listed targets with no mapped campaigns produce a note, not an error', () => {
  const cfg = core.buildConfig({ MONITORED_DOMAINS: 'send-1.outbound-pool.example' });
  const plan = core.planActions([{ target: 'send-1.outbound-pool.example', kind: 'domain', verdict: 'listed', listedZones: [], isPrimary: false }], cfg);
  assert.equal(plan.actions.length, 0);
  assert.equal(plan.notes[0].note, 'no_campaigns_mapped');
});

test('dry run never calls http', async () => {
  const cfg = core.buildConfig(BASE_ENV);
  let calls = 0;
  const out = await core.executePauses(
    [{ platform: 'smartlead', campaignId: 'zzz_TEST_sl_1001', reasons: [] }],
    cfg,
    { env: {}, http: async () => { calls++; return { statusCode: 200 }; }, sleep: async () => {} }
  );
  assert.equal(calls, 0);
  assert.equal(out[0].status, 'dry_run');
});

test('live mode retries 429 and 5xx with exponential backoff, and does not retry other 4xx', async () => {
  const env = Object.assign({}, BASE_ENV, { DRY_RUN: 'false', SANDBOX_MODE: 'false', HTTP_RETRY_BASE_MS: '10', SMARTLEAD_API_KEY: 'zzz_TEST_key_1234', INSTANTLY_API_KEY: 'zzz_TEST_key_5678' });
  const cfg = core.buildConfig(env);
  const sleeps = [];
  const codes = { sl_a: [429, 500, 200], sl_b: [401] };
  const counts = { sl_a: 0, sl_b: 0 };
  const http = async (req) => {
    const id = /campaigns\/([^/]+)\//.exec(req.url)[1];
    const c = codes[id][Math.min(counts[id]++, codes[id].length - 1)];
    return { statusCode: c, body: c >= 400 ? { message: 'err' } : {} };
  };
  const out = await core.executePauses(
    [{ platform: 'smartlead', campaignId: 'sl_a', reasons: [] }, { platform: 'smartlead', campaignId: 'sl_b', reasons: [] }],
    cfg,
    { env, http, sleep: async (ms) => sleeps.push(ms) }
  );
  assert.equal(out[0].status, 'paused');
  assert.equal(out[0].attempts, 3);
  assert.deepEqual(sleeps, [10, 20]);
  assert.equal(out[1].status, 'failed');
  assert.equal(out[1].attempts, 1);
});

test('secrets are redacted from failure details', async () => {
  const key = 'zzz_TEST_key_1234';
  const env = Object.assign({}, BASE_ENV, { DRY_RUN: 'false', SANDBOX_MODE: 'false', HTTP_RETRY_BASE_MS: '0', SMARTLEAD_API_KEY: key });
  const cfg = core.buildConfig(env);
  const http = async () => { throw new Error('connect failed for ?api_key=' + key); };
  const out = await core.executePauses([{ platform: 'smartlead', campaignId: 'sl_a', reasons: [] }], cfg, { env, http, sleep: async () => {} });
  assert.equal(out[0].status, 'failed');
  assert.ok(!JSON.stringify(out).includes(key));
  assert.ok(out[0].detail.includes('[REDACTED]'));
});

test('missing credentials skip the pause instead of calling the API', async () => {
  const env = Object.assign({}, BASE_ENV, { DRY_RUN: 'false', SANDBOX_MODE: 'false' });
  const cfg = core.buildConfig(env);
  let calls = 0;
  const out = await core.executePauses([{ platform: 'instantly', campaignId: 'inst_a', reasons: [] }], cfg, { env, http: async () => { calls++; return { statusCode: 200 }; }, sleep: async () => {} });
  assert.equal(calls, 0);
  assert.equal(out[0].status, 'skipped_missing_credentials');
});

test('circuit breaker blocks all pauses when the plan exceeds MAX_PAUSES_PER_RUN, even in dry-run', async () => {
  const cfg = core.buildConfig(Object.assign({}, BASE_ENV, { MAX_PAUSES_PER_RUN: '1' }));
  const actions = [
    { platform: 'smartlead', campaignId: 'a1', reasons: [] },
    { platform: 'smartlead', campaignId: 'a2', reasons: [] }
  ];
  const out = await core.executePauses(actions, cfg, { env: {}, http: async () => ({ statusCode: 200 }), sleep: async () => {} });
  assert.ok(out.every((a) => a.status === 'blocked_circuit_breaker'));
});

test('pause requests target the expected endpoints and encode campaign ids', () => {
  const cfg = core.buildConfig(BASE_ENV);
  const sl = core.buildPauseRequest({ platform: 'smartlead', campaignId: 'zzz_TEST_sl_1001' }, cfg, { SMARTLEAD_API_KEY: 'k' });
  assert.equal(sl.url, 'https://server.smartlead.ai/api/v1/campaigns/zzz_TEST_sl_1001/status');
  assert.deepEqual(sl.body, { status: 'PAUSED' });
  const ins = core.buildPauseRequest({ platform: 'instantly', campaignId: 'zzz_TEST_inst_2001' }, cfg, { INSTANTLY_API_KEY: 'k' });
  assert.equal(ins.url, 'https://api.instantly.ai/api/v2/campaigns/zzz_TEST_inst_2001/pause');
  assert.equal(ins.headers.Authorization, 'Bearer k');
});

test('non-https base URL overrides are rejected with a warning', () => {
  const cfg = core.buildConfig(Object.assign({}, BASE_ENV, { SMARTLEAD_BASE_URL: 'http://insecure.example' }));
  assert.equal(cfg.smartleadBaseUrl, 'https://server.smartlead.ai');
  assert.ok(cfg.warnings.some((w) => /SMARTLEAD_BASE_URL/.test(w)));
});
