from typing import Tuple
from types import SimpleNamespace
import time
import os
import json
import time
from typing import Optional
import kachery as ka
from ._temporarydirectory import TemporaryDirectory

def _api_port():
    return 20431

def get_swarms():
    port = _api_port()
    url = f'http://localhost:{port}/getState'
    resp = _http_post_json(url, dict())
    if not resp['success']:
        raise Exception(resp['error'])
    return resp['state']['swarms']

def join_swarm(swarm_name):
    port = _api_port()
    url = f'http://localhost:{port}/joinSwarm'
    resp = _http_post_json(url, dict(swarmName=swarm_name))
    if not resp['success']:
        raise Exception(resp['error'])

def leave_swarm(swarm_name):
    port = _api_port()
    url = f'http://localhost:{port}/leaveSwarm'
    resp = _http_post_json(url, dict(swarmName=swarm_name))
    if not resp['success']:
        raise Exception(resp['error'])

def find_file(path):
    port = _api_port()
    url = f'http://localhost:{port}/findFile'
    protocol, algorithm, hash0, additional_path = _parse_kachery_path(path)
    assert algorithm == 'sha1'
    file_key = dict(
        sha1=hash0
    )
    x = _http_post_json_receive_json_socket(url, dict(fileKey=file_key))
    def get_next():
        return x.get_next()
    return SimpleNamespace(
        get_next=get_next
    )

def _parse_kachery_path(url: str) -> Tuple[str, str, str, str]:
    list0 = url.split('/')
    protocol = list0[0].replace(':', '')
    hash0 = list0[2]
    if '.' in hash0:
        hash0 = hash0.split('.')[0]
    additional_path = '/'.join(list0[3:])
    algorithm = None
    for alg in ['sha1', 'md5', 'key']:
        if protocol.startswith(alg):
            algorithm = alg
    if algorithm is None:
        raise Exception('Unexpected protocol: {}'.format(protocol))
    return protocol, algorithm, hash0, additional_path

def load_file(path):
    results = find_file(path)
    if len(results) == 0:
        return None
    result0 = results[0]

    port = _api_port()
    url = f'http://localhost:{port}/downloadFile'
    with TemporaryDirectory() as tmpdir:
        fname = tmpdir + '/download.dat'
        _http_post_download_file(url, dict(swarmName=result0['swarmName'], nodeIdPath=result0['nodeIdPath'], kacheryPath=path), fname)
        with ka.config(use_hard_links=True):
            protocol, algorithm, expected_hash, additional_path = _parse_kachery_path(path)
            if algorithm == 'sha1':
                hash0 = ka.get_file_hash(fname)
                assert hash0 == expected_hash, f'Unexpected: hashes do not match: {expected_hash} <> {hash0}'
            ka.store_file(fname)
            return ka.load_file(path)

def _http_post_download_file(url: str, data: dict, dest_path: str):
    try:
        import requests
    except:
        raise Exception('Error importing requests *')

    with requests.post(url, json=data, stream=True) as r:
        r.raise_for_status()
        with open(dest_path, 'wb') as f:
            for chunk in r.iter_content(chunk_size=8192): 
                f.write(chunk)

def _http_post_json(url: str, data: dict, verbose: Optional[bool] = None) -> dict:
    timer = time.time()
    if verbose is None:
        verbose = (os.environ.get('HTTP_VERBOSE', '') == 'TRUE')
    if verbose:
        print('_http_post_json::: ' + url)
    try:
        import requests
    except:
        raise Exception('Error importing requests *')
    req = requests.post(url, json=data)
    if req.status_code != 200:
        return dict(
            success=False,
            error='Error posting json: {} {}'.format(
                req.status_code, req.content.decode('utf-8'))
        )
    if verbose:
        print('Elapsed time for _http_post_json: {}'.format(time.time() - timer))
    return json.loads(req.content)

def _http_post_json_receive_json_socket(url: str, data: dict, verbose: Optional[bool] = None):
    timer = time.time()
    if verbose is None:
        verbose = (os.environ.get('HTTP_VERBOSE', '') == 'TRUE')
    if verbose:
        print('_http_post_json::: ' + url)
    try:
        import requests
    except:
        raise Exception('Error importing requests *')
    req = requests.post(url, json=data, stream=True)
    if req.status_code != 200:
        return dict(
            success=False,
            error='Error posting json: {} {}'.format(
                req.status_code, req.content.decode('utf-8'))
        )
    def get_next():
        buf = bytearray(b'')
        while True:
            c = req.raw.read(1)
            if len(c) == 0:
                return None
            if c == b'#':
                size = int(buf)
                x = req.raw.read(size)
                obj = json.loads(x)
                return obj
            else:
                buf.append(c[0])
    return SimpleNamespace(
        get_next=get_next
    )

    if verbose:
        print('Elapsed time for _http_post_json: {}'.format(time.time() - timer))