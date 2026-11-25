// End-to-end checks for the import, file transfer, scan and dictation workflows.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {createHash}=require('node:crypto');
const pw=require(process.env.PLAYWRIGHT_PATH || 'playwright');
const origin=new URL(process.env.VITA_URL || 'http://127.0.0.1:4411');
const engine=process.env.VITA_BROWSERS || 'chromium';
const device=process.env.VITA_DEVICE;
const liveVoice=process.env.VITA_LIVE_VOICE==='1';
const requirePrimary=process.env.VITA_REQUIRE_PRIMARY==='1';
const forceFallback=process.env.VITA_FORCE_FALLBACK==='1';
const syntheticMic=process.env.VITA_SYNTHETIC_MIC==='1';
const dictation='/api/dictation';
const liveDictation=dictation+'/live';
const words='I prepared monthly budgets and checked financial reports.';
const reports=[], results=path.resolve(process.env.VITA_QA_RESULTS || 'qa/results/experience');
const fixtures=name=>path.join(__dirname,'fixtures',name);
const clock=()=>performance.now();
const python=process.env.VITA_QA_PYTHON || path.resolve(__dirname,'../../resume-fixtures-venv/bin/python');
const canonical={
  name:'Nora Mercier',email:'nora.mercier@example.test',phone:'+1 416-555-0124',location:'Ottawa, Ontario, Canada',
};
const widths=device?pw.devices[device]:{viewport:{width:1280,height:780}};
let browser;
async function run(name,test) {
  if (process.env.VITA_CASE && !(new RegExp(process.env.VITA_CASE,'i')).test(name)) return;
  const context=await browser.newContext({...widths,acceptDownloads:true});
  const page=await context.newPage();
  const errors=[], requests=[];
  context.on('request',r=>{if(/^https?:/.test(r.url()))requests.push([r.method(),r.url()]);});
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',message=>{if(message.type()==='error' && !/Failed to load resource|404 \(Not Found\)/i.test(message.text()))errors.push(message.text().slice(0,200));});
  page.setDefaultTimeout(8000);
  const start=clock();
  try {
    const response=await page.goto(origin.href);
    assert.equal(response.status(),200); assert.match(await page.title(),/Vita/);
    await page.waitForFunction(()=>document.querySelector('#entries')?.children.length);
    assert.equal(await page.locator('vite-error-overlay').count(),0);
    const measured=await test(page,context);
    assert.deepEqual(errors,[]);
    assert.deepEqual(requests.filter(([method,url])=>(!['GET','HEAD'].includes(method)&&!(method==='POST'&&[dictation,liveDictation].includes(new URL(url).pathname)))||new URL(url).origin!==origin.origin||/mercier@|monthly.budgets|student.id/i.test(url)),[]);
    reports.push({name,status:'pass',ms:Math.round(clock()-start),...measured});
    console.log('PASS',name,JSON.stringify(measured||{}));
  } catch(e) {
    reports.push({name,status:'fail',error:e.message,errors});
    console.log('FAIL',name,e.message.slice(0,450),errors);
    await page.screenshot({caret:'initial',path:path.join(results,'failure-'+reports.length+'.png')}).catch(()=>{});
  } finally {await context.close();}
}
async function upload(page,file) {
  await page.locator('[data-step=start]').click();
  await page.locator('#import-file').setInputFiles(Array.isArray(file)?file.map(fixtures):fixtures(file));
}
async function apply(page) {
  await page.locator('#apply-import').click();
  await page.locator('#name').waitFor();
}
async function entries(page) {
  return page.locator('#entries [data-index]').evaluateAll(nodes=>nodes.map(n=>Object.fromEntries([...n.querySelectorAll('[data-field]')].map(f=>[f.dataset.field,f.value]))));
}
async function dl(page,id) {
  const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#'+id).click()]);
  const file=path.join(results,download.suggestedFilename());
  await download.saveAs(file);return file;
}
async function voiceField(page) {
  await page.locator('[data-step=review]').click();
  const field=page.locator('#summary');
  await field.fill('Original text.');
  const wrapper=page.locator('.voice-field').filter({has:field});
  return {field, wrapper, mic:wrapper.locator('[data-voice-mic]'), file:wrapper.locator('[data-voice-file]'), cancel:wrapper.locator('[data-voice-cancel]')};
}
async function expectWords(page,field) {
  await page.waitForFunction(()=>/monthly budgets?.*financial reports/i.test(document.querySelector('#summary').value),{}, {timeout:38_000});
  assert.match(await field.inputValue(),/financial reports/i);
}
async function checkMicFit(mic) {
  const result=await mic.evaluate(async button=>{
    await document.fonts.ready;
    const label=button.querySelector('[data-voice-label]');
    const edge=button.getBoundingClientRect().right;
    const padding=Number.parseFloat(getComputedStyle(button).paddingRight);
    return {edge,label:label.getBoundingClientRect().right,padding,overflow:document.documentElement.scrollWidth>innerWidth};
  });
  assert.ok(result.edge-result.label>=result.padding-.5,'the label fits inside its button padding');
  assert.equal(result.overflow,false);
}
async function injectMicrophone(page) {
  const wav = (await fs.readFile(fixtures('spoken-microphone.wav'))).toString('base64');
  await page.evaluate(base64=>{
    const Audio = window.AudioContext || window.webkitAudioContext;
    const resume = Audio.prototype.resume;
    let audio;
    Audio.prototype.resume=function() {
      audio=this;
      return resume.call(this);
    };
    const devices = Object.getPrototypeOf(navigator.mediaDevices);
    Object.defineProperty(devices,'getUserMedia',{configurable:true,value:async function vitaFixture(){
      const output = audio.createMediaStreamDestination();
      const source = audio.createBufferSource();
      source.buffer=await audio.decodeAudioData(Uint8Array.from(atob(base64),char=>char.charCodeAt(0)).buffer);
      source.connect(output);
      source.start();
      return output.stream;
    }});
  },wav);
  // A test must never use the host microphone.
  assert.equal(await page.evaluate(()=>navigator.mediaDevices.getUserMedia.name),'vitaFixture');
}

