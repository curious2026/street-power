const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const duckdb = require('duckdb');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const CACHE_FILE = path.join(__dirname, 'cache.json');

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    }
  } catch(e) {}
  return {};
}

function saveCache(c) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(c), 'utf8'); } catch(e) {}
}

let cache = loadCache();
console.log('キャッシュ読込:', Object.keys(cache).length + '件');

const db = new duckdb.Database(':memory:');

// DuckDB初期化（httpfs + S3設定）
function initDB() {
  return new Promise((resolve, reject) => {
    const con = db.connect();
    con.exec(`
      INSTALL httpfs;
      LOAD httpfs;
      SET s3_region='us-west-2';
    `, (err) => {
      con.close();
      if (err) reject(err);
      else resolve();
    });
  });
}

const S3_PATH = "s3://overturemaps-us-west-2/release/2026-04-15.0/theme=places/type=place/*";

const EAT   = ['eat_and_drink','restaurant','cafe','bar','fast_food','coffee'];
const SHOP  = ['retail','shopping','supermarket','convenience_store','clothing'];
const SVC   = ['service','bank','pharmacy','post_office','beauty_salon','laundry'];
const MED   = ['health_and_medicine','hospital','clinic','dentist','doctors'];
const ENT   = ['entertainment','cinema','museum','sports','amusement'];

const WEIGHTS = { '飲食':30, 'ショッピング':25, '生活サービス':20, '医療・福祉':15, 'エンタメ':10 };

async function queryOverture(lat, lng, radius) {
  return new Promise((resolve, reject) => {
    const con = db.connect();
    const deg = radius / 111000;
    const degLng = deg / Math.cos(lat * Math.PI / 180);
    const minX = lng - degLng, maxX = lng + degLng;
    const minY = lat - deg,    maxY = lat + deg;

    const sql = `
      SELECT categories.primary as cat, COUNT(*) as cnt
      FROM read_parquet('${S3_PATH}', hive_partitioning=false)
      WHERE bbox.xmin >= ${minX}
        AND bbox.xmax <= ${maxX}
        AND bbox.ymin >= ${minY}
        AND bbox.ymax <= ${maxY}
      GROUP BY categories.primary
    `;

    con.all(sql, (err, rows) => {
      con.close();
      if (err) return reject(err);

      const details = { '飲食':0, 'ショッピング':0, '生活サービス':0, '医療・福祉':0, 'エンタメ':0 };
      (rows || []).forEach(row => {
        const c = row.cat || '';
        const n = parseInt(row.cnt) || 0;
        if (EAT.includes(c))  details['飲食'] += n;
        else if (SHOP.includes(c)) details['ショッピング'] += n;
        else if (SVC.includes(c))  details['生活サービス'] += n;
        else if (MED.includes(c))  details['医療・福祉'] += n;
        else if (ENT.includes(c))  details['エンタメ'] += n;
      });

      let raw = 0;
      Object.entries(details).forEach(([label, count]) => {
        raw += Math.min(count / 50, 1) * WEIGHTS[label] * 10;
      });
      resolve({ score: Math.round(Math.min(1000, raw)), details });
    });
  });
}

app.get('/api/score', async (req, res) => {
  const { ll, radius } = req.query;
  const r = parseInt(radius) || 800;
  const key = ll + '_' + r;

  if (cache[key]) {
    console.log('キャッシュHIT:', key);
    return res.json({ ...cache[key], cached: true });
  }

  try {
    const [lat, lng] = ll.split(',').map(Number);
    console.log('Overture取得中:', key);
    const result = await queryOverture(lat, lng, r);
    cache[key] = result;
    saveCache(cache);
    console.log('保存完了:', key, 'score:', result.score);
    res.json({ ...result, cached: false });
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: e.message, score: 0, details: {} });
  }
});

app.get('/api/test', async (req, res) => {
  try {
    const result = await queryOverture(35.6896, 139.7006, 800);
    res.json({ ok: true, source: 'Overture Maps 2026-04-15', ...result });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get('/api/cache', (req, res) => {
  res.json({ count: Object.keys(cache).length, keys: Object.keys(cache) });
});

// 起動時にDuckDB初期化
initDB().then(() => {
  console.log('DuckDB初期化完了');
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log('Server running on port ' + PORT));
}).catch(e => {
  console.error('DuckDB初期化失敗:', e);
  process.exit(1);
});
