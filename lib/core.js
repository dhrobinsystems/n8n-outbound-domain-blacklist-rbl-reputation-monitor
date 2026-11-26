'use strict';

/*
 * Core logic for n8n-outbound-domain-blacklist-rbl-reputation-monitor.
 *
 * Pure functions only. Network access (DNS, HTTP) is always injected by the caller.
 * scripts/build-workflow.js embeds this file verbatim into the n8n Code nodes, and
 * mirror-cli.js imports it, so the workflow and the local mirror run identical decision logic.
 */

const DEFAULT_ZONES = [
  'spamhaus_zen=zen.spamhaus.org:ip',
  'spamhaus_dbl=dbl.spamhaus.org:domain',
  'barracuda=b.barracudacentral.org:ip',
  'sorbs=dnsbl.sorbs.net:ip'
];

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const CAMPAIGN_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const ALIAS_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const CLEAN_DNS_CODES = ['ENOTFOUND', 'ENODATA', 'NXDOMAIN', 'NOTFOUND'];
const SUPPORTED_PLATFORMS = ['smartlead', 'instantly'];

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function parseList(value) {
  if (Array.isArray(value)) {
    return value.map(function (v) { return String(v).trim(); }).filter(Boolean);
  }
  if (value === undefined || value === null) return [];
  return String(value).split(/[\s,;]+/).map(function (s) { return s.trim(); }).filter(Boolean);
}

// Unset or unparseable values fall back to the supplied default (callers pass the SAFE default).
function parseBool(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const v = String(value).trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  return fallback;
}

function toInt(value, fallback, min, max) {
  const raw = value === undefined || value === null ? '' : String(value).trim();
  const n = parseInt(raw, 10);
  if (!isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function isValidIPv4(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(s));
  if (!m) return false;
  for (let i = 1; i <= 4; i++) {
    if (Number(m[i]) > 255 || String(Number(m[i])) !== m[i]) return false;
  }
  return true;
}

function isValidDomain(s) {
  return DOMAIN_RE.test(String(s));
}

// Entry format: [alias=]zone[:ip|domain]   (type defaults to ip)
function parseZones(value) {
  const out = { zones: [], warnings: [] };
  const source = parseList(value);
  const entries = source.length ? source : DEFAULT_ZONES;
  const seen = {};
  entries.forEach(function (entry, i) {
    let rest = entry;
    let alias = null;
    const eq = rest.indexOf('=');
    if (eq > 0) {
      alias = rest.slice(0, eq);
      rest = rest.slice(eq + 1);
    }
    let type = 'ip';
    const colon = rest.lastIndexOf(':');
    if (colon > 0) {
      type = rest.slice(colon + 1).toLowerCase();
      rest = rest.slice(0, colon);
    }
    const zone = rest.toLowerCase().replace(/\.$/, '');
    const badAlias = alias !== null && !ALIAS_RE.test(alias);
    if (!DOMAIN_RE.test(zone) || (type !== 'ip' && type !== 'domain') || badAlias) {
      out.warnings.push('Skipped invalid RBL_ZONES entry #' + (i + 1));
      return;
    }
    const key = zone + ':' + type;
    if (seen[key]) return;
    seen[key] = true;
    // The label is what appears in audit output. Use an alias for zones that embed a secret key.
    out.zones.push({ label: alias || zone, zone: zone, type: type });
  });
  return out;
}

// CAMPAIGN_MAP: { "<domain-or-ip>": { "smartlead": ["id"], "instantly": ["id"] } }
function parseCampaignMap(raw) {
  const out = { map: {}, fatal: [], warnings: [] };
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) return out;
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      out.fatal.push('CAMPAIGN_MAP is not valid JSON');
      return out;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    out.fatal.push('CAMPAIGN_MAP must be a JSON object keyed by domain or IP');
    return out;
  }
  Object.keys(parsed).forEach(function (key) {
    const k = key.trim().toLowerCase();
    const entry = parsed[key];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      out.warnings.push('CAMPAIGN_MAP entry ignored: value must be an object');
      return;
    }
    const clean = { smartlead: [], instantly: [] };
    SUPPORTED_PLATFORMS.forEach(function (platform) {
      parseList(entry[platform]).forEach(function (id) {
        if (CAMPAIGN_ID_RE.test(id)) clean[platform].push(id);
        else out.warnings.push('CAMPAIGN_MAP: invalid ' + platform + ' campaign id ignored');
      });
    });
    out.map[k] = clean;
  });
  return out;
}

