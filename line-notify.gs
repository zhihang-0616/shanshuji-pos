/**
 * 新訂單通知（Discord）＋ LINE Pay 線上支付 ＋ 每日資料備份（Google Apps Script）
 *
 * 做三件事：
 *  1. 點餐網頁通知有新訂單時，到 Firebase 讀取該訂單內容，推送到 Discord 頻道（可另外加 Telegram）。
 *     （訊息一律從資料庫讀取，不吃網頁傳來的文字，避免被人亂發訊息洗版。）
 *     送失敗不會漏：lpSweep 每分鐘會檢查，30 分鐘內的新單沒通知到就自動補發。
 *  2. LINE Pay 線上支付（要付款連結、確認收款、退款、逾時改現場掃碼）。
 *  3. 每天凌晨自動備份整個資料庫到你的 Google 雲端硬碟（資料夾「POS備份」，保留 30 天）。
 *
 *  ※ 已移除 LINE 群組通知（LINE 免費方案每月只有 100 則，不夠用）。LINE Pay 付款功能不受影響。
 *
 * 在「專案設定 → 指令碼屬性」新增（全部都是私密資料，不要貼到別的地方）：
 *   DISCORD_WEBHOOK = Discord Webhook 網址（訂單通知必填）
 *   TG_TOKEN / TG_CHAT = 選填：Telegram 機器人代碼與群組代號（執行 tgSetup 會自動存 TG_CHAT）
 *   DISCORD_RELAY / DISCORD_RELAY_KEY = 選填：Cloudflare Worker 轉送站網址與密碼（Discord 擋 Google 位址時用）
 *   FIREBASE_SA     = Firebase 服務帳戶金鑰（整份 JSON 內容；自動備份、補發通知、LINE Pay 線上支付需要）
 *   LINEPAY_ID      = LINE Pay Channel ID
 *   LINEPAY_SECRET  = LINE Pay Channel Secret Key（絕對不要放進網頁或貼給別人）
 *   LINEPAY_ENV     = 不填＝正式環境；填 sandbox＝測試環境
 *   （舊的 LINE_TOKEN、GROUP_ID、LINE_SCOPE 已經用不到，可執行 cleanupLineSettings 一次刪掉）
 */
const DB_URL = 'https://chuobian-pos-default-rtdb.asia-southeast1.firebasedatabase.app';
const P = PropertiesService.getScriptProperties();

function doGet(e) {
  const a = e && e.parameter && e.parameter.a;
  if (a === 'lpc') return lpConfirm_(e.parameter);   // LINE Pay 付款完成後，顧客被導回這裡
  if (a === 'lpx') return lpBack_('cancel', e.parameter.id, '', e.parameter.adm);   // 顧客在 LINE Pay 按了取消
  return ContentService.createTextOutput('POS notify OK');
}

function doPost(e) {
  let body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) {}
  if (body.events) return ContentService.createTextOutput('ok');           // 舊的 LINE 機器人 Webhook：已停用，直接略過
  if (body.type === 'order' && body.id) notifyOrder(String(body.id)); // 來自點餐網頁
  else if (body.type === 'lpCheck' && body.id) {                             // 顧客打開「我的訂單」：順便檢查有沒有付了款卻沒跳回來
    const c = CacheService.getScriptCache(), k = 'lpchk_' + body.id;
    if (!c.get(k)) { c.put(k, '1', 10); try { lpTryConfirm_(String(body.id)); } catch (err) {} }
  }
  else if (body.type === 'lpCash' && body.id) {                              // 線上支付開不起來／不想付了：改成到店付款
    let r;
    try { r = lpToCash_(String(body.id)); } catch (err) { r = { ok: false, err: String(err) }; }
    return ContentService.createTextOutput(JSON.stringify(r)).setMimeType(ContentService.MimeType.JSON);
  }
  else if (body.type === 'lpRefund' && body.id) {                            // 店長按「LINE Pay 退款」
    let r;
    try { r = lpRefund_(String(body.id), String(body.token || '')); } catch (err) { r = { ok: false, err: String(err) }; }
    return ContentService.createTextOutput(JSON.stringify(r)).setMimeType(ContentService.MimeType.JSON);
  }
  else if (body.type === 'lpPay' && body.id) {                              // 顧客要用 LINE Pay 線上支付
    let r;
    try { r = lpRequest_(String(body.id), !!body.adm); } catch (err) { r = { ok: false, err: String(err) }; }
    return ContentService.createTextOutput(JSON.stringify(r)).setMimeType(ContentService.MimeType.JSON);
  }
  return ContentService.createTextOutput('ok');
}

/* ---------- 新訂單通知 ---------- */
/* 注意：呼叫這個函式時，不可以還拿著別的鎖（否則會卡死、通知漏發）。
 * 每個管道送成功後，除了暫存，還會在訂單上記 ntD（Discord）／ntT（Telegram），lpSweep 會替漏發的單補發。 */
