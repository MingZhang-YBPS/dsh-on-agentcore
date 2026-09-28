// 数据清空保护的判定（Spike 08：Runtime 的任何属性变更都会产生新版本并清空所有用户的 session storage）。

// eslint-disable-next-line no-control-regex
export const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '')

/** cdk diff 的输出中 Runtime 资源是否有变更：[~] 修改、[-] 删除（替换时同时出现 [-] 与 [+]）；只有 [+] 是首次创建 */
export function runtimeChanged(diff: string): boolean {
  return stripAnsi(diff).split('\n').some((l) => /^\s*\[[~-]\]\s+AWS::BedrockAgentCore::Runtime\b/.test(l))
}
