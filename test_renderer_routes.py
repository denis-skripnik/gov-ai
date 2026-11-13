"""Real saved-report routes, disposable fixtures; no provider/API calls."""
import json
import os
from pathlib import Path
import socket
import subprocess
import time
from html.parser import HTMLParser
from urllib.parse import quote
from urllib.request import urlopen

import pytest

PAYLOAD = '</title></code></pre><img src=x onerror="attack"><svg onload="attack"> & Привет " \' <script>attack</script>'
CLASS_PAYLOAD = '" onclick="attack" data-injected="yes'


class Document(HTMLParser):
    def __init__(self, source):
        super().__init__(convert_charrefs=True)
        self.nodes = []
        self.text = ''
        self.feed(source)

    def handle_starttag(self, tag, attrs):
        self.nodes.append((tag, dict(attrs)))

    def handle_data(self, data):
        self.text += data

    def matching(self, tag, **attrs):
        return [a for t, a in self.nodes if t == tag and all(a.get(k) == v for k, v in attrs.items())]

    def safe(self):
        assert not any(t in {'img', 'svg', 'script', 'iframe', 'object', 'embed'} for t, _ in self.nodes), 'injected element'
        for tag, attrs in self.nodes:
            for key, value in attrs.items():
                if key.startswith('on'):
                    assert tag == 'button' and key == 'onclick' and value == "this.nextElementSibling.classList.toggle('expanded')", 'injected event attribute'
                assert key != 'data-injected'
                if key == 'href':
                    assert value.startswith(('http://', 'https://', '/', '#')) and not value.startswith('//'), repr(value)
            if attrs.get('class') == 'progress-fill':
                style = attrs['style']
                assert style.startswith('width: ') and style.endswith('%')
                assert 0 <= float(style[7:-1]) <= 100


def report(p):
    return {
        'input': {'url': p, 'source_type': p, 'prompt_used': {'prompt_used_summary': p, 'prompt_used_excerpt': p + 'x' * 600, 'model': p}},
        'extracted': {'title': p, 'body': p, 'options': [p], 'metadata': {'key': p}, 'current_results': {'status': p, 'votes': {p: p}, 'voteStats': [{'type': p, 'votesCount': p, 'votersCount': p, 'percent': 20}]}},
        'analysis': dict(summary=p, **{k: [p] for k in ['key_changes', 'risks', 'benefits', 'unknowns', 'evidence_quotes']}),
        'recommendation': {'suggested_option': p, 'confidence': p, 'reasoning': p, 'conflicts_with_user_principles': [p]},
        'multi_agent_council': {'workflow': [p], 'agent_count': p, 'facts': [{'statement': p}, {'fallback': p}], 'risk_summary': {'high_severity': [p], 'review_flags': [p]}, 'decision': {'suggested_option': p, 'confidence': p, 'rationale': p, 'blockers': [p]}, 'verification': {'status': p, 'output_hash': p, 'checks': [p]}, 'note': p},
        'limitations': [p],
        '__ambient': {'verified': True, 'verified_by_validators': p, 'model': p, 'merkle_root': p, 'request_id': p, 'auction': {'status': p, 'bids': {'placed': p, 'revealed': p}, 'address': p}, 'bidder': p},
        'verification_boundary': {'deterministic': [{'path': p}, p], 'interpretive': [{'path': p, 'text': p, 'reason': p}], 'uncertainty_flags': [p], 'method': {'kind': p, 'version': p, 'notes': [p]}},
        'verification_hooks': {'routing_action': p, 'segments': [{'path': p, 'category': p, 'text': p, 'reasons': [p]}], 'mixed_segments': [{'path': p, 'categories': [p]}], 'method': {'kind': p, 'version': p, 'notes': [p]}},
        'refusal_handling': {'refusal_detected': True, 'signals': [p], 'routed_to': p, 'note': p},
        'week7_evaluation': {'what_surprised': p, 'external_explanation_needed': p},
    }


