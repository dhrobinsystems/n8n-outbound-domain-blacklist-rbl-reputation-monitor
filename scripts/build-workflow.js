#!/usr/bin/env node
'use strict';

/*
 * Generates workflow.json from lib/core.js so the n8n Code nodes and the local mirror
 * always share the same logic.
 *
 *   node scripts/build-workflow.js           write workflow.json
 *   node scripts/build-workflow.js --check   exit 1 if workflow.json is out of date
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const OUTPUT = path.join(ROOT, 'workflow.json');

function nodeId(name) {
  const h = crypto.createHash('sha1').update('rbl-monitor:' + name).digest('hex');
  return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20, 32)].join('-');
}

const GLUE = {
  loadConfig: [
    '// ---- node: Load Config ----',
    '// Reads settings from environment variables only. No secrets are stored in this workflow.',
    'const cfg = buildConfig($env);',
    "if (cfg.fatal.length) throw new Error('Configuration error: ' + cfg.fatal.join('; '));",
    'return [{ json: { config: cfg } }];'
  ].join('\n'),

  dnsLookup: [
    '// ---- node: DNS Lookup ----',
    '// Requires NODE_FUNCTION_ALLOW_BUILTIN=dns on the n8n host.',
    "const dns = require('dns');",
    'const cfg = $input.first().json.config;',
    'const resolver = new dns.promises.Resolver({ timeout: cfg.dnsTimeoutMs, tries: 2 });',
    'if (cfg.dnsServers.length) resolver.setServers(cfg.dnsServers);',
    'const results = await lookupAll(',
    '  cfg.targets,',
    '  cfg.zones,',
    '  (name) => resolver.resolve4(name),',
    '  { concurrency: cfg.dnsConcurrency, timeoutMs: cfg.dnsTimeoutMs * 2 + 1000 }',
    ');',
    '// DNS errors and timeouts are recorded as "error" and can never cause a pause.',
    'return [{ json: { config: cfg, results } }];'
  ].join('\n'),

  evaluate: [
    '// ---- node: Evaluate Listings ----',
    'const { config: cfg, results } = $input.first().json;',
    'const verdicts = evaluateTargets(cfg.targets, results, cfg);',
    'const plan = planActions(verdicts, cfg);',
    'return [{ json: { config: cfg, verdicts, plan } }];'
  ].join('\n'),

  execute: [
    '// ---- node: Execute Pauses ----',
    '// In dry-run or sandbox mode this makes NO API calls and only records what it would do.',
    'const { config: cfg, verdicts, plan } = $input.first().json;',
    'const self = this;',
    'const deps = {',
    '  env: $env,',
    '  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),',
    '  http: async (req) => {',
    '    const res = await self.helpers.httpRequest({',
    '      method: req.method,',
    '      url: req.url,',
    '      qs: req.qs,',
    '      headers: req.headers,',
    '      body: req.body,',
    '      json: true,',
    '      returnFullResponse: true,',
    '      ignoreHttpStatusCodes: true,',
    '      timeout: cfg.httpTimeoutMs',
    '    });',
    '    return { statusCode: res.statusCode, body: res.body };',
    '  }',
    '};',
    'const execResults = await executePauses(plan.actions, cfg, deps);',
    'return [{ json: { config: cfg, verdicts, notes: plan.notes, execResults } }];'
  ].join('\n'),

  audit: [
    '// ---- node: Audit Report ----',
    'const { config: cfg, verdicts, notes, execResults } = $input.first().json;',
    'return [{ json: buildAudit(cfg, verdicts, notes, execResults, new Date().toISOString()) }];'
  ].join('\n')
};

function codeNode(name, glue, position, core) {
  return {
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: core + '\n\n' + glue
    },
    id: nodeId(name),
    name: name,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: position
  };
}

function buildWorkflow() {
  const core = fs.readFileSync(path.join(ROOT, 'lib', 'core.js'), 'utf8').trim();

  const N = {
    schedule: 'Schedule Trigger (Every 6 Hours)',
    manual: 'Manual Trigger (Test Run)',
    load: 'Load Config',
    dns: 'DNS Lookup',
    evaluate: 'Evaluate Listings',
    execute: 'Execute Pauses',
    audit: 'Audit Report',
    attention: 'Needs Attention?',
    notify: 'Notify Hook (Add Your Alert Node)',
    note: 'Setup Notes'
  };

  const nodes = [
    {
      parameters: {
        content: [
          '## RBL Reputation Monitor',
          'Checks sending domains and dedicated IPs against DNS blacklists every 6 hours and pauses mapped Smartlead / Instantly campaigns when listed.',
          '',
          '**Safe by default:** DRY_RUN=true and SANDBOX_MODE=true. Nothing is paused until BOTH are set to false.',
          '',
          '**n8n host requirements**',
          '- NODE_FUNCTION_ALLOW_BUILTIN=dns',
          '- N8N_BLOCK_ENV_ACCESS_IN_NODE=false',
          '- Use your own recursive resolver (public resolvers are often refused by RBLs)',
          '',
          'All settings come from environment variables. See README.md and .env.example.',
          'DNS timeouts and refusals are treated as "unknown", never as a listing.'
        ].join('\n'),
        height: 360,
        width: 460
      },
      id: nodeId(N.note),
      name: N.note,
      type: 'n8n-nodes-base.stickyNote',
      typeVersion: 1,
      position: [-40, -420]
    },
    {
      parameters: { rule: { interval: [{ field: 'hours', hoursInterval: 6 }] } },
      id: nodeId(N.schedule),
      name: N.schedule,
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.2,
      position: [0, 0]
    },
    {
      parameters: {},
      id: nodeId(N.manual),
      name: N.manual,
      type: 'n8n-nodes-base.manualTrigger',
      typeVersion: 1,
      position: [0, 200]
    },
    codeNode(N.load, GLUE.loadConfig, [260, 100], core),
    codeNode(N.dns, GLUE.dnsLookup, [520, 100], core),
    codeNode(N.evaluate, GLUE.evaluate, [780, 100], core),
    codeNode(N.execute, GLUE.execute, [1040, 100], core),
    codeNode(N.audit, GLUE.audit, [1300, 100], core),
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          conditions: [
            {
              id: nodeId('attention-condition'),
              leftValue: '={{ $json.summary.needsAttention }}',
              rightValue: '',
              operator: { type: 'boolean', operation: 'true', singleValue: true }
            }
          ],
          combinator: 'and'
        },
        options: {}
      },
      id: nodeId(N.attention),
      name: N.attention,
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: [1560, 100]
    },
    {
      parameters: {},
      id: nodeId(N.notify),
      name: N.notify,
      type: 'n8n-nodes-base.noOp',
      typeVersion: 1,
      position: [1820, 0]
    }
  ];

  function link(to) {
    return { main: [[{ node: to, type: 'main', index: 0 }]] };
  }

  const connections = {};
  connections[N.schedule] = link(N.load);
  connections[N.manual] = link(N.load);
  connections[N.load] = link(N.dns);
  connections[N.dns] = link(N.evaluate);
  connections[N.evaluate] = link(N.execute);
  connections[N.execute] = link(N.audit);
  connections[N.audit] = link(N.attention);
  connections[N.attention] = { main: [[{ node: N.notify, type: 'main', index: 0 }], []] };

  return {
    name: 'Outbound Domain Blacklist RBL Reputation Monitor',
    nodes: nodes,
    pinData: {},
    connections: connections,
    active: false,
    settings: { executionOrder: 'v1' },
    tags: [],
    meta: {}
  };
}

function render() {
  return JSON.stringify(buildWorkflow(), null, 2) + '\n';
}

if (require.main === module) {
  const rendered = render();
  if (process.argv.indexOf('--check') !== -1) {
    const current = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, 'utf8') : '';
    if (current !== rendered) {
      console.error('workflow.json is out of date. Run: npm run build');
      process.exit(1);
    }
    console.log('workflow.json is up to date.');
  } else {
    fs.writeFileSync(OUTPUT, rendered);
    console.log('Wrote workflow.json (' + rendered.length + ' bytes)');
  }
}

module.exports = { buildWorkflow: buildWorkflow, render: render };
