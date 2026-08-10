/** account/login/logout/whoami 命令选项。 */
export interface AccountCommandOptions {
  /** 账号名（login/logout/switch 必需）。 */
  name?: string;
  /** 非交互注入的 API Key（--key）。 */
  key?: string;
  /** logout 时删除账号目录（--purge）。 */
  purge?: boolean;
  /** accounts 根目录（测试注入；默认 ~/.concertoai/accounts）。 */
  accountsRoot?: string;
}