@pytest.fixture
def routes(tmp_path_factory):
    cwd = tmp_path_factory.mktemp('renderer')
    reports = cwd / 'reports'
    reports.mkdir()
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    proc = subprocess.Popen(['node', str(Path(__file__).with_name('pageServer.js'))], cwd=cwd, env={**os.environ, 'PAGE_PORT': str(port)}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    base = f'http://127.0.0.1:{port}'
    for _ in range(100):
        try:
            urlopen(base, timeout=.2).close()
            break
        except OSError:
            if proc.poll() is not None:
                pytest.fail('actual pageServer.js exited before ready')
            time.sleep(.05)
    else:
        proc.kill()
        pytest.fail('actual pageServer.js did not start')

    def fetch(data=None, name='fixture.json', lang='en', route=None):
        if data is not None:
            (reports / name).write_text(json.dumps(data, ensure_ascii=False))
        target = route if route is not None else '/report/' + quote(name, safe='') + '?lang=' + lang
        with urlopen(base + target, timeout=3) as response:
            assert response.status == 200
            return Document(response.read().decode())
    try:
        yield fetch
    finally:
        proc.terminate()
        proc.wait(timeout=5)


@pytest.mark.parametrize('lang', ['en', 'ru'])
@pytest.mark.parametrize('payload', [PAYLOAD, CLASS_PAYLOAD])
def test_all_rendered_fields_stay_text(routes, lang, payload):
    doc = routes(report(payload), lang=lang)
    doc.safe()
    assert payload in doc.text
    assert payload in doc.text.split('Source Information' if lang == 'en' else 'Информация об источнике')[-1]
    assert doc.matching('html', lang=lang)
    assert doc.matching('pre')
    assert any('neutral' in a.get('class', '') for _, a in doc.nodes)


@pytest.mark.parametrize('destination', ['javascript:attack', 'JaVaScRiPt:attack', 'java\tscript:attack', 'java\nscript:attack', '&#106;avascript:attack', 'javascript&#58;attack', 'data:text/html,attack', '//evil.invalid/x', 'https://good.invalid/" onclick="attack'])
def test_untrusted_links(routes, destination):
    data = report('safe')
    data['input']['url'] = destination
    data['__ambient']['auction']['address'] = destination
    data['__ambient']['bidder'] = destination
    data['extracted']['body'] = '[label](' + destination + ')'
    doc = routes(data)
    doc.safe()
    assert destination in doc.text
    assert not any(a.get('href') == destination for _, a in doc.nodes)


@pytest.mark.parametrize('percent', ['1" onclick="attack', 'Infinity', -900, 900, None, 0])
def test_tally_progress_is_finite(routes, percent):
    data = report('safe')
    data['extracted']['current_results'] = {'voteStats': [{'type': 'for', 'percent': percent, 'votesCount': 25, 'votersCount': 3}]}
    doc = routes(data)
    doc.safe()
    assert doc.matching('span', **{'class': 'vote-type vote-type-for'})


@pytest.mark.parametrize('lang', ['en', 'ru'])
def test_formatted_positive_controls_and_index(routes, lang):
    data = report('Привет & DAO')
    destination = 'https://example.invalid/path?a=1&b=2'
    data['input']['url'] = destination
    data['__ambient']['auction']['address'] = destination
    data['__ambient']['bidder'] = destination
    data['extracted']['body'] = '# Heading\n\n## Second\n\n### Third\n\n**bold** *italic* `code <x>`\n\n```literal <x> &```\n\n[normal](' + destination + ')'
    data['extracted']['current_results'] = {'status': 'open', 'votes': {'for': 30, 'against': 10, 'abstain': 0}, 'voteStats': [{'type': 'against', 'percent': 25, 'votesCount': 10, 'votersCount': 2}]}
    data['recommendation']['confidence'] = 'high'
    data['verification_hooks']['segments'][0]['category'] = 'deterministic'
    name = 'quotes"\' & <img onerror=attack>.json'
    doc = routes(data, name=name, lang=lang)
    doc.safe()
    assert 'Привет & DAO' in doc.text and name in doc.text
    for tag in ['h1', 'h2', 'h3', 'strong', 'em', 'code', 'pre', 'p', 'article']:
        assert doc.matching(tag), tag
    assert len(doc.matching('a', href=destination)) == 4
    for cls in ['vote-type vote-type-for', 'vote-type vote-type-against', 'confidence confidence-high', 'hook-category deterministic']:
        assert any(a.get('class') == cls for _, a in doc.nodes), cls
    assert 'literal <x> &' in doc.text and 'code <x>' in doc.text
    index = routes(route='/?lang=' + lang + '&q=%22%20onclick%3D%22attack&other=a%26b')
    index.safe()
    assert name in index.text
    assert index.matching('a', href='/report/' + quote(name, safe="~()*!.'-_") + '?lang=' + lang)
    switch = [a['href'] for _, a in index.nodes if a.get('class') in ('active', '') and 'href' in a]
    assert len(switch) == 2 and all('q=' in href and 'other=' in href for href in switch)


def test_json_fallback_and_markdown_attributes_are_not_reparsed(routes):
    data = report('safe')
    fallback = {'fallback': '**literal** `code` & <tag>'}
    data['multi_agent_council']['facts'] = [fallback]
    destination = 'https://example.invalid/**path**?q=`code`&b=2'
    data['extracted']['body'] = '[**label**](' + destination + ')'
    doc = routes(data)
    doc.safe()
    assert json.dumps(fallback, separators=(',', ':')) in doc.text
    assert doc.matching('a', href=destination)