function pickBaseUrl(value, fallback, name, warnings) {
  const v = value ? String(value).trim().replace(/\/+$/, '') : '';
  if (!v) return fallback;
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(v)) {
    warnings.push(name + ' must be an https origin; using the default');
    return fallback;
  }
  return v;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function buildConfig(env) {
  env = env || {};
  const fatal = [];
  const warnings = [];

  // Both switches default to ON. Live pausing needs DRY_RUN=false AND SANDBOX_MODE=false.
  const sandbox = parseBool(env.SANDBOX_MODE, true);
  const dryRunFlag = parseBool(env.DRY_RUN, true);
  const live = !sandbox && !dryRunFlag;

  const targets = [];
  const seenTargets = {};
  parseList(env.MONITORED_DOMAINS).forEach(function (raw, i) {
    const v = raw.toLowerCase().replace(/\.$/, '');
    if (!isValidDomain(v)) {
      warnings.push('Skipped invalid MONITORED_DOMAINS entry #' + (i + 1));
      return;
    }
    if (seenTargets['domain:' + v]) return;
    seenTargets['domain:' + v] = true;
    targets.push({ value: v, kind: 'domain' });
  });
  parseList(env.MONITORED_IPS).forEach(function (raw, i) {
    if (!isValidIPv4(raw)) {
      warnings.push('Skipped invalid MONITORED_IPS entry #' + (i + 1) + ' (IPv4 only)');
      return;
    }
    if (seenTargets['ip:' + raw]) return;
    seenTargets['ip:' + raw] = true;
    targets.push({ value: raw, kind: 'ip' });
  });
  if (targets.length === 0) fatal.push('No valid targets: set MONITORED_DOMAINS and/or MONITORED_IPS');

  const z = parseZones(env.RBL_ZONES);
  z.warnings.forEach(function (w) { warnings.push(w); });
  if (z.zones.length === 0) fatal.push('No valid RBL zones configured');
  const hasIpZone = z.zones.some(function (x) { return x.type === 'ip'; });
  const hasDomainZone = z.zones.some(function (x) { return x.type === 'domain'; });
  if (targets.some(function (t) { return t.kind === 'ip'; }) && !hasIpZone) {
    warnings.push('IP targets configured but no ip-type zones: IPs will not be checked');
  }
  if (targets.some(function (t) { return t.kind === 'domain'; }) && !hasDomainZone) {
    warnings.push('Domain targets configured but no domain-type zones: domains will not be checked');
  }

  const cm = parseCampaignMap(env.CAMPAIGN_MAP);
  cm.fatal.forEach(function (w) { fatal.push(w); });
  cm.warnings.forEach(function (w) { warnings.push(w); });
  Object.keys(cm.map).forEach(function (k) {
    if (!seenTargets['domain:' + k] && !seenTargets['ip:' + k]) {
      warnings.push('CAMPAIGN_MAP has an entry for a target that is not monitored');
    }
  });

  const platforms = [];
  parseList(env.PAUSE_PLATFORMS || 'smartlead,instantly').forEach(function (p) {
    const v = p.toLowerCase();
    if (SUPPORTED_PLATFORMS.indexOf(v) === -1) warnings.push('Unknown PAUSE_PLATFORMS entry ignored');
    else if (platforms.indexOf(v) === -1) platforms.push(v);
  });
  if (platforms.length === 0) fatal.push('PAUSE_PLATFORMS has no supported platform (smartlead, instantly)');

  const dnsServers = [];
  parseList(env.DNS_SERVERS).forEach(function (s) {
    if (isValidIPv4(s)) dnsServers.push(s);
    else warnings.push('Skipped invalid DNS_SERVERS entry (IPv4 only)');
  });

  if (live) {
    if (platforms.indexOf('smartlead') !== -1 && !env.SMARTLEAD_API_KEY) {
      warnings.push('LIVE mode but SMARTLEAD_API_KEY is not set: Smartlead pauses will be skipped');
    }
    if (platforms.indexOf('instantly') !== -1 && !env.INSTANTLY_API_KEY) {
      warnings.push('LIVE mode but INSTANTLY_API_KEY is not set: Instantly pauses will be skipped');
    }
  }

  return {
    live: live,
    dryRun: !live,
    targets: targets,
    zones: z.zones,
    campaignMap: cm.map,
    platforms: platforms,
    primaryDomains: parseList(env.PRIMARY_DOMAINS).map(function (d) { return d.toLowerCase().replace(/\.$/, ''); }),
    minListedZones: toInt(env.MIN_LISTED_ZONES, 1, 1, 20),
    maxPausesPerRun: toInt(env.MAX_PAUSES_PER_RUN, 10, 0, 1000),
    allowPrefix: env.PAUSE_ID_PREFIX_ALLOW ? String(env.PAUSE_ID_PREFIX_ALLOW).trim() : '',
    dnsServers: dnsServers,
    dnsTimeoutMs: toInt(env.DNS_TIMEOUT_MS, 4000, 200, 30000),
    dnsConcurrency: toInt(env.DNS_CONCURRENCY, 10, 1, 50),
    maxRetries: toInt(env.HTTP_MAX_RETRIES, 3, 0, 8),
    retryBaseMs: toInt(env.HTTP_RETRY_BASE_MS, 1000, 0, 60000),
    httpTimeoutMs: toInt(env.HTTP_TIMEOUT_MS, 15000, 1000, 120000),
    smartleadBaseUrl: pickBaseUrl(env.SMARTLEAD_BASE_URL, 'https://server.smartlead.ai', 'SMARTLEAD_BASE_URL', warnings),
    instantlyBaseUrl: pickBaseUrl(env.INSTANTLY_BASE_URL, 'https://api.instantly.ai', 'INSTANTLY_BASE_URL', warnings),
    fatal: fatal,
    warnings: warnings
  };
}

