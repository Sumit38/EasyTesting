# Hosting EasyTesting for a team

EasyTesting starts real browsers, runs for minutes, and keeps its data (accounts, bugs, fingerprints, screenshots) in files. It needs a small **always-on server that can run a container**. It will not work on serverless platforms such as Vercel or Netlify Functions: there is no browser, runs are cut off after a short time, and the disk is wiped between requests. (Vercel is fine for hosting the *app you want to test*.)

## Quick start with Docker

```sh
docker compose up -d --build
```

Open http://localhost:8080 and create the first account. That person becomes the admin and adds everyone else under **Team**.

The data lives in the `heal-data` volume (`/data` in the container). Back it up by copying that volume.

## Settings

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `8080` | Port to listen on. Hosts such as Railway and Render set this for you. |
| `HEAL_HTTPS` | `0` | Set to `1` when the app is reached over HTTPS, so the sign-in cookie is marked Secure. |
| `HEAL_MAX_RUNS` | `3` | How many test runs execute at once. Others wait as "queued". Each run starts a browser, so size this to the machine (about 1 GB of memory per run is a safe guess). |
| `HEAL_SIGNUP` | off | `on` lets anyone create their own tester account from the sign-in screen (the landing page's **Get started** button opens it). Off means only an admin can add people. New accounts are always testers, and one address can create at most 5 an hour. Turn it on only when you are happy for strangers to start browser runs on your server, and keep `HEAL_MAX_RUNS` small. |
| `HEAL_MAX_USER_RUNS` | `3` | How many runs one person may have waiting or running. Stops one account from filling the queue. |
| `HEAL_KEEP_DAYS` | `30` | Finished runs, with their screenshots and logs, are deleted after this many days so the disk does not fill. `0` keeps everything. |
| `HEAL_AI_PER_HOUR` | `30` | How many times one person can use the AI helper per hour (each use costs you money). |
| `HEAL_TRUST_PROXY` | on with `HEAL_HTTPS=1` | Read each visitor's address from the proxy's headers. Without it, everyone behind Railway or Render shares one sign-up and sign-in limit. Set `0` to turn off if the server is reached directly. |
| `HEAL_BLOCK_PRIVATE` | on unless local | Test cases may only open public websites, never the server itself, a private network or cloud metadata addresses. Set `0` only on a trusted machine. |
| `HEAL_CODE_UPLOADS` | `off` in the container | `on` lets people upload Playwright/Selenium projects. That runs *their code on this machine*. Leave it off on any shared server. |
| `ANTHROPIC_API_KEY` | none | Enables "Improve with AI" for writing test cases. The use-case text is sent to Anthropic. Never put the key in the repo; set it in the host's secret settings. |
| `HEAL_AI_MODEL` | `claude-opus-5-5` | Which Claude model to use for that option. |

## Where to run it

Any host that runs a container and gives it a persistent disk:

- **Railway / Render**: connect the GitHub repo, choose the Dockerfile, add a persistent volume mounted at `/data`, set `HEAL_HTTPS=1`. They provide HTTPS.
- **Fly.io**: `fly launch`, add a volume at `/data`, set `HEAL_HTTPS=1`.
- **A VM (Azure, AWS, Google Cloud) or an internal server**: install Docker, run `docker compose up -d`, and put an HTTPS reverse proxy (Caddy, nginx, or the cloud load balancer) in front.

## Before real users arrive

- **HTTPS is required** outside localhost: sign-in passwords travel over it.
- **Test code uploads stay off** unless every user is trusted. The plain-English modes (use cases and test cases) are much safer: they run only our own executor.
- The apps being tested must be reachable *from the server*. A staging site on a private network is only reachable if the server is on that network too.
- Run limits are per server, not per user. One person can use every slot.
- This image has not been built or run in the environment where it was written (no Docker there). Treat the first build as a trial: check `docker compose logs` and `/healthz`.

## Without Docker

```sh
npm ci && npm run build
npx playwright-core install --with-deps chromium
HEAL_CODE_UPLOADS=off node dist/cli.js serve --host 0.0.0.0 --port 8080 --data /var/lib/easytesting
```

## Jira and Azure DevOps

An admin connects them once under **Team → Connections**. Testers then file any bug from the report: they pick **Jira** or **Azure DevOps**, then **Bug** (a new bug on its own) or **User story** (a new bug linked to a story they search for). EasyTesting shows each ticket's status and, when a re-test passes or fails, adds a comment to the ticket.

- **Jira Cloud:** your address (`https://yourcompany.atlassian.net`), the email of the account that owns the token, an API token from id.atlassian.com → Security → API tokens, and the project key. Tickets are created as that account. Linked bugs use Jira's "Relates" link.
- **Azure DevOps Services:** your organization (`https://dev.azure.com/yourorg`), a personal access token with **Work Items: Read & write**, and the project name. A linked bug becomes a child of the user story. For Scrum projects set the story type to "Product Backlog Item"; for Basic, both types to "Issue".

Settings are tested before they are saved. Tokens are stored encrypted with a key kept in `secret.key` in the data folder (on Railway, the volume). Back that file up with the database; if it is lost, the admin re-enters the tokens.
