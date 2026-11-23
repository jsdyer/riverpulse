import {API,COLLECTIONS,normalizeFeatures,sourceURL,safeSource} from './model.mjs';
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
