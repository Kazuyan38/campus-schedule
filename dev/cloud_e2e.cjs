// ログイン・クラウド同期の端から端までの検証（Chrome が必要）。
//
//   node dev/cloud_e2e.cjs                 # リポジトリの index.html を検証
//   E2E_WIDTH=320 node dev/cloud_e2e.cjs   # 画面幅を変えて（既定 390）
//
// dev/mock_supabase.py（疑似サーバー）を2つ立て、隔離した複数の端末（ブラウザコンテキスト）を
// 本物のクリック・入力で動かす。失敗があれば終了コード 1。
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
const addCourses = (dev, names) => dev.ev(`(()=>{ ${JSON.stringify(names)}.forEach((n,i)=>state.courses.push(normCourse({id:'g'+i+Date.now(),name:n,year:2026,quarters:[3],slots:[{d:i,p:1}],credits:'2',color:'#8b7cff'}))); state.exams.push(normExam({id:'ge',title:'ゲスト試験',kind:'その他',date:'2026-11-10'})); save(); render(); return state.courses.length })()`);
const cfg = (dev, port) => dev.ev(`writeJSON(DEVICE_KEY,{cloud:{url:'http://127.0.0.1:${port}',anonKey:'mock-anon-key'}})`);
async function authForm(dev, mode, email, pass, pass2) {
  await dev.openAccount();
  await dev.click(`[data-acct="mode:${mode}"]`);
  await dev.ev("document.querySelector('#auEmail').value=''; 1");
  await dev.type('#auEmail', email);
  if (mode !== 'recover') await dev.type('#auPass', pass);
  if (mode === 'signup') await dev.type('#auPass2', pass2 === undefined ? pass : pass2);
  await dev.click('#authForm button[type="submit"]');
}