function notifyOrder(id) {
  const cache = CacheService.getScriptCache();
  const hook = P.getProperty('DISCORD_WEBHOOK') || P.getProperty('DISCORD_RELAY');
  const tgOn = tgReady_();
  if (!hook && !tgOn) { if (!cache.get('nt_nochan')) { cache.put('nt_nochan', '1', 3600); ntLog_('沒有設定任何通知管道（DISCORD_WEBHOOK），新訂單不會通知'); } return; }
  if ((!hook || cache.get('nd_' + id)) && (!tgOn || cache.get('nt_' + id))) return;   // 已通知過
  const lock = LockService.getScriptLock();
  let locked = false;
  try { lock.waitLock(12000); locked = true; } catch (e) { ntLog_(id + ' 等不到鎖，改為不鎖直接送（有 DB 旗標防重複）'); }   // 寧可偶爾重複，也不要漏通知
  try {
    const needDiscord0 = !!hook && !cache.get('nd_' + id);
    const needTg0 = tgOn && !cache.get('nt_' + id);
    if (!needDiscord0 && !needTg0) return;
    const res = UrlFetchApp.fetch(DB_URL + '/orders/' + encodeURIComponent(id) + '.json', { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) { ntLog_(id + ' 讀不到訂單（' + res.getResponseCode() + '），等 lpSweep 補發'); return; }
    const o = JSON.parse(res.getContentText());
    if (!o || !o.no) return;
    if (o.lp === 'expired') return;                                        // （舊版逾時取消的單不通知；現在逾時改成「現場掃碼收款」，不會再取消）
    if (o.late || o.status === 'cancelled') return;                        // 補單（事後補登）與已作廢的單不通知
    if (Date.now() - Number(o.createdAt || 0) > 5 * 60 * 60 * 1000) return; // 只通知 5 小時內的單（避免舊單被重複觸發）
    const needDiscord = needDiscord0 && !o.ntD, needTg = needTg0 && !o.ntT;
    const text = formatOrder(o), flags = {};
    // Discord：免費、沒有則數限制，每張新單都送
    if (needDiscord) { if (sendDiscord(text) === true) { cache.put('nd_' + id, '1', 21600); flags.ntD = true; } else ntLog_('#' + o.no + ' Discord 送出失敗'); }
    else if (hook && o.ntD) cache.put('nd_' + id, '1', 21600);
    // Telegram（選填）：免費、不限則數，每張新單都送
    if (needTg) { if (sendTelegram(text) === true) { cache.put('nt_' + id, '1', 21600); flags.ntT = true; } else ntLog_('#' + o.no + ' Telegram 送出失敗'); }
    else if (tgOn && o.ntT) cache.put('nt_' + id, '1', 21600);
    if ((flags.ntD || flags.ntT) && o.lp === 'paid') flags.ntP = true;     // 這則通知本身已寫明「已付款」，不用再補發付款通知
    if (flags.ntD || flags.ntT || flags.ntP) { try { patchOrder_(id, flags); } catch (e) { console.error('記錄通知狀態失敗：' + e); } }
  } finally {
    if (locked) lock.releaseLock();
  }
}

/* 通知紀錄：留最近 20 筆在「指令碼屬性」NT_LOG，執行 diagNotify 就能看到哪一則、哪個管道、為什麼沒送出去 */
function ntLog_(msg) {
  try {
    const old = String(P.getProperty('NT_LOG') || '').split('\n').filter(Boolean);
    old.push(Utilities.formatDate(new Date(), 'Asia/Taipei', 'MM/dd HH:mm:ss') + ' ' + msg);
    P.setProperty('NT_LOG', old.slice(-20).join('\n'));
  } catch (e) {}
}

/* 送一則簡短訊息到 Discord（有設定 Telegram 也會送）。回傳「有送的管道是否都成功」 */
function notifyBoth_(text, o) {
  let ok = true;
  const hook = P.getProperty('DISCORD_WEBHOOK') || P.getProperty('DISCORD_RELAY');
  if (hook && sendDiscord(text) !== true) ok = false;
  if (tgReady_() && sendTelegram(text) !== true) ok = false;
  return ok;
}

/* 線上支付成功的簡短通知（新單通知當時還沒付款的才需要補這則） */
function notifyPaid_(id) {
  const o = getOrder_(id);
  if (!o || !o.no || o.lp !== 'paid' || o.ntP || o.late || o.status === 'cancelled') return;
  if (notifyBoth_('💰 訂單 #' + o.no + '（' + (o.name || '') + '）線上支付成功 $' + o.total + '（LINE Pay）', o)) { try { patchOrder_(id, { ntP: true }); } catch (e) {} }
}
/* 付款成功之後一定要呼叫（必須在放掉鎖之後）：新單通知還沒送就先送，再送付款成功通知 */
function notifyAfterPaid_(id) {
  try { notifyOrder(id); } catch (e) { console.error('notifyOrder：' + e); }
  try { notifyPaid_(id); } catch (e) { console.error('notifyPaid_：' + e); }
}

function isOnlineOrder(o) { return !o.staff && (!o.src || o.src === '線上'); }

/* 一個品項一行；套餐會多一行「內含」，方便拿餐 */
function addItem(lines, x) {
  lines.push('・' + x.name + ' ×' + x.qty);
  if (x.inc) lines.push('　└ 內含' + (Number(x.qty) > 1 ? '（每份）' : '') + '：' + x.inc);
}

/* 金額對不起來（品項加總和小計不一致）就加一行警示 */
function amountWarning(o) {
  const items = o.items || [];
  if (o.staff || o.subtotal == null) return '';
  const sum = items.reduce(function (a, x) { return a + (Number(x.price) || 0) * (Number(x.qty) || 0); }, 0);
  return Math.abs(sum - Number(o.subtotal)) > 0.5 ? '⚠ 金額異常：品項加總 $' + sum + '，訂單小計 $' + o.subtotal + '，請核對' : '';
}

function formatOrder(o) {
  const items = o.items || [];
  const lines = [];
  lines.push('🔔 新訂單 #' + o.no + (o.src && o.src !== '線上' ? '（' + o.src + '）' : ''));
  lines.push('⏰ 取餐時間：' + o.time);
  lines.push('👤 ' + o.name + (o.phone ? '　' + o.phone : ''));
  lines.push('────────────');
  const people = (o.people && o.people.length > 1) ? o.people : null;
  if (people) {
    people.forEach(function (pp, i) {
      const opt = [pp.flavor, pp.spice, pp.salt].filter(Boolean).join('/');
      lines.push('【' + pp.name + '】' + opt + (pp.note ? '｜' + pp.note : ''));
      items.filter(function (x) { return (x.p || 0) === i; })
           .forEach(function (x) { addItem(lines, x); });
    });
  } else {
    const opt = [o.flavor, o.spice, o.salt].filter(Boolean).join('/');
    const gearTxt = (o.gear && o.gear.length) ? '配備：' + o.gear.join('、') : '';
    if (opt || gearTxt) lines.push([opt, gearTxt].filter(Boolean).join('｜'));
    if (o.note) lines.push('📝 備註：' + o.note);
    items.forEach(function (x) { addItem(lines, x); });
  }
  if (people) {
    if (o.gear && o.gear.length) lines.push('配備：' + o.gear.join('、'));
    if (o.note) lines.push('📝 備註：' + o.note);
  }
  lines.push('────────────');
  lines.push('💰 $' + o.total + '（' + (o.pay || '') + '）');
  if (o.lp === 'paid') lines.push('✅ 已付款（LINE Pay 線上支付）');
  else if (o.lp === 'pending' && !o.paid) lines.push('⏳ 尚未付款（顧客正在 LINE Pay 線上支付，可先製作；付款成功會再通知）');
  else if (o.paid) lines.push('✅ 已收款');
  else if (o.pay === '轉帳') lines.push('⏳ 尚未收款（轉帳' + (o.x5 ? '，顧客帳號後五碼 ' + o.x5 : '') + '），請核對入帳');
  else if (o.lpFallback) lines.push('⏳ 尚未收款（LINE Pay 現場掃碼）※顧客原選線上支付，改為現場掃碼，取餐時請收款');
  else lines.push('⏳ 尚未收款（到店付款）');
  const warn = amountWarning(o);
  if (warn) lines.push(warn);
  return lines.join('\n');
}

/* ---------- Discord ---------- */
/* Discord 回「429 error code: 1015」＝Discord 前面的 Cloudflare 暫時擋掉 Google 伺服器的網路位址（很多人共用，不是你的錯）。
 * 對策：換用 Discord 的其他網址（同一個 Webhook，網域不同）輪流試；還是不行，訂單上不會記「已通知」，lpSweep 每分鐘會再補發。 */
function sendDiscord(text) {
  const hook = String(P.getProperty('DISCORD_WEBHOOK') || '').replace(/\s+/g, '');
  const relay = String(P.getProperty('DISCORD_RELAY') || '').replace(/\s+/g, '');
  if (!hook && !relay) return false;
  if (relay) {                                                    // 有設定「轉送站」（Cloudflare Worker）就先走轉送站，失敗再直接送
    for (let k = 0; k < 2; k++) {
      try {
        const r = UrlFetchApp.fetch(relay, { method: 'post', contentType: 'application/json', muteHttpExceptions: true,
          headers: { 'X-Relay-Key': String(P.getProperty('DISCORD_RELAY_KEY') || '').trim() }, payload: JSON.stringify({ content: String(text).slice(0, 1900) }) });
        const c = r.getResponseCode();
        if (c >= 200 && c < 300) return true;
        console.error('Discord 轉送站失敗：' + c + ' ' + r.getContentText().slice(0, 150));
        if (c === 403) break;                                     // 密碼不對，重試沒用
      } catch (e) { console.error('Discord 轉送站連線失敗：' + e); }
      Utilities.sleep(600);
    }
    if (!hook) { ntLog_('Discord 轉送站失敗'); return false; }
  }
  const hosts = ['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com'];
  const urls = [hook].concat(hosts.map(function (h) { return hook.replace(/^https:\/\/[^\/]+/, 'https://' + h); })).filter(function (u, i, a) { return a.indexOf(u) === i; });
  for (let i = 0; i < Math.min(urls.length, 5); i++) {
    let res;
    try {
      res = UrlFetchApp.fetch(urls[i], {
        method: 'post', contentType: 'application/json', muteHttpExceptions: true,
        headers: { 'User-Agent': 'DiscordBot (pos-notify, 1.0)' },
        payload: JSON.stringify({ content: String(text).slice(0, 1900) })
      });
    } catch (e) { console.error('Discord 連線失敗：' + e); Utilities.sleep(800); continue; }
    const code = res.getResponseCode();
    if (code >= 200 && code < 300) return true;
    const body = res.getContentText().slice(0, 200);
    console.error('Discord 送出失敗（第 ' + (i + 1) + ' 個網址 ' + urls[i].split('/')[2] + '）：' + code + ' ' + body);
    if (code === 429 && /1015/.test(body)) { Utilities.sleep(500); continue; }     // Cloudflare 擋位址：直接換下一個網域
    if (code === 429) { let w = 1500; try { w = Math.min(3000, Math.ceil((JSON.parse(body).retry_after || 1.5) * 1000)); } catch (e) {} Utilities.sleep(w); continue; }
    if (code >= 500) { Utilities.sleep(800); continue; }
    return false;                                                 // 網址錯誤、被刪除等，換網域也沒用
  }
  ntLog_('Discord 全部網址都失敗（可能被 Cloudflare 暫時擋住），等 lpSweep 補發');
  return false;
}

/* ---------- Telegram（選填；免費、不限則數，Discord 被擋時的備援通知）----------
 * 指令碼屬性：TG_TOKEN（機器人代碼）、TG_CHAT（群組代號；執行 tgSetup 會自動找出並存好）*/
function tgReady_() { return !!(String(P.getProperty('TG_TOKEN') || '').trim() && String(P.getProperty('TG_CHAT') || '').trim()); }
function sendTelegram(text) {
  if (!tgReady_()) return false;
  const tok = String(P.getProperty('TG_TOKEN')).trim(), chat = String(P.getProperty('TG_CHAT')).trim();
  for (let i = 0; i < 3; i++) {
    let res;
    try {
      res = UrlFetchApp.fetch('https://api.telegram.org/bot' + tok + '/sendMessage', {
        method: 'post', contentType: 'application/json', muteHttpExceptions: true,
        payload: JSON.stringify({ chat_id: chat, text: String(text).slice(0, 4000) })
      });
    } catch (e) { console.error('Telegram 連線失敗：' + e); Utilities.sleep(800); continue; }
    const code = res.getResponseCode();
    if (code === 200) return true;
    const body = res.getContentText().slice(0, 200);
    console.error('Telegram 送出失敗（第 ' + (i + 1) + ' 次）：' + code + ' ' + body);
    if (code === 429) { let w = 1500; try { w = Math.min(4000, (JSON.parse(body).parameters.retry_after || 1.5) * 1000); } catch (e) {} Utilities.sleep(w); continue; }
    if (code >= 500) { Utilities.sleep(800); continue; }
    ntLog_('Telegram ' + code + ' ' + body);
    return false;                                                 // 代碼錯誤、機器人被踢出群組等，重試也沒用
  }
  return false;
}
/* 設定用：機器人加進群組、在群組講一句話之後，執行這個，會自動找出群組並存好（TG_CHAT） */
function tgSetup() {
  const tok = String(P.getProperty('TG_TOKEN') || '').trim();
  if (!tok) { Logger.log('❌ 還沒有設定 TG_TOKEN（機器人代碼）'); return; }
  const r = UrlFetchApp.fetch('https://api.telegram.org/bot' + tok + '/getUpdates', { muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) { Logger.log('❌ 代碼不對或機器人不存在：' + r.getResponseCode() + ' ' + r.getContentText().slice(0, 150)); return; }
  const found = {};
  (JSON.parse(r.getContentText()).result || []).forEach(function (u) {
    [u.message, u.edited_message, u.channel_post, u.my_chat_member].forEach(function (m) { const c = m && m.chat; if (c && c.id) found[c.id] = c.title || c.username || c.first_name || String(c.id); });
  });
  const ids = Object.keys(found);
  if (!ids.length) { Logger.log('❌ 還沒找到群組。請確認：①機器人已加進群組 ②在群組裡傳一句話（例如 /start）③再執行一次 tgSetup'); return; }
  const groups = ids.filter(function (i) { return Number(i) < 0; });          // 群組的代號是負數
  const pick = groups.length ? groups[groups.length - 1] : ids[ids.length - 1];
  P.setProperty('TG_CHAT', String(pick));
  Logger.log('✅ 已設定通知群組：' + found[pick] + '（' + pick + '）。' + (ids.length > 1 ? '（找到多個聊天：' + ids.map(function (i) { return found[i] + ' ' + i; }).join('、') + '；如果選錯，請手動修改 TG_CHAT）' : '') + ' 現在執行 testTelegram 試試看。');
}
function testTelegram() { Logger.log(sendTelegram('✅ 測試：Telegram 訂單通知運作中') ? 'Telegram 送出成功' : 'Telegram 送出失敗，請看上面的原因（或先執行 tgSetup）'); }

/* =====================================================================
 * 每日自動備份（整個資料庫 → Google 雲端硬碟「POS備份」資料夾，保留最近 30 份）
 * 需要 FIREBASE_SA（服務帳戶金鑰）。設定好後執行一次 setupBackupTrigger() 就會每天凌晨 4 點自動備份。
 * ===================================================================== */
const BACKUP_FOLDER = 'POS備份';
const KEEP_DAYS = 30;

function b64url_(x) { return Utilities.base64EncodeWebSafe(x).replace(/=+$/, ''); }

/* 用服務帳戶換取讀寫資料庫的存取權杖 */
function saToken_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('sa_tok');
  if (hit) return hit;
  const raw = P.getProperty('FIREBASE_SA');
  if (!raw) throw new Error('還沒有設定 FIREBASE_SA（服務帳戶金鑰）');
  const sa = JSON.parse(raw);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600
  };
  const unsigned = b64url_(JSON.stringify(header)) + '.' + b64url_(JSON.stringify(claim));
  const sig = b64url_(Utilities.computeRsaSha256Signature(unsigned, sa.private_key));
  const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post',
    payload: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: unsigned + '.' + sig },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) throw new Error('取得權杖失敗：' + res.getContentText());
  const tok = JSON.parse(res.getContentText()).access_token;
  cache.put('sa_tok', tok, 3000);
  return tok;
}