// ---------------------------------------------------------------------------
// DNS lookup and classification
// ---------------------------------------------------------------------------

function buildQueryName(target, zone) {
  if (zone.type !== target.kind) return null;
  if (target.kind === 'ip') {
    if (!isValidIPv4(target.value)) return null;
    return target.value.split('.').reverse().join('.') + '.' + zone.zone;
  }
  if (!isValidDomain(target.value)) return null;
  return target.value + '.' + zone.zone;
}

/*
 * Classify one DNS answer. Only a clean 127.x.x.x answer counts as "listed".
 * Everything ambiguous is an "error", and errors NEVER trigger a pause:
 *   - timeouts, SERVFAIL, refused, network errors
 *   - 127.255.255.x control answers (resolver blocked or rate limited by the RBL)
 *   - answers outside 127.0.0.0/8 (hijacked or wildcard DNS)
 */
function classifyAnswer(res) {
  if (res.errorCode) {
    if (CLEAN_DNS_CODES.indexOf(res.errorCode) !== -1) return { status: 'clean', codes: [] };
    return { status: 'error', codes: [], reason: 'dns_' + res.errorCode };
  }
  const addrs = res.addresses || [];
  if (addrs.length === 0) return { status: 'clean', codes: [] };
  const outside = addrs.filter(function (a) { return !/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a); });
  if (outside.length) return { status: 'error', codes: [], reason: 'unexpected_answer' };
  const control = addrs.filter(function (a) { return a.indexOf('127.255.255.') === 0; });
  if (control.length) return { status: 'error', codes: control, reason: 'rbl_refused_query' };
  return { status: 'listed', codes: addrs };
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise(function (resolve, reject) {
    timer = setTimeout(function () {
      const e = new Error('timeout');
      e.code = 'ETIMEOUT';
      reject(e);
    }, ms);
  });
  return Promise.race([promise, timeout]).then(
    function (v) { clearTimeout(timer); return v; },
    function (e) { clearTimeout(timer); throw e; }
  );
}

// resolve(queryName) must return Promise<string[]> or reject with an error carrying .code
async function lookupAll(targets, zones, resolve, opts) {
  opts = opts || {};
  const concurrency = opts.concurrency || 10;
  const timeoutMs = opts.timeoutMs || 5000;
  const jobs = [];
  targets.forEach(function (t) {
    zones.forEach(function (z) {
      if (z.type === t.kind) jobs.push({ t: t, z: z });
    });
  });
  const out = new Array(jobs.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const idx = next++;
      if (idx >= jobs.length) return;
      const job = jobs[idx];
      const name = buildQueryName(job.t, job.z);
      let raw;
      try {
        const addresses = await withTimeout(Promise.resolve().then(function () { return resolve(name); }), timeoutMs);
        raw = { addresses: addresses };
      } catch (e) {
        raw = { errorCode: (e && e.code) || 'EUNKNOWN' };
      }
      out[idx] = Object.assign({ target: job.t.value, kind: job.t.kind, zone: job.z.label }, classifyAnswer(raw));
    }
  }
  const workers = [];
  for (let i = 0; i < Math.min(concurrency, jobs.length); i++) workers.push(worker());
  await Promise.all(workers);
  return out;
}

// ---------------------------------------------------------------------------
// Evaluation and planning
// ---------------------------------------------------------------------------

