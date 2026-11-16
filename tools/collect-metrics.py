"""Collect a dated Cangjie PR cohort via read-only GitCode APIs and export review metrics."""

import argparse
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
import importlib.util
import os
from pathlib import Path
import re
import sys
from threading import Lock, local
import time
import unicodedata
from urllib.parse import quote, unquote, urlsplit


ROOT = Path(__file__).resolve().parents[1]
ATOM_GIT_BOT_ID = '672dd45c4ea6673461aa2102'
PROJECT_PATH = re.compile(r'Cangjie/[A-Za-z0-9_.-]+', re.IGNORECASE)
DEFAULT_TAG = '商用交付&社区运作'


def timestamp(value):
    date = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if date.utcoffset() is None:
        raise ValueError('Date bounds must include an explicit time zone.')
    return date


def load_source(metrics_dir):
    path = metrics_dir.resolve(strict=True)
    if not (path / 'review_metrics/client.py').is_file():
        raise ValueError('The metrics directory must contain review_metrics/client.py.')
    sys.path.insert(0, str(path))
    from review_metrics.client import APIError, Client
    from review_metrics.core import evaluate, now, scope_inventory, template

    spec = importlib.util.spec_from_file_location('export_metrics', ROOT / 'tools/export-metrics.py')
    exporter = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(exporter)
    return Client, APIError, evaluate, now, scope_inventory, template, exporter


class PagedAPI:
    def __init__(self, client_type, api_error, spacing, token):
        self.clients = local()
        self.spacing = spacing
        self.token = token
        self.client_type = client_type
        self.api_error = api_error
        self.lock = Lock()
        self.next_request = 0

    def client(self):
        if not hasattr(self.clients, 'client'):
            instance = self.client_type(token=self.token, delay=0)
            original = instance.opener

            class TimedOpener:
                headers = None

                def open(opener, *args, **kwargs):
                    with self.lock:
                        time.sleep(max(0, self.next_request - time.monotonic()))
                        self.next_request = time.monotonic() + self.spacing
                    response = original.open(*args, **kwargs)
                    opener.headers = response.headers
                    return response

            instance.opener = TimedOpener()
            self.clients.client = instance
        return self.clients.client

    def pages(self, path, params):
        rows = []
        seen = set()
        expected = None
        client = self.client()
        for page in range(1, 10001):
            result = client.get(path, dict(params, page=page, per_page=100))
            if not isinstance(result, list) or any(not isinstance(row, dict) for row in result):
                raise self.api_error('GitCode returned an unexpected list format.')
            headers = client.opener.headers
            values = [headers.get(name, '') for name in ('total_count', 'total_page')]
            if all(value.isascii() and value.isdecimal() for value in values):
                totals = tuple(map(int, values))
                if expected is None:
                    expected = totals
                elif expected != totals:
                    raise self.api_error('GitCode page totals changed during collection.')
            for row in result:
                key = row.get('id')
                if not isinstance(key, int) or isinstance(key, bool) or key in seen:
                    raise self.api_error('GitCode returned a missing or duplicate row ID.')
                seen.add(key)
                rows.append(row)
            if expected is not None and page >= expected[1]:
                if len(rows) != expected[0]:
                    raise self.api_error('GitCode row count disagrees with the page totals.')
                return rows
            if not result:
                if expected is not None:
                    raise self.api_error('GitCode returned an empty page before the expected last page.')
                return rows
        raise self.api_error('GitCode pagination ceiling reached.')


