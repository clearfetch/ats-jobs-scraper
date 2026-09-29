# ATS Jobs Scraper - Greenhouse, Lever, Ashby, Workday & More

**Run it on Apify: [apify.com/clearfetch/ats-jobs-scraper](https://apify.com/clearfetch/ats-jobs-scraper)**

Get every open job from company career sites, straight from the applicant tracking system behind them:
Greenhouse, Lever, Ashby, Workday, Workable, SmartRecruiters, Recruitee and Personio. Paste a careers page, a
plain company domain or a job board link, and the Actor finds the board, reads it through the board's public API
and returns every job in one flat schema, with salary ranges, remote flags and post dates. **$1.00 per 1,000
jobs.** No login, no proxy, no browser.

## What data you get

One row per job, the same columns whichever board it came from:

- `company`, `title`, `url` (the posting), `applyUrl`, `jobId` (stable, so it works as a key across runs)
- `location`, `locations` (every location listed), `country`, `remote`, `workplaceType` (remote, hybrid, onsite)
- `employmentType` (full-time, part-time, contract, internship, temporary), `department`, `team`
- `postedAt`, `updatedAt`
- Pay: `salaryMin`, `salaryMax`, `salaryCurrency`, `salaryPeriod` (year, month, hour), `salaryText`, and
  `salarySource`, which says whether the board publishes the range as data (`ats`: Greenhouse pay transparency,
  Lever, Ashby, Recruitee) or it was read from the job text (`description`)
- `description` as plain text, and optionally `descriptionHtml` and the board's untouched record in `raw`
- `ats`, `boardSlug`, `detectedBy` (how the board was found) and `isNew` for scheduled monitoring

A `SUMMARY` record in the run's key-value store lists every company with how its board was found, how many jobs
the board has, how many passed your filters and how many were written.

## How to use

1. Add companies, one per line: `stripe.com`, `https://jobs.lever.co/palantir`, a careers page, or a pair such
   as `greenhouse:airbnb`.
2. Optionally filter by title words, location, remote, or jobs posted in the last N days. For monitoring, turn
   on **Only jobs not seen in earlier runs** and put the Actor on a schedule.
3. Run it, then download JSON, CSV or Excel, or pull the rows through the API.

## Input

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `companies` | array | — | Board links, careers pages, domains or `ats:slug` pairs. Also `urls`, `startUrls`, `domains`. |
| `titleKeywords` | array | `[]` | Keep jobs whose title contains any of these. Also searched on Workday's side. |
| `excludeTitleKeywords` | array | `[]` | Leave out jobs whose title contains any of these. |
| `locationKeywords` | array | `[]` | Keep jobs whose location, country or workplace type contains any of these. |
| `remoteOnly` | boolean | `false` | Only remote jobs. |
| `postedWithinDays` | integer | `0` | Only jobs published in the last N days (0 = all). |
| `onlyNew` | boolean | `false` | Write only jobs not written in earlier runs, per board. The first run returns everything. |
| `stateStoreName` | string | `ats-jobs-scraper-state` | Where `onlyNew` remembers what it has seen. |
| `maxJobsPerCompany` | integer | `0` | Stop after this many jobs per board (0 = all). |
| `maxItems` | integer | `0` | Stop the run after this many jobs (0 = no limit). |
| `includeDescription` | boolean | `true` | Description as plain text. |
| `includeDescriptionHtml` | boolean | `false` | Description as HTML too. |
| `workdayDetails` | boolean | `true` | Read each Workday job's own record for its exact date, locations and description. |
| `guessBoards` | boolean | `true` | When a site links to no board, try its domain name as a board id and keep it only if the company name fits. |
| `includeRaw` | boolean | `false` | The board's own record for each job. |
| `maxConcurrency` | integer | `10` | Boards read at the same time (1-50). |
| `timeoutSecs` | integer | `30` | Per request. |
| `proxyConfiguration` | object | off | Not needed; available if you want your own IPs. |

Example:

```json
{
    "companies": ["stripe.com", "https://jobs.lever.co/palantir", "greenhouse:figma", "https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite"],
    "titleKeywords": ["engineer"],
    "locationKeywords": ["remote", "united states"],
    "postedWithinDays": 14
}
```

## Output example

A real row from a run on 2026-09-29 (description shortened here):

```json
{
    "ok": true,
    "ats": "ashby",
    "company": "Ramp",
    "boardSlug": "ramp",
    "jobId": "34413f8d-26bf-4bbc-8ade-eb309a0e2245",
    "title": "Security Engineer, Cloud",
    "url": "https://jobs.ashbyhq.com/ramp/34413f8d-26bf-4bbc-8ade-eb309a0e2245",
    "applyUrl": "https://jobs.ashbyhq.com/ramp/34413f8d-26bf-4bbc-8ade-eb309a0e2245/application",
    "location": "New York, NY (HQ)",
    "locations": ["New York, NY (HQ)", "Remote (Canada)", "Remote (US)", "Miami, FL"],
    "country": "USA",
    "remote": false,
    "workplaceType": "hybrid",
    "employmentType": "full-time",
    "department": "Engineering",
    "team": "Backend",
    "postedAt": "2026-04-07T17:12:35.753Z",
    "postedAtApproximate": false,
    "updatedAt": null,
    "salaryMin": 211400,
    "salaryMax": 290600,
    "salaryCurrency": "USD",
    "salaryPeriod": "year",
    "salaryText": "$211.4K – $290.6K • Offers Equity",
    "salarySource": "ats",
    "description": "About Ramp\nRamp is building the smart infrastructure for finance teams, embedded in the transaction flow of every dollar a business spends. We automate how over $200B in annualized spend flows in and out of 70,000+ companies: authorizing payments, flagging ris …",
    "isNew": null,
    "detectedBy": "url",
    "inputUrl": "https://jobs.ashbyhq.com/ramp",
    "scrapedAt": "2026-09-29T12:18:10.134Z"
}
```

An input that cannot be read comes back as one row with `ok: false` and a plain reason, such as
`no lever job board found for "acme"` or `no supported job board is linked from this site or its careers page`.
Those rows are free.

## Pricing

- **$0.001 per job**, which is $1.00 per 1,000. A company with 200 open jobs costs $0.20.
- You pay only for jobs written to your dataset. Inputs that fail, jobs your filters leave out and, with
  `onlyNew`, jobs already seen in earlier runs are never charged.
- Set a maximum cost on the run and it stops cleanly when it gets there.

## Use cases

- **Sales prospecting on hiring signals**: which target accounts are hiring for the role your product serves,
  with the department and location, every morning.
- **Recruiting and talent intelligence**: competitors' open roles, salary bands and where they hire.
- **Job boards and newsletters**: fresh postings from a curated list of companies, straight from the source,
  with only-new mode for daily updates.
- **Market and compensation research**: pay ranges by title, level and location across hundreds of companies.
- **Investors**: headcount growth and hiring focus across a portfolio or a watchlist.

## FAQ

**Which job boards are supported?** Greenhouse, Lever, Ashby, Workday, Workable, SmartRecruiters, Recruitee and
Personio. Together they run the careers pages of most tech companies and a large share of enterprises.

**What if I only know the company's website?** Give the domain or the careers page. The Actor looks for a board
link or embed on the home page, then on the careers page it links to. If there is none, it tries the domain
name as a board id and keeps a match only when the board's company name fits; those rows say
`detectedBy: "slug-guess"`. A site that runs its own careers system comes back as a free error row.

**Do I need a proxy?** No. These are the public APIs the boards publish for career sites, so they answer
ordinary requests. The proxy option is there only if you want to use your own IPs.

**How fresh is the data?** Live: every run reads the boards at that moment, nothing is cached.

**Why is a Workday date marked approximate?** Workday's list says "Posted 3 Days Ago". With **Read each Workday
job** on (the default), the exact date comes from each job's record and `postedAtApproximate` is false.

**Why does a salary sometimes come from the description?** Many boards do not publish pay as data. When a
posting states a range in its text ("$60,000 - $97,000/year"), it is read from there and marked
`salarySource: "description"`. The reader is deliberately strict and ignores numbers that are not clearly pay.

**How does only-new mode work?** For each board it remembers the ids of jobs it has written, in a key-value
store in your account. The next run writes only ids it has not seen. Jobs that close are dropped from memory,
so a re-posted role counts as new again.

**Is it legal?** It reads job postings that companies publish so that anyone can see them, through the APIs the
boards provide for that. You are responsible for how you use the data.

## Integrations

Run it from the Apify API or a client library, schedule it in Apify Console, or connect it to n8n, Make,
Zapier or any MCP client through Apify's integrations. Results are available as JSON, CSV, Excel and through
the dataset API.

## Changelog

- **1.0.0** (2026-09) — first release: eight job boards, board detection from careers pages and domains, one
  schema with salary, remote flag and post date, Greenhouse pay transparency, title, location, remote and date
  filters, only-new mode for schedules, per-company summary.
