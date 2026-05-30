#!/usr/bin/env python3
"""
cc-haha Tool-call Advisor — 方案 A

Tool-call 拦截模式：
  executor 跑任务（多轮循环，调工具）
    └─ 遇到不确定 → 主动调 ask_advisor
         └─ 框架层拦截 tool call
              └─ 把当前对话上下文 + 问题发给 advisor
                   └─ advisor 回 3-5 句 guidance → 作为 tool result 注入
                        └─ executor 拿到 guidance 继续跑

对比 runner.py（Injected 三阶段强制注入）：
  runner.py = 框架外部强行分阶段，阶段间注入 advisor
  tool_advisor.py = executor 内部自主调 advisor，框架只做拦截转发

Usage:
  python benchmark/tool_advisor.py --executor deepseek-v4-flash --advisor deepseek-chat --limit 1
  python benchmark/tool_advisor.py --executor deepseek-v4-flash --limit 1   # solo mode
"""

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Optional

from openai import OpenAI


# ═══════════════════════════════════════════════════════════════
# Model Config (from Hermes auth.json, same pattern as advisor-eval)
# ═══════════════════════════════════════════════════════════════

def load_api_keys() -> dict:
    """Extract API keys from Hermes auth.json."""
    auth_path = os.path.expanduser("~/.hermes/auth.json")
    if not os.path.exists(auth_path):
        return {}
    with open(auth_path) as f:
        auth = json.load(f)
    pool = auth.get("credential_pool", {})
    keys = {}
    # DeepSeek
    ds_creds = pool.get("deepseek", []) or pool.get("custom:deepseek", [])
    if ds_creds:
        keys["deepseek"] = {
            "api_key": ds_creds[0]["access_token"],
            "base_url": ds_creds[0].get("base_url", "https://api.deepseek.com/v1"),
        }
    # GLM
    glm_creds = pool.get("custom:glmcode", [])
    if glm_creds:
        keys["glm"] = {
            "api_key": glm_creds[0]["access_token"],
            "base_url": glm_creds[0]["base_url"],
        }
    return keys


_KEYS = load_api_keys()

MODELS = {
    "deepseek-chat": {
        "name": "deepseek-chat",
        "base_url": _KEYS.get("deepseek", {}).get("base_url", "https://api.deepseek.com/v1"),
        "api_key": _KEYS.get("deepseek", {}).get("api_key", ""),
        "max_tokens": 8192,
    },
    "deepseek-v4-flash": {
        "name": "deepseek-chat",  # API 侧映射
        "base_url": _KEYS.get("deepseek", {}).get("base_url", "https://api.deepseek.com/v1"),
        "api_key": _KEYS.get("deepseek", {}).get("api_key", ""),
        "max_tokens": 8192,
    },
    "glm-5.1": {
        "name": "glm-5.1",
        "base_url": _KEYS.get("glm", {}).get("base_url", ""),
        "api_key": _KEYS.get("glm", {}).get("api_key", ""),
        "max_tokens": 4096,
    },
    "glm-4.5-air": {
        "name": "glm-4.5-air",
        "base_url": _KEYS.get("glm", {}).get("base_url", ""),
        "api_key": _KEYS.get("glm", {}).get("api_key", ""),
        "max_tokens": 4096,
    },
}


def get_model(name: str) -> dict:
    if name not in MODELS:
        raise ValueError(f"Unknown model: {name}. Available: {list(MODELS.keys())}")
    cfg = MODELS[name]
    if not cfg["api_key"]:
        raise ValueError(f"No API key for {name}")
    return cfg


# ═══════════════════════════════════════════════════════════════
# Prompts
# ═══════════════════════════════════════════════════════════════

