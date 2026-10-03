/* 離線快取：讓店家 POS 在網路不穩時仍可開啟，也讓頁面可安裝成 App */
const V='pos-v1';
const SHELL=['./','./index.html','./manifest.json','./manifest-admin.json','./icon-192.png','./icon-512.png'];
self.addEventListener('install',e=>{
  e.waitUntil(caches.open(V).then(c=>Promise.all(SHELL.map(u=>c.add(u).catch(()=>{})))).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',e=>{
  e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==V).map(x=>caches.delete(x)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch',e=>{
  const r=e.request;
  if(r.method!=='GET')return;
  const u=new URL(r.url);
  if(u.origin===location.origin){
    // 自己的檔案：網路優先（確保拿到最新版），斷線時用快取
    e.respondWith(fetch(r).then(res=>{
      if(res&&res.ok){const copy=res.clone();caches.open(V).then(c=>c.put(r,copy))}
      return res;
    }).catch(()=>caches.match(r,{ignoreSearch:true}).then(h=>h||caches.match('./index.html'))));
  }else if(u.hostname==='www.gstatic.com'){
    // Firebase 程式庫：快取優先
    e.respondWith(caches.match(r).then(h=>h||fetch(r).then(res=>{
      if(res&&res.ok){const copy=res.clone();caches.open(V).then(c=>c.put(r,copy))}
      return res;
    })));
  }
});
