import {API,COLLECTIONS,normalizeFeatures,sourceURL,safeSource,isStation,finite} from './model.mjs';
export async function getJSON(url, signal) {
  const response = await fetch(url, {signal,headers:{Accept:'application/json'}});
  if (!response.ok) throw new Error(`Source returned HTTP ${response.status}.`);
  return response.json();
}
export async function fetchSeries(kind, id, period, label, config, signal, fetcher = getJSON) {
  const source = sourceURL(kind,id,period,config.pageSize);
  let url = source, features = [], providerTimestamp = null;
  const seen = new Set();
  for (let page = 0; page < config.maxPages; page++) {
    if (seen.has(url)) throw new Error('Source pagination repeated a page.');
    seen.add(url);
    const payload = await fetcher(url, signal);
    if (payload?.type !== 'FeatureCollection' || !Array.isArray(payload.features)) throw new Error('Source response was not a GeoMet collection.');
    features.push(...payload.features);
    providerTimestamp = payload.timeStamp ?? providerTimestamp;
    const next = payload.links?.find(l => l.rel === 'next')?.href;
    if (!next) {
      if (Number.isInteger(payload.numberMatched) && features.length < payload.numberMatched) throw new Error('Source response was incomplete.');
      return {kind,label,period,source,providerTimestamp,retrievedAt:new Date().toISOString(),observations:normalizeFeatures(features,id,kind)};
    }
    if (!safeSource(next) || new URL(next).pathname !== `/collections/${COLLECTIONS[kind]}/items`) throw new Error('Unexpected next-page destination.');
    const target = new URL(next); target.searchParams.set('f','json'); url = target.href;
    await new Promise(resolve => setTimeout(resolve,config.requestGapSeconds*1000));
  }
  throw new Error('The configured page limit was reached. Try fewer recent days. Previous data is unchanged.');
}
export async function fetchReceipt(station, years, days, config, signal) {
  const now = new Date(), capturedAt = now.toISOString(), start = new Date(now.getTime()-days*86400000).toISOString();
  const series = [];
  // Sequential small queries avoid a burst against a public service.
  series.push(await fetchSeries('realtime',station.id,`${start}/${capturedAt}`,'Recent unit observations',config,signal));
  for (const year of [...new Set(years)]) series.push(await fetchSeries('daily',station.id,`${year}-01-01/${year}-12-31`,String(year),config,signal));
  if (!series.some(s => s.observations.length)) throw new Error('No observations were returned for these periods. Try earlier years or another station.');
  return {schemaVersion:1,tool:'riverpulse',capturedAt,provider:'Environment and Climate Change Canada · MSC GeoMet / HYDAT',units:{level:'m (station datum)',discharge:'m³/s'},requested:{realtimeDays:days,historicalYears:years},stations:[{station,series}]};
}

// At most two small requests. The non-null filter distinguishes measured days
// from HYDAT calendar rows whose water level and discharge are both missing.
export async function fetchArchiveCoverage(id, signal, fetcher = getJSON) {
  if (!isStation(id)) throw new Error('Choose a valid ECCC station.');
  const source = (sort, limit) => {
    const url = new URL(`${API}/collections/${COLLECTIONS.daily}/items`);
    url.search = new URLSearchParams({f:'json',STATION_NUMBER:id,limit:String(limit),sortby:sort,filter:'properties.LEVEL IS NOT NULL OR properties.DISCHARGE IS NOT NULL'});
    return url.href;
  };
  const read = async (url, limit) => {
    const data = await fetcher(url, signal);
    if (data?.type !== 'FeatureCollection' || !Array.isArray(data.features) || data.features.length > limit || !Number.isInteger(data.numberMatched) || data.numberMatched < data.features.length) throw new Error('Archive date response was incomplete or unrecognized.');
    const rows = normalizeFeatures(data.features,id,'daily');
    if (rows.some(p=>!finite(p.level)&&!finite(p.discharge))) throw new Error('The source did not apply the measured-value filter.');
    if (data.numberMatched > 0 && !rows.length) throw new Error('Archive date response was incomplete.');
    return {rows,count:data.numberMatched};
  };
  const firstSource=source('DATE',1), first=await read(firstSource,1);
  if (!first.count) return {stationId:id,count:0,firstDate:null,lastDate:null,years:[],sources:[firstSource],checkedAt:new Date().toISOString()};
  // A calendar year has at most 366 dates: 367 measured rows find a second
  // represented year if one exists, even when whole intervening years are absent.
  const lastSource=source('-DATE',367), last=await read(lastSource,367);
  if (!last.rows.length || first.rows[0].at > last.rows.at(-1).at) throw new Error('Archive dates changed unexpectedly. Try again.');
  const years=[...new Set([...last.rows].reverse().map(p=>Number(p.at.slice(0,4))))].slice(0,2);
  return {stationId:id,count:last.count,firstDate:first.rows[0].at,lastDate:last.rows.at(-1).at,years,sources:[firstSource,lastSource],checkedAt:new Date().toISOString()};
}
export function createArchiveLookup(fetcher = getJSON) {
  const cache = new Map();
  return async (id,signal) => {
    if (cache.has(id)) return cache.get(id);
    const result=await fetchArchiveCoverage(id,signal,fetcher);
    cache.set(id,result);
    return result;
  };
}