def enabled_repositories(snapshot, inventory):
    if snapshot.get('version') != 1 or snapshot.get('organization') != 'Cangjie':
        raise ValueError('Expected a version 1 Cangjie review settings snapshot.')
    if inventory.get('organization') != 'Cangjie':
        raise ValueError('Expected a Cangjie repository inventory.')
    entries = {}
    for row in inventory['repositories']:
        path = row['path']
        if not PROJECT_PATH.fullmatch(path) or path.split('/')[-1] in ('.', '..') or path.casefold() in entries:
            raise ValueError('The inventory has a missing, invalid or duplicate repository path.')
        entries[path.casefold()] = path
    statuses = {}
    for row in snapshot['repositories']:
        key = row['path'].casefold()
        if key not in entries or key in statuses or not isinstance(row.get('aiReview'), bool):
            raise ValueError('The settings snapshot and inventory must cover the same repositories with verified AI review states.')
        statuses[key] = row['aiReview']
    if set(entries) != set(statuses) or inventory.get('total') != len(entries):
        raise ValueError('The settings snapshot and inventory differ or are incomplete.')
    enabled = sorted((path for key, path in entries.items() if statuses[key]), key=str.casefold)
    if not enabled:
        raise ValueError('No repositories are enabled for AI review in the settings snapshot.')
    return enabled, entries


def tagged_repositories(value, name):
    if not isinstance(value, dict) or value.get('version') != 1 or not isinstance(value.get('repositories'), list):
        raise ValueError('Expected a version 1 repository tag configuration.')
    tag_key = ' '.join(unicodedata.normalize('NFKC', name).split()).lower()
    selected = set()
    for row in value['repositories']:
        path, tags = row['path'], row['tags']
        if not isinstance(path, str) or not isinstance(tags, list) or any(not isinstance(tag, str) for tag in tags):
            raise ValueError('Invalid repository tag assignment.')
        if any(' '.join(unicodedata.normalize('NFKC', tag).split()).lower() == tag_key for tag in tags):
            selected.add(path.casefold())
    if not tag_key or not selected:
        raise ValueError('The requested tag is not assigned to any repositories.')
    return selected


def group_pulls(api, entries, first, end):
    pulls = api.pages('/org/Cangjie/pull_requests', {
        'state': 'all', 'sort': 'created', 'direction': 'desc',
        'created_after': (first - timedelta(seconds=1)).isoformat(),
        'created_before': end.isoformat(),
    })
    groups = defaultdict(dict)
    for pull in pulls:
        created = timestamp(pull['created_at'])
        if not first <= created < end:
            continue
        url = urlsplit(pull['html_url'])
        segments = [unquote(value) for value in url.path.strip('/').split('/')]
        number = pull['number']
        if (url.scheme != 'https' or url.netloc.lower() != 'gitcode.com' or len(segments) != 4 or
                segments[2] not in ('pull', 'merge_requests', 'pulls') or type(number) is not int or number < 1 or
                segments[3] != str(number)):
            raise ValueError('GitCode did not return a recognized Pull Request URL.')
        key = '/'.join(segments[:2]).casefold()
        if key not in entries:
            raise ValueError('GitCode returned a Pull Request from a repository absent from the inventory.')
        if number in groups[key]:
            raise ValueError('GitCode returned two Pull Requests with the same repository and number.')
        groups[key][number] = {
            'number': number, 'created_at': pull['created_at'], 'state': pull.get('state'),
            'merged_at': pull.get('merged_at'),
        }
    return groups


def collect_comments(api, repository, number, target, exporter, now):
    if target.is_file():
        existing = exporter.read_json(target)
        if existing['pr'] != number or not isinstance(existing['comments'], list):
            raise ValueError('Invalid PR checkpoint.')
        return 'cached'
    endpoint = '/repos/' + '/'.join(quote(part, safe='') for part in repository.split('/'))
    comments = api.pages(f'{endpoint}/pulls/{number}/comments', {'direction': 'asc'})
    exporter.write_output({'pr': number, 'observed_at': now(), 'comments': comments}, target)
    return 'collected'


