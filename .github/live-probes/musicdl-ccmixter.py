# Temporary live probe: run the supplied musicdl classes, not a reimplementation.
import os, sys, subprocess, shutil
sys.path.insert(0, '/tmp/musicdl-resource')
from musicdl.modules.sources.ccmixter import CCMixterMusicClient

def note(value):
    print(f'::notice title=musicdl ccMixter live::{value}', flush=True)

try:
    client = CCMixterMusicClient(search_size_per_source=5, search_size_per_page=5,
                                disable_print=True, max_retries=1, work_dir='/tmp/musicdl-output')
    # Run its actual title-search URL constructor and result parser as written.
    search_url = client._constructsearchurls('Stay snowflake')[0]
    response = client.get(search_url, timeout=20)
    response.raise_for_status()
    search_results = client._formatsearchresults(response.text)
    relevant = any('stay' in (item.get('title') or '').lower() and
                   'snowflake' in (item.get('creator') or '').lower() for item in search_results)
    note(f'actual title search returned {len(search_results)} results; exact sample relevant={relevant}')

    # Separately test actual parsing, media resolution and full download using a
    # known CC BY 3.0 sample, even if the upstream title search is irrelevant.
    response = client.get('https://ccmixter.org/api/query?f=xspf&ids=30378', timeout=20)
    response.raise_for_status()
    rows = client._formatsearchresults(response.text)
    item = next(row for row in rows if row.get('identifier') == '30378')
    info = client.get('https://ccmixter.org/api/query', params={'f': 'json', 'dataview': 'info', 'ids': '30378'}, timeout=20).json()[0]
    assert '/licenses/by/3.0/' in info.get('license_url', '')
    song = client._parsewithofficialapiv1(item, lossless_quality_is_sufficient=False)
    assert song.with_valid_download_url and song.ext == 'mp3'
    song.work_dir = '/tmp/musicdl-output'
    completed = client.download([song], num_threadings=1, request_overrides={'timeout': 45}, auto_supplement_song=False)
    assert len(completed) == 1 and os.path.getsize(completed[0].save_path) == 3285204
    subprocess.run([os.environ['FFMPEG_PATH'], '-v', 'error', '-i', completed[0].save_path,
                    '-map', '0:a:0', '-f', 'null', '-'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120)
    note('actual ccMixter resolver and downloader completed; all 3,285,204 bytes fully decoded')
except Exception as error:
    # Upstream exceptions may embed URLs; report only their class.
    note(f'probe failed safely ({type(error).__name__})')
    sys.exit(1)
finally:
    shutil.rmtree('/tmp/musicdl-output', ignore_errors=True)
