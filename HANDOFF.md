# Handoff — AI Opportunity Inventory site + assistant

This site replaces the custom GPT ("AI Opportunity Research Assistant") with a
public web app: a landing page, a browsable Raw Opportunity Bank, and a
Claude-powered research assistant with the full student memo workflow. The
Google Sheets + Apps Script backend stays — this app talks to it server-side.

```
Browser ──► Next.js on Vercel ──► Claude API (assistant, server-side key)
                   │
                   └─────────────► Google Apps Script /exec  ──► Google Sheets
                                   (secret held server-side)     · Opportunities (public view)
                                                                 · Prospects / Assignments / Reviews
                                                                 · Roster (interest-form responses)
```

Key security property vs. the GPT: **no secret ever reaches the model or the
browser.** The Apps Script secret and the Anthropic API key live only in Vercel
env vars; membership gating is enforced in server code (write tools are not
even registered for non-members), and the server stamps the verified member's
identity onto every write.

---

## 1. FIRST: rotate the Apps Script secret

The old key was embedded in the GPT's instructions and pasted into shared docs
— treat it as public. Do this regardless of anything else:

1. Generate a new secret (e.g. run `openssl rand -hex 32` or use a password
   manager's generator). Never put it in a doc, prompt, or email thread.
2. Follow §2 to deploy the new backend with that key.
3. Disable or archive the old Apps Script deployment used by the GPT.

## 2. Deploy the new Apps Script backend

The complete script is in `appsscript/Code.gs` (drop-in; supports the five
original workflow actions plus `listOpportunities` and `checkRoster`).

1. Open the **workflow spreadsheet** (where Prospects/Assignments/Reviews
   should live — can be a new spreadsheet) → Extensions → Apps Script.
2. Replace the code with `appsscript/Code.gs`.
3. Project Settings → Script Properties, add:
   | Property | Value |
   |---|---|
   | `API_KEY` | the new secret from §1 |
   | `ROSTER_SPREADSHEET_ID` | spreadsheet ID of the interest-form responses |
   | `ROSTER_SHEET_NAME` | usually `Form Responses 1` |
   | `OPPORTUNITIES_SPREADSHEET_ID` | ID of the "AI Opportunity Tracker Public View" sheet |
   | `OPPORTUNITIES_SHEET_NAME` | usually `Sheet1` |
   | `WORDPRESS_SITE_URL` | WordPress site URL, without `/wp-json/...` |
   | `WORDPRESS_USERNAME` | WordPress user permitted to create drafts |
   | `WORDPRESS_APP_PASSWORD` | Application password generated in that user's WordPress profile |
4. Deploy → New deployment → **Web app** → Execute as **Me**, access
   **Anyone**. Copy the `/exec` URL.

Notes:
- The Prospects / Assignments / Reviews tabs are created automatically on
  first write, with headers.
- **If a Prospects tab already exists**, add one header cell reading
  `evidentiaryPosture` in the first empty column to the right of `notes`.
  Writes and reads are positional against `PROSPECT_HEADERS`, so the data
  lands correctly either way — the header cell is only so the column is
  legible to a human reading the sheet. Existing rows stay blank in it.
- **Membership = a row on the interest-form responses sheet.** To remove
  someone's access, delete their row (their session cookie also expires after
  30 days). To add someone manually, add a row with at least their email.
- The site reads opportunities through this backend, so the public-view sheet
  does **not** need to be link-shared for the site to work. (It currently
  requires Google sign-in to view — if the Texas Law page links the raw sheet
  directly, either share it "Anyone with the link: Viewer" or just link the
  site's `/inventory` page instead, which is the nicer view anyway.)

## 3. Vercel environment variables

| Variable | Required | Value |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | Claude API key from console.anthropic.com — see §5 costs |
| `APPS_SCRIPT_URL` | yes | the `/exec` URL from §2 |
| `APPS_SCRIPT_SECRET` | yes | the new secret from §1 |
| `SESSION_SECRET` | yes | any long random string (`openssl rand -hex 32`); signs member cookies |
| `CLAUDE_MODEL` | no | defaults to `claude-sonnet-5` |
| `NEXT_PUBLIC_SUBSTACK_URL` | no | set once the Substack exists; adds links site-wide |
| `DEV_ROSTER` | no | local dev only — fake roster when no backend configured |

Until `APPS_SCRIPT_URL`/`APPS_SCRIPT_SECRET` are set, the deployed site runs
against bundled **sample data** (a snapshot of the real bank) and a dev roster
— fine for previewing, not for launch.

## 4. Substack

Create the publication, then set `NEXT_PUBLIC_SUBSTACK_URL` and redeploy. The
landing page's step 03 and the footer will pick it up automatically. Only the
name/subdomain matters up front — it's painful to change later.

## 5. Costs and abuse controls

- The assistant runs on Claude Sonnet ($3 / $15 per million tokens; intro
  pricing $2 / $10 through Aug 2026). A typical coaching conversation costs a
  few cents; a heavy month of student use is likely tens of dollars, not
  hundreds. The system prompt is cached, which cuts repeat-request input cost
  ~90%.
- **Set a spend alert** in console.anthropic.com → Billing so a surprise is an
  email, not an invoice.
- Built-in throttles: per-IP message throttling, per-request size caps, and a
  hard cap on tool rounds per reply. These are best-effort (serverless memory)
  — the console spend alert is the real backstop.

## 6. Known limitations / sensible next steps

1. **Roster check ≠ email ownership.** Anyone who knows a member's email can
   verify as them. Fine for a friendly academic community; if it becomes a
   problem, add a one-time email code (needs an email-sending service).
2. **Review submissions create WordPress drafts.** The Reviews tab retains the
   AI rubric score + summary and stores the WordPress edit URL in `draftLink`.
3. **No notifications.** Students aren't emailed on triage/review decisions;
   an Apps Script `onEdit` mailer would close that loop cheaply.
4. **AI-use disclosure.** When memos publish, include a standard line noting
   AI-assisted research coaching with human editorial review — the site's
   footer already discloses this for the assistant itself.

## 7. Local development

```bash
npm install
# .env.local: ANTHROPIC_API_KEY=... (nothing else needed — mock backend kicks in)
npm run dev
```

Mock mode: without `APPS_SCRIPT_URL`, data comes from
`data/opportunities.sample.json`, the roster accepts `test@example.com` (or
set `DEV_ROSTER`), and writes go to in-memory arrays.
