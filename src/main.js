import { Actor, log } from 'apify';
import { gotScraping } from 'got-scraping';
import {
    PAGE_SIZE, applyDetail, boardKey, boardPageUrl, careerLinks, classifyInput, companyFromBoardPage, compileFilters, detailUrl,
    findBoards, guessSlugs, htmlToText, listRequest, nameMatches, needsDetails, parseList, prettySlug, siteLabel, siteNameFromHtml, stateKey,
} from './ats.js';

const EVENT_JOB = 'job';
const INPUT_FIELDS = ['companies', 'company', 'urls', 'url', 'startUrls', 'careerPages', 'careersUrls', 'domains', 'websites', 'boards'];
// Boards tried, in this order, when a company's pages link to no board and the input allows guessing.
const GUESS_ATS = ['greenhouse', 'lever', 'ashby', 'workable', 'recruitee'];
const RETRY_DELAYS_MS = [1000, 3000, 8000];
const HEADER_OPTIONS = { browsers: [{ name: 'chrome', minVersion: 120 }], devices: ['desktop'] };
const DETAIL_CONCURRENCY = 5;
const MAX_BOARDS_PER_SITE = 10;
const STATE_STORE = 'ats-jobs-scraper-state';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const entries = collectEntries(input);
if (!entries.length) {
    await Actor.fail('No companies given. Pass "companies" with careers pages, company websites, job board links or "ats:slug" pairs, e.g. ["stripe.com", "https://jobs.lever.co/palantir", "greenhouse:airbnb"].');
}
const includeDescription = input.includeDescription !== false;
const includeDescriptionHtml = input.includeDescriptionHtml === true;
const includeRaw = input.includeRaw === true;
const workdayDetails = input.workdayDetails !== false;
const guessBoards = input.guessBoards !== false;
const onlyNew = input.onlyNew === true;
const maxJobsPerCompany = clamp(Number(input.maxJobsPerCompany ?? 0), 0, 1e6);
const maxItems = clamp(Number(input.maxItems ?? 0), 0, 1e7);
const maxConcurrency = clamp(Number(input.maxConcurrency ?? 10), 1, 50);
const timeoutMs = clamp(Number(input.timeoutSecs ?? 30), 5, 120) * 1000;
const filters = compileFilters(input);
// Called with nothing, createProxyConfiguration defaults to Apify Proxy, whose cost on a pay-per-event run falls
// on the developer. It is used only when the input asks for it.
const wantsProxy = input.proxyConfiguration?.useApifyProxy === true || input.proxyConfiguration?.proxyUrls?.length > 0;
const proxyConfiguration = wantsProxy ? await Actor.createProxyConfiguration(input.proxyConfiguration) : undefined;
const stateStore = onlyNew ? await Actor.openKeyValueStore(String(input.stateStoreName || STATE_STORE)) : null;

let stop = false;
let charged = 0;
let failed = 0;
let alreadySeen = 0;
let boardsDone = 0;
const leftOut = { title: 0, location: 0, remote: 0, date: 0 };
const summary = [];

// One entry per distinct board, however many inputs lead to it.
const boards = new Map();
const sites = [];
const seenInputs = new Set();
for (const raw of entries) {
    if (seenInputs.has(raw.toLowerCase())) continue;
    seenInputs.add(raw.toLowerCase());
    const c = classifyInput(raw);
    if (c.kind === 'invalid') await reportInputError(raw, c.error);
    else if (c.kind === 'board') addBoard(c.board, raw, c.detectedBy, null);
    else sites.push({ input: raw, url: c.url, domain: c.domain });
}

if (sites.length) log.info(`Looking for the job board behind ${sites.length} company site(s)`);
await runPool(sites, maxConcurrency, resolveSite);

const boardList = [...boards.values()];
log.info(`Reading ${boardList.length} job board(s)${onlyNew ? ', writing only jobs not seen in earlier runs' : ''}`);
await runPool(boardList, maxConcurrency, async (entry) => {
    if (stop) return;
    await scrapeBoard(entry);
    boardsDone += 1;
    if (boardsDone % 10 === 0) await Actor.setStatusMessage(`${boardsDone}/${boardList.length} boards, ${charged} jobs, ${failed} failed`);
});

await Actor.setValue('SUMMARY', summary);
const out = Object.entries(leftOut).filter(([, n]) => n).map(([k, n]) => `${n} by ${k}`).join(', ');
if (stop) log.warning('Stopped early: the maximum cost or item count set for this run was reached.');
await Actor.setStatusMessage(`${boardsDone}/${boardList.length} boards, ${charged} jobs, ${failed} failed`, { isStatusMessageTerminal: true });
log.info(`Finished: ${charged} job(s) from ${boardList.length} board(s), ${failed} failed input(s) or board(s)${out ? `; filtered out ${out}` : ''}${onlyNew ? `; ${alreadySeen} already seen` : ''}. Per-company counts are in the SUMMARY record.`);
await Actor.exit();

