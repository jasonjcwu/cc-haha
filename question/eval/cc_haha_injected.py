#!/usr/bin/env python3
"""
cc-haha CLI Injected Runner

Official-like dynamic advisor loop: executor requests strategic advice only
when useful, then continues with the advisor response in context.
Usage:
  source ../../scripts/set-env-ds.sh && python3 cc_haha_injected.py \
    --instance-json '{...}' --executor-model haiku --advisor-model deepseek
"""

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
import re
from typing import Optional

_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))  # cc-haha project root
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from prompt_templates import (
    build_official_like_advisor_prompt,
    build_official_like_correction_prompt,
    build_official_like_continue_prompt,
    build_official_like_initial_prompt,
    extract_advisor_request,
    extract_patch,
)

# ─── Advisor API 配置 ────────────────────────────────────────────────

ADVISOR_API_CONFIG = {
    "deepseek": {
        "provider": "openai-compatible",
        "base_url": "https://api.deepseek.com/v1",
        "model": "deepseek-v4-pro",
    },
    "glm": {
        "provider": "anthropic-compatible",
        "base_url": "https://open.bigmodel.cn/api/anthropic",
        "model": "glm-5.1",
    },
}

EMPTY_USAGE = {
    "input_tokens": 0,
    "output_tokens": 0,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 0,
}
RETRYABLE_HTTP_STATUS = {429, 500, 502, 503, 504}


def combine_usage(items: list[dict]) -> dict:
    total = EMPTY_USAGE.copy()
    for usage in items:
        for key in total:
            total[key] += usage.get(key, 0) or 0
    return total


def parse_cli_json(stdout: str) -> dict:
    try:
        data = json.loads(stdout)
    except json.JSONDecodeError:
        return {
            "text": stdout,
            "usage": EMPTY_USAGE.copy(),
            "total_cost_usd": 0,
        }
    return {
        "text": data.get("result") or data.get("message") or stdout,
        "usage": data.get("usage") or EMPTY_USAGE.copy(),
        "total_cost_usd": data.get("total_cost_usd") or 0,
        "raw": data,
    }


def redact_public_text(text: str, limit: int = 2000) -> str:
    """Keep public tool context useful without forwarding likely credentials."""
    redacted = re.sub(
        r"(?i)(api[_-]?key|authorization|token|secret|password)([\"'\s:=]+)([^\s,\"']+)",
        r"\1\2[REDACTED]",
        text,
    )
    if len(redacted) <= limit:
        return redacted
    return redacted[:limit] + "\n...[truncated]"


def render_public_block(block: dict) -> str:
    block_type = block.get("type")
    if block_type == "text":
        return redact_public_text(block.get("text", ""))
    if block_type in ("tool_use", "server_tool_use"):
        tool_input = json.dumps(block.get("input", {}), ensure_ascii=False, sort_keys=True)
        return f"[{block_type} {block.get('name', 'unknown')}]\n{redact_public_text(tool_input)}"
    if block_type == "tool_result":
        content = block.get("content", "")
        if not isinstance(content, str):
            content = json.dumps(content, ensure_ascii=False, sort_keys=True)
        status = " error" if block.get("is_error") else ""
        return f"[tool_result{status} {block.get('tool_use_id', '')}]\n{redact_public_text(content)}"
    if block_type == "advisor_tool_result":
        content = block.get("content", {})
        if isinstance(content, dict):
            content = content.get("text") or json.dumps(content, ensure_ascii=False, sort_keys=True)
        return f"[advisor_tool_result]\n{redact_public_text(str(content))}"
    return ""


def parse_cli_stream_json(stdout: str) -> dict:
    """Parse cc-haha NDJSON and retain bounded public tool history for advisor context."""
    events = []
    transcript_parts = []
    assistant_text = []
    result_data = {}

    for line in stdout.splitlines():
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        events.append(event)
        event_type = event.get("type")
        if event_type in ("assistant", "user"):
            content = event.get("message", {}).get("content", [])
            if not isinstance(content, list):
                continue
            rendered = []
            for block in content:
                if not isinstance(block, dict):
                    continue
                block_text = render_public_block(block)
                if block_text:
                    rendered.append(block_text)
                if event_type == "assistant" and block.get("type") == "text" and block.get("text"):
                    assistant_text.append(block["text"])
            if rendered:
                transcript_parts.append(f"[{event_type}]\n" + "\n\n".join(rendered))
        elif event_type == "result":
            result_data = event

    result_text = result_data.get("result")
    if not isinstance(result_text, str):
        result_text = "\n\n".join(assistant_text)
    public_transcript = "\n\n".join(transcript_parts)
    return {
        "text": result_text or "",
        "public_transcript": public_transcript[-18000:],
        "usage": result_data.get("usage") or EMPTY_USAGE.copy(),
        "total_cost_usd": result_data.get("total_cost_usd") or 0,
        "stream_event_count": len(events),
        "raw": result_data,
    }