EXECUTOR_SYSTEM_PROMPT = """You are a coding agent. You solve software engineering tasks by reading code, editing files, and running commands.

You have these tools:
- file_read: Read a file's content (use for exploration)
- file_edit: Replace an exact string in a file with a new string
- bash_run: Run a bash command and get output
- ask_advisor: Consult a more capable model for strategic guidance

**Mandatory Rules (these are hard constraints, not suggestions):**

◈ RULE 1 — You MUST call ask_advisor before your FIRST use of file_edit
  Sequence: explore codebase → call ask_advisor → implement → call ask_advisor before done
  Violation: any file_edit without a prior ask_advisor call = task FAILED

◈ RULE 2 — You MUST call ask_advisor before declaring the task complete
  Even if you're confident, do a final advisor check for edge cases you might have missed

◈ RULE 3 — If you encounter an error you don't understand, call ask_advisor

◈ RULE 4 — If your approach fails after 1+ attempts, call ask_advisor

**When NOT to use ask_advisor:**
- Reading files or running simple commands during initial exploration (this is information gathering, not substantive work)

**How to treat advisor advice:**
- Take the advisor's guidance seriously — it has broader context
- If you have concrete evidence that contradicts the advice, adapt
- If you find a conflict between the advice and your findings, call ask_advisor again to reconcile

Be concise. Focus on solving the task. Show your reasoning briefly."""

ADVISOR_SYSTEM_PROMPT = """You are an advisor to a coding agent. The agent is working on a software engineering task.

Review the conversation history and provide strategic guidance. Your advice should be:
- A clear plan or course correction (not code to copy-paste)
- Focused on the key decision or obstacle
- CONCISE (under 80 words)
- If the agent is on the right track, say so briefly and let it continue
- If the agent should stop (task is already solved), say "STOP: the task appears to be solved."

Do NOT write code. Do NOT call tools. Just provide strategic guidance."""


# Tool definitions for OpenAI function calling
TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "file_read",
            "description": "Read the content of a file",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Path to the file"}
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "file_edit",
            "description": "Replace an exact string in a file with a new string. The old_string must match exactly.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Path to the file"},
                    "old_string": {"type": "string", "description": "Exact string to find"},
                    "new_string": {"type": "string", "description": "Replacement string"},
                },
                "required": ["path", "old_string", "new_string"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "bash_run",
            "description": "Run a bash command and return its output",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "Bash command to run"},
                    "timeout": {"type": "integer", "description": "Timeout in seconds (default 30)", "default": 30},
                },
                "required": ["command"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "ask_advisor",
            "description": "Consult a more capable model for strategic guidance. Use when stuck, unsure about approach, or need architectural advice.",
            "parameters": {
                "type": "object",
                "properties": {
                    "question": {
                        "type": "string",
                        "description": "What you need guidance on. Be specific about where you're stuck.",
                    }
                },
                "required": ["question"],
            },
        },
    },
]

# Solo mode only has the first 3 tools
TOOLS_SOLO = TOOLS[:3]


# ═══════════════════════════════════════════════════════════════
# Agent Loop
# ═══════════════════════════════════════════════════════════════

