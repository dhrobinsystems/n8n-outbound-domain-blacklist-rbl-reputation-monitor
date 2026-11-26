#!/usr/bin/env node
'use strict';

/*
 * Local mirror of the n8n workflow. Runs the exact same logic from lib/core.js.
 *
 * Offline simulation (default, no DNS and no HTTP):
 *   node mirror-cli.js --scenario fixtures/scenarios/listed-domain.json
 *   node mirror-cli.js --all
 *
 * Read-only live DNS check (never calls Smartlead or Instantly, always forces dry-run):
 *   node mirror-cli.js --dns live --env-file .env
 *
 * Options: --json (print full report), --out <file> (write report JSON), --list, --help
 */

const fs = require('fs');
const path = require('path');
const dns = require('dns');
const core = require('./lib/core');

const SCENARIO_DIR = path.join(__dirname, 'fixtures', 'scenarios');

function parseEnvFile(text) {
  const out = {};
  String(text).split(/\r?\n/).forEach(function (line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.charAt(0) === '#') return;
    const eq = trimmed.indexOf('=');
    if (eq < 1) return;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (value.length >= 2) {
      const q = value.charAt(0);
      if ((q === '"' || q === "'") && value.charAt(value.length - 1) === q) value = value.slice(1, -1);
    }
    out[key] = value;
  });
  return out;
}

// Mock DNS and HTTP from a scenario file. The mock never records headers or query strings,
// so API keys cannot leak into test output.
function createMockDeps(scenario) {
  const dnsMap = scenario.dns || {};
  const dnsDefault = scenario.dnsDefault || 'ENOTFOUND';
  const httpMap = scenario.http || {};
  const counters = {};
  const httpCalls = [];
  const sleeps = [];

  function mockError(code) {
    const e = new Error('mock dns ' + code);
    e.code = code;
    return e;
  }

  return {
    httpCalls: httpCalls,
    sleeps: sleeps,
    resolve: async function (name) {
      if (Object.prototype.hasOwnProperty.call(dnsMap, name)) {
        const v = dnsMap[name];
        if (Array.isArray(v)) return v;
        throw mockError(String(v));
      }
      throw mockError(dnsDefault);
    },
    http: async function (req) {
      const m = /\/api\/v(\d)\/campaigns\/([^/]+)\//.exec(req.url);
      if (!m) return { statusCode: 404, body: { message: 'mock: unknown route' } };
      const platform = m[1] === '1' ? 'smartlead' : 'instantly';
      const id = decodeURIComponent(m[2]);
      const key = platform + ':' + id;
      httpCalls.push({ platform: platform, campaignId: id, method: req.method });
      const seq = httpMap[key];
      if (!seq || !seq.length) return { statusCode: 200, body: {} };
      const i = counters[key] || 0;
      counters[key] = i + 1;
      const code = seq[Math.min(i, seq.length - 1)];
      return { statusCode: code, body: code >= 400 ? { message: 'mock error ' + code } : {} };
    },
    sleep: async function (ms) { sleeps.push(ms); }
  };
}

async function simulate(scenario, opts) {
  opts = opts || {};
  const mock = createMockDeps(scenario);
  const report = await core.runPipeline(scenario.env || {}, {
    resolve: mock.resolve,
    http: mock.http,
    sleep: mock.sleep,
    nowIso: opts.nowIso || '2026-01-01T00:00:00.000Z'
  });
  return { report: report, httpCalls: mock.httpCalls, sleeps: mock.sleeps };
}

async function runLiveDns(envFile) {
  const fileEnv = envFile && fs.existsSync(envFile) ? parseEnvFile(fs.readFileSync(envFile, 'utf8')) : {};
  const env = Object.assign({}, fileEnv, process.env);
  // Read-only guarantee: this mode can never pause anything.
  env.DRY_RUN = 'true';
  env.SANDBOX_MODE = 'true';
  const cfg = core.buildConfig(env);
  if (cfg.fatal.length) throw new Error('Configuration error: ' + cfg.fatal.join('; '));
  const resolver = new dns.promises.Resolver({ timeout: cfg.dnsTimeoutMs, tries: 2 });
  if (cfg.dnsServers.length) resolver.setServers(cfg.dnsServers);
  return core.runPipeline(env, {
    resolve: function (name) { return resolver.resolve4(name); },
    http: async function () { throw new Error('mirror-cli never makes live API calls'); },
    sleep: async function () {},
    nowIso: new Date().toISOString()
  });
}

