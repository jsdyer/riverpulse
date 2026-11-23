export const API = 'https://api.weather.gc.ca';
export const COLLECTIONS = Object.freeze({stations:'hydrometric-stations', realtime:'hydrometric-realtime', daily:'hydrometric-daily-mean'});
export const isStation = s => typeof s === 'string' && /^\d{2}[A-Z]{2}[A-Z\d]{3}$/.test(s);
export const finite = v => typeof v === 'number' && Number.isFinite(v);
export const pretty = v => finite(v) ? new Intl.NumberFormat('en-CA', {maximumFractionDigits:3}).format(v) : '—';
export function stationQuery(stations, query, province = '') {
  const q = String(query).trim().toUpperCase();
  return stations.filter(s => (!province || s.province === province) && (!q || `${s.id} ${s.name}`.toUpperCase().includes(q)));
}
export function normalizeFeatures(features, id, kind) {
  const found = new Map();
  for (const f of features) {
    const p = f.properties;
    if (!p || p.STATION_NUMBER !== id) throw new Error('The source returned a different station.');
    const at = kind === 'realtime' ? p.DATETIME : p.DATE;
    if (!validDate(at, kind)) throw new Error('The source returned an invalid date.');
    for (const key of ['LEVEL','DISCHARGE']) if (p[key] != null && !finite(p[key])) throw new Error('Invalid source measurement.');
    const point = {at, level:p.LEVEL ?? null, discharge:p.DISCHARGE ?? null, levelSymbol:p.LEVEL_SYMBOL_EN ?? null, dischargeSymbol:p.DISCHARGE_SYMBOL_EN ?? null};
    if (kind === 'realtime') point.localAt = p.DATETIME_LST ?? null;
    if (found.has(at) && JSON.stringify(found.get(at)) !== JSON.stringify(point)) throw new Error('Conflicting source observations.');
    found.set(at, point);
  }
  return [...found.values()].sort((a,b) => a.at.localeCompare(b.at));
}
export function validDate(at, kind = 'realtime') {
  return typeof at === 'string' && (kind === 'daily' ? /^\d{4}-\d{2}-\d{2}$/.test(at) : /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(at)) && Number.isFinite(Date.parse(at));
}
export function sourceURL(kind, id, period, pageSize = 3000) {
  if (!COLLECTIONS[kind] || kind === 'stations' || !isStation(id)) throw new Error('Choose a valid ECCC station.');
  const url = new URL(`${API}/collections/${COLLECTIONS[kind]}/items`);
  url.search = new URLSearchParams({f:'json',limit:String(pageSize),STATION_NUMBER:id,datetime:period,sortby:kind === 'realtime' ? 'DATETIME' : 'DATE'});
  return url.href;
}
export function safeSource(value) {
  try { const u = new URL(value); return u.origin === API && Object.values(COLLECTIONS).some(c => u.pathname === `/collections/${c}/items`) && !u.username && !u.password ? u.href : null; } catch { return null; }
}
export function validateReceipt(input) {
  if (!input || input.schemaVersion !== 1 || input.tool !== 'riverpulse' || !validDate(input.capturedAt) || !Array.isArray(input.stations) || !input.stations.length || input.stations.length > 100) throw new Error('This is not a River Pulse receipt (schema 1).');
  let count = 0;
  const ids = new Set();
  for (const entry of input.stations) {
    const s = entry.station;
    if (!s || !isStation(s.id) || ids.has(s.id) || typeof s.name !== 'string' || s.name.length > 300 || !Array.isArray(entry.series) || entry.series.length > 6) throw new Error('Receipt contains invalid station data.');
    if (s.coordinates != null && (!Array.isArray(s.coordinates) || s.coordinates.length < 2 || !finite(s.coordinates[0]) || !finite(s.coordinates[1]) || Math.abs(s.coordinates[0]) > 180 || Math.abs(s.coordinates[1]) > 90)) throw new Error('Invalid station coordinates.');
    ids.add(s.id);
    for (const series of entry.series) {
      if (!['realtime','daily'].includes(series.kind) || typeof series.label !== 'string' || series.label.length > 100 || !safeSource(series.source) || !Array.isArray(series.observations) || series.observations.length > 40000) throw new Error('Receipt contains invalid series or provenance.');
      const dates = new Set();
      for (const p of series.observations) {
        if (!validDate(p.at, series.kind) || dates.has(p.at) || ['level','discharge'].some(k => p[k] !== null && !finite(p[k])) || ['levelSymbol','dischargeSymbol'].some(k => p[k] != null && (typeof p[k] !== 'string' || p[k].length > 300))) throw new Error('Receipt contains invalid or duplicate measurements.');
        dates.add(p.at);
        if (++count > 200000) throw new Error('Receipt exceeds 200,000 observations.');
      }
    }
  }
  return input;
}
export function latest(series, quantity) {
  return [...(series?.observations || [])].sort((a,b)=>b.at.localeCompare(a.at)).find(p => finite(p[quantity])) || null;
}
export function seasonalX(at) { return Date.parse(`2000-${at.slice(5,10)}T00:00:00Z`); }
export function seriesSegments(points, quantity, kind) {
  const segments = []; let part = [], previous = null;
  for (const point of [...points].sort((a,b)=>a.at.localeCompare(b.at))) {
    const time = Date.parse(point.at);
    if (!finite(point[quantity]) || (previous !== null && time - previous > (kind === 'daily' ? 36*3600000 : 2*3600000))) {
      if (part.length) segments.push(part);
      part = [];
    }
    if (finite(point[quantity])) part.push({x:kind === 'daily' ? seasonalX(point.at) : time, y:point[quantity], at:point.at});
    previous = time;
  }
  if (part.length) segments.push(part);
  return segments;
}
export function revisions(previous, current, stationId) {
  const oldStation = previous?.stations.find(e => e.station.id === stationId);
  const nextStation = current?.stations.find(e => e.station.id === stationId);
  if (!oldStation || !nextStation) return {comparable:false,changed:[],overlap:0,added:0};
  const old = new Map();
  for (const series of oldStation.series) for (const row of series.observations) old.set(`${series.kind}|${row.at}`,row);
  const changed = []; let overlap = 0, added = 0;
  for (const series of nextStation.series) for (const row of series.observations) {
    const before = old.get(`${series.kind}|${row.at}`);
    if (!before) { added++; continue; }
    overlap++;
    for (const quantity of ['level','discharge']) {
      if (before[quantity] !== row[quantity] || before[quantity+'Symbol'] !== row[quantity+'Symbol']) changed.push({kind:series.kind,at:row.at,quantity,before:before[quantity],after:row[quantity],beforeSymbol:before[quantity+'Symbol'],afterSymbol:row[quantity+'Symbol']});
    }
  }
  return {comparable:overlap > 0,changed,overlap,added};
}
export function toCSV(receipt, stationId) {
  const fields = ['station_id','station_name','province','captured_at','series','observed_at','source_local_timestamp','source_retrieved_at','water_level_m','discharge_m3_s','water_level_qualifier','discharge_qualifier','source'];
  const escape = v => { let value=String(v ?? ''); if(typeof v === 'string' && /^[\s]*[=+@-]/.test(value))value="'"+value; return '"'+value.replaceAll('"','""')+'"'; };
  const rows = [fields];
  for (const e of receipt.stations.filter(e => !stationId || e.station.id === stationId)) for (const s of e.series) for (const p of s.observations) rows.push([e.station.id,e.station.name,e.station.province,receipt.capturedAt,s.kind,p.at,p.localAt,s.retrievedAt||receipt.capturedAt,p.level,p.discharge,p.levelSymbol,p.dischargeSymbol,s.source]);
  return rows.map(row => row.map(escape).join(',')).join('\r\n');
}
