---
name: project-analyzer
description: 使用 explore 子代理分析项目结构，生成模块概览
version: 1.0.0
tools: []
---

## 技能描述

自动调用 explore 子代理分析项目结构，生成模块清单和职责描述。

## 使用方式

/skill project-analyzer

或指定模块：
/skill project-analyzer "src/loop/"

## 执行指令

使用 @agent:explore 分析指定目录（默认 src/），返回：
1. 目录结构树
2. 每个模块的核心职责
3. 文件数量统计