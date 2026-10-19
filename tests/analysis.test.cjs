const { test } = require('node:test')
const assert = require('node:assert/strict')
const { analysisSummary, formatAnalysis } = require('../lib/analysis')

test('extract summary without a detail heading, as in CNB Issue 66', () => {
  const body = '@user(Nickname)\n\n**一句话描述：** 日志读取成功；上游脚本识别失败。\n\n---\n\n### 一、日志读取情况\n证据内容。'
  assert.equal(analysisSummary(body), '日志读取成功；上游脚本识别失败。')
  assert.match(formatAnalysis(body), /【详细分析】[\s\S]*### 一、日志读取情况\n证据内容。/)
})

test('accept plain and Markdown headings used by CNB Issues 73 and 119', () => {
  for (const heading of ['一句话描述：', '**一句话描述**：', '**一句话描述：**', '## 一句话描述\n']) {
    assert.equal(analysisSummary(`@user(Name)\n\n${heading}**启动流程超时**。\n\n## 详细分析\n具体证据。`), '启动流程超时。')
  }
})

test('accept bracket headings and conclusion aliases without returning heading text', () => {
  for (const heading of ['【一句话描述】', '[一句话描述]', '【一句话结论】', '一句话结论：']) {
    assert.equal(analysisSummary(`${heading}\n连接超时。\n\n【详细分析】\n详细证据。`), '连接超时。')
  }
})

test('skip quoted code headings and mention-only fallback lines', () => {
  assert.equal(analysisSummary('```\n一句话描述：伪结论。\n```\n一句话描述：真实结论。'), '真实结论。')
  assert.equal(analysisSummary('@user(Name)\n\n连接超时。更多证据。'), '连接超时。')
})

test('retain multiline summary and all detail content', () => {
  const body = '一句话描述：第一行\n第二行。\n详细分析：具体证据。\n处理步骤。'
  assert.equal(analysisSummary(body), '第一行 第二行。')
  assert.match(formatAnalysis(body), /【详细分析】\n具体证据。\n处理步骤。/)
})