async function voiceResponse(context, code=200, json={text:words}, read = () => {}) {
  await context.route('**'+dictation,async route=>{
    const request=route.request();
    const bytes=request.postDataBuffer();
    assert.equal(request.method(),'POST');
    assert.equal(request.headers()['content-type'],'audio/wav');
    assert.equal(request.headers()['x-amz-content-sha256'],createHash('sha256').update(bytes).digest('hex'));
    assert.equal(bytes.subarray(0,4).toString(),'RIFF');
    assert.equal(bytes.readUInt32LE(24),16000);
    read(bytes);
    await route.fulfill({status:code,json});
  });
}

async function liveResponse(page,context,mode) {
  await context.route('**'+liveDictation,async route=>{
    const request=route.request(), body=request.postDataBuffer();
    assert.equal(request.headers()['content-type'],'application/sdp');
    assert.equal(request.headers()['x-amz-content-sha256'],createHash('sha256').update(body).digest('hex'));
    assert.ok(body.toString().includes('m=audio'));
    if (mode==='quota') await route.fulfill({status:429,json:{code:'voice_allowance'}});
    else await route.fulfill({status:200,json:{sdp:'v=0\r\ns=fixture\r\n'}});
  });
  await context.addInitScript(({mode,words})=>{
    window.vitaMock = {closed:false,commits:0,audioBytes:0};
    window.RTCPeerConnection=class {
      addTransceiver() {}
      createDataChannel() {
        const push=event=>this.channel.onmessage?.({data:JSON.stringify(event)});
        window.vitaMock.emit=push;
        this.channel={
          readyState:'connecting',
          close() { this.readyState='closed'; },
          send(message) {
            const event=JSON.parse(message);
            if(event.type==='input_audio_buffer.append') {
              window.vitaMock.audioBytes+=atob(event.audio).length;
              return;
            }
            if(event.type!=='input_audio_buffer.commit') throw new Error('Unexpected event');
            window.vitaMock.commits++;
            queueMicrotask(()=>{
              push({type:'conversation.item.input_audio_transcription.completed',item_id:'previous',transcript:'Ignore this result.'});
              push({type:'conversation.item.input_audio_transcription.completed',item_id:'current',transcript:mode==='empty'?'  ':words});
              push({type:'input_audio_buffer.committed',item_id:'current'});
            });
          },
        };
        return this.channel;
      }
      async createOffer() { return {type:'offer',sdp:'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n'}; }
      async setLocalDescription(offer) { this.localDescription=offer; }
      async setRemoteDescription() {
        this.channel.readyState='open';
        this.channel.onopen?.();
        window.vitaMock.emit({type:'session.created',session:{type:'transcription'}});
      }
      close() { window.vitaMock.closed=true; }
    };
  },{mode,words});
  await page.reload();
}