def classify_cli_error(stdout: str, stderr: str, returncode: int) -> Optional[str]:
    if returncode == 0:
        return None
    combined = f"{stdout}\n{stderr}"
    if "rate_limit_error" in combined or "API Error: 429" in combined:
        return "rate_limit"
    return f"exit {returncode}"


def get_advisor_client(advisor_model: str):
    """创建外部 advisor 的 OpenAI 客户端"""
    config = ADVISOR_API_CONFIG.get(advisor_model, ADVISOR_API_CONFIG["deepseek"])
    if advisor_model == "glm":
        key = (
            os.environ.get("ANTHROPIC_AUTH_TOKEN")
            or os.environ.get("ANTHROPIC_API_KEY")
            or os.environ.get("GLM_API_KEY")
            or os.environ.get("GLMCODE_API_KEY")
            or ""
        )
        base_url = os.environ.get("ANTHROPIC_BASE_URL") or config["base_url"]
    else:
        key = (
            os.environ.get("DEEPSEEK_API_KEY")
            or os.environ.get("OPENAI_API_KEY")
            or os.environ.get("ANTHROPIC_API_KEY")
            or ""
        )
        base_url = config["base_url"]
    # Read from auth.json if env not set
    if not key:
        try:
            with open(os.path.expanduser("~/.hermes/auth.json")) as f:
                auth = json.load(f)
            pool = auth.get("credential_pool", {})
            if advisor_model == "glm":
                key = pool.get("custom:glmcode", [{}])[0].get("access_token", "")
            else:
                key = pool.get("deepseek", [{}])[0].get("access_token", "")
        except Exception:
            pass
    return {
        "api_key": key,
        "base_url": base_url,
        "provider": config["provider"],
    }, config["model"]


def call_advisor(client: dict, model: str, prompt: str) -> dict:
    """调用外部 advisor API"""
    if client["provider"] == "anthropic-compatible":
        return call_anthropic_advisor(client, model, prompt)
    return call_openai_compatible_advisor(client, model, prompt)