// ---------------------------------------------------------------------------------------------------------

function addBoard(board, inputUrl, detectedBy, company) {
    const key = boardKey(board);
    const existing = boards.get(key);
    if (existing) {
        existing.inputs.push(inputUrl);
        existing.company ??= company;
        return;
    }
    boards.set(key, { board, inputs: [inputUrl], detectedBy, company });
}

/** Finds the board(s) a company site uses: on its home page, then on its careers page, then by guessing the slug. */
async function resolveSite(site) {
    if (stop) return;
    let siteName = null;
    let found = [];
    let homeProblem = null;
    const tried = new Set();
    const visit = async (url, isHome = false) => {
        if (tried.has(url)) return null;
        tried.add(url);
        try {
            const res = await request(url);
            if (res.statusCode >= 400) {
                if (isHome) homeProblem = `the site answered HTTP ${res.statusCode}`;
                return null;
            }
            siteName ??= siteNameFromHtml(res.body ?? '');
            found = findBoards(res.body ?? '');
            return res;
        } catch (err) {
            if (isHome) homeProblem = `could not load it: ${err.message}`;
            return null;
        }
    };

    const home = await visit(site.url, true);
    if (!found.length && home) {
        const origin = new URL(home.url ?? site.url).origin;
        const candidates = [...careerLinks(home.body ?? '', home.url ?? site.url), `${origin}/careers`, `${origin}/jobs`];
        for (const url of candidates) {
            await visit(url);
            if (found.length) break;
        }
    }
    let detectedBy = 'page';
    if (!found.length && guessBoards) {
        const guess = await guessBoard(site.domain, siteName);
        if (guess) {
            found = [guess];
            detectedBy = 'slug-guess';
        }
    }
    if (!found.length) {
        const error = homeProblem
            ? `no job board found: ${homeProblem}${guessBoards ? ', and no board matched the domain name' : ''}; pass the careers page or the job board link itself`
            : `no supported job board is linked from this site or its careers page; pass the careers page or the job board link itself`;
        await reportInputError(site.input, error);
        return;
    }
    if (found.length > MAX_BOARDS_PER_SITE) log.warning(`${site.input}: ${found.length} boards linked, reading the first ${MAX_BOARDS_PER_SITE}`);
    for (const board of found.slice(0, MAX_BOARDS_PER_SITE)) addBoard(board, site.input, detectedBy, siteName);
}

async function guessBoard(domain, siteName) {
    for (const slug of guessSlugs(domain)) {
        for (const ats of GUESS_ATS) {
            const board = { ats, slug };
            try {
                const res = await request(listRequest(board).url);
                if (res.statusCode !== 200) continue;
                const parsed = parseList(board, res.statusCode, res.body);
                if (!parsed.exists || !parsed.jobs.length) continue;
                const name = parsed.company ?? parsed.jobs[0]?.company ?? (await boardCompany(board));
                if (!nameMatches(name, siteLabel(domain), siteName)) continue;
                return board;
            } catch {
                // A board that errors is not the one; try the next.
            }
        }
    }
    return null;
}

