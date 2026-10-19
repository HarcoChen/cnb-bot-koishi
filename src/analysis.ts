function analysisHeading(line: string) {
  const text = line.replace(/^\s{0,3}#{1,6}\s*/, '').replace(/\*\*|__/g, '').trim()
  const match = text.match(/^(?:【(一句话描述|一句话结论|详细分析)】|\[(一句话描述|一句话结论|详细分析)\]|(一句话描述|一句话结论|详细分析))\s*(?:[：:]\s*(.*))?$/)
  if (!match) return
  return { label: (match[1] || match[2] || match[3]) === '详细分析' ? 'detail' : 'summary', inline: match[4] || '' }
}

function summarySection(lines: string[]) {
  let fenced = false
  for (let index = 0; index < lines.length; index++) {
    if (/^\s*(```|~~~)/.test(lines[index])) { fenced = !fenced; continue }
    if (fenced) continue
    const heading = analysisHeading(lines[index])
    if (heading?.label !== 'summary') continue
    const parts = heading.inline ? [heading.inline] : []
    let end = index + 1
    for (; end < lines.length; end++) {
      const line = lines[end]
      if (analysisHeading(line) || /^\s{0,3}#{1,6}\s|^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) break
      if (!line.trim()) {
        if (parts.length) break
        continue
      }
      parts.push(line.trim())
    }
    if (parts.length) return { start: index, end, text: parts.join('\n') }
  }
}

function cleanSummary(text: string) {
  return text.replace(/\*\*|__/g, '').replace(/`([^`]+)`/g, '$1').replace(/\s+/g, ' ').trim()
}

export function formatAnalysis(body: string) {
  const lines = body.trim().split(/\r?\n/)
  const section = summarySection(lines)
  if (section) {
    const detail = [...lines.slice(0, section.start), ...lines.slice(section.end)].map(line => {
      const heading = analysisHeading(line)
      return heading?.label === 'detail' ? heading.inline : line
    }).join('\n').trim()
    return `【一句话描述】\n${cleanSummary(section.text)}\n\n【详细分析】\n${detail || body.trim()}`
  }
  const first = lines.find(line => line.trim() && !/^\s*@\S+(?:\([^)]*\))?\s*$/.test(line))?.trim() || ''
  const cleaned = first.replace(/^\s{0,3}#{1,6}\s*/, '').replace(/^\s*[-*]\s+/, '').trim()
  const summary = cleanSummary(cleaned).split(/(?<=[。！？!?])/)[0]
  return `【一句话描述】\n${summary || '已返回分析，详见下方。'}\n\n【详细分析】\n${body.trim()}`
}

export function analysisSummary(body: string) {
  const formatted = formatAnalysis(body)
  const match = formatted.match(/【一句话描述】\s*([\s\S]*?)\s*【详细分析】/)
  const value = cleanSummary(match?.[1] || '')
  const end = value.search(/[。！？!?]/)
  return end >= 0 ? value.slice(0, end + 1) : value || '已返回分析，详见合并转发。'
}
