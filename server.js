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
  try { if (fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE,'utf8')); } catch(e) {}
  return {};
}
function saveCache(c) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(c), 'utf8'); } catch(e) {}
}
let cache = loadCache();
console.log('キャッシュ読込:', Object.keys(cache).length + '件');

const db = new duckdb.Database(':memory:');
function initDB() {
  return new Promise((resolve, reject) => {
    const con = db.connect();
    con.exec(`INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';`, err => {
      con.close();
      if (err) reject(err); else resolve();
    });
  });
}

const S3 = "s3://overturemaps-us-west-2/release/2026-04-15.0/theme=places/type=place/*";

// カテゴリ→軸マッピング
const AXIS_MAP = {
  eat_and_drink:'飲食', restaurant:'飲食', cafe:'飲食', bar:'飲食',
  fast_food:'飲食', coffee:'飲食', bakery:'飲食', food_and_drink:'飲食',
  izakaya:'飲食', ramen:'飲食', sushi:'飲食', food:'飲食',
  retail:'商業', shopping:'商業', clothing:'商業', department_store:'商業',
  electronics:'商業', bookstore:'商業', sports_store:'商業', toy_store:'商業',
  hotel:'商業', entertainment:'商業', cinema:'商業', museum:'商業',
  amusement:'商業', art:'商業', theater:'商業', night_club:'商業',
  convenience_store:'生活', supermarket:'生活', grocery:'生活',
  beauty_salon:'生活', laundry:'生活', hair_salon:'生活', nail_salon:'生活',
  bank:'生活', atm:'生活', post_office:'生活', drugstore:'生活',
  pharmacy:'生活', gas_station:'生活',
  health_and_medicine:'医療', hospital:'医療', clinic:'医療',
  dentist:'医療', doctors:'医療', nursing_home:'医療'
};

const AXES = ['飲食','商業','生活','医療'];
const MAX_PTS = { '飲食':350, '商業':350, '生活':200, '医療':100 };

// 1駅の生カウント取得
async function getRawCounts(lat, lng, radius) {
  return new Promise((resolve, reject) => {
    const con = db.connect();
    const deg = radius / 111000;
    const degLng = deg / Math.cos(lat * Math.PI / 180);
    const sql = `
      SELECT categories.primary as cat, COUNT(*) as cnt
      FROM read_parquet('${S3}', hive_partitioning=false)
      WHERE bbox.xmin >= ${lng - degLng} AND bbox.xmax <= ${lng + degLng}
        AND bbox.ymin >= ${lat - deg}    AND bbox.ymax <= ${lat + deg}
      GROUP BY categories.primary
    `;
    con.all(sql, (err, rows) => {
      con.close();
      if (err) return reject(err);
      const counts = { '飲食':0, '商業':0, '生活':0, '医療':0 };
      (rows || []).forEach(row => {
        const axis = AXIS_MAP[row.cat || ''];
        if (axis) counts[axis] += (parseInt(row.cnt) || 0);
      });
      resolve(counts);
    });
  });
}

// 全駅一括スコア計算（相対評価）
app.post('/api/scores/batch', express.json(), async (req, res) => {
  const { stations, radius } = req.body;
  const r = parseInt(radius) || 800;
  const cacheKey = 'batch_' + r;

  // サーバーキャッシュヒット
  if (cache[cacheKey] && cache[cacheKey].stations) {
    console.log('バッチキャッシュHIT:', cacheKey);
    return res.json({ ...cache[cacheKey], cached: true });
  }

  try {
    console.log('全駅生カウント取得開始:', stations.length + '駅');

    // フェーズ1：全駅の生カウント取得
    const rawList = await Promise.all(
      stations.map(async (st) => {
        const key = st.lat + ',' + st.lng + '_' + r + '_raw';
        if (cache[key]) return { ...st, counts: cache[key] };
        const counts = await getRawCounts(st.lat, st.lng, r);
        cache[key] = counts;
        return { ...st, counts };
      })
    );
    saveCache(cache);

    // フェーズ2：カテゴリごとの最大値を求める
    const maxCounts = { '飲食':1, '商業':1, '生活':1, '医療':1 };
    rawList.forEach(st => {
      AXES.forEach(axis => {
        if (st.counts[axis] > maxCounts[axis]) maxCounts[axis] = st.counts[axis];
      });
    });

    console.log('カテゴリ最大値:', maxCounts);

    // フェーズ3：相対スコア計算
    const result = rawList.map(st => {
      const details = {};
      let total = 0;
      AXES.forEach(axis => {
        const pts = Math.round((st.counts[axis] / maxCounts[axis]) * MAX_PTS[axis]);
        details[axis] = { count: st.counts[axis], pts, max: MAX_PTS[axis] };
        total += pts;
      });
      return {
        name: st.name,
        pref: st.pref,
        score: Math.min(1000, total),
        details
      };
    });

    const output = { stations: result, maxCounts };
    cache[cacheKey] = output;
    saveCache(cache);

    console.log('バッチ完了');
    res.json({ ...output, cached: false });

  } catch(e) {
    console.error('バッチエラー:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// キャッシュクリア（半径変更時用）
app.delete('/api/cache/batch/:radius', (req, res) => {
  const key = 'batch_' + req.params.radius;
  delete cache[key];
  saveCache(cache);
  res.json({ ok: true });
});

app.get('/api/test', async (req, res) => {
  try {
    const counts = await getRawCounts(35.6896, 139.7006, 800);
    res.json({ ok: true, source: 'Overture Maps', 新宿生カウント: counts });
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

app.get('/api/cache', (req, res) => {
  res.json({ count: Object.keys(cache).length, keys: Object.keys(cache) });
});

initDB().then(() => {
  console.log('DuckDB初期化完了');
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log('Server running on port ' + PORT));
}).catch(e => { console.error(e); process.exit(1); });
