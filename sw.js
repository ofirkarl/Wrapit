// service worker מינימלי: מאפשר התקנה למסך הבית. תמיד מהרשת, ואם אין רשת — מהעותק האחרון ששמור.
const C="wrapit-v2";
self.addEventListener("install",e=>self.skipWaiting());
self.addEventListener("activate",e=>e.waitUntil(self.clients.claim()));
self.addEventListener("fetch",e=>{const u=new URL(e.request.url);if(e.request.method!=="GET"||u.origin!==location.origin)return;
  // cache:"no-cache" — תמיד בודקים מול השרת, כדי שעדכון יגיע מיד ולא אחרי 10 דקות של מטמון הדפדפן
  e.respondWith(fetch(e.request,{cache:"no-cache"}).then(r=>{if(r.ok){const c=r.clone();caches.open(C).then(x=>x.put(e.request,c))}return r}).catch(()=>caches.match(e.request)))});
