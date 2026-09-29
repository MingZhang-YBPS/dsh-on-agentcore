// 数据清空保护的判定（Spike 08：Runtime 的任何属性变更都会产生新版本并清空所有用户的 session storage）。

// eslint-disable-next-line no-control-regex
export const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '')

/** cdk diff 的输出中 Runtime 资源是否有变更：[~] 修改、[-] 删除（替换时同时出现 [-] 与 [+]）；只有 [+] 是首次创建 */
export function runtimeChanged(diff: string): boolean {
  return stripAnsi(diff).split('\n').some((l) => /^\s*\[[~-]\]\s+AWS::BedrockAgentCore::Runtime\b/.test(l))
}

/**
 * 每用户部署（DshPerUser）：数据在各用户的 EFS 文件系统上，Runtime 变更不再清空数据；
 * 只有文件系统被删除（[-]）或替换（[~] … replace）才会丢数据。每名用户的资源在嵌套栈里：
 * 从 demoUsers 去掉用户时 diff 里只出现嵌套栈本身的 [-] AWS::CloudFormation::Stack（不会列出其中的 EFS），同样算作删除数据。
 * 返回这些资源所在的行。
 */
export function efsFileSystemsAtRisk(diff: string): string[] {
  const lines = stripAnsi(diff).split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const l = (lines[i] ?? '').trim()
    if (/^\[-\]\s+AWS::(EFS::FileSystem|CloudFormation::Stack)\b/.test(l)) { out.push(l); continue }
    if (!/^\[~\]\s+AWS::(EFS::FileSystem|CloudFormation::Stack)\b/.test(l)) continue
    // 替换标记可能在资源行（replace / may be replaced）或其下的属性行（requires replacement）
    let block = l
    for (let j = i + 1; j < lines.length && !/^\s*\[[+~-]\]\s+AWS::/.test(lines[j] ?? '') && /^\s/.test(lines[j] ?? ''); j++) block += `\n${lines[j]}`
    if (/replace/i.test(block)) out.push(l)
  }
  return out
}
