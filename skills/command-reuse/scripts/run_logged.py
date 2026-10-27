#!/usr/bin/env python3
# Copyright (C) 2026 Neil Ellis. All rights reserved.
"""Run a command once on POSIX; save its log and result in a new private directory.

Use -- before the command. No shell evaluation, live output, or model polling.
Timeout stops the whole process group. This does not certify that tests passed:
read the command's result and log, including skips and collected test counts.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import signal
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from types import FrameType
from typing import BinaryIO, cast

EXCERPT_BYTES = 4000


class Terminated(Exception):
    """The caller requested cancellation through SIGTERM."""


def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def positive_seconds(value: str) -> float:
    seconds = float(value)
    if not math.isfinite(seconds) or seconds <= 0:
        raise argparse.ArgumentTypeError('timeout must be a finite positive number')
    return seconds


def stop(child: subprocess.Popen[bytes]) -> None:
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        print(f'WARNING: process group {child.pid} exited before cancellation; collecting its status', file=sys.stderr)
    _ = child.wait()


def failure_excerpt(path: Path) -> str:
    with path.open('rb') as stream:
        first = stream.read(EXCERPT_BYTES)
        size = stream.seek(0, os.SEEK_END)
        if size <= EXCERPT_BYTES:
            return first.decode(errors='replace')
        _ = stream.seek(max(EXCERPT_BYTES, size - EXCERPT_BYTES))
        last = stream.read(EXCERPT_BYTES)
    return first.decode(errors='replace') + '\n[log excerpt; full log on disk]\n' + last.decode(errors='replace')


def run_command(command: list[str], stream: BinaryIO, timeout: float) -> tuple[int, str, str | None, int | None]:
    child: subprocess.Popen[bytes] | None = None
    terminate_requested = False

    def terminate(_signum: int, _frame: FrameType | None) -> None:
        nonlocal terminate_requested
        terminate_requested = True
        if child is not None:
            raise Terminated()

    previous = signal.signal(signal.SIGTERM, terminate)
    try:
        try:
            child = subprocess.Popen(command, stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)  # noqa: S603 — explicit user command; no shell.
            if terminate_requested:
                raise Terminated()
            child_code = child.wait(timeout=timeout)
            code = child_code if child_code >= 0 else 128 - child_code
            return code, 'passed' if code == 0 else 'failed', None, child_code
        except OSError as error:
            return 127, 'start_failed', str(error), None
        except subprocess.TimeoutExpired:
            _ = signal.signal(signal.SIGTERM, signal.SIG_IGN)
            assert child is not None
            print(f'ERROR: process group {child.pid} exceeded {timeout} seconds; cancelling it', file=sys.stderr)
            stop(child)
            return 124, 'timed_out', f'command exceeded {timeout} seconds; process group cancelled', child.returncode
        except (KeyboardInterrupt, Terminated) as error:
            _ = signal.signal(signal.SIGTERM, signal.SIG_IGN)
            print(f'ERROR: command interrupted; cancelling process group {child.pid if child else "not started"}', file=sys.stderr)
            if child is not None:
                stop(child)
            code = 143 if isinstance(error, Terminated) else 130
            return code, 'interrupted', 'command interrupted; process group cancelled', child.returncode if child else None
    finally:
        _ = signal.signal(signal.SIGTERM, previous)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out-dir', required=True, type=Path, help='new directory; existing evidence is never overwritten')
    parser.add_argument('--timeout', type=positive_seconds, default=1800.0, help='seconds before cancellation (default 1800)')
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = cast(list[str], args.command)
    if command[:1] == ['--']:
        command = command[1:]
    if not command:
        parser.error('provide a command after --')
    if os.name != 'posix':
        parser.error('POSIX process groups are required')
    output = cast(Path, args.out_dir).resolve()
    try:
        output.mkdir(mode=0o700)
    except OSError as error:
        print(f'ERROR: cannot create {output}: {error}; choose a new output directory', file=sys.stderr)
        return 2
    started = timestamp()
    log = output / 'output.log'
    with log.open('wb') as stream:
        code, status, error_text, child_code = run_command(command, stream, cast(float, args.timeout))
    result = {'command': command, 'cwd': str(Path.cwd()), 'started_at': started,
              'finished_at': timestamp(), 'status': status, 'exit_code': code,
              'child_exit_code': child_code, 'error': error_text, 'log': str(log)}
    result_path = output / 'result.json'
    _ = result_path.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(f'{status}: exit {code}; result: {result_path}; log: {log}')
    if code:
        print(f'ERROR: {error_text or "command failed"}', file=sys.stderr)
        print(failure_excerpt(log), file=sys.stderr)
    return code


if __name__ == '__main__':
    raise SystemExit(main())
