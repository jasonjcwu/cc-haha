#!/usr/bin/env python3
"""Robust Anthropic→OpenAI proxy for cc-haha multi-turn advisor testing."""
import json, os, sys, time, traceback
from http.server import HTTPServer, BaseHTTPRequestHandler
from openai import OpenAI

logfile = open('/tmp/proxy.log', 'w', buffering=1)
def log(msg):
    logfile.write(f"[{time.strftime('%H:%M:%S')}] {msg}\n")

with open('/root/.hermes/auth.json') as f:
    auth = json.load(f)
KEY = auth['credential_pool']['deepseek'][0]['access_token']
client = OpenAI(api_key=KEY, base_url='https://api.deepseek.com/v1')

def anthropic_msg_to_text(role, content):
    """Convert any Anthropic message format to a single text string."""
    if isinstance(content, str):
        return {"role": role, "content": content}
    texts = []
    for block in content if isinstance(content, list) else []:
        if not isinstance(block, dict):
            texts.append(str(block))
            continue
        bt = block.get('type', '')
        if bt == 'text':
            texts.append(block.get('text', ''))
        elif bt == 'tool_result':
            inner = block.get('content', '')
            if isinstance(inner, list):
                inner = ' '.join(
                    x.get('text', '') for x in inner 
                    if isinstance(x, dict) and x.get('type') == 'text'
                )
            texts.append(f"[Result({block.get('tool_use_id','?')})]: {str(inner)[:500]}")
        elif bt == 'tool_use':
            inp = block.get('input', {})
            texts.append(f"[Call {block.get('name')}]: {json.dumps(inp, ensure_ascii=False)[:200]}")
        elif bt == 'thinking':
            texts.append(f"[Think]: {str(block.get('thinking', ''))[:200]}")
        else:
            texts.append(str(block)[:200])
    return {"role": role, "content": '\n'.join(texts)}

def convert_openai_tools(anthropic_tools):
    """Convert Anthropic tools to OpenAI format, auto-inject advisor."""
    result = []
    has_advisor = False
    for t in (anthropic_tools or []):
        if t.get('type') == 'advisor_20260301' or t.get('name') == 'advisor':
            has_advisor = True
            result.append({
                "type": "function",
                "function": {
                    "name": "advisor",
                    "description": "Get strategic guidance from a stronger model. Call before editing code.",
                    "parameters": {"type": "object", "properties": {}}
                }
            })
        else:
            result.append({
                "type": "function",
                "function": {
                    "name": t.get('name', 'unknown'),
                    "description": t.get('description', ''),
                    "parameters": t.get('input_schema', {"type": "object", "properties": {}})
                }
            })
    if not has_advisor:
        log("  ⚡ Auto-injecting advisor tool")
        result.append({
            "type": "function",
            "function": {
                "name": "advisor",
                "description": "Get strategic guidance from a stronger model. Call after exploring but before writing code.",
                "parameters": {"type": "object", "properties": {}}
            }
        })
    return result

class ProxyHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        start = time.time()
        log(f">> POST {self.path}")
        
        try:
            # Read body safely
            length = int(self.headers.get('Content-Length', 0))
            body_raw = self.rfile.read(length)
            
            # Parse JSON safely
            try:
                body = json.loads(body_raw)
            except json.JSONDecodeError as e:
                log(f"  !! JSON parse error: {e}")
                log(f"  !! Body preview: {body_raw[:500]}")
                self.send_response(400)
                self.end_headers()
                self.wfile.write(json.dumps({"error": f"JSON parse error: {e}"}).encode())
                return
            
            log(f"  keys={list(body.keys())} msgs={len(body.get('messages',[]))} tools={len(body.get('tools',[]))}")
            
            if not self.path.startswith('/v1/messages'):
                self.send_response(404)
                self.end_headers()
                self.wfile.write(b'{"error":"not found"}')
                return
            
            model = body.get('model', 'deepseek-chat')
            messages = body.get('messages', [])
            
            # Convert to OpenAI format
            oa_messages = []
            system = body.get('system', '')
            if system:
                sys_text = system if isinstance(system, str) else str(system)
                oa_messages.append({"role": "system", "content": sys_text})
            for msg in messages:
                oa_messages.append(anthropic_msg_to_text(msg.get('role', 'user'), msg.get('content', '')))
            
            # Convert tools
            oa_tools = convert_openai_tools(body.get('tools', []))
            
            log(f"  Sending to DeepSeek ({len(oa_messages)} msgs, {len(oa_tools)} tools)...")
            
            try:
                resp = client.chat.completions.create(
                    model=model,
                    messages=oa_messages,
                    tools=oa_tools,
                    max_tokens=2048,
                    temperature=0,
                )
            except Exception as e:
                log(f"  !! DeepSeek API error: {e}")
                self.send_response(502)
                self.end_headers()
                self.wfile.write(json.dumps({"error": f"DeepSeek API error: {e}"}).encode())
                return
            
            log(f"  DeepSeek OK: model={resp.model} ({time.time()-start:.1f}s)")
            
            # Convert response back to Anthropic format
            choice = resp.choices[0]
            msg = choice.message
            content_blocks = []
            
            if msg.content:
                content_blocks.append({"type": "text", "text": msg.content})
            
            advisor_called = False
            if msg.tool_calls:
                for tc in msg.tool_calls:
                    fn = tc.function
                    try:
                        args = json.loads(fn.arguments) if fn.arguments else {}
                    except json.JSONDecodeError:
                        args = {}
                    if fn.name == 'advisor':
                        advisor_called = True
                    content_blocks.append({
                        "type": "tool_use",
                        "id": tc.id,
                        "name": fn.name,
                        "input": args
                    })
            
            if advisor_called:
                log(f"  ⭐ MODEL CALLED advisor()!")
            
            stop_reason = "tool_use" if msg.tool_calls else "end_turn"
            anthropic_resp = {
                "id": f"msg_{int(time.time())}_{os.getpid()}",
                "type": "message",
                "role": "assistant",
                "content": content_blocks,
                "model": resp.model,
                "stop_reason": stop_reason,
                "stop_sequence": None,
                "usage": {
                    "input_tokens": resp.usage.prompt_tokens if resp.usage else 0,
                    "output_tokens": resp.usage.completion_tokens if resp.usage else 0,
                }
            }
            
            resp_json = json.dumps(anthropic_resp, ensure_ascii=False)
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(resp_json.encode('utf-8'))))
            self.end_headers()
            self.wfile.write(resp_json.encode('utf-8'))
            
            duration = time.time() - start
            tool_names = [b.get('name','?') for b in content_blocks if b.get('type')=='tool_use']
            log(f"  ✅ Done ({duration:.1f}s) tools={tool_names}")
            
        except Exception as e:
            log(f"  !! UNHANDLED ERROR: {e}")
            traceback.print_exc(file=logfile)
            try:
                self.send_response(500)
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode())
            except Exception:
                pass
    
    def do_GET(self):
        self.send_response(404 if self.path != '/health' else 200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{"status":"ok"}' if self.path == '/health' else b'{"error":"not found"}')
    
    def log_message(self, format, *args):
        pass

log("=== PROXY STARTING ===")
log(f"  Key: {KEY[:8]}...")
HTTPServer(('0.0.0.0', 14000), ProxyHandler).serve_forever()
