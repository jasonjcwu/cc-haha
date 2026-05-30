#!/bin/bash
# 设置 cc-haha CLI 使用 GLM Anthropic 端点
export ANTHROPIC_BASE_URL="https://open.bigmodel.cn/api/anthropic"
export ANTHROPIC_API_KEY="5e3490380f0b4f3eb3d4f7e6512596fd.YdJmkBGvxydCrqmP"
unset ANTHROPIC_AUTH_TOKEN
echo "🟢 GLM: ANTHROPIC_BASE_URL=$ANTHROPIC_BASE_URL"
echo "   model mapping: claude-haiku -> glm-4.5-air"
echo "   model mapping: claude-sonnet -> glm-5.1"
echo "   model mapping: claude-opus -> glm-5.1"
