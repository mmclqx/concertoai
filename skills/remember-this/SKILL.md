---
name: remember-this
description: 快速保存当前对话中的重要信息到知识图谱
version: 1.0.0
tools: [knowledge_create_entities]
---

## 技能描述

将用户指定的信息保存到知识图谱，便于跨会话检索。

## 使用方式

/skill remember-this "项目使用 React 18 + TypeScript"

## 执行指令

1. 提取用户输入的关键信息
2. 调用 knowledge_create_entities 保存
3. 返回保存确认