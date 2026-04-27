const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const FSQ_BASE = 'https://places-api.foursquare.com/places/search';

const CATS = [
  { id: '13000', label: '飲食',         weight: 30 },
  { id: '17000', label: 'ショッピング',  weight: 25 },
  { id: '15000', label: '生活サービス',  weight: 20 },
  { id: '11000', label: 'ビジネス',      weight: 15 },
  { id: '10000', label: 'エンタメ',      weight: 10 },
];

async function fetchCount(ll, radius, categoryId, apiKey) {
  try {
    const url = `${FSQ_BASE}?ll=${ll}&radius=${radius}&categories=${categoryId}&limit=50`;
    const r = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json'
      }
    });
    const d = await r.json();
    return (d.results || []).length;
  } catch { return 0; }
}

app.get('/api/score', async (req, res) => {
  const { ll, radius } = req.query;
  const apiKey = process.env.FSQ_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'APIキー未設定', score: 0, details: {} });

  try {
    const counts = await Promise.all(
      CATS.map(cat => fetchCount(ll, radius || 800, cat.id, apiKey))
    );
    const details = {};
    let raw = 0;
    CATS.forEach((cat, i) => {
      details[cat.label] = counts[i];
      raw += Math.min(counts[i] / 50, 1) * cat.weight * 10;
    });
    res.json({ score: Math.round(Math.min(1000, raw)), details });
  } catch(e) {
    res.status(500).json({ error: e.message, score: 0, details: {} });
  }
});

app.get('/api/test', async (req, res) => {
  const apiKey = process.env.FSQ_API_KEY;
  if (!apiKey) return res.json({ ok: false, error: 'APIキーなし' });
  try {
    const url = `${FSQ_BASE}?ll=35.6896,139.7006&radius=800&limit=10`;
    const r = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json'
      }
    });
    const d = await r.json();
    res.json({ ok: true, status: r.status, count: (d.results||[]).length, sample: d });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