class ToolAdvisorAgent:
    """方案 A: Tool-call 拦截模式 agent loop."""

    def __init__(self, executor_model: str, advisor_model: str = None,
                 max_turns: int = 15, workdir: str = "/tmp/cc-haha-workspace",
                 verbose: bool = True):
        self.executor_cfg = get_model(executor_model)
        self.advisor_cfg = get_model(advisor_model) if advisor_model else None
        self.max_turns = max_turns
        self.workdir = workdir
        self.verbose = verbose
        self.messages: list[dict] = []
        self.advisor_calls = 0
        self.has_called_advisor = False  # RULE 1 tracker

        # Create OpenAI clients
        self.executor_client = OpenAI(
            api_key=self.executor_cfg["api_key"],
            base_url=self.executor_cfg["base_url"],
        )
        self.advisor_client = None
        if self.advisor_cfg:
            self.advisor_client = OpenAI(
                api_key=self.advisor_cfg["api_key"],
                base_url=self.advisor_cfg["base_url"],
            )

    def log(self, msg: str):
        if self.verbose:
            print(f"  {msg}")

    def execute_tool(self, tool_name: str, args: dict) -> str:
        """Execute a tool call and return the result."""
        import subprocess

        if tool_name == "file_read":
            path = args["path"]
            if not path.startswith("/"):
                path = f"{self.workdir}/{path}"
            try:
                with open(path) as f:
                    content = f.read()
                if len(content) > 10000:
                    content = content[:10000] + f"\n... (truncated, {len(content)} chars total)"
                return content
            except FileNotFoundError:
                return f"Error: File not found: {path}"
            except Exception as e:
                return f"Error reading file: {e}"

        elif tool_name == "file_edit":
            path = args["path"]
            if not path.startswith("/"):
                path = f"{self.workdir}/{path}"
            try:
                with open(path) as f:
                    content = f.read()
                old = args["old_string"]
                new = args["new_string"]
                if old not in content:
                    return f"Error: old_string not found in {path}"
                content = content.replace(old, new, 1)
                with open(path, "w") as f:
                    f.write(content)
                return f"Successfully edited {path}"
            except Exception as e:
                return f"Error editing file: {e}"

        elif tool_name == "bash_run":
            cmd = args["command"]
            timeout = args.get("timeout", 30)
            try:
                result = subprocess.run(
                    cmd, shell=True, capture_output=True, text=True,
                    timeout=timeout, cwd=self.workdir,
                )
                output = result.stdout
                if result.stderr:
                    output += f"\nSTDERR:\n{result.stderr}"
                if result.returncode != 0:
                    output += f"\nExit code: {result.returncode}"
                if len(output) > 8000:
                    output = output[:8000] + "... (truncated)"
                return output
            except subprocess.TimeoutExpired:
                return f"Error: Command timed out after {timeout}s"
            except Exception as e:
                return f"Error running command: {e}"

        elif tool_name == "ask_advisor":
            question = args.get("question") or args.get("message") or str(args)
            return self.call_advisor(question)

        else:
            return f"Error: Unknown tool {tool_name}"

    def sanitize_for_advisor(self, messages: list) -> list:
        """Clean messages for advisor: strip tool_calls/tool roles, convert to text."""
        clean = []
        for msg in messages:
            role = msg.get("role")
            content = msg.get("content", "")
            if role == "tool":
                clean.append({"role": "user", "content": f"[Tool output]: {content}"})
            elif role == "assistant" and msg.get("tool_calls"):
                parts = []
                if content:
                    parts.append(content)
                for tc in msg["tool_calls"]:
                    fn = tc.get("function", {})
                    args_str = fn.get("arguments", "")[:200]
                    parts.append(f"[Called {fn.get('name','?')}({args_str})]")
                clean.append({"role": "assistant", "content": "\n".join(parts)})
            elif content:
                clean.append({"role": role, "content": content})
        return clean

    def call_advisor(self, question: str) -> str:
        """Call the advisor model with conversation context."""
        if not self.advisor_client:
            return "Error: No advisor model configured."

        self.has_called_advisor = True
        self.advisor_calls += 1

        advisor_messages = [{"role": "system", "content": ADVISOR_SYSTEM_PROMPT}]
        advisor_messages.extend(self.sanitize_for_advisor(self.messages))
        advisor_messages.append({
            "role": "user",
            "content": f"[Advisor request]: {question}\n\n(Advisor: keep your guidance under 80 words — focused starting point, not comprehensive plan.)",
        })

        try:
            resp = self.advisor_client.chat.completions.create(
                model=self.advisor_cfg["name"],
                messages=advisor_messages,
                max_tokens=1024,
                temperature=0.3,
            )
            advice = resp.choices[0].message.content or ""
            self.log(f"← Advisor ({len(advice)} chars)")
            return advice
        except Exception as e:
            self.log(f"← Advisor ERROR: {e}")
            return f"Advisor unavailable: {e}"

    def run(self, problem_statement: str, instance_id: str = "unknown",
            timeout: int = 600) -> dict:
        """Run the agent on a task, returns result dict."""
        os.makedirs(self.workdir, exist_ok=True)

        start_time = time.time()
        result = {
            "instance_id": instance_id,
            "mode": "tool-advisor" if self.advisor_client else "solo",
            "executor": self.executor_cfg["name"],
            "advisor": self.advisor_cfg["name"] if self.advisor_cfg else None,
            "advisor_calls": 0,
            "started_at": datetime.now().isoformat(),
        }

        # Initial message
        self.messages = [{"role": "system", "content": EXECUTOR_SYSTEM_PROMPT}]
        self.messages.append({"role": "user", "content": problem_statement})

        tools = TOOLS if self.advisor_client else TOOLS_SOLO

        turn = 0
        while turn < self.max_turns:
            turn += 1
            elapsed = time.time() - start_time
            if elapsed > timeout:
                self.log(f"⏱ Timeout after {elapsed:.0f}s")
                self.messages.append({"role": "assistant", "content": "[TIMEOUT]"})
                break

            # Call executor
            self.log(f"Turn {turn}/{self.max_turns} ({elapsed:.0f}s elapsed)...")
            try:
                resp = self.executor_client.chat.completions.create(
                    model=self.executor_cfg["name"],
                    messages=self.messages,
                    tools=tools,
                    max_tokens=4096,
                    temperature=0,
                )
            except Exception as e:
                self.log(f"  ⚠ Executor API error: {e}")
                self.messages.append({
                    "role": "assistant",
                    "content": f"[API Error: {e}]",
                })
                continue

            choice = resp.choices[0]
            msg = choice.message

            # Check if executor wants to stop (no tool calls + explicit done)
            if not msg.tool_calls or len(msg.tool_calls) == 0:
                content = msg.content or ""
                self.messages.append({"role": "assistant", "content": content})

                # Detect completion signals
                done_signals = [
                    "<<<DONE>>>", "<<<ENDPATCH>>>", "<<<PATCH>>>",
                    "Output Format", "the patch in unified diff format",
                ]
                if any(s in content for s in done_signals) or turn >= self.max_turns:
                    self.log(f"  ✓ Done (turn {turn})")
                    result["output"] = content
                    result["patch"] = extract_patch(content)
                    break
                continue  # No tool calls, keep going (model is reasoning)

            # Process tool calls
            for tc in msg.tool_calls:
                fn = tc.function
                tool_name = fn.name
                try:
                    args = json.loads(fn.arguments)
                except json.JSONDecodeError:
                    args = {}

                self.log(f"  → {tool_name}({json.dumps(args)[:80]})")

                # Execute tool
                tool_result = self.execute_tool(tool_name, args)

                # Add assistant message with tool call
                self.messages.append({
                    "role": "assistant",
                    "content": msg.content or "",
                    "tool_calls": [tc],
                })

                # Add tool result
                self.messages.append({
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": tool_result,
                })

        result["advisor_calls"] = self.advisor_calls
        result["turns"] = turn
        result["duration_seconds"] = round(time.time() - start_time, 1)
        result["completed_at"] = datetime.now().isoformat()

        # Final patch extraction from last assistant message
        if "output" not in result:
            # Find last assistant message
            for msg in reversed(self.messages):
                if msg["role"] == "assistant" and msg.get("content"):
                    result["output"] = msg["content"]
                    result["patch"] = extract_patch(msg["content"])
                    break

        return result


