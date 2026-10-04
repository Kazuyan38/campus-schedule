// 管理者ページ（admin.html）の検証（Chrome が必要）。 node dev/admin_e2e.cjs
// 疑似サーバーに管理者・一般の利用者を作り、本物のクリック・入力で、権限・一覧・削除・表示の安全性を確かめる。失敗があれば終了コード 1。
// ログイン・クラウド同期の端から端までの検証。疑似サーバー + 隔離された2台のブラウザ（別端末）を、本物のクリック・入力で動かす。
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const SHOTS = process.argv[5] || process.env.E2E_SHOTS || '';
const os = require('os');
const ROOT = process.argv[2] || path.resolve(__dirname, '..');            // campus-schedule のルート
const APP = 'file:///' + (process.argv[3] || path.join(ROOT, 'index.html')).split('\\').join('/');   // 検証対象の index.html
const CH = process.env.CHROME || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome');
const PYTHON = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const PORT = 9391, MOCK = 8788, MOCK2 = 8789;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = (url) => new Promise((res, rej) => http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { res(d); } }); }).on('error', rej));
const results = [];
const ok = (n, c, x = '') => { results.push((c ? 'PASS ' : 'FAIL ') + n + (x !== '' && !c ? ' :: ' + x : '')); };
const mock = p => get(`http://127.0.0.1:${MOCK}${p}`);
const mock2 = p => get(`http://127.0.0.1:${MOCK2}${p}`);
const EM = e => encodeURIComponent(e);

