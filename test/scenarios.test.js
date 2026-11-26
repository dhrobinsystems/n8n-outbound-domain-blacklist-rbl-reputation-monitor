'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { simulate, listScenarios } = require('../mirror-cli');
const { render } = require('../scripts/build-workflow');

const ROOT = path.join(__dirname, '..');
const SCENARIO_DIR = path.join(ROOT, 'fixtures', 'scenarios');

// ---------------------------------------------------------------------------
// Scenario fixtures
// ---------------------------------------------------------------------------

listScenarios().forEach((file) => {
  test('scenario: ' + file, async () => {
    const scenario = JSON.parse(fs.readFileSync(path.join(SCENARIO_DIR, file), 'utf8'));
    const { report, httpCalls } = await simulate(scenario);
    const expect = scenario.expect;

    assert.equal(report.mode, expect.mode);

    const verdicts = {};
    report.verdicts.forEach((v) => { verdicts[v.target] = v.verdict; });
    assert.deepEqual(verdicts, expect.verdicts);

    const actions = {};
    report.actions.forEach((a) => { actions[a.platform + ':' + a.campaignId] = a.status; });
    assert.deepEqual(actions, expect.actions);

    if (expect.attempts) {
      Object.keys(expect.attempts).forEach((k) => {
        const a = report.actions.find((x) => x.platform + ':' + x.campaignId === k);
        assert.equal(a.attempts, expect.attempts[k], 'attempts for ' + k);
      });
    }
    if (typeof expect.httpCalls === 'number') assert.equal(httpCalls.length, expect.httpCalls);
    if (expect.noteCodes) assert.deepEqual(report.notes.map((n) => n.note), expect.noteCodes);
    if (expect.summary) {
      Object.keys(expect.summary).forEach((k) => assert.equal(report.summary[k], expect.summary[k], 'summary.' + k));
    }

    // Audit output must never contain credentials.
    const serialized = JSON.stringify(report);
    Object.keys(scenario.env || {}).forEach((k) => {
      if (/API_KEY/.test(k)) assert.ok(!serialized.includes(scenario.env[k]), k + ' leaked into the report');
    });
  });
});

// ---------------------------------------------------------------------------
// workflow.json
// ---------------------------------------------------------------------------

test('workflow.json is in sync with lib/core.js (run npm run build if this fails)', () => {
  const current = fs.readFileSync(path.join(ROOT, 'workflow.json'), 'utf8');
  assert.equal(current, render());
});

test('workflow.json structure: 6 hour schedule, valid connections, no credentials or instance metadata', () => {
  const wf = JSON.parse(fs.readFileSync(path.join(ROOT, 'workflow.json'), 'utf8'));
  const schedule = wf.nodes.find((n) => n.type === 'n8n-nodes-base.scheduleTrigger');
  assert.deepEqual(schedule.parameters.rule.interval, [{ field: 'hours', hoursInterval: 6 }]);
  assert.equal(wf.active, false);

  const names = new Set(wf.nodes.map((n) => n.name));
  Object.keys(wf.connections).forEach((from) => {
    assert.ok(names.has(from), 'unknown source node ' + from);
    wf.connections[from].main.forEach((branch) => branch.forEach((c) => assert.ok(names.has(c.node), 'unknown target ' + c.node)));
  });

  const raw = JSON.stringify(wf);
  assert.ok(!/"credentials"/.test(raw));
  assert.ok(!/instanceId|webhookId/.test(raw));

  wf.nodes.filter((n) => n.type === 'n8n-nodes-base.code').forEach((n) => {
    assert.doesNotThrow(() => new Function('$env', '$input', 'require', 'return (async function(){' + n.parameters.jsCode + '\n}).call(this)'), n.name + ' must be syntactically valid');
  });
});

// ---------------------------------------------------------------------------
// Repository hygiene: only synthetic data may be committed
// ---------------------------------------------------------------------------

function walk(dir, out) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    if (['node_modules', '.git', 'out', '.state'].includes(e.name)) return;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  });
  return out;
}

const ALLOWED_URL_HOSTS = new Set([
  'server.smartlead.ai', 'api.instantly.ai', 'www.spamhaus.org', 'www.barracudacentral.org',
  'docs.n8n.io', 'www.rfc-editor.org'
]);

test('hygiene: no real emails, unexpected hosts, public IPs, or secret-looking strings', () => {
  const files = walk(ROOT, []).filter((f) => !/\.(png|jpg|zip)$/.test(f) && path.basename(f) !== '.env');
  assert.ok(files.length > 5);
  files.forEach((f) => {
    const text = fs.readFileSync(f, 'utf8');
    const rel = path.relative(ROOT, f);

    (text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).forEach((m) => {
      assert.ok(/\.example$/.test(m), rel + ' contains a non-example email: ' + m);
    });

    (text.match(/https?:\/\/[^\s"'`)<>\],\\]+/g) || []).forEach((u) => {
      const host = u.replace(/^https?:\/\//, '').split(/[/:?#]/)[0];
      assert.ok(ALLOWED_URL_HOSTS.has(host) || /\.example$/.test(host), rel + ' references unexpected host ' + host);
    });

    (text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) || []).forEach((ip) => {
      const forward = /^(192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|127\.)/.test(ip);
      // Reverse-DNS form of the same documentation ranges, e.g. 10.2.0.192
      const reversed = /^\d{1,3}\.2\.0\.192$|^\d{1,3}\.100\.51\.198$|^\d{1,3}\.113\.0\.203$/.test(ip);
      assert.ok(forward || reversed, rel + ' contains a non-reserved IP: ' + ip);
    });

    assert.ok(!/\b[A-Fa-f0-9]{32,}\b/.test(text), rel + ' contains a long hex string');
    assert.ok(!/\bsk-[A-Za-z0-9]{16,}/.test(text), rel + ' contains a key-like token');
  });
});

test('hygiene: .env.example defaults are safe', () => {
  const text = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  assert.match(text, /^DRY_RUN=true$/m);
  assert.match(text, /^SANDBOX_MODE=true$/m);
});

test('hygiene: README contains no em-dashes and ends with the disclaimer then license', () => {
  const text = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.ok(!text.includes('\u2014'), 'README must not contain em-dashes');
  const d = text.indexOf('Disclaimer & Liability Limitation');
  const l = text.lastIndexOf('## License');
  assert.ok(d > 0 && l > d);
  assert.match(text.trim(), /Provided as-is, see the disclaimer\.$/);
});