(async () => {
  const mockP = spawn(PYTHON, [path.join(ROOT, 'dev', 'mock_supabase.py'), String(MOCK)], { stdio: 'ignore' });
  const mock2P = spawn(PYTHON, [path.join(ROOT, 'dev', 'mock_supabase.py'), String(MOCK2), '--confirm'], { stdio: 'ignore' });
  const chrome = spawn(CH, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`, `--user-data-dir=${process.argv[4] || path.join(os.tmpdir(), 'campus-cloud-e2e-profile')}`, 'about:blank'], { stdio: 'ignore' });
  const cleanup = () => { try { chrome.kill(); mockP.kill(); mock2P.kill(); } catch (e) {} };
  try {
    for (let i = 0; i < 60; i++) { try { await mock('/__state'); await mock2('/__state'); await get(`http://127.0.0.1:${PORT}/json/version`); break; } catch (e) { await sleep(200); } }
    const ver = await get(`http://127.0.0.1:${PORT}/json/version`);
    const bws = new WebSocket(ver.webSocketDebuggerUrl); await new Promise(r => bws.addEventListener('open', r));
    let bid = 0; const bpend = new Map();
    bws.addEventListener('message', m => { const d = JSON.parse(m.data); if (d.id && bpend.has(d.id)) { bpend.get(d.id)(d); bpend.delete(d.id); } });
    const bsend = (method, params = {}) => new Promise(r => { const i = ++bid; bpend.set(i, r); bws.send(JSON.stringify({ id: i, method, params })); });
    const A = new Dev('A'), B = new Dev('B');
    await A.open(bsend); await B.open(bsend);
    await A.nav(APP); await B.nav(APP);

    // ===== S0: 設定なし・ログインなし =====
    ok('S0 boot: no sync dot while logged out, no exception', await A.ev("document.querySelector('#sdot').hidden") === true && A.errors.length === 0, A.errors.join('|'));
    await A.click('#btnShare'); await A.waitFor("document.querySelector('#acctBox')"); await sleep(250);
    ok('S0 unconfigured: shows the setup message (not a login form)', /接続先.*設定されていません/.test(await A.ev("document.querySelector('#acctBox').textContent")) && !(await A.ev("!!document.querySelector('#authForm')")));
    await A.shot('01_unconfigured'); ok('01_unconfigured: no horizontal overflow at ' + (process.env.E2E_WIDTH||390) + 'px', (await A.overflow()).length === 0, JSON.stringify(await A.overflow()));
    await A.type('#cfUrl', `http://127.0.0.1:${MOCK}`); await A.type('#cfKey', 'mock-anon-key'); await A.click('#cfgForm button[type="submit"]'); await sleep(300);
    ok('S0 after saving the endpoint: login form appears', await A.ev("!!document.querySelector('#authForm')"));
    await A.shot('02_login'); ok('02_login: no horizontal overflow at ' + (process.env.E2E_WIDTH||390) + 'px', (await A.overflow()).length === 0, JSON.stringify(await A.overflow()));
    ok('S0 nothing was sent to the server before login', (await mock('/__state')).requests.length === 0, JSON.stringify((await mock('/__state')).requests));
    await A.closeSheet();
    await cfg(B, MOCK);

    // ===== S1: ゲストのデータがある端末で新規登録 → 引き継ぎ =====
    await addCourses(A, ['統計学', '経済史']);
    await authForm(A, 'signup', 'a@example.com', 'password-A1');
    ok('S1 signup with existing guest data asks about adopting it', await A.waitFor("!!document.querySelector('[data-acct=\"adopt-yes\"]')") && /ログイン前のデータを引き継ぎますか/.test(await A.ev("document.querySelector('#acctBox').textContent")));
    await A.shot('03_adopt'); ok('03_adopt: no horizontal overflow at ' + (process.env.E2E_WIDTH||390) + 'px', (await A.overflow()).length === 0, JSON.stringify(await A.overflow()));
    ok('S1 the new account starts empty until you choose', (await A.state()).c.length === 0 && (await A.state()).pg === true);
    await A.closeSheet();
    ok('S1 banner on the main screen asks to decide', /引き継ぐか選んでください/.test(await A.ev("document.querySelector('#syncbar').textContent")));
    await A.click('#syncbar [data-acctopen]'); await A.waitFor("document.querySelector('[data-acct=\"adopt-yes\"]')");
    await A.click('[data-acct="adopt-yes"]');
    ok('S1 adopt: courses copied into the account and uploaded (rev 1)', await A.waitFor("sync.rev===1 && !sync.dirty && syncState==='synced'") && (await mock(`/__row?email=${EM('a@example.com')}`)).data.courses.length === 2, JSON.stringify(await A.state()));
    ok('S1 server row holds courses + exams + settings', (r => r.data.exams.length === 1 && r.data.settings.required === 128)(await mock(`/__row?email=${EM('a@example.com')}`)));
    const keys = await A.ev("JSON.stringify(Object.keys(localStorage).sort())");
    ok('S1 local copies are separated per account (guest copy untouched)', /campus-schedule\/v1/.test(keys) && /campus-schedule\/u\//.test(keys) && JSON.parse(await A.ev("localStorage.getItem('campus-schedule/v1')")).courses.length === 2, keys);
    ok('S1 sync dot is green', await A.ev("document.querySelector('#sdot').className") === 'sdot ok');
    await A.openAccount(); await A.shot('04_loggedin'); ok('04_loggedin: no horizontal overflow at ' + (process.env.E2E_WIDTH||390) + 'px', (await A.overflow()).length === 0, JSON.stringify(await A.overflow())); await A.closeSheet(); await A.shot('04b_main_synced');
    await A.closeSheet();

    // ===== S2: 編集 → 自動送信。画面の切替だけでは送らない =====
    await mock('/__clear_requests');
    await A.ev("state.ui.view='list'; save(); render(); state.ui.view='grid'; save(); render(); 1");
    await sleep(2600);
    ok('S2 tab/view switches never write to the server', !(await mock('/__state')).requests.some(r => /^(POST|PATCH|PUT|DELETE) \/rest/.test(r)), JSON.stringify((await mock('/__state')).requests));
    await A.ev("state.courses[0].name='統計学Ⅰ'; save(); 1");
    ok('S2 an edit is marked unsent, then auto-uploaded (rev 2)', await A.ev('sync.dirty') === true && await A.waitFor("sync.rev===2 && !sync.dirty", 7000) && (await mock(`/__row?email=${EM('a@example.com')}`)).data.courses[0].name === '統計学Ⅰ');

    // ===== S3: アクセストークンの期限切れ（モックは2秒）→ 自動更新 =====
    await mock('/__clear_requests'); await sleep(2600);
    await A.ev("state.courses[1].name='経済史Ⅱ'; save(); 1");
    ok('S3 expired token: refreshed automatically and the edit still reaches the server', await A.waitFor("sync.rev===3 && !sync.dirty", 8000) && (await mock('/__state')).requests.some(r => r.includes('/auth/v1/token')));

    // ===== S4: 別の端末で同じアカウントにログイン =====
    await authForm(B, 'login', 'a@example.com', 'password-A1');
    ok('S4 device B pulls the account data (no guest prompt on an empty device)', await B.waitFor("state.courses.length===2 && syncState==='synced'") && (await B.state()).c.join() === '統計学Ⅰ,経済史Ⅱ' && (await B.state()).pg === false, JSON.stringify(await B.state()));
    await B.closeSheet();
    await B.ev("state.courses[0].name='統計学Ⅰ（B）'; save(); 1");
    ok('S4 B edits → uploaded (rev 4)', await B.waitFor("sync.rev===4 && !sync.dirty", 8000));
    ok('S4 A picks up B’s edit on its next sync', await A.ev("syncNow(true).then(r=>r)") === 'synced' && (await A.state()).c[0] === '統計学Ⅰ（B）');

    // ===== S5: 編集シートを開いている間は、画面を差し替えない =====
    await A.ev("openForm(state.courses[0].id); 1"); await sleep(500);
    await B.ev("state.courses[1].name='経済史Ⅲ（B）'; save(); 1"); await B.waitFor("sync.rev===5 && !sync.dirty", 8000);
    ok('S5 background sync is deferred while a form is open (state untouched)', await A.ev("syncNow(false)") === 'deferred' && (await A.state()).c[1] === '経済史Ⅱ');
    await A.closeSheet();
    ok('S5 …and applied right after the sheet closes', await A.waitFor("state.courses[1].name==='経済史Ⅲ（B）'", 5000));

    // ===== S6: 両方が変わった → 競合。どちらも黙って捨てない =====
    await A.ev("state.exams.push(normExam({id:'a1',title:'Aだけの試験',kind:'その他',date:'2026-12-10'})); save(); clearTimeout(syncTimer); 1");
    await B.ev("state.exams.push(normExam({id:'b1',title:'Bだけの試験',kind:'その他',date:'2026-12-11'})); save(); 1"); await B.waitFor("sync.rev===6 && !sync.dirty", 8000);
    ok('S6 both sides changed → conflict detected (nothing overwritten)', await A.ev("syncNow(false)") === 'conflict' && (await A.state()).conflict === true && (await mock(`/__row?email=${EM('a@example.com')}`)).data.exams.some(x => x.title === 'Bだけの試験'));
    ok('S6 conflict shows on the dot and as a banner', await A.ev("document.querySelector('#sdot').className") === 'sdot warn' && /競合/.test(await A.ev("document.querySelector('#syncbar').textContent")));
    await A.click('#syncbar [data-acctopen]'); await A.waitFor("document.querySelector('[data-acct=\"conflict-local\"]')");
    ok('S6 conflict panel offers both sides + export first', !!(await A.ev("document.querySelector('[data-acct=\"conflict-remote\"]')")) && !!(await A.ev("document.querySelector('[data-acct=\"conflict-export\"]')")) && /クラウド：.*授業2件/.test(await A.ev("document.querySelector('#acctBox').textContent")));
    await A.shot('05_conflict'); ok('05_conflict: no horizontal overflow at ' + (process.env.E2E_WIDTH||390) + 'px', (await A.overflow()).length === 0, JSON.stringify(await A.overflow()));
    await A.click('[data-acct="conflict-local"]');
    ok('S6 keeping “this device” overwrites the cloud with it', await A.waitFor("!cloudConflict && sync.rev===7 && !sync.dirty", 8000) && (r => r.data.exams.some(x => x.title === 'Aだけの試験') && !r.data.exams.some(x => x.title === 'Bだけの試験'))(await mock(`/__row?email=${EM('a@example.com')}`)));
    await A.closeSheet();
    ok('S6 B then adopts A’s version', await B.ev("syncNow(true)") === 'synced' && await B.ev("state.exams.some(x=>x.title==='Aだけの試験')"));
    // もう一度、今度は「クラウドの内容にする」
    await A.ev("state.exams.push(normExam({id:'a2',title:'A2',kind:'その他',date:'2026-12-12'})); save(); clearTimeout(syncTimer); 1");
    await B.ev("state.exams.push(normExam({id:'b2',title:'B2',kind:'その他',date:'2026-12-13'})); save(); 1"); await B.waitFor("sync.rev===8 && !sync.dirty", 8000);
    await A.ev("syncNow(false)"); await A.openAccount(); await A.click('[data-acct="conflict-remote"]');
    ok('S6 choosing “cloud” adopts the cloud version and drops the local change', await A.waitFor("!cloudConflict && state.exams.some(x=>x.title==='B2') && !state.exams.some(x=>x.title==='A2')", 6000));
    await A.closeSheet();

    // ===== S7: 同じ端末で別の人（共有端末）。データは混ざらず、ログアウトで消せる =====
    await A.openAccount(); await A.click('[data-acct="logout"]');
    ok('S7 logout asks whether to keep or wipe the local copy', /ログアウトしますか/.test(await A.ev("document.querySelector('#acctBox').textContent")) && !!(await A.ev("document.querySelector('[data-acct=\"logout-wipe\"]')")));
    await A.shot('06_logout'); ok('06_logout: no horizontal overflow at ' + (process.env.E2E_WIDTH||390) + 'px', (await A.overflow()).length === 0, JSON.stringify(await A.overflow()));
    await A.click('[data-acct="logout-keep"]');
    ok('S7 after logout the pre-login (guest) data is back; dot hidden', await A.waitFor("!session && state.courses.length===2 && state.courses[0].name==='統計学'") && await A.ev("document.querySelector('#sdot').hidden"), JSON.stringify(await A.state()));
    ok('S7 session token removed from the device', await A.ev("localStorage.getItem('campus-schedule/auth')") === null);
    await authForm(A, 'signup', 'c@example.com', 'password-C1');
    ok('S7 a second person on the same device: prompt appears again (guest data exists)', await A.waitFor("!!document.querySelector('[data-acct=\"adopt-no\"]')"));
    await A.click('[data-acct="adopt-no"]');
    ok('S7 declining keeps their account empty — A’s data is not visible', await A.waitFor("syncState==='synced' && state.courses.length===0", 7000) && (await mock(`/__row?email=${EM('c@example.com')}`)).data.courses.length === 0);
    ok('S7 each account has its own server row and revision', (await mock('/__state')).rows['a@example.com'] >= 8 && (await mock('/__state')).rows['c@example.com'] === 1);
    await A.ev("state.courses.push(normCourse({id:'c1',name:'Cさんの授業',year:2026,quarters:[1],slots:[{d:0,p:2}],credits:'2'})); save(); 1"); await A.waitFor("sync.rev===2 && !sync.dirty", 7000);
    await A.click('[data-acct="logout"]'); await A.click('[data-acct="logout-wipe"]');
    ok('S7 “wipe and logout”: guest data is intact again', await A.waitFor("!session && state.courses.length===2", 6000));
    const lk = JSON.parse(await A.ev("JSON.stringify(Object.keys(localStorage))"));
    ok('S7 only A’s cache remains locally (C’s was wiped)', lk.filter(k => /campus-schedule\/u\//.test(k)).length === 1, JSON.stringify(lk));
    await closeAll(A);
    await authForm(A, 'login', 'a@example.com', 'password-A1');
    ok('S7 logging in as A again restores A’s cloud data', await A.waitFor("state.courses.length===2 && state.courses[0].name==='統計学Ⅰ（B）' && syncState==='synced'", 8000), JSON.stringify(await A.state()));
    await A.closeSheet();

    // ===== S8: パスワードの再設定 =====
    await A.openAccount(); await A.click('[data-acct="logout"]'); await A.click('[data-acct="logout-keep"]');
    await authForm(A, 'recover', 'a@example.com');
    ok('S8 reset mail requested', await A.waitFor("/再設定メールを送りました/.test(document.querySelector('#acctBox').textContent)") && (await mock('/__state')).mails.some(m => m.kind === 'recovery' && m.email === 'a@example.com'));
    await A.shot('07_recover'); ok('07_recover: no horizontal overflow at ' + (process.env.E2E_WIDTH||390) + 'px', (await A.overflow()).length === 0, JSON.stringify(await A.overflow()));
    const link = (await mock('/__state')).mails.filter(m => m.kind === 'recovery').pop().link;
    const hash = link.slice(link.indexOf('#'));
    await A.nav('about:blank'); await A.nav(APP + hash);
    ok('S8 opening the mail link asks for confirmation first (not logged in yet), shows the account, wipes the token from the URL', await A.waitFor("!!document.querySelector('[data-acct=\"auth-yes\"]')", 8000) && await A.ev("!session && location.hash===''") && /a@example\.com/.test(await A.ev("document.querySelector('#acctBox').textContent")), await A.ev('location.href'));
    await A.click('[data-acct="auth-yes"]');
    ok('S8 after confirming: logged in and the new-password form is shown', await A.waitFor("!!document.querySelector('#pwForm') && !!session", 8000));
    await A.shot('08_newpw'); ok('08_newpw: no horizontal overflow at ' + (process.env.E2E_WIDTH||390) + 'px', (await A.overflow()).length === 0, JSON.stringify(await A.overflow()));
    await A.type('#pwNew', 'new-password-A2'); await A.click('#pwForm button[type="submit"]');
    ok('S8 password changed', await A.waitFor("/パスワードを変更しました/.test(document.querySelector('#acctBox').textContent)", 5000));
    await A.click('[data-acct="logout"]'); await A.click('[data-acct="logout-keep"]');
    await authForm(A, 'login', 'a@example.com', 'password-A1');
    ok('S8 the OLD password no longer works (clear Japanese error)', await A.waitFor("/メールアドレスまたはパスワードが違います/.test(document.querySelector('#acctBox').textContent)", 5000));
    ok('S8 after a failed login the email stays filled (password is cleared)', await A.ev("document.querySelector('#auEmail').value") === 'a@example.com' && await A.ev("document.querySelector('#auPass').value") === '');
    await A.type('#auPass', 'new-password-A2'); await A.click('#authForm button[type="submit"]');
    ok('S8 the NEW password works', await A.waitFor("!!session && syncState==='synced'", 8000));
    await A.closeSheet();

    // ===== S9: 入力の検証と、わかりやすいエラー =====
    await A.openAccount(); await A.click('[data-acct="logout"]'); await A.click('[data-acct="logout-keep"]');
    await authForm(A, 'signup', 'x@example.com', 'short');
    ok('S9 short password is rejected on the device (no request)', /8文字以上/.test(await A.ev("document.querySelector('#acctBox').textContent")));
    await A.ev("document.querySelector('#auPass').value=''; document.querySelector('#auPass2').value=''; 1");
    await A.type('#auPass', 'longenough1'); await A.type('#auPass2', 'different11'); await A.click('#authForm button[type="submit"]');
    ok('S9 mismatching confirmation is rejected', /一致しません/.test(await A.ev("document.querySelector('#acctBox').textContent")));
    await A.shot('09_signup_error'); ok('09_signup_error: no horizontal overflow at ' + (process.env.E2E_WIDTH||390) + 'px', (await A.overflow()).length === 0, JSON.stringify(await A.overflow()));
    await A.ev("document.querySelector('#auEmail').value=''; 1"); await A.type('#auEmail', 'a@example.com'); await A.type('#auPass', 'longenough1'); await A.type('#auPass2', 'longenough1'); await A.click('#authForm button[type="submit"]');
    ok('S9 already-registered email → friendly message', await A.waitFor("/登録済みです/.test(document.querySelector('#acctBox').textContent)", 5000));
    await A.closeSheet();

    // ===== S10: クラウドの記録の削除 / アカウントの削除 =====
    await authForm(A, 'login', 'a@example.com', 'new-password-A2'); await A.waitFor("!!session && syncState==='synced'", 8000);
    await A.openAccount();
    await A.ev("document.querySelector('details.cfg').open=true; 1");
    await A.click('[data-acct="delete-remote"]');
    ok('S10 the management section stays open after the first tap (so the second tap is possible)', await A.ev("document.querySelector('details.cfg').open") === true);
    ok('S10 first tap only arms the delete', /もう一度押すと、クラウドの記録を削除/.test(await A.ev("document.querySelector('[data-acct=\"delete-remote\"]').textContent")) && (await mock('/__state')).rows['a@example.com'] !== undefined);
    await A.click('[data-acct="delete-remote"]');
    ok('S10 second tap deletes the cloud copy only; local data stays', await A.waitFor("sync.rev===0", 5000) && (await mock('/__state')).rows['a@example.com'] === undefined && (await A.state()).c.length === 2);
    await A.ev("document.querySelector('details.cfg').open=true; 1");
    await A.ev("state.courses[0].name='再アップロード'; save(); 1");
    ok('S10 the next edit re-uploads from this device', await A.waitFor("sync.rev===1 && !sync.dirty", 8000) && (await mock(`/__row?email=${EM('a@example.com')}`)).data.courses[0].name === '再アップロード');
    await A.openAccount(); await A.ev("document.querySelector('details.cfg').open=true; 1");
    await A.click('[data-acct="delete-account"]'); await A.click('[data-acct="delete-account"]');
    ok('S10 account deletion removes the user and the data; device returns to guest mode', await A.waitFor("!session && !localStorage.getItem('campus-schedule/auth')", 6000) && (await mock('/__state')).users === 1 && (await mock('/__state')).rows['a@example.com'] === undefined);
    await A.closeSheet();
    await authForm(A, 'login', 'a@example.com', 'new-password-A2');
    ok('S10 the deleted account can no longer log in', await A.waitFor("/メールアドレスまたはパスワードが違います/.test(document.querySelector('#acctBox').textContent)", 5000));
    await A.closeSheet();

    // ===== S11: 通信できないとき / 壊れたクラウドデータ =====
    await B.ev("syncNow(true)"); // B は a@example.com のセッションを持つが、アカウントは削除済み
    ok('S11 B’s session for the deleted account expires gracefully: back to guest mode, with a clear toast', await B.waitFor("!session && document.querySelector('#sdot').hidden", 8000) && /ログインの有効期限が切れました/.test(await B.ev("document.querySelector('#toast').textContent")) && B.errors.length === 0, B.errors.join('|'));
    await authForm(B, 'signup', 'd@example.com', 'password-D1');
    await B.waitFor("syncState==='synced'", 8000); await B.closeSheet();
    await B.ev("(()=>{ const c=cloudConfig(); writeJSON(DEVICE_KEY,{cloud:{url:'http://127.0.0.1:9',anonKey:c.anonKey}}); return 1 })()");
    await B.ev("state.courses.push(normCourse({id:'d1',name:'オフライン中の授業',year:2026,quarters:[1],slots:[{d:0,p:3}],credits:'2'})); save(); 1");
    ok('S11 server unreachable → clear Japanese error, edit kept as unsent', await B.waitFor("syncState==='error'", 8000) && /ネットワークに接続できません/.test(await B.ev('syncError')) && await B.ev('sync.dirty') === true);
    ok('S11 error is surfaced on the main screen banner and the dot', /同期できませんでした/.test(await B.ev("document.querySelector('#syncbar').textContent")) && await B.ev("document.querySelector('#sdot').className") === 'sdot err');
    await B.ev(`(()=>{ const c=cloudConfig(); writeJSON(DEVICE_KEY,{cloud:{url:'http://127.0.0.1:${MOCK}',anonKey:c.anonKey}}); return 1 })()`);
    ok('S11 once reachable again, the unsent edit goes through', await B.ev("syncNow(true)") === 'synced' && (await mock(`/__row?email=${EM('d@example.com')}`)).data.courses.some(c => c.name === 'オフライン中の授業'));
    // 壊れた行をクラウドに置く（本人の権限でできる）→ 別端末は取り込まずに手元を守る
    await B.ev("cloudFetch('/rest/v1/campus_schedules?user_id=eq.'+cloudUser()+'&rev=eq.'+sync.rev,{method:'PATCH',headers:{Prefer:'return=representation'},body:JSON.stringify({data:{courses:'oops'},rev:sync.rev+1})}).then(r=>r.status)");
    await A.nav('about:blank'); await A.nav(APP); await cfg(A, MOCK);
    await authForm(A, 'login', 'd@example.com', 'password-D1');
    ok('S11 logging in with corrupt cloud data: logged in, but nothing adopted and nothing overwritten', await A.waitFor("!!session", 5000) && (await mock(`/__row?email=${EM('d@example.com')}`)).data.courses === 'oops');
    ok('S11 corrupt cloud data is NOT adopted; a clear error is shown', await A.waitFor("syncState==='error' && /読み取れませんでした/.test(syncError)", 8000), await A.ev('syncError + "|" + syncState'));
    await A.closeSheet();

    // ===== S12: メール確認が必要なプロジェクト（Supabase の既定） =====
    const D = new Dev('D'); await D.open(bsend); await D.nav(APP); await cfg(D, MOCK2);
    await authForm(D, 'signup', 'e@example.com', 'password-E1');
    ok('S12 confirm-mail project: tells the user to check mail; not logged in yet', await D.waitFor("/確認メールを送りました/.test(document.querySelector('#acctBox').textContent)", 6000) && await D.ev('!session'));
    await D.ev("document.querySelector('#auEmail').value=''; 1"); await D.type('#auEmail', 'e@example.com'); await D.type('#auPass', 'password-E1'); await D.click('#authForm button[type="submit"]');
    ok('S12 logging in before confirming → clear message', await D.waitFor("/メールの確認がまだ済んでいません/.test(document.querySelector('#acctBox').textContent)", 5000));
    const cf = await mock2(`/__confirm?email=${EM('e@example.com')}`);
    await D.nav('about:blank'); await D.nav(APP + cf.link);
    await D.waitFor("!!document.querySelector('[data-acct=\"auth-yes\"]')", 8000); await D.click('[data-acct="auth-yes"]');
    ok('S12 opening the confirmation link (and confirming) signs the user in', await D.waitFor("!!session && cloudEmail()==='e@example.com' && syncState==='synced'", 8000) && await D.ev("location.hash===''"), JSON.stringify(await D.state()));

    // ===== S13: 二重送信・同時実行の安全性 =====
    await mock('/__clear_requests');
    await A.ev("syncNow(true)"); // A は d@ にログイン中（壊れた行）→ エラーのまま
    await D.ev("Promise.all([syncNow(true),syncNow(true),syncNow(false)]).then(r=>r.join())");
    ok('S13 overlapping syncs share one run (no false conflict)', !(await D.state()).conflict, JSON.stringify(await D.state()));

    // ===== S14: 他人のトークン入りリンクを開かされても、勝手にログインせず、手元のデータも渡らない =====
    const E = new Dev('E'); await E.open(bsend); await E.nav(APP); await cfg(E, MOCK2);
    await addCourses(E, ['Eさんの手元の授業']);
    const evil = (await mock2(`/__confirm?email=${EM('e@example.com')}`)).link;     // 他人（攻撃者）のアカウントのトークン
    await mock2('/__clear_requests');
    await E.nav('about:blank'); await E.nav(APP + evil);
    ok('S14 a foreign token link does NOT log the device in by itself; it asks first', await E.waitFor("!!document.querySelector('[data-acct=\"auth-yes\"]')", 8000) && await E.ev("!session && localStorage.getItem('campus-schedule/auth')===null"));
    ok('S14 the foreign account’s email is shown so it can be recognised', /e@example\.com/.test(await E.ev("document.querySelector('#acctBox').textContent")));
    ok('S14 nothing was uploaded and no local data was touched', !(await mock2('/__state')).requests.some(r => /^(POST|PATCH|PUT|DELETE) \/rest/.test(r)) && (await E.state()).c.join() === 'Eさんの手元の授業');
    await E.click('[data-acct="auth-no"]');
    ok('S14 declining leaves the device logged out with its own data intact', await E.ev("!session") && (await E.state()).c.join() === 'Eさんの手元の授業' && !(await mock2('/__state')).requests.some(r => /^(POST|PATCH|PUT|DELETE) \/rest/.test(r)));
    // ===== S15: 今入力している時間割（旧版が保存したデータ）は、登録・ログイン・ログアウト・削除のどれでも消えない =====
    const F = new Dev('F'); await F.open(bsend); await F.nav(APP);
    const legacy = { v: 2, courses: [
      { id: 'L1', name: '線形代数学Ⅱ', year: 2026, quarters: [3, 4], slots: [{ d: 0, p: 1 }], credits: '2', grade: 'P', category: '基幹科目', room: 'A棟 301', teacher: '山田 太郎', color: '#8b7cff', evals: [{ label: '期末試験', pct: 60 }, { label: 'レポート', pct: 40 }], absences: [{ date: '2026-10-05', type: 'A', p: 1 }], memo: '持ち物：電卓' },
      { id: 'L2', name: 'ミクロ経済学', year: 2026, quarters: [1, 2], slots: [{ d: 2, p: 3 }], credits: '2', grade: 'g1', score: '84', category: '基幹科目' },
      { id: 'L3', name: '教養セミナー', year: 2026, quarters: [3], slots: [], credits: '2', grade: 'N', category: '全学教育科目' } ],
      exams: [{ id: 'LX', courseId: 'L1', kind: '期末試験', date: '2027-02-05', scope: '第1章\n第2章', tasks: [{ id: 't1', t: '第1章', d: '2026-10-20', m: 60, done: '' }], logs: [{ d: '2026-10-01', m: 45 }] }],
      settings: { entryYear: 2026, entrySet: true, years: 4, required: 128, scale: 'sabcf', curr: 1, attRatio: 3, lateRatio: 3, nikkei: '305', cats: [{ id: 'p0', name: '全学教育科目', req: 36, parent: '' }, { id: 'p1', name: '専門教育科目', req: 92, parent: '' }, { id: 'p1_1', name: '基幹科目', req: 12, parent: 'p1' }] },
      ui: { y: 2026, q: 3, view: 'grid', filter: 'term' } };
    const original = JSON.stringify(legacy);
    await F.ev(`localStorage.setItem('campus-schedule/v1', ${JSON.stringify(original)})`);
    await F.nav('about:blank'); await F.nav(APP); await cfg(F, MOCK);
    const view = () => F.ev("JSON.stringify({c:state.courses.map(c=>[c.name,c.grade,c.score,c.category,c.room,c.teacher,c.absences.length,c.evals.length,c.memo]),e:state.exams.map(x=>[x.scope,x.tasks.length,x.logs.length]),n:state.settings.nikkei,r:state.settings.required})");
    const before = await view();
    ok('S15 the existing timetable loads exactly as entered （旧版の P→G・N→H の読み替えだけ）', /線形代数学Ⅱ","G"/.test(before) && /ミクロ経済学","g1","84"/.test(before) && /教養セミナー","H"/.test(before) && /"n":"305"/.test(before) && /持ち物：電卓/.test(before), before.slice(0, 200));
    const sigBefore = await F.ev('payloadSig()');
    await authForm(F, 'signup', 'f@example.com', 'password-F1');
    await F.waitFor("!!document.querySelector('[data-acct=\"adopt-yes\"]')", 8000);
    ok('S15 with existing data and an empty cloud, it asks (and the data is untouched while asking)', await F.ev("pendingGuest.courses.length") === 3 && await F.ev("localStorage.getItem('campus-schedule/v1')") === original);
    await F.click('[data-acct="adopt-yes"]'); await F.waitFor("sync.rev===1 && !sync.dirty", 8000);
    const server = await mock(`/__row?email=${EM('f@example.com')}`);
    ok('S15 after adopting, the account holds the same timetable (courses, grades, exams, tasks, settings)', server.data.courses.length === 3 && server.data.courses[0].name === '線形代数学Ⅱ' && server.data.courses[1].score === '84' && server.data.exams[0].tasks.length === 1 && server.data.settings.nikkei === '305' && (await view()) === before);
    await F.closeSheet();
    ok('S15 the original local copy is byte-for-byte unchanged while logged in', await F.ev("localStorage.getItem('campus-schedule/v1')") === original);
    await F.ev("state.courses[1].name='ミクロ経済学（編集）'; save(); 1"); await F.waitFor("sync.rev===2 && !sync.dirty", 8000);
    ok('S15 edits made while logged in never touch the original local copy', await F.ev("localStorage.getItem('campus-schedule/v1')") === original);
    await F.openAccount(); await F.click('[data-acct="logout"]'); await F.click('[data-acct="logout-keep"]');
    ok('S15 after logout: the original timetable is back, identical', await F.waitFor("!session", 5000) && await F.ev('payloadSig()') === sigBefore && await F.ev("localStorage.getItem('campus-schedule/v1')") === original);
    await authForm(F, 'login', 'f@example.com', 'password-F1'); await F.waitFor("!!session && syncState==='synced'", 8000);
    ok('S15 logging in again brings back the edited cloud copy', (await F.state()).c[1] === 'ミクロ経済学（編集）');
    await F.click('[data-acct="logout"]'); await F.click('[data-acct="logout-wipe"]');
    ok('S15 even “wipe and logout” leaves the original timetable untouched', await F.waitFor("!session", 5000) && await F.ev('payloadSig()') === sigBefore && await F.ev("localStorage.getItem('campus-schedule/v1')") === original);
    await authForm(F, 'login', 'f@example.com', 'password-F1'); await F.waitFor("!!session && syncState==='synced'", 8000);
    await F.openAccount(); await F.ev("document.querySelector('details.cfg').open=true; 1");
    await F.click('[data-acct="delete-account"]'); await F.click('[data-acct="delete-account"]');
    ok('S15 even after deleting the account, the original timetable is still there, byte-for-byte', await F.waitFor("!session && !localStorage.getItem('campus-schedule/auth')", 6000) && await F.ev('payloadSig()') === sigBefore && await F.ev("localStorage.getItem('campus-schedule/v1')") === original);
    await F.closeSheet();

    ok('no uncaught exception on any device', A.errors.length + B.errors.length + D.errors.length + E.errors.length + F.errors.length === 0, [A.errors, B.errors, D.errors, E.errors, F.errors].flat().slice(0, 3).join(' | '));
  } catch (e) { results.push('FAIL harness: ' + e.message); }
  console.log(results.join('\n'));
  const bad = results.filter(r => r.startsWith('FAIL')).length;
  console.log(`
${results.length - bad} PASS / ${bad} FAIL`);
  cleanup(); process.exit(bad ? 1 : 0);
  async function closeAll(d) { try { await d.closeSheet(); } catch (e) {} }
})();
