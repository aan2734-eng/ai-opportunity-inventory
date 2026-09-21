# AI Opportunity Inventory

Public site + Claude-powered research assistant for the [AI Opportunity
Inventory](https://law.utexas.edu/ai/ai-opportunity-inventory/), a
multi-stakeholder initiative led by the University of Texas School of Law AI
Innovation and Law Program.

**Live site:** https://ai-opportunity-inventory.vercel.app

- **/** — program landing page
- **/inventory** — browsable, read-only Raw Opportunity Bank (search + filters)
- **/assistant** — research assistant: public Q&A for anyone; the full memo
  workflow (duplicate check → triage → assignment → staged draft review →
  editorial submission) for roster-verified community members

Stack: Next.js (App Router) · Tailwind · `@anthropic-ai/sdk` (streaming tool
use) · Google Apps Script + Sheets as the datastore.

See **HANDOFF.md** for deployment, environment variables, backend setup, and
the security model. `appsscript/Code.gs` is the drop-in backend script.

```bash
npm install
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env.local
npm run dev   # runs against bundled sample data + mock roster (test@example.com)
npm test      # Node's built-in runner; see HANDOFF.md §8
```
