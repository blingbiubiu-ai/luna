/** Dashboard user IDs are canonical identities, never provider mention IDs. */
export function renderLocalUserMentions(content: string, user: {
  id: string;
  displayName: string | null;
  profileSource: string | null;
} | undefined): string {
  if (user?.profileSource !== "dashboard") return content;
  const name = user.displayName?.trim() || "Dashboard 用户";
  const id = user.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Models occasionally ignore the instruction against raw provider tags.
  // Render the authenticated actor as ordinary text rather than an invalid @.
  return content
    .replace(new RegExp(`<at\\b[^>]*\\b(?:user_id|id)\\s*=\\s*["']${id}["'][^>]*>[\\s\\S]*?<\\/at>`, "gi"), () => name)
    .replace(new RegExp(`@${id}(?![\\w-])`, "g"), () => name);
}
