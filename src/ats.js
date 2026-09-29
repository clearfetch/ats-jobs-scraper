/**
 * Everything that interprets a job board: finding the board behind an input, building its API URLs, and mapping
 * each board's own format to one flat job row. No network here, so every rule is testable against fixtures.
 *
 * A "board" is { ats, slug } plus, for Workday, { host, site }. Supported: Greenhouse, Lever, Ashby, Workable,
 * Recruitee, SmartRecruiters, Personio, Workday. All of them publish these endpoints for career sites to read.
 */
import * as cheerio from 'cheerio';

export const ATS_NAMES = ['greenhouse', 'lever', 'ashby', 'workable', 'recruitee', 'smartrecruiters', 'personio', 'workday'];

// Path segments that sit where a board slug would be but are not one.
const NOT_SLUGS = new Set(['embed', 'api', 'j', 'jobs', 'v0', 'v1', 'posting-api', 'job-board', 'static', 'assets', 'www', 'app', 'apply', 'careers', 'favicon.ico', 'robots.txt', 'oneclick-ui', 'sr-jobs', 'widgets']);

// Second-level labels under a country code, so "acme.co.uk" is read as acme, not co.
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu', 'ne', 'or', 'gv', 'ltd', 'plc']);

/** The label that names the organisation in a host name: stripe for jobs.stripe.com, acme for acme.co.uk. */
export function siteLabel(hostname) {
    const parts = hostname.toLowerCase().replace(/^www\./, '').split('.');
    if (parts.length >= 3 && SECOND_LEVEL.has(parts.at(-2)) && parts.at(-1).length === 2) return parts.at(-3);
    return parts.length >= 2 ? parts.at(-2) : parts[0];
}

/**
 * Patterns that identify a board in a URL or anywhere in a page's HTML (links, iframes, embed scripts). Each returns
 * a board or null. Ordered from the most to the least specific.
 */
