"""Export calculated GitCode review metrics without shipping raw comments."""

import argparse
from collections import Counter
from contextlib import closing
from datetime import datetime
import json
from pathlib import Path
import re
import sqlite3
import sys
import tempfile
from urllib.parse import parse_qsl, urlsplit


DEFAULT_SOURCE = Path(__file__).resolve().parents[2] / 'gitcode-review-metrics'
DEFAULT_SNAPSHOT = Path('data/full-snapshot.json')
DEFAULT_ASSESSMENT = Path('examples/full-backfill-report/full-audit.assessment.json')
DEFAULT_CONFIG = Path('config/cangjie_docs.json')
REPORT_FIELDS = (
    'repository', 'observed_at', 'collection_complete', 'rule_version', 'assessment_version',
    'diff_comment_count', 'all_bot_comment_count', 'discussion_comment_count', 'scope_pending_count',
    'finding_count', 'unclassified_candidate_count', 'resolved', 'unresolved', 'state_unknown',
    'resolved_full', 'resolved_partial', 'resolved_not_adopted', 'resolved_adoption_unknown',
    'adoption_numerator', 'adoption_denominator', 'adoption_rate', 'final_adoption_rate',
    'adoption_assessment_coverage', 'classification_complete_for_scope', 'publishable_for_collected_scope',
)
CREDENTIAL_PARAMETERS = {'access_token', 'token', 'private_token', 'api_key', 'authorization'}
PR_STATES = {'merged', 'open', 'unmerged', 'unknown'}
ADOPTION_RULE = 'merged-resolved-raw-diff-v1'


def read_json(path):
    with path.open(encoding='utf-8-sig') as source:
        return json.load(source)


def export_evidence(values):
    if not isinstance(values, list):
        raise ValueError('Finding evidence must be a list of references.')
    links = []
    for value in values:
        if not isinstance(value, str):
            raise ValueError('Finding evidence must be a list of references.')
        parts = urlsplit(value)
        if parts.scheme in ('http', 'https') and (
            parts.username is not None or parts.password is not None or
            any(key.lower() in CREDENTIAL_PARAMETERS for key, _ in parse_qsl(parts.query))
        ):
            raise ValueError('An evidence URL contains credentials. Use a link without credentials.')
        links.append(value)
    return links


def project_report(report):
    result = {key: report[key] for key in REPORT_FIELDS}
    result['scope'] = {key: report['scope'][key] for key in ('type', 'prs')}
    result['findings'] = [
        {
            'id': row['finding_id'],
            'state': row['state'],
            'adoption': row['adoption'],
            'pr': row['pr'],
            'rationale': row.get('rationale', ''),
            'evidence': export_evidence(row.get('evidence', [])),
            'comment_keys': row['comment_keys'],
        }
        for row in report['findings']
    ]
    return result


def parse_time(value):
    if not isinstance(value, str):
        return None
    try:
        instant = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        return None
    return instant if instant.utcoffset() is not None else None


def pull_state(pull):
    state = pull.get('state')
    if state == 'merged' or pull.get('merged') is True or parse_time(pull.get('merged_at')):
        return 'merged'
    if state in ('open', 'opened'):
        return 'open'
    if state in ('closed', 'rejected', 'unmerged'):
        return 'unmerged'
    return 'unknown'


def read_pr_states(path):
    if path is None:
        return {}, None
    value = read_json(path)
    if (not isinstance(value, dict) or value.get('version') != 1 or not parse_time(value.get('observed_at')) or
            not isinstance(value.get('repositories'), dict)):
        raise ValueError('Invalid GitCode PR state data.')
    repositories = {}
    for repository, rows in value['repositories'].items():
        key = repository.casefold()
        if key in repositories or not isinstance(rows, dict) or any(
                not re.fullmatch(r'[1-9]\d*', number) or not isinstance(state, str) or state not in PR_STATES
                for number, state in rows.items()):
            raise ValueError('Invalid or duplicate GitCode PR state data.')
        repositories[key] = {int(number): state for number, state in rows.items()}
    return repositories, value['observed_at']


def read_adoption_evidence(path):
    if path is None:
        return {}
    value = read_json(path)
    if not isinstance(value, dict) or value.get('version') != 1 or not isinstance(value.get('reviews'), list):
        raise ValueError('Invalid adoption evidence data.')
    evidence = {}
    for row in value['reviews']:
        if not isinstance(row, dict):
            raise ValueError('Invalid adoption evidence row.')
        repository = row.get('repository')
        comment_id = row.get('id')
        verdict = row.get('adoption')
        rationale = row.get('rationale')
        if (not isinstance(repository, str) or not repository or not isinstance(comment_id, str) or
                not re.fullmatch(r'[1-9]\d*:[1-9]\d*', comment_id) or
                not parse_time(row.get('comment_observed_at')) or verdict not in ('adopted', 'not_adopted') or
                not isinstance(rationale, str) or not rationale.strip()):
            raise ValueError('Adoption evidence needs the repository, raw comment ID, observation time, verdict, and rationale.')
        references = export_evidence(row.get('evidence'))
        if not references or any(not reference.strip() for reference in references):
            raise ValueError('Adoption verdicts require nonempty evidence references.')
        key = (repository.casefold(), comment_id)
        if key in evidence:
            raise ValueError(f'Duplicate adoption evidence for {repository}#{comment_id}.')
        evidence[key] = {'adoption': verdict, 'rationale': rationale.strip(), 'evidence': references,
                         'comment_observed_at': row['comment_observed_at']}
    return evidence


