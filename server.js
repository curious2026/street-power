const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const FSQ_BASE = 'https://places-api.foursquare.com/places/search';

function fsqHeaders(apiKey) {
  return {
    'Authorization': 'Bearer ' + apiKey,
    'Accept': 'application/json',
    'X-Foursquare-API-Version': '20240101'
  };
}

const CATS = [
  { id: '13000', label: '飲食', weight: 30 },
  { id: '17000', label: 'ショッピング', weight: 25 },
  { id: '15000', label: '生活サービス', weight: 20 },
  { id: '11000', label: 'ビジネス', weight: 15 },
  { id: '10000', label: 'エンタメ', weight: 10 }
];

async function fetchCount(ll, radius, categoryId, apiKey) {
  try {
    var url = FSQ_BASE + '?ll=' + ll + '&radius=' + radius + '&categories=' + categoryId + '&limit=50';
    var r = await fetch(url, { headers: fsqHeaders(apiKey) });
    var d = await r.json();
    return (d.results || []).length;
  } catch(e) {
    return 0;
  }
}

app.get('/api/score', async function(req, res) {
  var ll = req.query.ll;
  var radius = req.query.radius || 800;
  var apiKey = process.env.FSQ_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'APIキー未設定', score: 0, details: {} });
  }
  try {
    var counts = await Promise.all(
      CATS.map(function(cat) {
        return fetchCount(ll, radius, cat.id, apiKey);
      })
    );
    var details = {};
    var raw = 0;
    for (var i = 0; i < CATS.length; i++) {
      details[CATS[i].label] = counts[i];
      raw += Math.min(counts[i] / 50, 1) * CATS[i].weight * 10;
    }
    res.json({ score: Math.round(Math.min(1000, raw)), details: details });
  } catch(e) {
    res.status(500).json({ error: e.message, score: 0, details: {} });
  }
});

app.get('/api/test', async function(req, res) {
  var apiKey = process.env.FSQ_API_KEY;
  if (!apiKey) {
    return res.json({ ok: false, error: 'APIキーなし' });
  }
  try {
    var url = FSQ_BASE + '?ll=35.6896,139.7006&radius=800&limit=10';
    var r = await fetch(url, { headers: fsqHeaders(apiKey) });
    var d = await r.json();
    res.json({ ok: true, status: r.status, count: (d.results || []).length, sample: d });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

var PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log('Server running on port ' + PORT);
});