function twDate_(d) { return Utilities.formatDate(d || new Date(), 'Asia/Taipei', 'yyyyMMdd'); }

function dailyBackup() {
  try {
    const tok = saToken_();
    const res = UrlFetchApp.fetch(DB_URL + '/.json?access_token=' + encodeURIComponent(tok), { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) throw new Error('讀取資料庫失敗：' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 200));
    const text = res.getContentText();
    const data = JSON.parse(text) || {};
    const folders = DriveApp.getFoldersByName(BACKUP_FOLDER);
    const folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(BACKUP_FOLDER);
    const name = 'pos-backup-' + twDate_() + '.json';
    const old = folder.getFilesByName(name);
    while (old.hasNext()) old.next().setTrashed(true);                    // 同一天重跑就覆蓋
    folder.createFile(name, text, 'application/json');
    // 清掉超過保留天數的舊備份
    const cutoff = Date.now() - KEEP_DAYS * 86400000;
    const files = folder.getFiles();
    while (files.hasNext()) { const f = files.next(); if (f.getDateCreated().getTime() < cutoff) f.setTrashed(true); }
    const kb = Math.round(text.length / 1024);
    const orders = data.orders ? Object.keys(data.orders).length : 0;
    // 把「這次備份成功」記回資料庫，後台「資料備份」畫面就看得到
    UrlFetchApp.fetch(DB_URL + '/shopMeta/lastAuto.json?access_token=' + encodeURIComponent(tok), {
      method: 'put', contentType: 'application/json',
      payload: JSON.stringify({ at: Date.now(), kb: kb, orders: orders, by: 'auto' }), muteHttpExceptions: true
    });
    sendDiscord('✅ 資料備份完成：' + name + '（' + kb + ' KB，訂單 ' + orders + ' 筆）');
    return name;
  } catch (err) {
    console.error('備份失敗：' + err);
    sendDiscord('❌ 資料備份失敗：' + err);
    throw err;
  }
}

/* 設定每天凌晨 4 點（台灣時間，營業日換日之後）自動備份；執行一次即可 */
function setupBackupTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'dailyBackup') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('dailyBackup').timeBased().everyDays(1).atHour(4).inTimezone('Asia/Taipei').create();
}

