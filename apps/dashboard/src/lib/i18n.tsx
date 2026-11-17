import extraChinese from "./zh-CN.json";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type Locale = "en" | "zh-CN";
const chinese: Record<string, string> = {
  ...extraChinese,
  "Operate": "运行", "Overview": "概览", "Sessions": "会话", "Tasks": "任务",
  "Workspace": "工作空间", "Knowledge": "知识库", "Skills": "技能", "Memory": "记忆",
  "Plugins": "插件", "Control": "管理", "Users": "用户", "Groups": "用户组",
  "Tokens": "访问令牌", "Agents": "智能体", "Settings": "设置", "Home": "首页",
  "Digital Shadows": "数字分身", "Model Configuration": "模型配置", "Containers": "容器",
  "Log out": "退出登录", "Agent management console": "智能体管理控制台",
  "Refresh dashboard": "刷新页面", "Change theme": "主题", "Language": "语言",
  "Light": "浅色", "Dark": "深色", "System": "跟随系统",
  "Knowledge Workspace": "知识库工作空间", "Workspace browser": "浏览和搜索知识库文件",
  "Uncommitted changes": "有未提交的修改", "Clean": "无未提交修改",
  "Search knowledge workspace": "搜索知识库", "Search file names and contents": "搜索文件名和内容",
  "Skipped binary or oversized files": "已跳过二进制文件、超大文件或超出搜索容量的文件",
  "Showing the first 500 matches. Narrow your search.": "仅显示前 500 条结果，请缩小搜索范围。",
  "Failed to load files": "文件加载失败",
  "Search": "搜索", "Files": "文件", "Loading": "加载中…", "No files found.": "没有匹配的文件。",
  "Search results": "内容搜索结果", "Searching…": "搜索中…", "Search failed": "搜索失败",
  "No content matches.": "没有匹配的内容。", "Enter a keyword to search file names and contents.": "输入关键词，搜索文件名和内容。",
  "Line": "行", "Select a file": "选择文件", "Copy path": "复制路径", "Copy full text": "复制全文",
  "knowledge workspace": "知识库工作空间", "No file selected.": "请选择一个文件。",
  "Git status": "Git 状态", "No workspace changes.": "工作空间暂无修改。", "Git diff": "Git 差异", "No diff.": "暂无差异。",
};
export function translate(locale: Locale, text: string): string {
  if (locale !== "zh-CN") return text;
  if (chinese[text]) return chinese[text];
  const runtime = /^(Runtime|Agent) (.+)$/.exec(text);
  if (runtime) return `${runtime[1] === "Runtime" ? "运行状态" : "智能体"} ${translate(locale, runtime[2]!)}`;
  const channel = /^(\w+) (\w+) · (\d+ channels?)$/.exec(text);
  if (channel) return `${channel[1]} ${translate(locale, channel[2]!)} · ${translate(locale, channel[3]!)}`;
  const total = /^(\d+) total$/.exec(text);
  if (total) return `共 ${total[1]} 项`;
  const count = /^(\d+) (messages?|sessions?|users?|groups?|members?|identit(?:y|ies)|direct grants?|files?|tasks?|channels?|steps?|claims?)$/.exec(text);
  if (count) {
    const unit = /message/.test(count[2]!) ? "条消息" : /session/.test(count[2]!) ? "个会话" : /user/.test(count[2]!) ? "位用户" : /group/.test(count[2]!) ? "个用户组" : /member/.test(count[2]!) ? "位成员" : /identit/.test(count[2]!) ? "个身份" : /grant/.test(count[2]!) ? "项直接授权" : /file/.test(count[2]!) ? "个文件" : /task/.test(count[2]!) ? "个任务" : /channel/.test(count[2]!) ? "个通道" : /step/.test(count[2]!) ? "个步骤" : "条身份声明";
    return `${count[1]} ${unit}`;
  }
  return text;
}
const LocaleContext = createContext({locale: "en" as Locale, setLocale: (_locale: Locale) => {}});
export function LocaleProvider({children, initialLocale}: {children: ReactNode; initialLocale?: Locale}) {
  const [locale, setLocale] = useState<Locale>(() => {
    if (initialLocale) return initialLocale;
    try {
      const saved = localStorage.getItem("luna-ui-language");
      if (saved === "en" || saved === "zh-CN") return saved;
    } catch { /* Storage may be disabled. */ }
    return typeof navigator !== "undefined" && navigator.language.startsWith("zh") ? "zh-CN" : "en";
  });
  useEffect(() => {
    document.documentElement.lang = locale;
    try { localStorage.setItem("luna-ui-language", locale); } catch { /* Keep the in-memory choice. */ }
  }, [locale]);
  return <LocaleContext.Provider value={{locale, setLocale}}>{children}</LocaleContext.Provider>;
}
export function useTranslation() {
  const {locale, setLocale} = useContext(LocaleContext);
  return {locale, setLocale, t: (text: string) => translate(locale, text)};
}

/** Translate presentation labels, never identifiers or document content. */
export function UiText({children}: {children: ReactNode}) {
  const { t } = useTranslation();
  return <>{typeof children === "string" ? t(children) : children}</>;
}