function evaluateTargets(targets, results, cfg) {
  return targets.map(function (t) {
    const r = results.filter(function (x) { return x.target === t.value && x.kind === t.kind; });
    const listed = r.filter(function (x) { return x.status === 'listed'; });
    const errors = r.filter(function (x) { return x.status === 'error'; });
    const cleanCount = r.length - listed.length - errors.length;
    let verdict;
    if (listed.length >= cfg.minListedZones) verdict = 'listed';
    else if (listed.length > 0) verdict = 'warning';
    else if (r.length === 0 || errors.length === r.length) verdict = 'unknown';
    else if (errors.length > 0) verdict = 'clean_partial';
    else verdict = 'clean';
    return {
      target: t.value,
      kind: t.kind,
      verdict: verdict,
      checked: r.length,
      cleanZones: cleanCount,
      listedZones: listed.map(function (x) { return { zone: x.zone, codes: x.codes }; }),
      errorZones: errors.map(function (x) { return { zone: x.zone, reason: x.reason }; }),
      isPrimary: cfg.primaryDomains.indexOf(t.value) !== -1
    };
  });
}

function planActions(verdicts, cfg) {
  const byKey = {};
  const order = [];
  const notes = [];
  verdicts.forEach(function (v) {
    if (v.verdict !== 'listed') return;
    if (v.isPrimary) {
      notes.push({ target: v.target, note: 'primary_domain_alert_only' });
      return;
    }
    const entry = cfg.campaignMap[v.target];
    if (!entry) {
      notes.push({ target: v.target, note: 'no_campaigns_mapped' });
      return;
    }
    cfg.platforms.forEach(function (platform) {
      (entry[platform] || []).forEach(function (id) {
        const key = platform + ':' + id;
        if (!byKey[key]) {
          byKey[key] = { platform: platform, campaignId: String(id), reasons: [] };
          order.push(key);
        }
        byKey[key].reasons.push({ target: v.target, zones: v.listedZones.map(function (z) { return z.zone; }) });
      });
    });
  });
  let actions = order.map(function (k) { return byKey[k]; });
  if (cfg.allowPrefix) {
    actions = actions.filter(function (a) {
      if (a.campaignId.indexOf(cfg.allowPrefix) === 0) return true;
      notes.push({ platform: a.platform, campaignId: a.campaignId, note: 'skipped_by_prefix_guard' });
      return false;
    });
  }
  return { actions: actions, notes: notes };
}

// ---------------------------------------------------------------------------
// Pause execution (HTTP is injected)
// ---------------------------------------------------------------------------

function redact(text, secrets) {
  let out = String(text);
  (secrets || []).forEach(function (s) {
    if (s) out = out.split(s).join('[REDACTED]');
  });
  return out;
}

// Endpoints follow the public Smartlead and Instantly v2 docs at the time of writing.
// Verify them against the current vendor documentation before enabling live mode.
function buildPauseRequest(action, cfg, env) {
  const id = encodeURIComponent(action.campaignId);
  if (action.platform === 'smartlead') {
    return {
      method: 'POST',
      url: cfg.smartleadBaseUrl + '/api/v1/campaigns/' + id + '/status',
      qs: { api_key: env.SMARTLEAD_API_KEY },
      headers: { 'Content-Type': 'application/json' },
      body: { status: 'PAUSED' }
    };
  }
  return {
    method: 'POST',
    url: cfg.instantlyBaseUrl + '/api/v2/campaigns/' + id + '/pause',
    headers: { Authorization: 'Bearer ' + env.INSTANTLY_API_KEY, 'Content-Type': 'application/json' },
    body: {}
  };
}

async function requestWithRetry(makeRequest, cfg, deps, secrets) {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    let res;
    try {
      res = await deps.http(makeRequest());
    } catch (e) {
      res = { statusCode: 0, body: { message: e && e.message ? e.message : 'request failed' } };
    }
    const code = res && typeof res.statusCode === 'number' ? res.statusCode : 0;
    if (code >= 200 && code < 300) return { ok: true, attempts: attempt, statusCode: code };
    const retryable = code === 0 || code === 429 || code >= 500;
    if (!retryable || attempt > cfg.maxRetries) {
      const msg = res && res.body && typeof res.body.message === 'string' ? res.body.message : '';
      const detail = redact('HTTP ' + code + (msg ? ': ' + msg : ''), secrets).slice(0, 300);
      return { ok: false, attempts: attempt, statusCode: code, detail: detail };
    }
    await deps.sleep(cfg.retryBaseMs * Math.pow(2, attempt - 1));
  }
}