async function scrapeBoard(entry) {
    const { board } = entry;
    const report = { inputs: entry.inputs, ats: board.ats, board: board.ats === 'workday' ? `${board.host}/${board.site}` : board.slug, company: null, detectedBy: entry.detectedBy, jobsOnBoard: null, jobsListed: 0, passedFilters: 0, written: 0, error: null };
    summary.push(report);

    let listing;
    try {
        listing = await listBoard(board);
    } catch (err) {
        report.error = `could not read the ${board.ats} board: ${err.message}`;
        await reportBoardError(entry, report.error);
        return;
    }
    if (listing.exists === false) {
        report.error = `no ${board.ats} job board found for "${report.board}"`;
        await reportBoardError(entry, report.error);
        return;
    }
    if (listing.exists === null) {
        report.error = `SmartRecruiters returned no jobs for company id "${board.slug}": the id is case-sensitive (e.g. BoschGroup), or the company has no open jobs`;
        await reportBoardError(entry, report.error);
        return;
    }

    const company = listing.company ?? (await boardCompany(board)) ?? entry.company ?? prettySlug(board.slug);
    report.company = company;
    report.jobsOnBoard = listing.total;
    report.jobsListed = listing.jobs.length;

    let jobs = keep(listing.jobs, (job) => preReject(board, job));

    const seen = onlyNew ? new Set((await stateStore.getValue(stateKey(board)))?.seen ?? []) : null;
    if (seen) {
        const fresh = jobs.filter((j) => !seen.has(j.jobId));
        alreadySeen += jobs.length - fresh.length;
        jobs = fresh;
    }
    const target = maxJobsPerCompany || Infinity;
    if (needsDetails(board, { includeDescription, workdayDetails })) {
        // Details are fetched a few at a time until enough jobs pass, because on Workday the location filter can
        // only be applied once a job's own record names its locations.
        const passed = [];
        for (let i = 0; i < jobs.length && passed.length < target && !stop; i += DETAIL_CONCURRENCY) {
            const chunk = jobs.slice(i, i + DETAIL_CONCURRENCY);
            await Promise.all(chunk.map((job) => fetchDetail(board, job)));
            passed.push(...(board.ats === 'workday' ? keep(chunk, (job) => filters.reject(job)) : chunk));
        }
        jobs = passed;
    }
    if (jobs.length > target) jobs = jobs.slice(0, target);

    report.passedFilters = jobs.length;
    const written = [];
    for (const job of jobs) {
        if (stop) break;
        await pushCharged(finalize(job, company, entry));
        written.push(job.jobId);
        report.written += 1;
    }

    if (seen) {
        // Seen = what was seen before and is still open, plus what this run wrote. Jobs not written because the run
        // stopped early stay new for the next run.
        const open = new Set(listing.jobs.map((j) => j.jobId));
        const next = [...seen].filter((id) => open.has(id)).concat(written);
        await stateStore.setValue(stateKey(board), { seen: [...new Set(next)], updatedAt: new Date().toISOString() });
    }
}

function keep(jobs, rejectFn) {
    return jobs.filter((job) => {
        const why = rejectFn(job);
        if (why) leftOut[why] += 1;
        return !why;
    });
}

/**
 * The filters as far as a board's list can answer them. Workday lists say "2 Locations" instead of naming them, and
 * such a row can be judged on location and remote only after its detail record is read.
 */
function preReject(board, job) {
    const why = filters.reject(job);
    const hidden = board.ats === 'workday' && workdayDetails && /^\d+\s+locations?$/i.test(job.location ?? '');
    return hidden && (why === 'location' || why === 'remote') ? null : why;
}

async function fetchDetail(board, job) {
    if (stop) return;
    try {
        const res = await request(detailUrl(board, job), { headers: { accept: 'application/json' } });
        if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);
        Object.assign(job, applyDetail(board, job, res.body));
    } catch (err) {
        job.detailError = `the job's own page could not be read (${err.message}); the row has the list fields only`;
    }
}

/** All of a board's jobs, following pages where the API has them. */
async function listBoard(board) {
    if (board.ats === 'personio') return listPersonio(board);
    if (board.ats === 'workday') return listWorkday(board);
    const first = await requestList(board, listRequest(board));
    if (board.ats !== 'smartrecruiters' || !first.exists) return first;
    const jobs = [...first.jobs];
    while (jobs.length < first.total && !stop && !(maxJobsPerCompany && keepCount(board, jobs) >= maxJobsPerCompany)) {
        const page = await requestList(board, listRequest(board, { offset: jobs.length }));
        if (!page.jobs.length) break;
        jobs.push(...page.jobs);
    }
    return { ...first, jobs };
}

/** Personio serves boards on .de or .com; an explicit "personio:slug" does not say which. */
async function listPersonio(board) {
    const tlds = board.tld ? [board.tld] : ['de', 'com'];
    for (const tld of tlds) {
        board.tld = tld;
        const result = await requestList(board, listRequest(board), { followRedirect: false });
        if (result.exists) return result;
    }
    return { exists: false };
}

/**
 * Workday pages 20 jobs at a time and reports the total only on the first page. With title keywords, each one is
 * searched on Workday's side, which on a board of thousands of jobs saves most of the requests.
 */
async function listWorkday(board) {
    const searches = filters.titleKeywords.length ? filters.titleKeywords.slice(0, 10) : [''];
    const byId = new Map();
    let total = 0;
    let exists = false;
    for (const searchText of searches) {
        let offset = 0;
        let pageTotal = null;
        while (!stop) {
            const page = await requestList(board, listRequest(board, { offset, searchText }));
            if (!page.exists) break;
            exists = true;
            if (pageTotal === null) pageTotal = page.total;
            for (const job of page.jobs) byId.set(job.jobId, job);
            offset += PAGE_SIZE.workday;
            if (!page.jobs.length || offset >= pageTotal) break;
            if (maxJobsPerCompany && keepCount(board, [...byId.values()]) >= maxJobsPerCompany) break;
        }
        total += pageTotal ?? 0;
    }
    if (!exists) return { exists: false };
    return { exists: true, jobs: [...byId.values()], total: searches.length > 1 ? byId.size : total };
}

