import {afterEach, beforeEach, expect, test} from "bun:test";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {eq} from "drizzle-orm";
import {DataConnection} from "@/data";
import * as schema from "@/data/schema";
import {setLunaHome} from "@/shared";
import {AgentStore} from "@/agents/agent-store";
import {BotBindingStore} from "@/agents/bot-binding-store";
import {ChannelBindingGuard} from "@/channels/channel-binding-guard";
import {LunaMessageIngress} from "@/messaging/gateway/luna-message-ingress";
import {FakeFeishuChannel} from "../../extensions/channels/fake/fake-feishu-channel";
import {fixtureSessionOwnership} from "../helpers/platform-fixtures";
let home: string, connection: DataConnection<typeof schema>, ownership: ReturnType<typeof fixtureSessionOwnership>;
const channel = {id: "bot", type: "feishu"};
beforeEach(() => {
 home=mkdtempSync(join(tmpdir(),"luna-binding-guard-"));setLunaHome(home);connection=new DataConnection(schema);
 ownership=fixtureSessionOwnership(connection.db,channel.type,channel.id);
});
afterEach(() => {connection.close();rmSync(home,{recursive:true,force:true});});
function rebind() {
 const bindings = new BotBindingStore(connection.db);
 bindings.retire("fixture-owner", ownership.binding_id!);
 const shadow = new AgentStore(connection.db).createShadow("fixture-owner", ownership.agent_id, {name:"New"}, "new");
 return bindings.bind("fixture-owner", shadow.id, channel.id);
}
test("captured binding rejects rebinding, disabled configs and retired adapter callbacks", () => {
 const guard = new ChannelBindingGuard(connection.db, channel);
 expect(() => guard.assertCurrent({...channel,id:"foreign"})).toThrow("channel_scope_mismatch");
 guard.retire();expect(() => guard.assertCurrent()).toThrow("channel_adapter_retired");
 guard.restore();guard.assertCurrent();
 connection.db.update(schema.channelConfigs).set({enabled:false}).where(eq(schema.channelConfigs.id,channel.id)).run();
 expect(() => guard.assertCurrent()).toThrow("channel_disabled");
 connection.db.update(schema.channelConfigs).set({enabled:true}).where(eq(schema.channelConfigs.id,channel.id)).run();
 const binding = rebind();
 expect(() => guard.assertCurrent()).toThrow("bot_binding_retired");
 expect(() => guard.restore()).toThrow("bot_binding_retired");
 expect(new ChannelBindingGuard(connection.db,channel).bindingId).toBe(binding.id);
});
test("late subscribed callback is refused before creating messages under the new binding", async () => {
 const adapter = new FakeFeishuChannel(channel.id);
 const ingress = new LunaMessageIngress({db:connection.db,runnerType:"mock"});
 await ingress.registerChannel(adapter);
 rebind();
 await expect(adapter.emitNormalizedInbound({id:"late",text:"hello",channel,surface:{externalId:"chat",kind:"p2p"},sender:{externalId:"user",kind:"user"},mentions:[],addressing:{addressedToBot:true,reason:"mention"}})).rejects.toThrow("bot_binding_retired");
 expect(connection.db.select().from(schema.messages).all()).toHaveLength(0);
 expect(connection.db.select().from(schema.sessions).all()).toHaveLength(0);
 await ingress.stop();
});
test("replacement retires the previous adapter even when its provider emits after stop", async () => {
 const previous = new FakeFeishuChannel(channel.id), next = new FakeFeishuChannel(channel.id);
 const ingress = new LunaMessageIngress({db:connection.db,runnerType:"mock"});
 await ingress.registerChannel(previous);
 await ingress.replaceChannel(channel.id,next);
 await expect(previous.emitNormalizedInbound({id:"late",text:"hello",channel,surface:{externalId:"chat",kind:"p2p"},sender:{externalId:"user",kind:"user"},mentions:[],addressing:{addressedToBot:true,reason:"mention"}})).rejects.toThrow("channel_adapter_retired");
 await ingress.stop();
});

test("failed replacement restores the original subscription only while its captured binding is valid", async () => {
 class BrokenChannel extends FakeFeishuChannel { override async start(): Promise<void> {throw new Error("start failed");} }
 const previous = new FakeFeishuChannel(channel.id), replacement = new BrokenChannel(channel.id);
 const ingress = new LunaMessageIngress({db:connection.db,runnerType:"mock"});
 await ingress.registerChannel(previous);
 await expect(ingress.replaceChannel(channel.id,replacement)).rejects.toThrow("start failed");
 await expect(previous.emitNormalizedInbound({id:"check",text:"hello",channel:{...channel,id:"foreign"},surface:{externalId:"chat",kind:"p2p"},sender:{externalId:"user",kind:"user"},mentions:[],addressing:{addressedToBot:true,reason:"mention"}})).rejects.toThrow("channel_scope_mismatch");
 await ingress.stop();
});

test("concurrent replacements of one channel cannot interleave start and stop", async () => {
 const events: string[] = []; let entered!: () => void, release!: () => void;
 const started = new Promise<void>(resolve => {entered=resolve;});
 const gate = new Promise<void>(resolve => {release=resolve;});
 class First extends FakeFeishuChannel {
   override async start() {events.push("first:start");entered();await gate;events.push("first:ready");}
   async stop() {events.push("first:stop");}
 }
 class Second extends FakeFeishuChannel {override async start() {events.push("second:start");}}
 const ingress = new LunaMessageIngress({db:connection.db,runnerType:"mock"});
 await ingress.registerChannel(new FakeFeishuChannel(channel.id));
 const first=ingress.replaceChannel(channel.id,new First(channel.id));
 const second=ingress.replaceChannel(channel.id,new Second(channel.id));
 await started;expect(events).toEqual(["first:start"]);release();
 await Promise.all([first,second]);
 expect(events).toEqual(["first:start","first:ready","first:stop","second:start"]);
 await ingress.stop();
});
