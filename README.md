# EasyTesting

*(Formerly NaturalHealing. The command line is `easytesting`; the older `heal` command still works.)*

A self-healing locator engine for end-to-end tests. When a test cannot find an element because a release changed it, the engine finds the closest match on the page, retries, and proposes (or, at high confidence, applies) a fix to the test source.

This is an MVP: the framework-neutral engine plus two adapters, Playwright and Selenium (selenium-webdriver for JavaScript/TypeScript), proven on a scripted bench.

## How it works

1. `healer.locate(page, selector)` replaces `page.locator(selector)` (Playwright), or `healer.find(driver, selector)` replaces `driver.findElement(By.css(selector))` (Selenium).
2. When the locator finds exactly one element, the engine saves a **fingerprint** of it (role, name, text, key attributes, class list, ancestors, sibling index, position).
3. When it finds nothing, the engine snapshots the page, keeps elements with the **same role and a similar name**, and scores each on attributes, text, tree, position and role.
4. The verdict depends on confidence (top score, capped when the runner-up is close):
   - `>= 0.85` **auto**: retry in-run; after the test passes, the selector in the source is rewritten.
   - `0.60 - 0.85` **suggest**: retry in-run, report only.
   - `< 0.60` **refuse**: the test fails normally and the report says why.
5. A heal counts only if the test then passes (`healer.finish(test, passed)`). Only lookup failures are healed; assertions are never touched.
6. The new selector is the most stable one that resolves to exactly the matched element. Playwright: test id, then `role=...[name=...]`, then id, then structure. Selenium: test id, id, `name`, visible text (XPath), placeholder, then structure.

## Run it

```sh
npm install
npm test        # needs Chromium; set up for /opt/pw-browsers
```

The Selenium tests need a chromedriver that matches the Chrome version. Set `CHROMEDRIVER` (and `CHROME_BIN` for a non-default Chrome) to point at them; without `CHROMEDRIVER`, Selenium Manager picks one.

## Command line

```sh
npm run build
npx heal run -- npx playwright test    # run your tests; heals are recorded in .heal/
npx heal report                        # list heals, write .heal/report.html
npx heal apply --approve a1b2c3d4      # rewrite test files (auto-level heals, plus ids you approve)
npx heal pr                            # apply, commit on a branch, push, open a draft pull request
```

In your tests, use the healer in place of `page.locator`, and tell it when each test ends:

```ts
const healer = new Healer();          // reads HEAL_DIR set by `heal run`
healer.beginTest('save profile');
await (await healer.locate(page, '#saveBtn')).click();
healer.finish('save profile', passed); // in afterEach
```

### Selenium

Selectors are CSS, or XPath when they start with `/` or `(`. With Mocha:

```js
import { SeleniumHealer } from 'easytesting/selenium';

const healer = new SeleniumHealer();
beforeEach(function () { healer.beginTest(this.currentTest.title); });
afterEach(function () { healer.finish(this.currentTest.title, this.currentTest.state === 'passed'); });

it('save profile', async () => {
  await (await healer.find(driver, '#saveBtn')).click();
});
```

Run it the same way: `npx heal run -- npx mocha`. Selenium cannot reach elements inside shadow DOM through CSS or XPath, so those are not healed.

Only heals whose test then passed are applied. Heals below the auto level are applied only when a person passes `--approve <id>` (ids are shown by `heal report`). `heal pr` needs `git` and, for the pull request, the GitHub CLI (`gh`); use `--no-push` or `--no-pr` to stop earlier.

**Hosting it for a team:** see [DEPLOY.md](DEPLOY.md) (Docker, settings, and why it does not run on Vercel).

## Sign in, use cases and test cases (no code needed)

```sh
npm run serve        # accounts are on by default; --no-login for solo use on your own machine
```

The first person to open the app creates the admin account and adds everyone else (**Team**). To let people create their own tester accounts instead, start it with `--signup` (or `HEAL_SIGNUP=on`): the sign-in screen then has a **Create account** tab, and the landing page's **Get started** and **Sign in** buttons link to `#/signup` and `#/signin`. Passwords are hashed with scrypt, sessions are HttpOnly SameSite=Strict cookies, and each tester sees only their own runs, bugs and test cases. Everything is stored in SQLite files under `.heal-server/` (`app.db` plus one `fingerprints.db` per project); old JSON data is imported on first start.