/* ---------- 手動工具（在 Apps Script 編輯器選函式後按「執行」）---------- */
function testDiscord() { Logger.log(sendDiscord('✅ 測試：Discord 訂單通知運作中') ? 'Discord 送出成功' : 'Discord 送出失敗，請檢查 DISCORD_WEBHOOK'); }
/* 診斷通知：選 diagNotify → 執行，看「執行記錄」。會檢查 Discord、最近的失敗原因、最近訂單有沒有通知 */
function diagNotify() {
  Logger.log('DISCORD_WEBHOOK：' + (P.getProperty('DISCORD_WEBHOOK') ? '已設定' : '❌ 沒設定') + (P.getProperty('DISCORD_RELAY') ? '｜轉送站：已設定' : ''));
  Logger.log('Discord 測試：' + (sendDiscord('🔧 diagNotify 測試訊息') ? '✅ 送出成功' : '❌ 送出失敗（看上面 Discord 失敗原因，或網址已失效）'));
  Logger.log('Telegram：' + (tgReady_() ? (sendTelegram('🔧 diagNotify 測試訊息') ? '✅ 送出成功' : '❌ 送出失敗') : '未設定（可選）'));
  Logger.log('補發觸發器 lpSweep：' + (ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'lpSweep'; }) ? '✅ 已設定' : '❌ 沒有設定（通知失敗不會補發，請執行 setupSweepTrigger）'));
  Logger.log('最近的通知失敗紀錄：\n' + (P.getProperty('NT_LOG') || '（沒有）'));
  const res = UrlFetchApp.fetch(DB_URL + '/orders.json?orderBy=' + encodeURIComponent('"createdAt"') + '&startAt=' + (Date.now() - 6 * 3600 * 1000) + '&access_token=' + saToken_(), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) { Logger.log('❌ 讀不到訂單（' + res.getResponseCode() + '）：' + res.getContentText().slice(0, 200) + '　→ 請執行 diagFirebase 檢查金鑰'); return; }
  const all = JSON.parse(res.getContentText()) || {};
  if (!Object.keys(all).length) Logger.log('最近 6 小時沒有訂單');
  Object.keys(all).map(function (k) { return all[k]; }).sort(function (a, b) { return a.createdAt - b.createdAt; }).slice(-8).forEach(function (o) {
    Logger.log('#' + o.no + '｜' + (o.src || '') + '｜' + (o.status || '') + '｜DC通知=' + (o.ntD ? '有' : '無') + (tgReady_() ? '｜TG通知=' + (o.ntT ? '有' : '無') : ''));
  });
}
/* 一次性清理：刪掉已經用不到的 LINE 機器人設定（LINE Pay 的設定不會動到） */
function cleanupLineSettings() {
  ['LINE_TOKEN', 'GROUP_ID', 'LINE_SCOPE'].forEach(function (k) { P.deleteProperty(k); });
  Logger.log('✅ 已刪除 LINE_TOKEN、GROUP_ID、LINE_SCOPE（LINEPAY_ID／LINEPAY_SECRET 保留不動）');
}
function testBackup() { Logger.log('備份完成：' + dailyBackup()); }


/* =====================================================================
 *  LINE Pay 線上支付（Online API v3）
 *  流程：顧客送單（訂單標記 lp=pending，新單通知立刻送出，店家可先做）→ 網頁呼叫 lpPay → 這裡向 LINE Pay 要付款連結
 *        → 顧客到 LINE Pay 付款 → 被導回 lpc → 這裡向 LINE Pay 確認 → 訂單改成已付款並再通知「線上支付成功」
 *        → 付款失敗／逾時：訂單不取消，改成「現場掃碼」收款並提醒店家
 *  金額一律以資料庫裡的訂單為準，不吃網頁傳來的金額。
 * ===================================================================== */
const SITE = 'https://zhihang-0616.github.io/shanshuji-pos/';
const HOOK_URL = 'https://script.google.com/macros/s/AKfycbzuHsCZCeZTgMhya7LXAruduye3Oq5d402VLuGnRx1i7gfbmQrpCyYKMn49FBFEtNfEsQ/exec';   // 本程式的網頁應用程式網址（與 index.html 的 LINE_HOOK 相同）

function lpBase_() { return P.getProperty('LINEPAY_ENV') === 'sandbox' ? 'https://sandbox-api-pay.line.me' : 'https://api-pay.line.me'; }

