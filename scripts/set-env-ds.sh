#!/bin/bash
# 设置 cc-haha CLI 使用 DeepSeek Anthropic 端点
export ANTHROPIC_BASE_URL="https://api.deepseek.com/anthropic"
export ANTHROPIC_API_KEY="sk-74fc5965c5224bdba42d0ab65658d18d"
unset ANTHROPIC_AUTH_TOKEN
echo "🟢 DeepSeek: ANTHROPIC_BASE_URL=$ANTHROPIC_BASE_URL"
echo "   model mapping: claude-sonnet/haiku -> deepseek-v4-flash"
echo "   model mapping: claude-opus -> deepseek-v4-pro"
