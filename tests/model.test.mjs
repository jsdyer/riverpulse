import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {isStation,stationQuery,normalizeFeatures,sourceURL,validateReceipt,seriesSegments,seasonalX,revisions,toCSV,safeSource} from '../web/model.mjs';
import {fetchSeries} from '../web/service.mjs';
const source=sourceURL('daily','01EJ001','2024-01-01/2024-12-31');
const row=(at,level=1,discharge=2)=>({at,level,discharge,levelSymbol:null,dischargeSymbol:null});
const receipt=(rows,capturedAt='2026-11-23T08:00:00Z')=>({schemaVersion:1,tool:'riverpulse',capturedAt,stations:[{station:{id:'01EJ001',name:'Sackville',province:'NS'},series:[{kind:'daily',label:'2024',source,observations:rows}]}]});
const feature=(at,value=1,id='01EJ001')=>({properties:{STATION_NUMBER:id,DATE:at,LEVEL:value,DISCHARGE:null,LEVEL_SYMBOL_EN:'Estimated'}});
test('finds arbitrary stations and source auxiliary IDs without a hardcoded whitelist',()=>{
  assert.ok(isStation('08HDX03'));assert.ok(!isStation('../main'));
  assert.deepEqual(stationQuery([{id:'01EJ001',name:'SACKVILLE RIVER',province:'NS'},{id:'08MF005',name:'FRASER',province:'BC'}],'sack','NS').map(s=>s.id),['01EJ001']);
});
test('normalizes source fields, qualifiers, nulls and order',()=>{
  const got=normalizeFeatures([feature('2024-01-02',null),feature('2024-01-01',0)],'01EJ001','daily');
  assert.equal(got[0].level,0);assert.equal(got[1].level,null);assert.equal(got[0].levelSymbol,'Estimated');
  assert.throws(()=>normalizeFeatures([feature('2024-01-01',3,'08MF005')],'01EJ001','daily'),/different station/);
  assert.throws(()=>normalizeFeatures([feature('2024-01-01',3),feature('2024-01-01',4)],'01EJ001','daily'),/Conflicting/);
});
test('safe pagination follows only expected ECCC collection and refuses truncation',async()=>{
  let calls=0;
  const config={pageSize:100,maxPages:2,requestGapSeconds:0};
  const result=await fetchSeries('daily','01EJ001','2024-01-01/2024-12-31','2024',config,null,async()=>++calls===1?{type:'FeatureCollection',features:[feature('2024-01-01')],numberMatched:2,links:[{rel:'next',href:source+'&offset=1'}]}:{type:'FeatureCollection',features:[feature('2024-01-02')],numberMatched:2,links:[]});
  assert.equal(result.observations.length,2);
  await assert.rejects(()=>fetchSeries('daily','01EJ001','2024-01-01/2024-12-31','2024',config,null,async()=>({type:'FeatureCollection',features:[],numberMatched:2,links:[]})),/incomplete/);
  await assert.rejects(()=>fetchSeries('daily','01EJ001','2024-01-01/2024-12-31','2024',config,null,async()=>({type:'FeatureCollection',features:[],links:[{rel:'next',href:'https://example.com/steal'}]})),/Unexpected/);
});
test('source URL uses constrained ID and supported collection',()=>{
  assert.equal(new URL(source).searchParams.get('STATION_NUMBER'),'01EJ001');
  assert.equal(safeSource('javascript:alert(1)'),null);assert.equal(safeSource('https://api.weather.gc.ca.evil.example/collections/hydrometric-daily-mean/items'),null);
  assert.throws(()=>sourceURL('daily','../../x','2024'));
});
test('gaps remain missing and seasonal alignment keeps leap day',()=>{
  const p=[row('2024-01-01',1),row('2024-01-02',null),row('2024-01-03',0),row('2024-01-06',2)];
  assert.deepEqual(seriesSegments(p,'level','daily').map(s=>s.length),[1,1,1]);
  assert.equal(seasonalX('2024-03-01'),seasonalX('2023-03-01'));assert.equal(seasonalX('2024-03-01')-seasonalX('2024-02-29'),86400000);
});
test('revision detection counts only overlap and includes changed qualifiers',()=>{
  const before=receipt([row('2024-01-01',1),row('2024-01-02',2)]);
  const after=receipt([{...row('2024-01-01',1),levelSymbol:'Estimated'},row('2024-01-03',4)]);
  const result=revisions(before,after,'01EJ001');assert.equal(result.overlap,1);assert.equal(result.added,1);assert.equal(result.changed.length,1);assert.equal(result.changed[0].before,1);
  assert.equal(revisions(before,after,'08MF005').comparable,false);
});
test('imports validate schema, provenance, numeric values and duplicate dates',()=>{
  assert.equal(validateReceipt(receipt([row('2024-01-01')])).tool,'riverpulse');
  assert.throws(()=>validateReceipt(receipt([row('2024-01-01',NaN)])));
  assert.throws(()=>validateReceipt(receipt([row('2024-01-01'),row('2024-01-01')])));
  const r=receipt([row('2024-01-01')]);r.stations[0].series[0].source='https://evil.example';assert.throws(()=>validateReceipt(r));
});
test('CSV preserves zero, null, provenance and escapes spreadsheet formulas',()=>{
  const r=receipt([row('2024-01-01',0,null)]);r.stations[0].station.name='=HYPERLINK("bad")';const csv=toCSV(r,'01EJ001');
  assert.ok(csv.includes('"0",""'));assert.ok(csv.includes("\"'=HYPERLINK"));assert.ok(csv.includes('source_retrieved_at'));assert.ok(csv.includes('https://api.weather.gc.ca'));
});
test('all genuine shipped captures validate and initial BC/NS history is populated',()=>{
  const index=JSON.parse(fs.readFileSync(new URL('../web/data/index.json',import.meta.url)));
  for(const item of index.captures)validateReceipt(JSON.parse(fs.readFileSync(new URL('../web/data/'+item.file,import.meta.url))));
  const initial=JSON.parse(fs.readFileSync(new URL('../web/data/'+index.captures.at(-1).file,import.meta.url)));assert.ok(initial.stations.some(e=>e.station.province==='BC'));assert.ok(initial.stations.some(e=>e.station.province==='NS'));assert.ok(initial.stations.some(e=>e.series.some(s=>s.kind==='daily'&&s.observations.length>300)));
});