function formatReport(report) {
  const lines = [];
  lines.push('RBL monitor run at ' + report.runAt + '  mode=' + report.mode);
  lines.push('');
  lines.push('Targets');
  report.verdicts.forEach(function (v) {
    let line = '  ' + v.target + ' (' + v.kind + ')  [' + v.verdict + ']';
    if (v.listedZones.length) {
      line += '  listed on: ' + v.listedZones.map(function (z) { return z.zone + '(' + z.codes.join('/') + ')'; }).join(', ');
    }
    if (v.errorZones.length) {
      line += '  dns issues: ' + v.errorZones.map(function (z) { return z.zone + '(' + z.reason + ')'; }).join(', ');
    }
    lines.push(line);
  });
  lines.push('');
  lines.push('Actions');
  if (!report.actions.length) lines.push('  none');
  report.actions.forEach(function (a) {
    lines.push('  ' + a.platform + ':' + a.campaignId + '  ' + a.status + '  attempts=' + a.attempts + '  ' + a.detail);
  });
  if (report.notes.length) {
    lines.push('');
    lines.push('Notes');
    report.notes.forEach(function (n) {
      lines.push('  ' + (n.target || (n.platform + ':' + n.campaignId)) + '  ' + n.note);
    });
  }
  if (report.configWarnings.length) {
    lines.push('');
    lines.push('Config warnings');
    report.configWarnings.forEach(function (w) { lines.push('  ' + w); });
  }
  lines.push('');
  lines.push('Summary ' + JSON.stringify(report.summary));
  return lines.join('\n');
}

function listScenarios() {
  return fs.readdirSync(SCENARIO_DIR).filter(function (f) { return /\.json$/.test(f); }).sort();
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--scenario' || a === '--dns' || a === '--env-file' || a === '--out') args[a.slice(2)] = argv[++i];
    else if (a === '--json' || a === '--all' || a === '--list' || a === '--help') args[a.slice(2)] = true;
    else args._.push(a);
  }
  return args;
}

const HELP = [
  'Usage:',
  '  node mirror-cli.js --scenario <file> [--json] [--out <file>]',
  '  node mirror-cli.js --all',
  '  node mirror-cli.js --list',
  '  node mirror-cli.js --dns live [--env-file .env] [--json]',
  '',
  'Scenario mode is fully offline. --dns live performs read-only DNS lookups and never',
  'contacts Smartlead or Instantly.'
].join('\n');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || process.argv.length <= 2) {
    console.log(HELP);
    return;
  }
  if (args.list) {
    listScenarios().forEach(function (f) { console.log(f); });
    return;
  }
  const outputs = [];
  if (args.dns === 'live') {
    outputs.push({ name: 'live-dns', report: await runLiveDns(args['env-file']) });
  } else if (args.all) {
    for (const f of listScenarios()) {
      const scenario = JSON.parse(fs.readFileSync(path.join(SCENARIO_DIR, f), 'utf8'));
      const r = await simulate(scenario);
      outputs.push({ name: f, report: r.report });
    }
  } else if (args.scenario) {
    const scenario = JSON.parse(fs.readFileSync(args.scenario, 'utf8'));
    const r = await simulate(scenario);
    outputs.push({ name: path.basename(args.scenario), report: r.report });
  } else {
    console.log(HELP);
    return;
  }
  outputs.forEach(function (o) {
    console.log('=== ' + o.name + ' ===');
    console.log(args.json ? JSON.stringify(o.report, null, 2) : formatReport(o.report));
    console.log('');
  });
  if (args.out) {
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    const payload = outputs.length === 1 ? outputs[0].report : outputs;
    fs.writeFileSync(args.out, JSON.stringify(payload, null, 2) + '\n');
    console.log('Report written to ' + args.out);
  }
}

if (require.main === module) {
  main().catch(function (e) {
    console.error(e.message);
    process.exit(1);
  });
}

module.exports = { parseEnvFile: parseEnvFile, createMockDeps: createMockDeps, simulate: simulate, formatReport: formatReport, listScenarios: listScenarios };