function lpCall_(uri, bodyObj, baseOverride) {
  const id = String(P.getProperty('LINEPAY_ID') || '').replace(/\s+/g, ''), secret = String(P.getProperty('LINEPAY_SECRET') || '').replace(/\s+/g, '');
  if (!id || !secret) throw new Error('還沒有設定 LINEPAY_ID / LINEPAY_SECRET');
  // 中文一律轉成 \uXXXX（整份內容變成純英數字），簽名與實際送出的內容才不會因編碼不同而對不上
  const body = JSON.stringify(bodyObj || {}).replace(/[\u007f-\uffff]/g, function (c) { return '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4); });
  const nonce = Utilities.getUuid();
  const sig = Utilities.base64Encode(Utilities.computeHmacSha256Signature(secret + uri + body + nonce, secret));
  const res = UrlFetchApp.fetch((baseOverride || lpBase_()) + uri, {
    method: 'post', contentType: 'application/json', payload: body, muteHttpExceptions: true,
    headers: { 'X-LINE-ChannelId': id, 'X-LINE-Authorization-Nonce': nonce, 'X-LINE-Authorization': sig }
  });
  let json = {};
  // transactionId 是 19 位數字，直接 JSON.parse 會被四捨五入而對不上，先把它變成文字再解析
  try { json = JSON.parse(res.getContentText().replace(/("transactionId"\s*:\s*)(\d+)/g, '$1"$2"')); } catch (e) { json = { returnCode: 'HTTP' + res.getResponseCode(), returnMessage: res.getContentText().slice(0, 200) }; }
  return json;
}

/* 向 LINE Pay 查詢「這筆付款現在進行到哪」（只是查詢，不會動到交易，顧客正在付款也不會被打斷）。
 * 回傳 returnCode：0000＝顧客已授權、可以請款（confirm）；其他代碼＝還在付款中／已取消／失敗，先不要 confirm */
function lpStatus_(txn) {
  const id = String(P.getProperty('LINEPAY_ID') || '').replace(/\s+/g, ''), secret = String(P.getProperty('LINEPAY_SECRET') || '').replace(/\s+/g, '');
  if (!id || !secret) throw new Error('還沒有設定 LINEPAY_ID / LINEPAY_SECRET');
  const uri = '/v3/payments/requests/' + encodeURIComponent(txn) + '/check', nonce = Utilities.getUuid();
  const sig = Utilities.base64Encode(Utilities.computeHmacSha256Signature(secret + uri + '' + nonce, secret));
  const res = UrlFetchApp.fetch(lpBase_() + uri, { method: 'get', muteHttpExceptions: true,
    headers: { 'Content-Type': 'application/json', 'X-LINE-ChannelId': id, 'X-LINE-Authorization-Nonce': nonce, 'X-LINE-Authorization': sig } });
  let j = {};
  try { j = JSON.parse(res.getContentText()); } catch (e) { j = { returnCode: 'HTTP' + res.getResponseCode(), returnMessage: res.getContentText().slice(0, 100) }; }
  return j;
}
/* 先查狀態，顧客已授權才請款；回傳請款結果（沒請款回 null）。不會在顧客還在付款時亂打 confirm */
function lpConfirmIfAuthorized_(txn, total, tag) {
  let st = null;
  try { st = lpStatus_(txn); } catch (e) { lpLog_(tag + ' 查詢狀態失敗 ' + e); return null; }
  lpLog_(tag + ' 狀態 ' + st.returnCode + ' ' + (st.returnMessage || ''));
  if (st.returnCode !== '0000') return null;
  const r = lpCall_('/v3/payments/' + encodeURIComponent(txn) + '/confirm', { amount: total, currency: 'TWD' });
  lpLog_(tag + ' 請款 ' + r.returnCode + ' ' + (r.returnMessage || ''));
  return r;
}
/* LINE Pay 流程紀錄：留最近 30 筆，執行 diagLpLog 就能看到每次查詢／請款的結果與時間 */
function lpLog_(msg) {
  try {
    const old = String(P.getProperty('LP_LOG') || '').split('\n').filter(Boolean);
    old.push(Utilities.formatDate(new Date(), 'Asia/Taipei', 'MM/dd HH:mm:ss') + ' ' + msg);
    P.setProperty('LP_LOG', old.slice(-30).join('\n'));
  } catch (e) {}
}
function diagLpLog() { Logger.log('LINE Pay 流程紀錄（最近 30 筆）：\n' + (P.getProperty('LP_LOG') || '（沒有）')); }

function getOrder_(id) {
  const res = UrlFetchApp.fetch(DB_URL + '/orders/' + encodeURIComponent(id) + '.json', { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return null;
  return JSON.parse(res.getContentText());
}
function patchOrder_(id, obj) {
  const res = UrlFetchApp.fetch(DB_URL + '/orders/' + encodeURIComponent(id) + '.json?access_token=' + saToken_(), {
    method: 'patch', contentType: 'application/json', payload: JSON.stringify(obj), muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) throw new Error('寫入訂單失敗：' + res.getContentText());
}

/* 記下付款出了什麼問題（員工頁的訂單卡片會顯示），並通知 Discord，方便事後查原因 */
function lpErr_(id, o, stage, code, msg) {
  try { patchOrder_(id, { lpErr: { at: Date.now(), stage: stage, code: String(code || ''), msg: String(msg || '').slice(0, 200) } }); } catch (e) {}
  try { sendDiscord('⚠ 訂單 #' + (o && o.no) + ' 線上支付出問題（' + stage + '）：' + code + ' ' + (msg || '')); } catch (e) {}
}

/* 向 LINE Pay 要付款連結 */
function lpRequest_(id, adm) {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(30000); } catch (e) { return { ok: false, err: '系統忙碌中，請再按一次「重新付款」' }; }
  let r, paidNow = false;
  try { r = lpRequestInner_(id, adm); paidNow = !!r._paidNow; } finally { lock.releaseLock(); }
  if (paidNow) notifyAfterPaid_(id);                               // 通知一定要在放掉鎖之後才送
  delete r._paidNow;
  return r;
}

function lpRequestInner_(id, adm) {
  const o = getOrder_(id);
  if (!o || !o.no) return { ok: false, err: '找不到訂單' };
  if (o.paid && o.lp === 'paid') return { ok: true, paid: true };                  // 其實已經付過了
  if (o.lp !== 'pending' || o.paid) return { ok: false, err: '這張訂單不需要付款或已付款' };
  if (o.status === 'cancelled' && !o.test) return { ok: false, err: '訂單已被拒單' };
  const total = Math.round(Number(o.total));
  if (!(total >= 1) || total > 100000) return { ok: false, err: '訂單金額不正確' };
  // 重新付款之前，先確認上一次的交易是不是其實已經付成功了（避免顧客被重複扣款）
  if (o.lpTxn) {
    let c = null;
    try { c = lpConfirmIfAuthorized_(o.lpTxn, total, '#' + o.no + ' 重新付款前檢查'); } catch (e) {}
    if (c && c.returnCode === '0000') {
      if (o.test) P.setProperty('LP_LAST_TEST', String(o.lpTxn));
      lpMarkPaid_(id, total);
      return { ok: true, paid: true, _paidNow: true };
    }
  }
  const chk = checkOrderAll_(o);                                 // 付款前先用菜單核對金額：嚴重問題才擋，輕微的只提醒店家
  if (chk.hard.length) {
    patchOrder_(id, { lpBlock: chk.hard.join('；') });
    sendDiscord('⚠ 訂單 #' + o.no + ' 的線上支付被擋下（金額核對不符）：' + chk.hard.join('；'));
    return { ok: false, err: '訂單金額核對不符，無法線上支付。您可以改選「到店付款」，或洽店家', block: true };
  }
  if (chk.soft.length && !o.lpWarn) {
    patchOrder_(id, { lpWarn: chk.soft.join('；') });
    sendDiscord('ℹ️ 訂單 #' + o.no + ' 價格與目前菜單略有出入（已放行付款，請留意）：' + chk.soft.join('；'));
  }
  const tries = Number(o.lpTry || 0);
  const orderId = tries ? id + '-r' + tries : id;
  let r;
  try {
    r = lpCall_('/v3/payments/request', {
      amount: total, currency: 'TWD', orderId: orderId,
      packages: [{ id: id, amount: total, name: '去中心鹹水雞', products: [{ name: '訂單 #' + o.no + ' 餐點', quantity: 1, price: total }] }],
      redirectUrls: { confirmUrl: HOOK_URL + '?a=lpc&id=' + encodeURIComponent(id) + (adm ? '&adm=1' : ''), cancelUrl: HOOK_URL + '?a=lpx&id=' + encodeURIComponent(id) + (adm ? '&adm=1' : '') }
    });
  } catch (e) {
    lpErr_(id, o, '要付款連結', 'EXC', e);
    return { ok: false, err: '連不上 LINE Pay，請稍後再按一次「重新付款」' };
  }
  if (r.returnCode !== '0000' || !r.info || !r.info.paymentUrl) {
    lpErr_(id, o, '要付款連結', r.returnCode, r.returnMessage);
    return { ok: false, err: 'LINE Pay 回應 ' + r.returnCode + '：' + (r.returnMessage || '') };
  }
  patchOrder_(id, { lpTry: tries + 1, lpTxn: String(r.info.transactionId), lpAt: Date.now(), lpErr: null });
  return { ok: true, url: r.info.paymentUrl.web || r.info.paymentUrl.app, txn: String(r.info.transactionId) };
}

/* 顧客付完款被導回：向 LINE Pay 確認「真的收到錢」 */
function lpConfirm_(q) {
  const id = String(q.id || ''), txn = String(q.transactionId || '');
  let state = 'fail', code = 'err', doNotify = false;
  const lock = LockService.getScriptLock();
  let got = false;
  try { lock.waitLock(30000); got = true; } catch (e) { code = 'busy'; }     // 拿不到鎖：款項可能已付，系統稍後會自動補確認
  if (got) {
    try {
      const o = getOrder_(id);
      if (!o || !o.no) code = 'notfound';
      else if (o.paid && o.lp === 'paid') { state = 'ok'; code = ''; }               // 已經確認過（重新整理、或系統已先補確認）
      else if (o.lp === 'expired' || (o.status === 'cancelled' && !o.test)) code = 'expired';
      else if (o.lp !== 'pending') code = 'switched';                                  // 已改成現場掃碼收款，不再接受線上付款（不確認＝LINE Pay 會自動退回）   // 已逾時取消的單不收款（不呼叫確認，LINE Pay 會自動把款項退回）
      else if (!txn || String(o.lpTxn) !== txn) code = 'txn';                          // 交易編號對不上，拒絕
      else {
        const total = Math.round(Number(o.total));
        const r = lpCall_('/v3/payments/' + encodeURIComponent(txn) + '/confirm', { amount: total, currency: 'TWD' });
        if (r.returnCode === '0000') {
          lpMarkPaid_(id, total);
          if (o.test) P.setProperty('LP_LAST_TEST', txn);
          state = 'ok'; code = ''; doNotify = true;
        } else {
          const o2 = getOrder_(id);                                                    // 可能同一時間別的程序已經確認成功了
          if (o2 && o2.paid && o2.lp === 'paid') { state = 'ok'; code = ''; }
          else { code = r.returnCode; lpErr_(id, o, '確認付款', r.returnCode, r.returnMessage); }
        }
      }
    } catch (err) {
      code = 'err'; try { lpErr_(id, null, '確認付款', 'EXC', err); } catch (e) {}
    } finally { lock.releaseLock(); }
  }
  if (doNotify) notifyAfterPaid_(id);                                                  // 通知一定要在放掉鎖之後才送
  return lpBack_(state, id, code, q.adm);
}

/* 把顧客送回點餐網頁（Apps Script 不能直接轉址，用網頁跳轉） */
function lpBack_(state, id, code, adm) {
  const url = SITE + (adm ? 'admin.html' : '') + '?lp=' + state + '&o=' + encodeURIComponent(id || '') + (code ? '&c=' + encodeURIComponent(code) : '');
  const html = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<body style="font-family:sans-serif;text-align:center;padding:40px"><p>正在返回點餐頁面…</p>' +
    '<p><a id="a" target="_top" href="' + url + '">如果沒有自動跳轉，請點這裡</a></p>' +
    '<script>try{window.top.location.replace(' + JSON.stringify(url) + ')}catch(e){}</script></body>';
  return HtmlService.createHtmlOutput(html).setTitle('返回點餐');
}

/* ---------- 測試用：在編輯器選 testLinePay → 執行，會建立一張 NT$1 的測試單 ---------- */
function testLinePay() {
  const now = Date.now();
  const day = Utilities.formatDate(new Date(now - 2 * 3600 * 1000), 'Asia/Taipei', 'yyyyMMdd');
  const order = {
    no: 'TEST', name: 'LINE Pay測試', phone: '', time: '--:--', src: '現場', pay: 'Linepay', status: 'cancelled',
    voidReason: 'LINE Pay 測試單（不計營收）', voidAt: now, voidBy: 'system', test: true, lp: 'pending',
    items: { '0': { name: 'LINE Pay 測試 NT$1', price: 1, qty: 1 } },
    subtotal: 1, total: 1, date: day, createdAt: now
  };
  const res = UrlFetchApp.fetch(DB_URL + '/orders.json?access_token=' + saToken_(), {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(order), muteHttpExceptions: true
  });
  const id = JSON.parse(res.getContentText()).name;
  const r = lpRequest_(id);
  if (!r.ok) { Logger.log('❌ 失敗：' + r.err); return; }
  Logger.log('✅ 向 LINE Pay 要到付款連結了。請用「手機」開這個網址，付 NT$1：\n' + r.url);
}

/* ---------- 測試後退款：付完 NT$1 後，選 testRefund → 執行 ---------- */
function testRefund() {
  const txn = P.getProperty('LP_LAST_TEST');
  if (!txn) { Logger.log('找不到可退款的測試交易（要先付款成功）'); return; }
  const r = lpCall_('/v3/payments/' + encodeURIComponent(txn) + '/refund', {});
  Logger.log(r.returnCode === '0000' ? '✅ 已退款 NT$1' : '❌ 退款失敗：' + r.returnCode + ' ' + (r.returnMessage || ''));
  if (r.returnCode === '0000') P.deleteProperty('LP_LAST_TEST');
}


/* ---------- 診斷：1106 之類的錯誤時，選 diagLinePay → 執行，看哪個環境認得你的金鑰 ---------- */
function diagLinePay() {
  const id = String(P.getProperty('LINEPAY_ID') || '').replace(/\s+/g, ''), sec = String(P.getProperty('LINEPAY_SECRET') || '').replace(/\s+/g, '');
  Logger.log('Channel ID 長度 ' + id.length + '（應為 10）｜Secret 長度 ' + sec.length + '（應為 32）｜目前設定的環境：' + (P.getProperty('LINEPAY_ENV') || '正式'));
  [['正式 api-pay.line.me', 'https://api-pay.line.me'], ['測試 sandbox-api-pay.line.me', 'https://sandbox-api-pay.line.me']].forEach(function (e) {
    const oid = 'DIAG' + Date.now();
    const r = lpCall_('/v3/payments/request', {
      amount: 1, currency: 'TWD', orderId: oid,
      packages: [{ id: oid, amount: 1, name: 'diag', products: [{ name: 'diag', quantity: 1, price: 1 }] }],
      redirectUrls: { confirmUrl: HOOK_URL + '?a=lpc&id=diag', cancelUrl: HOOK_URL + '?a=lpx&id=diag' }
    }, e[1]);
    Logger.log(e[0] + ' → returnCode ' + r.returnCode + '｜' + (r.returnMessage || ''));
  });
}


/* =====================================================================
 *  LINE Pay 進階功能：金額核對、逾時自動取消、補收款、店長退款
 * ===================================================================== */
const LP_EXPIRE_MIN = 20;   // 線上支付訂單超過幾分鐘沒付款，就自動取消並退回庫存
const FB_API_KEY = 'AIzaSyCw9S0F3IfTvsi-2lP4G32A8XCOzTTuCa4';   // Firebase 網頁金鑰（本來就公開在網頁裡，用來驗證店長身分）
const DEFAULT_PRICES = {"m1":{"p":65,"neg":0},"m2":{"p":75,"neg":0},"m3":{"p":65,"neg":0},"m4":{"p":75,"neg":0},"m5":{"p":130,"neg":0},"m6":{"p":150,"neg":0},"s1":{"p":260,"neg":0},"s2":{"p":390,"neg":0},"s3":{"p":630,"neg":0},"s4":{"p":139,"neg":0},"s5":{"p":239,"neg":0},"v1":{"p":40,"neg":0},"v2":{"p":30,"neg":0},"v3":{"p":25,"neg":0},"v4":{"p":25,"neg":0},"v5":{"p":25,"neg":0},"v6":{"p":25,"neg":0},"v7":{"p":25,"neg":0},"v8":{"p":25,"neg":0},"v9":{"p":20,"neg":0},"v10":{"p":20,"neg":0},"v11":{"p":20,"neg":0},"v12":{"p":20,"neg":0},"v13":{"p":20,"neg":0},"v14":{"p":20,"neg":0},"v15":{"p":20,"neg":0},"v16":{"p":20,"neg":0},"meat1":{"p":75,"neg":0},"meat2":{"p":70,"neg":0},"meat3":{"p":40,"neg":0},"meat4":{"p":30,"neg":0},"meat5":{"p":30,"neg":0},"meat6":{"p":25,"neg":0},"meat7":{"p":25,"neg":0},"meat8":{"p":25,"neg":0},"meat9":{"p":25,"neg":0},"meat10":{"p":25,"neg":0},"f1":{"p":30,"neg":0},"f2":{"p":30,"neg":0},"f3":{"p":30,"neg":0},"f4":{"p":25,"neg":0},"f5":{"p":25,"neg":0},"f6":{"p":25,"neg":0},"f7":{"p":25,"neg":0},"f8":{"p":25,"neg":0},"f9":{"p":20,"neg":0},"f10":{"p":20,"neg":0},"f11":{"p":20,"neg":0},"f12":{"p":20,"neg":0},"f13":{"p":20,"neg":0},"l1":{"p":45,"neg":0},"l2":{"p":45,"neg":0},"l3":{"p":45,"neg":0},"z1":{"p":15,"neg":0},"z2":{"p":15,"neg":0},"w1":{"p":120,"neg":0},"w2":{"p":120,"neg":0},"w3":{"p":120,"neg":0},"w4":{"p":120,"neg":0},"w5":{"p":150,"neg":0},"w6":{"p":150,"neg":0},"w7":{"p":100,"neg":0},"w8":{"p":80,"neg":0},"w9":{"p":40,"neg":0}};   // 預設菜單的品項底價（p）；neg=1 表示該品項有「減價」選項

function arr_(x) { return Array.isArray(x) ? x : (x && typeof x === 'object' ? Object.keys(x).sort(function (a, b) { return a - b; }).map(function (k) { return x[k]; }) : []); }

/* 取得目前菜單的底價表：店家有改過菜單就用資料庫裡的，沒改過就用預設值 */
function menuPrices_() {
  const cache = CacheService.getScriptCache(), hit = cache.get('menu_prices');
  if (hit) return JSON.parse(hit);
  let out = DEFAULT_PRICES;
  try {
    const res = UrlFetchApp.fetch(DB_URL + '/menu/cfg.json', { muteHttpExceptions: true });
    const cfg = res.getResponseCode() === 200 ? JSON.parse(res.getContentText()) : null;
    if (cfg) {
      out = {};
      arr_(cfg).forEach(function (c) {
        arr_(c.items).forEach(function (it) {
          const groups = arr_(c.opts).concat(arr_(it.opts));
          const neg = groups.some(function (gp) { return arr_(gp.ch).some(function (x) { return Number(x.p) < 0; }); });
          out[it.id] = { p: Number(it.price) || 0, neg: neg ? 1 : 0 };
        });
      });
    }
  } catch (e) {}
  cache.put('menu_prices', JSON.stringify(out), 300);
  return out;
}

/* 核對顧客自己下的單。分兩級：
 *   嚴重（會擋下線上支付）：沒有品項、數量亂填、加總對不上小計／總額、單價低於菜單價的一半（明顯被竄改）
 *   輕微（只提醒店家，不擋付款）：單價略低於目前菜單價（常見原因：店家剛改過菜單價，顧客手機還存著舊菜單）
 * checkOrder_ 回傳嚴重問題；checkOrderSoft_ 回傳輕微提醒。空陣列＝正常 */
function checkOrderAll_(o) {
  const hard = [], soft = [];
  if (o.staff || o.late) return { hard: hard, soft: soft };           // 店員自己下的單、補單不核對
  const items = arr_(o.items), prices = menuPrices_();
  let sum = 0;
  items.forEach(function (x) {
    const q = Number(x.qty), pr = Number(x.price);
    sum += (pr || 0) * (q || 0);
    if (!(q >= 1) || q > 200 || q !== Math.floor(q)) hard.push('「' + x.name + '」數量 ' + x.qty + ' 異常');
    if (!(pr >= 0)) hard.push('「' + x.name + '」單價 ' + x.price + ' 異常');
    const m = prices[String(x.id || '').split('_')[0]];
    if (m && m.p > 0 && !m.neg && pr < m.p) {
      if (pr < m.p * 0.5) hard.push('「' + x.name + '」單價 $' + pr + ' 遠低於菜單價 $' + m.p);
      else soft.push('「' + x.name + '」單價 $' + pr + ' 低於菜單價 $' + m.p);
    }
  });
  if (!items.length) hard.push('沒有任何品項');
  if (o.subtotal != null && Math.abs(sum - Number(o.subtotal)) > 0.5) hard.push('品項加總 $' + sum + ' 與小計 $' + o.subtotal + ' 不一致');
  if (Number(o.discount || 0) !== 0) hard.push('顧客單不應有折扣 $' + o.discount);
  if (o.baseTotal == null && o.subtotal != null && Math.abs(Number(o.subtotal) + Number(o.extra || 0) - Number(o.discount || 0) - Number(o.total)) > 0.5) hard.push('應付總額 $' + o.total + ' 與小計不一致');
  return { hard: hard, soft: soft };
}
function checkOrder_(o) { return checkOrderAll_(o).hard; }
function checkOrderSoft_(o) { return checkOrderAll_(o).soft; }

/* 把訂單標成「已付款」（通知要等放掉鎖之後再送，這裡不送） */
function lpMarkPaid_(id, total) {
  const now = Date.now();
  patchOrder_(id, { paid: true, paidAt: now, received: total, change: 0, pay: 'Linepay', lp: 'paid', lpPaidAt: now, lpErr: null, updatedAt: now });
}

/* 嘗試向 LINE Pay 確認這張單（顧客付了款卻沒跳回來時，靠這個補上）。確認成功回傳 true */
function lpTryConfirm_(id, final) {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(15000); } catch (e) { return false; }
  let ok = false;
  try {
    const o = getOrder_(id);
    if (!o || o.lp !== 'pending' || !o.lpTxn || o.paid || (o.status === 'cancelled' && !o.test)) return false;
    // 顧客正在 LINE Pay 付款時絕對不能亂請款（會讓他的付款頁出現「暫時性錯誤」）：正常付完款會自己跳回來，這裡只處理「付了款卻沒跳回來」，所以前 3 分鐘完全不動
    const age = o.lpAt ? (Date.now() - Number(o.lpAt)) / 60000 : 0;
    if (age < 3) return false;
    const total = Math.round(Number(o.total));
    let r;
    if (final) {                                                   // 逾時前最後一次：不管狀態直接請款（付了款沒跳回來的單就不會漏）；沒付款的會失敗，無害
      r = lpCall_('/v3/payments/' + encodeURIComponent(o.lpTxn) + '/confirm', { amount: total, currency: 'TWD' });
      lpLog_('#' + o.no + ' 逾時前最後請款 ' + r.returnCode);
    } else r = lpConfirmIfAuthorized_(o.lpTxn, total, '#' + o.no + ' 補確認');
    if (!r || r.returnCode !== '0000') return false;
    if (o.test) P.setProperty('LP_LAST_TEST', String(o.lpTxn));
    lpMarkPaid_(id, total);
    ok = true;
  } finally { lock.releaseLock(); }
  if (ok) notifyAfterPaid_(id);                                   // 放掉鎖之後才通知
  return ok;
}

/* 把訂單的庫存還回去（資料庫：stock/營業日/品項代號/sold） */
function releaseStock_(o) {
  if (!o || !o.date || o.late || o.test) return;
  const need = {};
  arr_(o.items).forEach(function (x) { const b = String(x.id || '').split('_')[0]; if (b) need[b] = (need[b] || 0) + (Number(x.qty) || 0); });
  Object.keys(need).forEach(function (b) {
    for (let i = 0; i < 3; i++) {
      const url = DB_URL + '/stock/' + o.date + '/' + encodeURIComponent(b) + '.json?access_token=' + saToken_();
      const res = UrlFetchApp.fetch(url, { headers: { 'X-Firebase-ETag': 'true' }, muteHttpExceptions: true });
      if (res.getResponseCode() !== 200) return;
      const node = JSON.parse(res.getContentText());
      if (!node || node.limit == null) return;                      // 這個品項沒設限量，不用還
      let etag = '';
      const hd = res.getAllHeaders();
      Object.keys(hd).forEach(function (k) { if (k.toLowerCase() === 'etag') etag = hd[k]; });
      node.sold = Math.max(0, (Number(node.sold) || 0) - need[b]);
      const put = UrlFetchApp.fetch(url, { method: 'put', contentType: 'application/json', payload: JSON.stringify(node), headers: etag ? { 'if-match': etag } : {}, muteHttpExceptions: true });
      if (put.getResponseCode() === 200) return;                    // 成功；412 代表同時有人改了，重試
    }
  });
}

/* 逾時沒完成線上支付：不取消訂單（店家可能已經在做了），改成「現場掃碼收款」並提醒店家 */
function lpExpire_(id) {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(15000); } catch (e) { return; }
  let o, did = false;
  try {
    o = getOrder_(id);
    if (!o || o.lp !== 'pending' || o.paid) return;
    const now = Date.now();
    if (o.status === 'cancelled') { patchOrder_(id, { lp: 'expired', updatedAt: now }); return; }   // 店員已經拒單（庫存當時已還）
    patchOrder_(id, { lp: null, pay: 'Linepay', lpFallback: true, updatedAt: now });
    did = true;
  } finally { lock.releaseLock(); }
  if (did) {
    try { notifyOrder(id); } catch (e) {}
    notifyBoth_('⏱ 訂單 #' + o.no + '（' + (o.name || '') + '）逾時未完成線上支付，已改為「現場掃碼」收款，取餐時請收款 $' + o.total, o);
  }
}

/* 每 1 分鐘自動跑：① 補收「付了款卻沒跳回來」的單 ② 取消逾時的單 ③ 替漏發通知的新單補發 Discord。用 setupSweepTrigger 設定一次即可 */
function lpSweep() {
  const since = Date.now() - 12 * 3600 * 1000;
  const url = DB_URL + '/orders.json?orderBy=' + encodeURIComponent('"createdAt"') + '&startAt=' + since + '&access_token=' + saToken_();
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return;
  const all = JSON.parse(res.getContentText()) || {};
  let since0 = Number(P.getProperty('NT_SINCE') || 0);
  if (!since0) { since0 = Date.now(); P.setProperty('NT_SINCE', String(since0)); }   // 補發只管這個程式更新「之後」的單，舊單不會被重複通知
  const hook = P.getProperty('DISCORD_WEBHOOK') || P.getProperty('DISCORD_RELAY'), tg = tgReady_();
  Object.keys(all).forEach(function (id) {
    const o = all[id];
    if (!o) return;
    try {
      if (o.lp === 'pending' && !o.paid) {
        // 用「系統自己的時間」計時（顧客手機時間不準，不能拿 createdAt 來算）：第一次看到就記下 lpAt，每次重新付款會重算
        if (!o.lpAt) { patchOrder_(id, { lpAt: Date.now() }); }
        const ageMin = o.lpAt ? (Date.now() - Number(o.lpAt)) / 60000 : 0;
        if (o.lpTxn && ageMin >= 3 && lpTryConfirm_(id, ageMin >= LP_EXPIRE_MIN - 1)) return;    // 其實已經付款，補上（成功時內部已通知）；快逾時前最後再試一次
        if (ageMin >= LP_EXPIRE_MIN) lpExpire_(id);
      }
      const recent = Date.now() - Number(o.createdAt || 0) < (o.lp ? 5 * 3600 * 1000 : 30 * 60 * 1000);
      if (o.no && o.lp !== 'expired' && o.status !== 'cancelled' && !o.late && Number(o.createdAt || 0) >= since0 && recent) {   // 所有新單：通知漏發就補發（30 分鐘內；線上支付單 5 小時內）
        if ((hook && !o.ntD) || (tg && !o.ntT)) notifyOrder(id);      // 新單通知沒送出去，補發
        if (o.lp === 'paid' && !o.ntP) notifyPaid_(id);                // 付款成功通知沒送出去，補發
      }
    } catch (e) { console.error('lpSweep ' + id + '：' + e); }
  });
}

function setupSweepTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'lpSweep') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('lpSweep').timeBased().everyMinutes(1).create();
  Logger.log('已設定：每 1 分鐘自動補收款／取消逾時訂單');
}

