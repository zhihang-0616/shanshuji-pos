/**
 * 新訂單 → LINE 群組通知（Google Apps Script）
 *
 * 設定步驟請看對話說明。這支程式做兩件事：
 *  1. 當 LINE 機器人被加進群組、群組有人講話時，自動記住「第一個」群組當通知群組（綁定後鎖定）。
 *  2. 當點餐網頁（客人頁面或店家頁面）通知有新訂單時，到 Firebase 讀取該訂單內容，再用 LINE 機器人推送到群組。
 *     （訊息內容一律從資料庫讀取，不吃網頁傳來的文字，避免被人亂發訊息洗版。）
 *
 * 需要在「專案設定 → 指令碼屬性」新增：
 *   LINE_TOKEN = 你的 LINE Channel access token（長期）
 */
const DB_URL = 'https://chuobian-pos-default-rtdb.asia-southeast1.firebasedatabase.app';
const P = PropertiesService.getScriptProperties();

function doGet() { return ContentService.createTextOutput('POS LINE notify OK'); }

function doPost(e) {
  let body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) {}
  if (body.events) handleLine(body.events);                    // 來自 LINE 的 Webhook
  else if (body.type === 'order' && body.id) notifyOrder(String(body.id)); // 來自點餐網頁
  return ContentService.createTextOutput('ok');
}

/* ---------- LINE Webhook：自動綁定群組 ---------- */
function handleLine(events) {
  events.forEach(function (ev) {
    const gid = ev.source && ev.source.groupId;
    if (!gid) return;
    const bound = P.getProperty('GROUP_ID');
    if (!bound) {
      P.setProperty('GROUP_ID', gid);
      if (ev.replyToken) reply(ev.replyToken, '✅ 已綁定此群組為「訂單通知群組」。之後有新訂單會自動通知到這裡。');
    } else if (bound === gid && ev.type === 'message' && ev.message && ev.message.type === 'text' && ev.message.text.trim() === '測試') {
      if (ev.replyToken) reply(ev.replyToken, '✅ 訂單通知運作中');
    }
  });
}

/* ---------- 新訂單通知 ---------- */
function notifyOrder(id) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const cache = CacheService.getScriptCache();
    if (cache.get('n_' + id)) return;                  // 已通知過（網頁與店家頁面可能都會呼叫）
    const gid = P.getProperty('GROUP_ID');
    if (!gid) return;
    const res = UrlFetchApp.fetch(DB_URL + '/orders/' + encodeURIComponent(id) + '.json', { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return;
    const o = JSON.parse(res.getContentText());
    if (!o || !o.no) return;
    if (o.late || o.status === 'cancelled') return;                        // 補單（事後補登）與已作廢的單不通知
    if (Date.now() - Number(o.createdAt || 0) > 5 * 60 * 60 * 1000) return; // 只通知 5 小時內的單（避免舊單被重複觸發）
    const code = push(gid, formatOrder(o));
    if (code === 200) cache.put('n_' + id, '1', 21600);
  } finally {
    lock.releaseLock();
  }
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
           .forEach(function (x) { lines.push('・' + x.name + ' ×' + x.qty); });
    });
  } else {
    const opt = [o.flavor, o.spice, o.salt].filter(Boolean).join('/');
    if (opt) lines.push(opt);
    items.forEach(function (x) { lines.push('・' + x.name + ' ×' + x.qty); });
  }
  if (o.gear && o.gear.length) lines.push('配備：' + o.gear.join('、'));
  if (o.note) lines.push('📝 備註：' + o.note);
  lines.push('────────────');
  lines.push('💰 $' + o.total + '（' + (o.pay || '') + '）');
  return lines.join('\n');
}

/* ---------- LINE API ---------- */
function push(to, text) {
  const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + P.getProperty('LINE_TOKEN') },
    payload: JSON.stringify({ to: to, messages: [{ type: 'text', text: text.slice(0, 4900) }] }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) console.error('LINE push 失敗：' + res.getContentText());
  return res.getResponseCode();
}

function reply(token, text) {
  UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + P.getProperty('LINE_TOKEN') },
    payload: JSON.stringify({ replyToken: token, messages: [{ type: 'text', text: text }] }),
    muteHttpExceptions: true
  });
}

/* ---------- 手動工具（在 Apps Script 編輯器選函式後按「執行」）---------- */
function testPush() { push(P.getProperty('GROUP_ID'), '✅ 測試：訂單通知運作中'); }
function resetGroup() { P.deleteProperty('GROUP_ID'); }   // 想換通知群組時，先執行這個，再到新群組講一句話
