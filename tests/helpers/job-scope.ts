import {createScopedResources} from "@luna/host-runtime/scoped-runner-resources";

/** Protocol fixtures choose a scope explicitly; production has no default Agent or Shadow. */
export function fixtureJobScope(agentId="agent",shadowId="shadow") {
 const scope={agentId,shadowId,placementGeneration:1};
 const resources=createScopedResources(scope,[]).selection;
 return {scope,resources,resourceRevision:resources.digest};
}