def project_adoption_comments(bundle, diff_comments, findings, pr_states, pr_observed_at, reviews):
    repository = bundle['repository'].casefold()
    comments_observed_at = bundle.get('pr_observations', {})
    stored_pr_states = {row['number']: pull_state(row) for row in bundle.get('pulls', [])}
    stored_pr_time = bundle.get('pr_state_observed_at', bundle.get('collection_started_at', bundle['observed_at']))
    supplied_pr_states = pr_states.get(repository, {})
    mapped = Counter(key for finding in findings for key in finding['comment_keys'])
    historical = {finding['comment_keys'][0]: finding for finding in findings
                  if len(finding['comment_keys']) == 1 and mapped[finding['comment_keys'][0]] == 1}
    result = []
    for key, source in sorted(diff_comments.items(), key=lambda item: (item[1]['pr'], int(item[0].split(':')[1]))):
        pr = source['pr']
        comment = source['comment']
        pr_state = supplied_pr_states.get(pr, stored_pr_states.get(pr, 'unknown'))
        pr_time = pr_observed_at if pr in supplied_pr_states else stored_pr_time if pr_state != 'unknown' else None
        observed = comments_observed_at.get(str(pr), bundle['observed_at'])
        resolved = comment.get('resolved')
        state = 'resolved' if resolved is True else 'unresolved' if resolved is False else 'unknown'
        review = reviews.pop((repository, key), None)
        eligible = pr_state == 'merged' and state == 'resolved'
        adoption, rationale, evidence = 'unknown', '', []

        if review is not None:
            if parse_time(review['comment_observed_at']) != parse_time(observed) or not eligible:
                raise ValueError(f'Adoption evidence for {bundle["repository"]}#{key} is stale or outside the adoption scope.')
            adoption, rationale, evidence = review['adoption'], review['rationale'], review['evidence']
        elif eligible:
            finding = historical.get(key)
            # Only unambiguous, evidence-backed decisions from this exact observation can carry over.
            if finding and finding['adoption'] in ('full', 'not_adopted') and finding['rationale'] and finding['evidence']:
                adoption = 'adopted' if finding['adoption'] == 'full' else 'not_adopted'
                rationale, evidence = finding['rationale'], finding['evidence']

        result.append({'id': key, 'pr': pr, 'comment_type': 'diff_comment', 'state': state,
                       'pr_state': pr_state, 'adoption': adoption, 'rationale': rationale, 'evidence': evidence,
                       'comment_observed_at': observed,
                       **({'pr_state_observed_at': pr_time} if parse_time(pr_time) else {})})
    return result


def adoption_report(report, adoption_comments, pr_observed_at=None):
    scope_fields = ('type', 'prs', 'created_after', 'created_before', 'collected_prs', 'failed_prs', 'bot_pr_count')
    scope = {key: report['scope'][key] for key in scope_fields if key in report['scope']}
    if parse_time(pr_observed_at):
        scope['pr_state_observed_at'] = pr_observed_at
    return {
        'repository': report['repository'], 'observed_at': report['observed_at'], 'scope': scope,
        'collection_complete': report['collection_complete'], 'rule_version': ADOPTION_RULE,
        'diff_comment_count': len(adoption_comments), 'adoption_comments': adoption_comments,
    }


def project_bundle(bundle, assessment, config, evaluate, scope_inventory, pr_states, pr_observed_at,
                   reviews, legacy_format=False):
    report = project_report(evaluate(bundle, assessment, config))
    diff_comments = scope_inventory(bundle, config['bot_logins'], config.get('bot_ids', ()))['diff']
    comments = project_adoption_comments(
        bundle, diff_comments, report['findings'], pr_states, pr_observed_at, reviews)
    if legacy_format:
        return {**report, 'adoption_comments': comments}
    state_observed_at = pr_observed_at or bundle.get('pr_state_observed_at') or bundle.get('collection_started_at')
    return adoption_report(report, comments, state_observed_at)


