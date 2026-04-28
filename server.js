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

// 4軸スコア設計（多様性・ボーナスを廃止）
const AXES = {
  '飲食充実': {
    cats: new Set(['eat_and_drink','restaurant','cafe','bar','fast_food','coffee','bakery','food_and_drink','izakaya','ramen','sushi']),
    target: 1800, max: 400, color: '#ff4060'
  },
  '生活利便': {
    cats: new Set(['convenience_store','supermarket','grocery','beauty_salon','laundry','drugstore','bank','atm','post_office','pharmacy','hair_salon','nail_salon']),
    target: 450, max: 300, color: '#4a9fd4'
  },
  '商業・小売': {
    cats: new Set(['retail','shopping','clothing','department_store','electronics','bookstore','hotel','professional_services','finance','entertainment','cinema','museum','sports','amusement','art','theater']),
    target: 350, max: 200, color: '#9b7fe8'
  },
  '医療・福祉': {
    cats: new Set(['health_and_medicine','hospital','clinic','dentist','doctors','nursing_home','welfare']),
    target: 150, max: 100, color: '#f09000'
  }
};

function linearScore(count, target, maxPt) {
  if(count<=0) return 0;
  return Math.min(maxPt, Math.round(count/target*maxPt));
}

async function queryOverture(lat, lng, radius) {
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
      const counts = {'飲食充実':0,'生活利便':0,'商業・小売':0,'医療・福祉':0};
      (rows||[]).forEach(row=>{
        const c=row.cat||'', n=parseInt(row.cnt)||0;
        for(const [axisName, axis] of Object.entries(AXES)){
          if(axis.cats.has(c)){ counts[axisName]+=n; break; }
        }
      });
      const details={};
      let total=0;
      for(const [axisName,axis] of Object.entries(AXES)){
        const pts=linearScore(counts[axisName],axis.target,axis.max);
        details[axisName]={count:counts[axisName],pts,max:axis.max,color:axis.color};
        total+=pts;
      }
      resolve({score:Math.min(1000,total),details});
    });
  });
}

app.get('/api/score',async(req,res)=>{
  const {ll,radius}=req.query;
  const r=parseInt(radius)||800;
  const key=ll+'_'+r;
  if(cache[key]){
    return res.json({...cache[key],cached:true});
  }
  try{
    const [lat,lng]=ll.split(',').map(Number);
    console.log('取得中:',key);
    const result=await queryOverture(lat,lng,r);
    cache[key]=result;
    saveCache(cache);
    console.log('完了:',key,'score:',result.score);
    res.json({...result,cached:false});
  }catch(e){
    console.error(e);
    res.status(500).json({error:e.message,score:0,details:{}});
  }
});

app.get('/api/test',async(req,res)=>{
  try{
    const r=await queryOverture(35.6896,139.7006,800);
    res.json({ok:true,source:'Overture Maps',...r});
  }catch(e){res.json({ok:false,error:e.message});}
});

app.get('/api/cache',(req,res)=>{
  res.json({count:Object.keys(cache).length,keys:Object.keys(cache)});
});

initDB().then(()=>{
  console.log('DuckDB初期化完了');
  const PORT=process.env.PORT||3000;
  app.listen(PORT,()=>console.log('Server running on port '+PORT));
}).catch(e=>{console.error(e);process.exit(1);});