async function executePauses(actions, cfg, deps) {
  const env = deps.env || {};
  const secrets = [env.SMARTLEAD_API_KEY, env.INSTANTLY_API_KEY].filter(function (s) {
    return typeof s === 'string' && s.length >= 4;
  });

  // Circuit breaker: a mass listing usually means a resolver problem, not a real incident.
  if (actions.length > cfg.maxPausesPerRun) {
    return actions.map(function (a) {
      return Object.assign({}, a, {
        status: 'blocked_circuit_breaker',
        attempts: 0,
        detail: 'Planned ' + actions.length + ' pauses, MAX_PAUSES_PER_RUN is ' + cfg.maxPausesPerRun
      });
    });
  }

  const results = [];
  for (const action of actions) {
    if (!cfg.live) {
      results.push(Object.assign({}, action, {
        status: 'dry_run',
        attempts: 0,
        detail: 'Would pause (DRY_RUN or SANDBOX_MODE is on)'
      }));
      continue;
    }
    const keyName = action.platform === 'smartlead' ? 'SMARTLEAD_API_KEY' : 'INSTANTLY_API_KEY';
    if (!env[keyName]) {
      results.push(Object.assign({}, action, {
        status: 'skipped_missing_credentials',
        attempts: 0,
        detail: keyName + ' is not set'
      }));
      continue;
    }
    const outcome = await requestWithRetry(function () {
      return buildPauseRequest(action, cfg, env);
    }, cfg, deps, secrets);
    results.push(Object.assign({}, action, {
      status: outcome.ok ? 'paused' : 'failed',
      attempts: outcome.attempts,
      statusCode: outcome.statusCode,
      detail: outcome.detail || 'ok'
    }));
  }
  return results;
}

// ---------------------------------------------------------------------------
// Audit and pipeline
// ---------------------------------------------------------------------------

function buildAudit(cfg, verdicts, notes, execResults, nowIso) {
  function count(arr, fn) { return arr.filter(fn).length; }
  const summary = {
    targetsChecked: verdicts.length,
    listed: count(verdicts, function (v) { return v.verdict === 'listed'; }),
    warning: count(verdicts, function (v) { return v.verdict === 'warning'; }),
    clean: count(verdicts, function (v) { return v.verdict === 'clean'; }),
    cleanPartial: count(verdicts, function (v) { return v.verdict === 'clean_partial'; }),
    unknown: count(verdicts, function (v) { return v.verdict === 'unknown'; }),
    actionsPlanned: execResults.length,
    paused: count(execResults, function (a) { return a.status === 'paused'; }),
    dryRun: count(execResults, function (a) { return a.status === 'dry_run'; }),
    failed: count(execResults, function (a) { return a.status === 'failed'; }),
    blocked: count(execResults, function (a) { return a.status === 'blocked_circuit_breaker'; }),
    skipped: count(execResults, function (a) { return a.status === 'skipped_missing_credentials'; })
  };
  summary.needsAttention = summary.listed > 0 || summary.failed > 0 || summary.blocked > 0 || summary.skipped > 0;
  return {
    runAt: nowIso,
    mode: cfg.live ? 'LIVE' : 'DRY_RUN',
    summary: summary,
    verdicts: verdicts,
    notes: notes,
    actions: execResults,
    configWarnings: cfg.warnings
  };
}

// Whole pipeline in one call. Used by mirror-cli.js and the tests.
// deps: { resolve, http, sleep, nowIso }
async function runPipeline(env, deps) {
  const cfg = buildConfig(env);
  if (cfg.fatal.length) throw new Error('Configuration error: ' + cfg.fatal.join('; '));
  const results = await lookupAll(cfg.targets, cfg.zones, deps.resolve, {
    concurrency: cfg.dnsConcurrency,
    timeoutMs: cfg.dnsTimeoutMs * 2 + 1000
  });
  const verdicts = evaluateTargets(cfg.targets, results, cfg);
  const plan = planActions(verdicts, cfg);
  const execResults = await executePauses(plan.actions, cfg, { env: env, http: deps.http, sleep: deps.sleep });
  return buildAudit(cfg, verdicts, plan.notes, execResults, deps.nowIso || new Date().toISOString());
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DEFAULT_ZONES: DEFAULT_ZONES,
    parseList: parseList,
    parseBool: parseBool,
    toInt: toInt,
    isValidIPv4: isValidIPv4,
    isValidDomain: isValidDomain,
    parseZones: parseZones,
    parseCampaignMap: parseCampaignMap,
    buildConfig: buildConfig,
    buildQueryName: buildQueryName,
    classifyAnswer: classifyAnswer,
    lookupAll: lookupAll,
    evaluateTargets: evaluateTargets,
    planActions: planActions,
    redact: redact,
    buildPauseRequest: buildPauseRequest,
    requestWithRetry: requestWithRetry,
    executePauses: executePauses,
    buildAudit: buildAudit,
    runPipeline: runPipeline
  };
}
