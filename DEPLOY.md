# Deploying FinPredict

## Option 1: Railway (Recommended — easiest, $5/mo)

1. Push this repo to GitHub
2. Go to railway.app → New Project → Deploy from GitHub
3. Add environment variables in Railway dashboard:
   - `FMP_API_KEY` = your FMP key
   - `GOOGLE_AI_KEY` = your Google AI Studio key
   - `DB_PATH` = `/data/finpredict.db`
4. Add a Volume: mount path `/data` (persists the SQLite database)
5. Railway auto-detects Node.js and deploys. Done.

## Option 2: Render (Free tier available)

1. Push repo to GitHub
2. render.com → New Web Service → connect repo
3. Build command: `npm install`
4. Start command: `node --experimental-sqlite server.js`
5. Add env vars (same as Railway)
6. Add a Disk: mount path `/data`, 1GB
7. Note: free tier spins down after 15 min inactivity

## Option 3: Fly.io (Free tier with persistent volumes)

```bash
# Install flyctl, then:
fly launch              # auto-detects Dockerfile
fly volumes create finpredict_data --size 1
fly secrets set FMP_API_KEY=xxx GOOGLE_AI_KEY=xxx DB_PATH=/data/finpredict.db
fly deploy
```

## Option 4: DigitalOcean App Platform ($5/mo)

1. Push to GitHub
2. Create App → select repo → auto-detect Dockerfile
3. Add env vars + a persistent storage volume at `/data`

## Notes

- The SQLite database persists on the mounted `/data` volume
- On first boot, the seed script runs automatically to populate companies + scores
- Daily scoring runs automatically via the built-in cron scheduler
- For production with many users, consider migrating to PostgreSQL (replace `node:sqlite` with `pg`)
