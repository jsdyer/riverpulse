import copy
import hashlib
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import refresh as collector

ROOT = Path(__file__).resolve().parents[1]


def feature(date='2024-01-01', station='01EJ001', value=2):
    return {'properties': {'STATION_NUMBER': station, 'DATE': date, 'LEVEL': value, 'DISCHARGE': None, 'LEVEL_SYMBOL_EN': 'Estimated'}}


class CollectorTests(unittest.TestCase):
    def setUp(self):
        self.config = json.loads((ROOT / 'web/config.json').read_text())
        self.config['requestGapSeconds'] = 0

    def test_complete_pagination_and_source_bounds(self):
        pages = iter([
            {'type':'FeatureCollection','features':[feature()], 'numberMatched':2, 'links':[{'rel':'next','href':collector.BASE+'/collections/hydrometric-daily-mean/items?offset=1'}]},
            {'type':'FeatureCollection','features':[feature('2024-01-02')], 'numberMatched':2, 'links':[]}
        ])
        rows, source, stamp = collector.collect('hydrometric-daily-mean',{'STATION_NUMBER':'01EJ001'}, self.config, lambda url:next(pages))
        self.assertEqual(len(rows),2)
        self.assertIn('STATION_NUMBER=01EJ001',source)
        with self.assertRaisesRegex(ValueError,'pagination destination'):
            collector.next_url('https://example.com/?key=x','hydrometric-daily-mean')
        with self.assertRaisesRegex(ValueError,'Incomplete'):
            collector.collect('hydrometric-daily-mean',{},self.config,lambda url:{'type':'FeatureCollection','features':[],'numberMatched':10})

    def test_null_and_qualifier_preservation_and_wrong_station(self):
        rows=collector.observations([feature(value=0),feature('2024-01-02',value=None)],'01EJ001','daily')
        self.assertEqual(rows[0]['level'],0)
        self.assertIsNone(rows[1]['level'])
        self.assertEqual(rows[0]['levelSymbol'],'Estimated')
        with self.assertRaisesRegex(ValueError,'different station'):
            collector.observations([feature(station='08MF005')],'01EJ001','daily')

    def test_config_rejects_unsupported_provider_and_duplicate_stations(self):
        self.assertEqual(collector.validate_config(self.config),self.config)
        bad=copy.deepcopy(self.config);bad['sources']['base']='https://example.com'
        with self.assertRaises(ValueError):collector.validate_config(bad)
        bad=copy.deepcopy(self.config);bad['stationIds']=['01EJ001','01EJ001']
        with self.assertRaises(ValueError):collector.validate_config(bad)

    def test_source_auxiliary_station_ids_are_kept(self):
        self.assertTrue(collector.STATION.fullmatch('08HDX03'))

    def test_failed_network_preserves_existing_index_and_captures(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);shutil.copytree(ROOT/'web',root/'web')
            before={str(p.relative_to(root)):p.read_bytes() for p in (root/'web/data').rglob('*.json')}
            def fail(url):raise OSError('source unavailable')
            with self.assertRaisesRegex(OSError,'unavailable'):
                collector.refresh(root,fetch=fail)
            after={str(p.relative_to(root)):p.read_bytes() for p in (root/'web/data').rglob('*.json')}
            self.assertEqual(before,after)

    def test_historical_cache_avoids_unnecessary_queries(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);shutil.copytree(ROOT/'web',root/'web')
            index=json.loads((root/'web/data/index.json').read_text())
            initial=json.loads((root/'web/data'/index['captures'][0]['file']).read_text())
            test_config=json.loads((root/'web/config.json').read_text())
            test_config['stationIds']=[e['station']['id'] for e in initial['stations']]
            test_config['defaultStation']=test_config['stationIds'][0]
            test_config['historicalYears']=[int(s['label']) for s in initial['stations'][0]['series'] if s['kind']=='daily']
            test_config['requestGapSeconds']=0
            (root/'web/config.json').write_text(json.dumps(test_config))
            fetched=[]
            def fake(url):
                from urllib.parse import parse_qs,urlsplit
                fetched.append(url);self.assertIn('/hydrometric-realtime/',url)
                station=parse_qs(urlsplit(url).query)['STATION_NUMBER'][0]
                return {'type':'FeatureCollection','numberMatched':1,'features':[{'properties':{'STATION_NUMBER':station,'DATETIME':'2026-11-23T08:00:00Z','DATETIME_LST':'2026-11-23T00:00:00-08:00','LEVEL':1,'DISCHARGE':2}}]}
            # Hold the receipt clock close to the fixture, independent of when CI runs.
            with patch.object(collector,'now_iso',return_value=initial['capturedAt']):
                collector.refresh(root,fetch=fake)
            self.assertEqual(len(fetched),len(initial['stations']))
            index=json.loads((root/'web/data/index.json').read_text())
            latest=json.loads((root/'web/data'/index['captures'][0]['file']).read_text())
            self.assertEqual(latest['stations'][0]['series'][1]['retrievedAt'],initial['stations'][0]['series'][1]['retrievedAt'])
            self.assertGreaterEqual(len(index['captures']),2)

    def test_retained_files_match_manifest_and_have_real_source_metadata(self):
        index=json.loads((ROOT/'web/data/index.json').read_text())
        for entry in index['captures']:
            raw=(ROOT/'web/data'/entry['file']).read_bytes()
            self.assertEqual(hashlib.sha256(raw).hexdigest(),entry['sha256'])
            capture=json.loads(raw)
            self.assertTrue(capture['stations'])
            for station in capture['stations']:
                self.assertTrue(station['station']['contributor'])
                for series in station['series']:
                    self.assertIn('api.weather.gc.ca/collections/',series['source'])
                    self.assertTrue(series['retrievedAt'])


if __name__ == '__main__':unittest.main()
