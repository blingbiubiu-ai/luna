import { useTranslation } from "@/lib/i18n";
import { useState } from "react";

import { ActionDialog } from "@/components/action-dialog";
import {
  parseSubjectKey,
  subjectKey,
  SubjectPicker,
} from "@/components/subject-picker";
import { Button } from "@/components/ui/button";
import type { DashboardGroup } from "@/lib/api";

export function AssignGroupDialog({
  error,
  excludedGroupIds = [],
  groups,
  isSubmitting = false,
  onAssignGroup,
}: {
  readonly error?: unknown;
  readonly excludedGroupIds?: readonly string[];
  readonly groups: readonly DashboardGroup[];
  readonly isSubmitting?: boolean;
  readonly onAssignGroup?: ((input: {
    groupId: string;
    role: "member";
  }) => Promise<unknown> | unknown) | undefined;
}) {
  const { t } = useTranslation();
  const [selectedGroupKey, setSelectedGroupKey] = useState("");
  const selectedGroup = parseSubjectKey(selectedGroupKey);

  return (
    <ActionDialog
      error={error}
      isSubmitting={isSubmitting}
      onSubmit={() => {
        if (selectedGroup?.subjectType !== "group") {
          return;
        }
        return onAssignGroup?.({
          groupId: selectedGroup.subjectId,
          role: "member",
        });
      }}
      onSuccess={() => setSelectedGroupKey("")}
      submitDisabled={selectedGroup?.subjectType !== "group"}
      submitLabel={t("Assign group")}
      title={t("Assign group")}
      trigger={<Button variant="outline">{t("Assign group")}</Button>}
    >
      <SubjectPicker
        allowedSubjectTypes={["group"]}
        excludedSubjectKeys={excludedGroupIds.map((groupId) =>
          subjectKey("group", groupId)
        )}
        groups={groups}
        label={t("Group *")}
        onSelectedSubjectKeyChange={setSelectedGroupKey}
        placeholder={t("Search groups")}
        selectedSubjectKey={selectedGroupKey}
        users={[]}
      />
    </ActionDialog>
  );
}
