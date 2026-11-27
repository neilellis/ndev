#!/usr/bin/env python3
# Copyright (c) 2026 Neil Ellis. Licensed under the MIT License.
"""Audit Codex JSONL rollouts or JSON record arrays with the Python standard library.

Read response_item records once. Ignore mirrored events, instructions, reasoning,
images and tool output bodies. Reports contain local text, not sanitised public data.
Nested tool names and activity signals are lexical hints, not execution counts.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import re
import sys
from collections import Counter
from collections.abc import Iterator
from pathlib import Path
from typing import TypeAlias, cast

Json: TypeAlias = None | bool | int | float | str | list['Json'] | dict[str, 'Json']
Row: TypeAlias = dict[str, Json]
logger = logging.getLogger(__name__)
NESTED_TOOL = re.compile(r'\btools\.([A-Za-z_][A-Za-z_0-9]*)\s*\(')
SIGNALS = {
    'wait_or_poll': re.compile(r'\b(?:write_stdin|wait_agent|sleep|wait_for_process_end|wait-for-pr-change|ndev\s+wait)\b'),
    'github_state': re.compile(r'\bgh\s+(?:pr\s+(?:view|checks)|run\s+(?:view|list))\b'),
    'inline_script': re.compile(r'\b(?:python[\d.]*|node)\s+(?:-\s*<<|-c\b|-e\b)'),
    'test_or_lint': re.compile(r'\b(?:pytest|ruff|basedpyright|shellcheck|precheck\.sh|vitest)\b'),
    'file_read': re.compile(r'\b(?:cat|sed|rg)\s'),
    'git_inspection': re.compile(r'\bgit\s+(?:-C\s+\S+\s+)?(?:status|diff|log|show|worktree)\b'),
}


def object_row(value: Json, location: str) -> Row:
    if not isinstance(value, dict):
        raise ValueError(f'{location}: expected a JSON object')
    return value


def records(path: Path) -> Iterator[tuple[int, Row]]:
    """Line numbers for JSONL; record positions for JSON arrays."""
    with path.open(encoding='utf-8') as stream:
        if path.suffix == '.json':
            try:
                value = cast(Json, json.load(stream))
            except json.JSONDecodeError as error:
                raise ValueError(f'{path}:{error.lineno}: invalid JSON: {error.msg}') from error
            rows = value if isinstance(value, list) else [value]
            for index, row in enumerate(rows, 1):
                yield index, object_row(row, f'{path}:record {index}')
        else:
            for line_number, line in enumerate(stream, 1):
                if not line.strip():
                    continue
                try:
                    row = cast(Json, json.loads(line))
                except json.JSONDecodeError as error:
                    raise ValueError(f'{path}:{line_number}: invalid JSON; retry after the writer finishes: {error.msg}') from error
                yield line_number, object_row(row, f'{path}:{line_number}')


def metadata(path: Path) -> Row:
    first = next(records(path), None)
    if first is None or first[1].get('type') != 'session_meta':
        raise ValueError(f'{path}: first record must be session_meta')
    return object_row(first[1].get('payload'), str(path))


def bounded(text: str, limit: int) -> str:
    return text[:limit] if limit else text


def as_text(value: Json) -> str:
    return value if isinstance(value, str) else json.dumps(value, sort_keys=True)


def audit_session(path: Path, max_chars: int = 1200) -> Row:
    logger.debug('Audit session records: %s', path)
    meta = metadata(path)
    tools: list[Json] = []
    messages: list[Json] = []
    calls: dict[str, Row] = {}
    for line, record in records(path):
        if record.get('type') != 'response_item':
            continue
        payload = object_row(record.get('payload'), f'{path}:{line}')
        kind = payload.get('type')
        if kind in ('function_call', 'custom_tool_call'):
            call_id, name = payload.get('call_id'), payload.get('name')
            if not isinstance(call_id, str) or not isinstance(name, str):
                raise ValueError(f'{path}:{line}: tool call needs name and call_id')
            if call_id in calls:
                continue
            namespace = payload.get('namespace')
            if isinstance(namespace, str) and not name.startswith(namespace + '.'):
                name = namespace + '.' + name
            key = 'arguments' if kind == 'function_call' else 'input'
            if key not in payload:
                raise ValueError(f'{path}:{line}: tool call lacks {key}')
            raw = as_text(payload[key])
            call: Row = {
                'line': line, 'timestamp': record.get('timestamp'), 'call_id': call_id,
                'name': name, 'input': bounded(raw, max_chars), 'input_chars': len(raw),
                'input_truncated': bool(max_chars and len(raw) > max_chars),
                'input_sha256': hashlib.sha256(raw.encode()).hexdigest(),
                'nested_tool_mentions': list(cast(list[Json], NESTED_TOOL.findall(raw))),
                'signals': [label for label, pattern in SIGNALS.items() if pattern.search(name + ' ' + raw)],
                'output_chars': None,
            }
            calls[call_id] = call
            tools.append(call)
        elif kind in ('function_call_output', 'custom_tool_call_output'):
            call_id = payload.get('call_id')
            if isinstance(call_id, str) and call_id in calls:
                call = calls[call_id]
                previous = call['output_chars']
                call['output_chars'] = (previous if isinstance(previous, int) else 0) + len(as_text(payload.get('output')))
        elif kind == 'message' and payload.get('role') in ('user', 'assistant'):
            content = payload.get('content')
            if not isinstance(content, list):
                raise ValueError(f'{path}:{line}: message content must be an array')
            parts = [part['text'] for part in content if isinstance(part, dict)
                     and part.get('type') in ('input_text', 'output_text') and isinstance(part.get('text'), str)]
            text = '\n'.join(cast(list[str], parts))
            lines = [part.strip() for part in text.splitlines() if part.strip()]
            if lines:
                messages.append({'line': line, 'timestamp': record.get('timestamp'),
                                 'role': payload['role'], 'first': bounded(lines[0], max_chars),
                                 'last': bounded(lines[-1], max_chars), 'text_chars': len(text),
                                 'line_count': len(lines),
                                 'truncated': bool(max_chars and max(len(lines[0]), len(lines[-1])) > max_chars)})
    return {'path': str(path), 'id': meta.get('id', meta.get('session_id')), 'cwd': meta.get('cwd'),
            'parent_thread_id': meta.get('parent_thread_id'), 'started_at': meta.get('timestamp'),
            'tools': tools, 'messages': messages}


def rows_in(row: Row, key: str) -> Iterator[Row]:
    values = row[key]
    if isinstance(values, list):
        for value in values:
            yield object_row(value, key)


def make_report(paths: list[Path], max_chars: int) -> Row:
    logger.info('Audit tool use and message boundaries in %d session files', len(paths))
    sessions: list[Json] = []
    counts: Counter[str] = Counter()
    mentions: Counter[str] = Counter()
    signals: Counter[str] = Counter()
    repeats: dict[tuple[str, str], list[Json]] = {}
    examples: dict[tuple[str, str], Row] = {}
    for path in paths:
        session = audit_session(path, max_chars)
        sessions.append(session)
        for call in rows_in(session, 'tools'):
            name = str(call['name'])
            counts[name] += 1
            for field, counter in [('nested_tool_mentions', mentions), ('signals', signals)]:
                values = call[field]
                if isinstance(values, list):
                    counter.update(str(value) for value in values)
            key = (name, str(call['input_sha256']))
            repeats.setdefault(key, []).append({'path': str(path), 'line': call['line']})
            examples[key] = call
    repeated: list[Json] = []
    for key, locations in sorted(repeats.items(), key=lambda pair: -len(pair[1])):
        if len(locations) > 1:
            repeated.append({'name': key[0], 'count': len(locations), 'input': examples[key]['input'],
                             'input_sha256': key[1], 'examples': locations[:3]})
    return {'selected_sessions': len(sessions), 'tool_calls': counts.total(),
            'tool_counts': dict(counts.most_common()), 'nested_tool_mentions': dict(mentions.most_common()),
            'signal_call_counts': dict(signals.most_common()), 'repeated_inputs': repeated,
            'notes': 'Recorded response_item calls only; events are not counted. Nested names and signals are lexical hints. '
                     'Wait calls are not necessarily waste. Characters are not billed tokens. No tool output bodies or reasoning are exported.',
            'sessions': sessions}


def nonnegative(value: str) -> int:
    number = int(value)
    if number < 0:
        raise argparse.ArgumentTypeError('must be zero or greater')
    return number


def main() -> int:
    logging.basicConfig(level=logging.INFO, format='%(levelname)s: %(message)s')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('paths', nargs='*', type=Path, help='explicit JSONL/JSON files (includes child sessions)')
    parser.add_argument('--sessions-dir', type=Path, default=Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex'))) / 'sessions')
    parser.add_argument('--repo', type=Path, help='include this cwd and its descendants')
    parser.add_argument('--limit', type=nonnegative, default=20, help='most recently modified sessions; 0 means all')
    parser.add_argument('--offset', type=nonnegative, default=0, help='skip this many matching recent sessions before --limit')
    parser.add_argument('--include-subagents', action='store_true')
    parser.add_argument('--max-chars', type=nonnegative, default=1200, help='per input or boundary line; 0 means full text')
    parser.add_argument('--output', type=Path, help='new private JSON file; print summary instead of JSON')
    parser.add_argument('--examples', type=nonnegative, default=0, help='with --output, show this many repeated inputs and session message boundaries')
    args = parser.parse_args()
    if args.examples and not args.output:
        parser.error('--examples requires --output')
    explicit = cast(list[Path], args.paths)
    root = cast(Path, args.sessions_dir)
    try:
        if explicit:
            candidates = explicit
        else:
            if not root.is_dir():
                raise ValueError(f'{root}: session directory does not exist')
            candidates = [p for p in root.rglob('*') if p.suffix in ('.jsonl', '.json') and p.is_file()]
        selected: list[Path] = []
        skipped = 0
        logger.info('Select recent sessions from %d candidate files', len(candidates))
        for path in sorted(set(candidates), key=lambda p: p.stat().st_mtime, reverse=True):
            meta = metadata(path)
            source = meta.get('source')
            if not explicit and not args.include_subagents and (meta.get('parent_thread_id') or isinstance(source, dict) and 'subagent' in source):
                continue
            if args.repo:
                cwd = meta.get('cwd')
                if not isinstance(cwd, str) or not Path(cwd).resolve().is_relative_to(cast(Path, args.repo).resolve()):
                    continue
            if skipped < args.offset:
                skipped += 1
                continue
            selected.append(path)
            if args.limit and len(selected) >= args.limit:
                break
        if not selected:
            raise ValueError(f'{root}: no matching sessions; check --repo and --sessions-dir')
        report = make_report(selected, cast(int, args.max_chars))
        report['candidate_files'] = len(candidates)
        report['offset'] = cast(int, args.offset)
        encoded = json.dumps(report, indent=2, ensure_ascii=False) + '\n'
        if args.output:
            output = cast(Path, args.output)
            descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
                _ = stream.write(encoded)
            print(f"Sessions: {report['selected_sessions']} of {len(candidates)} candidate files; recorded tool calls: {report['tool_calls']}")
            print('Tools: ' + json.dumps(report['tool_counts']))
            print('Activity hints: ' + json.dumps(report['signal_call_counts']))
            print(f'Local report: {output}')
            for repeat in list(rows_in(report, 'repeated_inputs'))[:args.examples]:
                print(f"Repeated {repeat['count']} times ({repeat['name']}): " + str(repeat['input'])[:350].replace('\n', ' '))
            for session in list(rows_in(report, 'sessions'))[:args.examples]:
                messages = [message for message in rows_in(session, 'messages') if message['role'] == 'assistant']
                if messages:
                    print(f"Session {session['id']}: first: " + str(messages[0]['first'])[:240])
                    print('  last: ' + str(messages[-1]['last'])[:240])
        else:
            print(encoded, end='')
    except (OSError, ValueError) as error:
        print(f'ERROR: audit failed: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
