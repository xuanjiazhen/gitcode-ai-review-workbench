"""Export calculated GitCode review metrics without shipping raw comments."""

import argparse
from contextlib import closing
import json
from pathlib import Path
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


def export_database(path, configs, evaluate, template):
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
            reports.append(project_report(evaluate(bundle, assessment, config)))

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
    parser.add_argument('--output', type=Path, help='destination JSON (defaults to standard output)')
    args = parser.parse_args()
    if args.db and args.assessment:
        parser.error('--assessment applies to the JSON snapshot mode.')

    try:
        metrics_dir = args.metrics_dir.resolve(strict=True)
        if not (metrics_dir / 'review_metrics/core.py').is_file():
            raise ValueError('The metrics directory must contain review_metrics/core.py.')
        sys.path.insert(0, str(metrics_dir))
        from review_metrics.core import evaluate, template

        config_path = args.config or metrics_dir / DEFAULT_CONFIG
        config = read_json(config_path)
        snapshot_path = args.snapshot or metrics_dir / DEFAULT_SNAPSHOT
        assessment_path = args.assessment
        if args.db is None and args.snapshot is None and assessment_path is None:
            assessment_path = metrics_dir / DEFAULT_ASSESSMENT
        inputs = (config_path, args.db, assessment_path) if args.db else (config_path, snapshot_path, assessment_path)
        if args.output and any(p is not None and p.resolve() == args.output.resolve() for p in inputs):
            raise ValueError('Choose an output path distinct from the inputs.')

        if args.db:
            config_key = config['repository'].casefold()
            reports = export_database(args.db, {config_key: config}, evaluate, template)
        else:
            bundle = read_json(snapshot_path)
            if config['repository'].casefold() != bundle['repository'].casefold():
                raise ValueError('The bot identity configuration must match the snapshot repository.')
            assessment = read_json(assessment_path) if assessment_path else template(bundle, config)
            reports = [project_report(evaluate(bundle, assessment, config))]
        write_output({'version': 1, 'reports': reports}, args.output)
    except (OSError, sqlite3.Error, TypeError, ValueError, KeyError) as error:
        parser.exit(1, f'Export failed: {error}\n')


if __name__ == '__main__':
    main()
