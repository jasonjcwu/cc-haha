#!/usr/bin/env python3
"""Tiny Terminal-Bench-style smoke runner for cc-haha CLI.

This is not the official Terminal-Bench Docker harness. It is a local mini set
that checks whether the CLI can inspect files, edit code, and satisfy a verifier.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import time
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
CC_HAHA = ROOT / "bin" / "claude-haha"
RESULTS_DIR = ROOT / "question" / "eval" / "results"
EMPTY_USAGE = {
    "input_tokens": 0,
    "output_tokens": 0,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 0,
}

TASKS = [
    {
        "id": "json-total",
        "instruction": (
            "Fix summarize.py so `python3 summarize.py orders.json` prints exactly "
            "`count=4 total=42.50`. Keep the script simple and deterministic."
        ),
        "files": {
            "orders.json": json.dumps({
                "orders": [
                    {"id": 1, "amount": "12.50"},
                    {"id": 2, "amount": "8.00"},
                    {"id": 3, "amount": "17.25"},
                    {"id": 4, "amount": "4.75"},
                ],
            }, indent=2),
            "summarize.py": (
                "import json\n"
                "import sys\n\n"
                "data = json.load(open(sys.argv[1]))\n"
                "orders = data['orders']\n"
                "total = float(orders[0]['amount'])\n"
                "print(f\"count={len(orders)} total={total:.2f}\")\n"
            ),
            "verify.py": (
                "import subprocess\n"
                "out = subprocess.check_output(['python3', 'summarize.py', 'orders.json'], text=True).strip()\n"
                "assert out == 'count=4 total=42.50', out\n"
            ),
        },
        "verify": ["python3", "verify.py"],
    },
    {
        "id": "email-normalize",
        "instruction": (
            "Fix normalize.py so `python3 normalize.py users.csv` prints normalized, "
            "unique lowercase emails sorted one per line."
        ),
        "files": {
            "users.csv": (
                "name,email\n"
                "Ann, ANN@example.COM \n"
                "Bo,bo@example.com\n"
                "Ann2,ann@example.com\n"
            ),
            "normalize.py": (
                "import csv\n"
                "import sys\n\n"
                "with open(sys.argv[1]) as f:\n"
                "    for row in csv.DictReader(f):\n"
                "        print(row['email'])\n"
            ),
            "verify.py": (
                "import subprocess\n"
                "out = subprocess.check_output(['python3', 'normalize.py', 'users.csv'], text=True).splitlines()\n"
                "assert out == ['ann@example.com', 'bo@example.com'], out\n"
            ),
        },
        "verify": ["python3", "verify.py"],
    },
]


def parse_cli_json(stdout: str) -> dict:
    try:
        data = json.loads(stdout)
    except json.JSONDecodeError:
        return {"text": stdout, "usage": EMPTY_USAGE.copy(), "total_cost_usd": 0}
    return {
        "text": data.get("result") or data.get("message") or stdout,
        "usage": data.get("usage") or EMPTY_USAGE.copy(),
        "total_cost_usd": data.get("total_cost_usd") or 0,
    }


def prepare_task(task: dict, root: Path) -> Path:
    task_dir = root / task["id"]
    if task_dir.exists():
        shutil.rmtree(task_dir)
    task_dir.mkdir(parents=True)
    for name, content in task["files"].items():
        path = task_dir / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
    return task_dir


def run_task(task: dict, run_root: Path, model: str | None, timeout: int) -> dict:
    task_dir = prepare_task(task, run_root)
    prompt = (
        "You are solving a Terminal-Bench-style task in the current directory.\n"
        "Inspect files, edit only what is needed, and run the verifier before finishing.\n\n"
        f"Task: {task['instruction']}\n\n"
        f"Verifier: {' '.join(task['verify'])}\n"
        "Return a short summary when done."
    )
    cmd = [str(CC_HAHA), "--bare", "--output-format", "json"]
    if model:
        cmd.extend(["--model", model])
    cmd.extend(["-p", prompt])

    start = time.time()
    try:
        cli = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            cwd=task_dir,
            timeout=timeout,
            env=os.environ.copy(),
        )
        elapsed = time.time() - start
        parsed = parse_cli_json(cli.stdout or "")
        verify = subprocess.run(
            task["verify"],
            capture_output=True,
            text=True,
            cwd=task_dir,
            timeout=30,
        )
        return {
            "task_id": task["id"],
            "mode": "terminal-mini",
            "model": model,
            "passed": verify.returncode == 0,
            "wall_seconds": round(elapsed, 1),
            "exit_code": cli.returncode,
            "verify_exit_code": verify.returncode,
            "verify_stdout": (verify.stdout or "")[-500:],
            "verify_stderr": (verify.stderr or "")[-500:],
            "usage": parsed["usage"],
            "total_cost_usd": parsed["total_cost_usd"],
            "stdout_preview": parsed["text"][-500:],
            "stderr_preview": (cli.stderr or "")[-500:],
        }
    except subprocess.TimeoutExpired:
        return {
            "task_id": task["id"],
            "mode": "terminal-mini",
            "model": model,
            "passed": False,
            "wall_seconds": timeout,
            "exit_code": -1,
            "verify_exit_code": None,
            "usage": EMPTY_USAGE.copy(),
            "total_cost_usd": 0,
            "error": "timeout",
        }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=len(TASKS))
    parser.add_argument("--model", default="haiku")
    parser.add_argument("--timeout", type=int, default=300)
    parser.add_argument("--workdir", default="/tmp/cc-haha-terminal-mini")
    parser.add_argument("--output", default=None)
    args = parser.parse_args()

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    run_root = Path(args.workdir) / ts
    results = [
        run_task(task, run_root, args.model, args.timeout)
        for task in TASKS[:args.limit]
    ]

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    output = Path(args.output) if args.output else RESULTS_DIR / f"terminal_mini_{ts}.json"
    output.write_text(json.dumps(results, indent=2))

    passed = sum(1 for row in results if row["passed"])
    total_tokens = sum(
        sum((row.get("usage") or {}).get(k, 0) or 0 for k in EMPTY_USAGE)
        for row in results
    )
    total_cost = sum(row.get("total_cost_usd", 0) or 0 for row in results)
    print(f"Terminal mini: {passed}/{len(results)} passed | tokens={total_tokens} | cost=${total_cost:.6f}")
    print(f"Saved: {output}")


if __name__ == "__main__":
    main()
