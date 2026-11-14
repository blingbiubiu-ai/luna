import { z } from "zod";

const providerId = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/);
export const groupCreationSchema = z.object({ channelId: z.string().min(1), name: z.string().trim().min(1).max(100), idType: z.enum(["open_id", "user_id", "union_id"]).default("open_id"), memberIds: z.array(providerId).min(1).max(50).transform(ids => [...new Set(ids)].sort()) }).strict();
export const groupContextMessageIdsSchema = z.array(z.string().min(1).max(256)).max(100).transform(ids => [...new Set(ids)]);
export const groupInvitationSchema = groupCreationSchema.omit({ name: true }).extend({ chatId: z.string().min(1).max(256) });
export type GroupInvitation = z.infer<typeof groupInvitationSchema>;
export type GroupCreation = z.infer<typeof groupCreationSchema>;
export const groupPolicySchema = z.object({ channelId: z.string().min(1), idType: z.enum(["open_id", "user_id", "union_id"]), memberIds: z.array(providerId).min(1).max(200), maxGroups: z.number().int().min(1).max(20).default(1), followupCapabilities: z.array(z.enum(["message.send", "session.invoke", "group.invite"])).default(["message.send"]) }).strict();
