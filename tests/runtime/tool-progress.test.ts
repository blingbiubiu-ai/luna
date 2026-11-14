import {expect, test} from "bun:test";
import {toolTitle} from "@luna/executor/providers/tool-progress";
import {resolveContainerRunnerProvider} from "@luna/executor/providers";

test("tool titles extract and bound concrete subjects without copying unrelated arguments", () => {
  expect(toolTitle("web_search", {query:"广州\n明天天气",secret:"hidden"})).toBe("搜索 · 广州 明天天气");
  expect(toolTitle("Bash", {command:["bash","-lc","git status --short"]})).toBe("执行命令 · git status --short");
  expect(toolTitle("Write", {content:"x".repeat(10000),file_path:"/work/src/index.ts"})).toBe("编辑文件 · /work/src/index.ts");
  expect(toolTitle("Bash", {command:"curl --token abc --password 'secret value' https://u:p@host"})).toBe("执行命令 · curl --token [redacted] --password [redacted] https://[redacted]@host");
  expect(toolTitle("Search", {query:"a".repeat(100)})).toBe("搜索 · "+"a".repeat(80)+"…");
  expect(toolTitle("Search", {query:{unexpected:"value"}})).toBe("搜索");
});

test("Codex keeps raw event types while extracting web and MCP subjects", () => {
  const provider=resolveContainerRunnerProvider("codex");
  for (const [item,title] of [
    [{id:"search-1",type:"web_search",query:"广州明天天气"},"搜索 · 广州明天天气"],
    [{id:"mcp-1",type:"mcp_tool_call",tool:"search",arguments:JSON.stringify({query:"天气",output:"private"})},"搜索 · 天气"],
    [{id:"file-1",type:"file_change",changes:[{path:"src/index.ts",kind:"update"}]},"编辑文件 · src/index.ts"],
  ] as const) {
    expect(provider.parseStreamLine(JSON.stringify({type:"item.started",item}))).toMatchObject({kind:"events",events:[{kind:"tool_start",id:item.id,title}]});
  }
});

test("Codex search subjects arriving only at completion still create a titled node", () => {
  const provider=resolveContainerRunnerProvider("codex");
  expect(provider.parseStreamLine(JSON.stringify({type:"item.started",item:{id:"s",type:"web_search"}}))).toEqual({kind:"events",events:[]});
  expect(provider.parseStreamLine(JSON.stringify({type:"item.completed",item:{id:"s",type:"web_search",query:"广州天气"}}))).toMatchObject({kind:"events",events:[{kind:"tool_start",id:"s",title:"搜索 · 广州天气"},{kind:"tool_result",id:"s"}]});
});

test("uses consistent tool categories and labels, preserving unknown tool names", () => {
  expect(toolTitle("execute_sql")).toBe("调用 execute_sql");
  expect(toolTitle("image")).toBe("调用 image");
  expect(toolTitle("exec_command")).toBe("执行命令");
  expect(toolTitle("TodoWrite")).toBe("编辑文件");
  expect(toolTitle("Task", {toolSummary:"检查结果"})).toBe("任务管理 · 检查结果");
  expect(toolTitle("Fetch", {Url:"https://example.com"})).toBe("搜索 · https://example.com");
});
