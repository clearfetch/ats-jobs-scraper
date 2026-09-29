/** Prints what a local run produced: one line per row, the per-company SUMMARY record and the charges. */
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const dir = 'storage/datasets/default';
const rows = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'))) : [];
for (const r of rows) {
    if (!r.ok) {
        console.log(`  ERROR  ${String(r.inputUrl).padEnd(44)} ${r.error}`);
        continue;
    }
    const salary = r.salaryMin ? `${r.salaryCurrency} ${r.salaryMin}-${r.salaryMax}/${r.salaryPeriod} (${r.salarySource})` : '';
    console.log(`  ${r.ats.padEnd(15)} ${String(r.company).slice(0, 18).padEnd(18)} ${String(r.title).slice(0, 44).padEnd(44)} ${String(r.location).slice(0, 24).padEnd(24)} ${String(r.workplaceType ?? '').padEnd(7)} ${String(r.postedAt ?? '').slice(0, 10)}${r.postedAtApproximate ? '~' : ' '} desc ${String(r.description?.length ?? 0).padStart(5)} ${salary}${r.detailError ? ' DETAIL-ERROR' : ''}`);
}
const ok = rows.filter((r) => r.ok);
const ids = ok.map((r) => `${r.ats}:${r.boardSlug}:${r.jobId}`);
console.log(`rows ${rows.length}: ok ${ok.length}, errors ${rows.length - ok.length}; duplicate job ids ${ids.length - new Set(ids).size}; with salary ${ok.filter((r) => r.salaryMin).length}; with description ${ok.filter((r) => r.description).length}`);
const sumPath = 'storage/key_value_stores/default/SUMMARY.json';
if (existsSync(sumPath)) {
    for (const s of JSON.parse(readFileSync(sumPath, 'utf8'))) {
        console.log(`  summary: ${String(s.ats ?? '-').padEnd(15)} ${String(s.company ?? '').slice(0, 22).padEnd(22)} ${String(s.detectedBy ?? '').padEnd(10)} onBoard ${s.jobsOnBoard ?? '-'} listed ${s.jobsListed ?? '-'} passed ${s.passedFilters ?? '-'} written ${s.written ?? '-'}${s.error ? `  ERROR ${s.error}` : ''}`);
    }
}
const logDir = 'storage/datasets/charging_log';
if (existsSync(logDir)) {
    const counts = {};
    for (const f of readdirSync(logDir).filter((x) => x.endsWith('.json'))) {
        const e = JSON.parse(readFileSync(`${logDir}/${f}`, 'utf8'));
        counts[e.eventName] = (counts[e.eventName] ?? 0) + (e.count ?? 1);
    }
    console.log('charged   :', Object.values(counts).reduce((a, b) => a + b, 0), counts);
}
