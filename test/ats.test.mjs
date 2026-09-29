/**
 * Offline tests for src/ats.js against real responses captured on 2026-09-29 (trimmed). Run: node test/ats.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    applyDetail, boardFromUrl, careerLinks, classifyInput, companyFromBoardPage, compileFilters, detailUrl, findBoards, guessSlugs,
    htmlToText, listRequest, nameMatches, parseList, parseWorkdayPostedOn, salaryFromText, siteLabel, siteNameFromHtml, stateKey,
} from '../src/ats.js';

const F = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const NVIDIA = { ats: 'workday', slug: 'nvidia', host: 'nvidia.wd5.myworkdayjobs.com', site: 'NVIDIAExternalCareerSite' };

// --- inputs and board detection -----------------------------------------------------------------------------
const b = (u) => boardFromUrl(u);
assert.deepEqual(b('https://boards.greenhouse.io/stripe'), { ats: 'greenhouse', slug: 'stripe' });
assert.deepEqual(b('https://job-boards.greenhouse.io/stripe/jobs/7306915'), { ats: 'greenhouse', slug: 'stripe' });
assert.deepEqual(b('https://job-boards.eu.greenhouse.io/acme'), { ats: 'greenhouse', slug: 'acme', region: 'eu' });
assert.deepEqual(b('https://boards.greenhouse.io/embed/job_board?for=Figma&b=https://www.figma.com'), { ats: 'greenhouse', slug: 'figma' });
assert.deepEqual(b('https://jobs.lever.co/palantir/ac978161-6f46-4f6b-ad9e-a258e642751c'), { ats: 'lever', slug: 'palantir' });
assert.deepEqual(b('https://jobs.eu.lever.co/acme'), { ats: 'lever', slug: 'acme', region: 'eu' });
assert.deepEqual(b('https://jobs.ashbyhq.com/OpenAI/8fb1615c'), { ats: 'ashby', slug: 'OpenAI' }, 'Ashby slug case kept');
assert.deepEqual(b('https://apply.workable.com/huggingface/j/F4C096B22E/'), { ats: 'workable', slug: 'huggingface' });
assert.deepEqual(b('https://apply.workable.com/j/F4C096B22E'), null, 'a bare Workable job link names no account');
assert.deepEqual(b('https://bunq.recruitee.com/o/senior-legal-counsel-3'), { ats: 'recruitee', slug: 'bunq' });
assert.deepEqual(b('https://careers.smartrecruiters.com/BoschGroup'), { ats: 'smartrecruiters', slug: 'BoschGroup' });
assert.deepEqual(b('https://jobs.smartrecruiters.com/BoschGroup/744000152399259-pflichtpraktikum'), { ats: 'smartrecruiters', slug: 'BoschGroup' });
assert.deepEqual(b('https://personio.jobs.personio.de/job/1834171'), { ats: 'personio', slug: 'personio', tld: 'de' });
assert.deepEqual(b('https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/x_JR1'), NVIDIA);
assert.deepEqual(b('https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite'), NVIDIA);
assert.deepEqual(b('https://wd3.myworkdaysite.com/recruiting/acme/External'), { ats: 'workday', slug: 'acme', host: 'acme.wd3.myworkdayjobs.com', site: 'External' });
assert.equal(b('https://stripe.com/jobs'), null);

assert.deepEqual(classifyInput('greenhouse:Airbnb'), { kind: 'board', board: { ats: 'greenhouse', slug: 'airbnb' }, detectedBy: 'explicit' });
assert.deepEqual(classifyInput('smartrecruiters:BoschGroup').board, { ats: 'smartrecruiters', slug: 'BoschGroup' });
assert.equal(classifyInput('workday:nvidia').kind, 'invalid', 'Workday needs the full link');
assert.deepEqual(classifyInput('stripe.com'), { kind: 'site', url: 'https://stripe.com/', domain: 'stripe.com' });
assert.deepEqual(classifyInput('https://www.stripe.com/jobs'), { kind: 'site', url: 'https://www.stripe.com/jobs', domain: 'stripe.com' });
assert.equal(classifyInput('https://jobs.lever.co/palantir').kind, 'board');
assert.match(classifyInput('ftp://stripe.com').error, /unsupported scheme/);
assert.match(classifyInput('not a url at all').error, /not a valid URL/);
assert.match(classifyInput('localhost:3000').error, /not a valid URL/);
assert.equal(classifyInput('   ').kind, 'invalid');

const careersPage = `<html><head><title>Careers | Acme</title></head><body>
  <a href="/about">About</a><a href="/careers">Careers</a><a href="https://blog.acme.com/jobs-report">Jobs report</a>
  <a href="https://twitter.com/acme/jobs">us on X</a>
  <div id="grnhse_app"></div><script src="https://boards.greenhouse.io/embed/job_board/js?for=acme"></script>
  <a href="https://jobs.lever.co/acme-labs">Labs jobs</a><a href="https://jobs.lever.co/acme-labs/123">A job</a>
  <a href="https://boards.greenhouse.io/embed">nothing</a></body></html>`;
assert.deepEqual(findBoards(careersPage), [{ ats: 'greenhouse', slug: 'acme' }, { ats: 'lever', slug: 'acme-labs' }], 'embed script and link, deduped, noise ignored');
assert.deepEqual(careerLinks(careersPage, 'https://www.acme.com/'), ['https://www.acme.com/careers', 'https://blog.acme.com/jobs-report'], 'same site only, careers first');
assert.equal(siteNameFromHtml(careersPage), 'Careers');
assert.equal(siteNameFromHtml('<meta property="og:site_name" content="Acme &amp; Co">'), 'Acme & Co');
assert.deepEqual(['stripe.com', 'jobs.stripe.com', 'acme.co.uk', 'x.ai', 'careers.x.ai'].map(siteLabel), ['stripe', 'stripe', 'acme', 'x', 'x']);
assert.deepEqual(guessSlugs('acme-labs.io'), ['acme-labs', 'acmelabs']);
assert.deepEqual(guessSlugs('x.ai'), [], 'one-letter labels are not guessed');
assert.equal(nameMatches('Stripe', 'stripe', 'Stripe'), true);
assert.equal(nameMatches('Acme Robotics GmbH', 'acme', null), true);
assert.equal(nameMatches('Palantir Technologies', 'stripe', 'Stripe'), false, 'a guessed slug that belongs to someone else is rejected');
assert.equal(nameMatches(null, 'stripe', null), true, 'boards without a name cannot be checked');

// --- endpoints ----------------------------------------------------------------------------------------------
assert.equal(listRequest({ ats: 'greenhouse', slug: 'stripe' }).url, 'https://boards-api.greenhouse.io/v1/boards/stripe/jobs?content=true&pay_transparency=true');
assert.equal(listRequest({ ats: 'lever', slug: 'acme', region: 'eu' }).url, 'https://api.eu.lever.co/v0/postings/acme?mode=json');
assert.equal(listRequest({ ats: 'smartrecruiters', slug: 'BoschGroup' }, { offset: 200 }).url, 'https://api.smartrecruiters.com/v1/companies/BoschGroup/postings?limit=100&offset=200');
const wdReq = listRequest(NVIDIA, { offset: 40, searchText: 'engineer' });
assert.equal(wdReq.method, 'POST');
assert.equal(wdReq.url, 'https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/jobs');
assert.deepEqual(wdReq.json, { appliedFacets: {}, limit: 20, offset: 40, searchText: 'engineer' });

// --- list parsing, one board at a time ----------------------------------------------------------------------
function rows(board, file) {
    const r = parseList(board, 200, F(file));
    assert.equal(r.exists, true, `${board.ats} exists`);
    for (const j of r.jobs) {
        assert.equal(j.ok, true);
        assert.ok(j.jobId && j.title && j.url?.startsWith('https://'), `${board.ats}: id, title and url on every row`);
        assert.ok(j.postedAt === null || !Number.isNaN(Date.parse(j.postedAt)), `${board.ats}: postedAt is ISO or null`);
        assert.ok(Array.isArray(j.locations));
    }
    return r;
}

const gh = rows({ ats: 'greenhouse', slug: 'stripe' }, 'greenhouse-jobs.json');
assert.equal(gh.jobs.length, 3);
assert.equal(gh.company, 'Stripe');
assert.equal(gh.jobs[0].postedAt, '2026-09-03T17:32:53.000Z');
assert.ok(!/&lt;|<p>/.test(htmlToText(gh.jobs[0].descriptionHtml)), 'Greenhouse content is entity-escaped HTML; the text has neither');
assert.ok(htmlToText(gh.jobs[0].descriptionHtml).length > 500, "Greenhouse description text");

const lv = rows({ ats: 'lever', slug: 'outreach' }, 'lever-postings.json');
assert.deepEqual([lv.jobs[0].salaryMin, lv.jobs[0].salaryMax, lv.jobs[0].salaryCurrency, lv.jobs[0].salaryPeriod, lv.jobs[0].salarySource], [70000, 110000, 'USD', 'year', 'ats']);
assert.deepEqual([lv.jobs[0].remote, lv.jobs[0].workplaceType, lv.jobs[0].employmentType, lv.jobs[0].country], [true, 'remote', 'full-time', 'US']);
assert.deepEqual([lv.jobs[1].remote, lv.jobs[1].workplaceType], [false, 'hybrid']);
assert.equal(lv.jobs[0].postedAt, new Date(JSON.parse(F('lever-postings.json'))[0].createdAt).toISOString(), 'Lever millisecond timestamps');

const ab = rows({ ats: 'ashby', slug: 'openai' }, 'ashby-board.json');
assert.equal(ab.jobs.length, 3, 'the unlisted posting is left out');
assert.deepEqual([ab.jobs[0].salaryMin, ab.jobs[0].salaryMax, ab.jobs[0].salaryCurrency, ab.jobs[0].salaryPeriod], [257000, 335000, 'USD', 'year']);
assert.match(ab.jobs[0].salaryText, /\$257K/);
assert.equal(ab.jobs[0].country, 'United States');
assert.equal(ab.jobs[2].salaryMin, null, 'no compensation, no salary invented');

const wk = rows({ ats: 'workable', slug: 'huggingface' }, 'workable-widget.json');
assert.equal(wk.company, 'Hugging Face');
assert.deepEqual([wk.jobs[0].remote, wk.jobs[0].workplaceType, wk.jobs[0].employmentType, wk.jobs[0].postedAt], [true, 'remote', 'full-time', '2026-07-30T00:00:00.000Z']);

const rc = rows({ ats: 'recruitee', slug: 'bunq' }, 'recruitee-offers.json');
assert.equal(rc.company, 'bunq');
assert.deepEqual([rc.jobs[0].workplaceType, rc.jobs[0].postedAt], ['hybrid', '2026-09-25T15:46:07.000Z'], 'Recruitee "YYYY-MM-DD HH:MM:SS UTC" dates');

const sr = rows({ ats: 'smartrecruiters', slug: 'BoschGroup' }, 'smartrecruiters-postings.json');
assert.equal(sr.total, 4796, 'SmartRecruiters reports the full count on every page');
assert.equal(sr.jobs[0].employmentType, 'internship', 'experience level "internship" wins over "Full-time"');
assert.equal(sr.jobs[0].country, 'DE');

const ps = parseList({ ats: 'personio', slug: 'personio' }, 200, F('personio.xml'));
assert.equal(ps.jobs.length, 1);
assert.deepEqual([ps.jobs[0].title, ps.jobs[0].company, ps.jobs[0].locations.join('|'), ps.jobs[0].department], ['Staff Software Engineer, Data Platform', 'Personio SE & Co. KG', 'Munich|Berlin', 'Product and Tech']);
assert.equal(ps.jobs[0].url, 'https://personio.jobs.personio.de/job/1834171');
assert.match(htmlToText(ps.jobs[0].descriptionHtml), /The Role/);

const wd = rows(NVIDIA, 'workday-jobs.json');
assert.equal(wd.total, 2000);
assert.equal(wd.jobs[0].jobId, 'JR2015057');
assert.equal(wd.jobs[0].postedAtApproximate, true);
assert.equal(detailUrl(NVIDIA, wd.jobs[0]), 'https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/job/Israel-Beer-Sheva/Senior-Chip-Design-Verification-Engineer_JR2015057');
const wdd = applyDetail(NVIDIA, wd.jobs[0], F('workday-detail.json'));
assert.deepEqual([wdd.location, wdd.locations, wdd.country, wdd.employmentType, wdd.postedAt, wdd.postedAtApproximate], ['Israel, Beer Sheva', ['Israel, Beer Sheva', 'Israel, Tel Aviv'], 'Israel', 'full-time', '2026-09-29T00:00:00.000Z', false]);
assert.equal(wdd.company, null, 'the legal entity in the detail does not replace the brand');
assert.ok(htmlToText(wdd.descriptionHtml).length > 500, "Workday description text");

const srd = applyDetail({ ats: 'smartrecruiters', slug: 'BoschGroup' }, sr.jobs[0], F('smartrecruiters-detail.json'));
assert.match(srd.url, /^https:\/\/jobs\.smartrecruiters\.com\/BoschGroup\/744000152399259-/);
assert.match(htmlToText(srd.descriptionHtml), /Stellenbeschreibung/);

// Not-found answers, one per board, as each API actually gives them.
assert.equal(parseList({ ats: 'greenhouse', slug: 'x' }, 404, '{"status":404,"error":"Job not found"}').exists, false);
assert.equal(parseList({ ats: 'lever', slug: 'x' }, 404, '{"ok":false,"error":"Document not found"}').exists, false);
assert.equal(parseList({ ats: 'ashby', slug: 'x' }, 404, 'Not Found').exists, false);
assert.equal(parseList({ ats: 'recruitee', slug: 'x' }, 404, '{"error":"Not Found"}').exists, false);
assert.equal(parseList({ ats: 'workable', slug: 'x' }, 404, 'Not Found').exists, false);
assert.equal(parseList({ ats: 'personio', slug: 'x' }, 307, '').exists, false, 'Personio redirects unknown boards to its home page');
assert.equal(parseList({ ats: 'smartrecruiters', slug: 'x' }, 200, '{"offset":0,"limit":1,"totalFound":0,"content":[]}').exists, null, 'SmartRecruiters cannot tell unknown from empty');

// Board names from the board's own page, for APIs that carry none.
assert.equal(companyFromBoardPage({ ats: 'lever' }, '<title>Palantir Technologies</title>'), 'Palantir Technologies');
assert.equal(companyFromBoardPage({ ats: 'ashby' }, 'x"organizationName":"OpenAI"y'), 'OpenAI');
assert.equal(companyFromBoardPage({ ats: 'workday' }, '<meta property="og:title" content="CAREERS AT NVIDIA">'), 'NVIDIA');

// --- salary text ----------------------------------------------------------------------------------------------
const sal = (t) => { const s = salaryFromText(t); return s.salaryMin === null ? null : [s.salaryMin, s.salaryMax, s.salaryCurrency, s.salaryPeriod]; };
assert.deepEqual(sal('The estimated salary range for this position is estimated to be $60,000 - $97,000/year.'), [60000, 97000, 'USD', 'year']);
assert.deepEqual(sal('Base pay: $150K–$200K plus equity'), [150000, 200000, 'USD', 'year']);
assert.deepEqual(sal('Gehalt: 60.000 € - 80.000 € pro Jahr'), [60000, 80000, 'EUR', 'year'], 'amount before the currency');
assert.deepEqual(sal('The base salary range is 136,000 USD - 212,750 USD.'), [136000, 212750, 'USD', 'year'], 'Workday style');
assert.deepEqual(sal('The base salary range is 136,000 USD - 212,750 USD for Level 3, and 168,000 USD - 270,250 USD for Level 4.'), [136000, 270250, 'USD', 'year'], 'ranges per level are spanned');
assert.deepEqual(sal('Base $120,000 - $150,000. We raised $20,000,000 - $30,000,000 last year.'), [120000, 150000, 'USD', 'year'], 'an implausible second pair is not spanned in');
assert.deepEqual(sal('Salary: €60.000 - €80.000 per year'), [60000, 80000, 'EUR', 'year']);
assert.deepEqual(sal('£45,000 to £55,000 depending on experience'), [45000, 55000, 'GBP', 'year']);
assert.deepEqual(sal('USD 45 - 60 per hour'), [45, 60, 'USD', 'hour']);
assert.deepEqual(sal('CA$120,000 - CA$140,000 annually'), [120000, 140000, 'CAD', 'year']);
assert.equal(sal('You bring $1 - 2 years of experience'), null, 'numbers that are not pay');
assert.equal(sal('Raised $20 - 30 million in funding'), null);
assert.equal(sal('We have 5 - 10 offices'), null, 'no currency, no salary');
assert.equal(sal(''), null);

// --- Workday dates ----------------------------------------------------------------------------------------------
const now = new Date('2026-09-29T15:00:00Z');
assert.deepEqual(parseWorkdayPostedOn('Posted Today', now), { date: '2026-09-29T00:00:00.000Z', approximate: true });
assert.deepEqual(parseWorkdayPostedOn('Posted Yesterday', now), { date: '2026-09-28T00:00:00.000Z', approximate: true });
assert.deepEqual(parseWorkdayPostedOn('Posted 3 Days Ago', now), { date: '2026-09-26T00:00:00.000Z', approximate: true });
assert.deepEqual(parseWorkdayPostedOn('Posted 30+ Days Ago', now), { date: null, approximate: true, olderThanDays: 30 });

// --- filters ----------------------------------------------------------------------------------------------------
const job = { title: 'Senior Backend Engineer', location: 'Berlin, Germany', locations: ['Berlin, Germany'], country: 'DE', remote: false, workplaceType: 'hybrid', postedAt: '2026-09-20T00:00:00.000Z' };
const nowMs = Date.parse('2026-09-29T00:00:00Z');
assert.equal(compileFilters({}).reject(job), null);
assert.equal(compileFilters({ titleKeywords: ['engineer', 'designer'] }).reject(job), null);
assert.equal(compileFilters({ titleKeywords: 'designer\nmarketing' }).reject(job), 'title', 'newline-separated keywords');
assert.equal(compileFilters({ excludeTitleKeywords: ['senior'] }).reject(job), 'title');
assert.equal(compileFilters({ locationKeywords: ['germany'] }).reject(job), null);
assert.equal(compileFilters({ locationKeywords: ['london'] }).reject(job), 'location');
assert.equal(compileFilters({ locationKeywords: ['hybrid'] }).reject(job), null, 'the workplace type is searchable as a location');
assert.equal(compileFilters({ remoteOnly: true }).reject(job), 'remote');
assert.equal(compileFilters({ remoteOnly: true }).reject({ ...job, workplaceType: 'remote' }), null);
assert.equal(compileFilters({ postedWithinDays: 14 }, nowMs).reject(job), null);
assert.equal(compileFilters({ postedWithinDays: 7 }, nowMs).reject(job), 'date');
assert.equal(compileFilters({ postedWithinDays: 7 }, nowMs).reject({ ...job, postedAt: null }), 'date', 'undated jobs cannot prove they are recent');
assert.equal(compileFilters({ postedWithinDays: 60 }, nowMs).reject({ ...job, postedAt: null, _olderThanDays: 30 }), null, '"30+ days" may still be within 60');
assert.equal(compileFilters({ postedWithinDays: 7 }, nowMs).reject({ ...job, postedAt: null, _olderThanDays: 30 }), 'date');

// --- state keys -----------------------------------------------------------------------------------------------
for (const board of [{ ats: 'greenhouse', slug: 'stripe' }, NVIDIA, { ats: 'ashby', slug: 'Open AI%' }]) {
    assert.match(stateKey(board), /^[a-zA-Z0-9!\-_.'()]{1,256}$/, 'key-value store key rules');
}
assert.notEqual(stateKey({ ats: 'greenhouse', slug: 'a' }), stateKey({ ats: 'lever', slug: 'a' }));

console.log('ALL ATS TESTS PASSED');