def call_openai_compatible_advisor(client: dict, model: str, prompt: str) -> dict:
    body = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": "You are an expert code review advisor."},
            {"role": "user", "content": prompt},
        ],
        "max_tokens": 1024,
        "temperature": 0.1,
    }).encode("utf-8")
    request = urllib.request.Request(
        client["base_url"].rstrip("/") + "/chat/completions",
        data=body,
        headers={
            "Authorization": f"Bearer {client['api_key']}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            data = json.loads(response.read().decode("utf-8"))
        usage = data.get("usage") or {}
        return {
            "text": data.get("choices", [{}])[0].get("message", {}).get("content", "") or "",
            "usage": {
                "input_tokens": usage.get("prompt_tokens", 0) or 0,
                "output_tokens": usage.get("completion_tokens", 0) or 0,
                "cache_creation_input_tokens": 0,
                "cache_read_input_tokens": 0,
            },
        }
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        return {"text": f"[Advisor error: HTTP {e.code}: {detail[:200]}]", "usage": EMPTY_USAGE.copy()}
    except Exception as e:
        return {"text": f"[Advisor error: {str(e)[:100]}]", "usage": EMPTY_USAGE.copy()}


def call_anthropic_advisor(client: dict, model: str, prompt: str) -> dict:
    body = json.dumps({
        "model": model,
        "max_tokens": 1024,
        "system": "You are an expert code review advisor.",
        "messages": [
            {"role": "user", "content": prompt},
        ],
    }).encode("utf-8")
    request = urllib.request.Request(
        client["base_url"].rstrip("/") + "/v1/messages",
        data=body,
        headers={
            "Authorization": f"Bearer {client['api_key']}",
            "x-api-key": client["api_key"],
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    for attempt in range(2):
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                data = json.loads(response.read().decode("utf-8"))
            text = ""
            for block in data.get("content", []):
                if block.get("type") == "text":
                    text = block.get("text", "") or ""
                    break
            return {
                "text": text,
                "usage": data.get("usage") or EMPTY_USAGE.copy(),
            }
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", errors="replace")
            if e.code in RETRYABLE_HTTP_STATUS and attempt == 0:
                time.sleep(1)
                continue
            return {"text": f"[Advisor error: HTTP {e.code}: {detail[:200]}]", "usage": EMPTY_USAGE.copy()}
        except Exception as e:
            return {"text": f"[Advisor error: {str(e)[:100]}]", "usage": EMPTY_USAGE.copy()}


def read_git_diff(repo_dir: str) -> str:
    """Return the current worktree diff when the CLI does not print one."""
    try:
        result = subprocess.run(
            ["git", "diff", "--no-ext-diff"],
            capture_output=True, text=True, cwd=repo_dir, timeout=30,
        )
    except Exception:
        return ""
    return result.stdout or ""


# ─── cc-haha CLI 调用 ────────────────────────────────────────────────

def run_cc_haha(
    prompt: str,
    workdir: str,
    timeout: int = 600,
    executor_model: Optional[str] = None,
) -> tuple:
    """Run cc-haha CLI with a prompt and capture public tool history."""
    cmd = [
        os.path.join(_ROOT, "bin", "claude-haha"),
        "--bare",
        "--verbose",
        "--output-format", "stream-json",
    ]
    if executor_model:
        cmd.extend(["--model", executor_model])
    cmd.extend(["-p", prompt])
    env = os.environ.copy()
    start = time.time()
    try:
        result = subprocess.run(
            cmd, input="", capture_output=True, text=True,
            timeout=timeout, cwd=workdir, env=env,
        )
        elapsed = time.time() - start
        parsed = parse_cli_stream_json(result.stdout or "")
        error = classify_cli_error(parsed["text"], result.stderr or "", result.returncode)
        return (
            parsed["text"],
            result.stderr or "",
            elapsed,
            error,
            parsed["usage"],
            parsed["total_cost_usd"],
            parsed["public_transcript"],
            parsed["stream_event_count"],
        )
    except subprocess.TimeoutExpired:
        return "", "", time.time() - start, "timeout", EMPTY_USAGE.copy(), 0, "", 0
    except Exception as e:
        return "", "", time.time() - start, str(e)[:200], EMPTY_USAGE.copy(), 0, "", 0


# ─── Official-like dynamic advisor loop ─────────────────────────────

def run_injected(
    instance: dict,
    advisor_model: str = "deepseek",
    timeout: int = 600,
    workdir: str = "/tmp/cc-haha-swe",
    executor_model: Optional[str] = None,
    force_pre_final_review: bool = False,
) -> dict:
    """Run a single SWE-bench task with official-like dynamic advisor calls."""
    iid = instance["instance_id"]
    repo = instance.get("repo", "")
    base_commit = instance.get("base_commit", "")

    # Prepare workdir
    repo_dir = os.path.join(workdir, iid.replace("/", "__"))
    os.makedirs(repo_dir, exist_ok=True)

    # Clone repo if needed
    setup_error = None
    if repo and base_commit and not os.path.exists(os.path.join(repo_dir, ".git")):
        cache_candidates = [
            os.path.join(os.path.dirname(workdir), iid.replace("/", "__")),
            os.path.join("/tmp", "cc-haha-swe", iid.replace("/", "__")),
        ]
        clone_url = f"https://github.com/{repo}.git"
        for cache_dir in cache_candidates:
            if cache_dir != repo_dir and os.path.exists(os.path.join(cache_dir, ".git")):
                clone_url = cache_dir
                break
        try:
            clone_result = subprocess.run(
                ["git", "clone", clone_url, repo_dir],
                capture_output=True, text=True, timeout=120,
            )
            if clone_result.returncode != 0:
                setup_error = f"git clone failed: {(clone_result.stderr or clone_result.stdout)[-300:]}"
            else:
                checkout_result = subprocess.run(
                    ["git", "checkout", base_commit],
                    capture_output=True, text=True, cwd=repo_dir, timeout=30,
                )
                if checkout_result.returncode != 0:
                    setup_error = f"git checkout failed: {(checkout_result.stderr or checkout_result.stdout)[-300:]}"
        except Exception as e:
            setup_error = f"repo setup failed: {e}"

    if repo and base_commit and not os.path.exists(os.path.join(repo_dir, ".git")):
        setup_error = setup_error or "repo setup failed: missing .git directory"

    if repo and base_commit and os.path.exists(os.path.join(repo_dir, ".git")):
        checkout_result = subprocess.run(
            ["git", "checkout", base_commit],
            capture_output=True, text=True, cwd=repo_dir, timeout=30,
        )
        if checkout_result.returncode != 0:
            setup_error = f"git checkout failed: {(checkout_result.stderr or checkout_result.stdout)[-300:]}"

    if setup_error:
        return {
            "instance_id": iid,
            "repo": repo,
            "mode": "injected",
            "executor_model": executor_model,
            "advisor_model": advisor_model,
            "phases": [],
            "total_wall_seconds": 0,
            "has_patch": False,
            "patch": "",
            "patch_len": 0,
            "error": setup_error,
        }

    # Setup advisor
    client, advisor_api_model = get_advisor_client(advisor_model)

    results = {
        "instance_id": iid,
        "repo": repo,
        "mode": "injected",
        "strategy": (
            "official-like-dynamic-advisor+forced-pre-final-review"
            if force_pre_final_review
            else "official-like-dynamic-advisor"
        ),
        "executor_model": executor_model,
        "advisor_model": advisor_model,
        "phases": [],
        "advisor_calls": [],
        "executor_usage": EMPTY_USAGE.copy(),
        "advisor_usage": EMPTY_USAGE.copy(),
        "usage": EMPTY_USAGE.copy(),
        "total_cost_usd": 0,
        "advisor_cost_usd": 0,
        "total_wall_seconds": 0,
    }

    max_advisor_calls = 3
    max_executor_turns = 4
    per_turn_timeout = max(240, timeout // 2)
    transcript_parts = []
    advisor_feedback = ""
    pre_final_review_done = False
    prompt = build_official_like_initial_prompt(instance, max_advisor_calls=max_advisor_calls)

    for turn in range(1, max_executor_turns + 1):
        remaining_calls = max_advisor_calls - len(results["advisor_calls"])
        print(f"  Executor turn {turn}/{max_executor_turns} (advisor remaining: {remaining_calls})...")
        (
            turn_out,
            turn_stderr,
            turn_time,
            turn_err,
            turn_usage,
            turn_cost,
            turn_public_transcript,
            turn_stream_event_count,
        ) = run_cc_haha(
            prompt, repo_dir, per_turn_timeout, executor_model=executor_model,
        )
        results["phases"].append({
            "phase": f"executor_turn_{turn}",
            "time": round(turn_time, 1),
            "stdout_preview": turn_out[-500:],
            "stderr_preview": turn_stderr[-500:],
            "public_transcript_preview": turn_public_transcript[-1000:],
            "stream_event_count": turn_stream_event_count,
            "usage": turn_usage,
            "total_cost_usd": turn_cost,
            "error": turn_err,
        })
        results["total_wall_seconds"] += turn_time
        results["total_cost_usd"] += turn_cost
        transcript_parts.append(
            f"## Executor Turn {turn}\n{turn_public_transcript or turn_out[-5000:]}"
        )
        print(f"    done in {turn_time:.0f}s")

        if turn_err:
            print(f"    ⚠️  executor turn {turn} error: {turn_err}")
            if turn_err == "rate_limit":
                results["error"] = "rate_limit"
                break

        current_diff = read_git_diff(repo_dir)
        all_output = "\n".join(transcript_parts)
        patch = current_diff or extract_patch(all_output)
        advisor_request = extract_advisor_request(turn_out)

        if advisor_request and remaining_calls > 0:
            advisor_turn = len(results["advisor_calls"]) + 1
            print(f"  Advisor {advisor_turn}/{max_advisor_calls}: strategic guidance...")
            advisor_prompt = build_official_like_advisor_prompt(
                instance,
                "\n\n".join(transcript_parts),
                advisor_request,
                current_diff=current_diff,
            )
            advisor_result = call_advisor(client, advisor_api_model, advisor_prompt)
            advisor_feedback = advisor_result["text"]
            results["advisor_calls"].append({
                "turn": advisor_turn,
                "kind": "executor_request",
                "request_preview": advisor_request[:500],
                "feedback_preview": advisor_feedback[:500],
                "usage": advisor_result["usage"],
            })
            transcript_parts.append(
                f"## Advisor Response {advisor_turn}\n{advisor_feedback[-3000:]}"
            )
            print(f"    feedback: {advisor_feedback[:100]}...")
            prompt = build_official_like_continue_prompt(
                instance,
                "\n\n".join(transcript_parts),
                advisor_feedback,
                max_advisor_calls - len(results["advisor_calls"]),
                current_diff=current_diff,
            )
            continue

        if (
            force_pre_final_review
            and
            patch
            and len(patch.strip()) > 10
            and remaining_calls > 0
            and turn < max_executor_turns
            and not pre_final_review_done
        ):
            advisor_turn = len(results["advisor_calls"]) + 1
            review_request = (
                "Perform a pre-final review of the current diff. Look for missing "
                "adjacent behavior, guards, hooks, or related functions. Identify "
                "unnecessary edits and give the smallest correction plan. Trace each "
                "newly relied-on helper, hook, or printer path one layer downstream; "
                "do not assume it already handles the new input correctly. Return a "
                "checklist. Follow the changed data path through source, filtering, "
                "hooks or callbacks, downstream consumers, and error fallbacks. "
                "Compare adjacent established paths, verify test assertions come "
                "from the issue's external behavior rather than the current output, "
                "and require focused test evidence before finishing."
            )
            print(f"  Advisor {advisor_turn}/{max_advisor_calls}: pre-final diff review...")
            advisor_prompt = build_official_like_advisor_prompt(
                instance,
                "\n\n".join(transcript_parts),
                review_request,
                current_diff=current_diff,
            )
            advisor_result = call_advisor(client, advisor_api_model, advisor_prompt)
            advisor_feedback = advisor_result["text"]
            results["advisor_calls"].append({
                "turn": advisor_turn,
                "kind": "pre_final_review",
                "request_preview": review_request[:500],
                "feedback_preview": advisor_feedback[:500],
                "usage": advisor_result["usage"],
            })
            transcript_parts.append(
                f"## Advisor Pre-Final Review {advisor_turn}\n{advisor_feedback[-3000:]}"
            )
            pre_final_review_done = True
            prompt = build_official_like_correction_prompt(
                instance,
                "\n\n".join(transcript_parts),
                advisor_feedback,
                max_advisor_calls - len(results["advisor_calls"]),
                current_diff=current_diff,
            )
            continue

        if patch and len(patch.strip()) > 10:
            break

        if turn < max_executor_turns:
            prompt = build_official_like_continue_prompt(
                instance,
                "\n\n".join(transcript_parts),
                advisor_feedback or "No advisor guidance has been requested yet. Continue from repository evidence.",
                remaining_calls,
                current_diff=current_diff,
            )

    # ── 提取最终 patch ──
    all_output = "\n".join(transcript_parts)
    patch = read_git_diff(repo_dir) or extract_patch(all_output)
    results["has_patch"] = bool(patch and len(patch.strip()) > 10)
    results["patch"] = patch
    results["patch_len"] = len(patch)
    results["total_wall_seconds"] = round(results["total_wall_seconds"], 1)
    results["total_cost_usd"] = round(results["total_cost_usd"], 6)
    results["executor_usage"] = combine_usage([p.get("usage", {}) for p in results["phases"]])
    results["advisor_usage"] = combine_usage([a.get("usage", {}) for a in results["advisor_calls"]])
    results["usage"] = combine_usage([results["executor_usage"], results["advisor_usage"]])
    results["advisor_feedback_1"] = (
        results["advisor_calls"][0]["feedback_preview"]
        if len(results["advisor_calls"]) > 0 else ""
    )
    results["advisor_feedback_2"] = (
        results["advisor_calls"][1]["feedback_preview"]
        if len(results["advisor_calls"]) > 1 else ""
    )

    return results


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--instance-json", type=str, default=None)
    parser.add_argument("--instance-json-file", type=str, default=None)
    parser.add_argument("--advisor-model", choices=["deepseek", "glm"], default="deepseek")
    parser.add_argument("--timeout", type=int, default=600)
    parser.add_argument("--workdir", type=str, default="/tmp/cc-haha-swe")
    parser.add_argument("--executor-model", type=str, default=None)
    parser.add_argument(
        "--force-pre-final-review",
        action="store_true",
        help="Experimental A/B mode: force one runner-level pre-final advisor review.",
    )
    args = parser.parse_args()

    if args.instance_json:
        instance = json.loads(args.instance_json)
    elif args.instance_json_file:
        with open(args.instance_json_file) as f:
            instance = json.load(f)
    else:
        print("Error: need --instance-json or --instance-json-file")
        sys.exit(1)

    result = run_injected(
        instance,
        advisor_model=args.advisor_model,
        timeout=args.timeout,
        workdir=args.workdir,
        executor_model=args.executor_model,
        force_pre_final_review=args.force_pre_final_review,
    )
    print(json.dumps(result, indent=2))