const BOARD_PATTERNS = [
    { ats: 'greenhouse', re: /boards-api(?:\.eu)?\.greenhouse\.io\/v1\/boards\/([A-Za-z0-9_-]+)/g },
    { ats: 'greenhouse', re: /(?:job-)?boards(?:\.eu)?\.greenhouse\.io\/embed\/job_board(?:\/js)?\?(?:[^"'\s<>]*&(?:amp;)?)?for=([A-Za-z0-9_-]+)/g },
    { ats: 'greenhouse', re: /(?:job-)?boards(?:\.eu)?\.greenhouse\.io\/([A-Za-z0-9_-]+)/g },
    { ats: 'lever', re: /api(?:\.eu)?\.lever\.co\/v0\/postings\/([A-Za-z0-9_.-]+)/g },
    { ats: 'lever', re: /jobs(?:\.eu)?\.lever\.co\/([A-Za-z0-9_.-]+)/g },
    { ats: 'ashby', re: /api\.ashbyhq\.com\/posting-api\/job-board\/([A-Za-z0-9_.%-]+)/g },
    { ats: 'ashby', re: /jobs\.ashbyhq\.com\/([A-Za-z0-9_.%-]+)/g },
    { ats: 'workable', re: /apply\.workable\.com\/(?:api\/v\d\/(?:widget\/)?accounts\/)?([A-Za-z0-9_-]+)/g },
    { ats: 'workable', re: /\/\/([a-z0-9-]+)\.workable\.com/g },
    { ats: 'recruitee', re: /\/\/([a-z0-9-]+)\.recruitee\.com/g },
    { ats: 'smartrecruiters', re: /api\.smartrecruiters\.com\/v1\/companies\/([A-Za-z0-9_-]+)/g },
    { ats: 'smartrecruiters', re: /(?:careers|jobs)\.smartrecruiters\.com\/([A-Za-z0-9_-]+)/g },
    { ats: 'personio', re: /\/\/([a-z0-9-]+)\.jobs\.personio\.(de|com)/g },
    { ats: 'workday', re: /\/\/([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:wday\/cxs\/[a-z0-9-]+\/)?(?:[a-z]{2}-[A-Z]{2}\/)?([A-Za-z0-9_-]+)/g },
    { ats: 'workday', re: /\/\/(?:[a-z0-9-]+\.)?(wd\d+)\.myworkdaysite\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?recruiting\/([a-z0-9-]+)\/([A-Za-z0-9_-]+)/g, site: true },
];

/** The board a single link points at, or null. */
export function boardFromUrl(text) {
    const found = findBoards(String(text));
    return found[0] ?? null;
}

/** Every distinct board referenced in a piece of HTML or text, in order of first appearance. */
export function findBoards(html) {
    const hits = [];
    for (const p of BOARD_PATTERNS) {
        p.re.lastIndex = 0;
        let m;
        while ((m = p.re.exec(html))) {
            const board = toBoard(p, m);
            if (board) hits.push({ at: m.index, board });
        }
    }
    hits.sort((a, b) => a.at - b.at);
    const seen = new Set();
    const out = [];
    for (const { board } of hits) {
        const key = boardKey(board);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(board);
    }
    return out;
}

function toBoard(pattern, m) {
    if (pattern.ats === 'workday') {
        const [tenant, dc, site] = pattern.site ? [m[2], m[1], m[3]] : [m[1], m[2], m[3]];
        if (!site || NOT_SLUGS.has(site.toLowerCase()) || site === 'wday') return null;
        return { ats: 'workday', slug: tenant.toLowerCase(), host: `${tenant.toLowerCase()}.${dc}.myworkdayjobs.com`, site };
    }
    let slug = decodeURIComponent(m[1]);
    if (!slug || NOT_SLUGS.has(slug.toLowerCase())) return null;
    // Lever and Ashby slugs are case-insensitive in their APIs; SmartRecruiters company ids are not.
    if (pattern.ats !== 'smartrecruiters' && pattern.ats !== 'ashby') slug = slug.toLowerCase();
    const board = { ats: pattern.ats, slug };
    if (pattern.ats === 'lever' && /\.eu\.lever\.co/.test(m[0])) board.region = 'eu';
    if (pattern.ats === 'greenhouse' && /\.eu\.greenhouse\.io/.test(m[0])) board.region = 'eu';
    if (pattern.ats === 'personio') board.tld = m[2];
    return board;
}

export function boardKey(board) {
    return board.ats === 'workday' ? `workday:${board.host}/${board.site}` : `${board.ats}:${board.slug.toLowerCase()}`;
}

/**
 * Sorts one input string into what it is: an explicit "ats:slug" pair, a board link, or a company site to search.
 * Returns { kind: 'board', board } | { kind: 'site', url, domain } | { kind: 'invalid', error }.
 */
export function classifyInput(raw) {
    const input = String(raw ?? '').trim();
    if (!input) return { kind: 'invalid', error: 'empty entry' };
    const pair = input.match(/^([a-z]+)\s*:\s*([^/\s]+)$/i);
    if (pair && ATS_NAMES.includes(pair[1].toLowerCase()) && !/^\d+$/.test(pair[2])) {
        const ats = pair[1].toLowerCase();
        if (ats === 'workday') return { kind: 'invalid', error: 'Workday boards need the full careers link, e.g. https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite' };
        const slug = ['smartrecruiters', 'ashby'].includes(ats) ? pair[2] : pair[2].toLowerCase();
        return { kind: 'board', board: { ats, slug }, detectedBy: 'explicit' };
    }
    let url;
    try {
        url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`);
    } catch {
        return { kind: 'invalid', error: 'not a valid URL, domain or "ats:slug" pair' };
    }
    if (!['http:', 'https:'].includes(url.protocol)) return { kind: 'invalid', error: `unsupported scheme "${url.protocol}"` };
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(url.hostname)) return { kind: 'invalid', error: 'not a valid URL, domain or "ats:slug" pair' };
    const board = boardFromUrl(url.href);
    if (board) return { kind: 'board', board, detectedBy: 'url' };
    return { kind: 'site', url: url.href, domain: url.hostname.replace(/^www\./, '') };
}

/** Links on a company page that probably lead to its careers page, same site only, best first. */
export function careerLinks(html, baseUrl, limit = 3) {
    const $ = cheerio.load(html);
    const base = new URL(baseUrl);
    const scored = [];
    $('a[href]').each((_, a) => {
        const href = $(a).attr('href');
        let u;
        try {
            u = new URL(href, base);
        } catch {
            return;
        }
        if (!['http:', 'https:'].includes(u.protocol)) return;
        if (siteLabel(u.hostname) !== siteLabel(base.hostname)) return;
        const text = `${$(a).text()} ${u.pathname}`.toLowerCase();
        let score = 0;
        if (/careers?|karriere|carri[eè]re|carreras?/.test(text)) score += 3;
        if (/\bjobs?\b|open[- ]?(positions|roles)|vacanc|stellen|join[- ]?(us|the[- ]team)|work[- ]with[- ]us|hiring/.test(text)) score += 2;
        if (!score) return;
        u.hash = '';
        scored.push({ url: u.href, score });
    });
    scored.sort((a, b) => b.score - a.score);
    return [...new Set(scored.map((s) => s.url))].filter((u) => u !== base.href).slice(0, limit);
}

/** The name a company site gives itself: og:site_name, else the first part of its title. */
export function siteNameFromHtml(html) {
    const og = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i) ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["']/i);
    if (og) return decodeEntities(og[1]).trim() || null;
    const title = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1];
    if (!title) return null;
    return decodeEntities(title).split(/\s+[|–—-]\s+|:\s+/)[0].trim() || null;
}

/**
 * Whether a board found by guessing its slug plausibly belongs to the company asked about. A guessed slug can
 * be another company's board ("acme" on Lever may not be acme.com), so a guess is kept only when the board's
 * own company name matches the domain or the site's name. Boards that expose no name cannot be checked.
 */
export function nameMatches(boardCompany, domainLabel, siteName) {
    if (!boardCompany) return true;
    const norm = (v) => String(v ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
    const strip = (v) => norm(v).replace(/(incorporated|inc|llc|ltd|limited|gmbh|ag|sa|bv|plc|corp|corporation|company|co|technologies|technology|group|holdings)$/g, '');
    const b = strip(boardCompany);
    return [domainLabel, siteName].map(strip).filter((x) => x.length >= 2).some((x) => b === x || b.startsWith(x) || x.startsWith(b));
}

/** Board slugs worth trying for a bare domain when its pages link to no board: "acme-labs.io" gives acme-labs, acmelabs. */
export function guessSlugs(domain) {
    const label = siteLabel(domain);
    if (!label || label.length < 2) return [];
    return [...new Set([label, label.replace(/-/g, '')])];
}

// --- endpoints ----------------------------------------------------------------------------------------------

export function listRequest(board, { offset = 0, searchText = '' } = {}) {
    const s = encodeURIComponent(board.slug);
    switch (board.ats) {
        case 'greenhouse':
            return { url: `https://boards-api${board.region === 'eu' ? '.eu' : ''}.greenhouse.io/v1/boards/${s}/jobs?content=true&pay_transparency=true` };
        case 'lever':
            return { url: `https://api${board.region === 'eu' ? '.eu' : ''}.lever.co/v0/postings/${s}?mode=json` };
        case 'ashby':
            return { url: `https://api.ashbyhq.com/posting-api/job-board/${s}?includeCompensation=true` };
        case 'workable':
            return { url: `https://apply.workable.com/api/v1/widget/accounts/${s}?details=true` };
        case 'recruitee':
            return { url: `https://${s}.recruitee.com/api/offers/` };
        case 'smartrecruiters':
            return { url: `https://api.smartrecruiters.com/v1/companies/${s}/postings?limit=100&offset=${offset}` };
        case 'personio':
            return { url: `https://${s}.jobs.personio.${board.tld ?? 'de'}/xml?language=en` };
        case 'workday':
            return {
                url: `https://${board.host}/wday/cxs/${board.slug}/${board.site}/jobs`,
                method: 'POST',
                json: { appliedFacets: {}, limit: 20, offset, searchText },
            };
        default:
            throw new Error(`unknown ATS ${board.ats}`);
    }
}

/** URL of one job's own record, for boards whose list omits the description or the exact date. */
export function detailUrl(board, job) {
    if (board.ats === 'workday') return `https://${board.host}/wday/cxs/${board.slug}/${board.site}${job.raw?.externalPath ?? job._externalPath}`;
    if (board.ats === 'smartrecruiters') return `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(board.slug)}/postings/${job.jobId}`;
    return null;
}

/**
 * Lever, Ashby and Workday APIs carry no company name, but the board's own page does. Other boards name the
 * company in their data, so they return null here and need no extra request.
 */
export function boardPageUrl(board) {
    if (board.ats === 'lever') return `https://jobs${board.region === 'eu' ? '.eu' : ''}.lever.co/${encodeURIComponent(board.slug)}`;
    if (board.ats === 'ashby') return `https://jobs.ashbyhq.com/${encodeURIComponent(board.slug)}`;
    if (board.ats === 'workday') return `https://${board.host}/${board.site}`;
    return null;
}

export function companyFromBoardPage(board, html) {
    const pick = (re) => decodeEntities(html.match(re)?.[1] ?? '').trim() || null;
    if (board.ats === 'ashby') return pick(/"organizationName":"([^"]+)"/) ?? pick(/<title[^>]*>([^<]*?)\s*Jobs\s*<\/title>/i);
    if (board.ats === 'lever') return pick(/<title[^>]*>([^<]+)<\/title>/i);
    if (board.ats === 'workday') return pick(/property="og:title" content="(?:careers\s+at\s+)?([^"]+)"/i);
    return null;
}

/** "acme-labs" to "Acme Labs", the last resort when a board names no company. */
export function prettySlug(slug) {
    return String(slug).replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Which boards need one extra request per job for the description (and, on Workday, the exact date). */
export function needsDetails(board, { includeDescription, workdayDetails }) {
    if (board.ats === 'workday') return workdayDetails;
    if (board.ats === 'smartrecruiters') return includeDescription;
    return false;
}

export const PAGE_SIZE = { smartrecruiters: 100, workday: 20 };

// --- list parsing -------------------------------------------------------------------------------------------

/**
 * Turns a list response into { exists, jobs, total, company }. `exists: false` means the board is not there
 * (the API's own not-found answer), which is reported as an input error rather than retried.
 */
export function parseList(board, status, body) {
    if (board.ats === 'personio') {
        if (status >= 300 && status < 400) return { exists: false };
        if (status === 404) return { exists: false };
        return { exists: true, ...parsePersonio(board, body) };
    }
    if (status === 404 || status === 410) return { exists: false };
    const data = typeof body === 'string' ? JSON.parse(body) : body;
    switch (board.ats) {
        case 'greenhouse': {
            const jobs = (data.jobs ?? []).map((j) => mapGreenhouse(board, j));
            return { exists: true, jobs, total: jobs.length, company: data.jobs?.[0]?.company_name ?? null };
        }
        case 'lever': {
            if (!Array.isArray(data)) return { exists: false };
            return { exists: true, jobs: data.map((j) => mapLever(board, j)), total: data.length };
        }
        case 'ashby': {
            const listed = (data.jobs ?? []).filter((j) => j.isListed !== false);
            return { exists: true, jobs: listed.map((j) => mapAshby(board, j)), total: listed.length };
        }
        case 'workable': {
            const jobs = (data.jobs ?? []).map((j) => mapWorkable(board, j, data.name));
            return { exists: true, jobs, total: jobs.length, company: data.name ?? null };
        }
        case 'recruitee': {
            const jobs = (data.offers ?? []).map((j) => mapRecruitee(board, j));
            return { exists: true, jobs, total: jobs.length, company: data.offers?.[0]?.company_name ?? null };
        }
        case 'smartrecruiters': {
            // An unknown company id answers 200 with nothing in it, the same as a real company with no openings.
            const jobs = (data.content ?? []).map((j) => mapSmartRecruiters(board, j));
            return { exists: data.totalFound > 0 || null, jobs, total: data.totalFound ?? jobs.length, company: data.content?.[0]?.company?.name ?? null };
        }
        case 'workday': {
            const jobs = (data.jobPostings ?? []).map((j) => mapWorkdayListItem(board, j));
            return { exists: true, jobs, total: data.total ?? jobs.length };
        }
        default:
            throw new Error(`unknown ATS ${board.ats}`);
    }
}

/** Folds a job's own record into the row built from the list. */
export function applyDetail(board, job, body) {
    const data = typeof body === 'string' ? JSON.parse(body) : body;
    if (board.ats === 'workday') {
        const info = data.jobPostingInfo ?? {};
        const locations = [info.location, ...(info.additionalLocations ?? [])].filter(Boolean);
        return {
            ...job,
            jobId: info.jobReqId ?? job.jobId,
            url: info.externalUrl ?? job.url,
            applyUrl: info.externalUrl ? `${info.externalUrl}/apply` : job.applyUrl,
            location: info.location ?? job.location,
            locations: locations.length ? locations : job.locations,
            country: info.country?.descriptor ?? job.country,
            employmentType: normalizeEmploymentType(info.timeType) ?? job.employmentType,
            ...workplace(info.remoteType ?? null, [info.title, info.location].join(' ')),
            postedAt: isoDate(info.startDate) ?? job.postedAt,
            postedAtApproximate: info.startDate ? false : job.postedAtApproximate,
            descriptionHtml: info.jobDescription ?? null,
            ...salaryFromText(htmlToText(info.jobDescription)),
            raw: { ...job.raw, detail: info },
        };
    }
    if (board.ats === 'smartrecruiters') {
        const sections = data.jobAd?.sections ?? {};
        const html = ['jobDescription', 'qualifications', 'additionalInformation', 'companyDescription']
            .map((k) => sections[k])
            .filter((s) => s?.text)
            .map((s) => (s.title ? `<h3>${s.title}</h3>${s.text}` : s.text))
            .join('\n');
        return {
            ...job,
            url: data.postingUrl ?? job.url,
            applyUrl: data.applyUrl ?? job.applyUrl,
            descriptionHtml: html || null,
            ...salaryFromText(htmlToText(html)),
            raw: { ...job.raw, detail: { jobAd: data.jobAd, postingUrl: data.postingUrl } },
        };
    }
    return job;
}

function base(board, fields) {
    for (const k of ['title', 'company', 'location', 'department', 'team', 'country']) {
        if (typeof fields[k] === 'string') fields[k] = fields[k].replace(/\s+/g, ' ').trim() || null;
    }
    return {
        ok: true,
        ats: board.ats,
        company: null,
        boardSlug: board.ats === 'workday' ? `${board.host}/${board.site}` : board.slug,
        jobId: null,
        title: null,
        url: null,
        applyUrl: null,
        location: null,
        locations: [],
        country: null,
        remote: null,
        workplaceType: null,
        employmentType: null,
        department: null,
        team: null,
        postedAt: null,
        postedAtApproximate: false,
        updatedAt: null,
        salaryMin: null,
        salaryMax: null,
        salaryCurrency: null,
        salaryPeriod: null,
        salaryText: null,
        salarySource: null,
        descriptionHtml: null,
        ...fields,
    };
}

function mapGreenhouse(board, j) {
    const html = decodeEntities(j.content ?? '');
    const offices = (j.offices ?? []).map((o) => o.location || o.name).filter(Boolean);
    const location = j.location?.name ?? null;
    const pay = greenhousePay(j.pay_input_ranges);
    return base(board, {
        company: j.company_name ?? null,
        jobId: String(j.id),
        title: j.title ?? null,
        url: j.absolute_url ?? null,
        applyUrl: j.absolute_url ?? null,
        location,
        locations: unique([location, ...offices]),
        ...workplace(null, location),
        department: j.departments?.[0]?.name ?? null,
        postedAt: isoDate(j.first_published),
        updatedAt: isoDate(j.updated_at),
        descriptionHtml: html || null,
        ...(pay ?? salaryFromText(htmlToText(html))),
        raw: j,
    });
}

/**
 * Greenhouse pay transparency: one range per pay zone, in cents. The row gets the span across zones; each zone's
 * own range stays in raw.pay_input_ranges.
 */
function greenhousePay(ranges) {
    const valid = (ranges ?? []).filter((r) => r.min_cents > 0 || r.max_cents > 0);
    if (!valid.length) return null;
    const min = Math.min(...valid.map((r) => r.min_cents || r.max_cents)) / 100;
    const max = Math.max(...valid.map((r) => r.max_cents || r.min_cents)) / 100;
    const label = valid.map((r) => r.title).filter(Boolean).join('; ');
    const period = leverInterval(label.toLowerCase()) ?? (/hourly/i.test(label) ? 'hour' : min < 1000 ? 'hour' : 'year');
    return { salaryMin: min, salaryMax: max, salaryCurrency: valid[0].currency_type ?? null, salaryPeriod: period, salaryText: label || null, salarySource: 'ats' };
}

function mapLever(board, j) {
    const cat = j.categories ?? {};
    const html = [j.description, ...(j.lists ?? []).map((l) => `<h3>${l.text}</h3><ul>${l.content}</ul>`), j.additional].filter(Boolean).join('\n');
    const salary = j.salaryRange
        ? {
            salaryMin: num(j.salaryRange.min),
            salaryMax: num(j.salaryRange.max),
            salaryCurrency: j.salaryRange.currency ?? null,
            salaryPeriod: leverInterval(j.salaryRange.interval),
            salaryText: j.salaryDescriptionPlain?.trim() || null,
            salarySource: 'ats',
        }
        : salaryFromText(htmlToText(html));
    return base(board, {
        jobId: j.id,
        title: j.text ?? null,
        url: j.hostedUrl ?? null,
        applyUrl: j.applyUrl ?? null,
        location: cat.location ?? null,
        locations: unique([cat.location, ...(cat.allLocations ?? [])]),
        country: j.country ?? null,
        ...workplace(j.workplaceType, cat.location),
        employmentType: normalizeEmploymentType(cat.commitment),
        department: cat.department ?? null,
        team: cat.team ?? null,
        postedAt: isoDate(j.createdAt),
        descriptionHtml: html || null,
        ...salary,
        raw: j,
    });
}

function mapAshby(board, j) {
    const comp = (j.compensation?.compensationTiers ?? []).flatMap((t) => t.components ?? []).find((c) => c.compensationType === 'Salary' && (c.minValue || c.maxValue));
    const html = j.descriptionHtml ?? '';
    const salary = comp
        ? {
            salaryMin: num(comp.minValue),
            salaryMax: num(comp.maxValue),
            salaryCurrency: comp.currencyCode ?? null,
            salaryPeriod: ashbyInterval(comp.interval),
            salaryText: j.compensation?.compensationTierSummary ?? comp.summary ?? null,
            salarySource: 'ats',
        }
        : salaryFromText(j.descriptionPlain ?? htmlToText(html));
    const addr = j.address?.postalAddress ?? {};
    return base(board, {
        jobId: j.id,
        title: j.title ?? null,
        url: j.jobUrl ?? null,
        applyUrl: j.applyUrl ?? null,
        location: j.location ?? null,
        locations: unique([j.location, ...(j.secondaryLocations ?? []).map((s) => s.location)]),
        country: addr.addressCountry ?? null,
        ...workplace(j.workplaceType ?? (j.isRemote ? 'remote' : null), j.location),
        employmentType: normalizeEmploymentType(j.employmentType),
        department: j.department ?? null,
        team: j.team ?? null,
        postedAt: isoDate(j.publishedAt),
        descriptionHtml: html || null,
        ...salary,
        raw: j,
    });
}

function mapWorkable(board, j, company) {
    const locs = (j.locations ?? []).map((l) => [l.city, l.region, l.country].filter(Boolean).join(', '));
    const location = [j.city, j.state, j.country].filter(Boolean).join(', ') || null;
    const remote = j.telecommuting === true || j.telecommuting === 'True' || j.telecommuting === 'true';
    const html = j.description ?? '';
    return base(board, {
        company: company ?? null,
        jobId: j.shortcode ?? null,
        title: j.title ?? null,
        url: j.url ?? j.shortlink ?? null,
        applyUrl: j.application_url ?? null,
        location,
        locations: unique([location, ...locs]),
        country: j.country ?? null,
        ...(remote ? { remote: true, workplaceType: 'remote' } : workplace(null, location)),
        employmentType: normalizeEmploymentType(j.employment_type),
        department: j.department || null,
        postedAt: isoDate(j.published_on ?? j.created_at),
        descriptionHtml: html || null,
        ...salaryFromText(htmlToText(html)),
        raw: j,
    });
}

function mapRecruitee(board, j) {
    const html = [j.description, j.requirements].filter(Boolean).join('\n');
    const s = j.salary ?? {};
    const salary = s.min || s.max
        ? { salaryMin: num(s.min), salaryMax: num(s.max), salaryCurrency: s.currency ?? null, salaryPeriod: normalizePeriod(s.period), salaryText: null, salarySource: 'ats' }
        : salaryFromText(htmlToText(html));
    const type = j.remote ? 'remote' : j.hybrid ? 'hybrid' : j.on_site ? 'onsite' : null;
    return base(board, {
        company: j.company_name ?? null,
        jobId: String(j.id),
        title: j.title ?? null,
        url: j.careers_url ?? null,
        applyUrl: j.careers_apply_url ?? null,
        location: j.location ?? null,
        locations: unique([j.location, ...(j.locations ?? []).map((l) => [l.city, l.country].filter(Boolean).join(', '))]),
        country: j.country ?? null,
        ...workplace(type, j.location),
        employmentType: normalizeEmploymentType(j.employment_type_code),
        department: j.department ?? null,
        postedAt: isoDate(j.published_at ?? j.created_at),
        updatedAt: isoDate(j.updated_at),
        descriptionHtml: html || null,
        ...salary,
        raw: j,
    });
}

function mapSmartRecruiters(board, j) {
    const loc = j.location ?? {};
    const location = loc.fullLocation ?? ([loc.city, loc.region, loc.country?.toUpperCase()].filter(Boolean).join(', ') || null);
    return base(board, {
        company: j.company?.name ?? null,
        jobId: String(j.id),
        title: j.name ?? null,
        url: `https://jobs.smartrecruiters.com/${encodeURIComponent(board.slug)}/${j.id}`,
        applyUrl: `https://jobs.smartrecruiters.com/${encodeURIComponent(board.slug)}/${j.id}?oga=true`,
        location,
        locations: unique([location]),
        country: loc.country ? loc.country.toUpperCase() : null,
        ...(loc.remote ? { remote: true, workplaceType: 'remote' } : workplace(loc.hybrid ? 'hybrid' : null, location)),
        employmentType: j.experienceLevel?.id === 'internship' ? 'internship' : normalizeEmploymentType(j.typeOfEmployment?.label),
        department: j.department?.label ?? j.function?.label ?? null,
        postedAt: isoDate(j.releasedDate),
        raw: j,
    });
}

function mapWorkdayListItem(board, j) {
    const posted = parseWorkdayPostedOn(j.postedOn);
    return base(board, {
        company: board.company ?? null,
        jobId: j.bulletFields?.[0] ?? j.externalPath ?? null,
        title: j.title ?? null,
        url: `https://${board.host}/${board.site}${j.externalPath}`,
        applyUrl: `https://${board.host}/${board.site}${j.externalPath}/apply`,
        location: j.locationsText ?? null,
        locations: unique([j.locationsText]),
        ...workplace(j.remoteType ?? null, j.locationsText),
        postedAt: posted.date,
        postedAtApproximate: posted.approximate,
        raw: j,
        _externalPath: j.externalPath,
        ...(posted.olderThanDays !== undefined ? { _olderThanDays: posted.olderThanDays } : {}),
    });
}

function parsePersonio(board, xml) {
    const $ = cheerio.load(xml, { xmlMode: true });
    const jobs = [];
    $('position').each((_, el) => {
        const p = $(el);
        const text = (sel) => p.children(sel).first().text().trim() || null;
        const offices = unique([text('office'), ...p.find('additionalOffices > office').map((__, o) => $(o).text().trim()).get()]);
        const html = p.find('jobDescriptions > jobDescription').map((__, d) => {
            const name = $(d).children('name').text().trim();
            const value = $(d).children('value').text().trim();
            return `${name ? `<h3>${name}</h3>` : ''}${value}`;
        }).get().join('\n');
        const id = text('id');
        jobs.push(base(board, {
            company: text('subcompany'),
            jobId: id,
            title: text('name'),
            url: `https://${board.slug}.jobs.personio.${board.tld ?? 'de'}/job/${id}`,
            applyUrl: `https://${board.slug}.jobs.personio.${board.tld ?? 'de'}/job/${id}#apply`,
            location: offices[0] ?? null,
            locations: offices,
            ...workplace(null, offices.join(' ')),
            employmentType: normalizeEmploymentType(text('schedule') ?? text('employmentType')),
            department: text('department'),
            team: text('recruitingCategory'),
            postedAt: isoDate(text('createdAt')),
            descriptionHtml: html || null,
            ...salaryFromText(htmlToText(html)),
            raw: { id, subcompany: text('subcompany'), office: text('office'), department: text('department'), recruitingCategory: text('recruitingCategory'), employmentType: text('employmentType'), seniority: text('seniority'), schedule: text('schedule'), yearsOfExperience: text('yearsOfExperience'), occupation: text('occupation'), occupationCategory: text('occupationCategory'), keywords: text('keywords'), createdAt: text('createdAt') },
        }));
    });
    return { jobs, total: jobs.length, company: jobs[0]?.company ?? null };
}

// --- normalisation ------------------------------------------------------------------------------------------

/** { remote, workplaceType } from the board's own flag when it has one, else from the location text. */
function workplace(declared, locationText) {
    const d = String(declared ?? '').toLowerCase().replace(/[\s_-]/g, '');
    if (d === 'remote' || d === 'fullyremote') return { remote: true, workplaceType: 'remote' };
    if (d === 'hybrid') return { remote: false, workplaceType: 'hybrid' };
    if (d === 'onsite' || d === 'inoffice' || d === 'office') return { remote: false, workplaceType: 'onsite' };
    if (/\bremote\b/i.test(locationText ?? '')) return { remote: true, workplaceType: 'remote' };
    if (/\bhybrid\b/i.test(locationText ?? '')) return { remote: false, workplaceType: 'hybrid' };
    return { remote: null, workplaceType: null };
}

export function normalizeEmploymentType(raw) {
    if (!raw) return null;
    const s = String(raw).toLowerCase();
    if (/intern|praktik|stage\b|werkstudent|working student/.test(s)) return 'internship';
    if (/part/.test(s)) return 'part-time';
    if (/contract|freelance|contractor|consult/.test(s)) return 'contract';
    if (/temp|fixed[- ]?term|befristet/.test(s)) return 'temporary';
    if (/full|permanent|regular|fulltime|unbefristet/.test(s)) return 'full-time';
    return s;
}

function leverInterval(i) {
    const s = String(i ?? '');
    if (/hour/.test(s)) return 'hour';
    if (/day/.test(s)) return 'day';
    if (/week/.test(s)) return 'week';
    if (/month/.test(s)) return 'month';
    if (/year|annual/.test(s)) return 'year';
    return null;
}

function ashbyInterval(i) {
    return leverInterval(String(i ?? '').toLowerCase());
}

function normalizePeriod(p) {
    return leverInterval(String(p ?? '').toLowerCase());
}

const CURRENCY_SYMBOLS = { $: 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR', 'C$': 'CAD', 'A$': 'AUD', 'CA$': 'CAD', 'AU$': 'AUD' };
const CURRENCY_CODES = 'USD|EUR|GBP|CAD|AUD|CHF|SEK|NOK|DKK|PLN|INR|JPY|SGD|NZD|BRL|MXN|ZAR|AED|ILS|CZK';

/**
 * A salary range stated in the description ("$150,000 - $200,000", "136,000 USD - 212,750 USD", "€60.000–€80.000
 * per year", "USD 45 to 60 per hour"). Conservative on purpose: it needs a currency and two numbers, the pair has to
 * be plausible pay for its period, and a figure under 1,000 without a period is ignored, because descriptions are
 * full of other numbers. Ranges stated per level next to each other ("... for Level 3, and ... for Level 4") are
 * spanned into one, the same way pay zones are.
 */
export function salaryFromText(text) {
    const none = { salaryMin: null, salaryMax: null, salaryCurrency: null, salaryPeriod: null, salaryText: null, salarySource: null };
    if (!text) return none;
    const found = salaryMatches(text);
    if (!found.length) return none;
    const first = found[0];
    const group = found.filter((m) => m.currency === first.currency && m.period === first.period && m.index - first.end < 250 && m.lo >= first.lo / 3 && m.hi <= first.hi * 3);
    const last = group.at(-1);
    return {
        salaryMin: Math.min(...group.map((m) => m.lo)),
        salaryMax: Math.max(...group.map((m) => m.hi)),
        salaryCurrency: first.currency,
        salaryPeriod: first.period,
        salaryText: text.slice(first.index, last.end).replace(/\s+/g, ' ').trim(),
        salarySource: 'description',
    };
}

const SYMBOL = '(C\\$|A\\$|CA\\$|AU\\$|[$€£¥₹])';
const CODE = `\\b(${CURRENCY_CODES})\\b`;
const AMOUNT = '(\\d{1,3}(?:[,.\\s]\\d{3})+|\\d+(?:\\.\\d+)?)\\s?([kK])?';
const DASH = '\\s*(?:-|–|—|to|bis|à)\\s*';
// Currency first: "$150,000 - $200,000", "USD 45 - 60". Groups: symbol, code, amount, k, symbol, code, amount, k.
const CURRENCY_FIRST = new RegExp(`(?:${SYMBOL}|${CODE})\\s?${AMOUNT}(?:\\s?(?:${CURRENCY_CODES}))?${DASH}(?:(?:${SYMBOL}|${CODE})\\s?)?${AMOUNT}`, 'g');
// Amount first: "136,000 USD - 212,750 USD", "60.000 € - 80.000 €". Groups: amount, k, symbol, code, amount, k.
const AMOUNT_FIRST = new RegExp(`${AMOUNT}\\s?(?:${SYMBOL}|${CODE})${DASH}${AMOUNT}(?:\\s?(?:[$€£]|${CURRENCY_CODES}))?`, 'g');

function salaryMatches(text) {
    const out = [];
    const add = (m, sym, code, a1, k1, a2, k2) => {
        const lo = parseAmount(a1, k1);
        const hi = parseAmount(a2, k2);
        if (!lo || !hi || hi < lo || hi > lo * 10) return;
        const end = m.index + m[0].length;
        const tail = text.slice(m.index, end + 40).toLowerCase();
        let period = /hour|\/hr|\bhr\b|hourly|stunde/.test(tail) ? 'hour'
            : /month|\/mo\b|monthly|monat/.test(tail) ? 'month'
                : /year|annual|\/yr|\bp\.?a\.?\b|jahr|salary/.test(tail) ? 'year' : null;
        if (!period) period = lo >= 1000 ? 'year' : null;
        // A range that is implausible for its period is some other pair of numbers ("$1 - 2 years of experience").
        const plausible = { year: lo >= 1000 && hi <= 5e6, month: lo >= 100 && hi <= 5e5, hour: lo >= 5 && hi <= 1000 }[period];
        if (!plausible) return;
        out.push({ index: m.index, end, lo, hi, currency: sym ? CURRENCY_SYMBOLS[sym] : code, period });
    };
    for (const m of text.matchAll(CURRENCY_FIRST)) add(m, m[1], m[2], m[3], m[4], m[7], m[8]);
    for (const m of text.matchAll(AMOUNT_FIRST)) add(m, m[3], m[4], m[1], m[2], m[5], m[6]);
    return out.sort((a, b) => a.index - b.index);
}

function parseAmount(digits, k) {
    if (!digits) return null;
    // "150,000", "60.000" and "60 000" are thousands separators; "52.5k" is a decimal.
    const n = /^\d{1,3}([,.\s]\d{3})+$/.test(digits) ? Number(digits.replace(/[,.\s]/g, '')) : Number(digits);
    if (!Number.isFinite(n)) return null;
    return Math.round(k ? n * 1000 : n);
}

/** "Posted Today", "Posted Yesterday", "Posted 3 Days Ago", "Posted 30+ Days Ago" to an approximate ISO date. */
export function parseWorkdayPostedOn(text, now = new Date()) {
    const s = String(text ?? '').toLowerCase();
    const day = 24 * 3600 * 1000;
    const at = (days) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - days * day).toISOString();
    if (/today/.test(s)) return { date: at(0), approximate: true };
    if (/yesterday/.test(s)) return { date: at(1), approximate: true };
    const m = s.match(/(\d+)(\+)?\s*days?\s*ago/);
    if (m && !m[2]) return { date: at(Number(m[1])), approximate: true };
    if (m && m[2]) return { date: null, approximate: true, olderThanDays: Number(m[1]) };
    return { date: null, approximate: false };
}

function isoDate(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v).toISOString();
    const s = String(v).trim().replace(/ UTC$/, 'Z').replace(/^(\d{4}-\d{2}-\d{2}) (\d)/, '$1T$2');
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function num(v) {
    const n = Number(v);
    return v === null || v === undefined || v === '' || !Number.isFinite(n) ? null : n;
}

function unique(list) {
    return [...new Set(list.map((s) => (s ?? '').trim()).filter(Boolean))];
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', euro: '€', pound: '£', bull: '•', middot: '·' };

export function decodeEntities(s) {
    return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, code) => {
        if (code[0] === '#') {
            const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
            return Number.isFinite(n) ? String.fromCodePoint(n) : all;
        }
        return ENTITIES[code.toLowerCase()] ?? all;
    });
}

/** Readable plain text from job-description HTML: paragraphs and list items on their own lines. */
export function htmlToText(html) {
    if (!html) return '';
    return decodeEntities(String(html)
        .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
        .replace(/<li[^>]*>/gi, '\n- ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|h[1-6]|li|ul|ol|tr|section)>/gi, '\n')
        .replace(/<[^>]+>/g, ''))
        .replace(/[ \t ]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// --- filters ------------------------------------------------------------------------------------------------

/**
 * Compiles the input filters once. Keywords match case-insensitively anywhere in the field; a job passes when it
 * matches any include keyword (or there are none) and no exclude keyword.
 */
export function compileFilters({ titleKeywords, excludeTitleKeywords, locationKeywords, remoteOnly, postedWithinDays }, now = Date.now()) {
    const list = (v) => (Array.isArray(v) ? v : v ? String(v).split(/[\n,;]+/) : []).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
    const inc = list(titleKeywords);
    const exc = list(excludeTitleKeywords);
    const loc = list(locationKeywords);
    const days = Number(postedWithinDays) > 0 ? Number(postedWithinDays) : 0;
    const cutoff = days ? now - days * 24 * 3600 * 1000 : null;
    return {
        titleKeywords: inc,
        cutoff,
        /** Returns null when the job passes, else the reason it was left out. */
        reject(job) {
            const title = (job.title ?? '').toLowerCase();
            if (inc.length && !inc.some((k) => title.includes(k))) return 'title';
            if (exc.some((k) => title.includes(k))) return 'title';
            if (loc.length) {
                const where = [job.location, ...(job.locations ?? []), job.country, job.workplaceType].join(' | ').toLowerCase();
                if (!loc.some((k) => where.includes(k))) return 'location';
            }
            if (remoteOnly && !(job.remote === true || job.workplaceType === 'remote')) return 'remote';
            if (cutoff) {
                if (job.postedAt) {
                    if (Date.parse(job.postedAt) < cutoff) return 'date';
                } else if (!(job._olderThanDays !== undefined && job._olderThanDays < days)) {
                    return 'date';
                }
            }
            return null;
        },
    };
}

/** A key-value store key for a board's "seen jobs" record; keys allow only [a-zA-Z0-9!-_.'()] and 256 chars. */
export function stateKey(board) {
    return `seen-${boardKey(board)}`.replace(/[^a-zA-Z0-9!\-_.'()]/g, '_').slice(0, 250);
}