/**
 * How many listed jobs could still be written, for deciding when to stop paging. Workday rows whose location is
 * hidden count at a third, since the detail records may rule most of them out.
 */
function keepCount(board, jobs) {
    let n = 0;
    for (const j of jobs) {
        if (preReject(board, j)) continue;
        const hidden = board.ats === 'workday' && /^\d+\s+locations?$/i.test(j.location ?? '') && filters.reject(j);
        n += hidden ? 1 / 3 : 1;
    }
    return n;
}

async function requestList(board, req, extra = {}) {
    const res = await request(req.url, {
        method: req.method ?? 'GET',
        ...(req.json ? { json: req.json } : {}),
        headers: { accept: board.ats === 'personio' ? 'application/xml' : 'application/json' },
        ...extra,
    });
    if (res.statusCode >= 400 && ![404, 410].includes(res.statusCode)) throw new Error(`HTTP ${res.statusCode}`);
    return parseList(board, res.statusCode, res.body);
}

async function boardCompany(board) {
    const url = boardPageUrl(board);
    if (!url) return null;
    try {
        const res = await request(url);
        return res.statusCode === 200 ? companyFromBoardPage(board, res.body ?? '') : null;
    } catch {
        return null;
    }
}

function finalize(job, company, entry) {
    const row = { ...job, company: job.company ?? company };
    if (includeDescription) row.description = htmlToText(job.descriptionHtml) || null;
    if (!includeDescriptionHtml) delete row.descriptionHtml;
    if (!includeRaw) delete row.raw;
    for (const k of Object.keys(row)) if (k.startsWith('_')) delete row[k];
    row.isNew = onlyNew ? true : null;
    row.detectedBy = entry.detectedBy;
    row.inputUrl = entry.inputs[0];
    row.scrapedAt = new Date().toISOString();
    return row;
}

async function pushCharged(item) {
    if (stop) return;
    const result = await Actor.pushData(item, EVENT_JOB);
    charged += 1;
    if (result?.eventChargeLimitReached || (maxItems && charged >= maxItems)) stop = true;
}

async function reportInputError(inputUrl, error) {
    failed += 1;
    log.warning(`Skipping ${inputUrl}: ${error}`);
    summary.push({ inputs: [inputUrl], error });
    await Actor.pushData({ ok: false, inputUrl, error, scrapedAt: new Date().toISOString() });
}

async function reportBoardError(entry, error) {
    failed += 1;
    log.warning(`${entry.inputs[0]}: ${error}`);
    const { board } = entry;
    await Actor.pushData({ ok: false, ats: board.ats, boardSlug: board.ats === 'workday' ? `${board.host}/${board.site}` : board.slug, inputUrl: entry.inputs[0], detectedBy: entry.detectedBy, error, scrapedAt: new Date().toISOString() });
}

async function request(url, extra = {}) {
    let last = null;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
        if (attempt) await sleep(RETRY_DELAYS_MS[attempt - 1]);
        try {
            const proxyUrl = proxyConfiguration ? await proxyConfiguration.newUrl() : undefined;
            const res = await gotScraping({
                url,
                proxyUrl,
                throwHttpErrors: false,
                timeout: { request: timeoutMs },
                retry: { limit: 0 },
                headerGeneratorOptions: HEADER_OPTIONS,
                ...extra,
                headers: { ...(extra.headers ?? {}) },
            });
            if (res.statusCode === 429 || res.statusCode >= 500) {
                last = new Error(`HTTP ${res.statusCode}`);
                continue;
            }
            return res;
        } catch (err) {
            last = err;
        }
    }
    throw last;
}

function collectEntries(inp) {
    const out = [];
    const push = (v) => {
        if (v === null || v === undefined || v === '') return;
        if (Array.isArray(v)) return v.forEach(push);
        if (typeof v === 'object') return push(v.url ?? v.link ?? v.href ?? v.domain ?? v.company);
        String(v).split(/[\n\r,;]+/).map((s) => s.trim()).filter(Boolean).forEach((s) => out.push(s));
    };
    for (const key of INPUT_FIELDS) push(inp[key]);
    return out;
}

async function runPool(items, size, worker) {
    let index = 0;
    async function next() {
        while (index < items.length) await worker(items[index++]);
    }
    await Promise.all(Array.from({ length: Math.min(size, items.length) }, next));
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(n, lo, hi) {
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
}
