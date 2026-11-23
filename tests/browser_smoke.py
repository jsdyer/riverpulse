"""CI-only browser regression checks at a GitHub Pages project subpath."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json
import shutil
import tempfile
import threading
from playwright.sync_api import sync_playwright, expect
ROOT = Path(__file__).resolve().parents[1]


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def main():
    screenshots=ROOT/'browser-checks';screenshots.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory() as temporary:
        shutil.copytree(ROOT/'dist',Path(temporary)/'riverpulse')
        server=ThreadingHTTPServer(('127.0.0.1',0),partial(QuietHandler,directory=temporary))
        threading.Thread(target=server.serve_forever,daemon=True).start()
        try:
            with sync_playwright() as p:
                browser=p.chromium.launch();page=browser.new_page(viewport={'width':1440,'height':1050})
                errors=[];dialogs=[];page.on('pageerror',lambda e:errors.append(str(e)))
                def reject_dialog(dialog):
                    dialogs.append(dialog.message)
                    dialog.dismiss()
                page.on('dialog',reject_dialog)
                page.route('**/assets/tool-metrics.js',lambda r:r.fulfill(status=200,content_type='text/javascript',body=''))
                page.goto(f'http://127.0.0.1:{server.server_port}/riverpulse/')
                expect(page.locator('#station-title')).to_contain_text('Nicomekl')
                expect(page.locator('#recent-chart svg')).to_have_count(1)
                expect(page.locator('#history-chart svg')).to_have_count(1)
                expect(page.locator('#observation-rows tr')).to_have_count(100)
                page.locator('#level-tab').click();expect(page.locator('#level-tab')).to_have_attribute('aria-pressed','true')
                page.locator('#station-query').fill('01EJ001');page.locator('.station-choice').click()
                expect(page.locator('#station-title')).to_contain_text('Sackville')
                with page.expect_download() as download:page.locator('#save-json').click()
                saved=json.loads(Path(download.value.path()).read_text());assert saved['stations'][0]['station']['id']=='01EJ001'
                # Failed source lookup keeps the displayed capture and source values.
                page.route('https://api.weather.gc.ca/**',lambda r:r.fulfill(status=503,content_type='application/json',body='{}'))
                old=page.locator('#capture-label').inner_text();page.locator('#fetch-button').click()
                expect(page.locator('#status')).to_contain_text('Previous data is unchanged')
                assert page.locator('#capture-label').inner_text()==old
                # An arbitrary catalogue station succeeds through the live-query path.
                page.unroute('https://api.weather.gc.ca/**')
                def mock_source(route):
                    from urllib.parse import parse_qs, urlsplit
                    query=parse_qs(urlsplit(route.request.url).query)
                    station=query['STATION_NUMBER'][0]
                    realtime='hydrometric-realtime' in route.request.url
                    date='2026-11-23T08:00:00Z' if realtime else query['datetime'][0].split('/')[0]
                    properties={'STATION_NUMBER':station,'LEVEL':0,'DISCHARGE':2,'LEVEL_SYMBOL_EN':'Estimated'}
                    properties['DATETIME' if realtime else 'DATE']=date
                    route.fulfill(status=200,content_type='application/json',body=json.dumps({'type':'FeatureCollection','numberMatched':1,'features':[{'properties':properties}]}))
                page.route('https://api.weather.gc.ca/**',mock_source)
                page.locator('#station-query').fill('01EJ004');page.locator('.station-choice').click()
                page.locator('#fetch-button').click();expect(page.locator('#status')).to_contain_text('Source capture ready')
                expect(page.locator('#station-title')).to_contain_text('Little Sackville')
                expect(page.locator('#observation-rows tr')).to_have_count(1)
                # Closed-gauge discovery distinguishes not-yet-loaded from missing data.
                page.unroute('https://api.weather.gc.ca/**')
                archive_calls=[]
                def mock_closed_gauge(route):
                    from urllib.parse import parse_qs, urlsplit
                    query=parse_qs(urlsplit(route.request.url).query)
                    station=query['STATION_NUMBER'][0]
                    if 'filter' in query:
                        archive_calls.append(route.request.url)
                        dates=['1916-03-27'] if query['sortby'][0]=='DATE' else ['1917-01-13','1916-12-31']
                        features=[{'properties':{'STATION_NUMBER':station,'DATE':d,'LEVEL':None,'DISCHARGE':5.8}} for d in dates]
                        count=290
                    elif 'hydrometric-realtime' in route.request.url:
                        features=[];count=0
                    else:
                        year=query['datetime'][0][:4]
                        date='1917-01-13' if year=='1917' else '1916-03-27'
                        features=[{'properties':{'STATION_NUMBER':station,'DATE':date,'LEVEL':None,'DISCHARGE':5.8}}];count=1
                    route.fulfill(status=200,content_type='application/json',body=json.dumps({'type':'FeatureCollection','numberMatched':count,'features':features}))
                page.route('https://api.weather.gc.ca/**',mock_closed_gauge)
                page.locator('#station-query').fill('01EG001');page.locator('.station-choice').click()
                expect(page.locator('#history-chart')).to_contain_text('Not loaded yet')
                expect(page.locator('#recent-chart')).not_to_contain_text('No recent values')
                expect(page.locator('#archive-summary')).to_contain_text('discontinued')
                expect(page.locator('#fetch-top')).to_be_visible()
                page.locator('#archive-button').click()
                expect(page.locator('#archive-summary')).to_contain_text('1916-03-27 to 1917-01-13')
                page.locator('#archive-button').click()
                expect(page.locator('#archive-summary')).to_contain_text('290 days')
                assert len(archive_calls)==2
                page.locator('#use-archive-years').click()
                expect(page.locator('#year-a')).to_have_value('1917');expect(page.locator('#year-b')).to_have_value('1916')
                expect(page.locator('#history-chart')).to_contain_text('Not loaded yet')
                page.locator('#discharge-tab').click();page.locator('#fetch-top').click()
                expect(page.locator('#status')).to_contain_text('Source capture ready')
                expect(page.locator('#history-chart svg')).to_have_count(1)
                expect(page.locator('#recent-chart')).to_contain_text('No recent values')
                # Imported markup is text, not HTML; malformed import does not erase data.
                saved['stations'][0]['station']['name']='<img src=x onerror=alert(1)>'
                page.locator('#import-json').set_input_files({'name':'receipt.json','mimeType':'application/json','buffer':json.dumps(saved).encode()})
                expect(page.locator('#station-title')).to_contain_text('<img')
                assert page.locator('#station-title img').count()==0
                assert not dialogs,dialogs
                page.locator('#import-json').set_input_files({'name':'invalid.json','mimeType':'application/json','buffer':b'{}'})
                expect(page.locator('#status')).to_contain_text('Import failed')
                # Restore public capture for screenshots.
                public_capture=json.loads((ROOT/'dist/data/index.json').read_text())['captures'][0]['file']
                page.locator('#capture-select').select_option(value=public_capture)
                expect(page.locator('#station-title')).to_contain_text('Sackville')
                page.screenshot(path=str(screenshots/'desktop.png'),full_page=True)
                page.set_viewport_size({'width':390,'height':844})
                assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
                page.screenshot(path=str(screenshots/'mobile.png'),full_page=True)
                assert not errors,errors
                assert not dialogs,dialogs
                browser.close()
            print('Browser checks passed: retained data, station search, charts, export/import, failed-request preservation, safe text and mobile layout')
        finally:server.shutdown()


if __name__=='__main__':main()
