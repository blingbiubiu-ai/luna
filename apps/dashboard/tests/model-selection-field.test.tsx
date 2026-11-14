import {expect,test} from "bun:test";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {ModelSelectionField} from "../src/components/model-selection-field";

test("model selector defaults to activation and marks untested model profiles unavailable",()=>{
  const html=renderToStaticMarkup(createElement(ModelSelectionField,{value:"inherit",activeLabel:"Default · model-a",disabled:false,onChange:()=>{},choices:[
    {revisionId:"valid",label:"Codex · model-b",validated:true},
    {revisionId:"draft",label:"Draft · model-c",validated:false},
  ]}));
  expect(html).toContain("跟随当前激活配置");expect(html).toContain("Default · model-a");
  expect(html).toContain("Codex · model-b");expect(html).toContain('value="draft" disabled');
  expect(html).toContain("未通过连接验证");
});