class Dev {
  constructor(name) { this.name = name; this.id = 0; this.pend = new Map(); this.errors = []; }
  async open(bsend) {
    const ctx = (await bsend('Target.createBrowserContext')).result.browserContextId;
    const tid = (await bsend('Target.createTarget', { url: 'about:blank', browserContextId: ctx })).result.targetId;
    let list; for (let i = 0; i < 30; i++) { list = await get(`http://127.0.0.1:${PORT}/json`); if (list.find(t => t.id === tid)) break; await sleep(100); }
    this.ws = new WebSocket(list.find(t => t.id === tid).webSocketDebuggerUrl);
    await new Promise(r => this.ws.addEventListener('open', r));
    this.ws.addEventListener('message', m => {
      const d = JSON.parse(m.data);
      if (d.id && this.pend.has(d.id)) { this.pend.get(d.id)(d); this.pend.delete(d.id); }
      else if (d.method === 'Runtime.exceptionThrown') this.errors.push((d.params.exceptionDetails.exception || {}).description || d.params.exceptionDetails.text);
    });
    await this.send('Page.enable'); await this.send('Runtime.enable');
    await this.send('Emulation.setDeviceMetricsOverride', { width: +(process.env.E2E_WIDTH || 390), height: 844, deviceScaleFactor: 1, mobile: false });
  }
  send(method, params = {}) { return new Promise(r => { const i = ++this.id; this.pend.set(i, r); this.ws.send(JSON.stringify({ id: i, method, params })); }); }
  async nav(url) { await this.send('Page.navigate', { url }); await sleep(900); }
  async ev(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result.exceptionDetails) throw new Error(`${this.name} eval: ${expr.slice(0, 90)} -> ${(r.result.exceptionDetails.exception || {}).description}`);
    return r.result.result.value;
  }
  async waitFor(expr, ms = 6000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await this.ev(expr)) return true; } catch (e) {} await sleep(120); } return false; }
  async center(sel) { return this.ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return null; e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); const t=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2); return {x:r.left+r.width/2,y:r.top+r.height/2,hit:t===e||e.contains(t)}})()`); }
  async click(sel) {
    await sleep(60); const c = await this.center(sel);
    if (!c) throw new Error(`${this.name}: no element ${sel}`); if (!c.hit) throw new Error(`${this.name}: element covered ${sel}`);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await this.send('Input.dispatchMouseEvent', { type, x: c.x, y: c.y, button: 'left', clickCount: 1 });
    await sleep(160);
  }
  async type(sel, text) { await this.click(sel); await this.send('Input.insertText', { text }); await sleep(60); }
  async shot(name) { if (!SHOTS) return; await sleep(250); const r = await this.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(r.result.data, 'base64')); }
  async overflow() { return this.ev("(()=>{const W=innerWidth;return [...document.querySelectorAll('#sheet .sh-body *')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&(r.right>W+0.5||r.left<-0.5)}).map(e=>(typeof e.className==='string'&&e.className?e.className:e.tagName)).slice(0,5)})()"); }
  async sheetOpen() { return this.ev("document.querySelector('#sheet').classList.contains('open')"); }
  async openAccount() { if (!(await this.sheetOpen())) { await this.click('#btnShare'); await this.waitFor("document.querySelector('#acctBox')"); await sleep(200); } }
  async closeSheet() { if (await this.sheetOpen()) { await this.ev('closeSheet()'); await sleep(450); } }
  state() { return this.ev('JSON.stringify({c:state.courses.map(c=>c.name),e:state.exams.length,rev:sync.rev,dirty:sync.dirty,st:syncState,conflict:!!cloudConflict,pg:!!pendingGuest,user:cloudEmail(),store:STORE_KEY})').then(JSON.parse); }
}

const ADMIN_SRC = path.join(ROOT, 'admin.html');
const post = (p, body, token) => new Promise((res, rej) => {
  const data = JSON.stringify(body);
  const r = http.request({ host: '127.0.0.1', port: MOCK, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), apikey: 'mock-anon-key', ...(token ? { Authorization: 'Bearer ' + token } : {}) } }, rs => { let d = ''; rs.on('data', c => d += c); rs.on('end', () => { try { res(JSON.parse(d)); } catch (e) { res(d); } }); });
  r.on('error', rej); r.write(data); r.end();
});
async function seed(email, courses) {
  const s = await post('/auth/v1/signup', { email, password: 'password-1234' });
  if (courses) await post('/rest/v1/campus_schedules', { user_id: s.user.id, data: { courses: Array.from({ length: courses }, (_, i) => ({ name: '秘密の授業' + i })) }, rev: 1, updated_at: new Date().toISOString(), device: 'iPhone' }, s.access_token);
  return s;
}
(async () => {
  const mockP = spawn(PYTHON, [path.join(ROOT, 'dev', 'mock_supabase.py'), String(MOCK)], { stdio: 'ignore' });
  const chrome = spawn(CH, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(os.tmpdir(), 'campus-admin-e2e-profile')}`, 'about:blank'], { stdio: 'ignore' });
  const cleanup = () => { try { chrome.kill(); mockP.kill(); } catch (e) {} };
  try {
    for (let i = 0; i < 60; i++) { try { await get(`http://127.0.0.1:${MOCK}/__state`); break; } catch (e) { await sleep(150); } }
    const tmp = path.join(os.tmpdir(), 'campus-admin-e2e'); fs.mkdirSync(tmp, { recursive: true });
    const html = fs.readFileSync(ADMIN_SRC, 'utf8').replace(/https:\/\/[a-z0-9]+\.supabase\.co/, `http://127.0.0.1:${MOCK}`).replace(/sb_publishable_[A-Za-z0-9_-]+/, 'mock-anon-key');
    ok('admin.html has the url/key constants the test replaces', html.includes(`127.0.0.1:${MOCK}`) && html.includes('mock-anon-key'));
    fs.writeFileSync(path.join(tmp, 'admin.html'), html);
    const URL_ = 'file:///' + path.join(tmp, 'admin.html').split('\\').join('/');

    await seed('admin@example.test', 3); await seed('friend1@example.test', 10); const f2 = await seed('friend2@example.test', 0);
    await seed('<i id="xss">x</i>@example.test', 1);

    for (let i = 0; i < 80; i++) { try { await get(`http://127.0.0.1:${PORT}/json/version`); break; } catch (e) { await sleep(200); } }
    const ver = await get(`http://127.0.0.1:${PORT}/json/version`);
    const bws = new WebSocket(ver.webSocketDebuggerUrl); await new Promise(r => bws.addEventListener('open', r));
    let bid = 0; const bpend = new Map();
    bws.addEventListener('message', m => { const d = JSON.parse(m.data); if (d.id && bpend.has(d.id)) { bpend.get(d.id)(d); bpend.delete(d.id); } });
    const bsend = (method, params = {}) => new Promise(r => { const i = ++bid; bpend.set(i, r); bws.send(JSON.stringify({ id: i, method, params })); });
    const D = new Dev('admin'); await D.open(bsend); await D.nav(URL_);

    const login = async (em, pw) => { await D.ev("document.querySelector('#em').value='';document.querySelector('#pw').value='';1"); await D.type('#em', em); await D.type('#pw', pw); await D.click('#loginBtn'); };
    ok('A1 the login form is shown first, dashboard hidden', await D.ev("!document.querySelector('#loginBox').hidden && document.querySelector('#dash').hidden"));
    await D.shot('admin_login');

    await login('friend1@example.test', 'wrong-password');
    ok('A2 wrong password: clear message', await D.waitFor("/パスワードが違います/.test(document.querySelector('#loginMsg').textContent)"));

    await login('friend1@example.test', 'password-1234');
    ok('A3 a non-admin account is refused and sees NO data', await D.waitFor("/権限がありません/.test(document.querySelector('#loginMsg').textContent)") && await D.ev("document.querySelector('#dash').hidden && document.querySelector('#rows').children.length===0"));
    ok('A3b …and the session is dropped', await D.ev("sessionStorage.getItem('campus-admin/auth')===null"));

    await login('admin@example.test', 'password-1234');
    ok('A4 admin logs in and the dashboard appears', await D.waitFor("!document.querySelector('#dash').hidden && document.querySelector('#rows').children.length>=4", 8000));
    ok('A5 stats are right (4 users)', await D.ev("document.querySelector('#sUsers').textContent.startsWith('4')"), await D.ev("document.querySelector('#sUsers').textContent"));
    ok('A6 the user list shows email, course count, but never course names', await D.ev("(()=>{const t=document.querySelector('#rows').textContent;return t.includes('friend1@example.test') && !t.includes('秘密の授業')})()"));
    const row10 = await D.ev("[...document.querySelectorAll('#rows tr')].find(r=>r.textContent.includes('friend1@example.test')).children[3].textContent");
    ok('A7 course count column is 10 for friend1', row10 === '10', row10);
    ok('A8 an email containing HTML is rendered as text (no injection)', await D.ev("!document.querySelector('#xss') && document.querySelector('#rows').textContent.includes('<i id=\"xss\">x</i>@example.test')"));
    ok('A9 the admin row has no delete button and is tagged', await D.ev("(()=>{const r=[...document.querySelectorAll('#rows tr')].find(r=>r.textContent.includes('admin@example.test'));return r.textContent.includes('管理者') && !r.querySelector('button')})()"));
    ok('A10 charts are drawn (14 bars each)', await D.ev("document.querySelector('#chartNew').children.length===14 && document.querySelector('#chartAct').children.length===14"));
    ok('A11 pause meter says room is plenty', await D.ev("/余裕あり/.test(document.querySelector('#pauseState').textContent)"));
    await D.shot('admin_dash');

    await D.type('#q', 'friend2');
    ok('A12 search filters the list', await D.ev("document.querySelector('#rows').children.length===1 && /1 \\/ 4/.test(document.querySelector('#count').textContent)"));
    await D.click('#rows .btn.danger');
    ok('A13 delete asks for the email first; the confirm button is locked', await D.ev("(()=>{const b=[...document.querySelectorAll('#rows .confirm button')][0];return !!b && b.disabled})()"));
    await D.type('#rows .confirm input', 'friend1@example.test');
    ok('A14 a wrong email keeps it locked', await D.ev("document.querySelector('#rows .confirm button').disabled"));
    await D.ev("(()=>{const i=document.querySelector('#rows .confirm input');i.value='friend2@example.test';i.dispatchEvent(new Event('input'));return 1})()");
    ok('A15 the exact email unlocks it', await D.ev("!document.querySelector('#rows .confirm button').disabled"));
    await D.click('#rows .confirm button');
    ok('A16 delete removes the user from server and list', await D.waitFor("document.querySelector('#sUsers').textContent.startsWith('3')", 6000) && (await mock('/__state')).users === 3);
    await D.ev("document.querySelector('#q').value='';document.querySelector('#q').dispatchEvent(new Event('input'));1");

    // 管理者でない人が直接 RPC を叩いても拒否される（サーバー側の防御）
    const friend = await post('/auth/v1/token?grant_type=password', { email: 'friend1@example.test', password: 'password-1234' });
    const direct = await new Promise(res => { const r = http.request({ host: '127.0.0.1', port: MOCK, path: '/rest/v1/rpc/admin_users', method: 'POST', headers: { 'Content-Type': 'application/json', apikey: 'mock-anon-key', Authorization: 'Bearer ' + friend.access_token } }, rs => { rs.resume(); res(rs.statusCode); }); r.end('{}'); });
    ok('A17 a non-admin calling the admin API directly is refused (server side)', direct === 403, String(direct));

    await D.click('#logout');
    ok('A18 logout returns to the login form and clears the session', await D.ev("!document.querySelector('#loginBox').hidden && sessionStorage.getItem('campus-admin/auth')===null"));
    ok('A19 no uncaught exception', D.errors.length === 0, D.errors.slice(0, 2).join(' | '));
  } catch (e) { results.push('FAIL harness: ' + e.message); }
  console.log(results.join('\n'));
  const bad = results.filter(r => r.startsWith('FAIL')).length;
  console.log(`\n${results.length - bad} PASS / ${bad} FAIL`);
  cleanup(); process.exit(bad ? 1 : 0);
})();
