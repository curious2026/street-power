const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const CATEGORIES = [
  { id: '13000', label: '飲食',        weight: 30 },
  { id: '17000', label: 'ショッピング', weight: 25 },
  { id: '70000', label: '生活サービス', weight: 20 },
  { id: '12000', label: '医療・福祉',   weight: 15 },
  { id: '11000', label: 'ビジネス',     weight: 10 },
];

app.get('/api/score', async (req, res) => {
  const { ll, radius } = req.query;
  const apiKey = process.env.FSQ_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'APIキー未設定', score: 0 });

  try {
    const results = await Promise.all(
      CATEGORIES.map(async (cat) => {
        const url = `https://api.foursquare.com/v3/places/search?ll=${ll}&radius=${radius}&categories=${cat.id}&limit=50`;
        const r = await fetch(url, {
          headers: { 'Authorization': apiKey, 'Accept': 'application/json' }
        });
        const data = await r.json();
        const count = (data.results || []).length;
        return { label: cat.label, count, weight: cat.weight };
      })
    );

    let totalScore = 0;
    const details = {};
    results.forEach(r => {
      details[r.label] = r.count;
      totalScore += (r.count / 50) * r.weight * 10;
    });

    res.json({ score: Math.round(Math.min(1000, totalScore)), details });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'APIエラー', score: 0 });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