def main():
    beijing = timezone(timedelta(hours=8))
    end_today = datetime.now(beijing).replace(hour=0, minute=0, second=0, microsecond=0)
    start_thirty_days = end_today - timedelta(days=30)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--metrics-dir', type=Path, default=ROOT.parent / 'gitcode-review-metrics')
    parser.add_argument('--inventory', type=Path, default=ROOT / 'data/inventory.json')
    parser.add_argument('--settings', type=Path, required=True, help='verified private review configuration snapshot')
    parser.add_argument('--repository', action='append', help='restrict the report to these enabled repositories; repeat for each one')
    parser.add_argument('--tags', type=Path, help='optional repository tag configuration selecting tagged enabled repositories')
    parser.add_argument('--tag', default=DEFAULT_TAG, help='tag name to use with --tags')
    parser.add_argument('--checkpoint-dir', type=Path, required=True, help='private folder, one directory per observation run')
    parser.add_argument('--output', type=Path, required=True, help='derived metrics JSON')
    parser.add_argument('--pr-states', type=Path, help='optional GitCode PR state observation for an existing checkpoint')
    parser.add_argument('--adoption-evidence', type=Path, help='verified judgments for exact raw comment observations')
    parser.add_argument('--legacy-format', action='store_true', help='also emit the original metrics fields')
    parser.add_argument('--created-after', default=start_thirty_days.isoformat(),
                        help='cohort lower bound, inclusive, with timezone (default: 30 complete Beijing days)')
    parser.add_argument('--created-before', default=end_today.isoformat(),
                        help='cohort upper bound, exclusive, with timezone (default: this Beijing midnight)')
    parser.add_argument('--workers', type=int, default=6, choices=range(1, 7))
    parser.add_argument('--delay', type=float, default=0.15, help='minimum seconds between request starts')
    args = parser.parse_args()
    if not 0.12 <= args.delay <= 10:
        parser.error('--delay must be between 0.12 and 10 seconds.')

    Client, APIError, evaluate, now, scope_inventory, template, exporter = load_source(args.metrics_dir)
    first, end = timestamp(args.created_after), timestamp(args.created_before)
    if first >= end:
        parser.error('The cohort start must precede the end.')
    bounds = {'created_after': first.isoformat(), 'created_before': end.isoformat()}
    repositories, known = enabled_repositories(exporter.read_json(args.settings), exporter.read_json(args.inventory))
    enabled = {repo.casefold() for repo in repositories}
    targets = {repo.casefold() for repo in args.repository} if args.repository else enabled
    if not targets.issubset(enabled):
        parser.error('--repository must name an enabled repository from the verified settings snapshot.')
    if args.tags:
        targets = targets & tagged_repositories(exporter.read_json(args.tags), args.tag)
    if not targets:
        parser.error('No enabled repositories match the selected scope.')
    checkpoint = args.checkpoint_dir.resolve()
    output = args.output.resolve()
    inputs = (args.settings, args.inventory, args.tags, args.pr_states, args.adoption_evidence)
    if output.is_relative_to(checkpoint) or any(path is not None and output == path.resolve() for path in inputs):
        parser.error('Choose a separate output path outside the checkpoint directory.')
    pr_states, pr_observed_at = exporter.read_pr_states(args.pr_states)
    reviews = exporter.read_adoption_evidence(args.adoption_evidence)
    api = PagedAPI(Client, APIError, args.delay, os.environ.get('GITCODE_TOKEN'))
    cohort_path = checkpoint / 'cohort.json'
    if cohort_path.is_file():
        cohort = exporter.read_json(cohort_path)
        old_scope = {repo.casefold() for repo in cohort['repositories']}
        scope_compatible = targets.issubset(old_scope) if args.repository or args.tags else old_scope == targets
        if cohort['bounds'] != bounds or not scope_compatible:
            parser.error('Checkpoint cohort bounds or enabled repository list differ.')
    else:
        print('Enumerating organization pull requests…', file=sys.stderr, flush=True)
        groups = group_pulls(api, known, first, end)
        cohort = {'bounds': bounds, 'started_at': now(), 'repositories': {
            path: list(groups[path.casefold()].values()) for path in repositories
        }}
        exporter.write_output(cohort, cohort_path)

    selected = {repo: pulls for repo, pulls in cohort['repositories'].items() if repo.casefold() in targets}
    total = sum(len(pulls) for pulls in selected.values())
    print(f'{len(selected)} eligible repositories, {total} pull requests', file=sys.stderr, flush=True)
    failures = defaultdict(dict)
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        pending = {}
        for repository, pulls in sorted(selected.items(), key=lambda pair: len(pair[1])):
            directory = checkpoint / repository.split('/')[-1]
            exporter.write_output({'repository': repository, **bounds, 'pulls': pulls}, directory / 'manifest.json')
            for pull in pulls:
                number = pull['number']
                path = directory / f'pr-{number}.json'
                task = pool.submit(collect_comments, api, repository, number, path, exporter, now)
                pending[task] = (repository, number)
        for done, task in enumerate(as_completed(pending), start=1):
            repository, number = pending[task]
            try:
                task.result()
            except (APIError, OSError, ValueError, KeyError, TypeError) as error:
                failures[repository][number] = type(error).__name__
                print(f'{repository}#{number}: {error}', file=sys.stderr, flush=True)
            if done % 50 == 0 or done == total:
                count = sum(len(rows) for rows in failures.values())
                print(f'{done}/{total} PR processed, {count} failed', file=sys.stderr, flush=True)

    reports = []
    for repository, pulls in selected.items():
        numbers = sorted(pull['number'] for pull in pulls)
        failed = sorted(failures[repository])
        directory = checkpoint / repository.split('/')[-1]
        observations = [exporter.read_json(directory / f'pr-{n}.json') for n in numbers if n not in failures[repository]]
        observed_at = max((item['observed_at'] for item in observations), default=cohort['started_at'])
        scope = {'type': 'selected_prs', 'prs': numbers, **bounds,
                 'collected_prs': len(observations), 'failed_prs': failed}
        bundle = {'repository': repository, 'observed_at': observed_at, 'scope': scope, 'complete': not failed,
                  'pulls': pulls, 'pr_state_observed_at': cohort['started_at'],
                  'pr_observations': {str(row['pr']): row['observed_at'] for row in observations},
                  'comments': [{'pr': row['pr'], 'comment': comment}
                               for row in observations for comment in row['comments']
                               if args.legacy_format or comment.get('comment_type') == 'diff_comment']}
        config = {'repository': repository, 'bot_logins': ['atomgit-bot'], 'bot_ids': [ATOM_GIT_BOT_ID]}
        diff_comments = scope_inventory(bundle, config['bot_logins'], config['bot_ids'])['diff']
        scope['bot_pr_count'] = len({row['pr'] for row in diff_comments.values()})
        adoption_comments = exporter.project_adoption_comments(bundle, diff_comments, [],
                                                               pr_states, pr_observed_at, reviews)
        if args.legacy_format:
            report = exporter.project_report(evaluate(bundle, template(bundle, config), config))
            report['scope'] = scope
            report['adoption_comments'] = adoption_comments
            report['candidates'] = [{key: row[key] for key in ('id', 'pr', 'state')} for row in adoption_comments]
        else:
            report = {'repository': repository, 'observed_at': observed_at, 'scope': scope,
                      'collection_complete': not failed}
            report = exporter.adoption_report(report, adoption_comments, pr_observed_at or cohort['started_at'])
        reports.append(report)

    if reviews:
        raise ValueError('Some adoption evidence does not match a raw Diff comment in the exported scope.')
    exporter.write_output({'version': 1, 'reports': reports}, output)
    if any(failures.values()):
        print('Partial cohort exported. Rerun with the same checkpoint directory to retry missing PRs.', file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, ValueError, KeyError, TypeError) as error:
        sys.exit(f'Collection failed: {error}')
