#!/usr/bin/env node
/**
 * Reads the lh-*.report.json files produced by the audit workflow and writes a
 * human-readable perf-summary.md (also echoed to stdout / the job summary).
 *
 * Reports the MEDIAN of the runs for each form factor, which is what Lighthouse
 * itself recommends when comparing numbers across time.
 */
const fs = require('fs');
const path = require('path');

const ms = (v) => (v == null ? 'n/a' : `${(v / 1000).toFixed(2)}s`);
const kb = (v) => (v == null ? 'n/a' : `${(v / 1024).toFixed(0)} KB`);
const median = (arr) => {
  const a = arr.filter((n) => typeof n === 'number' && !Number.isNaN(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
};

const METRICS = [
  ['first-contentful-paint', 'FCP  (First Contentful Paint)'],
  ['largest-contentful-paint', 'LCP  (Largest Contentful Paint)'],
  ['speed-index', 'SI   (Speed Index)'],
  ['total-blocking-time', 'TBT  (Total Blocking Time)'],
  ['interactive', 'TTI  (Time to Interactive)'],
  ['server-response-time', 'TTFB (Server Response Time)'],
];

function load(prefix) {
  return fs
    .readdirSync('.')
    .filter((f) => f.startsWith(prefix) && f.endsWith('.report.json'))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(f, 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function section(label, reports) {
  const out = [];
  out.push(`\n## ${label}\n`);
  if (!reports.length) {
    out.push('_No successful runs._\n');
    return out.join('\n');
  }

  const scores = reports.map((r) => r?.categories?.performance?.score).filter((s) => s != null);
  const score = median(scores);
  out.push(`**Performance score (median of ${reports.length} runs): ${score == null ? 'n/a' : Math.round(score * 100)} / 100**\n`);

  out.push('| Metric | Median | Runs |');
  out.push('|---|---|---|');
  for (const [id, label] of METRICS) {
    const vals = reports.map((r) => r?.audits?.[id]?.numericValue);
    const m = median(vals);
    const all = vals.map((v) => (v == null ? '-' : ms(v))).join(', ');
    out.push(`| ${label} | **${ms(m)}** | ${all} |`);
  }
  const cls = median(reports.map((r) => r?.audits?.['cumulative-layout-shift']?.numericValue));
  out.push(`| CLS  (Cumulative Layout Shift) | **${cls == null ? 'n/a' : cls.toFixed(3)}** | |`);
  out.push('');

  // Page weight breakdown
  const rs = reports[0]?.audits?.['resource-summary']?.details?.items || [];
  if (rs.length) {
    out.push('### Page weight');
    out.push('| Resource type | Requests | Transfer size |');
    out.push('|---|---|---|');
    for (const it of rs) {
      out.push(`| ${it.label || it.resourceType} | ${it.requestCount} | ${kb(it.transferSize)} |`);
    }
    out.push('');
  }

  // What Lighthouse thinks would help, ranked by estimated savings
  const opps = [];
  for (const [id, audit] of Object.entries(reports[0]?.audits || {})) {
    const savings = audit?.details?.overallSavingsMs ?? audit?.numericValue;
    if (audit?.details?.type === 'opportunity' && savings > 0) {
      opps.push({ id, title: audit.title, savings, bytes: audit?.details?.overallSavingsBytes });
    }
  }
  opps.sort((a, b) => b.savings - a.savings);
  if (opps.length) {
    out.push('### Opportunities (ranked by estimated time saved)');
    out.push('| Opportunity | Est. saving | Bytes saved |');
    out.push('|---|---|---|');
    for (const o of opps.slice(0, 15)) {
      out.push(`| ${o.title} | ${ms(o.savings)} | ${o.bytes ? kb(o.bytes) : '-'} |`);
    }
    out.push('');
  }

  // Failing diagnostics worth acting on
  const diagIds = [
    'render-blocking-resources', 'uses-responsive-images', 'offscreen-images',
    'unminified-css', 'unminified-javascript', 'unused-css-rules', 'unused-javascript',
    'uses-optimized-images', 'modern-image-formats', 'uses-text-compression',
    'uses-rel-preconnect', 'server-response-time', 'redirects', 'uses-long-cache-ttl',
    'total-byte-weight', 'dom-size', 'bootup-time', 'mainthread-work-breakdown',
    'font-display', 'third-party-summary', 'largest-contentful-paint-element',
    'prioritize-lcp-image', 'legacy-javascript',
  ];
  const failing = diagIds
    .map((id) => reports[0]?.audits?.[id])
    .filter((a) => a && a.score !== null && a.score < 0.9);
  if (failing.length) {
    out.push('### Failing diagnostics');
    for (const a of failing) {
      out.push(`- **${a.title}** — ${a.displayValue || ''}`);
    }
    out.push('');
  }

  // The single heaviest requests are usually where the wins are
  const reqs = reports[0]?.audits?.['network-requests']?.details?.items || [];
  const heavy = [...reqs]
    .filter((r) => r.transferSize)
    .sort((a, b) => b.transferSize - a.transferSize)
    .slice(0, 20);
  if (heavy.length) {
    out.push('### 20 heaviest requests');
    out.push('| Size | Type | URL |');
    out.push('|---|---|---|');
    for (const r of heavy) {
      const url = String(r.url || '').slice(0, 120);
      out.push(`| ${kb(r.transferSize)} | ${r.resourceType || '-'} | \`${url}\` |`);
    }
    out.push('');
  }

  // LCP element: knowing what it is decides the whole optimization strategy
  const lcpEl = reports[0]?.audits?.['largest-contentful-paint-element'];
  const lcpNode = lcpEl?.details?.items?.[0]?.items?.[0]?.node;
  if (lcpNode) {
    out.push('### LCP element');
    out.push('```');
    out.push(`selector: ${lcpNode.selector || 'n/a'}`);
    out.push(`snippet : ${lcpNode.snippet || 'n/a'}`);
    out.push('```');
    out.push('');
  }

  // Per-image detail. Filenames on this site are Japanese and arrive percent-encoded,
  // so decode them; pair each image with what Lighthouse says is wasted on it.
  const dec = (u) => { try { return decodeURIComponent(u); } catch { return u; } };
  const byUrl = (auditId) => {
    const m = new Map();
    for (const it of reports[0]?.audits?.[auditId]?.details?.items || []) {
      if (it.url) m.set(it.url, it);
    }
    return m;
  };
  const oversized = byUrl('uses-responsive-images');
  const webpable = byUrl('modern-image-formats');
  const images = reqs.filter((r) => r.resourceType === 'Image' && r.transferSize > 1024);

  if (images.length) {
    out.push('### Image detail');
    out.push('| Transfer | Oversized by | WebP saving | Suggested width | File |');
    out.push('|---|---|---|---|---|');
    for (const r of images.sort((a, b) => (b.transferSize || 0) - (a.transferSize || 0))) {
      const over = oversized.get(r.url);
      const web = webpable.get(r.url);
      // wastedPercent is area; linear scale is its square root.
      let suggested = '-';
      const wmatch = dec(r.url).match(/-(\d+)x(\d+)\.(png|jpe?g|webp)$/i);
      if (over?.wastedPercent && wmatch) {
        const curW = Number(wmatch[1]);
        const scale = Math.sqrt(Math.max(0, 1 - over.wastedPercent / 100));
        suggested = `${Math.round(curW * scale)}px (now ${curW}px)`;
      } else if (wmatch) {
        suggested = `ok (${wmatch[1]}px)`;
      }
      const file = dec(r.url).replace(/^https?:\/\/[^/]+/, '');
      out.push(`| ${kb(r.transferSize)} | ${over ? kb(over.wastedBytes) : '-'} | ${web ? kb(web.wastedBytes) : '-'} | ${suggested} | \`${file}\` |`);
    }
    out.push('');
  }

  // Every third-party request in full. The top-20 list above is truncated, and
  // when tag setups are in question the whole list is what settles the argument.
  const tp = reports[0]?.audits?.['third-party-summary']?.details?.items || [];
  if (tp.length) {
    out.push('### Third-party by provider');
    out.push('| Provider | Transfer | Main-thread blocking |');
    out.push('|---|---|---|');
    for (const it of tp) {
      const name = it.entity?.text || it.entity || '(unknown)';
      out.push(`| ${name} | ${kb(it.transferSize)} | ${Math.round(it.blockingTime || 0)} ms |`);
    }
    out.push('');
    out.push('<details><summary>Every third-party URL</summary>\n');
    for (const it of tp) {
      const name = it.entity?.text || it.entity || '(unknown)';
      out.push(`**${name}**`);
      for (const sub of it.subItems?.items || []) {
        out.push(`- ${kb(sub.transferSize)} — \`${String(sub.url || '').slice(0, 140)}\``);
      }
      out.push('');
    }
    out.push('</details>');
    out.push('');
  }

  // Anything served from a host other than the page's own, listed exhaustively.
  let ownHost = '';
  try { ownHost = new URL(reports[0]?.finalDisplayedUrl || '').host; } catch {}
  const external = reqs.filter((r) => {
    try { return new URL(r.url).host !== ownHost; } catch { return false; }
  });
  if (external.length) {
    out.push(`### All ${external.length} external requests`);
    out.push('| Size | Type | URL |');
    out.push('|---|---|---|');
    for (const r of external.sort((a, b) => (b.transferSize || 0) - (a.transferSize || 0))) {
      out.push(`| ${kb(r.transferSize)} | ${r.resourceType || '-'} | \`${String(r.url).slice(0, 140)}\` |`);
    }
    out.push('');
  }

  out.push(`Total requests: ${reqs.length}`);
  const totalBytes = reqs.reduce((s, r) => s + (r.transferSize || 0), 0);
  out.push(`Total transferred: ${kb(totalBytes)}`);
  out.push('');

  return out.join('\n');
}

const mobile = load('lh-mobile');
const desktop = load('lh-desktop');
const url = mobile[0]?.finalDisplayedUrl || desktop[0]?.finalDisplayedUrl || 'https://81drive.com/';

let md = `# Performance audit — ${url}\n\nMeasured ${new Date().toISOString()} from a GitHub-hosted runner (US region).\n`;
md += section('Mobile (throttled: slow 4G, 4x CPU slowdown)', mobile);
md += section('Desktop', desktop);

fs.writeFileSync('perf-summary.md', md);
console.log(md);

// A compact digest printed last in the job, so reading the result back does not
// mean paging through six Lighthouse runs' worth of log.
const brief = (label, reports) => {
  if (!reports.length) return `${label}: no successful runs`;
  const m = (id) => median(reports.map((r) => r?.audits?.[id]?.numericValue));
  const runs = (id) => reports.map((r) => ms(r?.audits?.[id]?.numericValue)).join(' / ');
  const score = median(reports.map((r) => r?.categories?.performance?.score));
  const bytes = (reports[0]?.audits?.['resource-summary']?.details?.items || [])
    .find((i) => i.resourceType === 'total');
  const imgs = (reports[0]?.audits?.['resource-summary']?.details?.items || [])
    .find((i) => i.resourceType === 'image');
  return [
    `${label}  score ${score == null ? '?' : Math.round(score * 100)}`,
    `  LCP  ${ms(m('largest-contentful-paint'))}   (runs: ${runs('largest-contentful-paint')})`,
    `  FCP  ${ms(m('first-contentful-paint'))}    SI ${ms(m('speed-index'))}    TBT ${ms(m('total-blocking-time'))}`,
    `  TTFB ${ms(m('server-response-time'))}    weight ${kb(bytes?.transferSize)}   images ${kb(imgs?.transferSize)}`,
  ].join('\n');
};
const lcpNode = (reports) =>
  reports[0]?.audits?.['largest-contentful-paint-element']?.details?.items?.[0]?.items?.[0]?.node?.snippet || '';
const snip = lcpNode(mobile) || lcpNode(desktop);
const digest = [
  '===== KEY NUMBERS =====',
  brief('MOBILE ', mobile),
  brief('DESKTOP', desktop),
  `fetchpriority on LCP image: ${/fetchpriority/i.test(snip) ? 'YES' : 'NO'}`,
  `loading=lazy on LCP image : ${/loading=["']?lazy/i.test(snip) ? 'YES' : 'no'}`,
  '=======================',
].join('\n');
fs.writeFileSync('perf-brief.txt', digest);