Three ways in from the home page:

1. **I have a use case.** Paste or upload text, Markdown, CSV or Excel. It is read for *Main Flow*, *Alternate Flows*, *Business Rules*, *Preconditions* and *Given/When/Then*, and turned into positive, negative (empty, invalid format), boundary (from limits such as "at least 8 characters" or "between 18 and 65"), alternate-flow and acceptance cases. Review them, then download as **Excel or CSV**. Two methods: *Standard* (rule-based, offline) and *Improve with AI* (Claude writes broader cases; needs `ANTHROPIC_API_KEY` on the server and sends the use case to Anthropic; every step the model writes is checked by the same reader that runs steps, it is asked once to fix any it cannot read, and on any failure the standard method is used instead and the screen says why). `HEAL_AI_MODEL` overrides the model (default `claude-opus-5-5`).
2. **I have test cases.** Upload Excel/CSV with any column names. You match the columns (guessed for you), then every step is shown with how it was understood and how sure the reader is; anything under 60% needs a rewrite because nothing is guessed. Steps can be in one cell (numbered or one per line) or one per row.
3. **I have test code.** The Playwright/Selenium project flow described below.

### The step language

Steps are plain English with a small vocabulary, shown on the review screen as you edit: `Open the application` / `Open "/login"`, `Click the "Sign in" button`, `Enter "a@b.co" in the Email field`, `Leave the Email field empty`, `Select "UK" from the Country dropdown`, `Check the "Remember me" checkbox`, `Press Enter`, `Wait 2 seconds`, and checks: `Verify "Welcome" is displayed`, `Verify the Save button is disabled`, `Verify an error message is displayed`, `Verify the page title contains "Billing"`, `Verify the user is redirected to the dashboard page`. Unquoted values ("a valid email") get example data and a lower confidence.

### How a run works and what the confidence means

The built-in executor opens each case in a fresh browser and finds each element **by meaning** (its name, label, placeholder, id), preferring the control type you wrote ("button", "field"). It remembers how it found each element on a green run; when the page later changes it uses, in order: the remembered locator, fingerprint healing (same engine as the test-code mode), then the name. If a control was renamed beyond recognition ("Sign in" to "Log in") it stops and lists what *is* on the page rather than clicking something else. Results feed the same report, bug tracker and heal list as everything else.

Two confidence numbers: **confidence in these results** (how sure we are each step was understood and run on the right element; it drops for partly understood steps and ambiguous matches) and **steps understood** (reading only, before running). The report adds **release confidence**, 100 minus the residual risk score.

