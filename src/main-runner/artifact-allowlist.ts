import { scanArtifactRefs } from "@luna/service-client/artifact-ref";

export function runnerArtifactAllowlistFromInput(
  value: unknown,
): readonly string[] {
  return scanArtifactRefs(value);
}