/* 線上支付沒辦法完成（開不起來、不想付了…）：改成到店付款，訂單照常通知店家製作。
 * 若其實已經付成功（付了款沒跳回來），會直接標成已付款，不會讓顧客付兩次。 */
function lpToCash_(id) {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(30000); } catch (e) { return { ok: false, err: '系統忙碌中，請再按一次' }; }
  let res, mode = '';
  try {
    const o = getOrder_(id);
    if (!o || !o.no) res = { ok: false, err: '找不到訂單' };
    else if (o.paid && o.lp === 'paid') res = { ok: true, paid: true };
    else if (o.lp !== 'pending') res = { ok: false, err: '這張訂單不是等待線上支付的狀態' };
    else if (o.status === 'cancelled' && !o.test) res = { ok: false, err: '訂單已取消，請重新下單' };
    else {
      let c = null;
      if (o.lpTxn) { try { c = lpConfirmIfAuthorized_(o.lpTxn, Math.round(Number(o.total)), '#' + o.no + ' 改現場前檢查'); } catch (e) {} }
      if (c && c.returnCode === '0000') { lpMarkPaid_(id, Math.round(Number(o.total))); res = { ok: true, paid: true }; mode = 'paid'; }
      else { patchOrder_(id, { lp: null, pay: 'Linepay', lpFallback: true, updatedAt: Date.now() }); res = { ok: true, cash: true }; mode = 'cash'; }
    }
  } finally { lock.releaseLock(); }
  if (mode === 'paid') notifyAfterPaid_(id);
  else if (mode === 'cash') {
    try { notifyOrder(id); } catch (e) {}                                      // 新單通知如果還沒送，補送
    try { const o = getOrder_(id); notifyBoth_('ℹ️ 訂單 #' + o.no + '（' + (o.name || '') + '）顧客改為「現場掃碼」付款，取餐時請收款 $' + o.total, o); } catch (e) {}
  }
  return res;
}

