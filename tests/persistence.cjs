const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve('dist');
let passes = 0;
const eq = (name, actual, expected) => { assert.deepEqual(actual, expected, name); passes++; console.log('PASS', name); };
const server = http.createServer((req,res)=> {
  const pathname = decodeURIComponent(new URL(req.url,'http://localhost').pathname).replace(/^\/chat-app\/?/, '');
  const file = path.join(root, pathname || 'index.html');
  if (!file.startsWith(root) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  const mime = {'.html':'text/html','.js':'application/javascript','.css':'text/css','.png':'image/png','.webp':'image/webp'}[path.extname(file)] || 'application/octet-stream';
  res.writeHead(200,{'Content-Type':mime}); res.end(fs.readFileSync(file));
});
(async()=> {
  await new Promise(r=>server.listen(8901,'127.0.0.1',r));
  const browser = await chromium.launch({headless:true});
  const context = await browser.newContext({ viewport: {width:1440,height:1000} });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e=>errors.push(e.message));
  let keyIds = [11,22], models = ['alpha','deepseek-flash'], delay=30, failRequest=false;
  const chats = [];
  await context.route('**/api/v1/**', async route=> {
    const url = route.request().url();
    const data = url.includes('groups/available') ? [{id:1,name:'通用',platform:'openai'}] : {items:keyIds.map(id=>({id,name:`密钥${id}`,key:`sk-test-${id}`,group_id:1,status:'active'}))};
    await route.fulfill({json:{code:0,data}});
  });
  await context.route('**/v1/models', route=>route.fulfill({json:{data:models.map(id=>({id}))}}));
  await context.route('**/v1/chat/completions', async route=> {
    chats.push(JSON.parse(route.request().postData()));
    await new Promise(r=>setTimeout(r,delay));
    if(failRequest) return route.fulfill({status:400,json:{error:{message:'test failure'}}});
    await route.fulfill({headers:{'content-type':'text/event-stream'},body:[
      {choices:[{delta:{content:'测试回复完成'}}]},
      {choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}}
    ].map(x=>'data: '+JSON.stringify(x)+'\n\n').join('')+'data: [DONE]\n\n'});
  });
  const base='http://127.0.0.1:8901/chat-app/';
  const wait = async()=>{await page.waitForFunction(()=>!document.querySelector('.topbar select')?.disabled);};
  await page.goto(base);
  await page.evaluate(()=>localStorage.setItem('auth_token','test-user'));
  await page.reload(); await wait();
  const keySelect = page.locator('.topbar select').nth(0), modelSelect = page.locator('.topbar select').nth(1);
  const create = async()=> { await page.locator('.rail-head .icon-btn').click(); await page.waitForFunction(()=>!document.querySelector('textarea')?.disabled); };
  const open = async()=> {await page.getByTitle('模型参数',{exact:true}).click(); await page.locator('.dialog').waitFor();};
  const field = (name)=>page.locator('.dialog .field').filter({hasText:name});
  const save = async()=> {await page.locator('.dialog .btn.primary',{hasText:'保存'}).click(); await page.waitForFunction(()=>document.querySelector('.foot-hint .status')?.textContent.includes('参数已保存'));};
  const read = async()=> {
    await open();
    const result = {
      context:await field('context_window').locator('input').inputValue(),
      modalities:await page.locator('.chip.on').allTextContents(),
      effort:await field('reasoning_effort').locator('select').inputValue(),
      temperature:await field('temperature').locator('input').inputValue(),
      timeout:await field('tool_timeout_ms').locator('input').inputValue(),
    };
    await page.locator('.dialog .x').click(); return result;
  };
  const data = async()=>page.evaluate(async()=> {
    const req=indexedDB.open('smartpage_agent');
    const db=await new Promise((r,j)=>{req.onsuccess=()=>r(req.result);req.onerror=()=>j(req.error)});
    const tx=db.transaction('sessions','readonly'); const q=tx.objectStore('sessions').getAll();
    const rows=await new Promise((r,j)=>{q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error)});db.close();
    return { rows, ui:JSON.parse(localStorage.getItem('s2chat_ui_state_v1')||'{}'), list:JSON.parse(localStorage.getItem('s2chat_session_cache_v1')||'{}') };
  });
  const send = async(text)=> {
    await page.locator('textarea').fill(text); await page.locator('.composer .btn.primary').click();
    await page.waitForFunction(()=>document.querySelector('.composer .btn.primary')?.textContent.trim()==='发送');
  };
  // Non-first key and non-first model, exactly the user's values.
  await keySelect.selectOption('22'); await page.waitForTimeout(250);
  await modelSelect.selectOption('deepseek-flash'); await create();
  await open();
  await field('context_window').locator('input').fill('192000');
  await page.locator('.chip',{hasText:'图片'}).click();
  await field('reasoning_effort').locator('select').selectOption('high');
  await field('temperature').locator('input').fill('0.42');
  await field('tool_timeout_ms').locator('input').fill('150000');
  await save();
  const expected={context:'192000',modalities:['文本','图片'],effort:'high',temperature:'0.42',timeout:'150000'};
  eq('after save: ALL params',await read(),expected);
  const a=await data(); const sid=a.ui.selection.sessionId;
  eq('localStorage selection: non-first key/model',{keyId:a.ui.selection.keyId,model:a.ui.selection.model},{keyId:22,model:'deepseek-flash'});
  eq('localStorage session snapshot', [a.list[sid].model_snapshot.context_window,a.list[sid].model_snapshot.modalities,a.list[sid].model_snapshot.model_params.reasoning_effort],[192000,['text','image'],'high']);
  eq('localStorage parameter draft',a.ui.drafts[JSON.stringify(['22','deepseek-flash',sid])].context_window,192000);
  await send('保存后发消息');
  eq('request really uses high effort',chats.at(-1).reasoning_effort,'high');
  eq('after sending: params not overwritten',await read(),expected);
  await page.reload(); await wait();
  eq('refresh restores key',await keySelect.inputValue(),'22');
  eq('refresh restores model',await modelSelect.inputValue(),'deepseek-flash');
  eq('refresh restores active session',(await data()).ui.selection.sessionId,sid);
  eq('refresh restores ALL parameters',await read(),expected);
  eq('session list visible',await page.locator('.session-item').count(),1);
  // Second session, separate saved parameter set.
  await create(); const sidB=(await data()).ui.selection.sessionId;
  await open(); await field('context_window').locator('input').fill('96000'); await save();
  await page.locator('.session-item').nth(1).click();
  eq('switch back restores A including execution params',await read(),expected);
  await page.reload();await wait(); eq('refresh after switching A',await read(),expected);
  await page.locator('.session-item').nth(0).click();
  eq('B independent context',(await read()).context,'96000');
  // Model change intentionally clears parameters for the current session.
  await modelSelect.selectOption('alpha'); await page.waitForTimeout(250);
  const reset=await read(); eq('model change clears runtime',[reset.context,reset.modalities],['32000',['文本']]);
  eq('model change clears reasoning',reset.effort,'');
  await page.reload();await wait(); eq('model change remains reset after reload',(await read()).context,'32000');
  await keySelect.selectOption('11');await page.waitForTimeout(250);
  eq('key change clears model parameters',(await read()).context,'');
  await page.reload();await wait();eq('refresh keeps new key',await keySelect.inputValue(),'11');
  eq('key11 has no sessions from key22',await page.locator('.session-item').count(),0);
  // Draft before creating a session.
  await open(); await field('context_window').locator('input').fill('192000');await field('reasoning_effort').locator('select').selectOption('high');await page.locator('.chip',{hasText:'图片'}).click();await save();
  await page.reload();await wait();eq('draft without a session persists',(await read()).context,'192000');
  await create();eq('draft is bound to newly created session',(await read()).context,'192000');
  // Model deleted on server -> fall back + clear old params; key deleted -> first valid key.
  models=['alpha']; await page.reload();await wait();eq('model still valid retained',await modelSelect.inputValue(),'alpha');
  models=['alpha','deepseek-flash'];await page.reload();await wait();
  await modelSelect.selectOption('deepseek-flash');await page.waitForTimeout(200);
  await open();await field('context_window').locator('input').fill('192000');await save();
  models=['alpha'];await page.reload();await wait();
  eq('removed selected model falls back',await modelSelect.inputValue(),'alpha');
  eq('removed model parameters cleared',(await read()).context,'32000');
  keyIds=[22]; await page.reload();await wait();eq('removed key falls back to valid key',await keySelect.inputValue(),'22');
  eq('no cross-key parameter leak',(await read()).context,'');
  // Busy guard: no new session while request still in flight.
  await create(); delay=1000;
  await page.locator('textarea').fill('慢请求');await page.locator('.composer .btn.primary').click();
  const count=await page.locator('.session-item').count();
  await page.locator('.rail-head .icon-btn').click();
  eq('busy guard blocks create',await page.locator('.session-item').count(),count);
  await page.waitForFunction(()=>document.querySelector('.composer .btn.primary')?.textContent.trim()==='发送');
  eq('busy guard releases after success',await keySelect.isDisabled(),false);
  failRequest=true;await send('失败请求');eq('busy guard releases after failure',await keySelect.isDisabled(),false);
  eq('no JS errors',errors,[]);

  await browser.close();server.close();console.log(`RESULT ${passes} passed`);
})().catch(e=>{console.error(e);server.close();process.exit(1)});
