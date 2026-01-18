# Content Automation

Automated posting to X and LinkedIn via GitHub Actions.

## Setup

1. Push this folder to a new **private** GitHub repo
2. Add secrets in Repo → Settings → Secrets → Actions:
   - `X_API_KEY`
   - `X_API_SECRET`
   - `X_ACCESS_TOKEN`
   - `X_ACCESS_SECRET`
   - `LINKEDIN_ACCESS_TOKEN`
   - `GOOGLE_SERVICE_ACCOUNT` (paste entire JSON)
   - `SPREADSHEET_ID`
3. Create Content Queue Google Sheet with tabs:
   - X Queue, X Posted, X Winners
   - LinkedIn Queue, LinkedIn Posted, LinkedIn Winners
4. Share Sheet with service account email
5. GitHub Actions will start automatically

## How It Works

| Workflow | Schedule | What It Does |
|----------|----------|--------------|
| post-to-x.yml | Every 3 hours | Posts 7 tweets from X Queue |
| post-to-linkedin.yml | Every 2 hours | Posts 2 LI posts from LinkedIn Queue |
| collect-stats.yml | Daily 8am UTC | Pulls engagement, flags winners (2x avg) |

## Sheet Column Structure

| Column | Purpose |
|--------|---------|
| A: Post ID | Unique identifier |
| B: Content | Post text |
| C: Status | Pending / Posted / Failed |
| D: Scheduled Time | When to post |
| E: Posted At | Actual timestamp |
| F: Platform Post ID | ID from X/LinkedIn |
| G: Impressions | From stats |
| H: Engagement | Likes + replies + shares |
| I: Engagement Rate | Formula |
| J: Winner? | 🏆 if 2x avg |

## Local Testing

```bash
npm install
X_API_KEY=xxx node scripts/post-to-x.js
```
