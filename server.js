const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const duckdb = require('duckdb');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// キャッシュファイルのパス
const CACHE_FILE = path.join(__dirname, 'cache.json');

// キャッシュをファイルから読み込む
function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    }
  } catch(e) {}
  return {};
}

// キャッシュをファイルに保存
function saveCache(cache) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache), 'utf8');
  } catch(e) {}
}

// 起動時にキャッシュ読み込み
let cache = loadCache();
console.log('キャッシュ読み込み済み:', Object.keys(cache).length + '件');

// DuckDBインスタンス
const db = new duckdb.Database(':memory:');

// DuckDBでOvertureデータをクエリ
async function queryOverture(lat, lng, radius) {
  return new Promise((resolve, reject) => {
    const con = db.connect();

    // 検索範囲のバウンディングボックスを計算（度単位の近似）
    const deg = radius / 111000;
    const minLat = lat - deg;
    const maxLat = lat + deg;
    const minLng = lng - deg / Math.cos(lat * Math.PI / 180);
    const maxLng = lng + deg / Math.cos(lat * Math.PI / 180);

    // カテゴリマッピング
    const catMap = {
      '飲食':         "categories.primary IN ('eat_and_drink','restaurant','cafe','bar','fast_food')",
      'ショッピング':  "categories.primary IN ('retail','shopping','supermarket','convenience_store')",
      '生活サービス':  "categories.primary IN ('service','bank','pharmacy','post_office','laundry')",
      '医療・福祉':    "categories.primary IN ('health_and_medicine','hospital','clinic','dentist')",
      'エンタメ':      "categories.primary IN ('entertainment','cinema','museum','sports','art')"
    };

    const weights = {
      '飲食': 30, 'ショッピング': 25, '生活サービス': 20, '医療・福祉': 15, 'エンタメ': 10
    };

    const sql = `
      INSTALL spatial;
      LOAD spatial;
      SELECT
        categories.primary as cat,
        COUNT(*) as cnt
      FROM read_parquet(
        'https://overturemaps-us-west-2.s3.amazonaws.com/release/2025-04-23.0/theme=places/type=place/*',
        hive_partitioning=false
      )
      WHERE bbox.minx >= ${minLng}
        AND bbox.maxx <= ${maxLng}
        AND bbox.miny >= ${minLat}
        AND bbox.maxy <= ${maxLat}
      GROUP BY categories.primary
    `;

    con.all(sql, (err, rows) => {
      con.close();
      if (err) {
        console.error('DuckDB error:', err.message);
        return reject(err);
      }

      // カテゴリ別に集計
      const details = { '飲食': 0, 'ショッピング': 0, '生活サービス': 0, '医療・福祉': 0, 'エンタメ': 0 };

      const eatCats = ['eat_and_drink','restaurant','cafe','bar','fast_food'];
      const shopCats = ['retail','shopping','supermarket','convenience_store'];
      const serviceCats = ['service','bank','pharmacy','post_office','laundry'];
      const healthCats = ['health_and_medicine','hospital','clinic','dentist'];
      const entCats = ['entertainment','cinema','museum','sports','art'];

      (rows || []).forEach(row => {
        const c = row.cat || '';
        const n = parseInt(row.cnt) || 0;
        if (eatCats.includes(c)) details['飲食'] += n;
        else if (shopCats.includes(c)) details['ショッピング'] += n;
        else if (serviceCats.includes(c)) details['生活サービス'] += n;
        else if (healthCats.includes(c)) details['医療・福祉'] += n;
        else if (entCats.includes(c)) details['エンタメ'] += n;
      });

      let raw = 0;
      Object.entries(details).forEach(([label, count]) => {
        raw += Math.min(count / 50, 1) * weights[label] * 10;
      });

      resolve({ score: Math.round(Math.min(1000, raw)), details });
    });
  });
}

// スコア取得API
app.get('/api/score', async (req, res) => {
  const { ll, radius } = req.query;
  const r = parseInt(radius) || 800;
  const cacheKey = ll + '_' + r;

  // キャッシュヒット
  if (cache[cacheKey]) {
    console.log('キャッシュHIT:', cacheKey);
    return res.json({ ...cache[cacheKey], cached: true });
  }

  try {
    const [lat, lng] = ll.split(',').map(Number);
    console.log('Overture取得中:', ll, r + 'm');
    const result = await queryOverture(lat, lng, r);

    // キャッシュに保存
    cache[cacheKey] = result;
    saveCache(cache);
    console.log('キャッシュ保存:', cacheKey, 'score:', result.score);

    res.json({ ...result, cached: false });
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: e.message, score: 0, details: {} });
  }
});

// テストAPI
app.get('/api/test', async (req, res) => {
  try {
    const result = await queryOverture(35.6896, 139.7006, 800);
    res.json({ ok: true, source: 'Overture Maps', ...result });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// キャッシュ確認API
app.get('/api/cache', (req, res) => {
  res.json({ count: Object.keys(cache).length, keys: Object.keys(cache) });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
