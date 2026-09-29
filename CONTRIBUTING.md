# Working on this Actor

```bash
npm install
node test/ats.test.mjs                  # unit tests against real board responses, no network
./scripts/run-test.sh default           # five boards incl. a bare domain, charging simulated
./scripts/run-test.sh other-boards      # Recruitee, SmartRecruiters, Personio, Greenhouse pay transparency
./scripts/run-test.sh filters           # title, location and age filters; Workday search and details
./scripts/run-test.sh problems          # invalid inputs and an unknown board on every platform
./scripts/run-test.sh onlynew           # run twice: the second run writes only unseen jobs
node ../../scripts/check-dataset-schema.mjs .   # rows vs .actor/dataset_schema.json, as the platform checks them
```

`src/ats.js` holds every rule as a pure function: which board a link or a careers page points at, the endpoints,
and how each board's format maps to the one output schema. `src/main.js` does the requests, paging, filters,
only-new state and charging.

## Things the boards taught

| Board | Surprise | Handling |
|---|---|---|
| Greenhouse | pay is not in the job content, it is a separate field most boards fill | `pay_transparency=true`, spanned across pay zones |
| Workday | the list says "2 Locations" and "Posted 3 Days Ago" | location filter deferred to each job's record, details fetched in batches until enough pass |
| Workday | pay only in the description, "136,000 USD - 212,750 USD for Level 3, and ..." | amount-before-currency ranges, per-level ranges spanned, plausibility caps |
| Lever, Ashby | no company name in the API | read from the board's own page |
| SmartRecruiters | an unknown company answers 200 with no jobs | reported as "unknown id or no openings", not as an empty board |
| Personio | an unknown board redirects to personio.com | redirects are not followed and count as not found |
| Ashby | titles can carry leading spaces | text fields are trimmed and collapsed |

If you change a mapper, add the real response that motivated it to `test/fixtures/`.