def export_database(path, configs, evaluate, template, scope_inventory, pr_states, pr_observed_at, reviews,
                    legacy_format=False):
    uri = path.resolve(strict=True).as_uri() + '?mode=ro'
    with closing(sqlite3.connect(uri, uri=True)) as db:
        db.row_factory = sqlite3.Row
        db.execute('BEGIN')
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        web_configs = {}
        selection = 'SELECT MAX(id) FROM snapshots GROUP BY repository COLLATE NOCASE'
        if 'web_repos' in tables:
            web_configs = {
                row['repository'].casefold(): {'repository': row['repository'], 'bot_logins': [row['bot_login']]}
                for row in db.execute('SELECT repository, bot_login FROM web_repos')
            }
            selection = 'SELECT snapshot_id FROM web_repos WHERE snapshot_id IS NOT NULL'
        snapshots = db.execute(f'''
            SELECT s.repository, s.payload, a.payload AS assessment
            FROM snapshots s
            LEFT JOIN assessments a ON a.id = (
                SELECT MAX(id) FROM assessments WHERE snapshot_id = s.id
            )
            WHERE s.id IN ({selection})
            ORDER BY s.repository COLLATE NOCASE
        ''')

        reports = []
        for row in snapshots:
            bundle = json.loads(row['payload'])
            key = row['repository'].casefold()
            config = configs.get(key) or web_configs.get(key)
            if config is None:
                raise ValueError(f'No bot identity configured for {row["repository"]}.')
            assessment = json.loads(row['assessment']) if row['assessment'] else template(bundle, config)
            reports.append(project_bundle(bundle, assessment, config, evaluate, scope_inventory,
                                          pr_states, pr_observed_at, reviews, legacy_format))

    if not reports:
        raise ValueError('No saved review snapshots found in the database.')
    return reports


def write_output(value, output):
    if output is None:
        json.dump(value, sys.stdout, ensure_ascii=True, indent=2, allow_nan=False)
        sys.stdout.write('\n')
        return

    output = output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=output.parent, delete=False) as temp:
            temp_path = Path(temp.name)
            json.dump(value, temp, ensure_ascii=False, indent=2, allow_nan=False)
            temp.write('\n')
        temp_path.replace(output)
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--metrics-dir', type=Path, default=DEFAULT_SOURCE, help='existing gitcode-review-metrics directory')
    source = parser.add_mutually_exclusive_group()
    source.add_argument('--snapshot', type=Path, help='saved input JSON (the cangjie_docs full snapshot is the default)')
    source.add_argument('--db', type=Path, help='read the snapshots currently selected by the local web app, or the latest per repository in a CLI database')
    parser.add_argument('--assessment', type=Path, help='assessment for --snapshot (omitting uses the seed assessment or an unassessed custom snapshot)')
    parser.add_argument('--config', type=Path, help='bot identity config (uses the cangjie_docs config by default)')
    parser.add_argument('--pr-states', type=Path, help='optional separate GitCode PR state observation')
    parser.add_argument('--adoption-evidence', type=Path, help='verified judgments for exact raw comment observations')
    parser.add_argument('--legacy-format', action='store_true', help='also emit the original metrics fields')
    parser.add_argument('--output', type=Path, help='destination JSON (defaults to standard output)')
    args = parser.parse_args()
    if args.db and args.assessment:
        parser.error('--assessment applies to the JSON snapshot mode.')

    try:
        metrics_dir = args.metrics_dir.resolve(strict=True)
        if not (metrics_dir / 'review_metrics/core.py').is_file():
            raise ValueError('The metrics directory must contain review_metrics/core.py.')
        sys.path.insert(0, str(metrics_dir))
        from review_metrics.core import evaluate, scope_inventory, template

        config_path = args.config or metrics_dir / DEFAULT_CONFIG
        config = read_json(config_path)
        snapshot_path = args.snapshot or metrics_dir / DEFAULT_SNAPSHOT
        assessment_path = args.assessment
        if args.db is None and args.snapshot is None and assessment_path is None:
            assessment_path = metrics_dir / DEFAULT_ASSESSMENT
        inputs = (config_path, args.db or snapshot_path, assessment_path, args.pr_states, args.adoption_evidence)
        if args.output and any(p is not None and p.resolve() == args.output.resolve() for p in inputs):
            raise ValueError('Choose an output path distinct from the inputs.')

        pr_states, pr_observed_at = read_pr_states(args.pr_states)
        reviews = read_adoption_evidence(args.adoption_evidence)

        if args.db:
            config_key = config['repository'].casefold()
            reports = export_database(args.db, {config_key: config}, evaluate, template, scope_inventory,
                                      pr_states, pr_observed_at, reviews, args.legacy_format)
        else:
            bundle = read_json(snapshot_path)
            if config['repository'].casefold() != bundle['repository'].casefold():
                raise ValueError('The bot identity configuration must match the snapshot repository.')
            assessment = read_json(assessment_path) if assessment_path else template(bundle, config)
            reports = [project_bundle(bundle, assessment, config, evaluate, scope_inventory,
                                      pr_states, pr_observed_at, reviews, args.legacy_format)]
        if reviews:
            raise ValueError('Some adoption evidence does not match a raw Diff comment in the exported scope.')
        write_output({'version': 1, 'reports': reports}, args.output)
    except (OSError, sqlite3.Error, TypeError, ValueError, KeyError) as error:
        parser.exit(1, f'Export failed: {error}\n')


if __name__ == '__main__':
    main()
