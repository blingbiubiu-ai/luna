import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkerRoutingFields } from "../src/components/worker-routing-fields";

test("Worker routing exposes automatic and bound choices with switch and unavailable-node guidance",()=>{
  const props={workerId:"worker-a",workers:[{workerId:"worker-a",label:"worker-a · 暂停接单"}],disabled:false,onModeChange:()=>{},onWorkerChange:()=>{}};
  const automatic=renderToStaticMarkup(createElement(WorkerRoutingFields,{...props,mode:"automatic"}));
  expect(automatic).toContain("自动分流");expect(automatic).not.toContain('aria-label="绑定 Worker"');
  const bound=renderToStaticMarkup(createElement(WorkerRoutingFields,{...props,mode:"bound"}));
  expect(bound).toContain('aria-label="绑定 Worker"');expect(bound).toContain("暂停接单");
  expect(bound).toContain("下一次执行");expect(bound).toContain("重建上下文");
});
