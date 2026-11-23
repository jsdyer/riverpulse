import {stationQuery,pretty,finite,validateReceipt,latest,seriesSegments,revisions,toCSV,safeSource} from './model.mjs';
import {getJSON,fetchReceipt,createArchiveLookup} from './service.mjs?v=archive-dates-1';
const $ = id => document.getElementById(id);
const colours = ['#2f6d66','#b67b39','#6d69a6','#ac5860'];
const state = {config:null,catalogue:null,index:null,receipt:null,selected:null,quantity:'discharge',shown:25,rows:100,memory:new Map(),controller:null,request:0,coverage:new Map(),archiveController:null,archiveRequest:0};
const archiveLookup=createArchiveLookup();
const text = (tag,value,cls) => {const el=document.createElement(tag);el.textContent=value;if(cls)el.className=cls;return el;};
const titleCase = name => String(name).toLowerCase().replace(/(^|[\s(-])\p{L}/gu,c=>c.toUpperCase());
const time = value => new Date(value).toLocaleString('en-CA',{timeZone:'UTC',dateStyle:'medium',timeStyle:'short'})+' UTC';
function status(message,error=false){$('status').textContent=message;$('status').classList.toggle('error',error);}
function currentEntry(){return state.receipt?.stations.find(e=>e.station.id===state.selected?.id);}
function option(value,label){const o=text('option',label);o.value=value;return o;}
function renderStations(){
  const query=$('station-query').value,province=$('province').value;
  let matches=stationQuery(state.catalogue.stations,query,province);
  const saved=new Set(state.config.stationIds);
  if(!query&&!province)matches=[...matches].sort((a,b)=>(Number(saved.has(b.id))-Number(saved.has(a.id)))||a.name.localeCompare(b.name));
  $('station-count').textContent=`${matches.length.toLocaleString()} matching stations`;
  const nodes=matches.slice(0,state.shown).map(s=>{
    const b=text('button','',`station-choice${state.selected?.id===s.id?' selected':''}`);b.type='button';b.setAttribute('aria-pressed',String(state.selected?.id===s.id));b.append(text('strong',titleCase(s.name)));
    b.append(text('span',`${s.id} · ${s.province} · ${s.status||'Status unavailable'}`));
    if(saved.has(s.id))b.append(text('span','Retained station','saved-badge'));
    b.addEventListener('click',()=>selectStation(s));return b;
  });
  $('station-list').replaceChildren(...(nodes.length?nodes:[text('p','No match. Try a shorter station name, or clear the province filter.','no-results')]));
  $('more-stations').hidden=matches.length<=state.shown;
}
function selectStation(station){
  state.controller?.abort();state.archiveController?.abort();state.archiveRequest++;state.request++;setBusy(false);state.selected=station;state.rows=100;
  renderStations();render();
  status(currentEntry()?`Showing a retained capture for ${station.id}. Fetch to request another period.`:`${station.id} is selected; observations have not been loaded. ${station.status==='Discontinued'?'This gauge is discontinued: find its archive dates to choose suitable years.':'Fetch this station to load the chosen periods.'}`);
}
function setBusy(busy){$('fetch-button').disabled=busy;$('fetch-top').disabled=busy;$('cancel-button').hidden=!busy;}
function svgElement(tag,attrs={},value){const el=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [key,v] of Object.entries(attrs))el.setAttribute(key,String(v));if(value!=null)el.textContent=value;return el;}
function chart(container,series,kind,loaded=true){
  const quantity=state.quantity;
  const chunks=series.map((s,i)=>({series:s,colour:colours[i%colours.length],segments:seriesSegments(s.observations,quantity,kind)}));
  const points=chunks.flatMap(c=>c.segments.flat());
  container.replaceChildren();
  if(!loaded){container.append(text('p','Not loaded yet. Fetch this station, or find its archive dates above to choose suitable years.','empty'));return;}
  if(!points.length){container.append(text('p',kind==='daily'?'No archived values for this measurement in the selected years. Choose earlier years or another measurement.':'No recent values for this measurement in the captured period. Historical records may still be available.','empty'));return;}
  const width=850,height=265,left=60,right=18,top=18,bottom=40,plotW=width-left-right,plotH=height-top-bottom;
  const minX=kind==='daily'?Date.UTC(2000,0,1):points.reduce((v,p)=>Math.min(v,p.x),Infinity);
  let maxX=kind==='daily'?Date.UTC(2000,11,31):points.reduce((v,p)=>Math.max(v,p.x),-Infinity);if(maxX===minX)maxX+=3600000;
  let minY=points.reduce((v,p)=>Math.min(v,p.y),Infinity),maxY=points.reduce((v,p)=>Math.max(v,p.y),-Infinity);
  const pad=(maxY-minY||Math.abs(maxY)*.05||1)*.12;minY-=pad;maxY+=pad;if(quantity==='discharge'&&minY<0)minY=0;
  const x=v=>left+(v-minX)/(maxX-minX)*plotW,y=v=>top+(maxY-v)/(maxY-minY)*plotH;
  const svg=svgElement('svg',{viewBox:`0 0 ${width} ${height}`,role:'img','aria-label':`${quantity==='level'?'Water level in metres':'Discharge in cubic metres per second'}; ${kind==='daily'?'daily means aligned by month and day':'recent observations in UTC'}. See observation table below.`});
  for(let i=0;i<5;i++){const val=minY+(maxY-minY)*i/4,yy=y(val);svg.append(svgElement('line',{x1:left,x2:width-right,y1:yy,y2:yy,stroke:'#e2e7db','stroke-dasharray':'3 5'}));svg.append(svgElement('text',{x:left-10,y:yy+4,'text-anchor':'end',fill:'#6f7f6f','font-size':11,'font-family':'system-ui'},pretty(val)));}
  const ticks=kind==='daily'?[0,3,6,9,11].map(m=>Date.UTC(2000,m,1)):Array.from({length:5},(_,i)=>minX+(maxX-minX)*i/4);
  for(const tick of ticks){const d=new Date(tick);const label=kind==='daily'?d.toLocaleDateString('en',{month:'short',timeZone:'UTC'}):d.toLocaleDateString('en-CA',{month:'short',day:'numeric',timeZone:'UTC'})+' '+d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',timeZone:'UTC'});svg.append(svgElement('text',{x:x(tick),y:height-13,'text-anchor':tick===minX?'start':tick===maxX?'end':'middle',fill:'#6f7f6f','font-size':10,'font-family':'system-ui'},label));}
  for(const c of chunks)for(const segment of c.segments){if(segment.length===1){svg.append(svgElement('circle',{cx:x(segment[0].x),cy:y(segment[0].y),r:2.5,fill:c.colour}));continue;}svg.append(svgElement('path',{d:segment.map((p,i)=>`${i?'L':'M'}${x(p.x).toFixed(2)},${y(p.y).toFixed(2)}`).join(' '),fill:'none',stroke:c.colour,'stroke-width':2,'stroke-linejoin':'round','stroke-linecap':'round'}));}
  container.append(svg);
}
function metric(id,dateId,series,quantity,unit){const row=latest(series,quantity);const node=$(id);node.replaceChildren(text('span',''));node.textContent=row?pretty(row[quantity]):'—';node.append(text('small',unit));$(dateId).textContent=row?time(row.at)+(row[quantity+'Symbol']?` · ${row[quantity+'Symbol']}`:''):'No recent value in this capture';}
function render(){
  const station=state.selected;if(!station)return;const entry=currentEntry();
  $('station-meta').textContent=`${station.province||'Canada'} / ${station.id} · ${station.status||'Source station'}`;
  $('station-title').textContent=titleCase(station.name);
  $('station-location').textContent=Array.isArray(station.coordinates)?`${Math.abs(station.coordinates[1]).toFixed(4)}° ${station.coordinates[1]>=0?'N':'S'}, ${Math.abs(station.coordinates[0]).toFixed(4)}° ${station.coordinates[0]>=0?'E':'W'} · ${station.contributor||'ECCC hydrometric network'}`:station.contributor||'ECCC hydrometric network';
  $('official').href=`https://wateroffice.ec.gc.ca/report/${station.realtime?'real_time':'historical'}_e.html?stn=${station.id}`;
  $('capture-label').textContent=entry?`Captured ${time(state.receipt.capturedAt)} · ${entry.series.reduce((n,s)=>n+s.observations.length,0).toLocaleString()} source records`:'Not loaded yet — fetch observations for this station';
  $('save-json').disabled=!entry;$('save-csv').disabled=!entry;
  const recent=entry?.series.find(s=>s.kind==='realtime');const history=entry?.series.filter(s=>s.kind==='daily')||[];
  metric('latest-level','level-date',recent,'level','m');metric('latest-discharge','discharge-date',recent,'discharge','m³/s');
  $('datum-note').textContent=`Datum: ${station.datum||'not supplied'}. Levels belong to this gauge.`;
  chart($('recent-chart'),recent?[recent]:[],'realtime',Boolean(entry));chart($('history-chart'),history,'daily',Boolean(entry));
  if(!entry){$('level-date').textContent='Not loaded yet';$('discharge-date').textContent='Not loaded yet';}
  const count=recent?.observations.filter(p=>finite(p[state.quantity])).length||0;
  $('recent-summary').textContent=!entry?'Selecting a station searches the catalogue only. No observations have been requested for this station.':count?`${count.toLocaleString()} ${state.quantity==='level'?'water-level':'discharge'} readings · time axis in UTC. Breaks indicate missing values or intervals longer than 2 hours. These are unit readings, not daily averages.`:'No recent series to display. A closed station or a missing measurement can still have historical data.';
  $('history-legend').replaceChildren(...history.map((s,i)=>{const e=text('span',`${s.label} · ${s.observations.filter(p=>finite(p[state.quantity])).length} days`);e.style.setProperty('--colour',colours[i%colours.length]);return e;}));
  $('history-summary').textContent=history.length?`Calendar-day alignment · ${history.map(s=>s.label).join(' / ')}. A daily mean averages the source's unit values for that day. Gaps are not zero; no baseline or flood threshold is inferred.`:'Select years and fetch the station to compare archived daily means.';
  $('source-links').replaceChildren(...(entry?.series||[]).map(s=>{const a=text('a',`${s.kind==='realtime'?'Recent observations':`Daily means · ${s.label}`} · retrieved ${time(s.retrievedAt||state.receipt.capturedAt)} ↗`);a.href=safeSource(s.source);return a;}));
  const previousValue=$('table-series').value;$('table-series').replaceChildren(...(entry?.series||[]).map((s,i)=>option(String(i),s.kind==='daily'?`${s.label} · daily means`:'Recent · unit readings')));
  if([...$('table-series').options].some(o=>o.value===previousValue))$('table-series').value=previousValue;
  renderTable();renderRevision();renderCoverage();updatePeriods();
}
function updatePeriods(){
  $('chosen-periods').textContent=`Past ${$('recent-days').value} days · years ${$('year-a').value} / ${$('year-b').value}`;
}
function renderCoverage(){
  const info=state.coverage.get(state.selected?.id);$('archive-button').disabled=false;$('use-archive-years').hidden=!info?.years.length;$('archive-sources').replaceChildren();
  if(!info){$('archive-summary').textContent=state.selected?.status==='Discontinued'?'This station is discontinued. Find its archive dates before choosing comparison years; the default years may be outside its record.':'Archive dates have not been checked. Find the source’s earliest and latest measured dates, then choose comparison years.';return;}
  $('archive-summary').textContent=info.count?`${info.count.toLocaleString()} days with at least one reported measurement · ${info.firstDate} to ${info.lastDate}. Gaps may occur; this does not mean both measurements exist on every day.`:'ECCC returned no daily archive rows with a reported water level or discharge. This is separate from recent-data availability.';
  if(info.years.length)$('use-archive-years').textContent=`Use available years: ${info.years.join(' & ')}`;
  $('archive-sources').append(...info.sources.map((url,i)=>{const a=text('a',i?'Latest measured dates ↗':'Earliest measured date ↗');a.href=url;return a;}));
  $('archive-sources').append(text('span',`Checked ${time(info.checkedAt)} · cached in this tab`));
}
$('archive-button').addEventListener('click',async()=>{
  if(!state.selected)return;state.archiveController?.abort();const controller=new AbortController();state.archiveController=controller;const stationId=state.selected.id,request=++state.archiveRequest;
  $('archive-button').disabled=true;$('archive-summary').textContent='Checking ECCC’s measured archive dates…';
  const timeout=setTimeout(()=>controller.abort(),90000);
  try{const info=await archiveLookup(stationId,controller.signal);if(request!==state.archiveRequest||state.selected.id!==stationId)return;state.coverage.set(stationId,info);renderCoverage();}
  catch(error){if(request===state.archiveRequest&&state.selected.id===stationId)$('archive-summary').textContent=error.name==='AbortError'?'Archive date request timed out or was cancelled. The displayed observations are unchanged.':`Could not check archive dates: ${error.message} The displayed observations are unchanged.`;}
  finally{clearTimeout(timeout);if(request===state.archiveRequest)$('archive-button').disabled=false;}
});
$('use-archive-years').addEventListener('click',()=>{
  const years=state.coverage.get(state.selected?.id)?.years;if(!years?.length)return;
  $('year-a').value=years[0];$('year-b').value=years[1]??years[0];updatePeriods();
  status(`Comparison years set to ${years.join(' and ')} from measured source records. Select Fetch this station to load them.`);
});
for(const id of ['recent-days','year-a','year-b'])$(id).addEventListener('input',updatePeriods);
function renderTable(){
  const series=currentEntry()?.series[Number($('table-series').value)||0];const rows=[...(series?.observations||[])].reverse();
  $('observation-rows').replaceChildren(...rows.slice(0,state.rows).map(p=>{const tr=document.createElement('tr');const symbols=[p.levelSymbol?`Level: ${p.levelSymbol}`:'',p.dischargeSymbol?`Flow: ${p.dischargeSymbol}`:''].filter(Boolean).join('; ')||'None supplied';tr.append(text('td',series.kind==='daily'?p.at:time(p.at)),text('td',pretty(p.level)),text('td',pretty(p.discharge)),text('td',symbols));return tr;}));
  $('table-count').textContent=`${Math.min(state.rows,rows.length).toLocaleString()} of ${rows.length.toLocaleString()} observations · newest first · — = missing`;$('more-rows').hidden=rows.length<=state.rows;
}
function updateCaptureOptions(selected=''){
  const list=[...state.memory.entries()].filter(([key])=>key.startsWith('tab:')).map(([key,r])=>({key,label:`This tab · ${time(r.capturedAt)} · ${r.stations.map(e=>e.station.id).join(', ')}`}));
  list.push(...state.index.captures.map(c=>({key:c.file,label:`${time(c.capturedAt)} · ${c.stationIds.join(', ')}`})));
  $('capture-select').replaceChildren(...list.map(c=>option(c.key,c.label)));
  if(selected)$('capture-select').value=selected;
  $('compare-select').replaceChildren(option('','Choose a capture'),...list.filter(c=>c.key!==selected).map(c=>option(c.key,c.label)));
  $('retention-note').textContent=`${state.index.captures.length} published capture${state.index.captures.length===1?'':'s'} retained. Scheduled daily; older captures are kept. Live fetches and imports stay in this tab until you download them.`;
}
async function loadCapture(key){
  if(state.memory.has(key))return state.memory.get(key);
  if(!/^captures\/[A-Za-z0-9-]+\.json$/.test(key))throw new Error('Invalid capture path.');
  const receipt=validateReceipt(await getJSON(`data/${key}`));state.memory.set(key,receipt);return receipt;
}
let comparisonSequence=0;
async function renderRevision(){
  const seq=++comparisonSequence,key=$('compare-select').value;$('revision-list').replaceChildren();
  if(!key){$('revision-status').textContent='Choose another capture to compare observations for the displayed station.';return;}
  try{
    const previous=await loadCapture(key);if(seq!==comparisonSequence)return;
    if(Date.parse(previous.capturedAt)>=Date.parse(state.receipt.capturedAt)){ $('revision-status').textContent='Choose a capture earlier than the displayed capture.';return; }
    const result=revisions(previous,state.receipt,state.selected.id);
    if(!result.comparable){$('revision-status').textContent='These captures have no overlapping observations for this station. No revision comparison is possible.';return;}
    $('revision-status').textContent=`${result.overlap.toLocaleString()} overlapping records · ${result.changed.length} changed value/qualifier pairs · ${result.added} newly captured records. Missing older dates are outside this comparison.`;
    $('revision-list').replaceChildren(...result.changed.slice(0,100).map(c=>text('p',`${c.at} · ${c.quantity}: ${c.before??'missing'} → ${c.after??'missing'} · qualifier ${c.beforeSymbol||'none'} → ${c.afterSymbol||'none'}`)));
    if(result.changed.length>100)$('revision-list').append(text('p','Showing 100 revisions. Export both receipts for the full record.'));
  }catch(error){if(seq===comparisonSequence)$('revision-status').textContent=`Comparison unavailable: ${error.message}`;}
}
function download(content,name,type){const link=document.createElement('a');const url=URL.createObjectURL(new Blob([content],{type}));link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
$('station-query').addEventListener('input',()=>{state.shown=25;renderStations();});$('province').addEventListener('change',()=>{state.shown=25;renderStations();});$('more-stations').addEventListener('click',()=>{state.shown+=50;renderStations();});
$('level-tab').addEventListener('click',()=>setQuantity('level'));$('discharge-tab').addEventListener('click',()=>setQuantity('discharge'));
function setQuantity(quantity){state.quantity=quantity;$('level-tab').setAttribute('aria-pressed',String(quantity==='level'));$('discharge-tab').setAttribute('aria-pressed',String(quantity==='discharge'));render();}
$('table-series').addEventListener('change',()=>{state.rows=100;renderTable();});$('more-rows').addEventListener('click',()=>{state.rows+=100;renderTable();});
$('save-json').addEventListener('click',()=>download(JSON.stringify({...state.receipt,stations:[currentEntry()]},null,2),`riverpulse-${state.selected.id}-${state.receipt.capturedAt.slice(0,10)}.json`,'application/json'));
$('save-csv').addEventListener('click',()=>download(toCSV(state.receipt,state.selected.id),`riverpulse-${state.selected.id}.csv`,'text/csv'));
$('cancel-button').addEventListener('click',()=>{state.controller?.abort();state.request++;setBusy(false);status('Request cancelled. The displayed capture is unchanged.');});
$('fetch-form').addEventListener('submit',async event=>{
  event.preventDefault();if(!state.selected)return;const years=[$('year-a').value,$('year-b').value].map(Number),days=Number($('recent-days').value);
  if(years.some(y=>!Number.isInteger(y)||y<1850||y>new Date().getUTCFullYear())){status('Choose years from 1850 through this year.',true);return;}
  state.controller?.abort();state.controller=new AbortController();const controller=state.controller;const request=++state.request;setBusy(true);status('Fetching recent observations and archived years from ECCC…');
  const timeout=setTimeout(()=>controller.abort(),150000);
  try{
    const receipt=validateReceipt(await fetchReceipt(state.catalogue.stations.find(s=>s.id===state.selected.id)||state.selected,years,days,state.config,controller.signal));if(request!==state.request)return;
    const key=`tab:${receipt.capturedAt}`;state.memory.set(key,receipt);state.receipt=receipt;state.rows=100;updateCaptureOptions(key);render();status('Source capture ready. Download the receipt to keep this live lookup.');
  }catch(error){if(request===state.request)status(error.name==='AbortError'?'The request timed out or was cancelled. Previous data is unchanged.':`${error.message} Previous data is unchanged. You can also open the official station page.`,true);}
  finally{clearTimeout(timeout);if(request===state.request)setBusy(false);}
});
$('capture-select').addEventListener('change',async()=>{
  const key=$('capture-select').value;state.controller?.abort();const request=++state.request;setBusy(false);
  try{const receipt=await loadCapture(key);if(request!==state.request)return;state.receipt=receipt;state.selected=(receipt.stations.find(e=>e.station.id===state.selected.id)||receipt.stations[0]).station;updateCaptureOptions(key);state.rows=100;renderStations();render();status('Retained capture opened. Observation dates are distinct from the capture date.');}catch(error){status(`Could not open capture: ${error.message}`,true);}
});
$('compare-select').addEventListener('change',renderRevision);
$('import-json').addEventListener('change',async event=>{
  const file=event.target.files[0];if(!file)return;
  try{if(file.size>15*1024*1024)throw new Error('Choose a receipt smaller than 15 MB.');const receipt=validateReceipt(JSON.parse(await file.text()));state.controller?.abort();state.request++;setBusy(false);const key=`tab:import-${Date.now()}`;state.memory.set(key,receipt);state.receipt=receipt;state.selected=receipt.stations[0].station;state.rows=100;updateCaptureOptions(key);renderStations();render();status('Imported receipt opened locally. It is not independently verified and has not been uploaded.');}catch(error){status(`Import failed: ${error.message} Previous data is unchanged.`,true);}event.target.value='';
});
async function init(){
  try{
    const [config,catalogue,index]=await Promise.all([getJSON('config.json'),getJSON('data/stations.json'),getJSON('data/index.json')]);state.config=config;state.catalogue=catalogue;state.index=index;
    $('catalogue-count').textContent=`${catalogue.stations.length.toLocaleString()} gauges`;
    $('province').append(...[...new Set(catalogue.stations.map(s=>s.province))].sort().map(p=>option(p,p)));
    $('recent-days').value=String(config.realtimeDays);if(!$('recent-days').value){$('recent-days').append(option(String(config.realtimeDays),`Past ${config.realtimeDays} days`));$('recent-days').value=String(config.realtimeDays);}
    $('year-a').value=config.historicalYears[0];$('year-b').value=config.historicalYears[1]||config.historicalYears[0]-1;for(const id of ['year-a','year-b'])$(id).max=String(new Date().getUTCFullYear());
    state.selected=catalogue.stations.find(s=>s.id===config.defaultStation)||catalogue.stations[0];
    if(index.captures.length)state.receipt=await loadCapture(index.captures[0].file);
    updateCaptureOptions(index.captures[0]?.file||'');renderStations();render();
    const age=state.receipt?(Date.now()-Date.parse(state.receipt.capturedAt))/86400000:Infinity;
    status(age>2?'This retained capture is over two days old. Fetch this station for a fresh lookup.':'Ready from retained source data. Search any station or change the years to explore.');
  }catch(error){status(`Could not load the retained data: ${error.message} Try reloading the page.`,true);}
}
init();