async function testProfiles(page) {
  let facts=0;
  const checks=[];
  for(const file of ['profile-sidebar.pdf','profile-staggered.pdf','profile-mirrored.pdf']) {
    await upload(page,file);await page.locator('#apply-import').waitFor();
    const metrics=await page.locator('#apply-import').evaluate(e=>{const b=e.getBoundingClientRect();return {y:b.y,bottom:b.bottom,height:innerHeight,width:innerWidth,pageWidth:document.documentElement.scrollWidth};});
    assert.ok(metrics.bottom<=metrics.height);assert.equal(metrics.pageWidth,metrics.width);
    assert.equal(await page.locator('#candidate-preview details[open]').count(),0);
    if(file==='profile-sidebar.pdf' && engine!=='webkit') await page.screenshot({caret:'initial',path:path.join(results,'import.png')});
    await page.locator('[data-step=download]').click();
    assert.equal(await page.locator('#download-screen').isVisible(),false);
    await apply(page);
    for(const [key,value] of Object.entries(canonical)){assert.equal(await page.locator('#'+key).inputValue(),value);facts++;}
    const web=await page.locator('#website').inputValue();assert.match(web,/linkedin\.com\/in\/nora-mercier/);assert.match(web,/ledger\.example/);facts+=2;
    const items=await entries(page),section=x=>items.filter(e=>e.section===x);
    assert.ok(section('Skills').some(e=>e.details.includes('Microsoft Excel')));
    assert.ok(section('Languages').some(e=>e.details.includes('French')));
    assert.ok(section('Certifications').some(e=>e.title==='Data Fluency: Methods & Practice'));
    assert.equal(section('Certifications').length,3);
    assert.ok(section('Experience').some(e=>e.title==='Senior Financial Analyst'&&e.organization==='Northern Ledger Group'&&e.dates.includes('2022')));
    assert.ok(section('Education').some(e=>e.title==='Bachelor of Commerce'&&e.organization==='Fictional Lake University'));
    assert.ok(!JSON.stringify(items).includes('Page 2 of 2'));
    facts+=7; checks.push(metrics);
  }
  return {facts,fixtures:3,actionY:checks.map(x=>Math.round(x.y)),viewport:page.viewportSize()};
}
async function start() {
  await fs.mkdir(results,{recursive:true});
  const options={executablePath:process.env['VITA_'+engine.toUpperCase()+'_EXECUTABLE']};
  if (engine==='chromium') options.args=['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--use-file-for-fake-audio-capture='+fixtures('spoken-microphone.wav')];
  browser=await pw[engine].launch(options);
  try {
    await run('profile fields and first-screen action',testProfiles);
    await run('editable Word round trip and both backup generations',async page=>{
      await upload(page,'profile-sidebar.pdf');await apply(page);
      const original=await entries(page);await page.locator('[data-step=download]').click();
      await page.getByRole('button',{name:'Download editable Word file'}).waitFor();
      const word=await dl(page,'download-docx');assert.match(word,/\.docx$/);
      const proof=JSON.parse(execFileSync(python,[path.join(__dirname,'inspect_exports.py'),word],{encoding:'utf8'}));
      for(const detail of ['Northern Ledger Group','Ledger Foundations','Data Fluency: Methods & Practice','Languages'])assert.ok(proof.text.includes(detail));
      await page.locator('.transfer-options > summary').click();
      const backup=await dl(page,'save-draft');assert.match(backup,/\.vita$/u);
      const raw=await fs.readFile(backup),legacy={name:'Previous résumé.vita.json',mimeType:'application/json',buffer:raw};
      for(const input of [word,backup,legacy]) {
        await page.locator('[data-step=start]').click();await page.locator('#import-file').setInputFiles(input);await apply(page);
        assert.equal(await page.locator('#name').inputValue(),canonical.name);
        assert.deepEqual(await entries(page),original);
      }
      for(const mode of ['rename','paragraph']) {
        const edited=path.join(results,'edited-'+mode+'.docx');
        execFileSync(python,[path.join(__dirname,'edit-word.py'),word,edited,mode]);
        await page.locator('[data-step=start]').click();await page.locator('#import-file').setInputFiles(edited);await apply(page);
        if(mode==='rename'){assert.equal(await page.locator('#name').inputValue(),'Nora Lee');assert.deepEqual(await entries(page),original);}
        else assert.ok(JSON.stringify(await entries(page)).includes('Reviewed a new budget workbook in Word.'));
      }
      return {formats:['.docx','.vita','.vita.json'],entries:original.length,externalWordEdits:2};
    });
    await run('one file picker for a resume and supporting documents',async page=>{
      await upload(page,['profile-sidebar.pdf','support-unofficial-transcript.pdf','support-certificate.docx']);
      await apply(page);await page.locator('#support-files article').nth(1).waitFor();
      await page.locator('#support-files input[data-support-selected]').first().check();
      await page.locator('#apply-support').click();await page.locator('#cancel-support').click();
      assert.ok((await entries(page)).some(e=>e.organization==='Stonewater College'));
      await page.locator('#undo').click();assert.ok(!(await entries(page)).some(e=>e.organization==='Stonewater College'));
      await upload(page,['finance.txt','finance.docx']);await page.locator('#file-set').waitFor();
      await page.locator('#primary-file').selectOption('1');await page.locator('#file-set-use').click();
      await page.locator('#cancel-import').click();
      await upload(page,'support-unofficial-transcript.pdf');await page.locator('#support-review').waitFor();
      assert.equal(await page.locator('#name').inputValue(),canonical.name);
      return {automaticPairing:true,ambiguousChoice:true,transcriptPreservedDraft:true};
    });
    await run('scan reads PDF and photo and preserves old work',async page=>{
      for(const file of ['scan-clear.pdf','scan-clear.png']) {
        await upload(page,file);await page.locator('#read-scan').click();
        await page.locator('#apply-import').waitFor({timeout:90000});await apply(page);
        assert.equal(await page.locator('#email').inputValue(),'amelie@example.test');assert.match(await page.locator('#name').inputValue(),/Amelie Fortin/i);
      }
      await upload(page,'scan-readable-and-image.pdf');await page.getByRole('button',{name:'Read scanned pages'}).click();
      await page.locator('#read-scan').click();await page.waitForFunction(()=>document.querySelector('#scan-panel').hidden,{},{timeout:90000});
      assert.match(await page.locator('#import-notes').textContent(),/Read from a scan/i);
      return {realImageOCR:3};
    });
    await run('voice memo inserts directly in the field and can be edited or undone',async(page,context)=>{
      if(!liveVoice) await voiceResponse(context);
      const {field,wrapper,file}=await voiceField(page);
      await file.setInputFiles(fixtures('spoken-work.wav'));
      await expectWords(page,field);
      assert.match(await field.inputValue(),/^Original text\./);
      assert.equal(await page.locator('dialog[open]').count(),0);
      await wrapper.getByRole('button',{name:'Undo dictation'}).click();
      assert.equal(await field.inputValue(),'Original text.');
    });
    await run('microphone denial and unreadable recordings preserve existing text',async page=>{
      await page.evaluate(()=>Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:()=>Promise.reject(new DOMException('Denied','NotAllowedError'))}}));
      const {field,mic,file}=await voiceField(page);
      await mic.click();await page.getByText(/Microphone access is off/).waitFor();
      await file.setInputFiles({name:'broken.wav',mimeType:'audio/wav',buffer:Buffer.from('bad')});
      await page.getByText(/This recording could not be opened/).waitFor();
      const silence=Buffer.from(await fs.readFile(fixtures('spoken-work.wav')));
      const offset=silence.indexOf(Buffer.from('data'));assert.ok(offset>0);silence.fill(0,offset+8);
      await file.setInputFiles({name:'silence.wav',mimeType:'audio/wav',buffer:silence});
      await page.getByText(/No clear speech was heard/).waitFor();
      assert.equal(await field.inputValue(),'Original text.');
    });
    await run('leaving a field releases a late microphone permission',async page=>{
      await page.evaluate(()=>Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:()=>new Promise(resolve=>{
        window.openLater=()=>resolve({getTracks:()=>[{stop:()=>{window.lateStopped=true;}}]});
      })}}));
      const {field,mic}=await voiceField(page);
      await mic.click();await page.getByText(/Waiting for microphone permission/).waitFor();
      await page.locator('[data-step=start]').click();
      await page.evaluate(()=>window.openLater());
      await page.waitForFunction(()=>window.lateStopped===true);
      await page.locator('[data-step=review]').click();
      assert.equal(await field.inputValue(),'Original text.');
      assert.equal(await page.getByRole('button',{name:'Use recording'}).count(),0);
    });
    await run('the selected text is replaced and words can be recovered at the field limit',async(page,context)=>{
      await voiceResponse(context,200,{text:'a clearer work description'});
      const {field,file,wrapper}=await voiceField(page);
      await field.fill('Keep draft today');
      await field.evaluate(e=>{e.focus();e.setSelectionRange(5,10);e.maxLength=16;});
      await file.setInputFiles(fixtures('spoken-work.wav'));
      await wrapper.getByText(/text limit was reached/).waitFor();
      assert.equal(await field.inputValue(),'Keep draft today');
      assert.equal(await wrapper.locator('[data-voice-words]').inputValue(),'a clearer work description');
      await field.evaluate(e=>{e.maxLength=5000; e.focus(); e.setSelectionRange(5,10);});
      await file.setInputFiles(fixtures('spoken-work.wav'));
      await wrapper.getByText('Added to this field.').waitFor();
      assert.equal(await field.inputValue(),'Keep a clearer work description today');
    });
    await run('cancel while transcribing keeps the original field',async(page,context)=>{
      let release;
      let requested;
      const arrived=new Promise(resolve=>{requested=resolve;});
      await context.route('**'+dictation,route=>{release=()=>route.fulfill({status:200,json:{text:words}}).catch(()=>{});requested();});
      const {field,file,cancel}=await voiceField(page);
      await file.setInputFiles(fixtures('spoken-work.wav'));
      await arrived;await cancel.click();await release();
      await page.waitForLoadState('networkidle');
      assert.equal(await field.inputValue(),'Original text.');
    });
    await run('a failed request retries the existing clip and the allowance preserves typing',async(page,context)=>{
      await voiceResponse(context,503,{code:'unavailable'});
      const {field,file,wrapper}=await voiceField(page);
      await file.setInputFiles(fixtures('spoken-work.wav'));
      await wrapper.getByText(/temporarily unavailable/).waitFor();
      await context.unroute('**'+dictation);
      await voiceResponse(context,429,{code:'voice_allowance'});
      await wrapper.getByRole('button',{name:'Try again'}).click();
      await wrapper.getByText(/monthly limit/).waitFor();
      assert.equal(await field.inputValue(),'Original text.');
      await field.fill('Still editable');
      assert.equal(await field.inputValue(),'Still editable');
    });
    if (engine==='chromium'||syntheticMic) await run('two microphone taps record and insert editable words',async (page,context)=>{
      if(syntheticMic) await injectMicrophone(page);
      if(!liveVoice) await voiceResponse(context);
      if(forceFallback) await context.route('**'+liveDictation,route=>route.fulfill({status:429,json:{code:'voice_allowance'}}));
      const calls = [];
      context.on('response',reply=>{
        const path=new URL(reply.url()).pathname;
        if([dictation,liveDictation].includes(path)) calls.push([path,reply.status()]);
      });
      const {field,mic,wrapper}=await voiceField(page);
      await checkMicFit(mic);
      if(device) await mic.tap();
      else await mic.click();
      await mic.getByText('Use recording').waitFor({timeout:15_000});
      await checkMicFit(mic);
      await wrapper.locator('[data-voice-meter]').waitFor();
      await page.waitForFunction(()=>document.querySelector('#summary').closest('.voice-field').querySelector('[data-voice-clock]').textContent==='0:06',{}, {timeout:15_000});
      const liveText = await wrapper.locator('[data-voice-caption]').isVisible();
      if(!device) await page.screenshot({path:path.join(results,'recording.png'),caret:'initial'});
      if(device) await mic.tap();
      else await mic.click();
      const stopped = clock();
      await expectWords(page,field);
      const finishMs = Math.round(clock()-stopped);
      assert.equal(await page.getByRole('button',{name:'Use recording'}).count(),0);
      if(requirePrimary) {
        assert.deepEqual(calls,[[liveDictation,200]],'a primary result should only call the live endpoint');
        assert.equal(liveText,true,'live words should appear before the recording stops');
      }
      if(forceFallback) assert.deepEqual(calls,[[liveDictation,429],[dictation,200]]);
      return {twoTaps:true,liveVoice,liveText,finishMs};
    });
    if(engine==='chromium'&&!liveVoice) {
      for (const mode of ['success','drop','quota','empty']) {
        await run('dictation primary and fallback: '+mode,async(page,context)=>{
          let backup = 0, frames = 0;
          await liveResponse(page,context,mode);
          await voiceResponse(context,200,{text:words},bytes=>{backup++;frames=(bytes.length-44)/2;});
          const {field,mic,wrapper}=await voiceField(page);
          await mic.click();
          await wrapper.getByText('Listening…',{exact:true}).waitFor();
          if (mode!=='quota') {
            await page.waitForFunction(()=>window.vitaMock.audioBytes>0);
            await page.evaluate(()=>window.vitaMock.emit({type:'conversation.item.input_audio_transcription.delta',
              item_id:'current',delta:'Temporary live words.'}));
            await wrapper.getByText('Temporary live words.',{exact:true}).waitFor();
            assert.equal(await field.inputValue(),'Original text.');
            if(mode==='drop') {
              await page.evaluate(()=>window.vitaMock.emit({type:'error',error:{code:'insufficient_quota'}}));
              await wrapper.locator('[data-voice-caption]').waitFor({state:'hidden'});
            }
          }
          await page.waitForFunction(()=>document.querySelector('#summary').closest('.voice-field').querySelector('[data-voice-clock]').textContent==='0:06',{}, {timeout:15_000});
          await mic.click();
          await expectWords(page,field);
          assert.equal(await field.inputValue(),'Original text. '+words);
          assert.equal(await page.evaluate(()=>window.vitaMock.closed),true);
          const commits=await page.evaluate(()=>window.vitaMock.commits);
          assert.equal(commits,['success','empty'].includes(mode)?1:0);
          const streamedBytes=await page.evaluate(()=>window.vitaMock.audioBytes);
          if(commits) assert.ok(streamedBytes>=24_000*2*5,'primary receives the complete capture at 24 kHz');
          assert.equal(backup,mode==='success'?0:1);
          if(backup) assert.ok(frames>=16_000*5,'fallback uses the complete multisecond recording');
          await wrapper.locator('[data-voice-caption]').waitFor({state:'hidden'});
          return {commits,backup,frames,streamedBytes};
        });
      }
    }
    await run('two tabs protect each other’s draft',async(page,context)=>{
      await page.locator('[data-step=review]').click();await page.locator('#name').fill('First Example');
      await page.waitForFunction(()=>localStorage.getItem('vita:draft:v1')?.includes('First Example'));
      const second=await context.newPage();await second.goto(origin.href);await second.locator('[data-step=review]').click();
      await second.locator('#name').fill('Second Example');await page.locator('#storage-conflict').waitFor();
      await page.locator('#name').fill('Unsaved first tab');await page.locator('#use-tab').click();
      assert.equal(await page.locator('#name').inputValue(),'Second Example');
      await page.locator('#undo').click();assert.equal(await page.locator('#name').inputValue(),'Unsaved first tab');
      await second.close();
    });
  } finally {await browser.close();}
  await fs.writeFile(path.join(results,'experience.json'),JSON.stringify({engine,device:device||null,origin:origin.href,reports},null,2));
  process.exitCode=Number(reports.some(x=>x.status!=='pass'));
}
start().catch(error=>{console.error(error);process.exitCode=1;});