/* 診斷：選 diagOrders → 執行，看最近 12 小時每張線上支付單卡在哪（把「執行記錄」貼給我就能查原因） */
function diagOrders() {
  const since = Date.now() - 12 * 3600 * 1000;
  const res = UrlFetchApp.fetch(DB_URL + '/orders.json?orderBy=' + encodeURIComponent('"createdAt"') + '&startAt=' + since + '&access_token=' + saToken_(), { muteHttpExceptions: true });
  const all = JSON.parse(res.getContentText()) || {};
  let n = 0;
  Object.keys(all).forEach(function (id) {
    const o = all[id];
    if (!o || !(o.lp || o.lpTxn || o.lpErr || o.lpBlock)) return;
    n++;
    Logger.log('#' + o.no + '｜$' + o.total + '｜' + (o.name || '') + '｜lp=' + o.lp + '｜付款=' + (o.paid ? '是' : '否') + '｜試了 ' + (o.lpTry || 0) + ' 次' +
      '｜DC通知=' + (o.ntD ? '有' : '無') +
      (o.lpBlock ? '｜被擋：' + o.lpBlock : '') + (o.lpWarn ? '｜提醒：' + o.lpWarn : '') +
      (o.lpErr ? '｜錯誤：' + o.lpErr.stage + ' ' + o.lpErr.code + ' ' + (o.lpErr.msg || '') : '') + (o.lpFallback ? '｜已改到店付款' : ''));
  });
  Logger.log('共 ' + n + ' 張線上支付相關訂單');
}

