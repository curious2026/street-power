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
  try { if (fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE,'utf8')); } catch(e){}
  return {};
}
function saveCache(c) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(c),'utf8'); } catch(e){}
}
let cache = loadCache();
console.log('キャッシュ読込:', Object.keys(cache).length+'件');

const db = new duckdb.Database(':memory:');
function initDB() {
  return new Promise((resolve,reject)=>{
    const con = db.connect();
    con.exec(`INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';`, err=>{
      con.close();
      if(err) reject(err); else resolve();
    });
  });
}

const S3 = "s3://overturemaps-us-west-2/release/2026-04-15.0/theme=places/type=place/*";

const AXIS_MAP = {
  eat_and_drink:'飲食', restaurant:'飲食', cafe:'飲食', bar:'飲食',
  fast_food:'飲食', coffee:'飲食', bakery:'飲食', food_and_drink:'飲食',
  izakaya:'飲食', ramen:'飲食', sushi:'飲食', food:'飲食',
  retail:'商業', shopping:'商業', clothing:'商業', department_store:'商業',
  electronics:'商業', bookstore:'商業', hotel:'商業', entertainment:'商業',
  cinema:'商業', museum:'商業', amusement:'商業', art:'商業', theater:'商業',
  convenience_store:'生活', supermarket:'生活', grocery:'生活',
  beauty_salon:'生活', laundry:'生活', hair_salon:'生活',
  bank:'生活', atm:'生活', post_office:'生活', drugstore:'生活', pharmacy:'生活',
  health_and_medicine:'医療', hospital:'医療', clinic:'医療',
  dentist:'医療', doctors:'医療'
};

const AXES = ['飲食','商業','生活','医療'];
const MAX_PTS = {'飲食':350,'商業':350,'生活':200,'医療':100};

// 全体の最大値（相対評価用）
// 初期値は新宿レベルの実測値を仮設定、全駅取得後に更新
let globalMax = {'飲食':2459,'商業':500,'生活':600,'医療':200};

async function getRawCounts(lat, lng, radius) {
  return new Promise((resolve,reject)=>{
    const con = db.connect();
    const deg = radius/111000;
    const degLng = deg/Math.cos(lat*Math.PI/180);
    const sql = `
      SELECT categories.primary as cat, COUNT(*) as cnt
      FROM read_parquet('${S3}', hive_partitioning=false)
      WHERE bbox.xmin>=${lng-degLng} AND bbox.xmax<=${lng+degLng}
        AND bbox.ymin>=${lat-deg} AND bbox.ymax<=${lat+deg}
      GROUP BY categories.primary
    `;
    con.all(sql,(err,rows)=>{
      con.close();
      if(err) return reject(err);
      const counts={'飲食':0,'商業':0,'生活':0,'医療':0};
      (rows||[]).forEach(row=>{
        const axis=AXIS_MAP[row.cat||''];
        if(axis) counts[axis]+=(parseInt(row.cnt)||0);
      });
      resolve(counts);
    });
  });
}

function calcScore(counts) {
  const details={};
  let total=0;
  AXES.forEach(axis=>{
    const pts=Math.round((counts[axis]/globalMax[axis])*MAX_PTS[axis]);
    const capped=Math.min(MAX_PTS[axis],pts);
    details[axis]={count:counts[axis],pts:capped,max:MAX_PTS[axis]};
    total+=capped;
  });
  return {score:Math.min(1000,total),details};
}

// 最大値を更新して全キャッシュのスコアを再計算
function rebuildScores() {
  const raw_prefix='raw_';
  Object.keys(cache).forEach(k=>{
    if(k.startsWith(raw_prefix)){
      const scoreKey=k.replace(raw_prefix,'score_');
      const result=calcScore(cache[k]);
      cache[scoreKey]=result;
    }
  });
  saveCache(cache);
}

// 個別スコア取得API
app.get('/api/score', async(req,res)=>{
  const {ll,radius}=req.query;
  const r=parseInt(radius)||800;
  const rawKey='raw_'+ll+'_'+r;
  const scoreKey='score_'+ll+'_'+r;

  // キャッシュヒット
  if(cache[scoreKey]){
    return res.json({...cache[scoreKey],cached:true});
  }

  try{
    const [lat,lng]=ll.split(',').map(Number);
    console.log('取得中:',ll);
    const counts=await getRawCounts(lat,lng,r);

    // globalMaxを更新
    let maxUpdated=false;
    AXES.forEach(axis=>{
      if(counts[axis]>globalMax[axis]){
        globalMax[axis]=counts[axis];
        maxUpdated=true;
      }
    });

    // 最大値が更新されたら全スコア再計算
    if(maxUpdated){
      console.log('globalMax更新:', globalMax);
      cache[rawKey]=counts;
      rebuildScores();
    } else {
      cache[rawKey]=counts;
      const result=calcScore(counts);
      cache[scoreKey]=result;
      saveCache(cache);
    }

    res.json({...cache[scoreKey],cached:false});
  }catch(e){
    console.error(e.message);
    res.status(500).json({error:e.message,score:0,details:{}});
  }
});

// globalMax取得API（フロントの相対表示用）
app.get('/api/maxvals',(req,res)=>{
  res.json(globalMax);
});

app.get('/api/test',async(req,res)=>{
  try{
    const counts=await getRawCounts(35.6896,139.7006,800);
    res.json({ok:true,counts,globalMax});
  }catch(e){res.json({ok:false,error:e.message});}
});

app.get('/api/cache',(req,res)=>{
  const scoreKeys=Object.keys(cache).filter(k=>k.startsWith('score_'));
  res.json({total:Object.keys(cache).length,scores:scoreKeys.length,globalMax});
});

initDB().then(()=>{
  console.log('DuckDB初期化完了');

  // 起動時にキャッシュからglobalMaxを復元
  const rawKeys=Object.keys(cache).filter(k=>k.startsWith('raw_'));
  rawKeys.forEach(k=>{
    AXES.forEach(axis=>{
      if(cache[k][axis]>globalMax[axis]) globalMax[axis]=cache[k][axis];
    });
  });
  console.log('globalMax復元:', globalMax);

  const PORT=process.env.PORT||3000;
  app.listen(PORT,()=>console.log('Server running on port '+PORT));
}).catch(e=>{console.error(e);process.exit(1);});
