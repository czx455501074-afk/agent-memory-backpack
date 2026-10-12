import { Store } from '../../dist/src/store.js';
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Fix system time reference for repeatable runs
const FIXED_CLOCK_MS = 1728500000000;

function computeStats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  const median = n % 2 === 1
    ? sorted[Math.floor(n / 2)]
    : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const p95Index = Math.min(n - 1, Math.ceil(n * 0.95) - 1);
  const p95 = sorted[p95Index];
  return {
    n,
    medianMs: Number(median.toFixed(3)),
    p95Ms: Number(p95.toFixed(3)),
    minMs: Number(sorted[0].toFixed(3)),
    maxMs: Number(sorted[n - 1].toFixed(3)),
  };
}

function timeRun(fn, iterations = 20, warmup = 5) {
  // Warmup rounds
  for (let i = 0; i < warmup; i++) {
    fn();
  }
  const samples = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    fn();
    const t1 = performance.now();
    samples.push(t1 - t0);
  }
  return computeStats(samples);
}

function makeMemoryEntry(id, title, body) {
  return {
    id,
    kind: 'memory',
    title,
    body,
    scope: { kind: 'project', projectId: 'audit' },
    provenance: 'user',
    evidence: 'verifiable',
  };
}

const auditBaseline = {
  latency: [
    { scale: 0, gateMedian: 0.018, gateP95: 0.026, prepareMedian: 0.091, prepareP95: 0.143, universalP95: 0.084 },
    { scale: 100, gateMedian: 0.959, gateP95: 1.818, prepareMedian: 2.872, prepareP95: 3.595, universalP95: 1.638 },
    { scale: 1000, gateMedian: 8.796, gateP95: 10.747, prepareMedian: 26.324, prepareP95: 27.564, universalP95: 10.603 },
    { scale: 5000, gateMedian: 45.876, gateP95: 52.177, prepareMedian: 137.508, prepareP95: 145.503, universalP95: 64.159 },
  ],
  context40Norms: {
    prepareChars: 480687,
    gateChars: 480629,
  },
};

console.log('--- R3 性能与上下文基线测量开始 ---');

// 1. Latency across knowledge scales: 0, 100, 1000, 5000
const scaleResults = [];

for (const count of [0, 100, 1000, 5000]) {
  const store = new Store(':memory:', () => FIXED_CLOCK_MS);
  
  if (count > 0) {
    const batchSize = 100;
    for (let base = 0; base < count; base += batchSize) {
      const chunk = Array.from({ length: Math.min(batchSize, count - base) }, (_, i) => {
        const idx = base + i;
        const title = (idx % 20 === 0 ? 'Database recovery' : 'Video workflow') + ' ' + idx;
        const body = 'Procedure prerequisites validation result failure branches '.repeat(10);
        return makeMemoryEntry(`m-${idx}`, title, body);
      });
      store.import(chunk);
    }
  }

  const gateStats = timeRun(() => store.gate('audit', 'read'), 40, 5);
  const prepareStats = timeRun(() => store.prepare('audit', 'Database recovery'), 20, 5);
  const universalStats = timeRun(() => store.searchUniversal('audit', 'Database recovery'), 15, 5);
  const prep = store.prepare('audit', 'Database recovery');

  const baselineItem = auditBaseline.latency.find(b => b.scale === count);

  scaleResults.push({
    scale: count,
    gate: gateStats,
    prepare: prepareStats,
    searchUniversal: universalStats,
    contextChars: prep.context.length,
    knowledgeHitCount: prep.knowledge.length,
    processRssBytes: process.memoryUsage().rss,
    comparisonWithAudit: {
      gateMedian: { audit: baselineItem.gateMedian, current: gateStats.medianMs },
      gateP95: { audit: baselineItem.gateP95, current: gateStats.p95Ms },
      prepareMedian: { audit: baselineItem.prepareMedian, current: prepareStats.medianMs },
      prepareP95: { audit: baselineItem.prepareP95, current: prepareStats.p95Ms },
      universalP95: { audit: baselineItem.universalP95, current: universalStats.p95Ms },
    },
  });

  store.close();
  console.log(`已完成规模 ${count}: gate p95=${gateStats.p95Ms}ms, prepare p95=${prepareStats.p95Ms}ms, universal p95=${universalStats.p95Ms}ms`);
}