/* 驗證呼叫者是店長：用 Firebase 登入憑證查出是誰，再到資料庫確認角色 */
function verifyManager_(idToken) {
  if (!idToken) return null;
  const res = UrlFetchApp.fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + FB_API_KEY, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify({ idToken: idToken }), muteHttpExceptions: true,
    headers: { Referer: SITE }          // API 金鑰限制「只能從你的網站使用」之後，伺服器呼叫也要帶上網站來源，否則會被擋
  });
  if (res.getResponseCode() !== 200) return null;
  const u = (JSON.parse(res.getContentText()).users || [])[0];
  if (!u || !u.localId) return null;
  const r = UrlFetchApp.fetch(DB_URL + '/roles/' + encodeURIComponent(u.localId) + '.json?access_token=' + saToken_(), { muteHttpExceptions: true });
  if (r.getResponseCode() !== 200 || JSON.parse(r.getContentText()) !== 'manager') return null;
  return { uid: u.localId, email: u.email || u.localId };
}

/* 店長退款（全額退回顧客的 LINE Pay） */
function lpRefund_(id, token) {
  const who = verifyManager_(token);
  if (!who) return { ok: false, err: '只有店長可以退款（請重新登入後再試）' };
  const lock = LockService.getScriptLock();
  try { lock.waitLock(30000); } catch (e) { return { ok: false, err: '系統忙碌中，請再按一次' }; }
  try {
    const o = getOrder_(id);
    if (!o || o.lp !== 'paid' || !o.lpTxn) return { ok: false, err: '這張單不是已付款的 LINE Pay 線上支付單（或已退款）' };
    const r = lpCall_('/v3/payments/' + encodeURIComponent(o.lpTxn) + '/refund', {});
    if (r.returnCode !== '0000') return { ok: false, err: 'LINE Pay 回應 ' + r.returnCode + '：' + (r.returnMessage || '') };
    patchOrder_(id, { lp: 'refunded', lpRefund: { at: Date.now(), by: who.email, amount: Math.round(Number(o.total)) }, updatedAt: Date.now() });
    sendDiscord('↩️ 訂單 #' + o.no + ' 已由 ' + who.email + ' 退款 $' + o.total + '（LINE Pay）');
    return { ok: true };
  } finally { lock.releaseLock(); }
}

/* 診斷 Firebase 金鑰：選 diagFirebase → 執行，看金鑰是不是 chuobian-pos 的、能不能讀到資料庫 */
function diagFirebase() {
  let sa;
  try { sa = JSON.parse(P.getProperty('FIREBASE_SA') || ''); } catch (e) { Logger.log('❌ FIREBASE_SA 不是完整的內容（可能沒複製完整，要從第一個 { 複製到最後一個 }）'); return; }
  Logger.log('金鑰所屬專案：' + sa.project_id + (sa.project_id === 'chuobian-pos' ? ' ✅' : ' ❌ 應該是 chuobian-pos，請到正確的 Firebase 專案重新產生金鑰'));
  let tok;
  try { CacheService.getScriptCache().remove('sa_tok'); tok = saToken_(); Logger.log('取得存取憑證：✅'); } catch (e) { Logger.log('❌ 取得存取憑證失敗：' + e); return; }
  const r = UrlFetchApp.fetch(DB_URL + '/shop.json?access_token=' + tok, { muteHttpExceptions: true });
  Logger.log('讀取資料庫：' + (r.getResponseCode() === 200 ? '✅ 成功' : '❌ ' + r.getResponseCode() + ' ' + r.getContentText().slice(0, 200)));
  const r2 = UrlFetchApp.fetch(DB_URL + '/orders.json?orderBy=' + encodeURIComponent('"createdAt"') + '&limitToLast=3&access_token=' + tok, { muteHttpExceptions: true });
  Logger.log('讀取訂單：' + (r2.getResponseCode() === 200 ? '✅ 成功（抓到最近 ' + Object.keys(JSON.parse(r2.getContentText()) || {}).length + ' 張）' : '❌ ' + r2.getResponseCode() + ' ' + r2.getContentText().slice(0, 200)));
}
