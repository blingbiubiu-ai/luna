/** Tool categories and Chinese labels shared by provider adapters and Feishu. */
export function toolDisplay(name: string): {icon: string; label: string} {
  const n = name.toLowerCase();
  if (n.includes("bash") || n.includes("shell") || n.includes("command") || /(^|[^a-z])exec([^a-z]|$)/.test(n)) return {icon:"bash",label:"执行命令"};
  if (n.includes("write") || n.includes("edit") || n.includes("patch")) return {icon:"write",label:"编辑文件"};
  if (n.includes("read") || n.includes("notebook")) return {icon:"read",label:"读取文件"};
  if (n.includes("grep") || n.includes("glob") || n.includes("search") || n.includes("fetch")) return {icon:"search",label:"搜索"};
  if (n.includes("task") || n.includes("todo") || n.includes("plan")) return {icon:"task",label:"任务管理"};
  return {icon:"default",label:`调用 ${name}`};
}