// 2. Norm Context Length & Budget: Few norms vs 40 near-limit norms
const contextResults = {};

// Scenario A: Few norms (2 norms, modest size)
{
  const store = new Store(':memory:', () => FIXED_CLOCK_MS);
  store.import([
    {
      id: 'norm-few-1',
      kind: 'norm',
      title: 'Valid credentials required',
      scope: { kind: 'project', projectId: 'audit' },
      body: 'Always check that project credentials are provided and non-empty before initiating any requests.',
      deniedTools: [],
    },
    {
      id: 'norm-few-2',
      kind: 'norm',
      title: 'Restricted destructive tools',
      scope: { kind: 'project', projectId: 'audit' },
      body: 'Destructive shell commands and unapproved git operations must be rejected at the gate boundary.',
      deniedTools: ['DangerousBash'],
    },
  ]);

  const prep = store.prepare('audit', 'Database recovery');
  const gateRes = store.gate('audit', 'read');

  contextResults.fewNorms = {
    normCount: 2,
    prepareContextLength: prep.context.length,
    gateContextLength: gateRes.context.length,
    budget: {
      limitChars: prep.budget?.limitChars ?? null,
      usedChars: prep.budget?.usedChars ?? null,
      omittedCount: prep.budget?.omitted ? prep.budget.omitted.length : 0,
      injectedCount: prep.budget?.injected ? prep.budget.injected.length : 0,
    },
  };
  store.close();
}

// Scenario B: 40 near-upper-limit norms (~12,000 chars each)
{
  const store = new Store(':memory:', () => FIXED_CLOCK_MS);
  const norms = Array.from({ length: 40 }, (_, i) => ({
    id: `norm-large-${i}`,
    kind: 'norm',
    title: `Enforce validation rule ${i}`,
    scope: { kind: 'project', projectId: 'audit' },
    body: 'Require a valid verification before proceeding with any action. '.repeat(250).slice(0, 12000),
    deniedTools: i === 0 ? ['BlockedDangerousTool'] : [],
  }));
  store.import(norms);

  const prep = store.prepare('audit', 'Database recovery');
  const gateRes = store.gate('audit', 'read');

  contextResults.nearLimit40Norms = {
    normCount: 40,
    prepareContextLength: prep.context.length,
    gateContextLength: gateRes.context.length,
    budget: {
      limitChars: prep.budget?.limitChars ?? null,
      usedChars: prep.budget?.usedChars ?? null,
      omittedCount: prep.budget?.omitted ? prep.budget.omitted.length : 0,
      injectedCount: prep.budget?.injected ? prep.budget.injected.length : 0,
    },
    comparisonWithAudit: {
      auditPrepareChars: auditBaseline.context40Norms.prepareChars,
      currentPrepareChars: prep.context.length,
      auditGateChars: auditBaseline.context40Norms.gateChars,
      currentGateChars: gateRes.context.length,
      reductionPercent: Number(((1 - prep.context.length / auditBaseline.context40Norms.prepareChars) * 100).toFixed(2)),
    },
  };
  store.close();
}

const finalPayload = {
  metadata: {
    measuredAt: new Date().toISOString(),
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    environmentNote: 'Isolated in-memory Store instance with fixed clock; hot Node process; synthetic fixture data.',
  },
  disclaimer: {
    notProductionSla: 'These readings reflect isolated micro-benchmarks on an in-memory Store fixture, not an end-to-end production SLA over real network/host IPC.',
    noABNetBenefitProof: 'This measurement quantifies isolated latency and context length bounds; it does NOT constitute an A/B benchmark against a no-plugin baseline, and does NOT prove net task efficiency gain.',
  },
  scales: scaleResults,
  context: contextResults,
};

const outputPath = resolve('verification/r3/results.json');
writeFileSync(outputPath, JSON.stringify(finalPayload, null, 2), 'utf8');
console.log(`--- R3 测量完成，结果已保存至 ${outputPath} ---`);
