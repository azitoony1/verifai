# VerifAI — OSINT Verification Engine

Multi-layer forensic image and claim verification. Upload an image, add a claim, receive a structured verdict: authenticity score, evidence flags, military equipment analysis, devil's advocate rebuttal, and executive summary.

---

## What It Does

| Phase | What it checks |
|---|---|
| **AI Vision Analysis** | Gemini 3 Flash: visual artifacts, AI-generation tells, manipulation signs |
| **Military Equipment ID** | Bellingcat-style: weapons, vehicles, ordnance, markings, provenance |
| **Physical Consistency** | Shadow/lighting plausibility, geolocation clues, temporal markers |
| **EXIF Metadata** | GPS, timestamps, device, editing software (client-side, zero cost) |
| **Reverse Image Search** | Google Vision API: prior appearances, exact/partial matches |
| **Web Corroboration** | Brave Search: cross-reference against trusted news and fact-check sources |
| **Devil's Advocate** | Active argument against the main verdict |

---

## Setup

### 1. Clone and install
```bash
git clone https://github.com/YOUR_USERNAME/verifai.git
cd verifai
npm install
```

### 2. Get API keys (all free for testing)

| Key | Where | Free tier |
|---|---|---|
| `GEMINI_API_KEY` | [aistudio.google.com](https://aistudio.google.com) | 1,500 req/day |
| `GOOGLE_VISION_API_KEY` | [console.cloud.google.com](https://console.cloud.google.com) | $300 GCP credit |
| `BRAVE_SEARCH_API_KEY` | [api.search.brave.com](https://api.search.brave.com) | 2,000 req/month |

Vision and Brave keys are optional — app works with just Gemini, other checks skip gracefully.

### 3. Configure
```bash
cp .env.example .env.local
# Fill in your keys in .env.local
```

### 4. Run
```bash
npm run dev
# Open http://localhost:3000
```

---

## Deploy to Vercel

1. Push to GitHub
2. [vercel.com](https://vercel.com) → New Project → Import repo
3. Add env vars in Vercel dashboard → Deploy

Or via CLI:
```bash
npx vercel
vercel env add GEMINI_API_KEY
vercel env add GOOGLE_VISION_API_KEY  
vercel env add BRAVE_SEARCH_API_KEY
vercel --prod
```

---

## Project Structure
```
verifai/
├── src/app/
│   ├── api/analyze/route.ts   ← Pipeline orchestrator
│   ├── page.tsx               ← Full UI
│   └── globals.css
├── src/lib/types.ts
├── .env.example
└── vercel.json
```

---

## Cost at Scale
| Volume | Est. cost |
|---|---|
| Test (< 100/month) | ~$0 |
| 1,000/month | ~$5–15 |
| 10,000/month | ~$50–150 |

---

## Roadmap
- [ ] Geolocation layer (SunCalc shadow analysis, Street View matching)
- [ ] Historical weather cross-reference (Open-Meteo)
- [ ] Synthetic text detection (GPTZero)
- [ ] PDF report export
- [ ] Video support

---

⚠️ VerifAI provides probabilistic assessments, not definitive verdicts. Always apply human judgment before publication.