# ═══════════════════════════════════════════════════════════════
# Patch Extraction
# ═══════════════════════════════════════════════════════════════

def extract_patch(output: str) -> Optional[str]:
    if not output:
        return None
    for pattern in [
        r'<<<PATCH>>>(.*?)<<<ENDPATCH>>>',
        r'(diff --git.*?)(?:\n\n|\Z)',
        r'```diff\n(.*?)```',
    ]:
        match = re.search(pattern, output, re.DOTALL)
        if match:
            return match.group(1).strip()
    return None


# ═══════════════════════════════════════════════════════════════
# Task Loading
# ═══════════════════════════════════════════════════════════════

def build_problem_prompt(task: dict) -> str:
    return f"""I need you to solve a bug in the repository {task['repo']}.

## Problem
{task['problem_statement']}

## Task
1. Clone the repo: git clone https://github.com/{task['repo']}.git
2. Checkout the base commit: git checkout {task['base_commit']}
3. Understand the problem from the description above
4. Write the minimal fix
5. Make sure the fix is correct by reading the relevant code

## Expected Test Behavior
The following tests should PASS after your fix:
{task['FAIL_TO_PASS']}

The following tests should still PASS (regression check):
{task['PASS_TO_PASS']}

## Output Format
When done, output the patch in unified diff format between <<<PATCH>>> and <<<ENDPATCH>>> markers.
"""


