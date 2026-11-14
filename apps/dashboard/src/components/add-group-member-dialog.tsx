import { useTranslation } from "@/lib/i18n";
import { useState } from "react";

import { ActionDialog } from "@/components/action-dialog";
import {
  parseSubjectKey,
  subjectKey,
  SubjectPicker,
} from "@/components/subject-picker";
import { Button } from "@/components/ui/button";
import type { DashboardUser } from "@/lib/api";

export function AddGroupMemberDialog({
  error,
  excludedUserIds = [],
  isSubmitting = false,
  onAddMember,
  users,
}: {
  readonly error?: unknown;
  readonly excludedUserIds?: readonly string[];
  readonly isSubmitting?: boolean;
  readonly onAddMember?: ((input: {
    userId: string;
    role: "member";
  }) => Promise<unknown> | unknown) | undefined;
  readonly users: readonly DashboardUser[];
}) {
  const { t } = useTranslation();
  const [selectedUserKey, setSelectedUserKey] = useState("");
  const selectedUser = parseSubjectKey(selectedUserKey);

  return (
    <ActionDialog
      error={error}
      isSubmitting={isSubmitting}
      onSubmit={() => {
        if (selectedUser?.subjectType !== "user") {
          return;
        }
        return onAddMember?.({ userId: selectedUser.subjectId, role: "member" });
      }}
      onSuccess={() => setSelectedUserKey("")}
      submitDisabled={selectedUser?.subjectType !== "user"}
      submitLabel={t("Add member")}
      title={t("Add member")}
      trigger={<Button variant="outline">{t("Add member")}</Button>}
    >
      <SubjectPicker
        allowedSubjectTypes={["user"]}
        excludedSubjectKeys={excludedUserIds.map((userId) =>
          subjectKey("user", userId)
        )}
        groups={[]}
        label={t("Member user *")}
        onSelectedSubjectKeyChange={setSelectedUserKey}
        placeholder={t("Search users")}
        selectedSubjectKey={selectedUserKey}
        users={users}
      />
    </ActionDialog>
  );
}
