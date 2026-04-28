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
  try { if (fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch(e) {}
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
    con.exec(`INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';`, (err) => {
      con.close();
      if (err) reject(err); else resolve();
    });
  });
}

const S3 = "s3://overturemaps-us-west-2/release/2026-04-15.0/theme=places/type=place/*";

// Overtureカテゴリ → スコア軸マッピング
const CAT_MAP = {
  eat_and_drink:'飲食', restaurant:'飲食', cafe:'飲食', bar:'飲食',
  fast_food:'飲食', coffee:'飲食', bakery:'飲食', food_and_drink:'飲食',
  retail:'生活利便', shopping:'生活利便', supermarket:'生活利便',
  convenience_store:'生活利便', clothing:'生活利便', grocery:'生活利便',
  beauty_salon:'生活利便', laundry:'生活利便', drugstore:'生活利便',
  bank:'生活利便', atm:'生活利便', post_office:'生活利便',
  office:'ビジネス', business:'ビジネス', hotel:'ビジネス',
  professional_services:'ビジネス', finance:'ビジネス',
  health_and_medicine:'医療福祉', hospital:'医療福祉', clinic:'医療福祉',
  dentist:'医療福祉', pharmacy:'医療福祉', doctors:'医療福祉',
  entertainment:'エンタメ', cinema:'エンタメ', museum:'エンタメ',
  sports:'エンタメ', amusement:'エンタメ', art:'エンタメ', park:'エンタメ'
};

// 対数スコア計算
function logScore(count, base, maxPt) {
  if (count <= 0) return 0;
  const ratio = Math.log(1 + count) / Math.log(1 + base);
  return Math.min(maxPt, Math.round(maxPt * ratio));
}

async function queryOverture(lat, lng, radius) {
  return new Promise((resolve, reject) => {
    const con = db.connect();
    const deg = radius / 111000;
    const degLng = deg / Math.cos(lat * Math.PI / 180);
    const minX = lng - degLng, maxX = lng + degLng;
    const minY = lat - deg,    maxY = lat + deg;

    const sql = `
      SELECT categories.primary as cat, COUNT(*) as cnt
      FROM read_parquet('${S3}', hive_partitioning=false)
      WHERE bbox.xmin >= ${minX} AND bbox.xmax <= ${maxX}
        AND bbox.ymin >= ${minY} AND bbox.ymax <= ${maxY}
      GROUP BY categories.primary
    `;

    con.all(sql, (err, rows) => {
      con.close();
      if (err) return reject(err);

      const counts = { 飲食:0, 生活利便:0, ビジネス:0, 医療福祉:0, エンタメ:0, 多様性:new Set() };
      let total = 0;

      (rows || []).forEach(row => {
        const c = row.cat || '';
        const n = parseInt(row.cnt) || 0;
        total += n;
        const axis = CAT_MAP[c];
        if (axis && axis !== 'エンタメ') counts[axis] += n;
        else if (axis === 'エンタメ') counts['エンタメ'] += n;
        if (n > 0) counts['多様性'].add(c);
      });

      // 対数スコア計算（基準値は新宿レベルを想定）
      const 飲食Pt     = logScore(counts['飲食'],     2000, 300);
      const 生活Pt     = logScore(counts['生活利便'],  600,  200);
      const ビジネスPt = logScore(counts['ビジネス'],  500,  150);
      const 多様性Pt   = logScore(counts['多様性'].size, 40, 100);
      const 医療Pt     = logScore(counts['医療福祉'],  100,  100);
      const ボーナスPt = logScore(total,              3000, 150);

      const score = Math.min(1000,
        飲食Pt + 生活Pt + ビジネスPt + 多様性Pt + 医療Pt + ボーナスPt
      );

      resolve({
        score,
        details: {
          '飲食充実': { count: counts['飲食'],     pts: 飲食Pt,     max: 300 },
          '生活利便': { count: counts['生活利便'],  pts: 生活Pt,     max: 200 },
          'ビジネス': { count: counts['ビジネス'],  pts: ビジネスPt, max: 150 },
          '商業多様性':{ count: counts['多様性'].size, pts: 多様性Pt, max: 100 },
          '医療・福祉':{ count: counts['医療福祉'],  pts: 医療Pt,     max: 100 },
          '総合ボーナス':{ count: total,            pts: ボーナスPt, max: 150 }
        }
      });
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
    console.log('取得中:', key);
    const result = await queryOverture(lat, lng, r);
    cache[key] = result;
    saveCache(cache);
    console.log('完了:', key, 'score:', result.score);
    res.json({ ...result, cached: false });
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: e.message, score: 0, details: {} });
  }
});

app.get('/api/test', async (req, res) => {
  try {
    const result = await queryOverture(35.6896, 139.7006, 800);
    res.json({ ok: true, source: 'Overture Maps', ...result });
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

app.get('/api/cache', (req, res) => {
  res.json({ count: Object.keys(cache).length, keys: Object.keys(cache) });
});

initDB().then(() => {
  console.log('DuckDB初期化完了');
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log('Server running on port ' + PORT));
}).catch(e => { console.error('DuckDB初期化失敗:', e); process.exit(1); });