def load_eval_set(path: str) -> list[dict]:
    with open(path) as f:
        data = json.load(f)
    if isinstance(data, list):
        return data
    elif isinstance(data, dict) and "tasks" in data:
        return data["tasks"]
    raise ValueError(f"Unknown format in {path}")


# ═══════════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(description="cc-haha Tool-call Advisor — 方案 A")
    parser.add_argument("--executor", default="deepseek-v4-flash", help="Executor model")
    parser.add_argument("--advisor", default=None, help="Advisor model (omit for solo)")
    parser.add_argument("--eval-set", default=None, help="Path to eval set JSON")
    parser.add_argument("--output", default=None, help="Output JSONL path")
    parser.add_argument("--limit", type=int, default=0, help="Limit tasks")
    parser.add_argument("--timeout", type=int, default=600, help="Timeout per task (s)")
    parser.add_argument("--max-turns", type=int, default=15, help="Max turns per task")
    parser.add_argument("--dry-run", action="store_true", help="Print tasks only")
    args = parser.parse_args()

    # Load tasks
    eval_set_path = args.eval_set or "/root/advisor-eval/eval_set_v3.json"
    tasks = load_eval_set(eval_set_path)
    if args.limit > 0:
        tasks = tasks[:args.limit]

    print(f"Loaded {len(tasks)} tasks")

    if args.dry_run:
        mode = "tool-advisor" if args.advisor else "solo"
        print(f"\n{'─'*60}")
        print(f"  DRY RUN — {len(tasks)} tasks, mode={mode}")
        print(f"  Executor: {args.executor}")
        if args.advisor:
            print(f"  Advisor: {args.advisor}")
        print(f"{'─'*60}")
        for i, t in enumerate(tasks):
            pid = t.get("instance_id", f"task-{i}")
            repo = t.get("repo", "?")
            print(f"  [{i+1}/{len(tasks)}] {pid} ({repo})")
        return

    # Determine output
    output_path = args.output or (
        f"results/tool-advisor-{args.executor}.jsonl"
        if args.advisor else f"results/solo-{args.executor}.jsonl"
    )

    results = []
    for i, task in enumerate(tasks):
        iid = task.get("instance_id", f"task-{i}")
        repo = task.get("repo", "?")
        prompt = build_problem_prompt(task)

        print(f"\n[{i+1}/{len(tasks)}] {iid} ({repo})")

        agent = ToolAdvisorAgent(
            executor_model=args.executor,
            advisor_model=args.advisor,
            max_turns=args.max_turns,
            workdir=f"/tmp/cc-haha-ws-{iid}",
        )
        result = agent.run(prompt, instance_id=iid, timeout=args.timeout)

        # Save
        os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
        with open(output_path, "a") as f:
            f.write(json.dumps(result, ensure_ascii=False) + "\n")
        results.append(result)

        ps = "✓ patch" if result.get("patch") else "✗ no patch"
        print(f"  → {result['duration_seconds']}s, {ps}, {result.get('advisor_calls', 0)} advisor calls")

    # Summary
    if results:
        mode = results[0].get("mode", "?")
        patches = [r for r in results if r.get("patch")]
        print(f"\n{'='*60}")
        print(f"  SUMMARY — {mode.upper()} ({len(results)} tasks)")
        print(f"  Executor: {results[0]['executor']}")
        if results[0].get("advisor"):
            print(f"  Advisor: {results[0]['advisor']}")
        print(f"  Patch rate: {len(patches)}/{len(results)} ({len(patches)/len(results)*100:.0f}%)")
        if results[0].get("advisor") is not None:
            adv_calls = [r.get("advisor_calls", 0) for r in results]
            print(f"  Avg advisor calls: {sum(adv_calls)/len(adv_calls):.1f}")
        print(f"{'='*60}")
        print(f"\nResults: {output_path}")


if __name__ == "__main__":
    main()