Limits: Chrome or Edge must be installed on the machine running the server (or Playwright's Chromium). Cases run in Playwright; a Selenium executor for plain-English cases is not built. Content inside iframes is not reached, each step does one thing, and Word/PDF use cases must be pasted as text.

## Web app

```sh
npm run serve                     # or: npx heal serve --port 4173 --token secret
```

Open http://127.0.0.1:4173 and follow the four steps: app link, pick the tool (Playwright or Selenium, with a one-question helper), drop your test project as a `.zip`, press **Start testing**. First time? **Run the demo** tests a sample site, changes it, and runs the same test again so you can watch the heals.

**No change to your tests.** The server starts your tests with a preload (`NODE_OPTIONS=--import .../auto/register`) that hooks the framework from outside:

- Playwright: `Locator` actions (`click`, `fill`, `check`, ...) are wrapped. Assertions (`expect(...)`) are never touched. Elements inside iframes are left alone.
- Selenium (JavaScript): `driver.findElement` with a CSS or XPath locator is wrapped. `findElements` and `driver.wait(until...)` are not.

When an element is found, its fingerprint is saved. When a later lookup finds nothing, the engine looks for the closest match; above the confidence threshold the step continues on the new locator. A heal is marked *verified* when that step then succeeds (`verifiedBy: "step"`). The explicit API (`healer.locate`, `healer.finish`) still exists and verifies against the whole test (`verifiedBy: "test"`).

Runs with the same project name share fingerprints, so run once while the app is healthy, then again after a release. The engine can only heal an element it has seen working. If you do not give a test command, it is detected (`npm test`, `npx playwright test`, `npx mocha`, ...). `APP_URL` and `BASE_URL` carry your app link into the tests.

The fixes review screen shows each broken locator beside its replacement and a confidence score. Nothing is written to your files until you press **Apply**; high-confidence fixes are pre-ticked, the rest you tick yourself. Locators that are not a plain string in your code (for example `getByRole(...)`) heal during the run but need a manual edit.

The server executes uploaded code. It listens on loopback only and refuses another host without `--token`; for shared use run it inside a container or VM. Uploads are capped (100 MB zipped, 500 MB unpacked) and zip paths are checked against escaping the project folder.

API: `POST /api/runs?name=&framework=&appUrl=&command=&install=` (zip as body), `GET /api/runs`, `GET /api/runs/:id`, `GET /api/runs/:id/log`, `GET /api/runs/:id/report`, `POST /api/runs/:id/rerun`, `PUT /api/runs/:id/scenarios` (CSV body), `PATCH /api/runs/:id/bugs/:bugId`, `GET /api/runs/:id/bugs.csv`, `POST /api/runs/:id/apply` (`{"only":[ids]}`), `GET /api/runs/:id/download`, `POST /api/runs/:id/stop`, `DELETE /api/runs/:id`, `POST /api/demo?version=1|2|3`.

## Report

Every run has a report (**Report** in the top bar, or **View report** on a run). It answers: what was tested, what was missed, what broke, and how risky is the release.

| Section | What it shows | Where the data comes from |
| --- | --- | --- |
| Pass rate, results | every test with its result and time | a reporter added to `playwright test` and `mocha` runs (other commands count as one test) |
| Pages and controls covered | pages visited vs. pages they link to; buttons, fields and links used vs. present | recorded inside the tests' own browser session, so logged-in pages count |
| Uncovered areas | linked pages never opened, and unused controls on tested pages | the same recording |
| Unattended scenarios | planned scenarios with no test, or only skipped tests | an optional CSV (`id,title,area,priority`) matched to tests by id or title |
| Bugs, status, re-tests | one bug per failing test: Open, Fixed, Verified fixed, Reopened, Not a bug, Won't fix | a later passing run verifies a bug; a failing one reopens it |
| Defect density | bugs found per 100 tests run, per page tested, and the residual figure still open after re-testing | bugs and results |
| Residual risk (0-100) | open bugs by severity (35), failing tests (15), pages not visited (15), controls not used (10), unattended scenarios (15), unapplied locator fixes (10), scaled to what could be measured | all of the above |

The risk score is a transparent heuristic, not a standard: the report shows each part and its points, and the weights are in `src/server/report.ts`. Bug severity comes from the matching scenario's priority, otherwise "high" for a wrong result and "medium" for the rest; a person can change it. A report is a snapshot of how things stood after that run; only the newest report of a project allows changing bugs. **Re-test now** runs the same tests again on the same app link, **Print** saves a PDF, and **Bugs (CSV)** exports the bug list.

Coverage limits: pages are discovered from links on pages the tests opened, so pages nothing links to cannot be listed, and only Playwright and Selenium (JavaScript) element actions are recorded.

## Bench result

Playwright, 14 scripted UI changes (renamed ids, moved or wrapped elements, link instead of button, open shadow DOM, plus cases that must not heal):

- 9 of 9 healable changes healed to the correct element, 0 false heals.
- Ambiguous (two "Save" buttons), icon-only, and removed-element cases are refused rather than guessed.
- Only 3 of the 9 reach the 0.85 auto-apply threshold; the other 6 are suggested for review. Thresholds and weights are starting values and need tuning on real suites.

Selenium, the same changes except shadow DOM: 8 of 8 healed to the correct element, 0 false heals, 2 at the auto level. Its selectors differ (`#id` or XPath text instead of role selectors), so scores differ slightly.

The bench is a small hand-made page, not a real application. Treat the numbers as a smoke test of the algorithm, not a measured heal rate.

## Not built yet

Mobile (APK/Appium), Python/Java Selenium suites, healing for `getBy*` locators in source patches, a queue and sandbox for multi-user hosting, visual similarity, SQLite store, TypeScript syntax-tree patcher, an MCP server, other frameworks (Cypress, Selenium for Java or Python), API healing, mobile. See the architecture plan for the roadmap.
