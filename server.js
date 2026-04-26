const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/test', async (req, res) => {
  const apiKey = process.env.FSQ_API_KEY;
  if (!apiKey) return res.json({ ok: false, error: 'APIキーなし' });
  try {
    const r = await fetch(
      'https://api.foursquare.com/v3/places/search?ll=35.6896,139.7006&radius=800&limit=10',
      { headers: { 'Authorization': apiKey, 'Accept': 'application/json' } }
    );
    const data = await r.json();
    res.json({ ok: true, status: r.status, count: (data.results||[]).length, sample: data });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get('/api/score', async (req, res) => {
  const { ll, radius } = req.query;
  const apiKey = process.env.FSQ_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'APIキー未設定', score: 0, details: {} });

  const CATS = [
    { id: '13000', label: '飲食',         weight: 30 },
    { id: '17000', label: 'ショッピング',  weight: 25 },
    { id: '15000', label: '医療・福祉',    weight: 20 },
    { id: '11000', label: 'ビジネス',      weight: 15 },
    { id: '10000', label: 'エンタメ',      weight: 10 },
  ];

  try {
    const results = await Promise.all(
      CATS.map(async (cat) => {
        const url = `https://api.foursquare.com/v3/places/search?ll=${ll}&radius=${radius}&categories=${cat.id}&limit=50`;
        const r = await fetch(url, {
          headers: { 'Authorization': apiKey, 'Accept': 'application/json' }
        });
        const data = await r.json();
        const count = (data.results || []).length;
        return { label: cat.label, count, weight: cat.weight };
      })
    );

    const details = {};
    let raw = 0;
    results.forEach(r => {
      details[r.label] = r.count;
      raw += (r.count / 50) * r.weight * 10;
    });

    res.json({ score: Math.round(Math.min(1000, raw)), details });
  } catch(e) {
    console.error('score error:', e.message);
    res.status(500).json({ error: e.message, score: 0, details: {} });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
